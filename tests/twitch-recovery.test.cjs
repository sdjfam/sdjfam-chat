const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, mocks) {
  const js = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(id => {
    if (id in mocks) return mocks[id];
    throw new Error(`Unexpected dependency ${id}`);
  }, module, module.exports);
  return module.exports;
}
test('only terminal auth categories ask for relinking', () => {
  const { eventSubNeedsRelogin } = load('src/platforms/twitch/eventSubStatus.ts', {});
  for (const status of ['relink_required', 'missing_scopes']) {
    assert.equal(eventSubNeedsRelogin({ status, message: '' }), true);
  }
  for (const status of ['network_error', 'temporary_service_error', 'configuration_error', 'retry_scheduled', 'retry_exhausted', 'connected']) {
    assert.equal(eventSubNeedsRelogin({ status, message: 'Opnieuw koppelen is niet nodig' }), false);
  }
});
function harness() {
  const effects=[], calls=[], statuses=[]; let callback; let unlistens=0;
  const diagnostics = new Proxy({}, { get: () => () => {} });
  const hook = load('src/platforms/twitch/useTwitch.ts', {
    react: { useRef: x => ({ current: x }), useState: x => [x, value => { if (value?.status) statuses.push(value.status); }], useEffect: fn => effects.push(fn) },
    '@tauri-apps/api/core': { invoke: async name => { calls.push(name); return { connected: true, message: 'ok' }; } },
    '@tauri-apps/api/event': { listen: async (name, fn) => { assert.equal(name, 'twitch-eventsub-status'); callback=fn; return () => unlistens++; } },
    'tmi.js': {}, '../../diagnostics': diagnostics, '../../utils/normalizeViewerCount': { normalizeViewerCount: x => x },
    './config': { TWITCH_CLIENT_ID: 'fake-client', TWITCH_CHANNEL: 'test' },
  });
  hook.useTwitch({ setMessages: () => {}, chatUserProfilesRef: { current: new Map() } });
  return { mount: () => effects[1](), calls, statuses, emit: status => callback({ payload: { status, message: 'test' } }), unlistens: () => unlistens };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('backend recovery updates status without spawning frontend retries', async () => {
  const h=harness(), cleanup=h.mount(); await flush();
  for (const s of ['network_error','retry_scheduled','connecting','connected']) h.emit(s);
  await flush();
  assert.deepEqual(h.statuses.slice(-4),['network_error','retry_scheduled','connecting','connected']);
  assert.equal(h.calls.filter(x=>x==='twitch_start_eventsub').length,1);
  cleanup(); await flush(); assert.equal(h.unlistens(),1);
  assert.equal(h.calls.filter(x=>x==='twitch_stop_eventsub').length,1);
});
test('cleanup and remount serialize stop before the next start', async () => {
  const h=harness(), cleanup=h.mount(); await flush(); cleanup();
  const cleanup2=h.mount(); await flush();
  assert.deepEqual(h.calls.filter(x=>/eventsub/.test(x)), ['twitch_start_eventsub','twitch_stop_eventsub','twitch_start_eventsub']);
  cleanup2(); await flush(); assert.equal(h.unlistens(),2);
});
