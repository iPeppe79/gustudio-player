import { invoke }           from '@tauri-apps/api/core';
import { convertFileSrc }   from '@tauri-apps/api/core';
import { listen }           from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/* global __BRAND__, __BUILD_MODE__, __BUILD_COMMIT__ */
const COMPILED_BRAND = __BRAND__;
const IS_DEV_BUILD   = __BUILD_MODE__ === 'dev';
const VERSION      = '0.1.0';
const BUILD_COMMIT = __BUILD_COMMIT__ || '';
const BUILD_LABEL  = VERSION + (BUILD_COMMIT ? ' #' + BUILD_COMMIT : '');
const DEFAULT_ICY_DELAY_MS = 4000;
let   ICY_DELAY_MS = parseInt(localStorage.getItem('icy_delay_ms') || String(DEFAULT_ICY_DELAY_MS), 10);
if (ICY_DELAY_MS === 18000) {
  ICY_DELAY_MS = DEFAULT_ICY_DELAY_MS;
  localStorage.setItem('icy_delay_ms', String(ICY_DELAY_MS));
}
// ICY delay dinamico: si allinea alla profondità reale di cache mpv (demuxer-cache-duration).
// Il titolo ICY è quasi-live, l'audio è indietro ≈ cache → ritardo il titolo di quel tanto.
// Se in auto usa la cache; altrimenti il valore manuale (default DEFAULT_ICY_DELAY_MS).
let   _icyAutoDelay = localStorage.getItem('icy_manual') !== '1';
let   _mpvCacheMs   = 0;   // ultima profondità cache (ms) da mpv-stats
let   _mpvStats     = {};  // ultimo snapshot mpv (cache_secs, reconnects, last_warn, ...)

function effectiveIcyDelay() {
  if (_icyAutoDelay && _mpvCacheMs > 0) {
    return Math.min(15000, Math.max(2000, Math.round(_mpvCacheMs)));
  }
  return ICY_DELAY_MS;
}

// Sono dentro la webview Tauri solo se __TAURI_INTERNALS__ esiste
const IS_TAURI = typeof window.__TAURI_INTERNALS__ !== 'undefined';

const uuid      = (() => {
  let id = localStorage.getItem('player_uuid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('player_uuid', id); }
  return id;
})();
const sessionId = crypto.randomUUID(); // nuovo ad ogni avvio

const brandFallbacks = JSON.parse(localStorage.getItem('brandFallbacks') || '{}');

// Estrae il mount name dall'URL stream (es. "funsidelatina" da "https://.../funsidelatina")
function streamToStationId(url) {
  try { return new URL(url).pathname.replace(/^\//, '').split('/')[0] || url; }
  catch { return url; }
}

// Rileva spot/jingle — allineato alla logica del vecchio player .NET (NowPlayingService.IsNonMusical)
const _SPOT_KEYWORDS = ['spot','meteo','news','promo','pubblicità','jingle','liner','rubrica',
  'professione casa','funside','gustracks','multiradio','multi radio','ident','stacco'];
// Fix caratteri Latin-1 mal decodificati dall'ICY metadata
function fixEncoding(s) {
  if (!s) return s;
  try {
    // Prova a interpretare la stringa come Latin-1 recodificata in UTF-8
    const bytes = new Uint8Array(s.split('').map(c => c.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    return s;
  }
}

function isSpot(title, artist, raw) {
  const combined = ((title||'')+' '+(artist||'')+' '+(raw||'')).toLowerCase();
  if (_SPOT_KEYWORDS.some(kw => combined.includes(kw))) return true;
  if (!artist && (title||'').length < 20) return true;
  return false;
}

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

// ── Audio (motore mpv nel backend Rust) ───────────────────────────────────────
// Nessun tag <audio>: play/stop/volume passano da invoke() → mpv.rs.
const DEFAULT_MPV_VOLUME = 0.35;
let _mpvVolume = DEFAULT_MPV_VOLUME; // 0..1 in UI, convertito a 0..100 per mpv
let _mpvWasPlaying = false;   // primo 'playing' = PLAY_START_OK, successivi = AUDIO_RECOVERED

function getAudioState() {
  if (!state.playing) return 'stopped';
  switch (state.audioPhase) {
    case 'playing':   return 'playing';
    case 'buffering':
    case 'silent':    return 'buffering';
    case 'error':     return 'error';
    default:          return 'buffering';
  }
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
  MPV_WARN:       30000,
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
  document.getElementById('brandLabel').textContent   = brand.brandId+'  v'+BUILD_LABEL;
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
  _mpvWasPlaying   = false;
  state.playing    = true;
  state.audioPhase = 'buffering';
  document.getElementById('btnPlay').textContent = '⏸';
  setStatus('buffering', 'BUFFERING...');
  showFallbackCover(); // mostra subito la cover fallback mentre aspettiamo ICY
  diag('PLAY_REQUEST', { audioState: 'buffering' });
  // Motore audio mpv: loadfile dello stream + avvio ramo PCM/FFT.
  safeInvoke('mpv_set_volume', { volume: Math.round(_mpvVolume * 100) }).catch(()=>{});
  safeInvoke('mpv_play', { url: state.brand.streamUrl }).then(async () => {
    try {
      const stats = await safeInvoke('mpv_stats');
      if (stats) {
        log('[MPV_PLAY_OK] alive='+stats.alive+' cache='+(stats.cache_secs ?? 0)+'s warn='+(stats.last_warn || '-'));
      }
    } catch(e) {
      log('[MPV_STATS_ERR] '+e);
    }
  }).catch(e => {
    state.playing    = false;
    state.audioPhase = 'stopped';
    document.getElementById('btnPlay').textContent = '▶';
    setStatus('error', 'ERRORE MOTORE AUDIO');
    log('[MPV_PLAY_ERR] '+e);
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
  safeInvoke('mpv_stop').catch(()=>{});
  safeInvoke('stop_icy').catch(()=>{});
  stopEq();
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

// ── Cover-blur background ─────────────────────────────────────────────────────
function setCoverBg(url) {
  const app = document.getElementById('app');
  if (!app) return;
  if (url) {
    app.style.setProperty('--cover-bg-url', `url("${url}")`);
    app.classList.add('has-cover-bg');
  } else {
    app.style.removeProperty('--cover-bg-url');
    app.classList.remove('has-cover-bg');
  }
}

// ── Cover ─────────────────────────────────────────────────────────────────────
function showFallbackCover() {
  const img = document.getElementById('coverImg');
  const fb  = document.getElementById('coverFallback');
  // 1. Fallback da disco (scelto dall'utente via UI)
  const fp = brandFallbacks[state.brand && state.brand.brandId];
  if (fp && IS_TAURI) {
    img.onload  = () => { img.hidden=false; fb.style.display='none'; setCoverBg(img.src); };
    img.onerror = () => { tryBrandFallbackCover(img, fb); };
    img.src = convertFileSrc(fp); return;
  }
  // 2. Fallback bundled nel brand JSON (es. /funside-cover.png)
  tryBrandFallbackCover(img, fb);
}

function tryBrandFallbackCover(img, fb) {
  const bundled = state.brand && state.brand.fallbackCover;
  if (bundled) {
    img.onload  = () => { img.hidden=false; fb.style.display='none'; setCoverBg(img.src); };
    img.onerror = () => { img.hidden=true;  fb.style.display=''; setCoverBg(null); };
    img.src = bundled; return;
  }
  img.hidden=true; fb.style.display=''; setCoverBg(null);
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
    img.onload  = () => { img.hidden=false; fb.style.display='none'; setCoverBg(url); };
    img.onerror = () => { showFallbackCover(); };
    img.src = url;
  } catch (e) { log('[ARTWORK_ERR] '+e); showFallbackCover(); }
}

// ── Telemetria ────────────────────────────────────────────────────────────────
// Brand B2C (community): setup con dati utente + consensi, password hardcodata, dati alla lista community.
function isConsumer() { return !!(state.brand && state.brand.consumerMode); }
const POLICY_VERSION = 'v1-2026-07';

function _val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { const e = document.getElementById(id); return !!(e && e.checked); }

function getSetupData() {
  if (isConsumer()) {
    const nome = _val('setupNome'), cognome = _val('setupCognome');
    const full = (nome + ' ' + cognome).trim();
    return {
      // registrazione DISPOSITIVO (minima: solo identificazione installazione)
      insegna: full, referente: '', via: '', citta: '', email: '', telefono: '',
      password: (state.brand && state.brand.registerPassword) || '',
      // dati COMMUNITY (destinazione B) + consensi
      consumer: true,
      community: {
        nome, cognome,
        whatsapp:  _val('setupWhatsapp'),
        email:     _val('setupEmail'),
        indirizzo: _val('setupIndirizzo'),
        citta:     _val('setupCitta'),
        cap:       _val('setupCap'),
        provincia: _val('setupProvincia'),
        privacyConsent:   _chk('setupPrivacy'),
        marketingConsent: _chk('setupMarketing'),
      },
    };
  }
  return {
    insegna:   _val('setupInsegna'),
    via:       _val('setupVia'),
    citta:     _val('setupCitta'),
    referente: _val('setupReferente'),
    email:     _val('setupEmail'),
    telefono:  _val('setupTel'),
    password:  (document.getElementById('setupPassword') && document.getElementById('setupPassword').value) || '',
  };
}

// Testo informativa (mostrato in un piccolo modal in-app)
const PRIVACY_INFORMATIVA =
  'I dati inseriti nel presente modulo saranno trattati da ROMANTICA RADIO®, marchio identificativo delle trasmissioni editato in licensing da MG MEDIA COMPANY & PARTNERS soc. coop., per finalità connesse alla gestione della community, all’invio di aggiornamenti, comunicazioni informative, iniziative dedicate ed eventuali gadget o materiali promozionali.\n\n'
  + 'Il trattamento avverrà nel rispetto del Regolamento UE 2016/679 — GDPR — e della normativa applicabile in materia di protezione dei dati personali. I dati saranno trattati con strumenti informatici e organizzativi idonei a garantirne sicurezza, riservatezza e corretto utilizzo.\n\n'
  + 'Con l’invio del modulo, l’utente dichiara di aver letto l’informativa privacy e acconsente al trattamento dei dati per le finalità indicate.';

function showPrivacyModal() {
  let ov = document.getElementById('privacyModal');
  if (ov) { ov.hidden = false; return; }
  ov = document.createElement('div');
  ov.id = 'privacyModal';
  ov.className = 'modal-overlay';
  ov.style.zIndex = '60';
  ov.innerHTML =
    '<div class="modal-box" style="width:284px;max-height:82vh">'
    + '<div class="modal-header"><span>Informativa privacy</span>'
    + '<button class="panel-close" id="btnPrivacyClose">✕</button></div>'
    + '<div class="modal-body" style="font-family:inherit;color:var(--text);font-size:11.5px;line-height:1.55;white-space:pre-wrap;padding:12px 14px">'
    + PRIVACY_INFORMATIVA.replace(/&/g,'&amp;').replace(/</g,'&lt;')
    + '</div></div>';
  document.getElementById('app').appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.hidden = true; });
  document.getElementById('btnPrivacyClose').addEventListener('click', () => { ov.hidden = true; });
}

// Sostituisce il form B2B con la CTA community (solo brand consumerMode)
function renderConsumerSetup() {
  if (!isConsumer()) return;
  const hdr = document.querySelector('#setupModal .modal-header span');
  if (hdr) hdr.textContent = '💗 Entra nella community';
  const body = document.getElementById('setupBody');
  if (!body) return;
  const cta = 'Unisciti alla community di Romantica Radio: ricevi aggiornamenti, iniziative speciali e, quando disponibili, gadget dedicati agli ascoltatori.';
  const inp = (id, ph) => '<input type="text" id="'+id+'" placeholder="'+ph+'" class="setup-input"/>';
  body.innerHTML =
    '<p style="font-size:12px;line-height:1.5;opacity:.8;margin:0 0 4px">'+cta+'</p>'
    + inp('setupNome','Nome *')
    + inp('setupCognome','Cognome *')
    + '<input type="tel" id="setupWhatsapp" placeholder="Numero WhatsApp *" class="setup-input"/>'
    + '<input type="email" id="setupEmail" placeholder="Email" class="setup-input"/>'
    + inp('setupIndirizzo','Indirizzo completo *')
    + inp('setupCitta','Città *')
    + '<div class="row-pair" style="gap:6px">'
    +   '<input type="text" id="setupCap" placeholder="CAP *" class="setup-input" style="flex:1"/>'
    +   '<input type="text" id="setupProvincia" placeholder="Provincia *" class="setup-input" style="flex:1"/>'
    + '</div>'
    + '<label style="display:flex;gap:7px;align-items:flex-start;font-size:11px;line-height:1.4;opacity:.85;margin-top:4px;cursor:pointer">'
    +   '<input type="checkbox" id="setupPrivacy" style="margin-top:2px;flex-shrink:0"/>'
    +   '<span>Ho letto l’<a href="#" id="privacyLink" style="color:var(--primary);text-decoration:underline">informativa privacy</a> e acconsento al trattamento dei miei dati per la gestione della community, l’invio di aggiornamenti, iniziative dedicate ed eventuali gadget di ROMANTICA RADIO®. *</span>'
    + '</label>'
    + '<label style="display:flex;gap:7px;align-items:flex-start;font-size:11px;line-height:1.4;opacity:.85;cursor:pointer">'
    +   '<input type="checkbox" id="setupMarketing" style="margin-top:2px;flex-shrink:0"/>'
    +   '<span>Acconsento a ricevere comunicazioni promozionali, iniziative commerciali e aggiornamenti tramite WhatsApp, SMS, email o altri strumenti di contatto indicati nel modulo.</span>'
    + '</label>'
    + '<span id="setupError" style="color:#E53E2D;font-size:10px;display:none"></span>'
    + '<button id="btnSetupSave" style="width:100%;padding:9px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;margin-top:2px">Entra nella community</button>';
  const pl = document.getElementById('privacyLink');
  if (pl) pl.addEventListener('click', e => { e.preventDefault(); showPrivacyModal(); });
}

async function doRegister() {
  try {
    const d = JSON.parse(localStorage.getItem('station_data') || '{}');
    await safeInvoke('telemetry_register', {
      uuid:      uuid,
      brand:     (state.brand && state.brand.brandId) || '',
      version:   BUILD_LABEL,
      stationId: streamToStationId((state.brand && state.brand.streamUrl) || ''),
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
  renderConsumerSetup(); // brand B2C: sostituisce il form con la CTA community
  try {
    const info = await safeInvoke('get_system_info');
    if (info) {
      const el = document.getElementById('setupHostInfo');
      if (el) el.textContent = (info.hostname||'') + ' · ' + (info.local_ip||'') + ' · ' + (info.mac||'') + ' · ' + (info.os||'');
    }
  } catch(e) {}
  modal.hidden = false;
  return new Promise(resolve => {
    document.getElementById('btnSetupSave').addEventListener('click', async () => {
      const d = getSetupData();
      const errEl = document.getElementById('setupError');
      // Validazione campi obbligatori (diversa per B2C) — la privacy BLOCCA se non spuntata
      let missing = false, errMsg = 'Compila tutti i campi obbligatori (*)';
      if (isConsumer()) {
        const c = d.community || {};
        missing = !c.nome || !c.cognome || !c.whatsapp || !c.indirizzo || !c.citta || !c.cap || !c.provincia;
        if (!missing && !c.privacyConsent) {
          missing = true;
          errMsg = 'Per continuare devi accettare l’informativa privacy.';
        }
      } else {
        missing = !d.insegna || !d.referente || !d.email || !d.password;
      }
      if (missing) {
        errEl.textContent = errMsg;
        errEl.style.display = 'block';
        return;
      }
      const btn = document.getElementById('btnSetupSave');
      btn.textContent = 'Verifica in corso…'; btn.disabled = true;
      errEl.style.display = 'none';
      try {
        // B2C: invia i dati + consensi alla lista community (destinazione B)
        if (isConsumer()) {
          const c = d.community || {};
          await safeInvoke('community_register', { payload: {
            brand:      (state.brand && state.brand.brandId) || '',
            uuid:       uuid,
            first_name: c.nome, last_name: c.cognome,
            whatsapp:   c.whatsapp, email: c.email,
            address:    c.indirizzo, city: c.citta, cap: c.cap, province: c.provincia,
            privacy_consent:   !!c.privacyConsent,
            marketing_consent: !!c.marketingConsent,
            policy_version:    POLICY_VERSION,
          }});
        }
        // Registrazione DISPOSITIVO — il Rust verifica la password lato server
        await safeInvoke('telemetry_register', {
          uuid:      uuid,
          brand:     (state.brand && state.brand.brandId) || '',
          version:   BUILD_LABEL,
          stationId: streamToStationId((state.brand && state.brand.streamUrl) || ''),
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

// ── Equalizer REALE — bande FFT calcolate in Rust (mpv PCM → rustfft) ─────────
// Il backend emette l'evento "eq-bands" con un array 0..1 per banda; qui lo
// disegniamo con smoothing e fade-out. Nessun dato finto.
let eqRunning  = false;
let smoothBars = null;             // Float32Array smussata per il rendering
let _eqBands   = new Float32Array(0); // ultimo frame ricevuto da Rust
let _eqCanvasReady = false;

function _ensureEqCanvas() {
  if (_eqCanvasReady) return true;
  const canvas = document.getElementById('eqCanvas');
  if (!canvas) return false;
  const dpr = window.devicePixelRatio || 1;
  const W = 272, H = 22;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  canvas.getContext('2d').scale(dpr, dpr);
  _eqCanvasReady = true;
  return true;
}

// Chiamata dal listener Tauri "eq-bands"
function onEqBands(bands) {
  if (!bands || !bands.length) return;
  _eqBands = bands;
  if (!smoothBars || smoothBars.length !== bands.length) {
    smoothBars = new Float32Array(bands.length).fill(0);
  }
}

function startEq() {
  if (eqRunning) return;
  if (!_ensureEqCanvas()) return;
  eqRunning = true;
  drawEq();
  log('[EQ_START] motore=mpv-fft');
}

function stopEq() {
  if (!eqRunning) return;
  eqRunning = false;
  fadeOutEq();
}

function fadeOutEq() {
  const canvas = document.getElementById('eqCanvas');
  if (!canvas || !smoothBars) return;
  const ctx = canvas.getContext('2d');
  const W = 272, H = 22;
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

function drawEq() {
  if (!eqRunning) return;
  const canvas = document.getElementById('eqCanvas');
  if (!canvas) { eqRunning = false; return; }
  const ctx = canvas.getContext('2d');
  const W = 272, H = 22;

  const bands = _eqBands;
  if (smoothBars && bands.length === smoothBars.length) {
    const LERP_UP = 0.45, LERP_DN = 0.14;
    for (let i = 0; i < smoothBars.length; i++) {
      const t = bands[i];
      smoothBars[i] += (t - smoothBars[i]) * (t > smoothBars[i] ? LERP_UP : LERP_DN);
    }
  }

  ctx.clearRect(0, 0, W, H);
  renderEqBars(ctx, W, H);
  requestAnimationFrame(drawEq);
}

// Barre colorate: equalizzatore classico. Ogni barra ha un colore lungo l'asse
// blu→giallo→rosso (colori brand funside), cima arrotondata e riflesso sotto.
const _EQ_BAR_COUNT = 22; // non troppo fitto

// Gradiente EQ pilotato dal brand: brand.eqColors = ["#hex", ...] (default funside).
function _hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec((h || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function _eqStops() {
  const hexes = (state.brand && state.brand.eqColors) || null;
  if (hexes && hexes.length >= 2) {
    const rgbs = hexes.map(_hexToRgb).filter(Boolean);
    if (rgbs.length >= 2) {
      return rgbs.map((rgb, i) => [i / (rgbs.length - 1), rgb]);
    }
  }
  return [
    [0.0, [41, 171, 226]],
    [0.5, [245, 197, 66]],
    [1.0, [229, 62, 45]],
  ];
}

// interpolazione colore lungo gli stop del brand su t∈[0,1]
function _eqColor(t) {
  const stops = _eqStops();
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const f = (t - a[0]) / (b[0] - a[0] || 1);
  const c = [0, 1, 2].map(k => Math.round(a[1][k] + (b[1][k] - a[1][k]) * f));
  return c;
}

function renderEqBars(ctx, W, H) {
  if (!smoothBars || !smoothBars.length) return;
  const src = smoothBars;
  const N = _EQ_BAR_COUNT;
  const gap = 3;
  const barW = (W - gap * (N - 1)) / N;
  const midY = H * 0.60;          // linea di base (spazio sotto per il riflesso)
  const maxUp = midY - 1;
  const maxDown = H - midY - 1;

  for (let i = 0; i < N; i++) {
    // media del gruppo di bin corrispondente
    const lo = Math.floor(i * src.length / N);
    const hi = Math.max(lo + 1, Math.floor((i + 1) * src.length / N));
    let s = 0, c = 0;
    for (let j = lo; j < hi && j < src.length; j++) { s += src[j]; c++; }
    const v = c ? s / c : 0;

    const x = i * (barW + gap);
    const bH = Math.max(2, v * maxUp);
    const t = i / (N - 1);
    const [r, g, b] = _eqColor(t);
    const r2 = Math.round(barW / 2);

    // barra principale con gradiente verticale + glow
    const grad = ctx.createLinearGradient(0, midY - bH, 0, midY);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0.55)`);
    ctx.fillStyle = grad;
    ctx.shadowColor = `rgba(${r},${g},${b},0.6)`;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, midY - bH, barW, bH, [r2, r2, 1, 1]);
    else ctx.rect(x, midY - bH, barW, bH);
    ctx.fill();

    // riflesso sotto la linea di base (più corto e sfumato)
    ctx.shadowBlur = 0;
    const rH = Math.min(maxDown, bH * 0.4);
    const refl = ctx.createLinearGradient(0, midY, 0, midY + rH);
    refl.addColorStop(0, `rgba(${r},${g},${b},0.28)`);
    refl.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = refl;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, midY + 1, barW, rH, [1, 1, r2, r2]);
    else ctx.rect(x, midY + 1, barW, rH);
    ctx.fill();
  }
}

// ── Stato motore audio mpv ─────────────────────────────────────────────────────
// Riceve le fasi digerite da mpv.rs (evento "mpv-state") e le mappa su UI +
// telemetria, mantenendo gli stessi eventi del vecchio flusso.
function setCoverPlaying(v) {
  const coverWrap = document.getElementById('coverWrap');
  if (coverWrap) coverWrap.classList.toggle('playing', v);
}

function handleMpvState(payload) {
  if (!state.playing && payload.phase !== 'idle') {
    // stop richiesto ma arrivano ancora eventi in coda: ignora
    return;
  }
  const phase = payload.phase;
  switch (phase) {
    case 'stream_open':
      log('[STREAM_OK] mpv file-loaded');
      diag('STREAM_OK', { audioState:'buffering' });
      break;
    case 'playing': {
      const wasErr = state.audioPhase==='error' || state.audioPhase==='silent';
      const bufMs  = _playRequestedAt > 0 ? Date.now() - _playRequestedAt : null;
      _reconnectAttempt = 0;
      if (!_playStartedAt) _playStartedAt = Date.now();
      state.audioPhase = 'playing';
      setStatus('playing','IN RIPRODUZIONE');
      const first = !_mpvWasPlaying;
      _mpvWasPlaying = true;
      const ev    = (first && !wasErr) ? 'PLAY_START_OK' : 'AUDIO_RECOVERED';
      const extra = bufMs !== null ? { buffer_time_ms: bufMs, cache_secs: payload.cache_secs } : null;
      log('['+ev+'] buf='+bufMs+'ms'); diag(ev, { audioState:'playing', extra });
      setCoverPlaying(true); startNeon(); startEq();
      break;
    }
    case 'buffering':
      state.audioPhase = 'buffering'; setStatus('buffering','BUFFERING...');
      log('[BUFFERING]'); diag('BUFFERING', { audioState:'buffering', issueType:'rebuffer' });
      setCoverPlaying(false); stopNeon();
      break;
    case 'silent':
      // il watchdog Rust ha rilevato stallo (core-idle bloccato)
      state.audioPhase = 'silent'; setStatus('buffering','RIAGGANCIO...');
      log('[AUDIO_STALL] '+(payload.reason||'')+' stall_ms='+(payload.stall_ms||0));
      diag('AUDIO_STALL', { audioState:'buffering', issueType:'watchdog_stall',
        issueNote:'stall_ms='+(payload.stall_ms||0) });
      setCoverPlaying(false); stopNeon();
      break;
    case 'ended':
      state.audioPhase = 'buffering'; setStatus('buffering','STREAM INTERROTTO');
      log('[STREAM_ENDED] eof'); setCoverPlaying(false); stopNeon();
      break;
    case 'error':
      state.audioPhase = 'error'; setCoverPlaying(false); stopNeon();
      setStatus('error','ERRORE STREAM'); log('[AUDIO_ERROR] '+(payload.reason||''));
      diag('AUDIO_ERROR', { audioState:'error', issueType:'mpv_error',
        issueNote:payload.reason||'unknown' });
      break;
    case 'idle':
      // stop: già gestito da stop()
      break;
  }
}

// evento watchdog: mpv riavviato dal backend
function handleMpvRestart(payload) {
  const stallMs = payload.stall_ms || 0;
  _reconnectAttempt = payload.attempt || (_reconnectAttempt + 1);
  log('[RECONNECT] mpv restart reason='+payload.reason+' attempt='+_reconnectAttempt);
  diag('RECONNECT', { audioState:'buffering', issueType:'watchdog_reconnect',
    issueNote: payload.reason, extra: { stall_ms: stallMs, attempt: _reconnectAttempt } });
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
        // mpv riapre l'output sul nuovo device ricaricando lo stream
        await new Promise(r => setTimeout(r,300));
        safeInvoke('mpv_play', { url: state.brand.streamUrl }).catch(e => {
          log('[DEVICE_CHANGE_FAIL] '+e);
          diag('AUDIO_ERROR', { audioState:'error', issueType:'device_change_recover_failed', issueNote:String(e) });
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

// Dati device + motore per il troubleshooting (allegati a HEARTBEAT/APP_START)
async function troubleshootExtra() {
  const nav = navigator || {};
  const conn = nav.connection || {};
  let mpv = {};
  try { mpv = await safeInvoke('mpv_stats') || {}; } catch(e) {}
  const scr = window.screen || {};
  return {
    app_version: BUILD_LABEL,
    audio_engine: mpv.engine || 'mpv',
    mpv_alive:  mpv.alive,
    cache_secs: mpv.cache_secs,
    reconnects: mpv.reconnects,
    last_warn:  mpv.last_warn || undefined,
    icy_delay_ms: effectiveIcyDelay(),
    icy_auto:   _icyAutoDelay,
    audio_phase: state.audioPhase,
    volume:     Math.round(_mpvVolume*100),
    net_online: navigator.onLine,
    net_type:   conn.effectiveType,
    net_downlink: conn.downlink,
    cores:      nav.hardwareConcurrency,
    device_mem: nav.deviceMemory,
    screen:     scr.width ? (scr.width+'x'+scr.height) : undefined,
    dpr:        window.devicePixelRatio,
    lang:       nav.language,
    ua:         (nav.userAgent||'').slice(0,120),
  };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(async () => {
    if (!state.brand) return;
    const uptime = _playStartedAt > 0 ? Math.round((Date.now()-_playStartedAt)/60000) : 0;
    const extra = await troubleshootExtra();
    extra.uptime_min = uptime;
    safeInvoke('send_event', { event:'HEARTBEAT', audioState:getAudioState(),
      issueType:null, issueNote:null, extra }).catch(()=>{});
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

  // 1. Wiring DOM puri (nessuna chiamata Tauri, non possono fallire)
  wireNetworkEvents();
  wireBrandDropdown();

  // 2. TUTTI i button listener prima di qualsiasi API Tauri
  document.getElementById('btnPlay').addEventListener('click', () => {
    if (state.playing) stop(); else play();
  });
  document.getElementById('btnStop').addEventListener('click', stop);
  const volSlider = document.getElementById('volSlider');
  volSlider.value = String(DEFAULT_MPV_VOLUME);
  safeInvoke('mpv_set_volume', { volume: Math.round(_mpvVolume * 100) }).catch(()=>{});
  volSlider.addEventListener('input', e => {
    _mpvVolume = parseFloat(e.target.value);
    safeInvoke('mpv_set_volume', { volume: Math.round(_mpvVolume * 100) }).catch(()=>{});
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
  document.getElementById('installedVersion').textContent = BUILD_LABEL;
  document.getElementById('playerUuid').textContent       = uuid;

  // ICY delay slider — di default AUTO (segue la cache mpv). Toccarlo passa a manuale.
  const icySlider = document.getElementById('icyDelaySlider');
  const icyLabel  = document.getElementById('icyDelayLabel');
  if (icySlider) {
    icySlider.value = ICY_DELAY_MS / 1000;
    icyLabel.textContent = _icyAutoDelay ? 'auto' : (ICY_DELAY_MS/1000)+'s';
    icySlider.addEventListener('input', e => {
      ICY_DELAY_MS = parseInt(e.target.value) * 1000;
      _icyAutoDelay = false;
      localStorage.setItem('icy_manual', '1');
      icyLabel.textContent = e.target.value+'s';
      localStorage.setItem('icy_delay_ms', String(ICY_DELAY_MS));
    });
  }

  log('[INIT] button listeners ok');

  // 3. Tauri window API — in blocco separato, non blocca il flusso se fallisce
  if (IS_TAURI) {
    try {
      const win = getCurrentWindow();
      try {
        await win.setBackgroundColor([0, 0, 0, 0]);
        await getCurrentWebview().setBackgroundColor([0, 0, 0, 0]);
        log('[INIT] transparent window/webview background ok');
      } catch (e) {
        log('[INIT] transparent background API non disponibile: '+e);
      }
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

    // 4a. mpv listeners (stato motore audio, watchdog, visualizer FFT)
    try {
      await listen('mpv-state',   ev => handleMpvState(ev.payload || {}));
      await listen('mpv-restart', ev => handleMpvRestart(ev.payload || {}));
      await listen('mpv-ready',   () => log('[MPV_READY] motore audio connesso'));
      await listen('eq-bands',    ev => onEqBands((ev.payload && ev.payload.bands) || []));
      await listen('mpv-stats',   ev => {
        const s = ev.payload || {};
        if (typeof s.cache_secs === 'number') _mpvCacheMs = s.cache_secs * 1000;
        _mpvStats.cache_secs = s.cache_secs;
        _mpvStats.reconnects = s.reconnects;
        // aggiorna label slider ICY se in auto
        if (_icyAutoDelay) {
          const lbl = document.getElementById('icyDelayLabel');
          if (lbl) lbl.textContent = 'auto ' + (effectiveIcyDelay()/1000).toFixed(0) + 's';
        }
      });
      await listen('mpv-warn',    ev => {
        const line = (ev.payload && ev.payload.line) || '';
        if (!line) return;
        log('[MPV_WARN] '+line);
        _mpvStats.last_warn = line;
        // inoltra a telemetria solo i warning che contano (throttle in diag)
        if (/error|fail|timeout|reconnect|underrun|refused|unavailable|cannot/i.test(line)) {
          diag('MPV_WARN', { audioState:getAudioState(), issueType:'mpv_stderr', issueNote: line.slice(0,180) });
        }
      });
      log('[INIT] mpv listeners ok');
      await safeInvoke('mpv_init').catch(e => log('[MPV_INIT_ERR] '+e));
      const stats = await safeInvoke('mpv_stats').catch(() => null);
      if (stats) log('[MPV_STATS] alive='+stats.alive+' cache='+(stats.cache_secs ?? 0)+'s warn='+(stats.last_warn || '-'));
    } catch (e) { log('[INIT] mpv listen fallito: '+e); }

    // 4b. ICY listeners
    try {
      await listen('icy-stream', ev => {
        const type = ev.payload.type;
        log('[ICY_STREAM] '+type);
        const m = {STREAM_HEADERS:'buffering',STREAM_FIRST_BYTE:'buffering',STREAM_OK:'playing'};
        diag(type, { audioState: m[type] || getAudioState() });
      });
      await listen('icy-meta', ev => {
        const { raw } = ev.payload;
        const title  = fixEncoding(ev.payload.title);
        const artist = fixEncoding(ev.payload.artist);
        log('[ICY_RAW] '+raw);
        setTimeout(() => {
          if (!state.playing || title===state.currentTitle) return;
          state.currentTitle=title; state.currentArtist=artist;
          _lastTrackAt = Date.now();
          document.getElementById('trackTitle').textContent  = title  || 'ON AIR';
          document.getElementById('trackArtist').textContent = artist || '';
          const spot = isSpot(title, artist, raw);
          log('[TRACK_CHANGE] '+(spot?'[SPOT] ':'')+raw);
          const trackLabel = artist ? artist+' — '+title : title;
          diag('TRACK_CHANGE', { audioState:'playing', issueNote: trackLabel, extra:{title,artist,raw,is_spot:spot} });
          fetchCover(title, artist);
        }, effectiveIcyDelay());
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
    version:   BUILD_LABEL,
    stationId: streamToStationId(brand.streamUrl || ''),
    name:      _sd.insegna || '',
  }).catch(e => log('[TELE_INIT_ERR] '+e));
  await safeInvoke('set_session_id', { sessionId }).catch(()=>{});
  diag('APP_START', { audioState: 'stopped', extra: await troubleshootExtra() });

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
