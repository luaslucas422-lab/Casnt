'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['code', 'paired', 'devices', 'cast-request', 'cast-request-cancelled', 'cast-accepted',
  'cast-started', 'cast-ended', 'video-config', 'video', 'audio', 'usb', 'ping', 'quest-status', 'rec-saved', 'update',
  'tt-tts', 'tt-tts-skip', 'tt-sound', 'tt-alert', 'tt-state', 'tt-feed', 'tt-status', 'tt-log', 'tt-config'];

contextBridge.exposeInMainWorld('casnt', {
  on(channel, cb) {
    if (!CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
  state: () => ipcRenderer.invoke('state'),
  newCode: () => ipcRenderer.invoke('new-code'),
  forgetDevice: (id) => ipcRenderer.invoke('forget-device', id),
  setSetting: (k, v) => ipcRenderer.invoke('set-setting', k, v),
  respondCast: (accept) => ipcRenderer.invoke('cast-response', accept),
  stopCast: () => ipcRenderer.invoke('stop-cast'),
  requestKeyFrame: () => ipcRenderer.invoke('key-request'),
  fullscreen: (on) => ipcRenderer.invoke('fullscreen', on),
  tiktokCheck: () => ipcRenderer.invoke('tiktok-check'),
  openUrl: (u) => ipcRenderer.invoke('open-url', u),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  qualityInfo: () => ipcRenderer.invoke('quality-info'),
  setQuestAudio: (a) => ipcRenderer.invoke('set-quest-audio', a),
  pickRecordFolder: () => ipcRenderer.invoke('pick-record-folder'),
  recStart: () => ipcRenderer.invoke('rec-start'),
  recChunk: (buf) => ipcRenderer.send('rec-chunk', buf),
  recStop: () => ipcRenderer.invoke('rec-stop'),
  openRecordings: () => ipcRenderer.invoke('open-recordings'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateQuest: () => ipcRenderer.invoke('update-quest'),
  tt: {
    get: () => ipcRenderer.invoke('tt-get'),
    set: (cfg) => ipcRenderer.invoke('tt-set', cfg),
    connect: (u) => ipcRenderer.invoke('tt-connect', u),
    disconnect: () => ipcRenderer.invoke('tt-disconnect'),
    simulate: (t) => ipcRenderer.invoke('tt-simulate', t),
    resetStats: () => ipcRenderer.invoke('tt-reset-stats'),
    testKeys: (k) => ipcRenderer.invoke('tt-test-keys', k),
    soundUrl: (id) => ipcRenderer.invoke('tt-sound-url', id),
    addSounds: () => ipcRenderer.invoke('tt-add-sounds'),
    removeSound: (id) => ipcRenderer.invoke('tt-remove-sound', id),
  },
  sp: {
    status: () => ipcRenderer.invoke('sp-status'),
    link: (id) => ipcRenderer.invoke('sp-link', id),
    unlink: () => ipcRenderer.invoke('sp-unlink'),
  },
});
