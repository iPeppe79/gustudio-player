use std::sync::{Arc, Mutex};
use serde::Serialize;
use tokio::task::JoinHandle;
use tokio::time::Duration;
use chrono::Utc;

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
    pub session_id:  Arc<Mutex<String>>,
}

impl TelemetryState {
    pub fn new() -> Self {
        Self {
            info:        Arc::new(Mutex::new(None)),
            hb_handle:   Arc::new(Mutex::new(None)),
            audio_state: Arc::new(Mutex::new("stopped".to_string())),
            session_id:  Arc::new(Mutex::new(String::new())),
        }
    }
}

// Payload evento — schema v2, mantiene uuid (obbligatorio server) + campi camelCase v2
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    uuid:           String,    // obbligatorio dal server
    schema_version: u8,        // schemaVersion: 2
    client_id:      String,    // clientId (alias uuid per schema v2)
    session_id:     String,    // sessionId
    station_id:     String,    // stationId
    brand_id:       String,    // brandId
    event:          String,
    #[serde(skip_serializing_if = "Option::is_none")]
    playback_state: Option<String>,  // playbackState
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_type:     Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_note:     Option<String>,
    os:             String,
    os_version:     String,    // osVersion
    architecture:   String,
    app_version:    String,    // appVersion
    audio_engine:   String,    // audioEngine
    ts:             u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra:          Option<serde_json::Value>,
}

// ── Funzioni di invio ─────────────────────────────────────────────────────────

pub async fn post_event(
    uuid:        String,
    session_id:  String,
    event:       String,
    station_id:  String,
    brand_id:    String,
    audio_state: Option<String>,
    issue_type:  Option<String>,
    issue_note:  Option<String>,
    version:     String,
    extra:       Option<serde_json::Value>,
) -> u16 {
    let url     = format!("{}/player-health?api_key={}", BASE, api_key());
    let os_info = os_info::get();
    let payload = EventPayload {
        uuid:       uuid.clone(),
        schema_version: 2,
        client_id:  uuid,
        session_id,
        station_id,
        brand_id,
        event,
        playback_state: audio_state,
        issue_type,
        issue_note,
        os:           std::env::consts::OS.to_string(),
        os_version:   format!("{} {}", os_info.os_type(), os_info.version()),
        architecture: std::env::consts::ARCH.to_string(),
        app_version:  version,
        audio_engine: "mpv".to_string(),
        ts:           now_secs(),
        extra,
    };
    match client().post(&url).json(&payload).send().await {
        Ok(resp) => resp.status().as_u16(),
        Err(_)   => 0,
    }
}

// Payload track change compatibile schema v2
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackChangePayload {
    schema_version: u8,
    client_id:      String,
    session_id:     String,
    station_id:     String,
    brand_id:       String,
    artist:         Option<String>,
    title:          Option<String>,
    raw_title:      Option<String>,
    is_spot:        bool,
    track_change_time: String,
}

pub async fn post_track_change(
    uuid:       String,
    session_id: String,
    station_id: String,
    brand_id:   String,
    artist:     Option<String>,
    title:      Option<String>,
    raw_title:  Option<String>,
) -> u16 {
    let url = format!("{}/player-health?api_key={}", BASE, api_key());
    let now = Utc::now().to_rfc3339();
    let payload = TrackChangePayload {
        schema_version: 2,
        client_id:  uuid,
        session_id,
        station_id,
        brand_id,
        artist,
        title,
        raw_title,
        is_spot: false,
        track_change_time: now,
    };
    match client().post(&url).json(&payload).send().await {
        Ok(resp) => resp.status().as_u16(),
        Err(_)   => 0,
    }
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
    session_id:  Arc<Mutex<String>>,
    hb_handle:   Arc<Mutex<Option<JoinHandle<()>>>>,
) {
    if let Ok(mut g) = hb_handle.lock() {
        if let Some(h) = g.take() { h.abort(); }
    }

    let h = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;

            let quad = info.lock().ok()
                .and_then(|g| g.as_ref().map(|i| (
                    i.uuid.clone(), i.station_id.clone(), i.brand.clone(), i.version.clone(),
                )));

            if let Some((uuid, station_id, brand_id, version)) = quad {
                let astate = audio_state.lock().ok()
                    .map(|g| g.clone())
                    .unwrap_or_else(|| "unknown".to_string());
                let sid = session_id.lock().ok()
                    .map(|g| g.clone())
                    .unwrap_or_default();

                let _status = post_event(
                    uuid, sid, "APP_HEALTHY".into(), station_id, brand_id,
                    Some(astate), None, None, version, None,
                ).await;
            }
        }
    });

    if let Ok(mut g) = hb_handle.lock() { *g = Some(h); }
}
