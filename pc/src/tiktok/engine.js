// Casnt TikTok LIVE engine (the "Tikfinity" part): stats, goals, leaderboard, points,
// TTS filtering, sound/alert/key actions. Pure logic: feed it events, it emits commands.
'use strict';
const { EventEmitter } = require('events');

const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_TIKTOK = {
  username: '',
  autoConnect: false,
  signApiKey: '',
  tts: {
    enabled: true,
    mode: 'all',          // all | command | gifters | followers
    command: '!tts',
    voice: '',            // empty = Windows default voice
    rate: 1, pitch: 1, volume: 90,
    maxLength: 140,
    sayName: true,
    readGifts: true,
    readFollows: false,
    skipLinks: true,
    userCooldown: 0,      // seconds between messages from the same viewer
    queueMax: 8,
    blockedWords: '',
    blockedUsers: '',
  },
  alerts: {
    enabled: true,
    gifts: true, minDiamonds: 1,
    follows: true, shares: true, subscribes: true,
    likeMilestone: 1000,
    duration: 5,
    giftSound: 'coin', followSound: 'ding', shareSound: 'whoosh', subSound: 'fanfare', likeSound: 'levelup',
  },
  sounds: {
    enabled: true,
    volume: 80,
    playOn: 'pc',         // pc | overlay | both
    chatCommand: true,
    command: '!sound',
    commandCooldown: 15,
    custom: [],           // [{ id, name, file }]
  },
  points: { enabled: true, perChat: 1, perLike: 1, perFollow: 50, perShare: 20, perDiamond: 10, command: '!points', topCommand: '!top' },
  goals: [
    { id: 'g-likes', kind: 'likes', target: 10000, title: 'Like goal' },
    { id: 'g-follows', kind: 'follows', target: 50, title: 'Follower goal' },
    { id: 'g-diamonds', kind: 'diamonds', target: 1000, title: 'Gift goal' },
  ],
  actions: [
    { id: 'a-rose', enabled: true, name: 'Rose = pop', trigger: { type: 'gift', gift: 'Rose' }, do: [{ kind: 'sound', sound: 'pop' }], cooldown: 0 },
    { id: 'a-big', enabled: true, name: 'Big gift hype', trigger: { type: 'gift', gift: '', minDiamonds: 99 },
      do: [{ kind: 'sound', sound: 'airhorn' }, { kind: 'tts', text: 'Wow! {name} sent {count} {gift}!' }], cooldown: 0 },
    { id: 'a-follow', enabled: true, name: 'New follower', trigger: { type: 'follow' }, do: [{ kind: 'sound', sound: 'ding' }], cooldown: 2 },
    { id: 'a-likes', enabled: true, name: 'Every 500 likes', trigger: { type: 'likes', likes: 500 }, do: [{ kind: 'sound', sound: 'applause' }], cooldown: 0 },
    { id: 'a-jump', enabled: false, name: '!jump presses Space', trigger: { type: 'command', command: '!jump' },
      do: [{ kind: 'keys', keys: 'space', hold: 80 }], cooldown: 3 },
  ],
  overlay: { theme: 'gold', chatMax: 10, showAvatars: true },
};

function fill(template, ev) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => {
    const v = {
      name: ev.user && ev.user.name, user: ev.user && ev.user.uniqueId, gift: ev.gift, count: ev.count,
      diamonds: ev.diamonds, text: ev.text, likes: ev.count, total: ev.total,
    }[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

const listOf = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);

class TikTokEngine extends EventEmitter {
  constructor(config) {
    super();
    this.setConfig(config || {});
    this.resetStats();
  }

  setConfig(cfg) {
    const d = DEFAULT_TIKTOK;
    this.cfg = {
      ...d, ...cfg,
      tts: { ...d.tts, ...(cfg.tts || {}) },
      alerts: { ...d.alerts, ...(cfg.alerts || {}) },
      sounds: { ...d.sounds, ...(cfg.sounds || {}) },
      points: { ...d.points, ...(cfg.points || {}) },
      overlay: { ...d.overlay, ...(cfg.overlay || {}) },
      goals: Array.isArray(cfg.goals) ? cfg.goals : d.goals,
      actions: Array.isArray(cfg.actions) ? cfg.actions : d.actions,
    };
  }

  resetStats() {
    this.stats = { viewers: 0, likes: 0, diamonds: 0, follows: 0, shares: 0, subs: 0, joins: 0, chats: 0 };
    this.gifters = new Map();   // uniqueId -> { name, avatar, diamonds }
    this.points = new Map();    // uniqueId -> { name, avatar, points }
    this.chat = [];
    this.gifts = [];
    this.lastFollower = null;
    this.lastUserTime = new Map();
    this.ruleTime = new Map();
    this.likeMarks = new Map(); // rule id / 'milestone' -> last multiple reached
    this.emitState();
  }

  // ------------------------------------------------------------ helpers
  command(c) { this.emit('command', c); }

  addPoints(user, n) {
    if (!this.cfg.points.enabled || !n || !user || !user.uniqueId) return;
    const p = this.points.get(user.uniqueId) || { name: user.name, avatar: user.avatar, points: 0 };
    p.points += n; p.name = user.name; p.avatar = user.avatar || p.avatar;
    this.points.set(user.uniqueId, p);
  }

  leaderboard(n = 10) {
    return [...this.gifters.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, n);
  }

  topPoints(n = 10) {
    return [...this.points.values()].sort((a, b) => b.points - a.points).slice(0, n);
  }

  goalValue(kind) {
    return { likes: this.stats.likes, follows: this.stats.follows, diamonds: this.stats.diamonds, shares: this.stats.shares, subs: this.stats.subs, viewers: this.stats.viewers }[kind] || 0;
  }

  getState() {
    return {
      stats: { ...this.stats },
      goals: this.cfg.goals.map((g) => ({ ...g, current: this.goalValue(g.kind) })),
      leaderboard: this.leaderboard(),
      points: this.topPoints(),
      chat: this.chat.slice(-30),
      gifts: this.gifts.slice(-20),
      lastFollower: this.lastFollower,
      overlay: this.cfg.overlay,
    };
  }

  emitState() {
    // batch state pushes (likes can arrive very fast)
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => { this.stateTimer = null; this.emit('state', this.getState()); }, 150);
    if (this.stateTimer.unref) this.stateTimer.unref();
  }

  soundExists(name) {
    const { SOUND_IDS } = require('./sfx-list');
    const n = String(name || '').toLowerCase();
    return SOUND_IDS.includes(n) || this.cfg.sounds.custom.some((s) => s.name.toLowerCase() === n || s.id === n);
  }

  playSound(sound) {
    if (!this.cfg.sounds.enabled || !sound) return;
    this.command({ kind: 'sound', sound, volume: this.cfg.sounds.volume, playOn: this.cfg.sounds.playOn });
  }

  alert(type, ev, title, sound) {
    const a = this.cfg.alerts;
    if (!a.enabled) return;
    this.command({
      kind: 'alert',
      alert: {
        type, title, text: ev.text || '', image: ev.image || '', avatar: ev.user ? ev.user.avatar : '',
        name: ev.user ? ev.user.name : '', duration: a.duration,
      },
    });
    if (sound) this.playSound(sound);
  }

  // ------------------------------------------------------------ TTS
  ttsFromChat(ev) {
    const t = this.cfg.tts;
    if (!t.enabled) return;
    let text = ev.text.trim();
    const cmd = String(t.command || '!tts').toLowerCase();
    const isCmd = text.toLowerCase().startsWith(cmd + ' ');
    if (t.mode === 'command' && !isCmd) return;
    if (isCmd) text = text.slice(cmd.length).trim();
    else if (text.startsWith('!')) return; // other commands aren't read out
    const name = (ev.user.uniqueId || '').toLowerCase();
    if (t.mode === 'gifters' && !this.gifters.has(ev.user.uniqueId)) return;
    if (t.mode === 'followers' && !ev.user.follower) return;
    if (listOf(t.blockedUsers).includes(name)) return;
    const low = text.toLowerCase();
    if (listOf(t.blockedWords).some((w) => low.includes(w))) return;
    if (t.skipLinks) text = text.replace(/https?:\/\/\S+|www\.\S+/gi, '').trim();
    if (!text) return;
    if (t.userCooldown > 0) {
      const last = this.lastUserTime.get('tts:' + name) || 0;
      if (Date.now() - last < t.userCooldown * 1000) return;
      this.lastUserTime.set('tts:' + name, Date.now());
    }
    text = text.slice(0, Math.max(10, Number(t.maxLength) || 140));
    this.command({ kind: 'tts', text: t.sayName ? `${ev.user.name} says ${text}` : text, user: ev.user.uniqueId });
  }

  say(text) {
    if (this.cfg.tts.enabled && text) this.command({ kind: 'tts', text, user: '' });
  }

  // ------------------------------------------------------------ actions
  ruleMatches(rule, ev) {
    const t = rule.trigger || {};
    if (t.type === 'gift') {
      if (ev.type !== 'gift' || ev.streaking) return false;
      if (t.gift && t.gift.toLowerCase() !== ev.gift.toLowerCase()) return false;
      if (t.minDiamonds && ev.diamonds * ev.count < t.minDiamonds) return false;
      return true;
    }
    if (t.type === 'command') {
      if (ev.type !== 'chat') return false;
      const c = String(t.command || '').toLowerCase().trim();
      return !!c && (ev.text.toLowerCase() === c || ev.text.toLowerCase().startsWith(c + ' '));
    }
    if (t.type === 'chat') {
      if (ev.type !== 'chat') return false;
      return !t.keyword || ev.text.toLowerCase().includes(String(t.keyword).toLowerCase());
    }
    if (t.type === 'likes') {
      if (ev.type !== 'like') return false;
      const every = Math.max(1, Number(t.likes) || 100);
      const mark = Math.floor(this.stats.likes / every);
      const prev = this.likeMarks.get(rule.id) ?? Math.floor((this.stats.likes - ev.count) / every);
      this.likeMarks.set(rule.id, mark);
      return mark > prev;
    }
    return ev.type === t.type; // follow | share | subscribe | join
  }

  runActions(rule, ev) {
    const now = Date.now();
    if (rule.cooldown > 0) {
      const last = this.ruleTime.get(rule.id) || 0;
      if (now - last < rule.cooldown * 1000) return;
    }
    if (rule.userCooldown > 0 && ev.user) {
      const k = rule.id + ':' + ev.user.uniqueId;
      if (now - (this.ruleTime.get(k) || 0) < rule.userCooldown * 1000) return;
      this.ruleTime.set(k, now);
    }
    this.ruleTime.set(rule.id, now);
    for (const a of rule.do || []) {
      if (a.kind === 'sound') this.playSound(a.sound);
      else if (a.kind === 'tts') this.say(fill(a.text, ev));
      else if (a.kind === 'alert') this.command({ kind: 'alert', alert: { type: 'custom', title: fill(a.text || rule.name, ev), text: '', image: a.image || ev.image || '', avatar: ev.user ? ev.user.avatar : '', name: ev.user ? ev.user.name : '', duration: this.cfg.alerts.duration } });
      else if (a.kind === 'keys') this.command({ kind: 'keys', keys: a.keys, hold: Number(a.hold) || 60, repeat: Math.min(20, Number(a.repeat) || 1) });
      else if (a.kind === 'quest') this.command({ kind: 'quest', text: fill(a.text, ev) });
    }
  }

  // ------------------------------------------------------------ main entry
  handle(ev) {
    if (!ev || !ev.type) return;
    const s = this.stats;
    const al = this.cfg.alerts;
    switch (ev.type) {
      case 'viewers': s.viewers = ev.count; break;
      case 'join': s.joins++; break;
      case 'chat': {
        s.chats++;
        this.chat.push({ name: ev.user.name, avatar: ev.user.avatar, text: ev.text, t: Date.now() });
        if (this.chat.length > 60) this.chat.shift();
        this.addPoints(ev.user, this.cfg.points.perChat);
        this.chatCommands(ev);
        this.ttsFromChat(ev);
        break;
      }
      case 'like': {
        s.likes = Math.max(s.likes + ev.count, ev.total || 0);
        this.addPoints(ev.user, this.cfg.points.perLike * ev.count);
        const every = Number(al.likeMilestone) || 0;
        if (every > 0) {
          const mark = Math.floor(s.likes / every);
          const prev = this.likeMarks.get('milestone') ?? Math.floor((s.likes - ev.count) / every);
          this.likeMarks.set('milestone', mark);
          if (mark > prev) this.alert('likes', { ...ev, text: '' }, `${(mark * every).toLocaleString()} likes!`, al.likeSound);
        }
        break;
      }
      case 'follow':
        s.follows++;
        this.lastFollower = { name: ev.user.name, avatar: ev.user.avatar };
        this.addPoints(ev.user, this.cfg.points.perFollow);
        if (al.follows) this.alert('follow', ev, `${ev.user.name} followed!`, al.followSound);
        if (this.cfg.tts.readFollows) this.say(`Thanks for the follow, ${ev.user.name}!`);
        break;
      case 'share':
        s.shares++;
        this.addPoints(ev.user, this.cfg.points.perShare);
        if (al.shares) this.alert('share', ev, `${ev.user.name} shared the LIVE!`, al.shareSound);
        break;
      case 'subscribe':
        s.subs++;
        if (al.subscribes) this.alert('subscribe', ev, `${ev.user.name} subscribed!`, al.subSound);
        break;
      case 'gift': {
        if (ev.streaking) break; // wait for the streak to finish
        const total = ev.diamonds * ev.count;
        s.diamonds += total;
        const g = this.gifters.get(ev.user.uniqueId) || { name: ev.user.name, avatar: ev.user.avatar, diamonds: 0 };
        g.diamonds += total; g.name = ev.user.name; g.avatar = ev.user.avatar || g.avatar;
        this.gifters.set(ev.user.uniqueId, g);
        this.gifts.push({ name: ev.user.name, avatar: ev.user.avatar, gift: ev.gift, image: ev.image, count: ev.count, diamonds: total, t: Date.now() });
        if (this.gifts.length > 40) this.gifts.shift();
        this.addPoints(ev.user, this.cfg.points.perDiamond * total);
        if (al.gifts && total >= (Number(al.minDiamonds) || 0)) {
          this.alert('gift', ev, `${ev.user.name} sent ${ev.count > 1 ? ev.count + '× ' : ''}${ev.gift}!`, al.giftSound);
        }
        if (this.cfg.tts.readGifts) this.say(`${ev.user.name} sent ${ev.count > 1 ? ev.count + ' ' : ''}${ev.gift}. Thank you!`);
        break;
      }
      case 'end': break;
      default: return;
    }
    for (const rule of this.cfg.actions) {
      if (rule.enabled === false) continue;
      try { if (this.ruleMatches(rule, ev)) this.runActions(rule, ev); } catch (_) { /* a bad rule never breaks the LIVE */ }
    }
    this.emit('feed', ev);
    this.emitState();
  }

  chatCommands(ev) {
    const text = ev.text.trim().toLowerCase();
    const sc = this.cfg.sounds;
    if (sc.chatCommand && text.startsWith(String(sc.command || '!sound').toLowerCase() + ' ')) {
      const name = text.slice(String(sc.command).length).trim();
      const key = 'snd:' + ev.user.uniqueId;
      const last = this.lastUserTime.get(key) || 0;
      if (this.soundExists(name) && Date.now() - last >= (Number(sc.commandCooldown) || 0) * 1000) {
        this.lastUserTime.set(key, Date.now());
        const custom = sc.custom.find((s) => s.name.toLowerCase() === name);
        this.playSound(custom ? custom.id : name);
      }
    }
    const pc = this.cfg.points;
    if (pc.enabled && text === String(pc.command || '!points').toLowerCase()) {
      const p = this.points.get(ev.user.uniqueId);
      this.say(`${ev.user.name} has ${p ? p.points : 0} points`);
    }
    if (pc.enabled && text === String(pc.topCommand || '!top').toLowerCase()) {
      const top = this.topPoints(3).map((p, i) => `${i + 1}. ${p.name} with ${p.points}`).join(', ');
      if (top) this.say(`Top viewers: ${top}`);
    }
  }

  // ------------------------------------------------------------ test events
  simulate(type) {
    const names = ['GeoFan', 'PixelPanda', 'NoodleKing', 'Skyler', 'LunaBee', 'CrispyTaco'];
    const n = names[Math.floor(Math.random() * names.length)];
    const user = { id: 't-' + n, uniqueId: n.toLowerCase(), name: n, avatar: '', follower: true };
    const ev = {
      chat: { type: 'chat', user, text: ['hello!', 'this is so cool', '!tts Casnt test message', '!sound airhorn', '!points'][Math.floor(Math.random() * 5)] },
      gift: { type: 'gift', user, gift: 'Rose', giftId: 5655, diamonds: 1, image: '', count: 5, streaking: false },
      biggift: { type: 'gift', user, gift: 'Galaxy', giftId: 11046, diamonds: 1000, image: '', count: 1, streaking: false },
      follow: { type: 'follow', user },
      share: { type: 'share', user },
      subscribe: { type: 'subscribe', user },
      like: { type: 'like', user, count: 250, total: 0 },
    }[type];
    if (ev) this.handle(ev);
  }
}

module.exports = { TikTokEngine, DEFAULT_TIKTOK, fill, uid };
