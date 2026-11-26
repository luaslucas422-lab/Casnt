'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { TikTokEngine, DEFAULT_TIKTOK } = require('../src/tiktok/engine');
const { normalize } = require('../src/tiktok/live');
const { OverlayServer } = require('../src/tiktok/overlays');

const user = (n) => ({ id: n, uniqueId: n, name: n.toUpperCase(), avatar: '', follower: false });
function engine(over = {}) {
  const e = new TikTokEngine(JSON.parse(JSON.stringify({ ...DEFAULT_TIKTOK, ...over })));
  const out = [];
  e.on('command', (c) => out.push(c));
  return { e, out, of: (k) => out.filter((c) => c.kind === k) };
}

test('chat is read out, with filters and command mode', () => {
  const { e, of } = engine();
  e.handle({ type: 'chat', user: user('geo'), text: 'hello there' });
  assert.equal(of('tts')[0].text, 'GEO says hello there');
  e.handle({ type: 'chat', user: user('geo'), text: 'look www.spam.com' });
  assert.equal(of('tts')[1].text, 'GEO says look');
  e.cfg.tts.blockedWords = 'badword';
  e.handle({ type: 'chat', user: user('x'), text: 'a BADWORD here' });
  assert.equal(of('tts').length, 2);
  e.cfg.tts.mode = 'command';
  e.handle({ type: 'chat', user: user('x'), text: 'not read' });
  e.handle({ type: 'chat', user: user('x'), text: '!tts read me' });
  assert.equal(of('tts').at(-1).text, 'X says read me');
  assert.equal(of('tts').length, 3);
});

test('gift streaks only count once at the end; leaderboard + diamonds + rules', () => {
  const { e, of } = engine();
  const g = (over) => ({ type: 'gift', user: user('ana'), gift: 'Rose', giftId: 1, diamonds: 1, image: '', count: 1, streaking: false, ...over });
  e.handle(g({ count: 3, streaking: true }));
  assert.equal(e.stats.diamonds, 0);
  e.handle(g({ count: 5 }));
  assert.equal(e.stats.diamonds, 5);
  assert.deepEqual(of('sound').map((s) => s.sound), ['coin', 'pop']); // alert sound + "Rose = pop" rule
  e.handle(g({ gift: 'Galaxy', diamonds: 1000, count: 1, user: user('bob') }));
  assert.equal(e.leaderboard()[0].name, 'BOB');
  assert.ok(of('sound').some((s) => s.sound === 'airhorn'), 'big gift rule fired');
  assert.ok(of('tts').some((t) => /BOB sent 1 Galaxy/.test(t.text)));
  assert.equal(of('alert').length, 2);
});

test('likes rule + milestone fire when crossing', () => {
  const { e, of } = engine();
  e.handle({ type: 'like', user: user('a'), count: 400, total: 0 });
  assert.equal(of('sound').length, 0);
  e.handle({ type: 'like', user: user('a'), count: 200, total: 0 }); // crosses 500
  assert.deepEqual(of('sound').map((s) => s.sound), ['applause']);
  e.handle({ type: 'like', user: user('a'), count: 500, total: 0 }); // 1100: crosses 1000 milestone + 1000 rule
  assert.ok(of('alert').some((a) => a.alert.title === '1,000 likes!'));
  assert.equal(e.stats.likes, 1100);
});

test('chat commands: !sound, !points, keys action with cooldown', () => {
  const { e, of } = engine();
  e.cfg.actions.find((a) => a.id === 'a-jump').enabled = true;
  e.handle({ type: 'chat', user: user('kid'), text: '!sound airhorn' });
  assert.equal(of('sound').at(-1).sound, 'airhorn');
  e.handle({ type: 'chat', user: user('kid'), text: '!sound airhorn' }); // cooldown
  assert.equal(of('sound').length, 1);
  e.handle({ type: 'chat', user: user('kid'), text: '!sound notasound' });
  assert.equal(of('sound').length, 1);
  e.handle({ type: 'chat', user: user('kid'), text: '!jump' });
  e.handle({ type: 'chat', user: user('kid'), text: '!jump' }); // rule cooldown 3s
  assert.equal(of('keys').length, 1);
  assert.equal(of('keys')[0].keys, 'space');
  e.handle({ type: 'chat', user: user('kid'), text: '!points' });
  assert.match(of('tts').at(-1).text, /KID has \d+ points/);
});

test('follow alert, goals in state, simulate works', () => {
  const { e, of } = engine();
  e.handle({ type: 'follow', user: user('fan') });
  assert.equal(of('alert')[0].alert.title, 'FAN followed!');
  const st = e.getState();
  assert.equal(st.goals.find((g) => g.kind === 'follows').current, 1);
  e.simulate('biggift');
  assert.equal(e.stats.diamonds, 1000);
});

test('a broken rule never breaks the engine', () => {
  const { e } = engine({ actions: [{ id: 'x', enabled: true, trigger: null, do: null }] });
  e.handle({ type: 'chat', user: user('a'), text: 'hi' });
  assert.equal(e.stats.chats, 1);
});

test('normalize handles connector shapes', () => {
  const g = normalize('gift', { giftId: 5655, repeatCount: 4, repeatEnd: 1, user: { uniqueId: 'geo', nickname: 'Geo', profilePicture: { urls: ['http://a/p.jpg'] } },
    giftDetails: { giftName: 'Rose', diamondCount: 1, giftType: 1, giftImage: { giftPictureUrl: 'http://a/rose.png' } } });
  assert.deepEqual([g.gift, g.count, g.diamonds, g.streaking, g.user.avatar, g.image], ['Rose', 4, 1, false, 'http://a/p.jpg', 'http://a/rose.png']);
  assert.equal(normalize('gift', { repeatCount: 2, repeatEnd: 0, giftDetails: { giftType: 1 } }).streaking, true);
  assert.equal(normalize('chat', { comment: 'yo', user: { uniqueId: 'a' } }).text, 'yo');
  assert.equal(normalize('roomUser', { viewerCount: 42 }).count, 42);
  assert.equal(normalize('weird', {}), null);
});

test('overlay server serves widgets and pushes events', async () => {
  const o = new OverlayServer({ getState: () => ({ hello: 1 }), port: 0 });
  await o.start();
  try {
    const html = await new Promise((r) => http.get(`http://127.0.0.1:${o.port}/overlay/chat`, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r(d)); }));
    assert.match(html, /data-widget="chat"/);
    const got = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${o.port}/events`, (res) => {
        let d = '';
        res.on('data', (c) => {
          d += c;
          if (d.includes('event: state') && !d.includes('event: alert')) o.broadcast('alert', { title: 'Yo' });
          if (d.includes('event: alert')) { res.destroy(); resolve(d); }
        });
      });
    });
    assert.match(got, /"hello":1/);
    assert.match(got, /"title":"Yo"/);
  } finally { o.stop(); }
});
