// Lettore metadati ICY dallo stream.
// Si connette con Icy-MetaData:1, legge blocchi ogni icy-metaint byte,
// emette evento "icy-meta" al frontend solo quando StreamTitle cambia.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct IcyMeta {
    pub raw:    String,
    pub title:  String,
    pub artist: String,
}

pub struct IcyState {
    handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl IcyState {
    pub fn new() -> Self {
        Self { handle: Arc::new(Mutex::new(None)) }
    }

    pub fn start(&self, app: AppHandle, url: String) {
        self.stop();
        let h = tokio::spawn(icy_loop(app, url));
        if let Ok(mut g) = self.handle.lock() { *g = Some(h); }
    }

    pub fn stop(&self) {
        if let Ok(mut g) = self.handle.lock() {
            if let Some(h) = g.take() { h.abort(); }
        }
    }
}

async fn icy_loop(app: AppHandle, url: String) {
    loop {
        match icy_connect(&app, &url).await {
            Ok(_)  => tokio::time::sleep(tokio::time::Duration::from_secs(3)).await,
            Err(e) => {
                eprintln!("[ICY] error: {e}");
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        }
    }
}

async fn icy_connect(app: &AppHandle, url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; GUStudio/1.0)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(url)
        .header("Icy-MetaData", "1")
        .send().await
        .map_err(|e| e.to_string())?;

    let metaint: usize = resp.headers()
        .get("icy-metaint")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(16000);

    eprintln!("[ICY] connected to {url}, metaint={metaint}");

    // ── STREAM_HEADERS: connessione HTTP stabilita ────────────────────────────
    let _ = app.emit("icy-stream", serde_json::json!({
        "type": "STREAM_HEADERS", "metaint": metaint
    }));

    let mut stream        = resp.bytes_stream();
    let mut buf: VecDeque<u8> = VecDeque::new();
    let mut last_title    = String::new();
    let mut first_chunk   = true;
    let mut stream_ok_sent = false;

    loop {
        // Leggi e scarta metaint byte audio
        fill(&mut stream, &mut buf, metaint).await?;

        // ── STREAM_FIRST_BYTE: primo blocco audio ricevuto ────────────────────
        if first_chunk {
            first_chunk = false;
            let _ = app.emit("icy-stream", serde_json::json!({ "type": "STREAM_FIRST_BYTE" }));
        }

        buf.drain(..metaint);

        // 1 byte: lunghezza blocco meta / 16
        fill(&mut stream, &mut buf, 1).await?;
        let meta_blocks = buf.pop_front().unwrap_or(0) as usize;
        let meta_len = meta_blocks * 16;

        if meta_len == 0 { continue; }

        // Leggi il blocco metadati
        fill(&mut stream, &mut buf, meta_len).await?;
        let raw_bytes: Vec<u8> = buf.drain(..meta_len).collect();
        let meta_str = String::from_utf8_lossy(&raw_bytes);
        let meta_str = meta_str.trim_end_matches('\0');

        if let Some(stream_title) = extract_title(meta_str) {
            // ── STREAM_OK: primo metadata valido → stream pienamente operativo ─
            if !stream_ok_sent {
                stream_ok_sent = true;
                let _ = app.emit("icy-stream", serde_json::json!({ "type": "STREAM_OK" }));
            }

            if stream_title == last_title { continue; }
            last_title = stream_title.clone();
            eprintln!("[ICY] title: {stream_title}");

            let (artist, title) = split(stream_title.as_str());
            let _ = app.emit("icy-meta", IcyMeta { raw: stream_title, title, artist });
        }
    }
}

async fn fill(
    stream: &mut (impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin),
    buf: &mut VecDeque<u8>,
    need: usize,
) -> Result<(), String> {
    while buf.len() < need {
        match stream.next().await {
            Some(Ok(chunk)) => buf.extend(chunk.iter()),
            Some(Err(e))    => return Err(e.to_string()),
            None            => return Err("stream closed".into()),
        }
    }
    Ok(())
}

fn extract_title(meta: &str) -> Option<String> {
    // StreamTitle='Artista - Titolo';StreamUrl='';
    let start = meta.find("StreamTitle='")?;
    let rest  = &meta[start + 13..];
    let end   = rest.find("';")?;
    Some(rest[..end].trim().to_string())
}

fn split(raw: &str) -> (String, String) {
    if let Some(idx) = raw.find(" - ") {
        (raw[..idx].trim().to_string(), raw[idx + 3..].trim().to_string())
    } else {
        (String::new(), raw.trim().to_string())
    }
}
