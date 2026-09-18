const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  const resolve = id => {
    if (!id.startsWith('.')) return require(id);
    const base = path.resolve(path.dirname(file), id);
    return load(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
  };
  new Function('require', 'module', 'exports', js)(resolve, module, module.exports);
  cache.set(file, module.exports);
  return module.exports;
}
const { LiveStatsStore } = load(path.resolve(__dirname, '../src/stats/liveStatsStore.ts'));
const { CompactLiveStats } = load(path.resolve(__dirname, '../src/stats/CompactLiveStats.tsx'));
const { toTikTokStatsEvent } = load(path.resolve(__dirname, '../src/platforms/tiktok/liveStatsEvents.ts'));
function session() {
  const store = new LiveStatsStore('tiktok');
  const send = e => store.consume({ sessionId: 'room', at: 1000, ...e });
  send({ kind: 'session', status: 'connected' });
  return { store, send };
}
const render = stats => renderToStaticMarkup(React.createElement(CompactLiveStats, { stats }));

test('unknown data is hidden; genuine reported zero likes is displayed', () => {
  const { store, send } = session();
  assert.equal(render(store.snapshot), '');
  assert.equal(store.snapshot.estimatedRevenue, null);
  send({ kind: 'likes', total: 0 });
  const html = render(store.snapshot);
  assert.match(html, /♥ 0/);
  assert.doesNotMatch(html, /🎁|€|nieuwe volgers/);
  send({ kind: 'session', status: 'disconnected' });
  assert.equal(render(store.snapshot), '');
});
test('like totals are cumulative and invalid counts cannot alter them', () => {
  const { store, send } = session();
  for (const total of [100, 110, 105]) send({ kind: 'likes', total });
  for (const total of [-1, NaN, Infinity, 1.5]) assert.equal(send({ kind: 'likes', total }), false);
  assert.equal(store.snapshot.totalLikes, 110);
});
test('final gifts are deduplicated; unknown diamond values fall back to gift count', () => {
  const { store, send } = session();
  const gift = { kind: 'gift', id: 'streak', count: 5, diamondsPerGift: 2 };
  send(gift); send(gift);
  assert.equal(store.snapshot.giftsObserved, 5);
  assert.equal(store.snapshot.diamondsObserved, 10);
  assert.match(render(store.snapshot), /🎁 10 ◆/);
  send({ kind: 'gift', id: 'unknown-price', count: 2, diamondsPerGift: null });
  assert.equal(store.snapshot.giftsObserved, 7);
  assert.match(render(store.snapshot), /🎁 7/);
  assert.doesNotMatch(render(store.snapshot), /◆|€/);
});
test('followers count unique observed users, not their total follower numbers', () => {
  const { store, send } = session();
  send({ kind: 'follow', userId: 'a', id: '1' });
  send({ kind: 'follow', userId: 'a', id: '2' });
  send({ kind: 'follow', userId: 'b', id: '3' });
  assert.equal(store.snapshot.followersObserved, 2);
});
test('same-room reconnect preserves counters; new room resets and stale events are ignored', () => {
  const { store, send } = session();
  send({ kind: 'likes', total: 100 });
  send({ kind: 'session', status: 'disconnected' });
  assert.equal(send({ kind: 'likes', total: 200 }), false);
  send({ kind: 'session', status: 'connected' });
  assert.equal(store.snapshot.totalLikes, 100);
  send({ kind: 'session', status: 'connected', sessionId: 'next' });
  assert.equal(store.snapshot.totalLikes, null);
  assert.equal(send({ kind: 'likes', total: 300 }), false);
});
test('viewer average is time weighted and excludes disconnected intervals', () => {
  const { store, send } = session();
  send({ kind: 'viewers', count: 40, at: 1000 });
  send({ kind: 'viewers', count: 60, at: 11000 });
  send({ kind: 'session', status: 'disconnected', at: 31000 });
  assert.equal(store.snapshot.viewerObservedMs, 30000);
  assert.equal(store.snapshot.averageViewers, 160 / 3);
  send({ kind: 'session', status: 'connected', at: 100000 });
  send({ kind: 'viewers', count: 0, at: 110000 });
  assert.equal(store.snapshot.viewerObservedMs, 30000);
  assert.equal(store.snapshot.peakViewers, 60);
  send({ kind: 'session', status: 'ended', at: 120000 });
  assert.equal(store.snapshot.averageViewers, 40);
  assert.equal(send({ kind: 'likes', total: 1, at: 130000 }), false);
});
test('stats boundary rejects previews, partial streaks and incomplete envelopes', () => {
  assert.equal(toTikTokStatsEvent({ platform: 'tiktok', type: 'gift', repeatCount: 5 }), null);
  const envelope = { platform: 'tiktok', schemaVersion: 1, roomId: 'room', receivedAt: 1 };
  assert.equal(toTikTokStatsEvent({ ...envelope, type: 'gift', repeatCount: 5, giftType: 1, repeatEnd: false }), null);
  assert.equal(toTikTokStatsEvent({ ...envelope, type: 'gift', repeatCount: 5, giftType: 1, repeatEnd: true, diamondCount: 0 }).diamondsPerGift, null);
  assert.equal(toTikTokStatsEvent({ ...envelope, type: 'viewerCount', count: 0 }).count, 0);
});
