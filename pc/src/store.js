// Small JSON store for Casnt (PC id, paired Quests, settings).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  // look
  showGreeting: true,
  cartoonUi: true,
  plainTheme: 'dark',
  animations: true,
  sounds: true,
  // startup
  startWithWindows: true,       // keeps the tray helper running so casts can reach you
  autoUpdate: true,             // check GitHub releases on start
  usbInstantConnect: true,      // Quest plugged in by USB: skip the code
  // cast requests
  popupPosition: 'bottom-right', // bottom-right | top-right | center
  requestTimeout: 60,           // seconds before an unanswered request is declined
  autoAccept: false,            // accept casts from paired Quests without asking
  // quality
  quality: 'good',              // potato | medium | good | custom
  goodMode: 'set',              // set (capped at 1440p) | max (as heavy as it can)
  custom: { height: 1080, fps: 60, mbps: 15 },
  // view
  fov: 100,                     // % of the Quest view shown (lower = zoomed in)
  smoothness: 0,                // 0..100 stabilizer strength
  startFullscreen: false,
  alwaysOnTop: false,
  showCastPanel: true,          // settings panel next to the cast when not fullscreen
  // audio
  gameVolume: 100,              // 0..200 %
  micVolume: 100,
  // stats overlay (all off by default)
  stats: { battery: false, ping: false, fps: false, bitrate: false },
  statsCorner: 'top-left',
  // recording
  recordFolder: '',             // empty = Videos\Casnt
  recordAudio: true,
  // experimental
  lowLatency: true,             // drop late frames instead of building up delay
  hardwareDecoding: false,      // ask the GPU to decode (faster, can glitch on some drivers)
  autoReconnectHint: true,
};

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (!(k in base)) continue;
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? { ...base[k], ...(v || {}) } : v;
  }
  return out;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = { pcId: crypto.randomUUID(), devices: [], settings: merge(DEFAULT_SETTINGS, {}) };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: merge(DEFAULT_SETTINGS, raw.settings) };
    } catch (_) { /* first run */ }
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get pcId() { return this.data.pcId; }
  get settings() { return this.data.settings; }

  /** key may be dotted for nested settings, e.g. "stats.fps" or "custom.height". */
  setSetting(key, value) {
    const [top, sub] = String(key).split('.');
    if (!(top in DEFAULT_SETTINGS)) return false;
    if (sub) {
      const group = DEFAULT_SETTINGS[top];
      if (!group || typeof group !== 'object' || !(sub in group)) return false;
      this.data.settings[top] = { ...this.data.settings[top], [sub]: value };
    } else {
      this.data.settings[top] = value;
    }
    this.save();
    return true;
  }

  resetSettings() {
    this.data.settings = merge(DEFAULT_SETTINGS, {});
    this.save();
  }

  devices() { return this.data.devices.map(({ token, ...d }) => d); }

  addDevice({ deviceId, name, model }) {
    const token = crypto.randomBytes(32).toString('hex');
    this.data.devices = this.data.devices.filter((d) => d.deviceId !== deviceId);
    this.data.devices.push({ deviceId, name, model, token, pairedAt: Date.now() });
    this.save();
    return token;
  }

  checkToken(deviceId, token) {
    const d = this.data.devices.find((x) => x.deviceId === deviceId);
    if (!d || typeof token !== 'string' || token.length !== d.token.length) return null;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(d.token)) ? d : null;
  }

  updateDevice(deviceId, patch) {
    const d = this.data.devices.find((x) => x.deviceId === deviceId);
    if (d) { Object.assign(d, patch); this.save(); }
  }

  removeDevice(deviceId) {
    this.data.devices = this.data.devices.filter((d) => d.deviceId !== deviceId);
    this.save();
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
