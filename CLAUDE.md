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
**riscrittura in Tauri** — un codice, tutti gli OS (Intel, Silicon, Windows x64/ARM).
Prototipo validato 02/07/2026.

Motore audio: inizialmente tag `<audio>` WebKit (leggero ma fragile: silenzio sotto
stress rete, EQ impossibile per CORS). Dal **05/07/2026 → mpv** orchestrato dal backend
Rust (stabile, reconnect, EQ reale via PCM+FFT), imbarcato come sidecar. Unisce il
peso di Tauri alla robustezza del vecchio player Electron.

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

**IMPORTANTE — `station_id`**: deve essere il **mount name** dello stream
(`funsidelatina`), NON l'URL completo. Il server salva gli eventi in cartelle
derivate da questo slug — se sbagliato, il pannello "Log eventi" resta vuoto.
In JS: `streamToStationId(streamUrl)` estrae l'ultima parte del path.

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
src-tauri/src/main.rs      — comandi Tauri (mpv_*, telemetry_*, send_event, ExitRequested→mpv.shutdown)
src-tauri/src/mpv.rs       — MOTORE AUDIO: spawn mpv, IPC socket, watchdog, PCM→FFT→eq-bands
src-tauri/src/telemetry.rs — PlayerInfo, post_event, do_register, heartbeat loop
src-tauri/src/icy.rs       — lettore ICY metadata (Rust)
src-tauri/bin/             — sidecar mpv per-arch (NON in git) + README + fetch-mpv.sh
.env                 — PLAYER_API_KEY=pc-radio-2026 (mai committare)
```

## BUILD
- `BRAND=funside npm run tauri build` → .dmg + .app in `src-tauri/target/release/bundle/`
- Installa: `rm -rf "/Applications/FunSide Radio.app" && cp -R "...bundle/macos/FunSide Radio.app" "/Applications/FunSide Radio.app"`
- **MAI committare**: dist/ target/ *.dll *.dylib .env

---

## VPS — ACCESSO E DEPLOY

**SSH**: `ssh -i ~/.ssh/id_gustudio_vps root@195.14.9.37`
(credenziali complete in `/Users/gus79/Documents/gustudio-player/.env.vps` — non committare)

**Servizio**: `systemctl restart gustudio79` / `systemctl status gustudio79`

**File principale**: `/root/gustudio79/tts_gui.py`

**Procedura modifica tts_gui.py** (OBBLIGATORIA — mai editare diretto sul server):
```bash
scp -i ~/.ssh/id_gustudio_vps root@195.14.9.37:/root/gustudio79/tts_gui.py /tmp/tts_gui.py
# edita con Edit tool
python3 -c "import py_compile; py_compile.compile('/tmp/tts_gui.py', doraise=True)"
scp -i ~/.ssh/id_gustudio_vps /tmp/tts_gui.py root@195.14.9.37:/root/gustudio79/tts_gui.py
ssh -i ~/.ssh/id_gustudio_vps root@195.14.9.37 'cd /root/gustudio79 && git add tts_gui.py && git commit -m "..." && systemctl restart gustudio79'
```

**player-health dir**: `/root/gustudio79/player-health/{slug}/{uuid}_YYYYMMDD.jsonl`
- slug = mount name dello stream (es. `funsidelatina`, `profcasa`)
- API: `GET /api/player-health-list?slug=funsidelatina&uuid=...&api_key=pc-radio-2026`

---

## TELEMETRIA — PAYLOAD CORRETTO (snake_case)

`EventPayload` in `telemetry.rs` usa snake_case (NO `rename_all=camelCase`) perché
il server legge `station_id`, `audio_state`, `brand_id`, `version` in snake_case.
Il campo `ts` è ISO-8601 string (`now_iso()` via `chrono::Utc::now().to_rfc3339()`).
Il server usa sempre `datetime.now()` ignorando il ts del client.

### Rilevamento spot (src/main.js — `isSpot()`)
Allineato a `.NET NowPlayingService.IsNonMusical`:
- combined (title+artist+raw) contiene keyword: spot/meteo/news/promo/pubblicità/jingle/
  liner/rubrica/professione casa/funside/gustracks/multiradio/multi radio/ident/stacco
- OPPURE: artist vuoto E title.length < 20
→ `extra.is_spot = true/false` in ogni TRACK_CHANGE

### Pannello server — comportamento atteso
- TRACK_CHANGE musica: verde, `artist — title` una sola riga
- TRACK_CHANGE spot: arancione `#fb923c`, italico
- `last_seen` aggiornato da `api_player_health` ad ogni evento → player resta online
  finché manda heartbeat (ogni 60s). Online = `last_seen < 12 minuti fa`.

---

## STATO DEBUG — 2026-07-05

### Sessione 2026-07-06 — build FunSide Intel x64 con mpv
- Repo clonato su Mac Intel (`x86_64`), `main` aggiornato (`git pull`: already up to date).
- Build eseguita con `BRAND=funside npm run tauri build`.
  Output generato: `src-tauri/target/release/bundle/dmg/FunSide Radio_0.1.0_x64.dmg`.
- DMG copiato in Google Drive:
  `/Volumes/5TBUSB3/CLOUDING/GDRIVE PEPPE/GUSTUDIO79/PLAYER/FUNSIDE/FunSide Radio_0.1.0_x64_mpv.dmg`.
- Sidecar confermato x86_64:
  `src-tauri/bin/mpv-x86_64-apple-darwin` → `Mach-O 64-bit executable x86_64`.
- Smoke test app bundle: OK. Dopo `open .../FunSide Radio.app`, verificati 2 processi
  `Contents/MacOS/mpv`: mpv audio principale + mpv PCM/EQ.
- Nota packaging: `brew install mpv` NON completato su questo Mac perché Homebrew richiede
  Xcode.app completo per compilare `mpv` su macOS 12; le sole Command Line Tools non bastano.
  Per sbloccare la build locale è stato usato un mpv prebuilt x86_64 con cartella `lib/`
  inclusa dentro `Contents/MacOS`. App/DMG restano non firmati.

### Sessione 2026-07-06 — fix volume iniziale + rebuild macOS
- Problema: app FunSide macOS partiva con volume troppo alto. Causa: default Rust mpv `80`
  e default JS `_mpvVolume = 0.8`; il ramo PCM/EQ partiva con `--volume=100`.
- Fix: default volume portato a 35% in `src/main.js` e `src-tauri/src/mpv.rs`; ramo
  PCM/EQ allineato al volume corrente invece di forzare 100.
- Rebuild creati e copiati in Google Drive:
  - `.../PLAYER/FUNSIDE/FunSide Radio_0.1.0_x64_mpv.dmg`
  - `.../PLAYER/FUNSIDE/FunSide Radio_0.1.0_arm64_mpv.dmg`
- Entrambi i DMG contengono `FunSide Radio.app` + symlink `Applications -> /Applications`.
- Smoke test x64: OK, verificati 2 processi mpv con `--volume=35` (audio + PCM/EQ).
- ARM64 rebuild eseguito da Mac Intel con toolchain rustup e target `aarch64-apple-darwin`;
  sidecar `mpv-aarch64-apple-darwin` estratto dal DMG ARM precedente. DMG ARM resta circa
  6 MB perché contiene un mpv arm64 singolo/self-contained, senza cartella `lib/`.
- Rebuild finale ripetuto su richiesta: rigenerati x64 e arm64, entrambi con layout DMG
  `FunSide Radio.app` + `Applications -> /Applications`, e ricopiati nella cartella
  Google Drive `GUSTUDIO79/PLAYER/FUNSIDE`.
- Fix successivo: il volume basso NON va applicato al processo PCM/EQ, altrimenti il
  visualizer diventa quasi fermo. Audio principale resta 35%, PCM/EQ torna a `--volume=100`
  (non esce sulle casse). ICY delay default ridotto da 18s a 4s e il vecchio valore 18s
  salvato in localStorage viene migrato automaticamente a 4s per velocizzare titolo/cover.
- Header FunSide aggiornato con PNG trasparente compatto `src/public/funside-logo.png`
  (180x70, da Desktop/Progetto senza titolo.png); CSS header riportato a 54px con logo
  centrato realmente sulla finestra e cover di nuovo a 272px.
- Eliminato doppio layer visibile su sfondi chiari: finestra Tauri portata a 300x502,
  `html/body` allineati alla stessa misura e rimossa ombra esterna CSS da `#app`.
- Rimosso definitivamente il tentativo di aura: finestra e player restano 300x502,
  nessun margine/ombra esterna; all'avvio JS forza background window+webview a RGBA
  trasparente via API Tauri (`setBackgroundColor`) con permission dedicata.
- Aggiunto fix nativo macOS in Rust: in `setup()` `apply_native_window_mask()` imposta
  `NSWindow` non opaque, background clear e clipping/corner radius sul `contentView` layer.
  Serve per eliminare gli spigoli residui su Mac ARM dove il solo CSS/JS non basta.
- Nota crash macOS Intel 12.7.6: `SIGABRT` in `_RegisterApplication` con parent `codex`
  è stato generato lanciando direttamente `FunSide Radio.app/Contents/MacOS/gustudio-player`.
  Per smoke test GUI usare sempre il bundle `.app` (`open .../FunSide Radio.app` o Finder);
  il binario interno non è un entrypoint valido per AppKit/LaunchServices.

### Sessione 2026-07-05 — migrazione a mpv
- `<audio>` WebKit → **mpv** nel backend Rust (vedi sez. "Motore audio — mpv").
- Watchdog anti-silenzio + `--network-timeout=10` + reconnect ffmpeg.
- EQ reale rustfft (canvas eqCanvas aggiunto ex-novo).
- `cargo check` pulito, `npm run build` ok. mpv verificato sullo stream funside reale
  (core-idle=false, titolo live, cache che avanza). PCM-stdout e watchdog live da provare.
- Fix server: `radio` — `rows.join('\r\n')` nel template Python rompeva la stringa JS
  (CR/LF letterali) → stazioni invisibili. Corretto in `\\r\\n` (commit VPS 4e69c14f).

### Tutto funzionante ✓ (base pre-mpv, 2026-07-04)
- Audio, ICY metadata, cover, setup modal, drag finestra
- Crash macOS 26 risolto (rimosso RAF)
- Watchdog auto-reconnect con backoff esponenziale (5s→10s→20s→40s)
- Registrazione postazione → HTTP 200 ✓
- Log eventi nel pannello server ✓ (snake_case payload + mount name station_id)
- Timestamp corretti ✓ (server usa ora propria, _fmtTs/_fmtTime fix ×1000)
- Spot arancione ✓, brano singola riga ✓
- Player rimane online nel pannello ✓ (api_player_health aggiorna last_seen)
- Export CSV brani/spot nel pannello ✓

### Motore audio — mpv (dal 2026-07-05, STRADA A implementata)
**Il motore audio è mpv**, orchestrato dal backend Rust (`src-tauri/src/mpv.rs`).
Il tag `<audio>` è stato RIMOSSO. Play/stop/volume → `invoke()` → mpv via socket IPC.

- `mpv.rs`: spawn binario per-arch, IPC JSON (Unix socket / named pipe Win),
  `observe_property` (core-idle, demuxer-cache-duration, pause, playback-time).
- **Watchdog anti-silenzio**: se `core-idle` bloccato >8s o cache ferma o mpv esce →
  KILL+RESTART automatico + ricarica stream. Logga `RECONNECT`/`AUDIO_STALL` con `stall_ms`.
  Flag mpv: reconnect ffmpeg + **`--network-timeout=10`** (mancava nel vecchio Electron).
- **EQ REALE (macOS)**: 2° processo mpv con `--ao=pcm --ao-pcm-file=/dev/stdout
  --ao-pcm-waveheader=no` (mpv NON scrive su `-`, serve `/dev/stdout`, VERIFICATO)
  → PCM float32 mono → `rustfft` (Hann, STFT ~60fps) → 48 bande log → evento `eq-bands`
  → canvas (barre colorate blu→giallo→rosso). `_fakeEqData`/`AudioContext`/`analyser`
  ELIMINATI dal frontend: nessun residuo fake. Il `<canvas id="eqCanvas">` non esisteva
  in index.html (per questo non si vedeva) — aggiunto.
- **EQ su WINDOWS = DISATTIVATO (TODO)**: `start_pcm` fa `return` su `#[cfg(windows)]`
  (come il vecchio Electron: `if win32 return`). mpv su Windows non scrive PCM su una
  pipe stdout affidabile → EQ fermo, audio ok. DA FARE: EQ reale anche su Windows via
  **FIFO / named-pipe dedicata** (`\\.\pipe\...`) letta dal backend Rust.
- `telemetry.rs`: `audio_engine` ora = `crate::mpv::AUDIO_ENGINE` (`"mpv"`), non hardcoded.
- Eventi Rust→JS: `mpv-state {phase}`, `mpv-restart`, `mpv-ready`, `eq-bands`.
  `handleMpvState()` in main.js mappa le fasi su UI + telemetria (PLAY_START_OK,
  BUFFERING, AUDIO_STALL, AUDIO_RECOVERED, ...). Il vecchio watchdog JS lato `<audio>`
  è stato tolto: la resilienza è ora tutta lato Rust/mpv.

### Binario mpv (sidecar) — PUNTO APERTO PACKAGING
`tauri.conf.json` → `externalBin: ["bin/mpv"]`. Servono binari **self-contained**
in `src-tauri/bin/` col nome-triple (`mpv-aarch64-apple-darwin`, `mpv-x86_64-apple-darwin`,
`mpv-x86_64-pc-windows-msvc.exe`; per Windows ARM64 anche
`mpv-aarch64-pc-windows-msvc.exe`). NON committati (`.gitignore`). Vedi `bin/README.md`.
- Dev/locale: `bin/fetch-mpv.sh` copia il mpv di Homebrew (⚠ NON portabile — dipende da
  dylib Homebrew, solo per test su questa macchina). Fallback runtime: `mpv` nel PATH.
- CI: step "Fetch mpv sidecar" in build-players.yml (URL da fissare: secrets MPV_WIN_URL/
  MPV_MAC_URL). I binari devono essere STESSA versione mpv >=0.38.
- Firma macOS: predisposta in CI (secrets APPLE_*), non ancora testata.

### Verificato dal vivo (DMG 2026-07-05)
- App bundle: mpv principale + mpv PCM partono dall'interno del `.app`, core-idle=false,
  cache che avanza, titolo live → **audio mpv OK**. EQ barre reali che si muovono col brano.
- **Registrazione postazione + log = INTATTI** (non toccati dalla migrazione mpv):
  `init()` chiama `telemetry_init` → `checkFirstRun()` (modal prima attivazione se
  `station_data` assente) → `doRegister()` → `startHeartbeat()`. Eventi APP_START/
  PLAY_REQUEST/TRACK_CHANGE/HEARTBEAT via `diag()`→`send_event`→`/api/player-health`.
  `handleMpvState()` produce PLAY_START_OK/BUFFERING/AUDIO_STALL/RECONNECT al posto dei
  vecchi eventi del tag `<audio>`. TRACK_CHANGE resta da ICY (`icy.rs`, invariato).

### DA VERIFICARE ancora (non provato live)
- Watchdog live "stacca rete → riaggancio": logica ok, dimostrazione GUI non eseguita.
- Portabilità sidecar mpv su altri Mac (quello nel DMG è Homebrew, gira solo su questa macchina).

### UI (2026-07-05, sera)
- Finestra `transparent:true` + `macOSPrivateApi:true` (320×524) → `#app` 300×502 con
  angoli tondi + ombra floating. Niente bleed bianco né pallini nativi (verificato screenshot).
- Fix pannello "che si apriva dietro": `#app > *{position:relative}` (spec. 1,0,0) vinceva
  su `.panel{position:absolute}` → aggiunte `#app > .panel` / `#app > .modal-overlay`.
- EQ: fascia bassa (22px) di **barre colorate** blu→giallo→rosso SOTTO la cover
  (non più onda sinusoidale, non più sovrapposto). Cover 272px (hero).

### Fix applicati in questa sessione (2026-07-04)
| Fix | Lato | Dettaglio |
|-----|------|-----------|
| payload snake_case | Client Rust | rimosso `rename_all=camelCase` da EventPayload |
| station_id mount name | Client JS | `streamToStationId()` estrae ultima parte URL |
| ts ISO string | Client Rust | `now_secs()→now_iso()` (RFC3339) |
| ts sempre dal server | Server | `api_player_health` ignora ts client |
| sort key ts misti | Server | `_ts_key()` normalizza int e str |
| _fmtTs fix ×1000 | Server | integer seconds → ×1000 per new Date() |
| brano doppio | Server | issue_note+audio_state+engine soppressi per TRACK_CHANGE |
| spot arancione | Client+Server | `isSpot()` + `_eventColor(ev,extra)` |
| player sempre online | Server | `api_player_health` aggiorna `last_seen` |
| audio_engine label | Client Rust | "mpv" → "webaudio" (motore reale) |
| neon ring rimosso | CSS | cover pulita senza bordino colorato |
| export CSV brani | Server | pulsante ⬇ nel tab Brani suonati |

---

## Da fare
1. **EQ reale su Windows** via FIFO/named-pipe (ora l'EQ è attivo solo su macOS)
2. Binari mpv self-contained per i 3 triple + firma macOS (packaging distribuzione)
3. Verifica watchdog live (stacca rete → riaggancio)
4. Build One Radio / GUSTracks
5. CI GitHub Actions multi-brand
6. Ri-registrare "FUNSIDE TEST PEPPE" con dati reali
