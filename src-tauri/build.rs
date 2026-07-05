fn main() {
    // Espone il target triple al codice (risoluzione binario mpv sidecar in dev).
    let triple = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=MPV_TARGET_TRIPLE={triple}");
    tauri_build::build()
}
