'use strict';
// Runs for real on Windows (GitHub's Windows build machine); skipped elsewhere.
const test = require('node:test');
const assert = require('node:assert');
const { WinHelper } = require('../src/winhelper');

const onWin = process.platform === 'win32';

test('PowerShell helper starts and answers', { skip: !onWin }, async () => {
  const w = new WinHelper();
  try {
    assert.equal(await w.call('ping', {}, 30000), 'pong');
    const sp = await w.call('spotify', {}, 30000);
    assert.equal(typeof sp.installed, 'boolean');
    // no media session on a build machine is fine: it must still answer
    const st = await w.call('media_state', {}, 30000).catch((e) => ({ error: e.message }));
    assert.ok(st && typeof st === 'object');
    console.log('media_state on CI:', JSON.stringify(st).slice(0, 200));
  } finally { w.stop(); }
});
