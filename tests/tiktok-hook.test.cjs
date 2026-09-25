const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
function harness() {
  const command = new EventEmitter();
  command.stdout = new EventEmitter(); command.stderr = new EventEmitter();
  let resolveSpawn, killed = 0, spawnCount = 0, argumentsUsed;
  command.spawn = () => { spawnCount++; return new Promise(resolve => { resolveSpawn = resolve; }); };
  const effects = [], records = [], alerts = [], messages = [];
  const callbacks = [];
  function load(file) {
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    function req(id) {
      if (id === 'react') return { useEffect: fn => effects.push(fn), useRef: v => ({ current: v }), useState: v => [v, () => {}] };
      if (id === '@tauri-apps/plugin-shell') return { Command: { sidecar: (...args) => { argumentsUsed = args; return command; } } };
      if (id.endsWith('/usePlatformLiveStats')) return { usePlatformLiveStats: () => ({ stats: {}, recordStats: e => records.push(e), disconnectStats: () => {} }) };
      if (id.endsWith('/diagnostics')) return new Proxy({}, { get: () => () => {} });
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
      return require(id);
    }
    new Function('require', 'module', 'exports', js)(req, module, module.exports);
    return module.exports;
  }
  const hook = load(path.resolve(__dirname, '../src/platforms/tiktok/useTikTok.ts')).useTikTok({ receiveEvent: e => alerts.push(e), setMessages: fn => messages.splice(0, messages.length, ...fn(messages)) });
  const cleanup = effects[0]();
  return { command, hook, records, alerts, messages, cleanup,
    emit: payload => command.stdout.emit('data', JSON.stringify(payload)),
    ready: async () => { resolveSpawn({ kill: async () => { killed++; } }); await Promise.resolve(); },
    get killed() { return killed; }, get spawnCount() { return spawnCount; }, get argumentsUsed() { return argumentsUsed; },
  };
}
test('existing sidecar command serves chat, viewers, gifts and stats through one listener', async () => {
  const h = harness(); await h.ready();
  assert.equal(h.argumentsUsed[0], 'binaries/tiktok-chat-helper');
  assert.equal(h.argumentsUsed[1].length, 1);
  assert.equal(h.spawnCount, 1);
  assert.equal(h.command.stdout.listenerCount('data'), 1);
  const envelope = { platform: 'tiktok', schemaVersion: 1, roomId: 'room', receivedAt: 1 };
  h.emit({ ...envelope, type: 'session', status: 'connected' });
  h.emit({ ...envelope, type: 'viewerCount', count: 47 });
  h.emit({ ...envelope, type: 'like', totalLikeCount: 100 });
  h.emit({ ...envelope, type: 'follow', userId: 'u' });
  h.emit({ ...envelope, type: 'chat', message: 'hello', username: 'Viewer' });
  h.emit({ ...envelope, type: 'gift', giftName: 'Rose', repeatCount: 5, giftType: 1, repeatEnd: true, eventId: 'gift-streak', diamondCount: 1 });
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].message, 'hello');
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].id, 'gift-streak');
  assert.deepEqual(h.records.map(e => e.kind), ['session', 'viewers', 'likes', 'follow', 'chat', 'gift']);
  h.cleanup();
  assert.equal(h.killed, 1);
  assert.equal(h.command.stdout.eventNames().length, 0);
  assert.equal(h.command.stderr.eventNames().length, 0);
  assert.equal(h.command.eventNames().length, 0);
});
test('a sidecar spawn resolving after unmount is killed and cannot receive events', async () => {
  const h = harness(); h.cleanup(); await h.ready();
  assert.equal(h.killed, 1);
  assert.equal(h.hook.tiktokChildRef.current, null);
  assert.equal(h.command.stdout.listenerCount('data'), 0);
});


test('join uses the existing sidecar listener and event callback without changing chat or stats', async () => {
  const h = harness(); await h.ready();
  h.emit({ type: 'join', platform: 'tiktok', eventId: 'join1', roomId: 'room', userId: '42', uniqueId: 'viewer', username: 'Viewer Name' });
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].event_type, 'viewer_join');
  assert.equal(h.alerts[0].user.display_name, 'Viewer Name');
  assert.equal(h.messages.length, 0);
  assert.equal(h.records.length, 0);
  h.emit({ type: 'join', platform: 'tiktok', eventId: 'invalid', username: {} });
  assert.equal(h.alerts.length, 1);
  h.cleanup();
});


test('active streak reaches event history but only final is eligible for Live Stats', async () => {
  const h = harness(); await h.ready();
  const base = { type: 'gift', platform: 'tiktok', schemaVersion: 1, roomId: 'room', receivedAt: 1,
    eventId: 'stable-streak', userId: '42', username: 'Piet', giftName: 'Rose', giftType: 1, diamondCount: 1 };
  for (const repeatCount of [1, 2, 5, 10]) h.emit({ ...base, repeatCount, repeatEnd: false });
  h.emit({ ...base, repeatCount: 10, repeatEnd: true });
  assert.deepEqual(h.records.filter(Boolean).map(e => e.count), [10]);
  assert.deepEqual(h.alerts.map(e => e.metadata.repeat_count), [1, 2, 5, 10, 10]);
  assert.ok(h.alerts.every(e => e.id === 'stable-streak' && e.user.display_name === 'Piet'));
  assert.equal(h.messages.length, 0); h.cleanup();
});
