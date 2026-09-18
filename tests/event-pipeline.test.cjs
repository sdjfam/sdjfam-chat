const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Load the TS modules with a controlled Tauri boundary; no login/network required.
function harness() {
  const cache = new Map(), effects = [], alerts = [], messages = [], counters = [];
  let listener, resolveListen, stopped = 0;
  const mocks = {
    react: {
      useCallback: fn => fn,
      useRef: value => ({ current: value }),
      useState: value => [value, () => {}],
      useEffect: fn => effects.push(fn),
    },
    '@tauri-apps/api/event': {
      listen: (_name, callback) => { listener = callback; return new Promise(resolve => { resolveListen = resolve; }); },
    },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const text = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} };
    function requireModule(id) {
      if (mocks[id]) return mocks[id];
      if (id.endsWith('/diagnostics')) return {
        incrementDiagnosticCounter: name => counters.push(name), recordDiagnosticEvent: () => {}, diagnosticError: () => {},
      };
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'));
      return require(id);
    }
    new Function('require', 'module', 'exports', js)(requireModule, module, module.exports);
    cache.set(file, module.exports);
    return module.exports;
  }
  const root = path.resolve(__dirname, '../src/events');
  const presentation = load(root + '/eventPresentation.ts');
  const samples = load(root + '/testEvents.ts');
  const { usePlatformEvents } = load(root + '/usePlatformEvents.ts');
  const hook = usePlatformEvents({ pushAlert: event => alerts.push(event), setMessages: fn => { const next = fn([...messages]); messages.splice(0, messages.length, ...next); } });
  return { ...hook, ...samples, ...presentation, alerts, messages, counters,
    mount: () => effects[0](), emit: event => listener({ payload: event }),
    ready: async () => { resolveListen(() => stopped++); await Promise.resolve(); }, stopped: () => stopped,
  };
}

test('all ten offline event examples produce visible, clearly marked alerts', () => {
  const h = harness();
  for (const option of h.TEST_EVENTS) {
    const event = h.createTestEvent(option.platform, option.type);
    assert.ok(h.getAlertContent(event));
    assert.equal(h.isTestEvent(event), true);
    assert.equal(h.receiveEvent(event), true);
  }
  assert.equal(h.alerts.length, 10);
  assert.equal(h.counters.length, 0, 'tests must not increment live counters');
  assert.ok(h.messages.every(message => message.message.startsWith('[TEST]')));
});

test('duplicate deliveries are ignored but equal IDs on different platforms are independent', () => {
  const h = harness();
  const twitch = { ...h.createTestEvent('twitch', 'follow'), id: 'shared-id', raw_event_type: 'channel.follow' };
  assert.equal(h.receiveEvent(twitch), true);
  assert.equal(h.receiveEvent(twitch), false);
  assert.equal(h.receiveEvent({ ...h.createTestEvent('youtube', 'member_join'), id: 'shared-id' }), true);
  assert.equal(h.alerts.length, 2);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.counters, ['eventsub_events', 'alerts']);
});

test('YouTube support events do not duplicate the existing chat message', () => {
  const h = harness();
  h.receiveEvent(h.createTestEvent('youtube', 'super_chat'));
  assert.equal(h.alerts.length, 1);
  assert.equal(h.messages.length, 0);
  assert.equal(h.receiveEvent({ ...h.createTestEvent('twitch', 'follow'), event_type: 'chat_message' }), false);
});

test('TikTok gift and Super Sticker have distinct display labels', () => {
  const h = harness();
  assert.equal(h.getAlertContent(h.createTestEvent('tiktok', 'gift')).label, 'TikTok Gift');
  assert.equal(h.getAlertContent(h.createTestEvent('youtube', 'super_sticker')).label, 'Super Sticker');
  assert.match(h.getAlertContent(h.createTestEvent('youtube', 'super_chat')).message, /5,00/);
});

test('global events arrive without a Twitch login and unmount releases the listener', async () => {
  const h = harness(), cleanup = h.mount();
  await h.ready();
  h.emit(h.createTestEvent('youtube', 'member_join'));
  assert.equal(h.alerts.length, 1);
  cleanup();
  assert.equal(h.stopped(), 1);
  h.emit(h.createTestEvent('tiktok', 'gift'));
  assert.equal(h.alerts.length, 1);
});

test('listener resolving after unmount is immediately released', async () => {
  const h = harness(), cleanup = h.mount();
  cleanup();
  await h.ready();
  assert.equal(h.stopped(), 1);
});

test('deduplication memory remains bounded', () => {
  const h = harness(), accept = h.createEventDeduplicator(2);
  const event = h.createTestEvent('twitch', 'follow');
  assert.equal(accept({ ...event, id: 'a' }), true);
  assert.equal(accept({ ...event, id: 'b' }), true);
  assert.equal(accept({ ...event, id: 'c' }), true);
  assert.equal(accept({ ...event, id: 'c' }), false);
  assert.equal(accept({ ...event, id: 'a' }), true);
});
