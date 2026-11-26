/* Casnt PC renderer: home, pairing, settings, TikTok check and the cast viewer. */
'use strict';
const $ = (id) => document.getElementById(id);
const api = window.casnt;
let state = null;
let S = null; // settings

// =====================================================================  helpers
function greeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}`;
}
function get(key) {
  if (key === 'theme') return S.cartoonUi ? 'gold' : S.plainTheme === 'light' ? 'white' : 'dark';
  const [a, b] = key.split('.'); return b ? S[a][b] : S[a];
}
async function set(key, value) {
  S = await api.setSetting(key, value);
  state.settings = S;
  applyLook();
  renderSettings();
  renderPanel();
  onSettingChanged(key);
}
let toastTimer;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// little cartoony click sounds (no audio files needed)
let sfxCtx = null;
function blip(freq = 660, dur = 0.07) {
  if (!S || !S.sounds) return;
  try {
    sfxCtx = sfxCtx || new AudioContext();
    const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, sfxCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(freq * 1.6, sfxCtx.currentTime + dur);
    g.gain.setValueAtTime(0.12, sfxCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, sfxCtx.currentTime + dur);
    o.connect(g).connect(sfxCtx.destination);
    o.start(); o.stop(sfxCtx.currentTime + dur);
  } catch (_) { /* ignore */ }
}
document.addEventListener('click', (e) => { if (e.target.closest('button')) blip(); }, true);

function applyLook() {
  document.body.classList.toggle('plain', !S.cartoonUi);
  document.body.classList.toggle('theme-dark', !S.cartoonUi && S.plainTheme !== 'light');
  document.body.classList.toggle('theme-light', !S.cartoonUi && S.plainTheme === 'light');
  document.body.classList.toggle('noanim', !S.animations);
  $('greet').textContent = S.showGreeting ? greeting(state.pcName) : 'Casnt';
  $('pcname').textContent = `This PC shows up on your Quest as “${state.pcName}”.`;
  $('qualitynow').textContent = `Quality: ${qualityLabel()}`;
}

function qualityLabel() {
  if (S.quality === 'good') return S.goodMode === 'max' ? 'Good (Max)' : 'Good (1440p)';
  if (S.quality === 'custom') return `Custom (${S.custom.height}p ${S.custom.fps} fps)`;
  return { potato: 'Potato', medium: 'Medium' }[S.quality] || 'Good';
}

// =====================================================================  navigation
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.nav-btn').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('show', s.id === b.dataset.go));
}));

// =====================================================================  pairing code + devices
let codeExpires = 0;
function showCode(code, expires) {
  $('code').innerHTML = code.split('').map((d) => `<span>${d}</span>`).join('');
  codeExpires = expires;
}
setInterval(() => {
  const s = Math.max(0, Math.round((codeExpires - Date.now()) / 1000));
  $('codetimer').textContent = `New code in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}, 500);
$('newcode').onclick = async () => { const c = await api.newCode(); showCode(c.code, c.expires); };
api.on('code', (c) => showCode(c.code, c.expires));

function renderDevices(list) {
  const ul = $('devices');
  if (!list.length) { ul.innerHTML = '<li class="empty">No Quests paired yet.</li>'; return; }
  ul.innerHTML = '';
  for (const d of list) {
    const li = document.createElement('li');
    const seen = d.lastSeen ? `last seen ${new Date(d.lastSeen).toLocaleString()}` : `paired ${new Date(d.pairedAt).toLocaleDateString()}`;
    li.innerHTML = '<span style="font-size:26px">🥽</span><div class="grow"><div class="dname"></div><div class="dmeta"></div></div>';
    li.querySelector('.dname').textContent = `${d.name} · ${d.model}`;
    li.querySelector('.dmeta').textContent = seen;
    const b = document.createElement('button');
    b.className = 'btn small dark'; b.textContent = 'Forget';
    b.onclick = async () => renderDevices(await api.forgetDevice(d.deviceId));
    li.appendChild(b);
    ul.appendChild(li);
  }
}
api.on('devices', renderDevices);
api.on('paired', (d) => toast(`Paired with ${d.name}'s ${d.model}${d.via === 'usb' ? ' over USB' : ''}!`));

// =====================================================================  settings schema
// type: toggle | select | seg | slider | folder | info | action
const SECTIONS = [
  { id: 'look', title: 'Look', items: [
    { key: 'showGreeting', type: 'toggle', label: 'Show greeting', sub: '"Good evening, PC name" on the home screen' },
    { key: 'theme', type: 'seg', label: 'Theme', sub: 'Gold is the cartoony Casnt look', options: [['gold', 'Gold'], ['dark', 'Dark'], ['white', 'White']] },
    { key: 'animations', type: 'toggle', label: 'Animations', sub: 'Bouncy buttons and pop-ins' },
    { key: 'sounds', type: 'toggle', label: 'Sound effects', sub: 'Little blips on buttons and a ding on cast requests' },
  ] },
  { id: 'quality', title: 'Cast quality', items: [
    { key: 'quality', type: 'seg', label: 'Quality', sub: 'Higher quality uses more Quest battery and Wi-Fi', options: [['potato', 'Potato'], ['medium', 'Medium'], ['good', 'Good'], ['custom', 'Custom']], panel: true },
    { key: 'goodMode', type: 'seg', label: 'Good mode', sub: 'Set resolution caps at 1440p. Max uses everything the Quest can do (4K, heavy).', options: [['set', 'Set resolution'], ['max', 'Max']], showIf: () => S.quality === 'good', panel: true },
    { key: 'custom.height', type: 'select', label: 'Custom resolution', options: [[480, '480p'], [720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K (2160p)']], showIf: () => S.quality === 'custom', panel: true, num: true },
    { key: 'custom.fps', type: 'select', label: 'Custom frame rate', options: [[30, '30 fps'], [60, '60 fps'], [72, '72 fps'], [90, '90 fps']], showIf: () => S.quality === 'custom', panel: true, num: true },
    { key: 'custom.mbps', type: 'slider', label: 'Custom bitrate', min: 1, max: 80, step: 1, unit: ' Mbps', showIf: () => S.quality === 'custom', panel: true },
  ] },
  { id: 'view', title: 'View', items: [
    { key: 'fov', type: 'slider', label: 'FOV', sub: 'How much of your Quest view is shown. Lower = zoomed in.', min: 50, max: 100, step: 1, unit: '%', panel: true },
    { key: 'smoothness', type: 'slider', label: 'Smoothness', sub: 'Steadies head shake like a camera stabilizer. Higher = smoother (zooms in a little).', min: 0, max: 100, step: 1, unit: '%', panel: true },
    { key: 'startFullscreen', type: 'toggle', label: 'Start casts in fullscreen' },
    { key: 'alwaysOnTop', type: 'toggle', label: 'Keep the cast window on top' },
    { key: 'showCastPanel', type: 'toggle', label: 'Settings panel next to the cast', sub: 'Shown when the cast is not fullscreen' },
  ] },
  { id: 'audio', title: 'Audio', items: [
    { key: 'gameVolume', type: 'slider', label: 'Game audio volume', min: 0, max: 200, step: 5, unit: '%', panel: true },
    { key: 'micVolume', type: 'slider', label: 'Quest mic volume', min: 0, max: 200, step: 5, unit: '%', panel: true },
  ] },
  { id: 'stats', title: 'Stats', items: [
    { key: 'stats.battery', type: 'toggle', label: 'Quest battery', panel: true },
    { key: 'stats.ping', type: 'toggle', label: 'Ping', panel: true },
    { key: 'stats.fps', type: 'toggle', label: 'FPS', panel: true },
    { key: 'stats.bitrate', type: 'toggle', label: 'Bitrate', panel: true },
    { key: 'statsCorner', type: 'select', label: 'Stats position', options: [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']] },
  ] },
  { id: 'connect', title: 'Connecting', items: [
    { key: 'usbInstantConnect', type: 'toggle', label: 'USB instant connect', sub: 'Quest plugged in by USB? Skip the code and connect straight away.' },
    { key: 'autoAccept', type: 'toggle', label: 'Auto-accept casts', sub: 'Paired Quests start casting without the "Do you accept?" popup' },
    { key: 'popupPosition', type: 'select', label: 'Cast request popup', options: [['bottom-right', 'Bottom right'], ['top-right', 'Top right'], ['center', 'Middle of the screen']] },
    { key: 'requestTimeout', type: 'select', label: 'Auto-decline after', num: true, options: [[30, '30 seconds'], [60, '1 minute'], [120, '2 minutes']] },
    { key: 'startWithWindows', type: 'toggle', label: 'Start with Windows', sub: 'Keeps Casnt in the tray so your Quest can cast any time' },
  ] },
  { id: 'recording', title: 'Recording', items: [
    { key: 'recordFolder', type: 'folder', label: 'Save recordings to' },
    { key: 'recordAudio', type: 'toggle', label: 'Record audio', sub: 'Game audio + Quest mic, at your volume settings' },
  ] },
  { id: 'updates', title: 'Updates', items: [
    { key: 'autoUpdate', type: 'toggle', label: 'Check for updates automatically', sub: 'Looks on the Casnt GitHub releases when Casnt starts' },
    { type: 'action', label: 'PC app', sub: () => updateText(), button: 'Check now', run: () => api.updateCheck() },
    { type: 'action', label: 'Quest app over USB', sub: () => questUpdateText(), button: 'Update Quest', run: () => updateQuest() },
  ] },
  { id: 'experimental', title: 'Experimental', exp: true, items: [
    { key: 'lowLatency', type: 'toggle', label: 'Low-latency mode', sub: 'Drops late frames instead of letting delay build up' },
    { key: 'hardwareDecoding', type: 'toggle', label: 'GPU decoding', sub: 'Faster on most PCs, can glitch on some drivers' },
    { type: 'info', label: 'Camera view (first / third person)', sub: 'Stays first person',
      text: 'A casting app can only show what the game draws, so it can\'t move the camera behind you in other games. Third person only works in games or mods that have their own spectator camera. Casnt can link to one of those in a later update.' },
  ] },
];

function control(item, onChange) {
  const wrap = document.createElement('div');
  const v = item.key ? get(item.key) : null;
  if (item.type === 'toggle') {
    wrap.innerHTML = '<label class="toggle"><input type="checkbox"><span></span></label>';
    const inp = wrap.querySelector('input');
    inp.checked = !!v;
    inp.onchange = () => onChange(inp.checked);
  } else if (item.type === 'seg') {
    wrap.className = 'seg';
    for (const [val, text] of item.options) {
      const b = document.createElement('button');
      b.textContent = text;
      b.classList.toggle('on', String(v) === String(val));
      b.onclick = () => onChange(val);
      wrap.appendChild(b);
    }
  } else if (item.type === 'select') {
    const sel = document.createElement('select');
    for (const [val, text] of item.options) {
      const o = document.createElement('option');
      o.value = val; o.textContent = text;
      if (String(v) === String(val)) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => onChange(item.num ? Number(sel.value) : sel.value);
    wrap.appendChild(sel);
  } else if (item.type === 'slider') {
    wrap.className = 'slider';
    wrap.innerHTML = `<input type="range" min="${item.min}" max="${item.max}" step="${item.step}"><span class="val"></span>`;
    const r = wrap.querySelector('input'), out = wrap.querySelector('.val');
    r.value = v;
    out.textContent = v + (item.unit || '');
    r.oninput = () => { out.textContent = r.value + (item.unit || ''); liveSlider(item.key, Number(r.value)); };
    r.onchange = () => onChange(Number(r.value));
  } else if (item.type === 'folder') {
    wrap.className = 'folder';
    wrap.innerHTML = '<code></code><button class="btn small dark">Change</button><button class="btn small dark">Open</button>';
    wrap.querySelector('code').textContent = S.recordFolder || state.defaultRecordFolder;
    const [change, open] = wrap.querySelectorAll('button');
    change.onclick = async () => { S.recordFolder = await api.pickRecordFolder(); renderSettings(); };
    open.onclick = () => api.openRecordings();
  } else if (item.type === 'action') {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = item.button;
    b.onclick = item.run;
    wrap.appendChild(b);
  } else if (item.type === 'info') {
    wrap.className = 'info-box';
    wrap.textContent = item.text;
  }
  return wrap;
}

function settingRow(item, onChange) {
  const row = document.createElement('div');
  row.className = 'setting';
  const sub = typeof item.sub === 'function' ? item.sub() : item.sub;
  row.innerHTML = '<div><b></b><small></small></div>';
  row.querySelector('b').textContent = item.label;
  row.querySelector('small').textContent = sub || '';
  row.appendChild(control(item, onChange));
  return row;
}

function renderSettings() {
  const body = $('settings-body'), nav = $('settings-nav');
  const scroll = document.querySelector('main').scrollTop;
  body.innerHTML = ''; nav.innerHTML = '';
  for (const sec of SECTIONS) {
    const card = document.createElement('div');
    card.className = 'card sec';
    card.id = 'sec-' + sec.id;
    card.innerHTML = `<h2>${sec.title}${sec.exp ? '<span class="exp-tag">EXPERIMENTAL</span>' : ''}</h2>`;
    for (const item of sec.items) {
      if (item.showIf && !item.showIf()) continue;
      card.appendChild(settingRow(item, (val) => set(item.key, val)));
    }
    body.appendChild(card);
    const b = document.createElement('button');
    b.textContent = sec.title;
    b.onclick = () => card.scrollIntoView({ behavior: S.animations ? 'smooth' : 'auto' });
    nav.appendChild(b);
  }
  if (window.casntSpotifyCard) {
    const sp = window.casntSpotifyCard();
    sp.id = 'sec-player';
    body.insertBefore(sp, document.getElementById('sec-updates'));
    const b = document.createElement('button');
    b.textContent = 'Cast Player';
    b.onclick = () => sp.scrollIntoView({ behavior: S.animations ? 'smooth' : 'auto' });
    nav.insertBefore(b, nav.children[7] || null);
  }
  document.querySelector('main').scrollTop = scroll;
}
$('reset').onclick = async () => {
  if (!confirm('Reset every Casnt setting back to default?')) return;
  S = await api.resetSettings(); state.settings = S;
  applyLook(); renderSettings(); renderPanel(); toast('Settings reset.');
};

// the "while casting" panel uses the same controls
function renderPanel() {
  const body = $('panel-body');
  body.innerHTML = '';
  for (const sec of SECTIONS) for (const item of sec.items) {
    if (!item.panel || (item.showIf && !item.showIf())) continue;
    body.appendChild(settingRow({ ...item, sub: '' }, (val) => set(item.key, val)));
  }
  $('cast').classList.toggle('panel', !!S.showCastPanel && !full && $('cast').classList.contains('show'));
  layoutStats();
}

// sliders apply instantly while dragging
function liveSlider(key, value) {
  if (key === 'fov' || key === 'smoothness') S[key] = value;
  if (key === 'gameVolume' || key === 'micVolume') { S[key] = value; updateGains(); }
}

function onSettingChanged(key) {
  if (key === 'gameVolume' || key === 'micVolume') updateGains();
  if (key === 'hardwareDecoding' && decoder) makeDecoder();
}

// =====================================================================  updates
let upd = { state: 'idle' };
function updateText() {
  switch (upd.state) {
    case 'checking': return 'Checking…';
    case 'none': return `You're on the newest version (${state.version}).`;
    case 'available': return `Version ${upd.version} found, downloading…`;
    case 'downloading': return `Downloading ${upd.percent || 0}%…`;
    case 'ready': return `Version ${upd.version} is ready. It installs when you quit Casnt.`;
    case 'error': return `Couldn't check: ${upd.message || 'no connection'}`;
    default: return `Version ${state.version}`;
  }
}
let questUpd = '';
function questUpdateText() { return questUpd || 'Plug your Quest in by USB to install the newest Casnt on it.'; }
async function updateQuest() {
  questUpd = 'Downloading the Quest app…'; renderSettings();
  const r = await api.updateQuest();
  questUpd = r.ok ? `Done! Casnt ${r.version} is installed on your Quest.` : `Couldn't update: ${r.message}`;
  renderSettings();
  toast(questUpd);
}
api.on('update', (u) => {
  upd = u;
  if (document.querySelector('#settings.show')) renderSettings();
  if (u.state === 'ready') toast(`Casnt ${u.version} downloaded. It installs when you quit Casnt.`, 6000);
});

// =====================================================================  cast requests
function showRequest(req) {
  $('req-text').textContent = `${req.device.model} (${req.device.name}) is trying to cast to you${req.mode === 'app' ? ' (just one app)' : ''}. Do you accept?`;
  $('request').classList.add('show');
  blip(880, 0.12); setTimeout(() => blip(1175, 0.15), 130);
}
$('req-yes').onclick = () => { $('request').classList.remove('show'); api.respondCast(true); };
$('req-no').onclick = () => { $('request').classList.remove('show'); api.respondCast(false); };
api.on('cast-request', showRequest);
api.on('cast-request-cancelled', () => $('request').classList.remove('show'));

// =====================================================================  cast viewer
const canvas = $('screen');
const ctx = canvas.getContext('2d');
let decoderErrors = [], forceSoftware = false;
let decoder = null, codec = null, needKey = true, audio = null, latest = null, full = false;
const questAudio = { game: true, mic: true };

function openCast(info) {
  $('request').classList.remove('show');
  $('castwho').textContent = `${info.device.model} · ${info.device.name}`;
  $('castspec').textContent = info.spec ? `${info.spec.height}p · ${info.spec.fps} fps` : '';
  $('castwait').style.display = '';
  $('cast').classList.add('show');
  full = !!S.startFullscreen;
  needKey = true;
  stab.reset();
  stats.reset();
  startAudio();
  renderPanel();
  showBar();
}
function closeCast() {
  stopRecording();
  $('cast').classList.remove('show', 'panel');
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null; codec = null;
  if (latest) { latest.close(); latest = null; }
  if (audio) { audio.ctx.close(); audio = null; }
  full = false;
  api.fullscreen(false);
}
api.on('cast-accepted', openCast);
api.on('cast-ended', (info) => {
  closeCast();
  if (info && info.reason === 'disconnected') toast('The Quest disconnected.');
});

function makeDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output(frame) {
      stats.frames++;
      if (latest) latest.close();
      latest = frame;
    },
    error(e) {
      console.warn('decoder error', e);
      // back off if it keeps failing, and try the other decoder mode
      decoderErrors = decoderErrors.filter((t) => Date.now() - t < 5000).concat(Date.now());
      if (decoderErrors.length >= 4) { forceSoftware = !forceSoftware; decoderErrors = []; toast('Video decoder had trouble, switching decoder mode…'); }
      needKey = true;
      setTimeout(() => { if (codec) makeDecoder(); }, 300);
    },
  });
  // No "description" => Annex B, which is what the Quest sends.
  let hw = S.hardwareDecoding ? 'prefer-hardware' : 'no-preference';
  if (forceSoftware) hw = S.hardwareDecoding ? 'no-preference' : 'prefer-software';
  decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: hw });
  needKey = true;
  api.requestKeyFrame();
}

api.on('video-config', (v) => { if (v.codec !== codec || !decoder) { codec = v.codec; makeDecoder(); } });
api.on('video', (v) => {
  stats.bytes += v.data.byteLength;
  if (!decoder || decoder.state !== 'configured') return;
  if (needKey && !v.key) return;
  needKey = false;
  if (S.lowLatency && decoder.decodeQueueSize > 6 && !v.key) { needKey = true; api.requestKeyFrame(); return; }
  decoder.decode(new EncodedVideoChunk({ type: v.key ? 'key' : 'delta', timestamp: v.pts, data: v.data }));
});

// ---------------- stabilizer ("Smoothness") ----------------
// Estimates how the whole picture moved since the last frame (head shake) using a tiny
// grayscale copy, then crops so the picture follows a smoothed path instead.
const stab = {
  SW: 160, SH: 90, R: 8,
  small: null, sctx: null, prev: null, pos: { x: 0, y: 0 }, path: { x: 0, y: 0 },
  reset() { this.prev = null; this.pos = { x: 0, y: 0 }; this.path = { x: 0, y: 0 }; },
  luma(frame) {
    if (!this.small) {
      this.small = new OffscreenCanvas(this.SW, this.SH);
      this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    }
    this.sctx.drawImage(frame, 0, 0, this.SW, this.SH);
    const d = this.sctx.getImageData(0, 0, this.SW, this.SH).data;
    const out = new Uint8Array(this.SW * this.SH);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return out;
  },
  sad(cur, prev, dx, dy) {
    const { SW, SH, R } = this;
    let sum = 0;
    for (let y = R; y < SH - R; y += 2) {
      const row = y * SW, crow = (y + dy) * SW;
      for (let x = R; x < SW - R; x += 2) sum += Math.abs(cur[crow + x + dx] - prev[row + x]);
    }
    return sum;
  },
  // returns the motion in full-resolution pixels
  estimate(frame, W, H) {
    const cur = this.luma(frame);
    const prev = this.prev;
    this.prev = cur;
    if (!prev) return { x: 0, y: 0 };
    const R = this.R;
    let best = Infinity, bx = 0, by = 0;
    const costs = new Map();
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const c = this.sad(cur, prev, dx, dy);
      costs.set(dx + ',' + dy, c);
      if (c < best) { best = c; bx = dx; by = dy; }
    }
    // sub-pixel refine with a parabola through the neighbours
    const sub = (a, b, c) => { const den = a - 2 * b + c; return den > 0 ? 0.5 * (a - c) / den : 0; };
    const cx = costs.get((bx - 1) + ',' + by), cx2 = costs.get((bx + 1) + ',' + by);
    const cy = costs.get(bx + ',' + (by - 1)), cy2 = costs.get(bx + ',' + (by + 1));
    const fx = bx + (cx !== undefined && cx2 !== undefined ? sub(cx, best, cx2) : 0);
    const fy = by + (cy !== undefined && cy2 !== undefined ? sub(cy, best, cy2) : 0);
    return { x: fx * (W / this.SW), y: fy * (H / this.SH) };
  },
};

function draw() {
  requestAnimationFrame(draw);
  const f = latest;
  if (!f) return;
  latest = null;
  const W = f.displayWidth, H = f.displayHeight;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const s = Math.max(0, Math.min(1, S.smoothness / 100));
  const z = Math.min(S.fov / 100, 1 - 0.2 * s); // fraction of the frame shown
  const w = W * z, h = H * z;
  let x = (W - w) / 2, y = (H - h) / 2;
  if (s > 0) {
    const m = stab.estimate(f, W, H);
    stab.pos.x += m.x; stab.pos.y += m.y;
    const a = 1 - 0.95 * s; // how fast the smoothed path catches up
    stab.path.x += (stab.pos.x - stab.path.x) * a;
    stab.path.y += (stab.pos.y - stab.path.y) * a;
    const mx = (W - w) / 2, my = (H - h) / 2;
    // keep the correction inside the spare border; if it hits the edge, drag the path along
    let cx = stab.pos.x - stab.path.x, cy = stab.pos.y - stab.path.y;
    if (Math.abs(cx) > mx) { stab.path.x = stab.pos.x - Math.sign(cx) * mx; cx = Math.sign(cx) * mx; }
    if (Math.abs(cy) > my) { stab.path.y = stab.pos.y - Math.sign(cy) * my; cy = Math.sign(cy) * my; }
    x += cx; y += cy;
  } else if (stab.prev) {
    stab.reset();
  }
  ctx.drawImage(f, x, y, w, h, 0, 0, W, H);
  f.close();
  $('castwait').style.display = 'none';
}
requestAnimationFrame(draw);

// ---------------- audio (PCM s16le 48 kHz) ----------------
function startAudio() {
  if (audio) return;
  const actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const rec = actx.createMediaStreamDestination();
  audio = { ctx: actx, rec, game: { gain: actx.createGain(), next: 0 }, mic: { gain: actx.createGain(), next: 0 } };
  for (const k of ['game', 'mic']) { audio[k].gain.connect(actx.destination); audio[k].gain.connect(rec); }
  updateGains();
}
function updateGains() {
  if (!audio) return;
  audio.game.gain.gain.value = S.gameVolume / 100;
  audio.mic.gain.gain.value = S.micVolume / 100;
}
api.on('audio', (a) => {
  stats.bytes += a.data.byteLength;
  if (!audio) return;
  const stream = audio[a.source];
  const bytes = a.data;
  const even = bytes.byteLength - (bytes.byteLength % 2);
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even)); // copy: offsets can be odd
  const frames = Math.floor(samples.length / a.channels);
  if (!frames) return;
  const buf = audio.ctx.createBuffer(a.channels, frames, 48000);
  for (let c = 0; c < a.channels; c++) {
    const out = buf.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] = samples[i * a.channels + c] / 32768;
  }
  const src = audio.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(stream.gain);
  const now = audio.ctx.currentTime;
  if (stream.next < now + 0.02 || stream.next > now + 0.5) stream.next = now + 0.06; // resync if drifting
  src.start(stream.next);
  stream.next += buf.duration;
});

// Quest-side audio capture on/off
function paintQuestAudio() {
  $('q-game').textContent = `🎮 Game audio: ${questAudio.game ? 'ON' : 'OFF'}`;
  $('q-mic').textContent = `🎙️ Quest mic: ${questAudio.mic ? 'ON' : 'OFF'}`;
  $('q-game').classList.toggle('off', !questAudio.game);
  $('q-mic').classList.toggle('off', !questAudio.mic);
}
$('q-game').onclick = () => { questAudio.game = !questAudio.game; paintQuestAudio(); api.setQuestAudio(questAudio); };
$('q-mic').onclick = () => { questAudio.mic = !questAudio.mic; paintQuestAudio(); api.setQuestAudio(questAudio); };

// ---------------- stats ----------------
const stats = {
  frames: 0, bytes: 0, fps: 0, kbps: 0, ping: null, battery: null, charging: false,
  reset() { this.frames = 0; this.bytes = 0; this.fps = 0; this.kbps = 0; this.ping = null; this.battery = null; },
};
setInterval(() => {
  stats.fps = stats.frames; stats.kbps = Math.round((stats.bytes * 8) / 1000);
  stats.frames = 0; stats.bytes = 0;
  layoutStats();
}, 1000);
api.on('ping', (p) => { stats.ping = p.ms; });
api.on('quest-status', (st) => {
  stats.battery = st.battery; stats.charging = st.charging;
  questAudio.game = st.game; questAudio.mic = st.mic; paintQuestAudio();
  if (st.spec) $('castspec').textContent = `${st.spec.height}p · ${st.spec.fps} fps${st.spec.preset ? ' · ' + st.spec.preset : ''}`;
});
function layoutStats() {
  const el = $('stats');
  if (!S) return;
  const lines = [];
  if (S.stats.battery) lines.push(`🔋 ${stats.battery == null ? '…' : stats.battery + '%'}${stats.charging ? ' ⚡' : ''}`);
  if (S.stats.ping) lines.push(`📶 ${stats.ping == null ? '…' : stats.ping + ' ms'}`);
  if (S.stats.fps) lines.push(`🎞️ ${stats.fps} fps`);
  if (S.stats.bitrate) lines.push(`📦 ${(stats.kbps / 1000).toFixed(1)} Mbps`);
  el.className = (lines.length ? 'show ' : '') + S.statsCorner;
  el.innerHTML = lines.join('<br>');
}

// ---------------- recording ----------------
let recorder = null, recStart = 0, recTimer = null;
async function startRecording() {
  if (recorder) return;
  const stream = canvas.captureStream(60);
  if (S.recordAudio && audio) for (const t of audio.rec.stream.getAudioTracks()) stream.addTrack(t);
  const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const file = await api.recStart();
  recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 16_000_000 });
  recorder.ondataavailable = async (e) => { if (e.data.size) api.recChunk(await e.data.arrayBuffer()); };
  recorder.onstop = async () => { await new Promise((r) => setTimeout(r, 300)); const p = await api.recStop(); if (p) toast(`Recording saved: ${p}`, 6000); };
  recorder.start(1000);
  recStart = Date.now();
  $('b-rec').classList.add('on'); $('b-rec').textContent = '⏹ Stop recording';
  $('recdot').classList.add('show');
  recTimer = setInterval(() => {
    const s = Math.round((Date.now() - recStart) / 1000);
    $('rectime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  toast(`Recording to ${file}`);
}
function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  clearInterval(recTimer);
  $('b-rec').classList.remove('on'); $('b-rec').textContent = '⏺ Record';
  $('recdot').classList.remove('show');
}
$('b-rec').onclick = () => (recorder ? stopRecording() : startRecording());

// ---------------- cast bar ----------------
function setFull(on) {
  full = on;
  api.fullscreen(on);
  renderPanel();
}
$('b-full').onclick = () => setFull(!full);
$('b-panel').onclick = () => { if (full) setFull(false); set('showCastPanel', !S.showCastPanel); };
$('b-stop').onclick = () => api.stopCast();
document.addEventListener('keydown', (e) => {
  if (!$('cast').classList.contains('show')) return;
  if (e.key === 'Escape' && full) setFull(false);
  if (e.key === 'F11') { e.preventDefault(); setFull(!full); }
});

let hideTimer;
function showBar() {
  $('castbar').classList.remove('hide');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => $('castbar').classList.add('hide'), 3000);
}
$('stage').addEventListener('mousemove', showBar);

// =====================================================================  USB
function showUsb(u) {
  const on = !!(u && u.connected);
  $('usb').textContent = on ? 'USB: Quest plugged in' : (u && u.problem ? 'USB: needs a look' : 'USB: not plugged in');
  $('usb').title = (u && u.problem) || '';
  $('usb').classList.toggle('off', !on);
}
api.on('usb', (u) => {
  showUsb(u);
  if (u.problem) toast(u.problem, 7000);
});

// =====================================================================  boot
(async () => {
  state = await api.state();
  S = state.settings;
  applyLook();
  renderSettings();
  showCode(state.code, state.codeExpires);
  renderDevices(state.devices);
  showUsb(state.usb);
  paintQuestAudio();
  if (state.update) upd = state.update;
  if (state.pendingRequest) showRequest(state.pendingRequest);
  if (state.casting) openCast(state.casting);
  setInterval(() => { if (S.showGreeting) $('greet').textContent = greeting(state.pcName); }, 60000);
})();
