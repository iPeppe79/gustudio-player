import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  brand: null,
  playing: false,
  currentTitle: '',
  currentArtist: '',
  uuid: crypto.randomUUID(),
  log: [],
};

// ── Brand loading ─────────────────────────────────────────────────────────────
const BRANDS = ['funside', 'professione-casa', 'gustracks'];

async function loadBrand(brandId) {
  const resp = await fetch(`/${brandId}.json`);
  if (!resp.ok) throw new Error(`brand ${brandId} non trovato`);
  return resp.json();
}

function applyBrand(brand) {
  state.brand = brand;
  const r = document.documentElement.style;
  r.setProperty('--primary', brand.theme.primary);
  r.setProperty('--bg', brand.theme.background);
  r.setProperty('--text', brand.theme.text);
  r.setProperty('--primary-a20', brand.theme.primary + '33');
  r.setProperty('--primary-a60', brand.theme.primary + '99');

  document.getElementById('brandName').textContent = brand.productName;
  document.getElementById('fallbackName').textContent = brand.productName;
  document.getElementById('brandLabel').textContent = `${brand.brandId}  v0.1.0`;
  document.title = brand.windowTitle || brand.productName;

  const logo = document.getElementById('brandLogo');
  logo.hidden = true; // placeholder; logo PNG goes in brands/{id}-logo.png

  document.getElementById('streamUrlInput').value = brand.streamUrl;
  log(`[BRAND_LOADED] ${brand.brandId}`);
}

// ── Audio ─────────────────────────────────────────────────────────────────────
const audio = document.getElementById('audioEl');
let audioCtx, analyser;

function initAudioContext() {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    // WKWebView cross-origin taint: Web Audio analysis non disponibile,
    // usiamo il visualizer animato basato sul tempo
    log(`[VIZ_FALLBACK] ${e.message}`);
    analyser = null;
  }
}

function play() {
  if (!state.brand) return;
  initAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audio.src = state.brand.streamUrl;
  audio.load();
  audio.play().catch(e => log(`[PLAY_ERROR] ${e.message}`));
  state.playing = true;
  setStatus('buffering', 'BUFFERING...');
  log(`[PLAY_ATTEMPT] url=${state.brand.streamUrl}`);
  // Avvia lettura metadati ICY nel backend Rust
  invoke('start_icy', { url: state.brand.streamUrl }).catch(e => log(`[ICY_START_ERR] ${e}`));
}

function stop() {
  audio.pause();
  audio.src = '';
  state.playing = false;
  setStatus('stopped', 'FERMATO');
  log('[PLAY_STOP]');
  invoke('stop_icy').catch(() => {});
  // Reset now-playing
  state.currentTitle  = '';
  state.currentArtist = '';
  document.getElementById('trackTitle').textContent  = '—';
  document.getElementById('trackArtist').textContent = '';
  showFallbackCover();
}

audio.addEventListener('playing', () => {
  setStatus('playing', 'IN RIPRODUZIONE');
  log('[PLAY_START]');
});
audio.addEventListener('waiting', () => setStatus('buffering', 'BUFFERING...'));
audio.addEventListener('error', () => {
  setStatus('error', 'ERRORE');
  log(`[STREAM_ERROR] ${audio.error?.message || 'unknown'}`);
});

// ── ICY metadata — letta dal backend Rust via stream ──────────────────────────
listen('icy-meta', (event) => {
  const { raw, title, artist } = event.payload;
  if (title === state.currentTitle) return;
  state.currentTitle  = title;
  state.currentArtist = artist;
  document.getElementById('trackTitle').textContent  = title || '—';
  document.getElementById('trackArtist').textContent = artist;
  log(`[TRACK_CHANGE] ${raw}`);
  fetchCover(title, artist);
});

// ── Cover ─────────────────────────────────────────────────────────────────────
function showFallbackCover() {
  document.getElementById('coverImg').hidden = true;
  document.getElementById('coverFallback').style.display = '';
}

async function fetchCover(title, artist) {
  if (!title) { showFallbackCover(); return; }
  try {
    const result = await invoke('fetch_artwork', {
      title,
      artist,
      station: state.brand?.productName || '',
    });
    const img = document.getElementById('coverImg');
    const fb  = document.getElementById('coverFallback');
    if (result.local_path) {
      img.src = convertFileSrc(result.local_path);
      img.hidden = false;
      fb.style.display = 'none';
      log(`[ARTWORK_OK] ${result.from_cache ? 'cache' : 'server'}`);
    } else {
      img.hidden = true;
      fb.style.display = '';
      if (result.error) log(`[ARTWORK_ERR] ${result.error}`);
    }
  } catch (e) {
    log(`[ARTWORK_EXCEPTION] ${e}`);
  }
}

// ── Visualizer ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('vizCanvas');
const ctx2d  = canvas.getContext('2d');
canvas.width  = 300;
canvas.height = 40;
const BARS = 40;
const BAR_W = 300 / BARS - 1;

// Frequenze seed per animazione fake — ogni barra ha la sua fase
const phases = Array.from({ length: BARS }, (_, i) => i * 0.4 + Math.random() * 2);
const speeds = Array.from({ length: BARS }, () => 0.8 + Math.random() * 1.2);

function drawViz(ts = 0) {
  requestAnimationFrame(drawViz);
  ctx2d.clearRect(0, 0, 300, 40);
  if (!state.playing) return;

  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#29ABE2';
  const t = ts / 1000;

  if (analyser) {
    // FFT reale
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    for (let i = 0; i < BARS; i++) {
      const val = buf[Math.floor(i * buf.length / BARS)] / 255;
      const h   = Math.max(2, val * 38);
      ctx2d.fillStyle = primary + Math.floor(val * 200 + 55).toString(16).padStart(2, '0');
      ctx2d.fillRect(i * (BAR_W + 1), 40 - h, BAR_W, h);
    }
  } else {
    // Fallback animato: envelope bassa + variazione per frequenza
    for (let i = 0; i < BARS; i++) {
      const env = 0.3 + 0.5 * Math.abs(Math.sin(t * 0.4));
      const wave = Math.sin(t * speeds[i] + phases[i]);
      const val  = Math.max(0, env * (0.4 + 0.6 * wave));
      const h    = Math.max(2, val * 36);
      const alpha = Math.floor(val * 180 + 55).toString(16).padStart(2, '0');
      ctx2d.fillStyle = primary + alpha;
      ctx2d.fillRect(i * (BAR_W + 1), 40 - h, BAR_W, h);
    }
  }
}
requestAnimationFrame(drawViz);

// ── Log ───────────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `[${ts}] ${msg}`;
  state.log.push(line);
  const body = document.getElementById('logBody');
  body.textContent += line + '\n';
  body.scrollTop = body.scrollHeight;
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(cls, label) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot ' + cls;
  document.getElementById('statusLabel').textContent = label;
}

// ── UI wiring ─────────────────────────────────────────────────────────────────
const win = getCurrentWindow();

document.getElementById('btnClose').addEventListener('click', () => win.close());
document.getElementById('btnMini').addEventListener('click',  () => win.minimize());

document.getElementById('btnPlay').addEventListener('click', play);
document.getElementById('btnStop').addEventListener('click', stop);

document.getElementById('volSlider').addEventListener('input', e => {
  audio.volume = parseFloat(e.target.value);
});

// Settings panel
const settingsPanel = document.getElementById('settingsPanel');
document.getElementById('btnSettings').addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});
document.getElementById('btnSettingsClose').addEventListener('click', () => {
  settingsPanel.hidden = true;
});
document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const brandId = document.getElementById('brandSelect').value;
  const brand = await loadBrand(brandId);
  applyBrand(brand);
  stop();
  settingsPanel.hidden = true;
});

// Log panel
const logPanel = document.getElementById('logPanel');
document.getElementById('btnShowLog').addEventListener('click', () => {
  settingsPanel.hidden = true;
  logPanel.hidden = false;
});
document.getElementById('btnLogClose').addEventListener('click', () => { logPanel.hidden = true; });
document.getElementById('btnCopyLog').addEventListener('click', copyLog);
document.getElementById('btnCopyLogInPanel').addEventListener('click', copyLog);

async function copyLog() {
  try { await navigator.clipboard.writeText(state.log.join('\n')); } catch {}
}

document.getElementById('installedVersion').textContent = '0.1.0';
document.getElementById('playerUuid').textContent = state.uuid;

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const savedBrand = localStorage.getItem('brand') || 'funside';
  const brand = await loadBrand(savedBrand).catch(() => loadBrand('funside'));
  applyBrand(brand);
  document.getElementById('brandSelect').value = brand.brandId;
  log('[PLAYER_START]');
  play(); // autoplay
})();
