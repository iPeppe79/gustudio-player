import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: ['es2021', 'chrome100', 'safari13'], minify: !process.env.TAURI_DEBUG },
});
