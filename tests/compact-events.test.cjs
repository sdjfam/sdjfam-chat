const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function harness() {
  const effects = [], cells = [], alerts = [], messages = [], cache = new Map();
  let cleared = false, updates = 0, now = 0, serial = 0, alertHook;
  const timers = new Map(), savedTimers = [], diagnosticEvents = [];
  function advance(ms) {
    now += ms;
    for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.fn(); }
  }
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
      if (id.endsWith('/diagnostics')) return { recordDiagnosticEvent: (...args) => diagnosticEvents.push(args), diagnosticError: () => {}, incrementDiagnosticCounter: () => {} };
      if (id === './config') return { TWITCH_CLIENT_ID: 'test-client', TIKTOK_USERNAME: 'test-viewer' };
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(file), id);
        return load(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
      }
      return require(id);
    };
    new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', js)(req, mod, mod.exports,
      (fn, ms) => { assert.equal(ms, 5000); const id = ++serial; timers.set(id, { fn, at: now + ms }); savedTimers.push(fn); return id; },
      id => { timers.delete(id); cleared = true; });
    cache.set(file, mod.exports); return mod.exports;
  }
  const hook = load('events/usePlatformEvents.ts').usePlatformEvents({ pushAlert: e => { alerts.push(e); alertHook?.pushAlert(e); }, setMessages: fn => messages.splice(0, messages.length, ...fn(messages)) });
  alertHook = load('alerts/useAlerts.ts').useAlerts();
  return { ...hook, load, alerts, messages, effects, cells, advance, savedTimers, diagnosticEvents,
    pendingTimers: () => timers.size, tick: () => advance(0), updates: () => updates, cleared: () => cleared,
    history: () => cells[4].value, queue: () => cells[3].value };
}
const join = (id, name = id) => ({ id, platform: 'tiktok', event_type: 'viewer_join', user: { id: name, display_name: name }, message: null, metadata: { room_id: 'room' } });
const redemption = (id = 'redemption:room:one', input = 'Gebruik sniper') => ({ id, platform: 'twitch', event_type: 'channel_points_redemption', user: { id: '42', username: 'piet', display_name: 'Piet' }, message: null,
  metadata: { reward_title: 'Kies mijn loadout', reward_cost: 2000, user_input: input } });

test('join storm keeps only the newest row and one timer without chat or large alerts', () => {
  const h = harness(), cleanup = h.effects[1]();
  for (let i = 0; i < 10000; i++) h.receiveEvent(join(String(i)));
  assert.deepEqual(h.cells[0].value.map(j => j.name), ['9999']);
  assert.equal(h.pendingTimers(), 1);
  assert.equal(h.alerts.length, 0); assert.equal(h.messages.length, 0);
  cleanup(); assert.equal(h.pendingTimers(), 0);
});

test('new joins immediately replace the row; old timer cannot remove the replacement', () => {
  const h = harness(); h.receiveEvent(join('a', 'Piet'));
  assert.equal(h.cells[0].value[0].name, 'Piet');
  h.advance(2000); h.receiveEvent(join('b', 'Jan'));
  assert.equal(h.cells[0].value[0].name, 'Jan');
  h.savedTimers[0](); // Even a previously queued callback is harmless.
  assert.equal(h.cells[0].value[0].name, 'Jan');
  h.advance(3000); assert.equal(h.cells[0].value[0].name, 'Jan');
  h.advance(1999); assert.equal(h.cells[0].value.length, 1);
  h.advance(1); assert.deepEqual(h.cells[0].value, []);
});

test('duplicate join delivery neither flickers nor extends timeout; new same-user event is allowed', () => {
  const h = harness(); h.receiveEvent(join('a', 'Piet'));
  h.advance(4000); const updates = h.updates();
  assert.equal(h.receiveEvent(join('a', 'Piet')), false);
  assert.equal(h.updates(), updates);
  h.advance(1000); assert.deepEqual(h.cells[0].value, []);
  assert.equal(h.receiveEvent(join('b', 'Piet')), true);
  assert.equal(h.cells[0].value[0].name, 'Piet');
  assert.equal(h.receiveEvent(join('bad', '')), false);
  assert.equal(h.receiveEvent({ ...join('bad'), user: { display_name: {} } }), false);
  assert.equal(h.receiveEvent(join('c', 'Piet')), true);
});

test('join cleanup invalidates an already queued timeout callback', () => {
  const h = harness(), cleanup = h.effects[1]();
  h.receiveEvent(join('a')); cleanup(); const updates = h.updates();
  h.savedTimers[0](); assert.equal(h.updates(), updates);
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


const gift = (id, count, end = false, sender = 'Piet', name = 'Rose', type = 1) => ({
  id, platform: 'tiktok', event_type: 'gift', user: { id: sender, display_name: sender }, message: `${name} ×${count}`,
  metadata: { gift_name: name, repeat_count: count, repeat_end: end, gift_type: type, group_id: id, gift_id: '5655', room_id: 'room' },
});

test('active gift counts replace one history row; only final adds a large alert once', () => {
  const h = harness();
  for (const count of [1, 2, 5, 10]) {
    assert.equal(h.receiveEvent(gift('streak', count)), true);
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].metadata.repeat_count, count);
    assert.equal(h.queue().length, 0);
  }
  assert.equal(h.receiveEvent(gift('streak', 5)), false, 'out-of-order progress ignored');
  assert.equal(h.receiveEvent(gift('streak', 10, true)), true);
  assert.equal(h.history().length, 1);
  assert.equal(h.history()[0].metadata.repeat_count, 10);
  assert.equal(h.queue().length, 1);
  assert.equal(h.receiveEvent(gift('streak', 10, true)), false);
  assert.equal(h.receiveEvent(gift('streak', 12)), false, 'late progress cannot reopen completed streak');
  assert.equal(h.queue().length, 1); assert.equal(h.messages.length, 0);
  assert.equal(h.diagnosticEvents.filter(e => e[1] === 'gift').length, 1, 'one final diagnostic, not two');
});

test('concurrent senders, different gifts and later streaks remain separate', () => {
  const h = harness();
  h.receiveEvent(gift('piet-rose-1', 1));
  h.receiveEvent(gift('jan-heart', 2, false, 'Jan', 'Finger Heart'));
  h.receiveEvent(gift('piet-galaxy', 1, true, 'Piet', 'Galaxy', 0));
  h.receiveEvent(gift('piet-rose-1', 5, true));
  h.receiveEvent(gift('jan-heart', 4, true, 'Jan', 'Finger Heart'));
  h.receiveEvent(gift('piet-rose-2', 1, true));
  assert.equal(h.history().length, 4); assert.equal(h.queue().length, 4);
  assert.equal(h.history().find(e => e.id === 'piet-rose-1').metadata.repeat_count, 5);
  assert.equal(h.history().find(e => e.id === 'jan-heart').metadata.repeat_count, 4);
});

test('gift history displays real gift fields and sender, keeping Channel Points out', () => {
  const h = harness(); h.receiveEvent(gift('g', 5, true, 'Piet', 'Rose'));
  h.receiveEvent(redemption());
  const html = renderToStaticMarkup(React.createElement(h.load('alerts/AlertHistory.tsx').AlertHistory, { alertHistory: h.history() }));
  assert.match(html, /Rose ×5/); assert.match(html, /Piet/);
  assert.doesNotMatch(html, /Channel Points|Kies mijn loadout/);
  assert.equal(h.messages.length, 1);
});

test('non-streak gifts and incomplete optional fields are safe; malformed counts are rejected', () => {
  const h = harness(), normalize = h.load('platforms/tiktok/giftEvents.ts').toTikTokGiftEvent;
  const event = normalize({ type: 'gift', platform: 'tiktok', eventId: 'one', repeatCount: 1, giftType: 0 });
  assert.equal(event.user.display_name, 'TikTok Viewer');
  assert.equal(event.metadata.gift_name, 'TikTok Gift');
  assert.equal(h.receiveEvent(event), true); assert.equal(h.queue().length, 1);
  assert.equal(h.receiveEvent(event), false);
  assert.equal(normalize({ type: 'gift', platform: 'tiktok', eventId: 'bad', repeatCount: -2 }), null);
  const named = normalize({ type: 'gift', platform: 'tiktok', eventId: 'two', repeatCount: 2, username: {}, uniqueId: 'handle', giftName: {} });
  assert.equal(named.user.display_name, 'handle');
});

test('targeted diagnostics whitelists fields, bounds bursts, and always logs final totals', () => {
  const h = harness(), log = h.load('platforms/tiktok/eventDiagnostics.ts').createTikTokEventDiagnostics();
  for (let i = 0; i < 100; i++) log({ ...join(String(i)), metadata: { raw: 'DO_NOT_LOG' } }, 1000);
  assert.equal(h.diagnosticEvents.length, 20);
  log(gift('final', 10, true), 1000);
  assert.equal(h.diagnosticEvents.length, 21);
  const details = h.diagnosticEvents.at(-1)[2];
  assert.equal(details.repeat_count, 10); assert.equal(details.repeat_end, true);
  assert.equal(details.sender, 'Piet'); assert.equal(details.suppressed_details, 80);
  assert.ok(!JSON.stringify(h.diagnosticEvents).includes('DO_NOT_LOG'));
  log({ ...gift('preview', 1, true), raw_event_type: 'simulated.gift' }, 2000);
  assert.equal(h.diagnosticEvents.length, 21);
});
