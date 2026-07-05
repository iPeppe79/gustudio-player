#!/usr/bin/env bash
# Procura il binario mpv per l'ARCH CORRENTE e lo mette col nome-triple atteso da
# Tauri (externalBin). Pensato per lo sviluppo LOCALE e come riferimento per la CI.
#
# ATTENZIONE distribuzione: su macOS `brew install mpv` produce un binario che
# dipende dalle dylib di Homebrew → NON portabile sul PC dell'utente. Va bene solo
# per testare in locale su questa stessa macchina. Per la distribuzione servono
# binari self-contained (vedi README.md).
set -euo pipefail
cd "$(dirname "$0")"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64) triple="aarch64-apple-darwin" ;;
      x86_64) triple="x86_64-apple-darwin" ;;
      *) echo "arch mac non gestita: $arch"; exit 1 ;;
    esac
    dest="mpv-$triple"
    if command -v mpv >/dev/null 2>&1; then
      real="$(command -v mpv)"
      echo "[fetch-mpv] copio $real → $dest (NON portabile: solo dev locale)"
      cp "$real" "$dest"
      chmod +x "$dest"
      echo "[fetch-mpv] otool -L (verifica dipendenze):"
      otool -L "$dest" | sed 's/^/    /' || true
    else
      echo "[fetch-mpv] mpv non in PATH. Installa con: brew install mpv"
      echo "            oppure metti a mano un binario statico come $dest"
      exit 1
    fi
    ;;
  *)
    echo "[fetch-mpv] Questo helper copre solo macOS dev."
    echo "            Windows: scarica mpv.exe self-contained (shinchiro) e salvalo come"
    echo "            mpv-x86_64-pc-windows-msvc.exe (vedi README.md)."
    exit 1
    ;;
esac

echo "[fetch-mpv] fatto: $dest"
