// Optional Spotify account link (for Cast Player search + playlists).
// Uses Spotify's PKCE login with the user's own free Spotify developer Client ID, so Casnt
// never needs a secret. Basic play/pause/next/prev work without this (Windows media controls).
'use strict';
const http = require('http');
const crypto = require('crypto');

const REDIRECT_PORT = 47831;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read';
const DOWNLOAD_URL = 'https://www.spotify.com/download/windows/';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class Spotify {
  /** load/save persist { clientId, refreshToken, accessToken, expires } */
  constructor({ load, save, openUrl, fetchImpl }) {
    this.load = load;
    this.save = save;
    this.openUrl = openUrl;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  get data() { return this.load() || {}; }
  linked() { return !!(this.data.clientId && this.data.refreshToken); }

  /** Opens the Spotify login in the browser and waits for the redirect. */
  login(clientId) {
    clientId = String(clientId || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) return Promise.reject(new Error('That Client ID doesn\'t look right (it is 32 letters/numbers).'));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(12));
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, REDIRECT_URI);
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const done = (ok, msg) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<body style="font-family:sans-serif;background:#1b1408;color:#ffe27a;display:grid;place-items:center;height:90vh"><h1>${ok ? 'Spotify is linked to Casnt! You can close this tab.' : 'Spotify link failed: ' + msg}</h1></body>`);
          clearTimeout(timer);
          server.close();
        };
        if (url.searchParams.get('state') !== state) { done(false, 'bad state'); reject(new Error('Login was interrupted.')); return; }
        const code = url.searchParams.get('code');
        if (!code) { done(false, url.searchParams.get('error') || 'cancelled'); reject(new Error('Spotify login was cancelled.')); return; }
        try {
          const tok = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier });
          this.save({ clientId, refreshToken: tok.refresh_token, accessToken: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 });
          done(true);
          resolve(true);
        } catch (e) { done(false, e.message); reject(e); }
      });
      const timer = setTimeout(() => { server.close(); reject(new Error('Spotify login timed out.')); }, 5 * 60 * 1000);
      server.on('error', (e) => reject(e));
      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI, code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state });
        this.openUrl('https://accounts.spotify.com/authorize?' + q);
      });
    });
  }

  unlink() { this.save({ clientId: this.data.clientId }); }

  async tokenRequest(params) {
    const r = await this.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error || `Spotify said ${r.status}`);
    return j;
  }

  async token() {
    const d = this.data;
    if (!d.refreshToken) throw new Error('Spotify account not linked');
    if (d.accessToken && d.expires > Date.now()) return d.accessToken;
    const tok = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: d.refreshToken, client_id: d.clientId });
    this.save({ ...d, accessToken: tok.access_token, refreshToken: tok.refresh_token || d.refreshToken, expires: Date.now() + (tok.expires_in - 60) * 1000 });
    return tok.access_token;
  }

  async api(method, path, body) {
    const r = await this.fetch('https://api.spotify.com/v1' + path, {
      method, headers: { Authorization: 'Bearer ' + (await this.token()), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const text = await r.text();
    const j = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const reason = j && j.error && (j.error.reason || j.error.message);
      const err = new Error(reason === 'PREMIUM_REQUIRED' ? 'Spotify only lets Premium accounts start songs from other apps.' : (reason || `Spotify said ${r.status}`));
      err.code = reason || r.status;
      throw err;
    }
    return j;
  }

  static track(t) {
    return { kind: 'track', id: t.id, uri: t.uri, title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '),
      art: t.album && t.album.images && t.album.images.length ? t.album.images[t.album.images.length - 1].url : '' };
  }

  async search(q) {
    const j = await this.api('GET', `/search?type=track,playlist&limit=12&q=${encodeURIComponent(q)}`);
    return {
      tracks: (j.tracks ? j.tracks.items : []).filter(Boolean).map(Spotify.track),
      playlists: (j.playlists ? j.playlists.items : []).filter(Boolean).map((p) => ({ kind: 'playlist', id: p.id, uri: p.uri, title: p.name, artist: p.owner ? p.owner.display_name : '', art: p.images && p.images[0] ? p.images[0].url : '' })),
    };
  }

  async playlists() {
    const j = await this.api('GET', '/me/playlists?limit=40');
    return (j.items || []).filter(Boolean).map((p) => ({ kind: 'playlist', id: p.id, uri: p.uri, title: p.name, artist: `${p.tracks ? p.tracks.total : 0} songs`, art: p.images && p.images[0] ? p.images[0].url : '' }));
  }

  async playlistTracks(id) {
    const j = await this.api('GET', `/playlists/${encodeURIComponent(id)}/tracks?limit=50`);
    return (j.items || []).map((i) => i && i.track).filter((t) => t && t.id).map(Spotify.track);
  }

  /** Play a track or playlist. Without Premium, falls back to opening it in the Spotify app. */
  async play(item, contextUri) {
    try {
      const body = item.kind === 'playlist' ? { context_uri: item.uri } : contextUri ? { context_uri: contextUri, offset: { uri: item.uri } } : { uris: [item.uri] };
      await this.api('PUT', '/me/player/play', body);
      return { ok: true };
    } catch (e) {
      this.openUrl(item.uri); // opens in the Spotify desktop app
      return { ok: false, opened: true, message: e.message };
    }
  }
}

module.exports = { Spotify, REDIRECT_URI, DOWNLOAD_URL };
