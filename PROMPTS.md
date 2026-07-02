# Prompt per Claude Code — in sequenza

Dai un prompt alla volta. Aspetta che finisca, poi passa al successivo.
Ognuno è autonomo: "esegui tutto, non fermarti a chiedere, report finale".

---

## PROMPT 1 — Setup repo + verità sull'auth

```
Lavora in autonomia, non fermarti a chiedermi conferma tra gli step. Report finale.

Sto per riscrivere il player radio in Tauri (era .NET+Avalonia+BASS). Ho un file
CLAUDE.md e un .gitignore da mettere nella radice del nuovo progetto.

FAI:
1. Esplora il repo attuale (gustudio-player-core o dove sta il player). Mappa cosa c'è.
2. Trova il valore REALE di PLAYER_API_KEY: cercalo sia nel codice del player (.cs)
   sia — se accessibile — nel server tts_gui.py. Cerca "PLAYER_API_KEY", "api_key",
   "pc-radio-2026". Dimmi il valore attuale e in quale file sta. NON modificarlo.
3. Trova come il player .NET chiama /api/radio-artwork: quale URL costruisce,
   dove infila api_key (query? header?). Citami il file e le righe.
4. Copia CLAUDE.md e .gitignore nella radice, fai il primo commit.

Report: valore della chiave, flusso cover del player vecchio, stato del repo.
Se un dato non è nel codice, dillo — non inventarlo.
```

---

## PROMPT 2 — Scaffold Tauri + trapianto cover

```
Lavora in autonomia. Report finale.

Crea un progetto Tauri 2 nel repo, frontend Vanilla HTML/JS (niente framework pesanti).

FAI:
1. Scaffold Tauri 2 (npm create tauri-app, vanilla JS).
2. Frontend: replica la scocca del player attuale — cover grande, play, stop,
   titolo/artista, switch brand, area log, pannello impostazioni. Tema per brand
   (colori nel CLAUDE.md). Riusa la struttura del prototipo HTML se te lo passo.
3. Audio: elemento <audio> che punta a stream2.multi-radio.com/<brand> (AAC-LC,
   già verificato compatibile). Visualizer con Web Audio API (AnalyserNode).
4. Cover via BACKEND RUST, non da JS: crea un comando Rust che chiama
   gus79.it/api/radio-artwork?title=<t>&station=<s>&api_key=<KEY> e ritorna il JSON.
   Così bypassi il CORS. La api_key sta in Rust (o in .env NON committato), MAI nel JS.
   Ispirati alla logica JS già esistente in tts_gui.py (funzione fetchArtworkData).
5. Cache copertine su disco (plugin-fs di Tauri), non solo in memoria.

Report: cosa hai creato, come gira in dev (npm run tauri dev), cosa manca.
Se la api_key non l'hai trovata nel Prompt 1, segnalalo e usa un placeholder in .env.
```

---

## PROMPT 3 — Fabbrica di build multi-OS

```
Lavora in autonomia. Report finale.

Metti in piedi GitHub Actions per buildare il player su 3 runner nativi.

FAI:
1. Ho un file build-players.yml — adattalo a Tauri (usa tauri-action ufficiale,
   non dotnet publish, visto che ora è Tauri). Matrice: macos-latest (arm64),
   macos-13 (intel), windows-latest (x64). fail-fast: false.
2. Ogni runner deve produrre l'installer nativo (.dmg / .exe) e caricarlo come artifact.
3. La api_key va passata come GitHub Secret, MAI hardcoded nel workflow.
4. Verifica che il .gitignore escluda target/ e i binari.

Report: link al workflow, cosa serve configurare (secrets), come lancio la prima build.
```

---

## Nota
Se hai altri player funzionanti da usare come riferimento, passali a Claude Code
PRIMA del Prompt 2 — arricchiscono la scocca di partenza.
