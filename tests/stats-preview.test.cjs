const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function harness(dev) {
  const states = [], effects = [], diagnostics = [];
  let cursor = 0;
  const live = { tiktokConnected: false, tiktokViewerCount: null, tiktokLiveStats: { totalLikes: null }, tiktokChildRef: { current: null } };
  const mocks = {
    react: { useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; }, useEffect: fn => effects.push(fn) },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  };
  function load(file) {
    const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env.DEV', String(dev));
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    function req(id) {
      if (mocks[id]) return mocks[id];
      if (id.endsWith('.css')) return {};
      if (id.endsWith('/diagnostics')) return { startFrontendDiagnostics: () => {}, updateDiagnosticSnapshot: d => diagnostics.push(d) };
      if (id.endsWith('/useTikTok')) return { useTikTok: () => live };
      if (id.endsWith('/useTwitch')) return { useTwitch: () => ({ twitchEventSubStatus: { status: 'offline' } }) };
      if (id.endsWith('/useChat')) return { useChat: () => ({ setMessages() {} }) };
      if (id.endsWith('/useAlerts')) return { useAlerts: () => ({ alertHistory: [] }) };
      if (id.endsWith('/useYouTube')) return { useYouTube: () => ({}) };
      if (id.endsWith('/useUpdater')) return { useUpdater: () => ({}) };
      if (id.endsWith('/usePlatformEvents')) return { usePlatformEvents: () => ({ receiveEvent() { throw Error('Preview must not emit real events'); } }) };
      if (id.endsWith('/testLiveStats') || id.endsWith('/liveStatsStore')) return load(path.resolve(path.dirname(file), id + '.ts'));
      const name = id.split('/').pop();
      return { [name]: name, default: name };
    }
    new Function('require', 'module', 'exports', js)(req, module, module.exports);
    return module.exports;
  }
  const App = load(root + '/src/App.tsx').default;
  function render() { cursor = 0; effects.length = 0; const tree = App(); effects.forEach(fn => fn()); return tree; }
  function find(tree, type) {
    if (!tree || typeof tree !== 'object') return null;
    if (tree.type === type) return tree.props;
    for (const child of [tree.props?.children].flat()) { const found = find(child, type); if (found) return found; }
    return null;
  }
  return { live, diagnostics, render, find };
}
test('preview affects only topbar, reset restores actual data, diagnostics stay real', () => {
  const h = harness(true);
  let tree = h.render();
  assert.equal(h.find(tree, 'Topbar').statsPreviewActive, false);
  h.find(tree, 'Topbar').setSettingsOpen(true);
  tree = h.render();
  h.find(tree, 'EventTestPanel').onEnableStatsPreview();
  tree = h.render();
  const bar = h.find(tree, 'Topbar');
  assert.equal(bar.tiktokViewerCount, 47);
  assert.equal(bar.tiktokLiveStats.diamondsObserved, 850);
  assert.equal(bar.tiktokLiveStats.sessionId, null);
  assert.equal(h.find(tree, 'ChatMessages').tiktokViewerCount, null);
  assert.ok(h.diagnostics.every(d => d.tiktokViewerCount === null && d.tiktokConnected === false));
  bar.onResetStatsPreview();
  assert.equal(h.find(h.render(), 'Topbar').tiktokLiveStats, h.live.tiktokLiveStats);
  assert.equal(h.find(h.render(), 'Topbar').statsPreviewActive, false);
});
test('production guard rejects preview activation and fresh app always starts with real state', () => {
  const h = harness(false);
  h.find(h.render(), 'Topbar').setSettingsOpen(true);
  h.find(h.render(), 'EventTestPanel').onEnableStatsPreview();
  const bar = h.find(h.render(), 'Topbar');
  assert.equal(bar.statsPreviewActive, false);
  assert.equal(bar.tiktokLiveStats, h.live.tiktokLiveStats);
  const fresh = harness(true);
  assert.equal(fresh.find(fresh.render(), 'Topbar').statsPreviewActive, false);
});
