#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artwork;
mod icy;
mod mpv;
mod telemetry;

use icy::IcyState;
use mpv::MpvState;
use telemetry::TelemetryState;

// ── mpv (motore audio) ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn apply_native_window_mask(app: &tauri::App) {
    use objc2::msg_send;
    use objc2_app_kit::{NSColor, NSWindow};
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[window-mask] main window not found");
        return;
    };

    let ns_window = match window.ns_window() {
        Ok(ptr) => ptr as *mut NSWindow,
        Err(err) => {
            eprintln!("[window-mask] ns_window unavailable: {err}");
            return;
        }
    };

    unsafe {
        let ns_window = &*ns_window;
        let clear = NSColor::clearColor();

        ns_window.setOpaque(false);
        ns_window.setBackgroundColor(Some(&clear));
        let _: () = msg_send![ns_window, setHasShadow: false];

        if let Some(content_view) = ns_window.contentView() {
            apply_rounded_clip_to_view(&content_view);
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_native_window_mask(app: &tauri::App) {
    use tauri::Manager;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED,
    };

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[window-mask] main window not found");
        return;
    };

    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd,
        Err(err) => {
            eprintln!("[window-mask] hwnd unavailable: {err}");
            return;
        }
    };

    unsafe {
        let hwnd = HWND(hwnd.0);
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as isize);

        let scale = window.scale_factor().unwrap_or(1.0);
        let w = (300.0 * scale).round() as i32;
        let h = (502.0 * scale).round() as i32;
        let radius = (18.0 * scale).round() as i32;
        let region = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2);
        if region.0.is_null() {
            eprintln!("[window-mask] CreateRoundRectRgn failed");
            return;
        }
        if SetWindowRgn(hwnd, region, true) == 0 {
            eprintln!("[window-mask] SetWindowRgn failed");
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply_native_window_mask(_app: &tauri::App) {}

#[cfg(target_os = "macos")]
unsafe fn apply_rounded_clip_to_view(view: &objc2_app_kit::NSView) {
    use objc2::msg_send;

    view.setWantsLayer(true);
    if let Some(layer) = view.layer() {
        let _: () = msg_send![&*layer, setMasksToBounds: true];
        let _: () = msg_send![&*layer, setCornerRadius: 18.0_f64];
    }
}

#[tauri::command]
async fn mpv_init(state: tauri::State<'_, MpvState>, app: tauri::AppHandle) -> Result<(), ()> {
    state.init(app);
    Ok(())
}

#[tauri::command]
async fn mpv_play(state: tauri::State<'_, MpvState>, url: String) -> Result<(), ()> {
    state.play(url);
    Ok(())
}

#[tauri::command]
async fn mpv_pause(state: tauri::State<'_, MpvState>) -> Result<(), ()> {
    state.pause();
    Ok(())
}

#[tauri::command]
async fn mpv_resume(state: tauri::State<'_, MpvState>) -> Result<(), ()> {
    state.resume();
    Ok(())
}

#[tauri::command]
async fn mpv_stop(state: tauri::State<'_, MpvState>) -> Result<(), ()> {
    state.stop();
    Ok(())
}

#[tauri::command]
async fn mpv_set_volume(state: tauri::State<'_, MpvState>, volume: f64) -> Result<(), ()> {
    state.set_volume(volume);
    Ok(())
}

#[tauri::command]
async fn mpv_is_alive(state: tauri::State<'_, MpvState>) -> Result<bool, ()> {
    Ok(state.is_alive())
}

#[tauri::command]
async fn mpv_stats(state: tauri::State<'_, MpvState>) -> Result<serde_json::Value, ()> {
    Ok(state.stats())
}

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
        local_ip:   telemetry::get_local_ip(),
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
        state.hb_handle.clone(),
    );
    Ok(())
}

#[tauri::command]
async fn get_system_info() -> serde_json::Value {
    serde_json::json!({
        "hostname": telemetry::get_hostname(),
        "local_ip": telemetry::get_local_ip(),
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
        local_ip:   telemetry::get_local_ip(),
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
        state.hb_handle.clone(),
    );
    result
}

/// Iscrizione community (B2C) — inoltra il payload alla lista dedicata.
#[tauri::command]
async fn community_register(payload: serde_json::Value) -> Result<u16, ()> {
    Ok(telemetry::post_community(payload).await)
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
        g.as_ref().map(|i| (i.uuid.clone(), i.hostname.clone(), i.station_id.clone(), i.brand.clone(), i.version.clone()))
    });

    if let Some((uuid, hostname, station_id, brand_id, version)) = quad {
        let status = telemetry::post_event(
            uuid, hostname, event, station_id, brand_id,
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
            "hostname": telemetry::get_hostname(),
            "username": telemetry::get_username(),
            "local_ip": telemetry::get_local_ip(),
            "mac": telemetry::get_mac(),
            "platform": format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
            "os": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "audio_engine": crate::mpv::AUDIO_ENGINE,
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
        .manage(MpvState::new())
        .setup(|app| {
            apply_native_window_mask(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // audio (mpv)
            mpv_init,
            mpv_play,
            mpv_pause,
            mpv_resume,
            mpv_stop,
            mpv_set_volume,
            mpv_is_alive,
            mpv_stats,
            // ICY metadata
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
            community_register,
            send_event,
            send_track_change,
            telemetry_health,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Alla chiusura app: ferma mpv e i figli PCM senza riavvii.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                app.state::<MpvState>().shutdown();
            }
        });
}
