// Artwork fetcher con cache disco TTL 30gg (hit) / 10min (null).
// La api_key NON è mai esposta al frontend JS.

use std::{collections::HashMap, fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};

const NULL_TTL_MS:  u64 = 10 * 60 * 1000;
const IMAGE_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CacheEntry {
    key:             String,
    title:           String,
    artist:          String,
    artwork_url:     Option<String>,
    local_path:      Option<String>,
    null_ttl_expiry: u64,
    image_ttl_expiry: u64,
    updated_at:      String,
}

#[derive(Debug, Serialize)]
pub struct ArtworkResult {
    pub local_path:  Option<String>,
    pub artwork_url: Option<String>,
    pub from_cache:  bool,
    pub error:       Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn cache_key(artist: &str, title: &str) -> String {
    let raw = format!("{}|{}", artist.trim().to_lowercase(), title.trim().to_lowercase());
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    hex::encode(h.finalize())
}

fn cache_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("GUStudio Player").join("artwork-cache")
}

fn cache_index_path() -> PathBuf {
    cache_dir().join("cache.json")
}

fn load_cache() -> HashMap<String, CacheEntry> {
    let p = cache_index_path();
    if !p.exists() { return HashMap::new(); }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cache(cache: &HashMap<String, CacheEntry>) {
    let p = cache_index_path();
    if let Some(dir) = p.parent() { let _ = fs::create_dir_all(dir); }
    let tmp = p.with_extension("json.tmp");
    if let Ok(json) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(&tmp, json);
        let _ = fs::rename(tmp, p);
    }
}

fn api_key() -> String {
    std::env::var("PLAYER_API_KEY").unwrap_or_else(|_| "pc-radio-2026".to_string())
}

#[tauri::command]
pub async fn fetch_artwork(title: String, artist: String, station: String) -> ArtworkResult {
    let key = cache_key(&artist, &title);
    let now = now_ms();

    let mut cache = load_cache();

    if let Some(entry) = cache.get(&key) {
        // null TTL hit → nessuna cover
        if entry.null_ttl_expiry > 0 && now < entry.null_ttl_expiry {
            return ArtworkResult { local_path: None, artwork_url: None, from_cache: true, error: None };
        }
        // immagine valida su disco
        if let Some(ref lp) = entry.local_path {
            if std::path::Path::new(lp).exists()
                && (entry.image_ttl_expiry == 0 || now < entry.image_ttl_expiry)
            {
                return ArtworkResult {
                    local_path: Some(lp.clone()),
                    artwork_url: entry.artwork_url.clone(),
                    from_cache: true,
                    error: None,
                };
            }
        }
    }

    // Chiama il server — api_key rimane nel backend Rust
    let title_raw = if artist.is_empty() {
        title.clone()
    } else {
        format!("{} - {}", artist, title)
    };
    let url = format!(
        "https://gus79.it/api/radio-artwork?title={}&station={}&api_key={}",
        urlencoding::encode(&title_raw),
        urlencoding::encode(&station),
        urlencoding::encode(&api_key()),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return ArtworkResult { local_path: None, artwork_url: None, from_cache: false, error: Some(e.to_string()) },
    };

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return ArtworkResult { local_path: None, artwork_url: None, from_cache: false, error: Some(e.to_string()) },
    };

    let artwork_url = body.get("artwork").and_then(|v| v.as_str()).map(String::from);

    if artwork_url.is_none() {
        let entry = CacheEntry {
            key: key.clone(), title, artist,
            artwork_url: None, local_path: None,
            null_ttl_expiry: now + NULL_TTL_MS,
            image_ttl_expiry: 0,
            updated_at: chrono_now(),
        };
        cache.insert(key, entry);
        save_cache(&cache);
        return ArtworkResult { local_path: None, artwork_url: None, from_cache: false, error: None };
    }

    let artwork_url = artwork_url.unwrap();
    let local_path = download_image(&client, &artwork_url, &key).await;

    let entry = CacheEntry {
        key: key.clone(), title, artist,
        artwork_url: Some(artwork_url.clone()),
        local_path: local_path.clone(),
        null_ttl_expiry: 0,
        image_ttl_expiry: if local_path.is_some() { now + IMAGE_TTL_MS } else { 0 },
        updated_at: chrono_now(),
    };
    cache.insert(key, entry);
    save_cache(&cache);

    ArtworkResult { local_path, artwork_url: Some(artwork_url), from_cache: false, error: None }
}

async fn download_image(client: &reqwest::Client, url: &str, key: &str) -> Option<String> {
    let resp = client.get(url).send().await.ok()?;
    let bytes = resp.bytes().await.ok()?;
    let ext = url.split('?').next().unwrap_or(url)
        .rsplit('.').next().filter(|e| e.len() <= 4).unwrap_or("jpg");
    let safe_key = &key[..key.len().min(40)];
    let dir = cache_dir();
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.{}", safe_key, ext));
    fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().to_string())
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("{}", secs)
}
