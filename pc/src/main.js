// Casnt PC app — Electron main process.
// Runs as a tray helper so a Quest can still ask to cast while the window is closed.
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { Store } = require('./store');
const { CasntServer } = require('./server');

const START_HIDDEN = process.argv.includes('--hidden');
const PC_NAME = process.env.COMPUTERNAME || os.hostname();
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const TIKTOK_STUDIO_URL = 'https://www.tiktok.com/studio/download';

let store, server, tray, mainWindow, popupWindow;
let quitting = false;
let pendingRequest = null; // { sessionId, device, mode }
let casting = null;        // { device, mode }

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => showMain());
app.setAppUserModelId('com.darkerdawnfr.casnt');

// ---------------- windows ----------------
function createMain(show) {
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 820, minHeight: 560,
    show: false, backgroundColor: '#1b1408', title: 'Casnt', icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => { if (show) mainWindow.show(); });
  mainWindow.on('close', (e) => { if (!quitting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showMain() {
  if (!mainWindow) createMain(true);
  else { mainWindow.show(); mainWindow.focus(); }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function showCastPopup(req) {
  closePopup();
  const { workArea } = screen.getPrimaryDisplay();
  const w = 440, h = 250;
  popupWindow = new BrowserWindow({
    width: w, height: h, x: workArea.x + workArea.width - w - 20, y: workArea.y + workArea.height - h - 20,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, transparent: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  const query = { model: req.device.model, name: req.device.name, mode: req.mode, cartoon: String(store.settings.cartoonUi) };
  popupWindow.loadFile(path.join(__dirname, 'ui', 'popup.html'), { query });
  popupWindow.once('ready-to-show', () => { popupWindow.showInactive(); popupWindow.flashFrame(true); });
  popupWindow.on('closed', () => { popupWindow = null; });
}

function closePopup() { if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close(); popupWindow = null; }

// ---------------- tray + startup ----------------
function setupTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Casnt — waiting for your Quest');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Casnt', click: showMain },
    { type: 'separator' },
    { label: 'Quit Casnt', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

function applyStartup() {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.startWithWindows, args: ['--hidden'] });
}

// ---------------- USB (adb reverse) ----------------
// If the Quest is plugged in and adb is around (SideQuest ships one), forward the port so
// the Quest can reach the PC over the cable at 127.0.0.1.
function findAdb() {
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'SideQuest', 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'adb';
}
let usbConnected = false;
function usbTick() {
  const adb = findAdb();
  execFile(adb, ['reverse', `tcp:${server.port}`, `tcp:${server.port}`], { timeout: 4000, windowsHide: true }, (err) => {
    const now = !err;
    if (now !== usbConnected) { usbConnected = now; send('usb', { connected: now }); }
  });
}

// ---------------- TikTok LIVE Studio check ----------------
function checkTikTokStudio() {
  const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.APPDATA].filter(Boolean);
  const names = ['TikTok LIVE Studio', 'TikTokLIVEStudio', path.join('Programs', 'TikTok LIVE Studio')];
  for (const r of roots) for (const n of names) {
    const p = path.join(r, n);
    if (fs.existsSync(p)) return { installed: true, path: p };
  }
  return { installed: false, downloadUrl: TIKTOK_STUDIO_URL };
}

// ---------------- server wiring ----------------
function wireServer() {
  server.on('code', (c) => send('code', c));
  server.on('paired', (d) => { send('paired', d); send('devices', store.devices()); });
  server.on('devices-changed', () => send('devices', store.devices()));
  server.on('log', (m) => console.log('[casnt]', m));

  server.on('cast-request', (req) => {
    pendingRequest = req;
    // Window in front: the in-window banner is enough. Otherwise pop up over everything.
    const inFront = mainWindow && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized();
    if (!inFront) showCastPopup(req);
    send('cast-request', req);
  });
  server.on('cast-request-cancelled', () => { pendingRequest = null; closePopup(); send('cast-request-cancelled'); });
  server.on('cast-accepted', (info) => {
    casting = info;
    if (!mainWindow) createMain(true); else showMain();
    send('cast-accepted', info);
    tray.setToolTip(`Casnt — casting from ${info.device.model}`);
  });
  server.on('cast-started', (info) => send('cast-started', info));
  server.on('cast-ended', (info) => { casting = null; send('cast-ended', info); tray.setToolTip('Casnt — waiting for your Quest'); });

  server.on('video-config', (v) => send('video-config', { codec: v.codec, config: v.config }));
  server.on('video', (v) => send('video', v));
  server.on('audio', (a) => send('audio', a));

  server.on('tiktok-check', ({ sessionId }) => server.replyTikTok(sessionId, checkTikTokStudio()));
}

function wireIpc() {
  ipcMain.handle('state', () => ({
    pcName: PC_NAME, code: server.code, codeExpires: server.codeExpires,
    devices: store.devices(), settings: store.settings, casting, pendingRequest, usbConnected,
  }));
  ipcMain.handle('new-code', () => { server.newCode(); return { code: server.code, expires: server.codeExpires }; });
  ipcMain.handle('forget-device', (_e, id) => { server.forgetDevice(id); return store.devices(); });
  ipcMain.handle('set-setting', (_e, key, value) => {
    store.setSetting(key, value);
    if (key === 'startWithWindows') applyStartup();
    return store.settings;
  });
  ipcMain.handle('cast-response', (_e, accept) => {
    const req = pendingRequest;
    pendingRequest = null;
    closePopup();
    if (req) server.respondCast(req.sessionId, !!accept);
  });
  ipcMain.handle('stop-cast', () => server.stopCast());
  ipcMain.handle('key-request', () => server.requestKeyFrame());
  ipcMain.handle('fullscreen', (_e, on) => { if (mainWindow) mainWindow.setFullScreen(!!on); });
  ipcMain.handle('tiktok-check', () => checkTikTokStudio());
  ipcMain.handle('open-url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
}

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'casnt.json'));
  server = new CasntServer({ store, pcName: PC_NAME });
  wireServer();
  wireIpc();
  try { await server.start(); } catch (e) { console.error('Casnt could not start its server:', e); }
  setupTray();
  applyStartup();
  createMain(!START_HIDDEN);
  usbTick();
  setInterval(usbTick, 5000);
});

app.on('window-all-closed', (e) => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; if (server) server.stop(); });
