'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['code', 'paired', 'devices', 'cast-request', 'cast-request-cancelled', 'cast-accepted',
  'cast-started', 'cast-ended', 'video-config', 'video', 'audio', 'usb'];

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
});
