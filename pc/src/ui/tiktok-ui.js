/* Casnt PC: TikTok LIVE area (Tikfinity-style) + Cast Player account link. */
'use strict';
(() => {
  const tt = window.casnt.tt;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const SOUNDS = window.CasntSfx.LIST;

  let C = null;        // config
  let info = null;     // overlays etc.
  let state = null;    // engine state
  let status = { status: 'offline' };
  let tab = 'live';
  const feed = [];

  // ================================================================ config helpers
  const getPath = (p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), C);
  function setPath(p, v) {
    const keys = p.split('.');
    let o = C;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = v;
    save();
  }
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { C = await tt.set(C); }, 250);
  }

  function row(label, sub, control) {
    const r = document.createElement('div');
    r.className = 'setting';
    r.innerHTML = '<div><b></b><small></small></div>';
    r.querySelector('b').textContent = label;
    r.querySelector('small').textContent = sub || '';
    r.appendChild(control);
    return r;
  }
  function toggle(p) {
    const w = document.createElement('label');
    w.className = 'toggle';
    w.innerHTML = '<input type="checkbox"><span></span>';
    const i = w.querySelector('input');
    i.checked = !!getPath(p);
    i.onchange = () => { setPath(p, i.checked); };
    return w;
  }
  function text(p, placeholder = '', width = 220) {
    const i = document.createElement('input');
    i.className = 'tin'; i.style.width = width + 'px';
    i.value = getPath(p) ?? ''; i.placeholder = placeholder;
    i.oninput = () => setPath(p, i.value);
    return i;
  }
  function num(p, min, max, width = 110) {
    const i = document.createElement('input');
    i.type = 'number'; i.className = 'tin'; i.style.width = width + 'px';
    i.min = min; i.max = max; i.value = getPath(p);
    i.oninput = () => setPath(p, Number(i.value));
    return i;
  }
  function area(p, placeholder) {
    const t = document.createElement('textarea');
    t.className = 'tin'; t.rows = 3; t.style.width = '320px';
    t.value = getPath(p) || ''; t.placeholder = placeholder;
    t.oninput = () => setPath(p, t.value);
    return t;
  }
  function slider(p, min, max, step, unit = '') {
    const w = document.createElement('div');
    w.className = 'slider';
    w.innerHTML = `<input type="range" min="${min}" max="${max}" step="${step}"><span class="val"></span>`;
    const r = w.querySelector('input'), v = w.querySelector('.val');
    r.value = getPath(p); v.textContent = r.value + unit;
    r.oninput = () => { v.textContent = r.value + unit; setPath(p, Number(r.value)); };
    return w;
  }
  function seg(p, options, after) {
    const w = document.createElement('div');
    w.className = 'seg';
    for (const [val, label] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('on', getPath(p) === val);
      b.onclick = () => { setPath(p, val); render(); if (after) after(val); };
      w.appendChild(b);
    }
    return w;
  }
  function select(p, options, onChange) {
    const s = document.createElement('select');
    for (const [val, label] of options) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if (String(getPath(p)) === String(val)) o.selected = true;
      s.appendChild(o);
    }
    s.onchange = () => { setPath(p, s.value); if (onChange) onChange(s.value); };
    return s;
  }
  function btn(label, onClick, cls = 'btn small') {
    const b = document.createElement('button');
    b.className = cls; b.textContent = label; b.onclick = onClick;
    return b;
  }
  function card(title, sub) {
    const c = document.createElement('div');
    c.className = 'card sec';
    c.innerHTML = `<h2>${esc(title)}</h2>${sub ? `<div class="hint" style="margin:-6px 0 6px">${esc(sub)}</div>` : ''}`;
    return c;
  }
  const soundOptions = () => [['', '(none)'], ...SOUNDS.map(([id, name, e]) => [id, `${e} ${name}`]), ...C.sounds.custom.map((s) => [s.id, `🎵 ${s.name}`])];

  // ================================================================ sounds + TTS (played on this PC)
  async function playSound(id, volume) {
    const custom = C && C.sounds.custom.find((s) => s.id === id);
    if (custom) window.CasntSfx.play(id, volume, await tt.soundUrl(id));
    else window.CasntSfx.play(id, volume);
  }
  window.casnt.on('tt-sound', (s) => window.CasntSfx.play(s.sound, s.volume, s.url || undefined));

  const tts = { queue: [], speaking: false };
  function voices() { return (window.speechSynthesis && speechSynthesis.getVoices()) || []; }
  function speakNext() {
    if (tts.speaking || !tts.queue.length || !window.speechSynthesis) return;
    const text = tts.queue.shift();
    const u = new SpeechSynthesisUtterance(text);
    const t = C.tts;
    const v = voices().find((x) => x.name === t.voice);
    if (v) u.voice = v;
    u.rate = t.rate; u.pitch = t.pitch; u.volume = Math.min(1, t.volume / 100);
    tts.speaking = true;
    u.onend = u.onerror = () => { tts.speaking = false; speakNext(); };
    speechSynthesis.speak(u);
  }
  function say(text) {
    if (!C || !C.tts.enabled) return;
    if (tts.queue.length >= (C.tts.queueMax || 8)) tts.queue.shift();
    tts.queue.push(text);
    speakNext();
  }
  function skipTts() { if (window.speechSynthesis) speechSynthesis.cancel(); tts.speaking = false; speakNext(); }
  window.casnt.on('tt-tts', (c) => say(c.text));
  window.casnt.on('tt-tts-skip', skipTts);
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { if (tab === 'tts') render(); };

  // ================================================================ live updates
  window.casnt.on('tt-state', (s) => { state = s; if (tab === 'live' || tab === 'points') renderLiveBits(); });
  window.casnt.on('tt-feed', (item) => { feed.unshift(item); feed.length = Math.min(feed.length, 120); if (tab === 'live') renderFeed(); });
  window.casnt.on('tt-status', (s) => { status = s; paintBadge(); if (tab === 'live') render(); });
  window.casnt.on('tt-log', (m) => console.log('[tiktok]', m));
  window.casnt.on('tt-config', (c) => { C = c; render(); });
  window.casnt.on('tt-alert', () => {});

  function paintBadge() {
    const b = $('tt-badge');
    const map = { live: ['LIVE', ''], connecting: ['Connecting…', 'off'], waiting: ['Waiting for LIVE', 'off'], error: ['Problem', 'off'], offline: ['Offline', 'off'] };
    const [label, cls] = map[status.status] || map.offline;
    b.textContent = label;
    b.className = 'badge ' + cls + (status.status === 'live' ? ' live' : '');
  }

  // ================================================================ tabs
  const TABS = [['live', '📡 Live'], ['tts', '🗣️ TTS'], ['alerts', '🔔 Alerts'], ['sounds', '🔊 Sounds'], ['actions', '⚡ Actions'],
    ['goals', '🎯 Goals'], ['overlays', '🖼️ Overlays'], ['points', '🏆 Points'], ['more', '⚙️ More']];

  function render() {
    if (!C) return;
    const tabs = $('tt-tabs');
    tabs.innerHTML = '';
    for (const [id, label] of TABS) {
      const b = btn(label, () => { tab = id; render(); }, '');
      if (id === tab) b.classList.add('on');
      tabs.appendChild(b);
    }
    const body = $('tt-body');
    body.innerHTML = '';
    ({ live: renderLive, tts: renderTts, alerts: renderAlerts, sounds: renderSounds, actions: renderActions, goals: renderGoals,
      overlays: renderOverlays, points: renderPoints, more: renderMore })[tab](body);
  }

  // ---------------------------------------------------------------- Live
  function renderLive(body) {
    const c = card('Connect', 'Type the TikTok username that goes LIVE. Casnt keeps checking until you are live.');
    const r = document.createElement('div');
    r.className = 'row';
    const u = text('username', '@yourname', 260);
    r.appendChild(u);
    const on = status.status === 'live' || status.status === 'connecting' || status.status === 'waiting';
    r.appendChild(btn(on ? 'Disconnect' : 'Connect', async () => { if (on) await tt.disconnect(); else await tt.connect(u.value); }, on ? 'btn small dark' : 'btn small'));
    const msg = document.createElement('span');
    msg.className = 'hint'; msg.textContent = status.message || '';
    r.appendChild(msg);
    c.appendChild(r);
    body.appendChild(c);

    const s = card('This LIVE');
    s.innerHTML += '<div class="tiles" id="tt-tiles"></div>';
    body.appendChild(s);

    const t = card('Test without going LIVE', 'Sends a fake event through everything (TTS, sounds, alerts, actions, overlays).');
    const tr = document.createElement('div');
    tr.className = 'row';
    for (const [k, l] of [['chat', '💬 Chat'], ['gift', '🌹 5 Roses'], ['biggift', '🌌 Galaxy'], ['follow', '➕ Follow'], ['share', '🔁 Share'], ['subscribe', '⭐ Sub'], ['like', '❤️ 250 likes']]) {
      tr.appendChild(btn(l, () => tt.simulate(k), 'btn small dark'));
    }
    tr.appendChild(btn('Reset stats', () => tt.resetStats(), 'btn small red'));
    t.appendChild(tr);
    body.appendChild(t);

    const f = card('Live feed');
    f.innerHTML += '<div class="feed" id="tt-feed"></div>';
    body.appendChild(f);
    renderLiveBits();
    renderFeed();
  }

  function renderLiveBits() {
    if (!state) return;
    const tiles = $('tt-tiles');
    if (tiles) {
      const st = state.stats;
      const top = state.leaderboard[0];
      tiles.innerHTML = [['👀', st.viewers, 'viewers'], ['❤️', st.likes, 'likes'], ['💎', st.diamonds, 'diamonds'], ['➕', st.follows, 'follows'],
        ['🔁', st.shares, 'shares'], ['💬', st.chats, 'chats']].map(([e, n, l]) => `<div class="tile"><div class="n">${e} ${fmt(n)}</div><div class="l">${l}</div></div>`).join('') +
        `<div class="tile wide"><div class="n">👑 ${top ? esc(top.name) : '–'}</div><div class="l">top gifter${top ? ' · 💎 ' + fmt(top.diamonds) : ''}</div></div>`;
    }
    if (tab === 'points') renderPointsTable();
  }

  function renderFeed() {
    const el = $('tt-feed');
    if (!el) return;
    const icon = { chat: '💬', gift: '🎁', follow: '➕', share: '🔁', subscribe: '⭐' };
    el.innerHTML = feed.map((f) => `<div class="fitem ${f.type}">${f.avatar ? `<img src="${esc(f.avatar)}" referrerpolicy="no-referrer">` : `<span class="fi">${icon[f.type] || '•'}</span>`}<b>${esc(f.name)}</b> ${
      f.type === 'chat' ? esc(f.text) : f.type === 'gift' ? `sent ${f.count > 1 ? f.count + '× ' : ''}${esc(f.gift)} <span class="hint">💎 ${fmt(f.diamonds * f.count)}</span>` :
        f.type === 'follow' ? 'followed' : f.type === 'share' ? 'shared the LIVE' : f.type === 'subscribe' ? 'subscribed' : ''}</div>`).join('') || '<div class="hint">Nothing yet. Connect, or press a test button.</div>';
  }

  // ---------------------------------------------------------------- TTS
  function renderTts(body) {
    const c = card('Text-to-speech', 'Reads chat out loud on this PC using Windows voices.');
    c.appendChild(row('TTS on', '', toggle('tts.enabled')));
    c.appendChild(row('Which messages', 'Command = only messages starting with the command below', seg('tts.mode', [['all', 'All chat'], ['command', 'Command only'], ['gifters', 'Gifters only'], ['followers', 'Followers only']])));
    c.appendChild(row('Command', 'e.g. !tts hello', text('tts.command', '!tts', 120)));
    c.appendChild(row('Voice', '', select('tts.voice', [['', 'Windows default'], ...voices().map((v) => [v.name, `${v.name} (${v.lang})`])])));
    c.appendChild(row('Speed', '', slider('tts.rate', 0.5, 2, 0.1, '×')));
    c.appendChild(row('Pitch', '', slider('tts.pitch', 0.5, 2, 0.1, '')));
    c.appendChild(row('Volume', '', slider('tts.volume', 0, 100, 5, '%')));
    c.appendChild(row('Say the name first', '"Geo says hello"', toggle('tts.sayName')));
    c.appendChild(row('Read gifts', '"Geo sent 5 Rose. Thank you!"', toggle('tts.readGifts')));
    c.appendChild(row('Read follows', '"Thanks for the follow, Geo!"', toggle('tts.readFollows')));
    c.appendChild(row('Skip links', '', toggle('tts.skipLinks')));
    c.appendChild(row('Max length', 'characters', num('tts.maxLength', 10, 500)));
    c.appendChild(row('Per-viewer cooldown', 'seconds between one viewer\'s messages', num('tts.userCooldown', 0, 600)));
    c.appendChild(row('Queue size', 'older messages get dropped when it\'s full', num('tts.queueMax', 1, 50)));
    c.appendChild(row('Blocked words', 'comma separated', area('tts.blockedWords', 'word1, word2')));
    c.appendChild(row('Blocked viewers', 'usernames, comma separated', area('tts.blockedUsers', 'user1, user2')));
    const r = document.createElement('div'); r.className = 'row'; r.style.marginTop = '12px';
    r.appendChild(btn('🔊 Test voice', () => say('This is Casnt text to speech. Hello TikTok!')));
    r.appendChild(btn('⏭ Skip current', skipTts, 'btn small dark'));
    c.appendChild(r);
    body.appendChild(c);
  }

  // ---------------------------------------------------------------- Alerts
  function renderAlerts(body) {
    const c = card('Alerts', 'Pop-ups on the Alerts overlay (add it in the Overlays tab) with a sound.');
    c.appendChild(row('Alerts on', '', toggle('alerts.enabled')));
    c.appendChild(row('Gifts', '', toggle('alerts.gifts')));
    c.appendChild(row('Smallest gift that alerts', 'diamonds', num('alerts.minDiamonds', 0, 100000)));
    c.appendChild(row('Gift sound', '', select('alerts.giftSound', soundOptions())));
    c.appendChild(row('Follows', '', toggle('alerts.follows')));
    c.appendChild(row('Follow sound', '', select('alerts.followSound', soundOptions())));
    c.appendChild(row('Shares', '', toggle('alerts.shares')));
    c.appendChild(row('Share sound', '', select('alerts.shareSound', soundOptions())));
    c.appendChild(row('Subscribers', '', toggle('alerts.subscribes')));
    c.appendChild(row('Subscriber sound', '', select('alerts.subSound', soundOptions())));
    c.appendChild(row('Like milestones', 'alert every N likes (0 = off)', num('alerts.likeMilestone', 0, 1000000)));
    c.appendChild(row('Like milestone sound', '', select('alerts.likeSound', soundOptions())));
    c.appendChild(row('Alert time', 'seconds on screen', num('alerts.duration', 2, 30)));
    body.appendChild(c);
  }

  // ---------------------------------------------------------------- Sounds
  function renderSounds(body) {
    const c = card('Sounds');
    c.appendChild(row('Sounds on', '', toggle('sounds.enabled')));
    c.appendChild(row('Volume', '', slider('sounds.volume', 0, 150, 5, '%')));
    c.appendChild(row('Play sounds on', 'Overlay = inside the Alerts browser source (so the stream hears it)', seg('sounds.playOn', [['pc', 'This PC'], ['overlay', 'Overlay'], ['both', 'Both']])));
    c.appendChild(row('Viewers can play sounds', 'with a chat command', toggle('sounds.chatCommand')));
    c.appendChild(row('Sound command', 'e.g. !sound airhorn', text('sounds.command', '!sound', 120)));
    c.appendChild(row('Command cooldown', 'seconds per viewer', num('sounds.commandCooldown', 0, 600)));
    body.appendChild(c);

    const b = card('Soundboard', `${SOUNDS.length} preset sounds. Click to play. Viewers use the name after the command, e.g. "!sound airhorn".`);
    const grid = document.createElement('div');
    grid.className = 'sboard';
    for (const [id, name, emoji] of SOUNDS) {
      const x = btn(`${emoji} ${name}`, () => playSound(id, C.sounds.volume), 'sbtn');
      x.title = id;
      grid.appendChild(x);
    }
    b.appendChild(grid);
    body.appendChild(b);

    const m = card('Your own sounds', 'Add MP3/WAV/OGG files. They work everywhere the presets do.');
    for (const s of C.sounds.custom) {
      const r = document.createElement('div'); r.className = 'row';
      r.innerHTML = `<b style="min-width:200px">🎵 ${esc(s.name)}</b>`;
      r.appendChild(btn('▶ Play', () => playSound(s.id, C.sounds.volume), 'btn small dark'));
      r.appendChild(btn('Remove', async () => { C = await tt.removeSound(s.id); render(); }, 'btn small red'));
      m.appendChild(r);
    }
    m.appendChild(btn('+ Add sound files', async () => { C = await tt.addSounds(); render(); }));
    body.appendChild(m);
  }

  // ---------------------------------------------------------------- Actions
  const TRIGGERS = [['gift', '🎁 Gift'], ['follow', '➕ Follow'], ['share', '🔁 Share'], ['subscribe', '⭐ Subscribe'], ['likes', '❤️ Every N likes'], ['command', '⌨️ Chat command'], ['chat', '💬 Chat contains'], ['join', '👋 Viewer joins']];
  const ACTION_KINDS = [['sound', '🔊 Play sound'], ['tts', '🗣️ Say'], ['alert', '🔔 Show alert'], ['keys', '⌨️ Press keys on PC'], ['quest', '🥽 Show on Quest']];

  function renderActions(body) {
    const intro = card('Actions & events', 'When something happens on your LIVE, do things: play sounds, say text, show alerts, or press keys in a game. Use {name}, {gift}, {count}, {diamonds}, {text} in text.');
    intro.appendChild(btn('+ New action', () => {
      C.actions.push({ id: 'a-' + Math.random().toString(36).slice(2, 8), enabled: true, name: 'New action', trigger: { type: 'gift', gift: '' }, do: [{ kind: 'sound', sound: 'airhorn' }], cooldown: 0 });
      save(); render();
    }));
    body.appendChild(intro);
    C.actions.forEach((a, i) => body.appendChild(actionCard(a, i)));
  }

  function actionCard(a, i) {
    const p = `actions.${i}`;
    const c = document.createElement('div');
    c.className = 'card sec action';
    const head = document.createElement('div'); head.className = 'row';
    head.appendChild(toggle(`${p}.enabled`));
    const name = text(`${p}.name`, 'Name', 260); name.classList.add('aname');
    head.appendChild(name);
    head.appendChild(btn('Delete', () => { C.actions.splice(i, 1); save(); render(); }, 'btn small red'));
    c.appendChild(head);

    const when = document.createElement('div'); when.className = 'row'; when.style.marginTop = '10px';
    when.innerHTML = '<b>When</b>';
    when.appendChild(select(`${p}.trigger.type`, TRIGGERS, () => render()));
    const t = a.trigger.type;
    if (t === 'gift') {
      const g = text(`${p}.trigger.gift`, 'any gift (or e.g. Rose)', 170); when.appendChild(g);
      when.appendChild(document.createTextNode(' worth at least '));
      when.appendChild(num(`${p}.trigger.minDiamonds`, 0, 100000, 90)); when.appendChild(document.createTextNode(' 💎'));
    } else if (t === 'likes') { when.appendChild(num(`${p}.trigger.likes`, 1, 1000000)); when.appendChild(document.createTextNode(' likes')); }
    else if (t === 'command') when.appendChild(text(`${p}.trigger.command`, '!jump', 130));
    else if (t === 'chat') when.appendChild(text(`${p}.trigger.keyword`, 'word', 160));
    c.appendChild(when);

    (a.do || []).forEach((d, j) => {
      const q = `${p}.do.${j}`;
      const r = document.createElement('div'); r.className = 'row'; r.style.marginTop = '8px';
      r.innerHTML = `<b>${j === 0 ? 'Do' : 'and'}</b>`;
      r.appendChild(select(`${q}.kind`, ACTION_KINDS, () => render()));
      if (d.kind === 'sound') { r.appendChild(select(`${q}.sound`, soundOptions())); r.appendChild(btn('▶', () => playSound(d.sound, C.sounds.volume), 'btn small dark')); }
      else if (d.kind === 'tts' || d.kind === 'alert' || d.kind === 'quest') r.appendChild(text(`${q}.text`, d.kind === 'tts' ? '{name} sent {gift}!' : 'Text to show', 300));
      else if (d.kind === 'keys') {
        r.appendChild(text(`${q}.keys`, 'e.g. space, w, ctrl+r', 170));
        r.appendChild(document.createTextNode(' hold ')); r.appendChild(num(`${q}.hold`, 10, 5000, 80)); r.appendChild(document.createTextNode(' ms ×'));
        r.appendChild(num(`${q}.repeat`, 1, 20, 60));
        r.appendChild(btn('Test', async () => { const res = await tt.testKeys(d.keys); if (!res.ok) alert('Key press failed: ' + res.message); }, 'btn small dark'));
      }
      r.appendChild(btn('✕', () => { a.do.splice(j, 1); save(); render(); }, 'btn small dark'));
      c.appendChild(r);
    });
    const add = document.createElement('div'); add.className = 'row'; add.style.marginTop = '8px';
    add.appendChild(btn('+ Add a thing to do', () => { a.do.push({ kind: 'sound', sound: 'ding' }); save(); render(); }, 'btn small dark'));
    add.appendChild(document.createTextNode('  Cooldown '));
    add.appendChild(num(`${p}.cooldown`, 0, 3600, 80));
    add.appendChild(document.createTextNode(' s  · per viewer '));
    add.appendChild(num(`${p}.userCooldown`, 0, 3600, 80));
    add.appendChild(document.createTextNode(' s'));
    c.appendChild(add);
    return c;
  }

  // ---------------------------------------------------------------- Goals
  function renderGoals(body) {
    const c = card('Goals', 'Progress bars on the Goals overlay. They count from when you connect.');
    C.goals.forEach((g, i) => {
      const r = document.createElement('div'); r.className = 'row'; r.style.marginTop = '8px';
      r.appendChild(text(`goals.${i}.title`, 'Title', 200));
      r.appendChild(select(`goals.${i}.kind`, [['likes', '❤️ Likes'], ['follows', '➕ Follows'], ['diamonds', '💎 Diamonds'], ['shares', '🔁 Shares'], ['subs', '⭐ Subs'], ['viewers', '👀 Viewers']]));
      r.appendChild(document.createTextNode(' target '));
      r.appendChild(num(`goals.${i}.target`, 1, 100000000, 120));
      const cur = state ? (state.goals.find((x) => x.id === g.id) || {}).current : 0;
      const pr = document.createElement('span'); pr.className = 'hint'; pr.textContent = `now ${fmt(cur)}`;
      r.appendChild(pr);
      r.appendChild(btn('✕', () => { C.goals.splice(i, 1); save(); render(); }, 'btn small dark'));
      c.appendChild(r);
    });
    c.appendChild(btn('+ New goal', () => { C.goals.push({ id: 'g-' + Math.random().toString(36).slice(2, 8), kind: 'likes', target: 1000, title: 'New goal' }); save(); render(); }));
    body.appendChild(c);
  }

  // ---------------------------------------------------------------- Overlays
  function renderOverlays(body) {
    const h = card('Add overlays to your LIVE',
      'TikTok LIVE Studio: Add source → Link (or Web), then paste a link. OBS: Add → Browser source. Size 1080 × 1920 for vertical. Each overlay is see-through.');
    h.appendChild(row('Overlay style', '', seg('overlay.theme', [['gold', 'Cartoony gold'], ['clean', 'Clean']])));
    h.appendChild(row('Chat messages shown', '', num('overlay.chatMax', 3, 30)));
    h.appendChild(row('Show profile pictures', '', toggle('overlay.showAvatars')));
    body.appendChild(h);
    const c = card('Links');
    for (const o of info.overlays) {
      const r = document.createElement('div'); r.className = 'row ourl';
      r.innerHTML = `<b style="min-width:240px">${esc(o.name)}</b><code>${esc(o.url)}</code>`;
      r.appendChild(btn('Copy', () => { navigator.clipboard.writeText(o.url); b.textContent = 'Copied!'; setTimeout(() => (b.textContent = 'Copy'), 1200); }, 'btn small'));
      const b = r.lastChild;
      r.appendChild(btn('Preview', () => window.casnt.openUrl(o.url), 'btn small dark'));
      c.appendChild(r);
    }
    c.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'Tip: add "?max=5" to a chat, gifts or leaderboard link to change how many rows it shows. Goals take "?goal=likes".' }));
    body.appendChild(c);
  }

  // ---------------------------------------------------------------- Points
  function renderPoints(body) {
    const c = card('Viewer points', 'Viewers earn points for watching along. They can type the commands in chat and TTS answers.');
    c.appendChild(row('Points on', '', toggle('points.enabled')));
    c.appendChild(row('Per chat message', '', num('points.perChat', 0, 1000)));
    c.appendChild(row('Per like', '', num('points.perLike', 0, 1000)));
    c.appendChild(row('Per follow', '', num('points.perFollow', 0, 100000)));
    c.appendChild(row('Per share', '', num('points.perShare', 0, 100000)));
    c.appendChild(row('Per diamond gifted', '', num('points.perDiamond', 0, 100000)));
    c.appendChild(row('"My points" command', '', text('points.command', '!points', 120)));
    c.appendChild(row('"Top viewers" command', '', text('points.topCommand', '!top', 120)));
    body.appendChild(c);
    const t = card('Leaderboard');
    t.innerHTML += '<div id="tt-points"></div>';
    body.appendChild(t);
    renderPointsTable();
  }
  function renderPointsTable() {
    const el = $('tt-points');
    if (!el || !state) return;
    el.innerHTML = state.points.map((p, i) => `<div class="fitem"><b>${i + 1}.</b> ${esc(p.name)} <span class="hint">${fmt(p.points)} pts</span></div>`).join('') || '<div class="hint">No points yet.</div>';
  }

  // ---------------------------------------------------------------- More
  function renderMore(body) {
    const c = card('Connection');
    c.appendChild(row('Connect when Casnt starts', 'Uses the username on the Live tab', toggle('autoConnect')));
    c.appendChild(row('Euler Stream API key', 'Optional. Only needed if TikTok connecting gets rate-limited (free key at eulerstream.com).', text('signApiKey', 'optional', 260)));
    body.appendChild(c);
    const q = card('On your Quest', 'Open Casnt on your Quest and press TikTok LIVE: you get the live feed, stats, TTS skip/toggle, a soundboard and test buttons. The full controls stay here on the PC.');
    body.appendChild(q);
    body.appendChild(spotifyCard());
  }

  // ---------------------------------------------------------------- Cast Player account (also shown in Settings)
  function spotifyCard() {
    const c = card('Cast Player (Spotify)', 'Play/pause/next/back work with any Spotify account. To search songs and open your playlists from the Quest, link Spotify once (free):');
    const steps = document.createElement('ol');
    steps.className = 'req-list';
    steps.innerHTML = '<li>Go to developer.spotify.com → Dashboard → Create app (any name).</li><li>Redirect URI: <code>http://127.0.0.1:47831/callback</code> and tick "Web API".</li><li>Copy the Client ID into the box below and press Link.</li><li>Picking songs from the Quest needs Spotify Premium. Without it, Casnt opens the song in Spotify on your PC.</li>';
    c.appendChild(steps);
    const r = document.createElement('div'); r.className = 'row';
    const idBox = document.createElement('input'); idBox.className = 'tin'; idBox.style.width = '330px'; idBox.placeholder = 'Spotify Client ID';
    const st = document.createElement('span'); st.className = 'hint';
    window.casnt.sp.status().then((s) => { idBox.value = s.clientId; st.textContent = s.linked ? '✅ Linked' : 'Not linked'; });
    r.appendChild(idBox);
    r.appendChild(btn('Link Spotify', async () => { st.textContent = 'Finish the login in your browser…'; const res = await window.casnt.sp.link(idBox.value); st.textContent = res.ok ? '✅ Linked' : '❌ ' + res.message; }));
    r.appendChild(btn('Unlink', async () => { await window.casnt.sp.unlink(); st.textContent = 'Not linked'; }, 'btn small dark'));
    r.appendChild(st);
    c.appendChild(r);
    return c;
  }
  window.casntSpotifyCard = spotifyCard;

  // ================================================================ entry: the LIVE Studio question first
  let introDone = false;
  try { introDone = localStorage.getItem('casnt-tt-intro') === '1'; } catch (_) { /* no storage */ }
  async function openArea() {
    $('tt-ask').style.display = 'none';
    $('tt-area').style.display = '';
    const g = await tt.get();
    C = g.cfg; info = g; state = g.state; status = g.status;
    paintBadge();
    render();
  }
  $('tt-cancel').onclick = () => document.querySelector('[data-go="home"]').click();
  $('tt-confirm').onclick = async () => {
    const r = await window.casnt.tiktokCheck();
    const box = $('tt-result');
    if (r.installed) {
      try { localStorage.setItem('casnt-tt-intro', '1'); } catch (_) { /* ignore */ }
      openArea();
    } else {
      box.innerHTML = '<div class="hint" style="margin-bottom:10px">TikTok LIVE Studio wasn\'t found on this PC.</div>';
      const row1 = document.createElement('div'); row1.className = 'row';
      row1.appendChild(btn('Download LIVE Studio', () => window.casnt.openUrl(r.downloadUrl)));
      row1.appendChild(btn('Continue anyway (OBS etc.)', () => { try { localStorage.setItem('casnt-tt-intro', '1'); } catch (_) { /* ignore */ } openArea(); }, 'btn small dark'));
      box.appendChild(row1);
    }
  };
  if (introDone) openArea();
  else tt.get().then((g) => { C = g.cfg; status = g.status; paintBadge(); });
})();
