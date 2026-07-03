# GUStudio Player — Monorepo Cross-Platform

> Memoria di progetto. Claude Code legge questo file all'avvio di ogni sessione,
> su qualsiasi macchina, dopo `git pull`. Aggiorna la sezione **STATO DEBUG** a
> fine sessione: è così che riprendi il lavoro su Mac Intel, Mac Silicon o Windows
> senza raccontare niente da capo.

---

## COS'È
Player radio desktop multi-brand. Fa **due cose**: suona uno stream Icecast e
mostra la cover del brano in onda. Tutto il resto (log, cache, play/stop,
impostazioni) è contorno attorno a queste due.

Brand attuali:
- **One Radio** (professione-casa) — rosso #E53E2D
- **Fun Side** (funside) — azzurro #29ABE2
- **GUSTracks** (gustracks) — oro #C8A85A

---

## STORIA (perché siamo qui)
Il player .NET+Avalonia+BASS ha generato centinaia di build divergenti. Decisione:
**riscrittura in Tauri** — un codice, tutti gli OS (Intel, Silicon, Windows x64/ARM),
motore audio = webview di sistema. Prototipo validato 02/07/2026.

---

## ARCHITETTURA TAURI (VERIFICATA e funzionante al 03/07/2026)

Stack:
- **Frontend**: Vite + vanilla JS/HTML/CSS in `src/`
- **Backend**: Rust in `src-tauri/` — gestisce audio ICY, telemetria, cover cache
- **Brand config**: `src/public/<brand>.json` con streamUrl, theme, colors, fallbackCover

### Sicurezza
- `PLAYER_API_KEY=pc-radio-2026` nel `.env` (mai nel JS/frontend)
- Tutte le chiamate server partono da Rust con `?api_key=` in query string
- `SETUP_PASSWORD`: NON usare — la password di setup (`funside26`) va nel body
  di `POST /api/player-register`, validata server-side. Non serve .env.

---

## SERVER gus79.it — ENDPOINT PLAYER (VERIFICATI)

Base: `https://gus79.it/api/` con `?api_key=pc-radio-2026`

| Endpoint | Metodo | Scopo |
|----------|--------|-------|
| `/player-register` | POST | Registra postazione. Body: uuid, station_id (URL completo stream), hostname, mac, version, platform, username, password, insegna, via, citta, referente, email, telefono |
| `/player-health` | POST | Invia evento/log. Body: uuid, event, station_id, audio_state, issue_type, issue_note, os, architecture, version, ts |
| `/radio-artwork` | GET | Cover brano. Query: title, station, api_key |

**IMPORTANTE — `station_id`**: deve essere la URL COMPLETA dello stream
(`https://stream2.multi-radio.com/funsidelatina`), NON solo il mount name.

**Password setup** (`funside26` per funside): va nel body di `player-register`.
Il server la valida. Senza campo password → 200 OK. Con password sbagliata → 401.
Con `funside26` → 200 OK (VERIFICATO con curl il 03/07/2026).

**Due chiavi diverse:**
- `PLAYER_API_KEY` = `pc-radio-2026` → autenticazione endpoint macchina
- `funside26` = password postazione → validazione setup umano lato server

---

## TELEMETRIA — FLUSSO CORRETTO

### Race condition risolta (03/07/2026)
`telemetry_init` **DEVE essere awaited** prima che `play()` scatti, altrimenti
`tele.info` è None in Rust e tutti gli eventi vengono scartati silenziosamente.

Ordine corretto in `init()`:
1. `await safeInvoke('telemetry_init', ...)` → popola `state.info` in Rust + avvia heartbeat
2. `diag('APP_START', ...)` → primo evento inviato
3. `await checkFirstRun()` → mostra setup modal se prima volta
4. `doRegister()` → registrazione completa con tutti i campi
5. `play()` → avvia stream

### Eventi inviati
| Evento | Quando |
|--------|--------|
| `APP_START` | Avvio app (dopo telemetry_init) |
| `PLAY_REQUEST` | Click play |
| `PLAY_START_OK` | Audio inizia a suonare |
| `BUFFERING` | Audio in buffering (throttle 15s) |
| `STOP_REQUEST` | Click stop |
| `STOP_OK` | Audio fermato |
| `TRACK_CHANGE` | Cambio brano ICY (issue_note = "Artist — Title") |
| `HEARTBEAT` | Ogni 60s (loop Rust + JS) |
| `APP_EXIT` | Chiusura finestra |
| `NETWORK_LOST/RESTORED` | Cambio connettività |
| `AUDIO_STALL/RECOVERED` | Stallo stream |
| `RECONNECT` | Watchdog ha forzato riconnessione (extra: stall_ms, attempt) |
| `LONG_SILENCE` | Audio playing ma nessun TRACK_CHANGE da >20min (extra: silence_ms) |

### Throttle `diag()`
- BUFFERING / AUDIO_STALL: max 1 ogni 15s
- HEARTBEAT: max 1 ogni 60s
- RECONNECT: max 1 ogni 5s
- LONG_SILENCE: max 1 ogni 20min
- default: max 1 ogni 2s, global min 2s tra qualsiasi evento

### Watchdog (src/main.js)
Variabili: `_watchdogTimer`, `_reconnectAttempt`, `_stallStartedAt`, `_playRequestedAt`, `_playStartedAt`, `_lastTrackAt`

- **startWatchdog(reason)**: avvia timer con backoff esponenziale (5s→10s→20s→40s max). Scatta se audio è in waiting/stalled/error.
- **clearWatchdog()**: cancella timer (chiamato su 'playing' e stop())
- **play()**: resetta `_playRequestedAt` e `_lastTrackAt`, chiama clearWatchdog()
- **stop()**: resetta tutto incluso `_playStartedAt`
- **audio 'playing'**: clearWatchdog(), reset `_reconnectAttempt=0`, calcola `buffer_time_ms` in PLAY_START_OK extra
- **HEARTBEAT JS**: include `extra.uptime_min` (minuti da primo play), controlla LONG_SILENCE ogni 60s
- **TRACK_CHANGE**: aggiorna `_lastTrackAt`

---

## NEON RING — CRASH FIX (03/07/2026)
`requestAnimationFrame` causava SIGSEGV in `WebCore::ScrollingTree::takePendingScrollUpdates()`
su macOS 26 (Tahoe) Beta. Fix: animazione respiro → CSS `@keyframes neon-breath`.
Il colore cambia ogni 4s con `setInterval`. Zero RAF.

---

## SETUP PRIMO AVVIO
- Form modale al primo avvio se `station_data` non in localStorage
- Campi: insegna*, via, città, referente*, email*, telefono, password*
- `password` va nel body di `player-register` → server valida
- Solo se server risponde 200 → salva `station_data` in localStorage
- Per forzare ri-registrazione: cancella `station_data` da localStorage

---

## STRUTTURA FILE CHIAVE
```
src/main.js          — logica JS principale (play/stop, ICY, telemetria, UI)
src/index.html       — HTML con setup modal, settings panel, log panel
src/style.css        — stile con neon CSS, status badge, cover
src/public/funside.json — brand config (streamUrl, theme, colors)
src-tauri/src/main.rs      — comandi Tauri (telemetry_init, telemetry_register, send_event)
src-tauri/src/telemetry.rs — PlayerInfo, post_event, do_register, heartbeat loop
src-tauri/src/icy.rs       — lettore ICY metadata (Rust)
.env                 — PLAYER_API_KEY=pc-radio-2026 (mai committare)
```

## BUILD
- `npm run tauri build` → .dmg + .app in `src-tauri/target/release/bundle/`
- **MAI committare**: dist/ target/ *.dll *.dylib .env

---

## STATO DEBUG
- **2026-07-03**: Player Tauri funzionante. Audio ✓, ICY metadata ✓, cover ✓,
  telemetria ✓ (log arrivano al server), setup modal ✓, neon ring ✓ (CSS),
  crash macOS 26 risolto (rimosso RAF), drag finestra da tutti gli header ✓.
- **Da fare**: (1) registrazione con dati reali (resettata per test — station_data
  cancellato), (2) build per One Radio / GUSTracks, (3) CI GitHub Actions multi-brand.
- **Postazione test nel server panel**: "As" / UUID 158c334f-b996-4614-b391-e10f4360d82a
  (dati fittizi, da ri-registrare con dati veri).
