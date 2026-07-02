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
Il player .NET+Avalonia+BASS ha generato centinaia di build divergenti (fix su una
macchina mai tornati altrove), bug audio (silenzio di alcuni secondi), e tre
codebase per tre OS che si somigliano ma non sono uno. Decisione: **riscrittura in
Tauri** — un codice, tutti gli OS presenti e futuri (Intel, Silicon, Windows x64,
Windows ARM), motore audio = webview di sistema (mantenuto gratis da Google/Apple).

Prototipo HTML testato il 02/07/2026: audio LIVE ✓, visualizer FFT ✓, brand switch ✓.
Cover ✗ (auth mancante, vedi sotto). Verdetto: **strada Tauri confermata.**

---

## ARCHITETTURA VERIFICATA (estratta dai binari .dmg + .exe)

Stack condiviso Mac e Windows (VERIFICATO da entrambi i binari):
- .NET 8 (runtime 8.0.28) + Avalonia UI + SkiaSharp + HarfBuzz
- Audio: BASS (un4seen) — `libbass.dylib` su Mac, `bass.dll` su Windows
- Il Windows è MODULARE (PlayerCore.UI / .Audio / .Telemetry / .Supervisor),
  il Mac è MONOLITE (Player.Native). Il Windows è la generazione più matura:
  **portare il Mac al modello Windows, non il contrario.**

Differenze reali (le uniche): libreria audio (dll/dylib), target build
(osx-arm64 / osx-x64 / win-x64), packaging (hdiutil UDZO / NSIS).

---

## AUTH & COVER — IL FLUSSO REALE (VERIFICATO dal server tts_gui.py)

Il server è Flask (nginx/1.24 Ubuntu) su **gus79.it**. Espone gli endpoint player.

Autenticazione player (riga ~1536 di tts_gui.py):
```python
if PLAYER_API_KEY and request.args.get("api_key") == PLAYER_API_KEY:
    if path in PLAYER_API_ALLOWED_PATHS:
        return  # passa
```
**La chiave è un `?api_key=XXX` in query string. NON un login, NON un cookie.**
Il prototipo prendeva 401 perché chiamava senza `api_key`.

Endpoint cover: `GET /api/radio-artwork?title=<ICY>&station=<nome>&api_key=<KEY>`
→ ritorna `{artwork, preview_url, uri}`. Cerca il titolo su Spotify, ha già
cache per stazione lato server. [VERIFICATO righe 52404-52438]

**La logica cover in JS esiste GIÀ dentro GUStudio** (funzione `fetchArtworkData`,
riga ~56388 di tts_gui.py). Da trapiantare nel player, non da reinventare.

Due chiavi diverse per due scopi (non confonderle):
- `PLAYER_API_KEY` (es. `pc-radio-2026`) → endpoint-macchina (cover, now-playing, heartbeat)
- `profcasa26` / `funside26` → [INFERENZA] password umane per le pagine demo `/profcasa` `/funside`

⚠️ [NON VERIFICATO] Il valore ATTUALE di `PLAYER_API_KEY` sul server. Nel .dmg era
`pc-radio-2026` ma le password sono cambiate, quindi presumo anche la chiave.
**PRIMO TASK: trovare il valore reale nel repo/server.**

Stream verificato: `stream2.multi-radio.com/<brand>`, codec **AAC-LC** (universale,
non HE-AAC), header `access-control-allow-origin: *`, metadati ICY inline
(`icy-metaint: 16000`) → il titolo del brano viaggia DENTRO lo stream.

---

## SICUREZZA — DA CORREGGERE
Oggi la `api_key` è in chiaro nei JSON di brand: chiunque apra il .app la legge.
In Tauri va nel backend **Rust** (compilato, non estraibile a occhio). Il CORS che
blocca il prototipo browser NON esiste in Tauri: le chiamate partono dal Rust, che
non è un browser. Un colpo, due muri abbattuti (auth + CORS).

---

## STRUTTURA TARGET (monorepo)
```
gustudio-player/
├── src/            # frontend web (HTML/CSS/JS) — la scocca, identica a oggi
├── src-tauri/      # backend Rust: auth, api_key, proxy verso gus79.it, cache
├── brands/         # professione-casa.json, funside.json, gustracks.json
└── .github/workflows/build-players.yml  # fabbrica: 3 runner nativi
```

## BUILD
- Locale: `npm run tauri build` (produce .dmg su Mac, .exe/.msi su Windows)
- CI: push su main → GitHub Actions builda tutti e 3 i target nativi in parallelo
- **MAI committare binari**: bin/ obj/ dist/ target/ *.dll *.dylib (vedi .gitignore)

---

## STATO DEBUG
<!-- AGGIORNA QUI a fine sessione. Esempio:
2026-07-02: prototipo web validato (audio+viz ok, cover ko per auth).
Prossimo: trovare PLAYER_API_KEY reale, poi scaffold Tauri.
-->
- 2026-07-02: deciso Tauri. Prototipo HTML validato. Da fare: (1) recuperare
  PLAYER_API_KEY attuale, (2) scaffold progetto Tauri, (3) trapianto logica cover dal JS esistente.
