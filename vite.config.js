import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

function gitShortHash() {
  try {
    return execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const buildCommit = gitShortHash();

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
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG,
  },
});
