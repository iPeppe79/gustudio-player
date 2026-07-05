# Binari mpv sidecar

Il motore audio del player è **mpv**, imbarcato come *external binary* (sidecar) di
Tauri. `tauri.conf.json` dichiara `"externalBin": ["bin/mpv"]`: al bundle Tauri copia
il file col target-triple corrispondente accanto all'eseguibile, spogliato del triple
(`<app>/Contents/MacOS/mpv` su macOS, `mpv.exe` accanto all'exe su Windows).

## File attesi (nomi ESATTI)

Ogni piattaforma deve avere il suo binario, con il triple nel nome:

| Piattaforma      | Target triple              | File                                 |
|------------------|----------------------------|--------------------------------------|
| macOS Apple Sil. | `aarch64-apple-darwin`     | `mpv-aarch64-apple-darwin`           |
| macOS Intel      | `x86_64-apple-darwin`      | `mpv-x86_64-apple-darwin`            |
| Windows x64      | `x86_64-pc-windows-msvc`   | `mpv-x86_64-pc-windows-msvc.exe`     |

> IMPORTANTE: devono essere **binari self-contained** (statici o con le loro
> dipendenze accanto), NON il wrapper di Homebrew che dipende da dylib esterne:
> altrimenti sul PC dell'utente mpv non parte. Verifica con `otool -L` (mac) /
> `dumpbin /dependents` (win) che non puntino a percorsi della build machine.
>
> I 3 binari devono essere della **stessa versione mpv recente** (>= 0.38).
> Build disallineate erano il sospetto per cui si stoppava solo Windows.

## Come procurarli

- **Windows**: build self-contained di shinchiro
  (https://sourceforge.net/projects/mpv-player-windows/files/) — `mpv.exe`.
- **macOS**: build statica (es. `mpv` da https://laboratory.stolendata.net/~djinn/mpv_osx/
  o compilata con `mpv-build` con link statico), una per arch.

In CI questo è automatizzato: vedi `.github/workflows/build-players.yml`
(step "Fetch mpv sidecar"). In locale, metti i file qui a mano prima di
`BRAND=funside npm run tauri build`.

## Firma (macOS)

Un eseguibile esterno non firmato dentro il .app fa scattare Gatekeeper.
Il bundler Tauri firma i sidecar se `APPLE_SIGNING_IDENTITY` (e notarizzazione)
sono configurati. In alternativa firmare a mano prima del bundle:

    codesign --force --options runtime --sign "$APPLE_SIGNING_IDENTITY" bin/mpv-aarch64-apple-darwin

## Dev senza bundle

In `npm run tauri dev` il sidecar non viene copiato: `mpv.rs` ripiega su
`bin/mpv-<triple>` (questa cartella) e, se assente, su `mpv` nel PATH di sistema
(`brew install mpv`). Sufficiente per sviluppare e testare il watchdog/EQ in locale.
