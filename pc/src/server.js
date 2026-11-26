// Casnt PC server: LAN discovery, 6-digit pairing, cast requests and media receive.
'use strict';
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./protocol');

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_CODE_TRIES = 5;
const CAST_REQUEST_TIMEOUT_MS = 60 * 1000;

class CasntServer extends EventEmitter {
  constructor({ store, pcName, port = P.PORT, discoveryPort = P.DISCOVERY_PORT }) {
    super();
    this.store = store;
    this.pcName = pcName;
    this.port = port;
    this.discoveryPort = discoveryPort;
    this.sessions = new Map(); // id -> session
    this.castSession = null;   // session currently casting
    this.pendingCast = null;   // { session, timer }
    this.newCode();
  }

  // ---------- pairing code ----------
  newCode() {
    this.code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.codeExpires = Date.now() + CODE_LIFETIME_MS;
    clearTimeout(this.codeTimer);
    this.codeTimer = setTimeout(() => this.newCode(), CODE_LIFETIME_MS);
    if (this.codeTimer.unref) this.codeTimer.unref();
    this.emit('code', { code: this.code, expires: this.codeExpires });
  }

  // ---------- lifecycle ----------
  start() {
    return new Promise((resolve, reject) => {
      this.tcp = net.createServer((sock) => this.onConnection(sock));
      this.tcp.on('error', reject);
      this.tcp.listen(this.port, '0.0.0.0', () => {
        this.port = this.tcp.address().port;
        this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.udp.on('message', (msg, rinfo) => this.onDiscovery(msg, rinfo));
        this.udp.on('error', (e) => this.emit('log', 'discovery error: ' + e.message));
        this.udp.bind(this.discoveryPort, () => resolve());
      });
    });
  }

  stop() {
    clearTimeout(this.codeTimer);
    for (const s of this.sessions.values()) s.sock.destroy();
    if (this.udp) try { this.udp.close(); } catch (_) {}
    if (this.tcp) this.tcp.close();
  }

  onDiscovery(msg, rinfo) {
    if (msg.toString('utf8').trim() !== P.DISCOVERY_PROBE) return;
    const reply = Buffer.from(JSON.stringify({ app: 'casnt', v: 1, pcId: this.store.pcId, pcName: this.pcName, port: this.port }));
    this.udp.send(reply, rinfo.port, rinfo.address);
  }

  // ---------- connections ----------
  onConnection(sock) {
    sock.setNoDelay(true);
    const session = {
      id: crypto.randomUUID(), sock, device: null, authed: false,
      pendingPair: false, codeTries: 0, address: sock.remoteAddress,
    };
    this.sessions.set(session.id, session);
    session.reader = new P.FrameReader(
      (type, payload) => this.onFrame(session, type, payload),
      (err) => { this.emit('log', 'bad frame: ' + err.message); sock.destroy(); },
    );
    sock.on('data', (c) => session.reader.push(c));
    sock.on('error', () => {});
    sock.on('close', () => this.onClose(session));
  }

  onClose(session) {
    this.sessions.delete(session.id);
    if (this.pendingCast && this.pendingCast.session === session) {
      clearTimeout(this.pendingCast.timer);
      this.pendingCast = null;
      this.emit('cast-request-cancelled', { sessionId: session.id });
    }
    if (this.castSession === session) {
      this.castSession = null;
      this.emit('cast-ended', { reason: 'disconnected' });
    }
  }

  send(session, obj) {
    if (!session.sock.destroyed) session.sock.write(P.encodeJson(obj));
  }

  onFrame(session, type, payload) {
    if (type === P.T.JSON) {
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { return; }
      if (msg && typeof msg.t === 'string') this.onMessage(session, msg);
      return;
    }
    if (this.castSession !== session) return; // media only from the accepted cast
    switch (type) {
      case P.T.VCONF: this.emit('video-config', { config: payload, codec: P.avcCodecString(payload) }); break;
      case P.T.VKEY:
      case P.T.VFRAME:
        if (payload.length < 9) return;
        this.emit('video', { key: type === P.T.VKEY, pts: Number(payload.readBigUInt64BE(0)), data: payload.subarray(8) });
        break;
      case P.T.AGAME: this.emit('audio', { source: 'game', channels: 2, data: payload }); break;
      case P.T.AMIC: this.emit('audio', { source: 'mic', channels: 1, data: payload }); break;
      default: break;
    }
  }

  onMessage(session, msg) {
    switch (msg.t) {
      case 'hello': {
        session.device = {
          deviceId: String(msg.deviceId || '').slice(0, 64),
          name: String(msg.name || 'Quest').slice(0, 40),
          model: String(msg.model || 'Meta Quest').slice(0, 40),
        };
        this.send(session, { t: 'hello', pcName: this.pcName, pcId: this.store.pcId });
        break;
      }
      case 'pair_code': {
        if (!session.device || !session.device.deviceId) return;
        session.codeTries++;
        if (session.codeTries > MAX_CODE_TRIES) { this.send(session, { t: 'pair_fail', reason: 'too_many_tries' }); session.sock.end(); return; }
        const ok = String(msg.code) === this.code && Date.now() < this.codeExpires;
        if (ok) {
          session.pendingPair = true;
          this.send(session, { t: 'pair_match', pcName: this.pcName, pcId: this.store.pcId });
        } else {
          this.send(session, { t: 'pair_fail', reason: 'wrong_code' });
        }
        break;
      }
      case 'pair_confirm': {
        if (!session.pendingPair) return;
        session.pendingPair = false;
        const token = this.store.addDevice(session.device);
        session.authed = true;
        this.send(session, { t: 'paired', token, pcName: this.pcName, pcId: this.store.pcId });
        this.emit('paired', { ...session.device });
        this.newCode();
        break;
      }
      case 'pair_cancel': session.pendingPair = false; break;
      case 'auth': {
        if (!session.device) return;
        const d = this.store.checkToken(session.device.deviceId, msg.token);
        if (d) {
          session.authed = true;
          this.store.updateDevice(d.deviceId, { name: session.device.name, model: session.device.model, lastSeen: Date.now() });
          this.send(session, { t: 'auth_ok', pcName: this.pcName });
          this.emit('devices-changed');
        } else {
          this.send(session, { t: 'auth_fail' });
        }
        break;
      }
      case 'ping': this.send(session, { t: 'pong', ts: msg.ts }); break;
      default:
        if (session.authed) this.onAuthedMessage(session, msg);
    }
  }

  onAuthedMessage(session, msg) {
    switch (msg.t) {
      case 'cast_request': {
        if (this.castSession || this.pendingCast) { this.send(session, { t: 'cast_decline', reason: 'busy' }); return; }
        const mode = msg.mode === 'app' ? 'app' : 'everything';
        const timer = setTimeout(() => this.respondCast(session.id, false, 'timeout'), CAST_REQUEST_TIMEOUT_MS);
        this.pendingCast = { session, timer, mode };
        this.emit('cast-request', { sessionId: session.id, device: { ...session.device }, mode });
        break;
      }
      case 'cast_started': this.emit('cast-started', { width: msg.width, height: msg.height, fps: msg.fps }); break;
      case 'cast_stop':
        if (this.castSession === session) { this.castSession = null; this.emit('cast-ended', { reason: 'quest' }); }
        break;
      case 'tiktok_check': this.emit('tiktok-check', { sessionId: session.id }); break;
      default: break;
    }
  }

  // ---------- called by the UI ----------
  respondCast(sessionId, accept, reason) {
    const pending = this.pendingCast;
    if (!pending || pending.session.id !== sessionId) return false;
    clearTimeout(pending.timer);
    this.pendingCast = null;
    if (accept) {
      this.castSession = pending.session;
      this.send(pending.session, { t: 'cast_accept', quality: 'good' });
      this.emit('cast-accepted', { device: { ...pending.session.device }, mode: pending.mode });
    } else {
      this.send(pending.session, { t: 'cast_decline', reason: reason || 'declined' });
      this.emit('cast-request-cancelled', { sessionId });
    }
    return true;
  }

  stopCast() {
    const s = this.castSession;
    if (!s) return;
    this.castSession = null;
    this.send(s, { t: 'cast_stop' });
    this.emit('cast-ended', { reason: 'pc' });
  }

  requestKeyFrame() {
    if (this.castSession) this.send(this.castSession, { t: 'key_request' });
  }

  replyTikTok(sessionId, result) {
    const s = this.sessions.get(sessionId);
    if (s && s.authed) this.send(s, { t: 'tiktok_result', ...result });
  }

  forgetDevice(deviceId) {
    this.store.removeDevice(deviceId);
    for (const s of this.sessions.values()) {
      if (s.device && s.device.deviceId === deviceId) { this.send(s, { t: 'unpaired' }); s.sock.end(); }
    }
    this.emit('devices-changed');
  }
}

module.exports = { CasntServer };
