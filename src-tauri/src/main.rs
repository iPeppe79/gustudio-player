#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artwork;
mod icy;
mod telemetry;

use icy::IcyState;
use telemetry::TelemetryState;

// ── ICY ───────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn start_icy(
    state: tauri::State<'_, IcyState>,
    app:   tauri::AppHandle,
    url:   String,
) -> Result<(), ()> {
    state.start(app, url);
    Ok(())
}

#[tauri::command]
async fn stop_icy(state: tauri::State<'_, IcyState>) -> Result<(), ()> {
    state.stop();
    Ok(())
}

// ── Telemetria ────────────────────────────────────────────────────────────────

#[tauri::command]
async fn telemetry_register(
    state:      tauri::State<'_, TelemetryState>,
    uuid:       String,
    brand:      String,
    version:    String,
    station_id: String,
) -> Result<String, String> {
    let info = telemetry::PlayerInfo {
        uuid:       uuid.clone(),
        brand:      brand.clone(),
        version:    version.clone(),
        os:         std::env::consts::OS.to_string(),
        station_id: station_id.clone(),
    };
    let result = telemetry::do_register(&info).await;
    if let Ok(mut g) = state.info.lock() { *g = Some(info); }
    telemetry::start_heartbeat(
        state.info.clone(),
        state.audio_state.clone(),
        state.hb_handle.clone(),
    );
    result
}

/// Evento diagnostico generico — payload verificato col server
#[tauri::command]
async fn send_event(
    tele:        tauri::State<'_, TelemetryState>,
    event:       String,
    audio_state: Option<String>,
    issue_type:  Option<String>,
    issue_note:  Option<String>,
    extra:       Option<serde_json::Value>,
) -> Result<(), ()> {
    // Aggiorna audio_state condiviso (usato dall'heartbeat)
    if let Some(ref s) = audio_state {
        if let Ok(mut g) = tele.audio_state.lock() { *g = s.clone(); }
    }

    let triplet = tele.info.lock().ok().and_then(|g| {
        g.as_ref().map(|i| (i.uuid.clone(), i.station_id.clone(), i.version.clone()))
    });

    if let Some((uuid, station_id, version)) = triplet {
        tokio::spawn(telemetry::post_event(
            uuid, event, station_id,
            audio_state, issue_type, issue_note, version, extra,
        ));
    }
    Ok(())
}

#[tauri::command]
async fn telemetry_health(
    tele: tauri::State<'_, TelemetryState>,
) -> Result<serde_json::Value, String> {
    let (uuid, station_id, version) = tele.info.lock().ok()
        .and_then(|g| g.as_ref().map(|i| (i.uuid.clone(), i.station_id.clone(), i.version.clone())))
        .unwrap_or_default();

    let url  = format!("https://gus79.it/api/player-health?api_key={}", telemetry::api_key());
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({
            "uuid": uuid, "event": "health_check",
            "station_id": station_id, "version": version,
        }))
        .send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body   = resp.text().await.unwrap_or_default();
    Ok(serde_json::json!({ "status": status, "body": body }))
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .manage(IcyState::new())
        .manage(TelemetryState::new())
        .invoke_handler(tauri::generate_handler![
            // audio
            start_icy,
            stop_icy,
            // cover
            artwork::fetch_artwork,
            artwork::get_cache_info,
            artwork::clear_artwork_cache,
            artwork::save_brand_fallback,
            artwork::get_brand_fallback,
            // telemetria
            telemetry_register,
            send_event,
            telemetry_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
