// Stage 3 wiring for the main process: TikTok LIVE engine + overlays + key presses,
// the Quest's TikTok panel, and Cast Player (Spotify).
'use strict';
const fs = require('fs');
const path = require('path');
const { TikTokLive } = require('./tiktok/live');
const { TikTokEngine, DEFAULT_TIKTOK, uid } = require('./tiktok/engine');
const { OverlayServer, WIDGETS } = require('./tiktok/overlays');
const { WinHelper } = require('./winhelper');
const { Spotify, DOWNLOAD_URL } = require('./spotify');

function setupStage3({ app, ipcMain, dialog, shell, store, server, send, log }) {
  const live = new TikTokLive();
  const engine = new TikTokEngine(store.tiktok);
  const win = new WinHelper();
  const soundsDir = path.join(app.getPath('userData'), 'sounds');

  const cfg = () => engine.cfg;
  const customSoundFile = (id) => {
    const s = cfg().sounds.custom.find((x) => x.id === id);
    return s ? path.join(soundsDir, s.file) : null;
  };
  const overlays = new OverlayServer({ getState: () => ({ ...engine.getState(), live: { status: live.status, username: live.username } }), getCustomSound: customSoundFile });
  overlays.start().then((ok) => { if (!ok) log('overlay server could not start: ' + overlays.error); });

  const soundUrl = (id) => (customSoundFile(id) ? `http://127.0.0.1:${overlays.port}/sound/${id}` : '');

  // ------------------------------------------------------------ engine -> outputs
  engine.on('command', (c) => {
    if (c.kind === 'tts') { send('tt-tts', c); return; }
    if (c.kind === 'sound') {
      const msg = { sound: c.sound, volume: c.volume, url: soundUrl(c.sound) };
      if (c.playOn !== 'overlay') send('tt-sound', msg);
      if (c.playOn === 'overlay' || c.playOn === 'both') overlays.broadcast('sound', msg);
      return;
    }
    if (c.kind === 'alert') { overlays.broadcast('alert', c.alert); send('tt-alert', c.alert); server.sendToSubs('tiktok', { t: 'tiktok_alert', title: c.alert.title }); return; }
    if (c.kind === 'keys') {
      win.press(c.keys, c.hold, c.repeat).catch((e) => send('tt-log', `Key press "${c.keys}" failed: ${e.message}`));
      return;
    }
    if (c.kind === 'quest') server.sendToSubs('tiktok', { t: 'tiktok_alert', title: c.text });
  });
  engine.on('state', (st) => {
    overlays.broadcast('state', { ...st, live: { status: live.status, username: live.username } });
    send('tt-state', st);
    if (server.hasSubs('tiktok')) server.sendToSubs('tiktok', { t: 'tiktok_stats', stats: st.stats, goals: st.goals.slice(0, 3), top: st.leaderboard.slice(0, 3).map((g) => ({ name: g.name, diamonds: g.diamonds })) });
  });

  // feed: everything except likes/joins goes to the PC feed + Quest panel right away
  engine.on('feed', (ev) => {
    if (ev.type === 'viewers' || ev.type === 'join') return;
    const item = {
      type: ev.type, name: ev.user ? ev.user.name : '', avatar: ev.user ? ev.user.avatar : '',
      text: ev.text || '', gift: ev.gift || '', count: ev.count || 0, diamonds: ev.diamonds || 0, image: ev.image || '',
    };
    if (ev.type === 'like') return; // likes are summed in stats instead of spamming the feed
    send('tt-feed', item);
    server.sendToSubs('tiktok', { t: 'tiktok_feed', item: { type: item.type, name: item.name, text: item.text, gift: item.gift, count: item.count } });
  });

  live.on('event', (ev) => engine.handle(ev));
  live.on('status', (s) => { send('tt-status', s); server.sendToSubs('tiktok', { t: 'tiktok_status', ...s }); overlays.broadcast('state', { ...engine.getState(), live: s }); });
  live.on('connected', () => engine.resetStats());
  live.on('log', (m) => send('tt-log', m));

  const saveCfg = (next) => { engine.setConfig(next); store.setTiktok(engine.cfg); engine.emitState(); return engine.cfg; };
  if (store.tiktok.autoConnect && store.tiktok.username) setTimeout(() => live.connect(store.tiktok.username, { signApiKey: store.tiktok.signApiKey }), 3000);

  // ------------------------------------------------------------ IPC (PC TikTok page)
  ipcMain.handle('tt-get', () => ({
    cfg: cfg(), defaults: DEFAULT_TIKTOK, state: engine.getState(), status: { status: live.status, message: live.message, username: live.username },
    overlays: Object.entries(WIDGETS).map(([id, name]) => ({ id, name, url: overlays.url(id) })), overlayPort: overlays.port,
  }));
  ipcMain.handle('tt-set', (_e, next) => saveCfg(next));
  ipcMain.handle('tt-connect', (_e, username) => {
    saveCfg({ ...cfg(), username });
    return live.connect(username, { signApiKey: cfg().signApiKey });
  });
  ipcMain.handle('tt-disconnect', () => live.disconnect());
  ipcMain.handle('tt-simulate', (_e, type) => engine.simulate(type));
  ipcMain.handle('tt-reset-stats', () => engine.resetStats());
  ipcMain.handle('tt-test-keys', async (_e, keys) => {
    try { await win.press(keys, 80, 1); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('tt-sound-url', (_e, id) => soundUrl(id));
  ipcMain.handle('tt-add-sounds', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Sounds', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] });
    if (r.canceled) return cfg();
    fs.mkdirSync(soundsDir, { recursive: true });
    const custom = [...cfg().sounds.custom];
    for (const f of r.filePaths) {
      const id = 'c-' + uid();
      const file = id + path.extname(f).toLowerCase();
      fs.copyFileSync(f, path.join(soundsDir, file));
      custom.push({ id, name: path.basename(f, path.extname(f)).toLowerCase().replace(/[^\w]+/g, '').slice(0, 24) || id, file });
    }
    return saveCfg({ ...cfg(), sounds: { ...cfg().sounds, custom } });
  });
  ipcMain.handle('tt-remove-sound', (_e, id) => {
    const f = customSoundFile(id);
    if (f) try { fs.unlinkSync(f); } catch (_) { /* gone already */ }
    return saveCfg({ ...cfg(), sounds: { ...cfg().sounds, custom: cfg().sounds.custom.filter((s) => s.id !== id) } });
  });

  // ------------------------------------------------------------ Spotify (Cast Player)
  const spotify = new Spotify({ load: () => store.spotify, save: (s) => store.setSpotify(s), openUrl: (u) => shell.openExternal(u) });
  ipcMain.handle('sp-status', () => ({ linked: spotify.linked(), clientId: store.spotify.clientId || '' }));
  ipcMain.handle('sp-link', async (_e, clientId) => {
    try { await spotify.login(clientId); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('sp-unlink', () => { spotify.unlink(); return { ok: true }; });

  let playerTimer = null;
  let lastPlayer = '';
  async function pushPlayer(force) {
    if (!server.hasSubs('player')) { clearInterval(playerTimer); playerTimer = null; return; }
    try {
      const st = await win.call('media_state', { art: !!force });
      const key = JSON.stringify({ ...st, art: st.art ? st.art.length : 0 });
      if (force || key !== lastPlayer) {
        lastPlayer = key;
        server.sendToSubs('player', { t: 'player_state', ...st, linked: spotify.linked() });
      }
    } catch (e) {
      server.sendToSubs('player', { t: 'player_state', active: false, error: e.message, linked: spotify.linked() });
    }
  }

  async function questPlayer(sessionId, msg) {
    const reply = (obj) => server.sendTo(sessionId, { t: 'player_result', req: msg.req, ...obj });
    try {
      switch (msg.do) {
        case 'subscribe':
          server.subscribe(sessionId, 'player', true);
          if (!playerTimer) playerTimer = setInterval(() => pushPlayer(false), 1500);
          pushPlayer(true);
          return reply({ ok: true });
        case 'unsubscribe': server.subscribe(sessionId, 'player', false); return reply({ ok: true });
        case 'toggle': case 'play': case 'pause': case 'next': case 'prev':
          await win.call('media', { action: msg.do });
          setTimeout(() => pushPlayer(false), 350);
          return reply({ ok: true });
        case 'search':
          if (!spotify.linked()) { shell.openExternal('spotify:search:' + encodeURIComponent(msg.q || '')); return reply({ ok: false, needLink: true, message: 'Opened the search in Spotify on your PC. Link your Spotify account in Casnt on the PC to pick songs from here.' }); }
          return reply({ ok: true, results: await spotify.search(msg.q || '') });
        case 'playlists':
          if (!spotify.linked()) return reply({ ok: false, needLink: true, message: 'Link your Spotify account in Casnt on your PC (Settings → Cast Player) to see your playlists.' });
          return reply({ ok: true, results: { playlists: await spotify.playlists() } });
        case 'playlist':
          return reply({ ok: true, results: { tracks: await spotify.playlistTracks(msg.id) }, context: msg.uri });
        case 'play_item': {
          const r = spotify.linked() ? await spotify.play(msg.item, msg.context) : (shell.openExternal(msg.item.uri), { ok: false, opened: true });
          setTimeout(() => pushPlayer(true), 800);
          return reply(r.ok ? { ok: true } : { ok: false, message: r.message ? `${r.message} Opened it in Spotify on your PC instead.` : 'Opened it in Spotify on your PC.' });
        }
        default: return reply({ ok: false, message: 'unknown command' });
      }
    } catch (e) { return reply({ ok: false, message: e.message }); }
  }

  // ------------------------------------------------------------ Quest messages
  server.on('quest-msg', async ({ sessionId, msg }) => {
    switch (msg.t) {
      case 'tiktok_subscribe':
        server.subscribe(sessionId, 'tiktok', true);
        server.sendTo(sessionId, { t: 'tiktok_status', status: live.status, message: live.message, username: live.username || cfg().username });
        server.sendTo(sessionId, { t: 'tiktok_stats', stats: engine.stats, goals: engine.getState().goals.slice(0, 3), top: engine.leaderboard(3).map((g) => ({ name: g.name, diamonds: g.diamonds })) });
        server.sendTo(sessionId, { t: 'tiktok_config', tts: cfg().tts.enabled, sounds: cfg().sounds.enabled, alerts: cfg().alerts.enabled,
          soundList: require('./tiktok/sfx-list').LIST.slice(0, 16).map(([id, name, emoji]) => ({ id, name, emoji })) });
        break;
      case 'tiktok_unsubscribe': server.subscribe(sessionId, 'tiktok', false); break;
      case 'tiktok_action': {
        const a = msg.do;
        if (a === 'connect') live.connect(cfg().username, { signApiKey: cfg().signApiKey });
        else if (a === 'disconnect') live.disconnect();
        else if (a === 'tts_skip') send('tt-tts-skip');
        else if (a === 'sound') engine.playSound(String(msg.sound || ''));
        else if (a === 'test') engine.simulate(String(msg.type || 'gift'));
        else if (a === 'toggle') {
          const k = msg.what;
          if (['tts', 'sounds', 'alerts'].includes(k)) {
            const c = cfg();
            saveCfg({ ...c, [k]: { ...c[k], enabled: !c[k].enabled } });
            send('tt-config', engine.cfg);
            server.sendToSubs('tiktok', { t: 'tiktok_config', tts: engine.cfg.tts.enabled, sounds: engine.cfg.sounds.enabled, alerts: engine.cfg.alerts.enabled });
          }
        }
        break;
      }
      case 'spotify_check': {
        let info = { installed: false, running: false };
        try { info = await win.call('spotify', {}, 15000); } catch (e) { info.error = e.message; }
        server.sendTo(sessionId, { t: 'spotify_info', ...info, linked: spotify.linked(), downloadUrl: DOWNLOAD_URL });
        break;
      }
      case 'spotify_open_download': shell.openExternal(DOWNLOAD_URL); break;
      case 'player_cmd': questPlayer(sessionId, msg); break;
      default: break;
    }
  });

  return {
    stop() { live.disconnect(); overlays.stop(); win.stop(); },
  };
}

module.exports = { setupStage3 };
