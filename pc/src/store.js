// Small JSON store for Casnt (PC id, paired Quests, settings).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  showGreeting: true,
  cartoonUi: true,
  plainTheme: 'dark',     // used when cartoonUi is off (Stage 2)
  startWithWindows: true, // keeps the tray helper running so casts can reach you
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { pcId: crypto.randomUUID(), devices: [], settings: { ...DEFAULT_SETTINGS } };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
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
  setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    this.data.settings[key] = value;
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
