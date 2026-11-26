// TikTok LIVE connection: turns TikTok's raw events into simple Casnt events.
// Uses tiktok-live-connector (AGPL-3.0) for the actual webcast connection.
'use strict';
const { EventEmitter } = require('events');

/** Pull a usable picture URL out of the many shapes TikTok uses. */
function pic(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  const list = p.urls || p.url || p.urlList || p.mUrls || p.url_list;
  if (Array.isArray(list) && list.length) return String(list[0]);
  return p.giftPictureUrl || '';
}

function normUser(u) {
  u = u || {};
  return {
    id: String(u.userId || u.uniqueId || ''),
    uniqueId: String(u.uniqueId || ''),
    name: String(u.nickname || u.uniqueId || 'someone'),
    avatar: pic(u.profilePicture) || pic(u.avatarThumb) || pic(u.avatarLarge) || u.profilePictureUrl || '',
    follower: !!(u.followInfo && u.followInfo.followStatus) || u.followRole >= 1,
  };
}

/** Normalise one raw connector event into a Casnt event (or null to ignore). */
function normalize(type, d) {
  d = d || {};
  const user = normUser(d.user);
  switch (type) {
    case 'chat':
      return { type: 'chat', user, text: String(d.comment || '').slice(0, 500) };
    case 'gift': {
      const g = d.giftDetails || d.gift || {};
      const giftType = Number(g.giftType ?? d.giftType ?? 0);
      const repeat = Number(d.repeatCount || 1);
      const ended = !!d.repeatEnd;
      return {
        type: 'gift', user,
        giftId: Number(d.giftId || g.id || 0),
        gift: String(g.giftName || d.giftName || g.name || 'Gift'),
        diamonds: Number(g.diamondCount ?? d.diamondCount ?? g.diamond_count ?? 0),
        image: pic(g.giftImage) || d.giftPictureUrl || pic(g.image) || '',
        count: repeat,
        // streakable gifts send several events; only the last one counts
        streaking: giftType === 1 && !ended,
      };
    }
    case 'like':
      return { type: 'like', user, count: Number(d.likeCount || 1), total: Number(d.totalLikeCount || 0) };
    case 'follow':
      return { type: 'follow', user };
    case 'share':
      return { type: 'share', user };
    case 'member':
      return { type: 'join', user };
    case 'subscribe':
      return { type: 'subscribe', user };
    case 'roomUser':
      return { type: 'viewers', count: Number(d.viewerCount || 0) };
    case 'streamEnd':
      return { type: 'end' };
    default:
      return null;
  }
}

const RAW = {
  chat: 'chat', gift: 'gift', like: 'like', follow: 'follow', share: 'share',
  member: 'member', roomUser: 'roomUser', streamEnd: 'streamEnd', subNotify: 'subscribe', superFanJoin: 'subscribe',
};

class TikTokLive extends EventEmitter {
  constructor() {
    super();
    this.conn = null;
    this.username = '';
    this.status = 'offline'; // offline | connecting | live | waiting | error
    this.message = '';
    this.wantOnline = false;
    this.retryTimer = null;
    this.retries = 0;
  }

  setStatus(status, message = '') {
    this.status = status;
    this.message = message;
    this.emit('status', { status, message, username: this.username });
  }

  async connect(username, { signApiKey } = {}) {
    username = String(username || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?tiktok\.com\/@/, '').split(/[/?]/)[0];
    if (!username) { this.setStatus('error', 'Type your TikTok username first.'); return; }
    await this.disconnect();
    this.username = username;
    this.wantOnline = true;
    this.retries = 0;
    this.open({ signApiKey });
  }

  async open(opts) {
    let TikTokLiveConnection;
    try { ({ TikTokLiveConnection } = require('tiktok-live-connector')); } catch (e) {
      this.setStatus('error', 'TikTok connector is missing: ' + e.message); return;
    }
    this.setStatus('connecting', `Connecting to @${this.username}…`);
    const conn = new TikTokLiveConnection(this.username, {
      processInitialData: false,
      enableExtendedGiftInfo: true,
      ...(opts.signApiKey ? { signApiKey: opts.signApiKey } : {}),
    });
    this.conn = conn;
    for (const [raw, kind] of Object.entries(RAW)) {
      conn.on(raw, (d) => {
        const ev = normalize(kind, d);
        if (ev) this.emit('event', ev);
        if (kind === 'streamEnd') this.setStatus('waiting', 'The LIVE ended.');
      });
    }
    conn.on('disconnected', () => {
      if (this.conn !== conn) return;
      if (this.wantOnline) this.scheduleRetry(opts, 'Disconnected, reconnecting…');
      else this.setStatus('offline');
    });
    conn.on('error', (e) => this.emit('log', String(e && e.message || e)));
    try {
      const state = await conn.connect();
      if (this.conn !== conn) return;
      this.retries = 0;
      this.setStatus('live', `Connected to @${this.username}'s LIVE`);
      this.emit('connected', { roomId: state && state.roomId });
    } catch (e) {
      if (this.conn !== conn) return;
      const msg = String(e && e.message || e);
      const offline = /offline|not live|isn't live|LIVE has ended|UserOfflineError/i.test(msg) || (e && e.name === 'UserOfflineError');
      this.scheduleRetry(opts, offline ? `@${this.username} isn't live yet. Casnt will keep checking…` : `Couldn't connect: ${msg.slice(0, 160)}`);
    }
  }

  scheduleRetry(opts, message) {
    if (!this.wantOnline) return;
    this.retries++;
    const wait = Math.min(60000, 10000 * this.retries);
    this.setStatus('waiting', message);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.wantOnline) this.open(opts); }, wait);
  }

  async disconnect() {
    this.wantOnline = false;
    clearTimeout(this.retryTimer);
    const c = this.conn;
    this.conn = null;
    if (c) { try { await c.disconnect(); } catch (_) { /* ignore */ } }
    this.setStatus('offline');
  }
}

module.exports = { TikTokLive, normalize, normUser };
