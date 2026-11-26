/* Casnt PC renderer: home, pairing code, settings, TikTok check and the cast viewer. */
'use strict';
const $ = (id) => document.getElementById(id);
const api = window.casnt;
let state = null;

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}`;
}

function applyLook() {
  const s = state.settings;
  document.body.classList.toggle('plain', !s.cartoonUi);
  document.body.classList.toggle('theme-dark', !s.cartoonUi && s.plainTheme !== 'light');
  document.body.classList.toggle('theme-light', !s.cartoonUi && s.plainTheme === 'light');
  $('plainrow').style.display = s.cartoonUi ? 'none' : '';
  $('greet').textContent = s.showGreeting ? greeting(state.pcName) : 'Casnt';
  $('pcname').textContent = `This PC shows up on your Quest as “${state.pcName}”.`;
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const v = s[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
}

// ---------- navigation ----------
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.nav-btn').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('show', s.id === b.dataset.go));
}));

// ---------- pairing code ----------
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

// ---------- devices ----------
function renderDevices(list) {
  const ul = $('devices');
  if (!list.length) { ul.innerHTML = '<li class="empty">No Quests paired yet.</li>'; return; }
  ul.innerHTML = '';
  for (const d of list) {
    const li = document.createElement('li');
    const seen = d.lastSeen ? `last seen ${new Date(d.lastSeen).toLocaleString()}` : `paired ${new Date(d.pairedAt).toLocaleDateString()}`;
    li.innerHTML = `<span style="font-size:26px">🥽</span><div class="grow"><div class="dname"></div><div class="dmeta"></div></div>`;
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

// ---------- settings ----------
document.querySelectorAll('[data-setting]').forEach((el) => el.addEventListener('change', async () => {
  const v = el.type === 'checkbox' ? el.checked : el.value;
  state.settings = await api.setSetting(el.dataset.setting, v);
  applyLook();
}));

// ---------- TikTok LIVE ----------
$('tt-cancel').onclick = () => document.querySelector('[data-go="home"]').click();
$('tt-confirm').onclick = async () => {
  const r = await api.tiktokCheck();
  const box = $('tt-result');
  box.style.display = '';
  if (r.installed) {
    box.innerHTML = '<h2>TikTok LIVE Studio found! ✅</h2><div class="hint">The LIVE tools (text-to-speech, alerts, goals, chat overlay) arrive in the next Casnt update.</div>';
  } else {
    box.innerHTML = '<h2>TikTok LIVE Studio not found</h2><div class="hint">Get it from TikTok, then press Confirm again.</div><div class="row" style="margin-top:14px"><button class="btn" id="tt-dl">Download LIVE Studio</button></div>';
    $('tt-dl').onclick = () => api.openUrl(r.downloadUrl);
  }
};

// ---------- cast requests ----------
function showRequest(req) {
  $('req-title').textContent = 'Cast request';
  $('req-text').textContent = `${req.device.model} (${req.device.name}) is trying to cast to you${req.mode === 'app' ? ' — just one app' : ''}. Do you accept?`;
  $('request').classList.add('show');
}
$('req-yes').onclick = () => { $('request').classList.remove('show'); api.respondCast(true); };
$('req-no').onclick = () => { $('request').classList.remove('show'); api.respondCast(false); };
api.on('cast-request', showRequest);
api.on('cast-request-cancelled', () => $('request').classList.remove('show'));

// ---------- cast viewer ----------
const canvas = $('screen');
const ctx = canvas.getContext('2d');
let decoder = null, codec = null, needKey = true, audio = null;
const mute = { game: false, mic: false };
let hideTimer;

function openCast(info) {
  $('request').classList.remove('show');
  $('castwho').textContent = `${info.device.model} · ${info.device.name}`;
  $('castwait').style.display = '';
  $('cast').classList.add('show');
  needKey = true;
  startAudio();
  $('castbar').classList.remove('hide');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => $('castbar').classList.add('hide'), 4000);
}
function closeCast() {
  $('cast').classList.remove('show');
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null; codec = null;
  if (audio) { audio.ctx.close(); audio = null; }
  api.fullscreen(false);
}
api.on('cast-accepted', openCast);
api.on('cast-ended', closeCast);

function makeDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output(frame) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();
      $('castwait').style.display = 'none';
    },
    error(e) { console.warn('decoder error', e); needKey = true; makeDecoder(); api.requestKeyFrame(); },
  });
  // No "description" => the stream is Annex B, which is what the Quest sends.
  decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  needKey = true;
}

api.on('video-config', (v) => { if (v.codec !== codec || !decoder) { codec = v.codec; makeDecoder(); } });
api.on('video', (v) => {
  if (!decoder || decoder.state !== 'configured') return;
  if (needKey && !v.key) return;
  needKey = false;
  if (decoder.decodeQueueSize > 8 && !v.key) return; // falling behind: drop until the next key frame
  decoder.decode(new EncodedVideoChunk({ type: v.key ? 'key' : 'delta', timestamp: v.pts, data: v.data }));
});

// ---------- audio (PCM s16le 48 kHz) ----------
function startAudio() {
  if (audio) return;
  const actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  audio = { ctx: actx, game: { gain: actx.createGain(), next: 0 }, mic: { gain: actx.createGain(), next: 0 } };
  audio.game.gain.connect(actx.destination);
  audio.mic.gain.connect(actx.destination);
  updateMute();
}
api.on('audio', (a) => {
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
function updateMute() {
  if (audio) { audio.game.gain.gain.value = mute.game ? 0 : 1; audio.mic.gain.gain.value = mute.mic ? 0 : 1; }
  $('b-game').classList.toggle('off', mute.game);
  $('b-mic').classList.toggle('off', mute.mic);
}
$('b-game').onclick = () => { mute.game = !mute.game; updateMute(); };
$('b-mic').onclick = () => { mute.mic = !mute.mic; updateMute(); };

let full = false;
$('b-full').onclick = () => { full = !full; api.fullscreen(full); };
$('b-stop').onclick = () => api.stopCast();

// auto-hide the cast bar
document.addEventListener('mousemove', () => {
  $('castbar').classList.remove('hide');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => $('castbar').classList.add('hide'), 2500);
});

// ---------- USB ----------
function showUsb(on) {
  $('usb').textContent = on ? 'USB: Quest plugged in' : 'USB: not plugged in';
  $('usb').classList.toggle('off', !on);
}
api.on('usb', (u) => showUsb(u.connected));

// ---------- boot ----------
(async () => {
  state = await api.state();
  applyLook();
  showCode(state.code, state.codeExpires);
  renderDevices(state.devices);
  showUsb(state.usbConnected);
  if (state.pendingRequest) showRequest(state.pendingRequest);
  if (state.casting) openCast(state.casting);
  setInterval(() => { if (state.settings.showGreeting) $('greet').textContent = greeting(state.pcName); }, 60000);
})();
