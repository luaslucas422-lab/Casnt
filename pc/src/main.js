// Casnt PC app — Electron main process.
// Runs as a tray helper so a Quest can still ask to cast while the window is closed.
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { Store } = require('./store');
const { CasntServer } = require('./server');
const Q = require('./quality');

const START_HIDDEN = process.argv.includes('--hidden');
const PC_NAME = process.env.COMPUTERNAME || os.hostname();
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const TIKTOK_STUDIO_URL = 'https://www.tiktok.com/studio/download';
const RELEASES_API = 'https://api.github.com/repos/luaslucas422-lab/Casnt/releases/latest';

let store, server, tray, mainWindow, popupWindow;
let quitting = false;
let pendingRequest = null; // { sessionId, device, mode }
let casting = null;        // { device, mode, spec }
let recording = null;      // { path, stream }
let usb = { connected: false, serials: [], problem: '' };
let updateState = { state: 'idle' };

if (!app.requestSingleInstanceLock()) { app.exit(0); } // Casnt is already running: the other copy gets focused
app.on('second-instance', () => showMain());
app.setAppUserModelId('com.calmchasm.casnt');

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
  const pos = store.settings.popupPosition;
  const x = pos === 'center' ? workArea.x + Math.round((workArea.width - w) / 2) : workArea.x + workArea.width - w - 20;
  const y = pos === 'center' ? workArea.y + Math.round((workArea.height - h) / 2)
    : pos === 'top-right' ? workArea.y + 20 : workArea.y + workArea.height - h - 20;
  popupWindow = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, transparent: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  const query = { model: req.device.model, name: req.device.name, mode: req.mode, cartoon: String(store.settings.cartoonUi),
    timeout: String(Math.round((req.timeoutMs || 60000) / 1000)), sounds: String(store.settings.sounds) };
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
// Casnt ships its own adb. When a Quest is plugged in (with USB debugging allowed), the
// Quest's 127.0.0.1:47820 is forwarded to this PC, so the Quest app can reach us over the cable.
function findAdb() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'adb', 'adb.exe'),
    path.join(__dirname, '..', 'vendor', 'adb', process.platform === 'win32' ? 'adb.exe' : 'adb'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'SideQuest', 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'SideQuest', 'resources', 'app.asar.unpacked', 'build', 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'adb'; // on PATH
}

function adb(args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(findAdb(), args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

let usbBusy = false;
async function usbTick() {
  if (usbBusy) return;
  usbBusy = true;
  try {
    const list = await adb(['devices', '-l']);
    let next;
    if (!list.ok) {
      next = { connected: false, serials: [], problem: /ENOENT/.test(list.err) ? 'USB needs adb, which is missing. Reinstall Casnt.' : '' };
    } else {
      const lines = list.out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
      const ready = [], problems = [];
      for (const l of lines) {
        const [serial, status] = l.split(/\s+/);
        if (status === 'device') ready.push(serial);
        else if (status === 'unauthorized') problems.push('Put on your Quest and tap "Allow" on the USB debugging popup (tick "Always allow").');
        else if (status === 'offline') problems.push('The Quest is offline over USB. Unplug it and plug it back in.');
      }
      const serials = [];
      for (const serial of ready) {
        const r = await adb(['-s', serial, 'reverse', `tcp:${server.port}`, `tcp:${server.port}`]);
        if (r.ok) serials.push(serial);
        else problems.push('Casnt could not open the USB link: ' + r.err.trim().split('\n')[0]);
      }
      next = { connected: serials.length > 0, serials, problem: serials.length ? '' : (problems[0] || '') };
    }
    const changed = next.connected !== usb.connected || next.problem !== usb.problem;
    usb = next;
    if (changed) send('usb', usb);
  } finally {
    usbBusy = false;
  }
}

// ---------------- updates ----------------
function setUpdate(u) { updateState = u; send('update', u); }

function setupUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'none' }));
  autoUpdater.on('update-available', (i) => setUpdate({ state: 'available', version: i.version }));
  autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ state: 'ready', version: i.version });
    if (tray) tray.displayBalloon && tray.displayBalloon({ title: 'Casnt', content: `Casnt ${i.version} is ready. It installs when you quit Casnt.` });
  });
  autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: String(e && e.message || e).split('\n')[0].slice(0, 140) }));
}

function checkForUpdates() {
  if (!app.isPackaged) { setUpdate({ state: 'error', message: 'updates only work in the installed app' }); return; }
  autoUpdater.checkForUpdates().catch((e) => setUpdate({ state: 'error', message: String(e.message || e).slice(0, 140) }));
}

// Download the newest Quest APK from GitHub and install it over USB.
async function updateQuestOverUsb() {
  if (!usb.connected || !usb.serials.length) return { ok: false, message: 'plug your Quest in by USB first (and allow USB debugging).' };
  try {
    const { net } = require('electron');
    const rel = await (await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })).json();
    const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    if (!asset) return { ok: false, message: 'no Quest app in the newest release.' };
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok) return { ok: false, message: `download failed (${res.status})` };
    const file = path.join(app.getPath('temp'), 'Casnt-Quest.apk');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const r = await adb(['-s', usb.serials[0], 'install', '-r', file], 120000);
    if (r.ok && /Success/.test(r.out)) return { ok: true, version: String(rel.tag_name || '').replace(/^v/, '') };
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(r.out + r.err)) {
      return { ok: false, message: 'the Casnt on your Quest was signed differently (an older test build). Uninstall it once, then try again.' };
    }
    return { ok: false, message: (r.out + r.err).trim().split('\n').pop() || 'adb install failed' };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

// ---------------- TikTok LIVE Studio check ----------------
function checkTikTokStudio() {
  // 1) the Windows "installed apps" list
  try {
    for (const hive of ['HKCU', 'HKLM']) {
      const out = require('child_process').execFileSync('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'TikTok LIVE Studio', '/d'],
        { windowsHide: true, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/TikTok LIVE Studio/i.test(out)) return { installed: true, path: hive };
    }
  } catch (_) { /* not found or no reg.exe */ }
  // 2) the usual install folders
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
    if (store.settings.autoAccept) { pendingRequest = null; server.respondCast(req.sessionId, true); return; }
    // Window in front: the in-window banner is enough. Otherwise pop up over everything.
    const inFront = mainWindow && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized();
    if (!inFront) showCastPopup(req);
    send('cast-request', req);
  });
  server.on('cast-request-cancelled', () => { pendingRequest = null; closePopup(); send('cast-request-cancelled'); });
  server.on('cast-accepted', (info) => {
    casting = info;
    if (!mainWindow) createMain(true); else showMain();
    if (store.settings.alwaysOnTop) mainWindow.setAlwaysOnTop(true, 'floating');
    if (store.settings.startFullscreen) mainWindow.setFullScreen(true);
    send('cast-accepted', info);
    tray.setToolTip(`Casnt — casting from ${info.device.model}`);
  });
  server.on('cast-started', (info) => send('cast-started', info));
  server.on('cast-ended', (info) => {
    casting = null;
    stopRecording();
    if (mainWindow) { mainWindow.setAlwaysOnTop(false); mainWindow.setFullScreen(false); }
    send('cast-ended', info); tray.setToolTip('Casnt — waiting for your Quest'); });

  server.on('video-config', (v) => send('video-config', { codec: v.codec, config: v.config }));
  server.on('video', (v) => send('video', v));
  server.on('audio', (a) => send('audio', a));
  server.on('ping', (p) => send('ping', p));
  server.on('quest-status', (st) => {
    if (casting && st.spec) casting.spec = st.spec;
    send('quest-status', st);
  });

  server.on('tiktok-check', ({ sessionId }) => server.replyTikTok(sessionId, checkTikTokStudio()));
}

function wireIpc() {
  ipcMain.handle('state', () => ({
    pcName: PC_NAME, code: server.code, codeExpires: server.codeExpires,
    devices: store.devices(), settings: store.settings, casting, pendingRequest, usb,
    version: app.getVersion(), update: updateState, defaultRecordFolder: path.join(app.getPath('videos'), 'Casnt'),
  }));
  ipcMain.handle('update-check', () => checkForUpdates());
  ipcMain.handle('update-quest', () => updateQuestOverUsb());
  ipcMain.handle('new-code', () => { server.newCode(); return { code: server.code, expires: server.codeExpires }; });
  ipcMain.handle('forget-device', (_e, id) => { server.forgetDevice(id); return store.devices(); });
  ipcMain.handle('set-setting', (_e, key, value) => {
    store.setSetting(key, value);
    if (key === 'startWithWindows') applyStartup();
    if (casting && (key === 'quality' || key === 'goodMode' || key.startsWith('custom.'))) {
      server.setQuality(Q.specFor(store.settings.quality, store.settings));
    }
    if (casting && key === 'alwaysOnTop' && mainWindow) mainWindow.setAlwaysOnTop(!!value, 'floating');
    return store.settings;
  });
  ipcMain.handle('reset-settings', () => { store.resetSettings(); applyStartup(); return store.settings; });
  ipcMain.handle('quality-info', () => ({ presets: Q.PRESETS, heights: Q.CUSTOM_HEIGHTS, fps: Q.CUSTOM_FPS }));
  ipcMain.handle('set-quest-audio', (_e, a) => server.setAudio(a));
  ipcMain.handle('pick-record-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return store.settings.recordFolder;
    store.setSetting('recordFolder', r.filePaths[0]);
    return r.filePaths[0];
  });
  ipcMain.handle('rec-start', () => startRecording());
  ipcMain.on('rec-chunk', (_e, chunk) => { if (recording) recording.stream.write(Buffer.from(chunk)); });
  ipcMain.handle('rec-stop', () => stopRecording());
  ipcMain.handle('open-recordings', () => shell.openPath(recordFolder()));
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

// ---------------- recording ----------------
function recordFolder() {
  return store.settings.recordFolder || path.join(app.getPath('videos'), 'Casnt');
}
function startRecording() {
  stopRecording();
  const dir = recordFolder();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, `Casnt-${stamp}.webm`);
  recording = { path: file, stream: fs.createWriteStream(file) };
  return file;
}
function stopRecording() {
  if (!recording) return null;
  const done = recording.path;
  recording.stream.end();
  recording = null;
  send('rec-saved', { path: done });
  return done;
}

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'casnt.json'));
  server = new CasntServer({
    store, pcName: PC_NAME,
    // The Quest can ask for a preset; otherwise the PC's quality setting decides.
    specFor: (questPref) => (questPref && questPref !== 'pc'
      ? (questPref === 'max' ? { ...Q.PRESETS.max } : Q.specFor(questPref, { ...store.settings, goodMode: 'set' }))
      : Q.specFor(store.settings.quality, store.settings)),
  });
  wireServer();
  wireIpc();
  try { await server.start(); } catch (e) { console.error('Casnt could not start its server:', e); }
  setupTray();
  applyStartup();
  createMain(!START_HIDDEN);
  setupUpdater();
  if (store.settings.autoUpdate && app.isPackaged) setTimeout(checkForUpdates, 8000);
  usbTick();
  setInterval(usbTick, 3000);
});

app.on('window-all-closed', (e) => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; if (server) server.stop(); });
