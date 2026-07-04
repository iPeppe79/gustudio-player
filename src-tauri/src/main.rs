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
async fn set_session_id(
    state:      tauri::State<'_, TelemetryState>,
    session_id: String,
) -> Result<(), ()> {
    if let Ok(mut g) = state.session_id.lock() { *g = session_id; }
    Ok(())
}

/// Inizializzazione minima all'avvio: popola state.info con dati base
/// così send_event funziona subito, anche prima della registrazione completa.
#[tauri::command]
async fn telemetry_init(
    state:      tauri::State<'_, TelemetryState>,
    uuid:       String,
    brand:      String,
    version:    String,
    station_id: String,
    name:       String,
) -> Result<(), ()> {
    let info = telemetry::PlayerInfo {
        uuid:       uuid.clone(),
        brand:      brand.clone(),
        version:    version.clone(),
        os:         telemetry::get_os_string(),
        station_id: station_id.clone(),
        name:       name.clone(),
        hostname:   telemetry::get_hostname(),
        mac:        telemetry::get_mac(),
        insegna:    String::new(),
        via:        String::new(),
        citta:      String::new(),
        referente:  String::new(),
        email:      String::new(),
        telefono:   String::new(),
        password:   String::new(),
    };
    if let Ok(mut g) = state.info.lock() { *g = Some(info); }
    telemetry::start_heartbeat(
        state.info.clone(),
        state.audio_state.clone(),
        state.session_id.clone(),
        state.hb_handle.clone(),
    );
    Ok(())
}

#[tauri::command]
async fn get_system_info() -> serde_json::Value {
    serde_json::json!({
        "hostname": telemetry::get_hostname(),
        "mac":      telemetry::get_mac(),
        "os":       telemetry::get_os_string(),
    })
}

#[tauri::command]
async fn telemetry_register(
    state:      tauri::State<'_, TelemetryState>,
    uuid:       String,
    brand:      String,
    version:    String,
    station_id: String,
    name:       String,
    password:   String,
    insegna:    String,
    via:        String,
    citta:      String,
    referente:  String,
    email:      String,
    telefono:   String,
) -> Result<String, String> {
    let info = telemetry::PlayerInfo {
        uuid:       uuid.clone(),
        brand:      brand.clone(),
        version:    version.clone(),
        os:         telemetry::get_os_string(),
        station_id: station_id.clone(),
        name:       name.clone(),
        hostname:   telemetry::get_hostname(),
        mac:        telemetry::get_mac(),
        insegna:    insegna.clone(),
        via:        via.clone(),
        citta:      citta.clone(),
        referente:  referente.clone(),
        email:      email.clone(),
        telefono:   telefono.clone(),
        password:   password.clone(),
    };
    let result = telemetry::do_register(&info).await;
    if let Ok(mut g) = state.info.lock() { *g = Some(info); }
    telemetry::start_heartbeat(
        state.info.clone(),
        state.audio_state.clone(),
        state.session_id.clone(),
        state.hb_handle.clone(),
    );
    result
}

#[tauri::command]
async fn send_track_change(
    tele:      tauri::State<'_, TelemetryState>,
    session_id: String,
    artist:    Option<String>,
    title:     Option<String>,
    raw_title: Option<String>,
) -> Result<u16, ()> {
    let triplet = tele.info.lock().ok().and_then(|g| {
        g.as_ref().map(|i| (i.uuid.clone(), i.station_id.clone(), i.brand.clone()))
    });
    if let Some((uuid, station_id, brand_id)) = triplet {
        let status = telemetry::post_track_change(
            uuid, session_id, station_id, brand_id, artist, title, raw_title,
        ).await;
        return Ok(status);
    }
    Ok(0)
}

/// Evento diagnostico generico
#[tauri::command]
async fn send_event(
    tele:        tauri::State<'_, TelemetryState>,
    event:       String,
    audio_state: Option<String>,
    issue_type:  Option<String>,
    issue_note:  Option<String>,
    extra:       Option<serde_json::Value>,
) -> Result<u16, ()> {
    if let Some(ref s) = audio_state {
        if let Ok(mut g) = tele.audio_state.lock() { *g = s.clone(); }
    }

    let quad = tele.info.lock().ok().and_then(|g| {
        g.as_ref().map(|i| (i.uuid.clone(), i.station_id.clone(), i.brand.clone(), i.version.clone()))
    });
    let sid = tele.session_id.lock().ok().map(|g| g.clone()).unwrap_or_default();

    if let Some((uuid, station_id, brand_id, version)) = quad {
        let status = telemetry::post_event(
            uuid, sid, event, station_id, brand_id,
            audio_state, issue_type, issue_note, version, extra,
        ).await;
        return Ok(status);
    }
    Ok(0)
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
            get_system_info,
            set_session_id,
            telemetry_init,
            telemetry_register,
            send_event,
            send_track_change,
            telemetry_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
