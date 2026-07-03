import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ── Costanti build-time ───────────────────────────────────────────────────────
// __BRAND__ e __BUILD_MODE__ sono sostituiti da Vite a compile time.
// In dev (BRAND non settato): 'funside' e 'dev'.
// In prod (BRAND=funside npm run tauri build): 'funside' e 'production'.
/* global __BRAND__, __BUILD_MODE__ */
const COMPILED_BRAND = __BRAND__;
const IS_DEV_BUILD   = __BUILD_MODE__ === 'dev';
const VERSION        = '0.1.0';
const ICY_DELAY_MS   = 5000;

// ── UUID persistente ──────────────────────────────────────────────────────────
const uuid = (() => {
  let id = localStorage.getItem('player_uuid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('player_uuid', id); }
  return id;
})();

const brandFallbacks = JSON.parse(localStorage.getItem('brandFallbacks') || '{}');

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  brand:          null,
  playing:        false,
  currentTitle:   '',
  currentArtist:  '',
  audioPhase:     'stopped', // stopped | buffering | playing | error | stall
  lastError:      null,
  networkOnline:  navigator.onLine,
  devMode:        false,
  log:            [],
};

// ── Telemetria — evento diagnostico generico ──────────────────────────────────
async function diag(event, opts = {}) {
  try {
    await invoke('send_event', {
      event,
      audioState: opts.audioState ?? getAudioState(),
      issueType:  opts.issueType  ?? null,
      issueNote:  opts.issueNote  ?? null,
      extra:      opts.extra      ?? null,
    });
  } catch (e) {
    log(`[DIAG_ERR] ${event}: ${e}`);
  }
}

function getAudioState() {
  if (!state.playing)       return 'stopped';
  if (audio.error)          return 'error';
  if (audio.readyState < 3) return 'buffering';
  return 'playing';
}

// ── Brand loading ─────────────────────────────────────────────────────────────
async function loadBrand(brandId) {
  const resp = await fetch(`/${brandId}.json`);
  if (!resp.ok) throw new Error(`brand ${brandId} non trovato`);
  return resp.json();
}

function applyBrand(brand) {
  state.brand = brand;
  const r = document.documentElement.style;
  r.setProperty('--primary',     brand.theme.primary);
  r.setProperty('--bg',          brand.theme.background);
  r.setProperty('--text',        brand.theme.text);
  r.setProperty('--primary-a20', brand.theme.primary + '33');
  r.setProperty('--primary-a60', brand.theme.primary + '99');

  const logoEl = document.getElementById('brandLogo');
  const nameEl = document.getElementById('brandName');
  nameEl.textContent = brand.productName;
  logoEl.hidden = true;
  nameEl.hidden = false;

  const tryLogo = new Image();
  tryLogo.onload  = () => { logoEl.src = tryLogo.src; logoEl.hidden = false; nameEl.hidden = true;
    document.getElementById('logoStatus').textContent = `/${brand.brandId}-logo.png ✓`; };
  tryLogo.onerror = () => { document.getElementById('logoStatus').textContent = `/${brand.brandId}-logo.png non trovato`; };
  tryLogo.src = `/${brand.brandId}-logo.png`;

  document.getElementById('fallbackName').textContent = brand.productName;
  document.getElementById('brandLabel').textContent   = `${brand.brandId}  v${VERSION}`;
  document.title = brand.windowTitle || brand.productName;
  document.getElementById('streamUrlInput').value = brand.streamUrl;

  const ef = brandFallbacks[brand.brandId];
  if (ef) document.getElementById('fallbackFileStatus').textContent = ef.split('/').pop();

  log(`[BRAND_LOADED] ${brand.brandId}`);
}

// ── Audio ─────────────────────────────────────────────────────────────────────
const audio = document.getElementById('audioEl');

function play() {
  if (!state.brand) return;
  diag('PLAY_REQUEST', { audioState: 'buffering' });
  audio.src = state.brand.streamUrl;
  audio.load();
  audio.play().catch(e => {
    log(`[PLAY_ERROR] ${e.message}`);
    diag('AUDIO_ERROR', { audioState: 'error', issueType: 'play_rejected', issueNote: e.message });
  });
  state.playing = true;
  updatePlayBtn(true);
  setStatus('buffering', 'BUFFERING...');
  log(`[PLAY_ATTEMPT] ${state.brand.streamUrl}`);
  invoke('start_icy', { url: state.brand.streamUrl }).catch(e => log(`[ICY_ERR] ${e}`));
}

function stop() {
  diag('STOP_REQUEST', { audioState: 'stopped' });
  audio.pause();
  audio.src = '';
  invoke('stop_icy').catch(() => {});
  state.playing = false;
  state.audioPhase  = 'stopped';
  updatePlayBtn(false);
  setStatus('stopped', 'FERMATO');
  diag('STOP_OK', { audioState: 'stopped' });
  log('[PLAY_STOP]');
  state.currentTitle  = '';
  state.currentArtist = '';
  document.getElementById('trackTitle').textContent  = 'ON AIR';
  document.getElementById('trackArtist').textContent = '';
  showFallbackCover();
}

function updatePlayBtn(playing) {
  document.getElementById('btnPlay').textContent = playing ? '⏸' : '▶';
}

// ── Sequenza avvio stream ─────────────────────────────────────────────────────
// STREAM_HEADERS / STREAM_FIRST_BYTE / STREAM_OK → arrivano da ICY Rust
listen('icy-stream', (event) => {
  const { type } = event.payload;
  log(`[ICY_STREAM] ${type}`);
  const stateMap = {
    STREAM_HEADERS:    'buffering',
    STREAM_FIRST_BYTE: 'buffering',
    STREAM_OK:         'playing',
  };
  diag(type, { audioState: stateMap[type] || getAudioState() });
});

// ── Sequenza audio element ────────────────────────────────────────────────────
audio.addEventListener('playing', () => {
  const wasError = state.audioPhase === 'error' || state.audioPhase === 'stall';
  state.audioPhase = 'playing';
  setStatus('playing', 'IN RIPRODUZIONE');
  log(wasError ? '[AUDIO_RECOVERED]' : '[PLAY_START_OK]');
  diag(wasError ? 'AUDIO_RECOVERED' : 'PLAY_START_OK', { audioState: 'playing' });
});

audio.addEventListener('waiting', () => {
  state.audioPhase = 'buffering';
  setStatus('buffering', 'BUFFERING...');
  log('[BUFFERING]');
  diag('BUFFERING', { audioState: 'buffering', issueType: 'rebuffer' });
});

audio.addEventListener('stalled', () => {
  state.audioPhase = 'stall';
  log('[AUDIO_STALL]');
  diag('AUDIO_STALL', {
    audioState: 'error',
    issueType: 'stall',
    issueNote: `readyState=${audio.readyState} networkState=${audio.networkState}`,
  });
});

audio.addEventListener('error', () => {
  state.audioPhase = 'error';
  const code = audio.error?.code;
  const msg  = audio.error?.message || 'unknown';
  state.lastError = msg;
  setStatus('error', 'ERRORE STREAM');
  log(`[AUDIO_ERROR] code=${code} ${msg}`);
  diag('AUDIO_ERROR', {
    audioState: 'error',
    issueType:  `media_error_${code}`,
    issueNote:  msg,
  });
});

audio.addEventListener('loadeddata', () => {
  // Proxy STREAM_FIRST_BYTE lato audio element (arrivo dati nel buffer HTML)
  // (ICY emette il suo STREAM_FIRST_BYTE separatamente)
  log('[AUDIO_FIRST_FRAME]');
});

audio.addEventListener('pause', () => {
  if (!state.playing) return; // stop() intenzionale già gestito
  // Pausa inattesa (es. sistema sospende, cuffie staccate)
  log('[AUDIO_UNEXPECTED_PAUSE]');
  diag('AUDIO_UNEXPECTED_PAUSE', {
    audioState: 'error',
    issueType:  'unexpected_pause',
  });
});

// ── Device change — hardware audio agnostico ──────────────────────────────────
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    log('[DEVICE_CHANGE] uscita audio cambiata');
    diag('DEVICE_CHANGE', {
      audioState: getAudioState(),
      issueType:  'device_change',
      issueNote:  `wasPlaying=${state.playing}`,
    });
    // Se stava suonando, ricarica stream sul nuovo device
    if (state.playing) {
      log('[DEVICE_CHANGE] tentativo ripresa automatica...');
      const src = audio.src;
      audio.src = '';
      await new Promise(r => setTimeout(r, 300));
      audio.src = src;
      audio.play().catch(e => {
        log(`[DEVICE_CHANGE_FAIL] ${e.message}`);
        diag('AUDIO_ERROR', { audioState: 'error', issueType: 'device_change_recover_failed', issueNote: e.message });
      });
    }
  });
}

// ── Rete ─────────────────────────────────────────────────────────────────────
let offlineAt = null;

window.addEventListener('offline', () => {
  offlineAt = Date.now();
  state.networkOnline = false;
  log('[NETWORK_LOST]');
  setStatus('error', 'RETE ASSENTE');
  diag('NETWORK_LOST', { audioState: 'error', issueType: 'network_offline' });
});

window.addEventListener('online', () => {
  state.networkOnline = true;
  const downMs = offlineAt ? Date.now() - offlineAt : null;
  offlineAt = null;
  log(`[NETWORK_RESTORED] down=${downMs}ms`);
  diag('NETWORK_RESTORED', {
    audioState: 'buffering',
    issueType:  'network_restored',
    extra:      downMs !== null ? { downtime_ms: downMs } : null,
  });
  // Riconnetti automaticamente se stava suonando
  if (state.playing) {
    log('[NETWORK_RESTORED] riconnessione stream...');
    play();
  }
});

// ── ICY metadata ──────────────────────────────────────────────────────────────
listen('icy-meta', (event) => {
  const { raw, title, artist } = event.payload;
  log(`[ICY_RAW] ${raw}`);
  setTimeout(() => {
    if (!state.playing) return;
    if (title === state.currentTitle) return;
    state.currentTitle  = title;
    state.currentArtist = artist;
    document.getElementById('trackTitle').textContent  = title  || 'ON AIR';
    document.getElementById('trackArtist').textContent = artist || '';
    log(`[TRACK_CHANGE] ${raw}`);
    diag('TRACK_CHANGE', {
      audioState: 'playing',
      extra:      { title, artist, raw },
    });
    fetchCover(title, artist);
  }, ICY_DELAY_MS);
});

// ── Cover ─────────────────────────────────────────────────────────────────────
async function showFallbackCover() {
  const img = document.getElementById('coverImg');
  const fb  = document.getElementById('coverFallback');
  const fallbackPath = brandFallbacks[state.brand?.brandId];
  if (fallbackPath) {
    img.onload  = () => { img.hidden = false; fb.style.display = 'none'; };
    img.onerror = () => { img.hidden = true;  fb.style.display = ''; };
    img.src = convertFileSrc(fallbackPath);
    return;
  }
  img.hidden = true;
  fb.style.display = '';
}

async function fetchCover(title, artist) {
  if (!title) { showFallbackCover(); return; }
  log(`[ARTWORK_FETCH] "${title}" / "${artist}"`);
  try {
    const result = await invoke('fetch_artwork', {
      title, artist, station: state.brand?.productName || '',
    });
    log(`[ARTWORK_RESULT] cache=${result.from_cache} err=${result.error}`);
    const img    = document.getElementById('coverImg');
    const fb     = document.getElementById('coverFallback');
    const imgUrl = result.artwork_url || (result.local_path ? convertFileSrc(result.local_path) : null);
    if (!imgUrl) { showFallbackCover(); return; }
    img.onload  = () => { img.hidden = false; fb.style.display = 'none'; log('[ARTWORK_SHOWN]'); };
    img.onerror = () => {
      log(`[ARTWORK_IMG_ERR] ${img.src.slice(0, 80)}`);
      if (result.local_path && img.src !== convertFileSrc(result.local_path))
        img.src = convertFileSrc(result.local_path);
      else showFallbackCover();
    };
    img.src = imgUrl;
  } catch (e) {
    log(`[ARTWORK_EXCEPTION] ${e}`);
    showFallbackCover();
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
async function refreshCacheInfo() {
  try {
    const info = await invoke('get_cache_info');
    const mb   = (info.size_bytes / 1024 / 1024).toFixed(1);
    document.getElementById('cacheInfo').textContent = `${info.file_count} file · ${mb} MB`;
  } catch { /* ignore */ }
}

// ── Log ───────────────────────────────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `[${ts}] ${msg}`;
  state.log.push(line);
  const body = document.getElementById('logBody');
  body.textContent += line + '\n';
  body.scrollTop = body.scrollHeight;
}

function setStatus(cls, label) {
  document.getElementById('statusDot').className     = 'status-dot ' + cls;
  document.getElementById('statusLabel').textContent = label;
}

// ── Telemetria UI ─────────────────────────────────────────────────────────────
async function doRegister() {
  try {
    const res = await invoke('telemetry_register', {
      uuid,
      brand:     state.brand?.brandId   || '',
      version:   VERSION,
      stationId: state.brand?.streamUrl || '',
    });
    document.getElementById('teleStatusDot').className     = 'status-dot playing';
    document.getElementById('teleStatusLabel').textContent = 'registrato';
    log(`[TELE_REGISTER] ok`);
    // APP_START dopo registrazione riuscita
    diag('APP_START', { audioState: 'stopped' });
  } catch (e) {
    document.getElementById('teleStatusDot').className     = 'status-dot error';
    document.getElementById('teleStatusLabel').textContent = 'non registrato';
    log(`[TELE_REGISTER_ERR] ${e}`);
  }
}

// ── Window wiring ─────────────────────────────────────────────────────────────
const win = getCurrentWindow();

// APP_EXIT prima di chiudere (max 1.5s di attesa)
win.onCloseRequested(async (ev) => {
  ev.preventDefault();
  try {
    await Promise.race([
      diag('APP_EXIT', { audioState: 'stopped' }),
      new Promise(r => setTimeout(r, 1500)),
    ]);
  } finally {
    await win.destroy();
  }
});

document.getElementById('btnClose').addEventListener('click', () => win.close());
document.getElementById('btnMini').addEventListener('click',  () => win.minimize());

document.getElementById('btnPlay').addEventListener('click', () => {
  if (state.playing) { stop(); } else { play(); }
});
document.getElementById('btnStop').addEventListener('click', stop);

document.getElementById('volSlider').addEventListener('input', e => {
  audio.volume = parseFloat(e.target.value);
});

// ── Settings panel ────────────────────────────────────────────────────────────
const settingsPanel = document.getElementById('settingsPanel');

// Dev mode: Ctrl+Shift+D rivela il brand selector nascosto
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    state.devMode = !state.devMode;
    document.getElementById('devPanel').hidden = !state.devMode;
    log(`[DEV_MODE] ${state.devMode ? 'ON' : 'OFF'}`);
  }
});

document.getElementById('btnSettings').addEventListener('click', () => {
  const wasHidden = settingsPanel.hidden;
  settingsPanel.hidden = !settingsPanel.hidden;
  document.getElementById('logPanel').hidden = true;
  if (wasHidden) refreshCacheInfo();
});
document.getElementById('btnSettingsClose').addEventListener('click', () => {
  settingsPanel.hidden = true;
});

// Riconnetti (aggiorna solo stream URL, brand è fixed)
document.getElementById('btnSaveSettings').addEventListener('click', () => {
  const newUrl = document.getElementById('streamUrlInput').value.trim();
  if (newUrl && state.brand) {
    state.brand.streamUrl = newUrl;
    stop();
    setTimeout(play, 300);
  }
  settingsPanel.hidden = true;
});

// ── Dev dropdown brand ────────────────────────────────────────────────────────
let selectedBrandId = COMPILED_BRAND;

const brandSelectBtn   = document.getElementById('brandSelectBtn');
const brandSelectList  = document.getElementById('brandSelectList');
const brandSelectLabel = document.getElementById('brandSelectLabel');
const brandSelectWrap  = document.getElementById('brandSelectWrap');

brandSelectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !brandSelectList.hidden;
  brandSelectList.hidden = open;
  brandSelectWrap.classList.toggle('open', !open);
});

brandSelectList.addEventListener('click', (e) => {
  const opt = e.target.closest('.cselect-opt');
  if (!opt) return;
  selectedBrandId = opt.dataset.value;
  brandSelectLabel.textContent = opt.textContent.trim();
  brandSelectList.querySelectorAll('.cselect-opt')
    .forEach(o => o.classList.toggle('selected', o.dataset.value === selectedBrandId));
  brandSelectList.hidden = true;
  brandSelectWrap.classList.remove('open');
});

document.addEventListener('click', () => {
  if (brandSelectList) { brandSelectList.hidden = true; brandSelectWrap?.classList.remove('open'); }
});

function setBrandSelect(brandId) {
  selectedBrandId = brandId;
  const opt = brandSelectList?.querySelector(`[data-value="${brandId}"]`);
  if (opt) {
    brandSelectLabel.textContent = opt.textContent.trim();
    brandSelectList.querySelectorAll('.cselect-opt')
      .forEach(o => o.classList.toggle('selected', o.dataset.value === brandId));
  }
}

document.getElementById('btnSaveBrand')?.addEventListener('click', async () => {
  const brand = await loadBrand(selectedBrandId);
  applyBrand(brand);
  localStorage.setItem('brand', selectedBrandId);
  stop();
  settingsPanel.hidden = true;
  doRegister();
});

// ── Fallback cover upload ─────────────────────────────────────────────────────
document.getElementById('btnPickFallback').addEventListener('click', () => {
  document.getElementById('fileFallback').click();
});
document.getElementById('fileFallback').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !state.brand) return;
  const ext    = file.name.split('.').pop().toLowerCase();
  const buffer = await file.arrayBuffer();
  const data   = Array.from(new Uint8Array(buffer));
  try {
    const path = await invoke('save_brand_fallback', { brandId: state.brand.brandId, data, ext });
    if (path) {
      brandFallbacks[state.brand.brandId] = path;
      localStorage.setItem('brandFallbacks', JSON.stringify(brandFallbacks));
      document.getElementById('fallbackFileStatus').textContent = file.name;
      log(`[FALLBACK_SAVED] ${path}`);
    }
  } catch (err) { log(`[FALLBACK_ERR] ${err}`); }
  e.target.value = '';
});

// ── Cache ─────────────────────────────────────────────────────────────────────
document.getElementById('btnClearCache').addEventListener('click', async () => {
  await invoke('clear_artwork_cache');
  document.getElementById('cacheInfo').textContent = '0 file · 0.0 MB';
  log('[CACHE_CLEARED]');
});

// ── Telemetria UI buttons ─────────────────────────────────────────────────────
document.getElementById('btnTeleRegister').addEventListener('click', doRegister);
document.getElementById('btnTeleHealth').addEventListener('click', async () => {
  try {
    const res = await invoke('telemetry_health');
    document.getElementById('teleResult').textContent = `HTTP ${res.status}\n${res.body?.slice(0, 200)}`;
  } catch (e) {
    document.getElementById('teleResult').textContent = String(e);
  }
});

// ── Log panel ─────────────────────────────────────────────────────────────────
const logPanel = document.getElementById('logPanel');
document.getElementById('btnShowLog').addEventListener('click', () => {
  settingsPanel.hidden = true;
  logPanel.hidden = false;
});
document.getElementById('btnLogClose').addEventListener('click',       () => { logPanel.hidden = true; });
document.getElementById('btnCopyLog').addEventListener('click',        copyLog);
document.getElementById('btnCopyLogInPanel').addEventListener('click', copyLog);
async function copyLog() {
  try { await navigator.clipboard.writeText(state.log.join('\n')); } catch {}
}

document.getElementById('installedVersion').textContent = VERSION;
document.getElementById('playerUuid').textContent       = uuid;

// ── Heartbeat intervallo da JS — mantiene audio_state aggiornato in Rust ──────
setInterval(() => {
  if (!state.brand) return;
  invoke('send_event', {
    event:      'HEARTBEAT',
    audioState: getAudioState(),
    issueType:  null, issueNote: null, extra: null,
  }).catch(() => {});
}, 60_000);

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // In produzione il brand è fissato a build time; in dev usa localStorage o fallback
  const brandToLoad = IS_DEV_BUILD
    ? (localStorage.getItem('brand') || COMPILED_BRAND)
    : COMPILED_BRAND;

  const brand = await loadBrand(brandToLoad).catch(() => loadBrand('funside'));
  applyBrand(brand);
  setBrandSelect(brand.brandId);

  log(`[PLAYER_START] brand=${brand.brandId} mode=${__BUILD_MODE__} uuid=${uuid}`);

  // Registrazione telemetria
  doRegister();

  // Fallback cover dal disco
  invoke('get_brand_fallback', { brandId: brand.brandId })
    .then(path => {
      if (path && !brandFallbacks[brand.brandId]) {
        brandFallbacks[brand.brandId] = path;
        localStorage.setItem('brandFallbacks', JSON.stringify(brandFallbacks));
      }
    }).catch(() => {});

  play();
})();
