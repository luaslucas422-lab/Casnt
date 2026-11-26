// Overlay server: browser-source pages for TikTok LIVE Studio / OBS on http://127.0.0.1:47830
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const OVERLAY_PORT = 47830;
const WIDGETS = {
  alerts: 'Alerts (gifts, follows, shares, subs)',
  chat: 'Chat',
  goals: 'Goals',
  leaderboard: 'Top gifters',
  gifts: 'Gift wall',
  counters: 'Counters (viewers, likes, follows, diamonds)',
  points: 'Points leaderboard',
  all: 'Everything in one',
};

const STATIC = {
  '/overlay.js': ['overlay.js', 'text/javascript'],
  '/overlay.css': ['overlay.css', 'text/css'],
  '/sfx.js': ['sfx.js', 'text/javascript'],
};

class OverlayServer {
  constructor({ getState, getCustomSound, port = OVERLAY_PORT, host = '127.0.0.1' }) {
    this.getState = getState;
    this.getCustomSound = getCustomSound || (() => null);
    this.port = port;
    this.host = host;
    this.clients = new Set();
  }

  url(widget) { return `http://127.0.0.1:${this.port}/overlay/${widget}`; }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.route(req, res));
      this.server.on('error', (e) => { this.error = e.message; resolve(false); });
      this.server.listen(this.port, this.host, () => { this.port = this.server.address().port; resolve(true); });
      this.ping = setInterval(() => this.broadcast('ping', {}), 15000);
      if (this.ping.unref) this.ping.unref();
    });
  }

  stop() {
    clearInterval(this.ping);
    for (const c of this.clients) c.end();
    if (this.server) this.server.close();
  }

  route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/events') return this.sse(req, res);
    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
    }
    const m = p.match(/^\/overlay\/([a-z]+)$/);
    if (m && WIDGETS[m[1]]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'overlay.html'), 'utf8').replace('__WIDGET__', m[1]));
    }
    const s = p.match(/^\/sound\/([\w-]+)$/);
    if (s) {
      const file = this.getCustomSound(s[1]);
      if (file && fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const type = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        return fs.createReadStream(file).pipe(res);
      }
    }
    if (p === '/' || p === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>Casnt overlays</h1><ul>' + Object.entries(WIDGETS).map(([k, v]) => `<li><a href="/overlay/${k}">${v}</a></li>`).join('') + '</ul>');
    }
    res.writeHead(404); res.end('not found');
  }

  sse(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(this.getState())}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }
}

module.exports = { OverlayServer, OVERLAY_PORT, WIDGETS };
