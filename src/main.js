import { invoke }           from '@tauri-apps/api/core';
import { convertFileSrc }   from '@tauri-apps/api/core';
import { listen }           from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

/* global __BRAND__, __BUILD_MODE__ */
const COMPILED_BRAND = __BRAND__;
const IS_DEV_BUILD   = __BUILD_MODE__ === 'dev';
const VERSION      = '0.1.0';
let   ICY_DELAY_MS = parseInt(localStorage.getItem('icy_delay_ms') || '18000', 10);

// Sono dentro la webview Tauri solo se __TAURI_INTERNALS__ esiste
const IS_TAURI = typeof window.__TAURI_INTERNALS__ !== 'undefined';

const uuid      = (() => {
  let id = localStorage.getItem('player_uuid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('player_uuid', id); }
  return id;
})();
const sessionId = crypto.randomUUID(); // nuovo ad ogni avvio

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
  const b = document.getElementById('statusBadge');
  if (d) d.className   = 'status-dot '+cls;
  if (l) l.textContent = label;
  if (b) b.className   = 'status-badge '+cls;
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

// Rate limiter: max 1 evento per tipo ogni N ms, globalmente max 1 req/2s
const _diagLast = {};
const _DIAG_THROTTLE = {
  BUFFERING:      15000,
  AUDIO_STALL:    15000,
  AUDIO_RECOVERED: 5000,
  HEARTBEAT:      60000,
  RECONNECT:       5000,
  LONG_SILENCE: 20*60*1000,
  default:         2000,
};
let _diagLastGlobal = 0;
const _DIAG_GLOBAL_MIN = 500; // protezione anti-burst, i throttle per-evento gestiscono la frequenza

async function diag(event, opts) {
  const now = Date.now();
  const throttle = _DIAG_THROTTLE[event] ?? _DIAG_THROTTLE.default;
  if (now - (_diagLast[event] || 0) < throttle) { log('[DIAG_SKIP_THROTTLE] '+event); return; }
  if (now - _diagLastGlobal < _DIAG_GLOBAL_MIN) { log('[DIAG_SKIP_GLOBAL] '+event+' gap='+(now-_diagLastGlobal)+'ms'); return; }
  _diagLast[event]  = now;
  _diagLastGlobal   = now;
  opts = opts || {};
  log('[DIAG_SEND] '+event);
  try {
    const status = await safeInvoke('send_event', {
      event:      event,
      audioState: opts.audioState != null ? opts.audioState : getAudioState(),
      issueType:  opts.issueType  || null,
      issueNote:  opts.issueNote  || null,
      extra:      opts.extra      || null,
    });
    log('[DIAG_OK] '+event+' HTTP='+status);
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

  // Colori brand (logo dots) → traffic buttons + neon pulse
  const colors = brand.colors || [brand.theme.primary];
  state.brandColors = colors;
  const closeBtn = document.querySelector('.close-btn');
  const miniBtn  = document.querySelector('.mini-btn');
  if (closeBtn) closeBtn.style.background = colors[0] || brand.theme.primary;
  if (miniBtn)  miniBtn.style.background  = colors[1] || 'rgba(255,255,255,0.25)';

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
  _playRequestedAt = Date.now();
  _lastTrackAt     = Date.now(); // evita LONG_SILENCE immediato su nuovo play
  clearWatchdog();
  // Setto playing=true PRIMA di audio.play() così l'evento 'playing' trova lo stato corretto
  state.playing    = true;
  state.audioPhase = 'buffering';
  document.getElementById('btnPlay').textContent = '⏸';
  setStatus('buffering', 'BUFFERING...');
  showFallbackCover(); // mostra subito la cover fallback mentre aspettiamo ICY
  diag('PLAY_REQUEST', { audioState: 'buffering' });
  audio.src = state.brand.streamUrl; audio.load();
  audio.play().catch(e => {
    // Autoplay bloccato
    state.playing    = false;
    state.audioPhase = 'stopped';
    document.getElementById('btnPlay').textContent = '▶';
    setStatus('stopped', 'Premi ▶ per ascoltare');
    log('[AUTOPLAY_BLOCKED] '+e.message);
  });
  safeInvoke('start_icy', { url: state.brand.streamUrl }).catch(e => log('[ICY_ERR] '+e));
  log('[PLAY_ATTEMPT] '+state.brand.streamUrl);
}

function stop() {
  clearWatchdog();
  _reconnectAttempt = 0;
  _playStartedAt    = 0;
  _playRequestedAt  = 0;
  diag('STOP_REQUEST', { audioState: 'stopped' });
  audio.pause(); audio.src = '';
  safeInvoke('stop_icy').catch(()=>{});
  state.playing = false; state.audioPhase = 'stopped';
  document.getElementById('coverWrap') && document.getElementById('coverWrap').classList.remove('playing');
  stopNeon();
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
  // 1. Fallback da disco (scelto dall'utente via UI)
  const fp = brandFallbacks[state.brand && state.brand.brandId];
  if (fp && IS_TAURI) {
    img.onload  = () => { img.hidden=false; fb.style.display='none'; };
    img.onerror = () => { tryBrandFallbackCover(img, fb); };
    img.src = convertFileSrc(fp); return;
  }
  // 2. Fallback bundled nel brand JSON (es. /funside-cover.png)
  tryBrandFallbackCover(img, fb);
}

function tryBrandFallbackCover(img, fb) {
  const bundled = state.brand && state.brand.fallbackCover;
  if (bundled) {
    img.onload  = () => { img.hidden=false; fb.style.display='none'; };
    img.onerror = () => { img.hidden=true;  fb.style.display=''; };
    img.src = bundled; return;
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
function getSetupData() {
  return {
    insegna:   (document.getElementById('setupInsegna')  && document.getElementById('setupInsegna').value.trim())   || '',
    via:       (document.getElementById('setupVia')       && document.getElementById('setupVia').value.trim())       || '',
    citta:     (document.getElementById('setupCitta')     && document.getElementById('setupCitta').value.trim())     || '',
    referente: (document.getElementById('setupReferente') && document.getElementById('setupReferente').value.trim()) || '',
    email:     (document.getElementById('setupEmail')     && document.getElementById('setupEmail').value.trim())     || '',
    telefono:  (document.getElementById('setupTel')       && document.getElementById('setupTel').value.trim())       || '',
    password:  (document.getElementById('setupPassword')  && document.getElementById('setupPassword').value)        || '',
  };
}

async function doRegister() {
  try {
    const d = JSON.parse(localStorage.getItem('station_data') || '{}');
    await safeInvoke('telemetry_register', {
      uuid:      uuid,
      brand:     (state.brand && state.brand.brandId) || '',
      version:   VERSION,
      stationId: (state.brand && state.brand.streamUrl) || '',
      name:      d.insegna || '',
      password:  d.password || '',
      insegna:   d.insegna  || '',
      via:       d.via      || '',
      citta:     d.citta    || '',
      referente: d.referente|| '',
      email:     d.email    || '',
      telefono:  d.telefono || '',
    });
    document.getElementById('teleStatusDot').className     = 'status-dot playing';
    document.getElementById('teleStatusLabel').textContent = 'registrato · '+d.insegna;
    log('[TELE_REGISTER] ok insegna='+d.insegna);
    diag('APP_START', { audioState: 'stopped' });
  } catch (e) {
    document.getElementById('teleStatusDot').className     = 'status-dot error';
    document.getElementById('teleStatusLabel').textContent = 'non registrato';
    log('[TELE_REGISTER_ERR] '+e);
  }
}

async function checkFirstRun() {
  if (localStorage.getItem('station_data')) return;
  const modal = document.getElementById('setupModal');
  if (!modal) return;
  try {
    const info = await safeInvoke('get_system_info');
    if (info) {
      const el = document.getElementById('setupHostInfo');
      if (el) el.textContent = (info.hostname||'') + ' · ' + (info.mac||'') + ' · ' + (info.os||'');
    }
  } catch(e) {}
  modal.hidden = false;
  return new Promise(resolve => {
    document.getElementById('btnSetupSave').addEventListener('click', async () => {
      const d = getSetupData();
      const errEl = document.getElementById('setupError');
      // Validazione campi obbligatori
      if (!d.insegna || !d.referente || !d.email || !d.password) {
        errEl.textContent = 'Compila tutti i campi obbligatori (*)';
        errEl.style.display = 'block';
        return;
      }
      const btn = document.getElementById('btnSetupSave');
      btn.textContent = 'Verifica in corso…'; btn.disabled = true;
      errEl.style.display = 'none';
      try {
        // Tenta registrazione — il Rust verifica la password lato server
        await safeInvoke('telemetry_register', {
          uuid:      uuid,
          brand:     (state.brand && state.brand.brandId) || '',
          version:   VERSION,
          stationId: (state.brand && state.brand.streamUrl) || '',
          name:      d.insegna,
          password:  d.password,
          insegna:   d.insegna,
          via:       d.via,
          citta:     d.citta,
          referente: d.referente,
          email:     d.email,
          telefono:  d.telefono,
        });
        // Salva solo se il server accetta
        localStorage.setItem('station_data', JSON.stringify(d));
        document.getElementById('teleStatusDot').className     = 'status-dot playing';
        document.getElementById('teleStatusLabel').textContent = 'registrato · '+d.insegna;
        log('[TELE_REGISTER] ok insegna='+d.insegna);
        diag('APP_START', { audioState: 'stopped' });
        modal.hidden = true;
        resolve();
      } catch(e) {
        errEl.textContent = String(e).replace('Error: ','');
        errEl.style.display = 'block';
        btn.textContent = 'Registra'; btn.disabled = false;
      }
    });
  });
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

// ── Watchdog / resilienza ─────────────────────────────────────────────────────
let _watchdogTimer    = null;
let _reconnectAttempt = 0;
let _stallStartedAt   = 0;
let _playRequestedAt  = 0;
let _playStartedAt    = 0;
let _lastTrackAt      = 0;

function _watchdogDelay(n) { return Math.min(40000, 5000 * Math.pow(2, n)); }

function startWatchdog(reason) {
  clearWatchdog();
  if (!_stallStartedAt) _stallStartedAt = Date.now();
  const delay = _watchdogDelay(_reconnectAttempt);
  log('[WATCHDOG] '+reason+' delay='+Math.round(delay/1000)+'s attempt='+_reconnectAttempt);
  _watchdogTimer = setTimeout(() => {
    _watchdogTimer = null;
    if (!state.playing) return;
    const stallMs = Date.now() - _stallStartedAt;
    log('[RECONNECT] stall_ms='+stallMs+' attempt='+_reconnectAttempt+' reason='+reason);
    diag('RECONNECT', { audioState:'buffering', issueType:'watchdog_reconnect',
      issueNote: reason, extra: { stall_ms: stallMs, attempt: _reconnectAttempt } });
    _reconnectAttempt++;
    play();
  }, delay);
}

function clearWatchdog() {
  if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
  _stallStartedAt = 0;
}

// ── Neon pulse cover — colore via setInterval, respiro via CSS @keyframes ────
let _neonInterval = null;
let _neonPhase    = 0;

function startNeon() {
  if (_neonInterval) return;
  const colors = (state.brandColors && state.brandColors.length > 0)
    ? state.brandColors : ['#29ABE2'];
  _neonPhase = 0;
  const cw = document.getElementById('coverWrap');
  if (cw) cw.style.setProperty('--neon-color', colors[0]);
  _neonInterval = setInterval(() => {
    _neonPhase = (_neonPhase + 1) % colors.length;
    const cw2 = document.getElementById('coverWrap');
    if (cw2) cw2.style.setProperty('--neon-color', colors[_neonPhase]);
  }, 4000);
}

function stopNeon() {
  if (_neonInterval) { clearInterval(_neonInterval); _neonInterval = null; }
  const cw = document.getElementById('coverWrap');
  if (cw) cw.style.removeProperty('--neon-color');
}

// ── Equalizer Web Audio ───────────────────────────────────────────────────────
let audioCtx   = null;
let analyser   = null;
let eqRunning  = false;
let smoothBars = null;
let eqInited   = false;

function initEq() {
  if (eqInited) return !!analyser;
  eqInited = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(audio);
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize              = 128; // 64 bin
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    smoothBars = new Float32Array(analyser.frequencyBinCount).fill(0);

    // Dimensiona il canvas a risoluzione corretta (Retina)
    const canvas = document.getElementById('eqCanvas');
    const dpr    = window.devicePixelRatio || 1;
    const W = 300; const H = 44;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    canvas.getContext('2d').scale(dpr, dpr);

    log('[EQ_INIT] ok bin='+analyser.frequencyBinCount+' dpr='+dpr);
    return true;
  } catch (e) {
    log('[EQ_INIT_ERR] '+e.message);
    analyser = null;
    return false;
  }
}

function startEq() {
  if (eqRunning) return;
  if (!initEq()) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  _eqZeroFrames = 0;
  eqRunning = true;
  drawEq();
  log('[EQ_START]');
}

function stopEq() {
  if (!eqRunning) return;
  eqRunning = false;
  fadeOutEq();
}

function fadeOutEq() {
  const canvas = document.getElementById('eqCanvas');
  if (!canvas || !smoothBars) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx  = canvas.getContext('2d');
  const W = 300; const H = 44;
  function step() {
    if (eqRunning) return;
    let any = false;
    for (let i = 0; i < smoothBars.length; i++) {
      smoothBars[i] *= 0.88;
      if (smoothBars[i] > 0.005) any = true;
    }
    ctx.clearRect(0, 0, W, H);
    renderEqBars(ctx, W, H);
    if (any) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, W, H);
  }
  requestAnimationFrame(step);
}

let _eqZeroFrames = 0; // conta frame con analyser tutti zero → fallback simulato

function _fakeEqData(out) {
  // Visualizzatore simulato: onde sinusoidali sfasate per ogni banda
  const t = performance.now() / 1000;
  for (let i = 0; i < out.length; i++) {
    const base = 0.18 + 0.30 * Math.exp(-i / (out.length * 0.4)); // enfasi sui bassi
    const wave = Math.sin(t * (1.2 + i * 0.15) + i * 0.7) * 0.5 + 0.5;
    const noise = Math.random() * 0.12;
    out[i] = Math.min(1, Math.max(0, base * wave + noise)) * 255;
  }
}

function drawEq() {
  if (!eqRunning || !analyser) return;
  const canvas = document.getElementById('eqCanvas');
  if (!canvas) { eqRunning = false; return; }
  const ctx = canvas.getContext('2d');
  const W = 300; const H = 44;

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  // Se l'analyser ritorna tutti zero per troppi frame (WKWebView non espone lo stream
  // radio al pipeline Web Audio), usa un visualizzatore simulato
  const allZero = data.every(v => v === 0);
  if (allZero) {
    _eqZeroFrames++;
    if (_eqZeroFrames > 60) _fakeEqData(data); // dopo ~1s usa fake
  } else {
    _eqZeroFrames = 0;
  }

  const LERP_UP = 0.45; const LERP_DN = 0.14;
  for (let i = 0; i < smoothBars.length; i++) {
    const t = data[i] / 255;
    smoothBars[i] += (t - smoothBars[i]) * (t > smoothBars[i] ? LERP_UP : LERP_DN);
  }

  ctx.clearRect(0, 0, W, H);
  renderEqBars(ctx, W, H);
  requestAnimationFrame(drawEq);
}

function renderEqBars(ctx, W, H) {
  if (!smoothBars) return;
  const primary = getComputedStyle(document.documentElement)
    .getPropertyValue('--primary').trim() || '#29ABE2';

  // Usa solo i primi 2/3 dei bin (le alte frequenze sono poco significative sul radio mp3)
  const BAR_COUNT = Math.floor(smoothBars.length * 0.65);
  const GAP  = 2;
  const barW = (W - GAP * (BAR_COUNT - 1)) / BAR_COUNT;

  for (let i = 0; i < BAR_COUNT; i++) {
    const v  = smoothBars[i];
    const bH = Math.max(2, v * H);
    const x  = i * (barW + GAP);
    const y  = H - bH;

    const grad = ctx.createLinearGradient(0, y, 0, H);
    grad.addColorStop(0, primary + 'DD');
    grad.addColorStop(1, primary + '33');
    ctx.fillStyle = grad;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barW, bH, [2, 2, 0, 0]);
    else ctx.rect(x, y, barW, bH);
    ctx.fill();
  }
}

// ── Audio events ──────────────────────────────────────────────────────────────
function wireAudioEvents() {
  const coverWrap = document.getElementById('coverWrap');
  const setCoverPlaying = v => coverWrap && coverWrap.classList.toggle('playing', v);

  audio.addEventListener('playing', () => {
    const wasErr = state.audioPhase==='error' || state.audioPhase==='stall';
    const bufMs  = _playRequestedAt > 0 ? Date.now() - _playRequestedAt : null;
    clearWatchdog();
    _reconnectAttempt = 0;
    if (!_playStartedAt) _playStartedAt = Date.now();
    state.audioPhase = 'playing';
    setStatus('playing','IN RIPRODUZIONE');
    const ev    = wasErr ? 'AUDIO_RECOVERED' : 'PLAY_START_OK';
    const extra = bufMs !== null ? { buffer_time_ms: bufMs } : null;
    log('['+ev+'] buf='+bufMs+'ms'); diag(ev, { audioState:'playing', extra });
    setCoverPlaying(true); startNeon();
  });
  audio.addEventListener('waiting', () => {
    state.audioPhase = 'buffering'; setStatus('buffering','BUFFERING...');
    log('[BUFFERING]'); diag('BUFFERING', { audioState:'buffering', issueType:'rebuffer' });
    setCoverPlaying(false); stopNeon();
    startWatchdog('rebuffer');
  });
  audio.addEventListener('stalled', () => {
    state.audioPhase = 'stall'; log('[AUDIO_STALL]'); setCoverPlaying(false); stopNeon();
    diag('AUDIO_STALL', { audioState:'error', issueType:'stall',
      issueNote:'rs='+audio.readyState+' ns='+audio.networkState });
    startWatchdog('stall');
  });
  audio.addEventListener('error', () => {
    state.audioPhase = 'error'; setCoverPlaying(false); stopNeon();
    const code = audio.error && audio.error.code;
    const msg  = (audio.error && audio.error.message) || 'unknown';
    setStatus('error','ERRORE STREAM'); log('[AUDIO_ERROR] code='+code+' '+msg);
    diag('AUDIO_ERROR', { audioState:'error', issueType:'media_error_'+code, issueNote:msg });
    startWatchdog('audio_error');
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
    const uptime = _playStartedAt > 0 ? Math.round((Date.now()-_playStartedAt)/60000) : 0;
    safeInvoke('send_event', { event:'HEARTBEAT', audioState:getAudioState(),
      issueType:null, issueNote:null,
      extra: uptime > 0 ? { uptime_min: uptime } : null }).catch(()=>{});
    // Silenzio prolungato: playing ma nessun cambio brano da >20min
    if (state.playing && state.audioPhase==='playing' && _lastTrackAt > 0 &&
        (Date.now()-_lastTrackAt) > 20*60*1000) {
      const silMin = Math.round((Date.now()-_lastTrackAt)/60000);
      diag('LONG_SILENCE', { audioState:'playing', issueType:'no_track_change',
        issueNote:'silent_for_'+silMin+'min', extra:{ silence_ms: Date.now()-_lastTrackAt } });
    }
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
  const healthModal = document.getElementById('healthModal');
  const healthResult = document.getElementById('healthResult');
  document.getElementById('btnTeleHealth').addEventListener('click', async () => {
    healthResult.textContent = '…';
    healthModal.hidden = false;
    try {
      const res = await safeInvoke('telemetry_health');
      healthResult.textContent = 'HTTP '+res.status+'\n\n'+(res.body||'');
    } catch (e) { healthResult.textContent = String(e); }
  });
  document.getElementById('btnHealthModalClose').addEventListener('click', () => {
    healthModal.hidden = true;
  });
  document.getElementById('btnShowLog').addEventListener('click', () => { settingsPanel.hidden=true; logPanel.hidden=false; });
  document.getElementById('btnLogClose').addEventListener('click', () => { logPanel.hidden=true; });
  document.getElementById('btnCopyLog').addEventListener('click', copyLog);
  document.getElementById('btnCopyLogInPanel').addEventListener('click', copyLog);
  document.getElementById('installedVersion').textContent = VERSION;
  document.getElementById('playerUuid').textContent       = uuid;

  // ICY delay slider
  const icySlider = document.getElementById('icyDelaySlider');
  const icyLabel  = document.getElementById('icyDelayLabel');
  if (icySlider) {
    icySlider.value = ICY_DELAY_MS / 1000;
    icyLabel.textContent = (ICY_DELAY_MS/1000)+'s';
    icySlider.addEventListener('input', e => {
      ICY_DELAY_MS = parseInt(e.target.value) * 1000;
      icyLabel.textContent = e.target.value+'s';
      localStorage.setItem('icy_delay_ms', String(ICY_DELAY_MS));
    });
  }

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
          _lastTrackAt = Date.now();
          document.getElementById('trackTitle').textContent  = title  || 'ON AIR';
          document.getElementById('trackArtist').textContent = artist || '';
          log('[TRACK_CHANGE] '+raw);
          const trackLabel = artist ? artist+' — '+title : title;
          diag('TRACK_CHANGE', { audioState:'playing', issueNote: trackLabel, extra:{title,artist,raw} });
          safeInvoke('send_track_change', {
            sessionId, artist: artist||null, title: title||null, rawTitle: raw||null,
          }).then(s => log('[TRACK_CHANGE_V2] HTTP='+s)).catch(()=>{});
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

  // 6. Init telemetria — AWAITED: tele.info deve essere pronto prima che partano eventi
  const _sd = JSON.parse(localStorage.getItem('station_data') || '{}');
  await safeInvoke('telemetry_init', {
    uuid:      uuid,
    brand:     brand.brandId,
    version:   VERSION,
    stationId: brand.streamUrl || '',
    name:      _sd.insegna || '',
  }).catch(e => log('[TELE_INIT_ERR] '+e));
  await safeInvoke('set_session_id', { sessionId }).catch(()=>{});
  diag('APP_START', { audioState: 'stopped' });

  // 7. Setup primo avvio (se non configurato) poi registrazione completa
  await checkFirstRun();
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
