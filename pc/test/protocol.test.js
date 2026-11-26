// Fake-Quest test: discovery, pairing, auth, cast request/accept and media.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');
const P = require('../src/protocol');
const { Store } = require('../src/store');
const { CasntServer } = require('../src/server');

function fakeQuest(port) {
  const sock = net.connect(port, '127.0.0.1');
  const inbox = [];
  const waiters = [];
  const reader = new P.FrameReader((type, payload) => {
    if (type !== P.T.JSON) return;
    const msg = JSON.parse(payload.toString());
    const w = waiters.findIndex((x) => x.t === msg.t);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(msg); else inbox.push(msg);
  });
  sock.on('data', (c) => reader.push(c));
  return {
    sock,
    send: (obj) => sock.write(P.encodeJson(obj)),
    sendRaw: (type, buf) => sock.write(P.encode(type, buf)),
    wait: (t) => new Promise((resolve) => {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) resolve(inbox.splice(i, 1)[0]); else waiters.push({ t, resolve });
    }),
    close: () => sock.destroy(),
  };
}

const once = (em, ev) => new Promise((r) => em.once(ev, r));

test('full pairing + cast flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casnt-'));
  const store = new Store(path.join(dir, 'casnt.json'));
  const server = new CasntServer({ store, pcName: 'GEO-PC', port: 0, discoveryPort: 0 });
  await server.start();
  const device = { t: 'hello', deviceId: 'quest-123', name: 'Lucas', model: 'Quest 3' };

  try {
    // discovery
    const udp = dgram.createSocket('udp4');
    const reply = new Promise((r) => udp.once('message', (m) => r(JSON.parse(m.toString()))));
    udp.send(P.DISCOVERY_PROBE, server.udp.address().port, '127.0.0.1');
    const found = await reply;
    udp.close();
    assert.equal(found.app, 'casnt');
    assert.equal(found.pcName, 'GEO-PC');
    assert.equal(found.port, server.port);

    // pairing: wrong code, then right code
    const q = fakeQuest(server.port);
    q.send(device);
    assert.equal((await q.wait('hello')).pcName, 'GEO-PC');
    q.send({ t: 'pair_code', code: server.code === '000000' ? '111111' : '000000' });
    assert.equal((await q.wait('pair_fail')).reason, 'wrong_code');
    const oldCode = server.code;
    q.send({ t: 'pair_code', code: oldCode });
    const match = await q.wait('pair_match');
    assert.equal(match.pcName, 'GEO-PC'); // "Is this PC yours? GEO-PC"
    const pairedEv = once(server, 'paired');
    q.send({ t: 'pair_confirm' });
    const paired = await q.wait('paired');
    assert.equal(paired.token.length, 64);
    assert.equal((await pairedEv).name, 'Lucas');
    assert.notEqual(server.code, oldCode, 'code rotates after pairing');
    q.close();

    // later: reconnect with the token and cast
    const q2 = fakeQuest(server.port);
    q2.send(device);
    await q2.wait('hello');
    q2.send({ t: 'auth', token: 'nope' });
    await q2.wait('auth_fail');
    q2.send({ t: 'auth', token: paired.token });
    assert.equal((await q2.wait('auth_ok')).pcName, 'GEO-PC');

    const reqEv = once(server, 'cast-request');
    q2.send({ t: 'cast_request', mode: 'app' });
    const req = await reqEv;
    assert.equal(req.device.model, 'Quest 3');
    assert.equal(req.mode, 'app');

    // a second Quest can't jump in while one is pending
    server.respondCast(req.sessionId, true);
    assert.equal((await q2.wait('cast_accept')).quality, 'good');

    // media
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x33, 0xac, 0, 0, 0, 1, 0x68, 0xee]);
    const cfgEv = once(server, 'video-config');
    q2.sendRaw(P.T.VCONF, sps);
    assert.equal((await cfgEv).codec, 'avc1.640033');

    const vidEv = once(server, 'video');
    const pts = Buffer.alloc(8); pts.writeBigUInt64BE(123456n);
    q2.sendRaw(P.T.VKEY, Buffer.concat([pts, sps, Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3])]));
    const vid = await vidEv;
    assert.equal(vid.key, true);
    assert.equal(vid.pts, 123456);

    const audEv = once(server, 'audio');
    q2.sendRaw(P.T.AGAME, Buffer.alloc(3840));
    const aud = await audEv;
    assert.equal(aud.source, 'game');
    assert.equal(aud.data.length, 3840);

    // PC stops the cast
    const endEv = once(server, 'cast-ended');
    server.stopCast();
    await q2.wait('cast_stop');
    assert.equal((await endEv).reason, 'pc');
    q2.close();
  } finally {
    server.stop();
  }
});

test('frame reader handles split and merged chunks', () => {
  const got = [];
  const r = new P.FrameReader((t, p) => got.push([t, p.toString()]));
  const a = P.encodeJson({ t: 'a' });
  const b = P.encode(P.T.AMIC, Buffer.from('xyz'));
  const all = Buffer.concat([a, b, a]);
  for (let i = 0; i < all.length; i += 3) r.push(all.subarray(i, i + 3));
  assert.deepEqual(got.map((g) => g[0]), [1, 6, 1]);
  assert.equal(got[1][1], 'xyz');
});

test('pairing locks out after too many wrong codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casnt-'));
  const server = new CasntServer({ store: new Store(path.join(dir, 's.json')), pcName: 'PC', port: 0, discoveryPort: 0 });
  await server.start();
  try {
    const q = fakeQuest(server.port);
    q.send({ t: 'hello', deviceId: 'x', name: 'x', model: 'Quest 3' });
    await q.wait('hello');
    const wrong = server.code === '999999' ? '999998' : '999999';
    for (let i = 0; i < 5; i++) { q.send({ t: 'pair_code', code: wrong }); await q.wait('pair_fail'); }
    q.send({ t: 'pair_code', code: server.code });
    assert.equal((await q.wait('pair_fail')).reason, 'too_many_tries');
    q.close();
  } finally { server.stop(); }
});

test('USB instant connect pairs without a code, and can be turned off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casnt-'));
  const store = new Store(path.join(dir, 's.json'));
  const server = new CasntServer({ store, pcName: 'USB-PC', port: 0, discoveryPort: 0 });
  await server.start();
  try {
    const q = fakeQuest(server.port); // 127.0.0.1 == what adb reverse looks like
    q.send({ t: 'hello', deviceId: 'usb-q', name: 'Lucas', model: 'Meta Quest 3' });
    await q.wait('hello');
    q.send({ t: 'usb_pair' });
    const p = await q.wait('paired');
    assert.equal(p.via, 'usb');
    assert.equal(p.pcName, 'USB-PC');
    assert.ok(store.checkToken('usb-q', p.token));
    q.close();

    store.setSetting('usbInstantConnect', false);
    const q2 = fakeQuest(server.port);
    q2.send({ t: 'hello', deviceId: 'usb-q2', name: 'X', model: 'Meta Quest 3' });
    await q2.wait('hello');
    q2.send({ t: 'usb_pair' });
    assert.equal((await q2.wait('pair_fail')).reason, 'usb_off');
    q2.close();
  } finally { server.stop(); }
});

test('live quality, audio, ping and Quest status while casting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casnt-'));
  const store = new Store(path.join(dir, 's.json'));
  const server = new CasntServer({ store, pcName: 'PC', port: 0, discoveryPort: 0,
    specFor: (pref) => ({ preset: pref === 'pc' ? 'medium' : pref, width: 1280, height: 720, fps: 60, bitrate: 8e6 }) });
  await server.start();
  try {
    const q = fakeQuest(server.port);
    q.send({ t: 'hello', deviceId: 'd', name: 'L', model: 'Meta Quest 3' });
    await q.wait('hello');
    q.send({ t: 'usb_pair' }); await q.wait('paired');
    const req = once(server, 'cast-request');
    q.send({ t: 'cast_request', mode: 'everything', quality: 'potato' });
    server.respondCast((await req).sessionId, true);
    const acc = await q.wait('cast_accept');
    assert.equal(acc.spec.preset, 'potato', 'Quest-picked quality wins');

    server.setQuality({ preset: 'good', width: 2560, height: 1440, fps: 60, bitrate: 2e7 });
    assert.equal((await q.wait('set_quality')).spec.height, 1440);
    server.setAudio({ game: false, mic: true });
    const a = await q.wait('set_audio');
    assert.equal(a.game, false); assert.equal(a.mic, true);

    const ping = await q.wait('ping'); // PC pings every 2 s while casting
    const pingEv = once(server, 'ping');
    q.send({ t: 'pong', ts: ping.ts });
    assert.ok((await pingEv).ms >= 0);

    const stEv = once(server, 'quest-status');
    q.send({ t: 'status', battery: 81, charging: true, game: false, mic: true, spec: { height: 1440, fps: 60 } });
    const st = await stEv;
    assert.equal(st.battery, 81); assert.equal(st.game, false);
    q.close();
  } finally { server.stop(); }
});

test('quality presets', () => {
  const Q = require('../src/quality');
  assert.equal(Q.specFor('good', { goodMode: 'set' }).height, 1440);
  assert.equal(Q.specFor('good', { goodMode: 'max' }).height, 2160);
  const c = Q.specFor('custom', { custom: { height: 1080, fps: 90, mbps: 30 } });
  assert.deepEqual([c.width, c.height, c.fps, c.bitrate], [1920, 1080, 90, 30e6]);
  assert.equal(Q.specFor('potato', {}).height, 480);
});
