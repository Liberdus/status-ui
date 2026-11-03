const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
function element(tag = 'div') {
  return { tag, children: [], style: {}, dataset: {}, textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
  };
}
function load() {
  const nodes = new Map();
  const context = vm.createContext({
    Date, URLSearchParams, AbortController, setTimeout, clearTimeout,
    document: {
      readyState: 'loading', addEventListener() {},
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      createElement: element, createTextNode: text => ({ tag: '#text', textContent: text }),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  return { context, nodes };
}
test('tooltip renders hostile service names as text nodes', () => {
  const { context, nodes } = load();
  const value = 'Gateway <img src=x onerror="alert(1)">';
  context.handleBarEnter({ currentTarget: {
    dataset: { service: value, status: 'up', pct: '100', date: new Date().toISOString() },
    getBoundingClientRect: () => ({ left: 0, width: 10, bottom: 10 }),
  } });
  const children = nodes.get('uptime-tooltip').children;
  assert(children.some(node => node.tag === '#text' && node.textContent.includes(value)));
  assert(children.every(node => ['#text', 'br'].includes(node.tag)));
});
test('missing and invalid history stays unknown and renders without exceptions', () => {
  const { context, nodes } = load();
  vm.runInContext(`backendHistory = { historyByService: new Map([['test', [{date: new Date(), successPct: null, total: 0}]]]) };`, context);
  const history = context.buildServiceHistory({ id: 'test', uptime30d: 100 }, 1);
  assert.equal(history[0].state, 'unknown'); assert.equal(history[0].successPct, null);
  for (const value of [null, undefined, NaN, Infinity, -1, 101]) assert.equal(context.classifyStateFromPct(value), 'unknown');
  context.renderServiceUptimeList([{ id: 'test', name: 'Gateway', status: 'unknown', uptime30d: null }], 1);
  assert(nodes.get('service-uptime-list').children.length > 0);
  vm.runInContext('backendHistory = null', context);
  assert.equal(context.buildServiceHistory({ id: 'test', uptime30d: 100 }, 1).length, 0);
});
test('empty and unknown services never aggregate to all operational', () => {
  const { context } = load();
  assert.equal(context.summarizeOverallStatus([], []).status, 'unknown');
  assert.equal(context.summarizeOverallStatus([{ status: 'unknown' }], []).status, 'unknown');
  assert.equal(context.summarizeOverallStatus([{ status: 'operational' }], []).status, 'operational');
});
test('failed history fetch clears previous data and stale summaries are unavailable', async () => {
  const { context } = load();
  vm.runInContext('backendHistory = { old: true }', context);
  context.fetch = async () => ({ ok: false });
  assert.equal(await context.loadBackendHistory(7, '5m'), null);
  assert.equal(vm.runInContext('backendHistory', context), null);
  context.fetch = async () => ({ ok: true, json: async () => ({ generatedAt: '2000-01-01T00:00:00Z', services: [] }) });
  assert.equal((await context.loadBackendSnapshot()).fetchFailed, true);
});
test('preview serves assets and denies private files and traversal', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['local-server.mjs'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error(`Preview exited: ${code}`)));
    child.stdout.on('data', data => { const match = String(data).match(/localhost:(\d+)/); if (match) resolve(match[1]); });
  });
  for (const route of ['/', '/main.js', '/style.css', '/local-demo.html?scenario=all-up']) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`); assert.equal(response.status, 200); await response.arrayBuffer();
  }
  for (const route of ['/env.md', '/.env', '/.git/config', '/README.md', '/documentation/security-review/report.md', '/%2e%2e/env.md', '/%65nv.md']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${route}`, { method: 'HEAD' })).status, 404);
  }
});
