#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artwork;
mod icy;

use icy::IcyState;

#[tauri::command]
fn start_icy(state: tauri::State<'_, IcyState>, app: tauri::AppHandle, url: String) {
    state.start(app, url);
}

#[tauri::command]
fn stop_icy(state: tauri::State<'_, IcyState>) {
    state.stop();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .manage(IcyState::new())
        .invoke_handler(tauri::generate_handler![
            artwork::fetch_artwork,
            start_icy,
            stop_icy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
