const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function harness() {
  const effects = [], cells = [], alerts = [], messages = [], cache = new Map();
  let timer, cleared = false, updates = 0;
  function load(name) {
    const file = path.resolve(__dirname, '../src', name);
    if (cache.has(file)) return cache.get(file);
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env.DEV', 'true');
    const js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const mod = { exports: {} };
    const req = id => {
      if (id === 'react') return { ...React, useCallback: fn => fn, useRef: value => ({ current: value }), useEffect: fn => effects.push(fn), useState: value => {
        const cell = { value }; cells.push(cell); return [value, next => { updates++; cell.value = typeof next === 'function' ? next(cell.value) : next; }];
      } };
      if (id === '@tauri-apps/api/event') return { listen: async () => () => {} };
      if (id.endsWith('/diagnostics')) return new Proxy({}, { get: () => () => {} });
      if (id === './config') return { TWITCH_CLIENT_ID: 'test-client', TIKTOK_USERNAME: 'test-viewer' };
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(file), id);
        return load(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
      }
      return require(id);
    };
    new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', js)(req, mod, mod.exports,
      (fn, ms) => { assert.equal(ms, 500); timer = fn; return 1; }, () => { cleared = true; });
    cache.set(file, mod.exports); return mod.exports;
  }
  const hook = load('events/usePlatformEvents.ts').usePlatformEvents({ pushAlert: e => alerts.push(e), setMessages: fn => messages.splice(0, messages.length, ...fn(messages)) });
  return { ...hook, load, alerts, messages, effects, cells, tick: () => timer(), updates: () => updates, cleared: () => cleared };
}
const join = (id, name = id) => ({ id, platform: 'tiktok', event_type: 'viewer_join', user: { id: name, display_name: name }, message: null, metadata: { room_id: 'room' } });
const redemption = (id = 'redemption:room:one', input = 'Gebruik sniper') => ({ id, platform: 'twitch', event_type: 'channel_points_redemption', user: { id: '42', username: 'piet', display_name: 'Piet' }, message: null,
  metadata: { reward_title: 'Kies mijn loadout', reward_cost: 2000, user_input: input } });

test('join storm is batched, bounded to five, and never displaces alerts or adds chat', () => {
  const h = harness(), cleanup = h.effects[1]();
  for (let i = 0; i < 10000; i++) h.receiveEvent(join(String(i)));
  assert.equal(h.updates(), 0);
  h.tick();
  assert.equal(h.updates(), 1);
  assert.deepEqual(h.cells[0].value.map(j => j.name), ['9999', '9998', '9997', '9996', '9995']);
  h.tick(); assert.equal(h.updates(), 1);
  assert.equal(h.alerts.length, 0); assert.equal(h.messages.length, 0);
  cleanup(); assert.equal(h.cleared(), true);
});

test('join dedup suppresses duplicate event IDs and rapid same-user joins, allowing later reentry', () => {
  const h = harness(), buffer = h.load('events/tiktokJoins.ts').createTikTokJoinBuffer();
  assert.equal(buffer.add(join('a', 'Piet'), 0), true);
  assert.equal(buffer.add(join('a', 'Piet'), 20000), false);
  assert.equal(buffer.add(join('b', 'Piet'), 500), false);
  assert.equal(buffer.add(join('c', 'Piet'), 10000), true);
  assert.equal(buffer.add(join('bad', ''), 10001), false);
  assert.equal(buffer.add({ ...join('bad'), user: { display_name: {} } }), false);
});

test('joins render as compact rows inside Alerts & Gifts and cannot render as an overlay', () => {
  const h = harness(); h.effects[1](); h.receiveEvent(join('one', '<Viewer>')); h.tick();
  const html = renderToStaticMarkup(React.createElement(h.load('alerts/AlertHistory.tsx').AlertHistory, { alertHistory: [], tiktokJoins: h.cells[0].value }));
  assert.match(html, /Alerts &amp; Gifts/); assert.match(html, /tiktok-join-list/);
  assert.match(html, /&lt;Viewer&gt;/); assert.match(html, /joined/);
  assert.doesNotMatch(html, /alert-history-item/);
  assert.equal(renderToStaticMarkup(React.createElement(h.load('alerts/AlertOverlay.tsx').default, { event: join('one') })), '');
});

test('redemption preserves username, reward, cost and input, exclusively in chat', () => {
  const h = harness(); assert.equal(h.receiveEvent(redemption()), true);
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].username, 'Piet');
  assert.equal(h.messages[0].channelPoints.rewardTitle, 'Kies mijn loadout');
  assert.equal(h.messages[0].channelPoints.cost, 2000);
  assert.equal(h.messages[0].channelPoints.userInput, 'Gebruik sniper');
  assert.match(h.messages[0].message, /2\.000 punten/);
  assert.equal(h.alerts.length, 0); assert.deepEqual(h.cells[0].value, []);
  assert.equal(h.load('events/eventPresentation.ts').getAlertContent(redemption()), null);
  assert.equal(renderToStaticMarkup(React.createElement(h.load('alerts/AlertOverlay.tsx').default, { event: redemption() })), '');
});

test('redemption redelivery after reconnect and cache eviction cannot add a second chat row', () => {
  const h = harness(); h.receiveEvent(redemption());
  assert.equal(h.receiveEvent(redemption()), false);
  for (let i = 0; i < 1100; i++) h.receiveEvent({ ...redemption(String(i)), event_type: 'stream_online' });
  h.receiveEvent(redemption());
  assert.equal(h.messages.filter(m => m.channelPoints).length, 1);
});

test('Channel Points chat uses escaped plain text, preserves input lines and handles absent input', () => {
  const h = harness(); h.receiveEvent(redemption('one', '<script>alert(1)</script>\nTweede regel'));
  h.receiveEvent(redemption('two', ''));
  const html = renderToStaticMarkup(React.createElement(h.load('chat/ChatMessages.tsx').ChatMessages, { messages: h.messages, messageListRef: { current: null } }));
  assert.match(html, /channel-points-message/); assert.match(html, /Channel Points/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/<blockquote/g) || []).length, 1);
  assert.match(html, /Tweede regel/);
});

test('invalid rewards are ignored and a valid retry remains acceptable', () => {
  const h = harness();
  for (const metadata of [{}, { reward_title: 'Test', reward_cost: -1 }, { reward_title: {}, reward_cost: 100 }]) {
    assert.equal(h.receiveEvent({ ...redemption(), metadata }), false);
  }
  assert.equal(h.receiveEvent(redemption()), true);
});

test('join flood cannot evict deduplication of existing alerts or Channel Points', () => {
  const h = harness(); h.receiveEvent(redemption());
  for (let i = 0; i < 1100; i++) h.receiveEvent(join(String(i)));
  assert.equal(h.receiveEvent(redemption()), false);
  assert.equal(h.messages.length, 1);
});

test('Settings headings and test groups reuse the correct platform SVGs', () => {
  const h = harness();
  for (const [platform, title] of [['twitch', 'Twitch'], ['youtube', 'YouTube'], ['tiktok', 'TikTok']]) {
    const component = h.load(`platforms/${platform}/${title}Settings.tsx`)[`${title}Settings`];
    const icon = renderToStaticMarkup(React.createElement(h.load('components/PlatformIcon.tsx').PlatformIcon, { platform }));
    const html = renderToStaticMarkup(React.createElement(component, { twitchEventSubStatus: { status: 'connected', message: 'Actief' } }));
    assert.ok(html.includes(icon)); assert.match(html, new RegExp(`settings-${platform}-icon`));
  }
  const html = renderToStaticMarkup(React.createElement(h.load('events/EventTestPanel.tsx').EventTestPanel, { listenerError: '' }));
  assert.equal((html.match(/settings-test-platform-icon/g) || []).length, 4);
});
