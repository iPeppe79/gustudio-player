// Motore audio mpv orchestrato dal backend Rust di Tauri.
//
// Porta in Rust la logica del vecchio player Electron (mpv-electron-main-11giugno.js):
//   - spawn del binario mpv giusto per arch (sidecar Tauri o mpv di sistema in dev)
//   - controllo via socket IPC JSON (loadfile/pause/stop/volume + observe_property)
//   - eventi mpv digeriti e inoltrati al frontend (mpv-state / mpv-event / mpv-restart)
//   - WATCHDOG anti-silenzio: se core-idle resta bloccato o mpv esce mentre vogliamo
//     suonare, KILL + RESTART automatico (il fallback che mancava su Windows)
//   - secondo processo mpv che estrae PCM float32 → FFT (rustfft) → bande → evento
//     "eq-bands" ~60fps per il visualizer reale.
//
// Sostituisce completamente il tag <audio> di WebKit.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// Etichetta motore audio — usata dalla telemetria. Ora è VERO: mpv.
pub const AUDIO_ENGINE: &str = "mpv";

// Se core-idle resta true (nessun output audio) per più di questo mentre vogliamo
// suonare, il watchdog considera lo stream morto e riavvia mpv.
const STALL_RESTART_SECS: u64 = 8;

// Parametri FFT del visualizer.
const FFT_SIZE: usize = 1024;
const FFT_HOP: usize = 735; // ~60 frame/s a 44100 Hz
const NUM_BANDS: usize = 48;

// ── Stato condiviso ─────────────────────────────────────────────────────────────

struct Inner {
    app: Mutex<Option<AppHandle>>,
    // canale verso il writer del socket mpv (None finché non connesso)
    cmd_tx: Mutex<Option<UnboundedSender<String>>>,
    current_url: Mutex<Option<String>>,
    want_play: AtomicBool,
    volume: AtomicU64, // 0..100
    shutdown: AtomicBool,
    started: AtomicBool,
    alive: AtomicBool, // processo mpv principale connesso e vivo
    // PCM / FFT
    pcm_child: Mutex<Option<Child>>,
    pcm_gen: AtomicU64, // generazione: invalida i task PCM vecchi al restart
}

#[derive(Clone)]
pub struct MpvState {
    inner: Arc<Inner>,
}

impl MpvState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                app: Mutex::new(None),
                cmd_tx: Mutex::new(None),
                current_url: Mutex::new(None),
                want_play: AtomicBool::new(false),
                volume: AtomicU64::new(80),
                shutdown: AtomicBool::new(false),
                started: AtomicBool::new(false),
                alive: AtomicBool::new(false),
                pcm_child: Mutex::new(None),
                pcm_gen: AtomicU64::new(0),
            }),
        }
    }

    /// True se il processo mpv principale è vivo e connesso.
    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::Relaxed)
    }

    /// Avvia il supervisore (idempotente). Da chiamare una volta con l'AppHandle.
    pub fn init(&self, app: AppHandle) {
        if let Ok(mut g) = self.inner.app.lock() {
            *g = Some(app);
        }
        if self.inner.started.swap(true, Ordering::SeqCst) {
            return; // già avviato
        }
        let inner = self.inner.clone();
        // async_runtime di Tauri: init() è chiamata da setup() (contesto sync),
        // dove tokio::spawn panicherebbe ("no reactor running").
        tauri::async_runtime::spawn(async move { supervisor(inner).await });
    }

    fn send_cmd(&self, value: serde_json::Value) {
        let line = value.to_string() + "\n";
        if let Ok(g) = self.inner.cmd_tx.lock() {
            if let Some(tx) = g.as_ref() {
                let _ = tx.send(line);
            }
        }
    }

    pub fn play(&self, url: String) {
        if let Ok(mut g) = self.inner.current_url.lock() {
            *g = Some(url.clone());
        }
        self.inner.want_play.store(true, Ordering::Relaxed);
        // loadfile immediato se già connessi; altrimenti il supervisore lo farà al connect.
        self.send_cmd(json!({ "command": ["loadfile", url.clone(), "replace"] }));
        self.send_cmd(json!({ "command": ["set_property", "pause", false] }));
        // avvia il ramo PCM/FFT
        start_pcm(self.inner.clone(), url);
    }

    pub fn pause(&self) {
        self.send_cmd(json!({ "command": ["set_property", "pause", true] }));
    }

    pub fn resume(&self) {
        self.send_cmd(json!({ "command": ["set_property", "pause", false] }));
    }

    pub fn stop(&self) {
        self.inner.want_play.store(false, Ordering::Relaxed);
        if let Ok(mut g) = self.inner.current_url.lock() {
            *g = None;
        }
        self.send_cmd(json!({ "command": ["stop"] }));
        stop_pcm(&self.inner);
        emit(&self.inner, "mpv-state", json!({ "phase": "idle", "reason": "stop" }));
    }

    pub fn set_volume(&self, vol: f64) {
        let v = vol.clamp(0.0, 100.0).round() as u64;
        self.inner.volume.store(v, Ordering::Relaxed);
        self.send_cmd(json!({ "command": ["set_property", "volume", v] }));
    }

    /// Da chiamare alla chiusura app: ferma tutto senza riavvii.
    pub fn shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::Relaxed);
        self.inner.want_play.store(false, Ordering::Relaxed);
        self.send_cmd(json!({ "command": ["quit"] }));
        stop_pcm(&self.inner);
    }
}

fn emit(inner: &Arc<Inner>, event: &str, payload: serde_json::Value) {
    if let Ok(g) = inner.app.lock() {
        if let Some(app) = g.as_ref() {
            let _ = app.emit(event, payload);
        }
    }
}

// ── Risoluzione binario mpv ──────────────────────────────────────────────────────
//
// In bundle Tauri copia il sidecar `bin/mpv-<triple>` accanto all'eseguibile
// spogliato del triple → `<exe_dir>/mpv[.exe]`. In dev ripiega su un `bin/` locale
// o su mpv di sistema (PATH).
fn mpv_binary() -> String {
    let exe_name = if cfg!(windows) { "mpv.exe" } else { "mpv" };

    // 1) sidecar accanto all'eseguibile
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join(exe_name);
            if cand.exists() {
                return cand.to_string_lossy().to_string();
            }
        }
    }
    // 2) src-tauri/bin/<triple> in dev
    let triple = env!("MPV_TARGET_TRIPLE");
    let dev_name = if cfg!(windows) {
        format!("mpv-{triple}.exe")
    } else {
        format!("mpv-{triple}")
    };
    let dev_cand = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(&dev_name);
    if dev_cand.exists() {
        return dev_cand.to_string_lossy().to_string();
    }
    let dev_plain = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(exe_name);
    if dev_plain.exists() {
        return dev_plain.to_string_lossy().to_string();
    }
    // 3) mpv di sistema
    "mpv".to_string()
}

fn ipc_socket_path() -> String {
    let pid = std::process::id();
    if cfg!(windows) {
        format!("\\\\.\\pipe\\mpvsocket-{pid}")
    } else {
        std::env::temp_dir()
            .join(format!("mpvsocket-{pid}"))
            .to_string_lossy()
            .to_string()
    }
}

// ── Supervisore processo mpv principale ──────────────────────────────────────────

async fn supervisor(inner: Arc<Inner>) {
    let mut attempt: u32 = 0;
    loop {
        if inner.shutdown.load(Ordering::Relaxed) {
            return;
        }

        let sock_path = ipc_socket_path();
        // pulizia socket stantìo (unix)
        #[cfg(unix)]
        let _ = std::fs::remove_file(&sock_path);

        let binary = mpv_binary();
        let mut cmd = Command::new(&binary);
        cmd.args([
            "--no-video",
            "--idle=yes",
            "--no-terminal",
            "--no-config",
            "--quiet",
            &format!("--input-ipc-server={sock_path}"),
            "--cache=yes",
            "--cache-secs=30",
            "--demuxer-max-bytes=50M",
            "--stream-buffer-size=512k",
            "--no-cache-pause",
            // reconnect ffmpeg + timeout esplicito (MANCAVA nel vecchio player → causa silenzio Windows)
            "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5",
            "--network-timeout=10",
            &format!("--volume={}", inner.volume.load(Ordering::Relaxed)),
        ]);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        cmd.kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                emit(
                    &inner,
                    "mpv-state",
                    json!({ "phase": "error", "reason": format!("spawn_failed: {e}") }),
                );
                eprintln!("[mpv] spawn error ({binary}): {e}");
                attempt = attempt.saturating_add(1);
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        // connessione socket con retry
        let stream = connect_ipc(&sock_path).await;
        let (reader, writer) = match stream {
            Some(rw) => rw,
            None => {
                eprintln!("[mpv] IPC socket non connesso: {sock_path}");
                let mut child = child;
                let _ = child.kill().await;
                attempt = attempt.saturating_add(1);
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };

        // writer task + canale comandi
        let (tx, mut rx) = unbounded_channel::<String>();
        if let Ok(mut g) = inner.cmd_tx.lock() {
            *g = Some(tx.clone());
        }
        let writer_handle = tokio::spawn(async move {
            let mut w = writer;
            while let Some(line) = rx.recv().await {
                if w.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = w.flush().await;
            }
        });

        inner.alive.store(true, Ordering::Relaxed);
        attempt = 0;
        emit(&inner, "mpv-ready", json!({}));

        // observe_property (stessi id del vecchio player)
        let _ = tx.send(json!({"command":["observe_property",1,"playback-time"]}).to_string() + "\n");
        let _ = tx.send(json!({"command":["observe_property",2,"pause"]}).to_string() + "\n");
        let _ = tx.send(json!({"command":["observe_property",3,"core-idle"]}).to_string() + "\n");
        let _ = tx.send(json!({"command":["observe_property",4,"demuxer-cache-duration"]}).to_string() + "\n");
        // volume corrente
        let _ = tx.send(
            json!({"command":["set_property","volume", inner.volume.load(Ordering::Relaxed)]}).to_string()
                + "\n",
        );

        // se vogliamo già suonare, (ri)carica lo stream — questo è il RECONNECT automatico
        let resume_url = inner.current_url.lock().ok().and_then(|g| g.clone());
        if inner.want_play.load(Ordering::Relaxed) {
            if let Some(url) = resume_url.clone() {
                let _ = tx.send(json!({"command":["loadfile", url.clone(), "replace"]}).to_string() + "\n");
                let _ = tx.send(json!({"command":["set_property","pause",false]}).to_string() + "\n");
                start_pcm(inner.clone(), url);
            }
        }

        // loop lettore + watchdog
        let restart_reason = reader_loop(inner.clone(), reader).await;

        // teardown connessione corrente
        inner.alive.store(false, Ordering::Relaxed);
        if let Ok(mut g) = inner.cmd_tx.lock() {
            *g = None;
        }
        writer_handle.abort();
        let mut child = child;
        let _ = child.kill().await;

        if inner.shutdown.load(Ordering::Relaxed) {
            stop_pcm(&inner);
            return;
        }

        // riavvia solo se vogliamo ancora suonare (mpv --idle non dovrebbe uscire da solo)
        if let Some(reason) = restart_reason {
            attempt += 1;
            emit(
                &inner,
                "mpv-restart",
                json!({ "reason": reason, "attempt": attempt }),
            );
        }
        // backoff leggero anti-spam
        let backoff = (attempt.min(5) as u64).max(1);
        tokio::time::sleep(Duration::from_millis(400 * backoff)).await;
    }
}

/// Ritorna Some(reason) se serve un riavvio, None se uscita pulita (shutdown).
async fn reader_loop(
    inner: Arc<Inner>,
    reader: Box<dyn AsyncRead + Unpin + Send>,
) -> Option<String> {
    let mut lines = BufReader::new(reader).lines();
    let mut interval = tokio::time::interval(Duration::from_millis(500));

    // stato digerito
    let mut core_idle = true;
    let mut phase = String::from("idle");
    let mut idle_since: Option<Instant> = None;
    let mut eof_reason: Option<String> = None;
    let mut cache_dur: f64 = 0.0;
    let mut last_cache_adv = Instant::now();

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if l.trim().is_empty() { continue; }
                        let msg: serde_json::Value = match serde_json::from_str(&l) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        // inoltra evento grezzo per log/osservabilità
                        if msg.get("event").is_some() {
                            emit(&inner, "mpv-event", msg.clone());
                        }
                        if let Some(ev) = msg.get("event").and_then(|v| v.as_str()) {
                            match ev {
                                "property-change" => {
                                    let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                    match name {
                                        "core-idle" => {
                                            core_idle = msg.get("data").and_then(|v| v.as_bool()).unwrap_or(true);
                                            if core_idle {
                                                if idle_since.is_none() { idle_since = Some(Instant::now()); }
                                            } else {
                                                idle_since = None;
                                            }
                                        }
                                        "demuxer-cache-duration" => {
                                            if let Some(d) = msg.get("data").and_then(|v| v.as_f64()) {
                                                if d > cache_dur + 0.01 { last_cache_adv = Instant::now(); }
                                                cache_dur = d;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                "file-loaded" | "playback-restart" => {
                                    eof_reason = None;
                                    emit(&inner, "mpv-state", json!({ "phase": "stream_open" }));
                                }
                                "end-file" => {
                                    let reason = msg.get("reason").and_then(|v| v.as_str()).unwrap_or("eof").to_string();
                                    eof_reason = Some(reason);
                                }
                                _ => {}
                            }
                        }

                        // ricalcola fase digerita
                        let want = inner.want_play.load(Ordering::Relaxed);
                        let new_phase = if !want {
                            "idle"
                        } else if let Some(ref r) = eof_reason {
                            if r == "error" { "error" } else { "ended" }
                        } else if core_idle {
                            "buffering"
                        } else {
                            "playing"
                        };
                        if new_phase != phase {
                            phase = new_phase.to_string();
                            emit(&inner, "mpv-state", json!({
                                "phase": phase,
                                "cache_secs": cache_dur,
                            }));
                        }
                    }
                    Ok(None) | Err(_) => {
                        // socket chiuso / mpv uscito
                        return Some("process_exit".to_string());
                    }
                }
            }
            _ = interval.tick() => {
                if inner.shutdown.load(Ordering::Relaxed) { return None; }
                let want = inner.want_play.load(Ordering::Relaxed);
                if want {
                    // watchdog: core-idle bloccato troppo a lungo → stream morto
                    let stalled_idle = idle_since
                        .map(|t| t.elapsed().as_secs() >= STALL_RESTART_SECS)
                        .unwrap_or(false);
                    // oppure cache ferma da troppo tempo mentre non stiamo suonando
                    let stalled_cache = core_idle && last_cache_adv.elapsed().as_secs() >= STALL_RESTART_SECS;
                    if stalled_idle || stalled_cache {
                        let stall_ms = idle_since.map(|t| t.elapsed().as_millis()).unwrap_or(0);
                        emit(&inner, "mpv-state", json!({
                            "phase": "silent",
                            "reason": "watchdog_stall",
                            "stall_ms": stall_ms,
                        }));
                        return Some(format!("watchdog_stall_{stall_ms}ms"));
                    }
                }
            }
        }
    }
}

// ── Connessione IPC cross-platform ───────────────────────────────────────────────

type BoxRead = Box<dyn AsyncRead + Unpin + Send>;
type BoxWrite = Box<dyn AsyncWrite + Unpin + Send>;

async fn connect_ipc(path: &str) -> Option<(BoxRead, BoxWrite)> {
    // retry: mpv crea il socket poco dopo lo spawn
    for _ in 0..60 {
        #[cfg(unix)]
        {
            if let Ok(s) = tokio::net::UnixStream::connect(path).await {
                let (r, w) = s.into_split();
                return Some((Box::new(r), Box::new(w)));
            }
        }
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ClientOptions;
            match ClientOptions::new().open(path) {
                Ok(c) => {
                    let (r, w) = tokio::io::split(c);
                    return Some((Box::new(r), Box::new(w)));
                }
                Err(_) => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    None
}

// ── Ramo PCM → FFT → bande visualizer ────────────────────────────────────────────

fn stop_pcm(inner: &Arc<Inner>) {
    inner.pcm_gen.fetch_add(1, Ordering::SeqCst); // invalida task PCM in corso
    if let Ok(mut g) = inner.pcm_child.lock() {
        if let Some(mut child) = g.take() {
            let _ = child.start_kill();
        }
    }
}

fn start_pcm(inner: Arc<Inner>, url: String) {
    stop_pcm(&inner);

    // Windows: niente ramo PCM/FFT (come il vecchio player Electron). mpv non scrive
    // PCM su una pipe stdout affidabile lì; l'EQ resta piatto ma l'audio funziona.
    #[cfg(windows)]
    {
        let _ = (inner, url);
        return;
    }
    #[cfg(unix)]
    {
    let my_gen = inner.pcm_gen.load(Ordering::SeqCst);

    let binary = mpv_binary();
    let mut cmd = Command::new(&binary);
    cmd.args([
        "--no-video",
        "--no-terminal",
        "--no-config",
        "--quiet",
        "--ao=pcm",
        // mpv NON scrive su "-": /dev/stdout sì (verificato). Va sul fd della pipe.
        "--ao-pcm-file=/dev/stdout",
        "--ao-pcm-waveheader=no",   // niente header WAV → solo campioni
        "--af=aformat=sample_fmts=flt:channel_layouts=mono:sample_rates=44100",
        "--volume=100",
        &url,
    ]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[pcm] spawn error: {e}");
            return;
        }
    };
    let stdout = child.stdout.take();
    if let Ok(mut g) = inner.pcm_child.lock() {
        *g = Some(child);
    }

    let Some(mut stdout) = stdout else { return };
    tokio::spawn(async move {
        use rustfft::{num_complex::Complex, FftPlanner};
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);

        // finestra di Hann precalcolata
        let hann: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                let x = std::f32::consts::PI * i as f32 / (FFT_SIZE as f32 - 1.0);
                x.sin() * x.sin()
            })
            .collect();

        // edge log-spaziati sui bin 1..FFT_SIZE/2
        let bin_max = FFT_SIZE / 2;
        let band_edges: Vec<usize> = (0..=NUM_BANDS)
            .map(|b| {
                let frac = b as f32 / NUM_BANDS as f32;
                let lo = 1.0_f32.ln();
                let hi = (bin_max as f32).ln();
                (lo + (hi - lo) * frac).exp().round() as usize
            })
            .map(|v| v.clamp(1, bin_max))
            .collect();

        let mut byte_buf: Vec<u8> = Vec::with_capacity(FFT_SIZE * 8);
        let mut samples: Vec<f32> = Vec::with_capacity(FFT_SIZE * 4);
        let mut read_buf = [0u8; 8192];
        let mut last_emit = Instant::now();

        loop {
            if inner.pcm_gen.load(Ordering::SeqCst) != my_gen {
                break; // superato da un nuovo start_pcm/stop_pcm
            }
            let n = match stdout.read(&mut read_buf).await {
                Ok(0) => break, // EOF
                Ok(n) => n,
                Err(_) => break,
            };
            byte_buf.extend_from_slice(&read_buf[..n]);

            // bytes → f32 LE
            let usable = byte_buf.len() - (byte_buf.len() % 4);
            let mut i = 0;
            while i < usable {
                let b = [byte_buf[i], byte_buf[i + 1], byte_buf[i + 2], byte_buf[i + 3]];
                samples.push(f32::from_le_bytes(b));
                i += 4;
            }
            byte_buf.drain(0..usable);

            // STFT a salti di FFT_HOP
            while samples.len() >= FFT_SIZE {
                let mut spectrum: Vec<Complex<f32>> = (0..FFT_SIZE)
                    .map(|k| Complex {
                        re: samples[k] * hann[k],
                        im: 0.0,
                    })
                    .collect();
                fft.process(&mut spectrum);

                // magnitudini → bande
                let mut bands = vec![0.0f32; NUM_BANDS];
                for band in 0..NUM_BANDS {
                    let lo = band_edges[band];
                    let hi = band_edges[band + 1].max(lo + 1);
                    let mut sum = 0.0f32;
                    let mut cnt = 0u32;
                    for bin in lo..hi.min(bin_max) {
                        let m = spectrum[bin].norm() / FFT_SIZE as f32;
                        sum += m;
                        cnt += 1;
                    }
                    let avg = if cnt > 0 { sum / cnt as f32 } else { 0.0 };
                    // scala percettiva + gain euristico
                    let v = (avg * 22.0).sqrt();
                    bands[band] = v.clamp(0.0, 1.0);
                }

                samples.drain(0..FFT_HOP);

                // throttle ~60fps
                if last_emit.elapsed().as_millis() >= 14 {
                    last_emit = Instant::now();
                    if inner.pcm_gen.load(Ordering::SeqCst) != my_gen {
                        break;
                    }
                    emit(&inner, "eq-bands", json!({ "bands": bands }));
                }
            }
        }
    });
    } // #[cfg(unix)]
}
