/* Casnt overlay client: listens to the Casnt app and draws one widget. */
(function () {
  'use strict';
  const widget = document.body.dataset.widget;
  const root = document.getElementById('root');
  const q = new URLSearchParams(location.search);
  let state = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const av = (url) => (url && state && state.overlay.showAvatars !== false ? `<img class="av" src="${esc(url)}" referrerpolicy="no-referrer">` : '');

  // ---------------- alerts (queued, one at a time) ----------------
  const alertQueue = [];
  let showing = false;
  const alertWrap = document.createElement('div');
  alertWrap.className = 'alert-wrap';
  function nextAlert() {
    if (showing || !alertQueue.length) return;
    showing = true;
    const a = alertQueue.shift();
    const el = document.createElement('div');
    el.className = 'alert';
    const pic = a.image ? `<img src="${esc(a.image)}" referrerpolicy="no-referrer">` : (a.avatar ? `<img class="av" src="${esc(a.avatar)}" referrerpolicy="no-referrer">` : '');
    el.innerHTML = `${pic}<div>${esc(a.title)}${a.text ? `<small>${esc(a.text)}</small>` : ''}</div>`;
    alertWrap.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); showing = false; nextAlert(); }, 380); }, Math.max(2, a.duration || 5) * 1000);
  }

  // ---------------- widgets ----------------
  function goals() {
    const only = q.get('goal');
    return `<div class="box">${state.goals.filter((g) => !only || g.id === only || g.kind === only).map((g) => {
      const pct = Math.min(100, (g.current / Math.max(1, g.target)) * 100);
      return `<div class="goal"><div class="title">${esc(g.title)}</div><div class="bar"><div class="fill" style="width:${pct}%"></div><div class="txt">${fmt(g.current)} / ${fmt(g.target)}</div></div></div>`;
    }).join('')}</div>`;
  }
  function chat() {
    const max = Number(q.get('max')) || state.overlay.chatMax || 10;
    return `<div class="chat">${state.chat.slice(-max).map((m) => `<div class="msg">${av(m.avatar)}<div><b>${esc(m.name)}</b>${esc(m.text)}</div></div>`).join('')}</div>`;
  }
  function leaderboard() {
    return `<div class="box"><div class="title">Top gifters</div>${state.leaderboard.slice(0, Number(q.get('max')) || 5).map((g, i) =>
      `<div class="row"><span class="rank">${i + 1}</span>${av(g.avatar)}<span class="grow">${esc(g.name)}</span><span class="val">💎 ${fmt(g.diamonds)}</span></div>`).join('') || '<div class="row">No gifts yet</div>'}</div>`;
  }
  function points() {
    return `<div class="box"><div class="title">Top viewers</div>${state.points.slice(0, Number(q.get('max')) || 5).map((p, i) =>
      `<div class="row"><span class="rank">${i + 1}</span>${av(p.avatar)}<span class="grow">${esc(p.name)}</span><span class="val">${fmt(p.points)} pts</span></div>`).join('') || '<div class="row">No points yet</div>'}</div>`;
  }
  function gifts() {
    return `<div class="box"><div class="title">Recent gifts</div>${state.gifts.slice(-(Number(q.get('max')) || 6)).reverse().map((g) =>
      `<div class="gift row">${g.image ? `<img src="${esc(g.image)}" referrerpolicy="no-referrer">` : '🎁'}<span class="grow">${esc(g.name)} · ${g.count > 1 ? g.count + '× ' : ''}${esc(g.gift)}</span><span class="val">💎 ${fmt(g.diamonds)}</span></div>`).join('') || '<div class="row">No gifts yet</div>'}</div>`;
  }
  function counters() {
    const s = state.stats;
    const c = (n, l) => `<div class="box counter"><div class="n">${fmt(n)}</div><div class="l">${l}</div></div>`;
    return `<div class="counters">${c(s.viewers, 'viewers')}${c(s.likes, 'likes')}${c(s.follows, 'new follows')}${c(s.diamonds, 'diamonds')}</div>`;
  }

  function render() {
    if (!state) return;
    document.body.classList.toggle('clean', state.overlay.theme === 'clean');
    const parts = {
      alerts: () => '', chat, goals, leaderboard, gifts, counters, points,
      all: () => counters() + goals() + leaderboard(),
    };
    root.innerHTML = (parts[widget] || parts.all)();
    if (widget === 'alerts' || widget === 'all') root.appendChild(alertWrap);
  }

  // ---------------- live connection ----------------
  function connect() {
    const es = new EventSource('/events');
    es.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });
    es.addEventListener('alert', (e) => {
      if (widget !== 'alerts' && widget !== 'all') return;
      alertQueue.push(JSON.parse(e.data)); nextAlert();
    });
    es.addEventListener('sound', (e) => {
      if (widget !== 'alerts' && widget !== 'all') return; // only one overlay plays sounds
      const s = JSON.parse(e.data);
      window.CasntSfx.play(s.sound, s.volume, s.url);
    });
    es.onerror = () => { es.close(); setTimeout(connect, 2000); };
  }
  connect();
})();
