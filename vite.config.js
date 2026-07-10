import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

function gitShortHash() {
  try {
    return execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Fonte UNICA della versione: tauri.conf.json (schema CalVer "2026.N", N sale a
// ogni release). Niente più "0.1.0" hardcodato in main.js che poteva divergere.
function appVersion() {
  try {
    const conf = JSON.parse(readFileSync('./src-tauri/tauri.conf.json', 'utf8'));
    return conf.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const buildCommit = gitShortHash();
const appVer = appVersion();

export default defineConfig({
  root: 'src',
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    // Sostituito a compile time: BRAND=funside npm run tauri build
    __BRAND__: JSON.stringify(process.env.BRAND || 'funside'),
    __BUILD_MODE__: JSON.stringify(process.env.BRAND ? 'production' : 'dev'),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
    __APP_VERSION__: JSON.stringify(appVer),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG,
  },
});
