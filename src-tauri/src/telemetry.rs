use std::sync::{Arc, Mutex};
use serde::Serialize;
use tokio::task::JoinHandle;
use tokio::time::Duration;

const BASE: &str = "https://gus79.it/api";

pub fn api_key() -> String {
    std::env::var("PLAYER_API_KEY").unwrap_or_else(|_| "pc-radio-2026".to_string())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap()
}

// ── Strutture dati ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PlayerInfo {
    pub uuid:       String,
    pub brand:      String,
    pub version:    String,
    pub os:         String,
    pub station_id: String,
    pub name:       String,
    pub hostname:   String,
    pub mac:        String,
    pub insegna:    String,
    pub via:        String,
    pub citta:      String,
    pub referente:  String,
    pub email:      String,
    pub telefono:   String,
    pub password:   String,
}

pub fn get_hostname() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

pub fn get_mac() -> String {
    mac_address::get_mac_address()
        .ok()
        .flatten()
        .map(|m| m.to_string())
        .unwrap_or_else(|| "00-00-00-00-00-00".to_string())
}

pub fn get_os_string() -> String {
    let info = os_info::get();
    format!("{} {}", info.os_type(), info.version())
}

pub struct TelemetryState {
    pub info:        Arc<Mutex<Option<PlayerInfo>>>,
    pub hb_handle:   Arc<Mutex<Option<JoinHandle<()>>>>,
    pub audio_state: Arc<Mutex<String>>,
}

impl TelemetryState {
    pub fn new() -> Self {
        Self {
            info:        Arc::new(Mutex::new(None)),
            hb_handle:   Arc::new(Mutex::new(None)),
            audio_state: Arc::new(Mutex::new("stopped".to_string())),
        }
    }
}

// Payload canonico verificato con il server
#[derive(Serialize)]
struct EventPayload {
    uuid:         String,
    event:        String,
    station_id:   String,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_state:  Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_type:   Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_note:   Option<String>,
    os:           String,
    architecture: String,
    version:      String,
    ts:           u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra:        Option<serde_json::Value>,
}

// ── Funzioni di invio ─────────────────────────────────────────────────────────

pub async fn post_event(
    uuid:        String,
    event:       String,
    station_id:  String,
    audio_state: Option<String>,
    issue_type:  Option<String>,
    issue_note:  Option<String>,
    version:     String,
    extra:       Option<serde_json::Value>,
) {
    let url     = format!("{}/player-health?api_key={}", BASE, api_key());
    let payload = EventPayload {
        uuid, event, station_id,
        audio_state, issue_type, issue_note,
        os:           std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        version,
        ts:           now_secs(),
        extra,
    };
    let _ = client().post(&url).json(&payload).send().await;
}

pub async fn do_register(info: &PlayerInfo) -> Result<String, String> {
    let url  = format!("{}/player-register?api_key={}", BASE, api_key());
    let resp = client().post(&url).json(info).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body   = resp.text().await.unwrap_or_default();
    if status < 400 { Ok(body) } else { Err(format!("HTTP {status}: {body}")) }
}

// ── Heartbeat loop ────────────────────────────────────────────────────────────

pub fn start_heartbeat(
    info:        Arc<Mutex<Option<PlayerInfo>>>,
    audio_state: Arc<Mutex<String>>,
    hb_handle:   Arc<Mutex<Option<JoinHandle<()>>>>,
) {
    if let Ok(mut g) = hb_handle.lock() {
        if let Some(h) = g.take() { h.abort(); }
    }

    let h = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            let pair = info.lock().ok()
                .and_then(|g| g.as_ref().map(|i| (
                    i.uuid.clone(), i.station_id.clone(), i.version.clone(),
                )));

            if let Some((uuid, station_id, version)) = pair {
                let astate = audio_state.lock().ok()
                    .map(|g| g.clone())
                    .unwrap_or_else(|| "unknown".to_string());

                post_event(
                    uuid, "HEARTBEAT".into(), station_id,
                    Some(astate), None, None, version, None,
                ).await;
            }
        }
    });

    if let Ok(mut g) = hb_handle.lock() { *g = Some(h); }
}
