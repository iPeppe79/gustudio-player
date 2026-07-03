import { invoke }           from '@tauri-apps/api/core';
import { convertFileSrc }   from '@tauri-apps/api/core';
import { listen }           from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

/* global __BRAND__, __BUILD_MODE__ */
const COMPILED_BRAND = __BRAND__;
const IS_DEV_BUILD   = __BUILD_MODE__ === 'dev';
const VERSION        = '0.1.0';
const ICY_DELAY_MS   = 5000;

// Sono dentro la webview Tauri solo se __TAURI_INTERNALS__ esiste
const IS_TAURI = typeof window.__TAURI_INTERNALS__ !== 'undefined';

const uuid = (() => {
  let id = localStorage.getItem('player_uuid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('player_uuid', id); }
  return id;
})();

const brandFallbacks = JSON.parse(localStorage.getItem('brandFallbacks') || '{}');

const state = {
  brand: null, playing: false, currentTitle: '', currentArtist: '',
  audioPhase: 'stopped', networkOnline: navigator.onLine, devMode: false, log: [],
};

function log(msg) {
  const ts   = new Date().toISOString().replace('T',' ').slice(0,23);
  const line = '['+ts+'] '+msg;
  state.log.push(line);
  const body = document.getElementById('logBody');
  if (body) { body.textContent += line+'\n'; body.scrollTop = body.scrollHeight; }
}

function setStatus(cls, label) {
  const d = document.getElementById('statusDot');
  const l = document.getElementById('statusLabel');
  if (d) d.className   = 'status-dot '+cls;
  if (l) l.textContent = label;
}

// ── Audio ─────────────────────────────────────────────────────────────────────
const audio  = document.getElementById('audioEl');
audio.volume = 0.8;

function getAudioState() {
  if (!state.playing)       return 'stopped';
  if (audio.error)          return 'error';
  if (audio.readyState < 3) return 'buffering';
  return 'playing';
}

// ── Tauri invoke — no-op se non siamo in Tauri ────────────────────────────────
async function safeInvoke(cmd, args) {
  if (!IS_TAURI) { log('[MOCK] invoke '+cmd); return null; }
  return invoke(cmd, args);
}

async function diag(event, opts) {
  opts = opts || {};
  try {
    await safeInvoke('send_event', {
      event:      event,
      audioState: opts.audioState != null ? opts.audioState : getAudioState(),
      issueType:  opts.issueType  || null,
      issueNote:  opts.issueNote  || null,
      extra:      opts.extra      || null,
    });
  } catch (e) { log('[DIAG_ERR] '+event+': '+e); }
}

// ── Brand ─────────────────────────────────────────────────────────────────────
async function loadBrand(brandId) {
  const r = await fetch('/'+brandId+'.json');
  if (!r.ok) throw new Error('brand '+brandId+' non trovato');
  return r.json();
}

function applyBrand(brand) {
  state.brand = brand;
  const s = document.documentElement.style;
  s.setProperty('--primary',     brand.theme.primary);
  s.setProperty('--bg',          brand.theme.background);
  s.setProperty('--text',        brand.theme.text);
  s.setProperty('--primary-a20', brand.theme.primary+'33');
  s.setProperty('--primary-a60', brand.theme.primary+'99');
  const logoEl = document.getElementById('brandLogo');
  const nameEl = document.getElementById('brandName');
  nameEl.textContent = brand.productName;
  logoEl.hidden = true; nameEl.hidden = false;
  const t = new Image();
  t.onload  = () => { logoEl.src=t.src; logoEl.hidden=false; nameEl.hidden=true;
    document.getElementById('logoStatus').textContent = '/'+brand.brandId+'-logo.png ok'; };
  t.onerror = () => { document.getElementById('logoStatus').textContent = '/'+brand.brandId+'-logo.png non trovato'; };
  t.src = '/'+brand.brandId+'-logo.png';
  document.getElementById('fallbackName').textContent = brand.productName;
  document.getElementById('brandLabel').textContent   = brand.brandId+'  v'+VERSION;
  document.title = brand.windowTitle || brand.productName;
  document.getElementById('streamUrlInput').value = brand.streamUrl;
  const ef = brandFallbacks[brand.brandId];
  if (ef) document.getElementById('fallbackFileStatus').textContent = ef.split('/').pop();
}

// ── Play / Stop ───────────────────────────────────────────────────────────────
function play() {
  if (!state.brand) return;
  diag('PLAY_REQUEST', { audioState: 'buffering' });
  audio.src = state.brand.streamUrl; audio.load();
  audio.play().catch(e => {
    log('[PLAY_ERROR] '+e.message);
    diag('AUDIO_ERROR', { audioState:'error', issueType:'play_rejected', issueNote:e.message });
  });
  state.playing = true;
  document.getElementById('btnPlay').textContent = '⏸';
  setStatus('buffering','BUFFERING...');
  safeInvoke('start_icy', { url: state.brand.streamUrl }).catch(e => log('[ICY_ERR] '+e));
  log('[PLAY_ATTEMPT] '+state.brand.streamUrl);
}

function stop() {
  diag('STOP_REQUEST', { audioState: 'stopped' });
  audio.pause(); audio.src = '';
  safeInvoke('stop_icy').catch(()=>{});
  state.playing = false; state.audioPhase = 'stopped';
  document.getElementById('btnPlay').textContent = '▶';
  setStatus('stopped','FERMATO');
  diag('STOP_OK', { audioState: 'stopped' });
  state.currentTitle = ''; state.currentArtist = '';
  document.getElementById('trackTitle').textContent  = 'ON AIR';
  document.getElementById('trackArtist').textContent = '';
  showFallbackCover();
  log('[PLAY_STOP]');
}

// ── Cover ─────────────────────────────────────────────────────────────────────
function showFallbackCover() {
  const img = document.getElementById('coverImg');
  const fb  = document.getElementById('coverFallback');
  const fp  = brandFallbacks[state.brand && state.brand.brandId];
  if (fp && IS_TAURI) {
    img.onload  = () => { img.hidden=false; fb.style.display='none'; };
    img.onerror = () => { img.hidden=true;  fb.style.display=''; };
    img.src = convertFileSrc(fp); return;
  }
  img.hidden=true; fb.style.display='';
}

async function fetchCover(title, artist) {
  if (!title) { showFallbackCover(); return; }
  try {
    const result = await safeInvoke('fetch_artwork', {
      title: title, artist: artist, station: (state.brand && state.brand.productName) || '',
    });
    if (!result) { showFallbackCover(); return; }
    const img = document.getElementById('coverImg');
    const fb  = document.getElementById('coverFallback');
    const url = result.artwork_url || (result.local_path && IS_TAURI ? convertFileSrc(result.local_path) : null);
    if (!url) { showFallbackCover(); return; }
    img.onload  = () => { img.hidden=false; fb.style.display='none'; };
    img.onerror = () => { showFallbackCover(); };
    img.src = url;
  } catch (e) { log('[ARTWORK_ERR] '+e); showFallbackCover(); }
}

// ── Telemetria ────────────────────────────────────────────────────────────────
async function doRegister() {
  try {
    await safeInvoke('telemetry_register', {
      uuid: uuid, brand: (state.brand && state.brand.brandId) || '',
      version: VERSION, stationId: (state.brand && state.brand.streamUrl) || '',
    });
    document.getElementById('teleStatusDot').className     = 'status-dot playing';
    document.getElementById('teleStatusLabel').textContent = 'registrato';
    log('[TELE_REGISTER] ok');
    diag('APP_START', { audioState: 'stopped' });
  } catch (e) {
    document.getElementById('teleStatusDot').className     = 'status-dot error';
    document.getElementById('teleStatusLabel').textContent = 'non registrato';
    log('[TELE_REGISTER_ERR] '+e);
  }
}

async function refreshCacheInfo() {
  try {
    const info = await safeInvoke('get_cache_info');
    if (info) {
      const mb = (info.size_bytes/1024/1024).toFixed(1);
      document.getElementById('cacheInfo').textContent = info.file_count+' file · '+mb+' MB';
    }
  } catch (e) {}
}

async function copyLog() {
  try { await navigator.clipboard.writeText(state.log.join('\n')); } catch(e) {}
}

// ── Audio events ──────────────────────────────────────────────────────────────
function wireAudioEvents() {
  audio.addEventListener('playing', () => {
    const wasErr = state.audioPhase==='error' || state.audioPhase==='stall';
    state.audioPhase = 'playing';
    setStatus('playing','IN RIPRODUZIONE');
    const ev = wasErr ? 'AUDIO_RECOVERED' : 'PLAY_START_OK';
    log('['+ev+']'); diag(ev, { audioState:'playing' });
  });
  audio.addEventListener('waiting', () => {
    state.audioPhase = 'buffering'; setStatus('buffering','BUFFERING...');
    log('[BUFFERING]'); diag('BUFFERING', { audioState:'buffering', issueType:'rebuffer' });
  });
  audio.addEventListener('stalled', () => {
    state.audioPhase = 'stall'; log('[AUDIO_STALL]');
    diag('AUDIO_STALL', { audioState:'error', issueType:'stall',
      issueNote:'rs='+audio.readyState+' ns='+audio.networkState });
  });
  audio.addEventListener('error', () => {
    state.audioPhase = 'error';
    const code = audio.error && audio.error.code;
    const msg  = (audio.error && audio.error.message) || 'unknown';
    setStatus('error','ERRORE STREAM'); log('[AUDIO_ERROR] code='+code+' '+msg);
    diag('AUDIO_ERROR', { audioState:'error', issueType:'media_error_'+code, issueNote:msg });
  });
}

// ── Device / Network ─────────────────────────────────────────────────────────
function wireNetworkEvents() {
  let offlineAt = null;
  window.addEventListener('offline', () => {
    offlineAt = Date.now(); state.networkOnline = false;
    log('[NETWORK_LOST]'); setStatus('error','RETE ASSENTE');
    diag('NETWORK_LOST', { audioState:'error', issueType:'network_offline' });
  });
  window.addEventListener('online', () => {
    state.networkOnline = true;
    const d = offlineAt ? Date.now()-offlineAt : null; offlineAt = null;
    log('[NETWORK_RESTORED] down='+d+'ms');
    diag('NETWORK_RESTORED', { audioState:'buffering', issueType:'network_restored',
      extra: d !== null ? { downtime_ms:d } : null });
    if (state.playing) play();
  });
  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      log('[DEVICE_CHANGE]');
      diag('DEVICE_CHANGE', { audioState:getAudioState(), issueType:'device_change',
        issueNote:'wasPlaying='+state.playing });
      if (state.playing) {
        const src = audio.src; audio.src = '';
        await new Promise(r => setTimeout(r,300));
        audio.src = src;
        audio.play().catch(e => {
          log('[DEVICE_CHANGE_FAIL] '+e.message);
          diag('AUDIO_ERROR', { audioState:'error', issueType:'device_change_recover_failed', issueNote:e.message });
        });
      }
    });
  }
}

// ── Dev dropdown ─────────────────────────────────────────────────────────────
let selectedBrandId = COMPILED_BRAND;

function wireBrandDropdown() {
  const btn  = document.getElementById('brandSelectBtn');
  const list = document.getElementById('brandSelectList');
  const lbl  = document.getElementById('brandSelectLabel');
  const wrap = document.getElementById('brandSelectWrap');
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = !list.hidden; list.hidden = open; wrap.classList.toggle('open', !open);
  });
  list.addEventListener('click', e => {
    const opt = e.target.closest('.cselect-opt'); if (!opt) return;
    selectedBrandId = opt.dataset.value; lbl.textContent = opt.textContent.trim();
    list.querySelectorAll('.cselect-opt').forEach(o => o.classList.toggle('selected', o.dataset.value===selectedBrandId));
    list.hidden = true; wrap.classList.remove('open');
  });
  document.addEventListener('click', () => { if(list){list.hidden=true; wrap.classList.remove('open');} });
}

function setBrandSelect(brandId) {
  selectedBrandId = brandId;
  const list = document.getElementById('brandSelectList');
  const lbl  = document.getElementById('brandSelectLabel');
  if (!list) return;
  const opt = list.querySelector('[data-value="'+brandId+'"]');
  if (opt) { lbl.textContent = opt.textContent.trim();
    list.querySelectorAll('.cselect-opt').forEach(o => o.classList.toggle('selected', o.dataset.value===brandId)); }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    if (!state.brand) return;
    safeInvoke('send_event', { event:'HEARTBEAT', audioState:getAudioState(),
      issueType:null, issueNote:null, extra:null }).catch(()=>{});
  }, 60000);
}

// ── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  log('[INIT] start IS_TAURI='+IS_TAURI+' IS_DEV_BUILD='+IS_DEV_BUILD);

  // 1. Wiring audio + DOM puri (nessuna chiamata Tauri, non possono fallire)
  wireAudioEvents();
  wireNetworkEvents();
  wireBrandDropdown();

  // 2. TUTTI i button listener prima di qualsiasi API Tauri
  document.getElementById('btnPlay').addEventListener('click', () => {
    if (state.playing) stop(); else play();
  });
  document.getElementById('btnStop').addEventListener('click', stop);
  document.getElementById('volSlider').addEventListener('input', e => {
    audio.volume = parseFloat(e.target.value);
  });

  const settingsPanel = document.getElementById('settingsPanel');
  const logPanel      = document.getElementById('logPanel');

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      state.devMode = !state.devMode;
      document.getElementById('devPanel').hidden = !state.devMode;
      log('[DEV_MODE] '+(state.devMode?'ON':'OFF'));
    }
  });
  document.getElementById('btnSettings').addEventListener('click', () => {
    const h = settingsPanel.hidden; settingsPanel.hidden = !h; logPanel.hidden = true;
    if (h) refreshCacheInfo();
  });
  document.getElementById('btnSettingsClose').addEventListener('click', () => { settingsPanel.hidden=true; });
  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    const u = document.getElementById('streamUrlInput').value.trim();
    if (u && state.brand) { state.brand.streamUrl=u; stop(); setTimeout(play,300); }
    settingsPanel.hidden = true;
  });
  document.getElementById('btnSaveBrand') && document.getElementById('btnSaveBrand').addEventListener('click', async () => {
    const brand = await loadBrand(selectedBrandId);
    applyBrand(brand); localStorage.setItem('brand', selectedBrandId);
    stop(); settingsPanel.hidden=true; doRegister();
  });
  document.getElementById('btnPickFallback').addEventListener('click', () => {
    document.getElementById('fileFallback').click();
  });
  document.getElementById('fileFallback').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file || !state.brand) return;
    const ext  = file.name.split('.').pop().toLowerCase();
    const data = Array.from(new Uint8Array(await file.arrayBuffer()));
    try {
      const path = await safeInvoke('save_brand_fallback', { brandId:state.brand.brandId, data:data, ext:ext });
      if (path) { brandFallbacks[state.brand.brandId]=path; localStorage.setItem('brandFallbacks',JSON.stringify(brandFallbacks));
        document.getElementById('fallbackFileStatus').textContent = file.name; }
    } catch(err) { log('[FALLBACK_ERR] '+err); }
    e.target.value = '';
  });
  document.getElementById('btnClearCache').addEventListener('click', async () => {
    await safeInvoke('clear_artwork_cache');
    document.getElementById('cacheInfo').textContent = '0 file · 0.0 MB'; log('[CACHE_CLEARED]');
  });
  document.getElementById('btnTeleRegister').addEventListener('click', doRegister);
  document.getElementById('btnTeleHealth').addEventListener('click', async () => {
    try {
      const res = await safeInvoke('telemetry_health');
      document.getElementById('teleResult').textContent = 'HTTP '+res.status+'\n'+(res.body||'').slice(0,200);
    } catch (e) { document.getElementById('teleResult').textContent = String(e); }
  });
  document.getElementById('btnShowLog').addEventListener('click', () => { settingsPanel.hidden=true; logPanel.hidden=false; });
  document.getElementById('btnLogClose').addEventListener('click', () => { logPanel.hidden=true; });
  document.getElementById('btnCopyLog').addEventListener('click', copyLog);
  document.getElementById('btnCopyLogInPanel').addEventListener('click', copyLog);
  document.getElementById('installedVersion').textContent = VERSION;
  document.getElementById('playerUuid').textContent       = uuid;

  log('[INIT] button listeners ok');

  // 3. Tauri window API — in blocco separato, non blocca il flusso se fallisce
  if (IS_TAURI) {
    try {
      const win = getCurrentWindow();
      document.getElementById('btnClose').addEventListener('click', () => win.close());
      document.getElementById('btnMini').addEventListener('click',  () => win.minimize());
      try {
        await win.onCloseRequested(async ev => {
          ev.preventDefault();
          try { await Promise.race([diag('APP_EXIT',{audioState:'stopped'}), new Promise(r=>setTimeout(r,1500))]); }
          finally { await win.destroy(); }
        });
        log('[INIT] onCloseRequested ok');
      } catch (e) {
        log('[INIT] onCloseRequested non supportato: '+e);
        window.addEventListener('beforeunload', () => diag('APP_EXIT',{audioState:'stopped'}));
      }
    } catch (e) {
      log('[INIT] getCurrentWindow fallito: '+e);
      // fallback chiusura via DOM
      document.getElementById('btnClose').addEventListener('click', () => window.close());
    }

    // 4. ICY listeners
    try {
      await listen('icy-stream', ev => {
        const type = ev.payload.type;
        log('[ICY_STREAM] '+type);
        const m = {STREAM_HEADERS:'buffering',STREAM_FIRST_BYTE:'buffering',STREAM_OK:'playing'};
        diag(type, { audioState: m[type] || getAudioState() });
      });
      await listen('icy-meta', ev => {
        const { raw, title, artist } = ev.payload;
        log('[ICY_RAW] '+raw);
        setTimeout(() => {
          if (!state.playing || title===state.currentTitle) return;
          state.currentTitle=title; state.currentArtist=artist;
          document.getElementById('trackTitle').textContent  = title  || 'ON AIR';
          document.getElementById('trackArtist').textContent = artist || '';
          log('[TRACK_CHANGE] '+raw);
          diag('TRACK_CHANGE', { audioState:'playing', extra:{title,artist,raw} });
          fetchCover(title, artist);
        }, ICY_DELAY_MS);
      });
      log('[INIT] ICY listeners ok');
    } catch (e) { log('[INIT] listen fallito: '+e); }
  } else {
    // Browser: wire close/mini con semplice fallback
    document.getElementById('btnClose').addEventListener('click', () => window.close());
    document.getElementById('btnMini').addEventListener('click',  () => {});
    log('[INIT] running in browser (non Tauri), ICY listeners skipped');
  }

  // 5. Brand
  const brandToLoad = IS_DEV_BUILD
    ? (localStorage.getItem('brand') || COMPILED_BRAND)
    : COMPILED_BRAND;
  const brand = await loadBrand(brandToLoad).catch(() => loadBrand('funside'));
  applyBrand(brand);
  setBrandSelect(brand.brandId);
  log('[PLAYER_START] brand='+brand.brandId+' mode='+__BUILD_MODE__+' uuid='+uuid);

  // 6. Registrazione telemetria + heartbeat
  doRegister();
  startHeartbeat();

  // 7. Fallback cover da disco
  if (IS_TAURI) {
    safeInvoke('get_brand_fallback', { brandId: brand.brandId })
      .then(path => {
        if (path && !brandFallbacks[brand.brandId]) {
          brandFallbacks[brand.brandId]=path;
          localStorage.setItem('brandFallbacks',JSON.stringify(brandFallbacks));
        }
      }).catch(()=>{});
  }

  // 8. Avvia stream
  play();
  log('[INIT] complete');
}

init().catch(e => {
  console.error('[INIT_FATAL]', e);
  log('[INIT_FATAL] '+e);
});
