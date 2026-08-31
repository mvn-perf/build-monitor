/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { generateSite, renderIndexHtml, embedJson } = require('../src/site');
const { emptyHistory } = require('../src/history');

const SITE = path.join(__dirname, '..', 'site');
const SANDBOX_ATTR = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads';

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'bm') + '-')); }

function smokeHistory() {
  const base = Date.now() - 3600000;
  function iso(off) { return new Date(base + off).toISOString(); }
  const h = emptyHistory('acme/widgets');
  h.repositoryUrl = 'https://github.com/acme/widgets';
  h.serverUrl = 'https://github.com';
  h.defaultBranch = 'main';
  h.generatedAt = iso(0);
  h.stats = { reportsCount: 3, reportsBytes: 5000000 };
  h.workflows = { '1': { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, '3': { id: 3, name: 'Build monitor', path: '.github/workflows/build-monitor.yml', state: 'active' } };
  const summary = { status: 'OK', totalMs: 100000, wallMs: 95000, cpuMs: 80000, gcMs: 3000, goals: ['verify'], threads: 4, jdkVersion: '25', mavenVersion: '3.9.9', moduleCount: 5, startedAt: base - 7 * 86400000 + 10000, endedAt: base - 7 * 86400000 + 110000, environment: { mvnd: false } };
  h.runs = [
    {
      id: 5000000001, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 12, attempt: 2,
      event: 'push', status: 'completed', conclusion: 'success', branch: 'main', sha: 'a'.repeat(40), title: 'Speed up the reactor', actor: 'octocat',
      htmlUrl: 'https://github.com/acme/widgets/actions/runs/5000000001',
      createdAt: iso(-600000), startedAt: iso(-590000), completedAt: iso(-290000), durationMs: 300000, queueMs: 10000,
      jobs: [{
        id: 91, name: 'build', status: 'completed', conclusion: 'success', startedAt: iso(-588000), completedAt: iso(-292000), durationMs: 296000,
        runnerName: 'GitHub Actions 7', labels: ['ubuntu-latest'], htmlUrl: 'https://github.com/acme/widgets/actions/runs/5000000001/job/91',
        steps: [
          { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', startedAt: iso(-588000), completedAt: iso(-586000), durationMs: 2000 },
          { number: 4, name: 'Build with Maven', status: 'completed', conclusion: 'success', startedAt: iso(-585000), completedAt: iso(-480000), durationMs: 105000 },
          { number: 5, name: 'Publish mvn-lens report', status: 'completed', conclusion: 'success', startedAt: iso(-480000), completedAt: iso(-478000), durationMs: 2000 },
          { number: 6, name: 'Skipped step', status: 'completed', conclusion: 'skipped', startedAt: null, completedAt: null, durationMs: null },
        ],
      }],
      mvnLens: [
        { key: 'j91-s4', jobId: 91, jobName: 'build', jobUrl: 'https://github.com/acme/widgets/actions/runs/5000000001/job/91', stepNumber: 4, stepName: 'Build with Maven', label: null, attempt: 2, attribution: 'jobId', superseded: false, collectedAt: iso(0), bytes: 2900000, reports: [{ name: 'report.html', path: 'reports/5000000001/j91-s4/report.html', summary: Object.assign({}, summary, { startedAt: base - 585000 + 5000, endedAt: base - 485000 }), summarySource: 'meta', bytes: 2900000 }] },
        { key: 'j80-s4', jobId: 80, jobName: 'build', jobUrl: null, stepNumber: 4, stepName: 'Build with Maven', label: null, attempt: 1, attribution: 'stale-job', superseded: true, collectedAt: iso(0), bytes: 1000, reports: [{ name: 'report.html', path: 'reports/5000000001/j80-s4/report.html', summary: Object.assign({}, summary, { status: 'FAILED' }), summarySource: 'meta', bytes: 1000 }] },
        { key: 'loose-abc123', jobId: null, jobName: null, jobUrl: null, stepNumber: null, stepName: null, label: 'sidecar', attempt: 2, attribution: 'none', superseded: false, collectedAt: iso(0), bytes: 500, reports: [{ name: 'report.html', path: 'reports/5000000001/loose-abc123/report.html', summary: Object.assign({}, summary), summarySource: 'meta', bytes: 500 }] },
      ],
    },
    {
      id: 5000000000, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 11, attempt: 1,
      event: 'push', status: 'completed', conclusion: 'failure', branch: 'main', sha: 'b'.repeat(40), title: 'Try something', actor: 'hubot',
      htmlUrl: 'https://github.com/acme/widgets/actions/runs/5000000000',
      createdAt: iso(-7 * 86400000), startedAt: iso(-7 * 86400000), completedAt: iso(-7 * 86400000 + 400000), durationMs: 400000, queueMs: 5000,
      jobs: [{ id: 71, name: 'build', status: 'completed', conclusion: 'failure', startedAt: iso(-7 * 86400000), completedAt: iso(-7 * 86400000 + 390000), durationMs: 390000, runnerName: 'GitHub Actions 3', labels: ['ubuntu-latest'], htmlUrl: 'https://github.com/acme/widgets/actions/runs/5000000000/job/71', steps: [{ number: 4, name: 'Build with Maven', status: 'completed', conclusion: 'failure', startedAt: iso(-7 * 86400000), completedAt: iso(-7 * 86400000 + 380000), durationMs: 380000 }] }],
      mvnLens: [{ key: 'j71-s4', jobId: 71, jobName: 'build', jobUrl: null, stepNumber: 4, stepName: 'Build with Maven', label: null, attempt: 1, attribution: 'jobId', superseded: false, collectedAt: iso(0), bytes: 1200, reports: [{ name: 'report.html', path: 'reports/5000000000/j71-s4/report.html', summary: Object.assign({}, summary, { status: 'FAILED', totalMs: 130000 }), summarySource: 'meta', bytes: 1200 }] }],
    },
  ];
  return h;
}

function extractData(html) {
  const m = /<script id="build-monitor-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'data block present');
  return m[1];
}
function decodeEmbedded(raw) {
  raw = raw.trim();
  if (raw.startsWith('gzip:')) return JSON.parse(zlib.gunzipSync(Buffer.from(raw.slice(5), 'base64')).toString('utf8'));
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// renderIndexHtml / generateSite
// ---------------------------------------------------------------------------

test('renderIndexHtml with dataset null leaves the data block empty and fills every placeholder', () => {
  const html = renderIndexHtml({ title: 'My <monitor>', dataset: null });
  assert.ok(html.includes('<script id="build-monitor-data" type="application/json"></script>'), 'empty data block');
  assert.ok(html.includes('<title>My &lt;monitor&gt;</title>'), 'title escaped');
  for (const ph of ['__TITLE__', '__APP_CSS__', '__DATA_JSON__', '__VENDOR_JS__', '__MODEL_JS__', '__APP_JS__']) {
    assert.ok(!html.includes(ph), ph + ' replaced');
  }
  assert.ok(html.includes('Chart.js v4'), 'Chart.js inlined');
  assert.ok(html.includes('BuildMonitorModel'), 'model.js inlined');
  assert.ok(html.includes(SANDBOX_ATTR), 'iframe sandbox attribute string present');
  assert.ok(html.includes("referrerpolicy: 'no-referrer'"), 'iframe referrerpolicy present');
  assert.equal(renderIndexHtml({ title: 'My <monitor>', dataset: null }), html, 'pure and deterministic');
});

test('generateSite writes index.html, data/history.json and .nojekyll; no inline data by default', () => {
  const dir = tmpDir('site');
  const history = smokeHistory();
  const out = generateSite({ history, siteDir: dir, title: 'Build monitor · acme/widgets' });
  const html = fs.readFileSync(out.indexFile, 'utf8');
  assert.ok(html.includes('<script id="build-monitor-data" type="application/json"></script>'), 'dataset not inlined by default');
  assert.ok(fs.existsSync(path.join(dir, '.nojekyll')));
  const hist = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'history.json'), 'utf8'));
  assert.equal(hist.runs.length, history.runs.length);
  assert.equal(hist.repository, 'acme/widgets');
});

test('inline dataset round-trips, including the gzip embedding', () => {
  const dir = tmpDir('site');
  const history = smokeHistory();
  history.runs[0].title = '</script><!-- sneaky -->';
  const out = generateSite({ history, siteDir: dir, inline: true, gzipThreshold: null });
  const raw = extractData(fs.readFileSync(out.indexFile, 'utf8'));
  assert.ok(!/<\/script/i.test(raw), 'no script-closing sequence inside the block');
  assert.ok(!raw.includes('<!--'));
  const data = decodeEmbedded(raw);
  assert.equal(data.runs[0].title, '</script><!-- sneaky -->');
  assert.equal(data.runs.length, history.runs.length);

  // Large datasets are gzip-embedded and still decode.
  const big = smokeHistory();
  for (let i = 0; i < 300; i++) big.runs.push({ id: 6000000000 + i, workflowId: 1, runNumber: i, status: 'completed', conclusion: 'success', createdAt: new Date().toISOString(), durationMs: 1000 + i, jobs: [{ id: i, name: 'build', steps: [{ number: 1, name: 'x'.repeat(150), durationMs: 5 }] }], mvnLens: [] });
  const dir2 = tmpDir('site');
  const out2 = generateSite({ history: big, siteDir: dir2, inline: true, gzipThreshold: 1024 });
  const raw2 = extractData(fs.readFileSync(out2.indexFile, 'utf8'));
  assert.ok(raw2.trim().startsWith('gzip:'), 'gzip embedding above the threshold');
  assert.equal(decodeEmbedded(raw2).runs.length, big.runs.length);
});

test('embedJson neutralises script-closing and comment sequences while staying valid JSON', () => {
  const s = embedJson({ a: '</script><!-- x -->', b: 'line sep' });
  assert.ok(!/<\/script/i.test(s));
  assert.ok(!s.includes('<!--'));
  assert.ok(!s.includes(' '));
  assert.deepEqual(JSON.parse(s), { a: '</script><!-- x -->', b: 'line sep' });
});

// ---------------------------------------------------------------------------
// static safety checks on the browser sources
// ---------------------------------------------------------------------------

/** Drops block comments and line comments (a "//" preceded by whitespace or at line start — "https://" inside a string survives). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}
/** Anything that turns a string into markup or code. Applied to the comment-free source, so a comment may talk about innerHTML. */
const HTML_SINK_RE = /innerHTML|outerHTML|insertAdjacentHTML|srcdoc|document\.write|\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"]/;
/** The licence header scripts/check-syntax.js enforces (site/*.js are checked like every shipped script). */
const HEADER_RE = /^\/\*\r?\n \* Copyright \(c\) The mvn-perf Authors\.\r?\n \* Licensed under the Apache License, Version 2\.0\./;

test('stripComments keeps code and string URLs but removes comments', () => {
  const sample = "/* never innerHTML */\nvar u = 'https://github.com'; // innerHTML in a trailing comment\n// innerHTML on its own line\nx.textContent = u;";
  const stripped = stripComments(sample);
  assert.ok(!/innerHTML/.test(stripped), 'comments removed');
  assert.ok(stripped.includes("'https://github.com'"), 'URL inside a string kept');
  assert.ok(stripped.includes('x.textContent = u;'), 'code kept');
  assert.ok(HTML_SINK_RE.test(stripComments('el.innerHTML = s;')), 'a real assignment is still caught');
  assert.ok(HTML_SINK_RE.test(stripComments("el.insertAdjacentHTML('beforeend', s)")));
  assert.ok(HTML_SINK_RE.test(stripComments('iframe.srcdoc = s')));
});

test('app.js and model.js parse under vm, carry the licence header and never write HTML strings into the DOM', () => {
  for (const f of ['app.js', 'model.js']) {
    const src = fs.readFileSync(path.join(SITE, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }));
    assert.match(src, HEADER_RE, f + ': Apache-2.0 header as scripts/check-syntax.js expects it');
    const code = stripComments(src);
    const m = HTML_SINK_RE.exec(code);
    assert.equal(m, null, f + ': HTML/code sink used: ' + (m && m[0]) + ' (textContent / element builder only)');
    if (f === 'app.js') assert.ok(code.includes('textContent'), 'app.js inserts text through textContent');
  }
});

test('the rendered page loads the data block, then Chart.js, then model.js, then app.js', () => {
  const html = renderIndexHtml({ title: 't', dataset: { runs: [] } });
  const at = (marker) => { const i = html.indexOf(marker); assert.ok(i >= 0, 'marker present: ' + marker); return i; };
  const data = at('<script id="build-monitor-data" type="application/json">');
  const vendor = at('Chart.js v4');
  const model = at('root.BuildMonitorModel = api');
  const app = at('var M = window.BuildMonitorModel;');
  assert.ok(data < vendor && vendor < model && model < app, `order data(${data}) < vendor(${vendor}) < model(${model}) < app(${app})`);
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'), 'page-level referrer policy');
  assert.ok(html.includes('<meta name="color-scheme" content="light dark">'), 'light + dark');
});

test('model.js attaches to window.BuildMonitorModel in a browser-like sandbox', () => {
  const src = fs.readFileSync(path.join(SITE, 'model.js'), 'utf8');
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'model.js' });
  assert.ok(sandbox.BuildMonitorModel, 'window.BuildMonitorModel defined');
  assert.equal(typeof sandbox.BuildMonitorModel.parseRoute, 'function');
});

// ---------------------------------------------------------------------------
// smoke-render the app against a minimal fake DOM (no browser available)
// ---------------------------------------------------------------------------

function makeDom(inlineJson) {
  const byId = new Map();
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.className = ''; this._text = ''; this.listeners = {};
      const el = this;
      this.classList = {
        toggle(n, force) { const cs = el.className ? el.className.split(/\s+/).filter(Boolean) : []; const i = cs.indexOf(n); const want = force === undefined ? i < 0 : !!force; if (want && i < 0) cs.push(n); if (!want && i >= 0) cs.splice(i, 1); el.className = cs.join(' '); },
        add(n) { this.toggle(n, true); }, remove(n) { this.toggle(n, false); },
        contains(n) { return el.className.split(/\s+/).indexOf(n) >= 0; },
      };
    }
    appendChild(c) {
      if (c.tagName === '#FRAGMENT') { for (const x of c.children.slice()) this.appendChild(x); return c; }
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this; this.children.push(c); return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
    get firstChild() { return this.children[0] || null; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') byId.set(String(v), this); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    dispatch(type, ev) { for (const fn of this.listeners[type] || []) fn(Object.assign({ target: this }, ev || {})); }
    get textContent() { return this.tagName === '#TEXT' ? this._text : this.children.map(c => c.textContent).join(''); }
    set textContent(v) { if (this.tagName === '#TEXT') { this._text = String(v); return; } this.children.forEach(c => { c.parentNode = null; }); this.children = []; if (v !== '') { const t = new El('#text'); t._text = String(v); t.parentNode = this; this.children.push(t); } }
    querySelectorAll(sel) { const want = String(sel).toUpperCase(); const out = []; (function walk(n) { for (const c of n.children) { if (c.tagName === want) out.push(c); walk(c); } })(this); return out; }
    getContext() { return null; }
    focus() { } blur() { }
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  }
  const htmlEl = new El('html');
  const body = new El('body');
  htmlEl.appendChild(body);
  const app = new El('div'); app.setAttribute('id', 'app'); body.appendChild(app);
  const dataNode = new El('script'); dataNode.setAttribute('id', 'build-monitor-data'); dataNode.textContent = inlineJson || '';
  body.appendChild(dataNode);
  const document = {
    documentElement: htmlEl, body,
    title: 'Build monitor · acme/widgets',
    createElement: t => new El(t),
    createTextNode: v => { const t = new El('#text'); t._text = String(v); return t; },
    createDocumentFragment: () => new El('#fragment'),
    getElementById: id => byId.get(id) || null,
  };
  return { document, app, El };
}

/** A localStorage stand-in (Map-backed) so the persisted filters can be inspected. */
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}

/** Boots model.js + app.js in a vm sandbox around the fake DOM. opts: { storage: {key: json}, fetch }. */
async function bootApp(inlineJson, hash, opts) {
  const o = opts || {};
  const dom = makeDom(inlineJson);
  const intervals = [];
  const intervalFns = [];
  const storage = fakeStorage(o.storage);
  const sandbox = {
    console, URL, setTimeout, clearTimeout,
    setInterval: (fn, ms) => { intervals.push(ms); intervalFns.push(fn); return intervals.length; },
    clearInterval: () => { },
    requestAnimationFrame: fn => { fn(); return 1; },
    addEventListener: () => { },
    getComputedStyle: () => ({ getPropertyValue: () => '#2a78d6' }),
    localStorage: storage,
    document: dom.document,
    location: { hash: hash || '#/reports', protocol: 'https:' },
    fetch: o.fetch || (() => Promise.reject(new Error('network disabled in this test'))),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SITE, 'model.js'), 'utf8'), sandbox, { filename: 'model.js' });
  vm.runInContext(fs.readFileSync(path.join(SITE, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 25));   // loadData() resolves asynchronously
  return { sandbox, dom, intervals, intervalFns, storage };
}
function viewText(dom) { const v = dom.document.getElementById('view'); return v ? v.textContent : ''; }
function hrefs(dom) { return dom.app.querySelectorAll('a').map(a => a.getAttribute('href')); }
/** Every element under root in document order. */
function docOrder(root) { const out = []; (function walk(n) { for (const c of n.children) { out.push(c); walk(c); } })(root); return out; }
function anchorsByText(dom, text) { return dom.app.querySelectorAll('a').filter(a => a.textContent === text); }
const STORAGE_KEY = 'build-monitor.filters.acme/widgets';

test('smoke: the app renders every route from an inline dataset without a browser', async (t) => {
  const { sandbox, dom, intervals, intervalFns } = await bootApp(JSON.stringify(smokeHistory()));

  await t.test('reports view (default): filters, table grouped by run first, then the Trends strip', () => {
    assert.match(sandbox.document.title, /mvn-lens reports/);
    const text = viewText(dom);
    assert.ok(!text.includes('failed to render'), 'no render error: ' + text.slice(0, 200));
    assert.match(text, /Trends/);
    assert.match(text, /Show superseded \(1\)/);
    assert.match(text, /#12/);
    assert.match(text, /unattributed/);
    assert.ok(hrefs(dom).includes('#/report/5000000001/j91-s4'), 'viewer link present');
    const gh = hrefs(dom).filter(h => h && h.startsWith('https://'));
    assert.ok(gh.includes('https://github.com/acme/widgets/actions/runs/5000000001/job/91#step:4:1'), 'step deep link present');
    assert.ok(gh.every(h => h.startsWith('https://github.com/')), 'external links only to the server host');
    // Order inside the view: filter bars, the reports table, then the (collapsible) trends strip.
    const order = docOrder(dom.document.getElementById('view'));
    const table = order.findIndex(e => e.tagName === 'TABLE');
    const trends = order.findIndex(e => e.tagName === 'DETAILS');
    assert.ok(table >= 0 && trends >= 0 && table < trends, `table (${table}) before trends (${trends})`);
    assert.equal(order[trends].getAttribute('open'), '', '≤ 4 series → strip open');
    // Grouped by run: the first body row is a run header (#12), and the step deep link degrades with a tooltip naming the attribution.
    const rows = order.filter(e => e.tagName === 'TR');
    assert.ok(rows[1].className.includes('group'), 'first body row is a run group header');
    assert.match(rows[1].textContent, /#12/);
    const stepLink = anchorsByText(dom, 'GitHub step ↗')[0];
    assert.match(stepLink.getAttribute('title'), /attributed by jobId/);
    const runLink = anchorsByText(dom, 'GitHub run ↗')[0];
    assert.ok(runLink, 'unattributed entry degrades to the run link');
    assert.match(runLink.getAttribute('title'), /attribution: none/);
    // Constant columns are auto-hidden and listed under the table (every row has JDK 25).
    assert.match(text, /Same on every row \(hidden\):.*JDK: 25/);
  });

  await t.test('builds view', () => {
    sandbox.location.hash = '#/builds';
    sandbox.buildMonitor.render();
    assert.match(sandbox.document.title, /Builds/);
    const text = viewText(dom);
    assert.ok(!text.includes('failed to render'), text.slice(0, 200));
    assert.match(text, /Success rate/);
    assert.match(text, /CI/);
    assert.match(text, /Runs/);
  });

  await t.test('run page', () => {
    sandbox.location.hash = '#/run/5000000001';
    sandbox.buildMonitor.render();
    const text = viewText(dom);
    assert.ok(!text.includes('failed to render'), text.slice(0, 200));
    assert.match(sandbox.document.title, /#12/);
    assert.match(text, /Jobs & steps/);
    assert.match(text, /mvn-lens reports/);
    assert.match(text, /Build with Maven/);
    assert.equal(sandbox.document.body.className, '', 'not in viewer mode');
  });

  await t.test('viewer route: sandboxed iframe fed only from the stored, re-validated path', () => {
    sandbox.location.hash = '#/report/5000000001/j91-s4';
    sandbox.buildMonitor.render();
    assert.equal(sandbox.document.body.className, 'viewer-mode');
    const iframes = dom.app.querySelectorAll('iframe');
    assert.equal(iframes.length, 1);
    assert.equal(iframes[0].getAttribute('sandbox'), SANDBOX_ATTR);
    assert.equal(iframes[0].getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(iframes[0].getAttribute('src'), 'reports/5000000001/j91-s4/report.html');
    assert.match(viewText(dom), /2\.8 MB/, 'loading placeholder shows the report size');
    assert.match(sandbox.document.title, /mvn-lens report/);
    // Context bar links, each once: GitHub step ↗ · GitHub job ↗ · Run details · Open raw ↗
    assert.equal(anchorsByText(dom, 'GitHub step ↗').length, 1);
    assert.equal(anchorsByText(dom, 'GitHub step ↗')[0].getAttribute('href'), 'https://github.com/acme/widgets/actions/runs/5000000001/job/91#step:4:1');
    assert.equal(anchorsByText(dom, 'GitHub job ↗').length, 1);
    assert.equal(anchorsByText(dom, 'GitHub job ↗')[0].getAttribute('href'), 'https://github.com/acme/widgets/actions/runs/5000000001/job/91');
    assert.equal(anchorsByText(dom, 'Run details').length, 1);
    assert.equal(anchorsByText(dom, 'Run details')[0].getAttribute('href'), '#/run/5000000001');
    const raw = anchorsByText(dom, 'Open raw ↗');
    assert.equal(raw.length, 1);
    assert.equal(raw[0].getAttribute('href'), 'reports/5000000001/j91-s4/report.html', 'raw link is the stored, validated path');
    assert.equal(raw[0].getAttribute('rel'), 'noopener noreferrer');
    assert.match(viewText(dom), /CI.*#12.*main.*build › Build with Maven.*Maven.*1m 40s/, 'context: workflow · #n · branch · job › step · Maven total');
  });

  await t.test('viewer of an unattributed report: the step link degrades to one run link', () => {
    sandbox.location.hash = '#/report/5000000001/loose-abc123';
    sandbox.buildMonitor.render();
    assert.equal(sandbox.document.body.className, 'viewer-mode');
    assert.equal(anchorsByText(dom, 'GitHub step ↗').length, 0);
    assert.equal(anchorsByText(dom, 'GitHub job ↗').length, 0);
    assert.equal(anchorsByText(dom, 'GitHub run ↗').length, 1);
    assert.equal(anchorsByText(dom, 'GitHub run ↗')[0].getAttribute('href'), 'https://github.com/acme/widgets/actions/runs/5000000001');
    assert.equal(dom.app.querySelectorAll('iframe')[0].getAttribute('src'), 'reports/5000000001/loose-abc123/report.html');
  });

  await t.test('pending state for an unknown run id', () => {
    sandbox.location.hash = '#/run/9999999999';
    sandbox.buildMonitor.render();
    const text = viewText(dom);
    assert.match(text, /[Ww]aiting for the Build monitor workflow/);
    const gh = hrefs(dom);
    assert.ok(gh.includes('https://github.com/acme/widgets/actions/runs/9999999999'), 'GitHub run link built from the validated id');
    assert.ok(gh.includes('https://github.com/acme/widgets/actions/workflows/build-monitor.yml'), 'Build monitor workflow link');
    assert.ok(intervals.includes(30000), 'auto re-fetch every 30 s armed');
  });

  await t.test('pending state for an unknown report key', () => {
    sandbox.location.hash = '#/report/5000000001/j99-s9';
    sandbox.buildMonitor.render();
    assert.match(viewText(dom), /[Ww]aiting for the Build monitor workflow/);
    assert.equal(sandbox.document.body.className, '', 'pending report is not viewer mode');
  });

  await t.test('the pending poll re-fetches data/history.json with cache no-store and renders the run once it appears', async () => {
    sandbox.location.hash = '#/run/9999999999';
    sandbox.buildMonitor.render();
    const fetched = [];
    const updated = smokeHistory();
    updated.runs.unshift(Object.assign({}, updated.runs[0], { id: 9999999999, runNumber: 13, mvnLens: [], jobs: [] }));
    sandbox.fetch = (url, opts) => { fetched.push({ url, opts }); return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(updated)) }); };
    await intervalFns[intervalFns.length - 1]();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].url, 'data/history.json');
    assert.equal(fetched[0].opts.cache, 'no-store');
    assert.match(sandbox.document.title, /#13/, 'the run page replaced the pending state');
    assert.match(viewText(dom), /Jobs & steps/);
  });
});

test('smoke: a job-only attribution shows one GitHub job link and no step link in the viewer', async () => {
  const h = smokeHistory();
  const e = h.runs[0].mvnLens[0];
  e.stepNumber = null; e.stepName = null; e.attribution = 'jobName/job-only';
  const { sandbox, dom } = await bootApp(JSON.stringify(h), '#/report/5000000001/j91-s4');
  assert.equal(sandbox.document.body.className, 'viewer-mode');
  assert.equal(anchorsByText(dom, 'GitHub step ↗').length, 0);
  const job = anchorsByText(dom, 'GitHub job ↗');
  assert.equal(job.length, 1, 'exactly one job link (no duplicate from the degraded step link)');
  assert.match(job[0].getAttribute('title'), /Step unknown.*attributed by jobName\/job-only/);
});

test('smoke: filters and reports-view extras are persisted per repository and re-validated on load', async () => {
  const seriesKey = '.github/workflows/ci.yml build Build with Maven ';
  const saved = { range: '7d', branch: 'main', event: 'bogus-event', status: 'failure', workflow: '', series: seriesKey, maven: 'failed', showSuperseded: true };
  const { sandbox, dom, storage } = await bootApp(JSON.stringify(smokeHistory()), '#/reports', { storage: { [STORAGE_KEY]: JSON.stringify(saved) } });
  const f = sandbox.buildMonitor.filters();
  assert.equal(f.range, '7d');
  assert.equal(f.branch, 'main');
  assert.equal(f.event, '', 'an event that no run has is dropped');
  assert.equal(f.status, 'failure');
  const x = sandbox.buildMonitor.extras();
  assert.equal(x.series, seriesKey);
  assert.equal(x.maven, 'failed');
  assert.equal(x.showSuperseded, true);
  // Changing an extra through the UI saves the whole set under the repository key.
  sandbox.location.hash = '#/reports';
  sandbox.buildMonitor.render();
  const boxes = dom.app.querySelectorAll('input').filter(i => i.getAttribute('type') === 'checkbox');
  assert.equal(boxes.length, 1, 'the superseded toggle');
  boxes[0].checked = false;
  boxes[0].dispatch('change');
  const stored = JSON.parse(storage.map.get(STORAGE_KEY));
  assert.equal(stored.showSuperseded, false);
  assert.equal(stored.maven, 'failed');
  assert.equal(stored.series, seriesKey);
  assert.equal(stored.range, '7d');
  assert.equal(sandbox.buildMonitor.extras().showSuperseded, false);
  // A stale series key is ignored on the next boot.
  const again = await bootApp(JSON.stringify(smokeHistory()), '#/reports', { storage: { [STORAGE_KEY]: JSON.stringify(Object.assign({}, saved, { series: 'gone', maven: 'weird' })) } });
  assert.equal(again.sandbox.buildMonitor.extras().series, '');
  assert.equal(again.sandbox.buildMonitor.extras().maven, '');
});

test('smoke: hostile URLs in the history never reach an href or the iframe src', async () => {
  const h = smokeHistory();
  const r = h.runs[0];
  r.htmlUrl = 'javascript:alert(1)';
  r.jobs[0].htmlUrl = 'http://github.com/acme/widgets/actions/runs/5000000001/job/91';
  r.mvnLens[0].jobUrl = 'https://evil.example/job';
  r.mvnLens[0].reports[0].path = '../../etc/passwd';
  r.mvnLens[2].reports[0].path = 'https://evil.example/report.html';
  r.sha = '../evil';
  h.workflows['1'].path = '../../<evil>.yml';
  h.repositoryUrl = 'https://evil.example/acme/widgets';
  const allowed = href => /^#\/(reports|builds|run\/\d+|report\/\d+\/[A-Za-z0-9_-][A-Za-z0-9._-]*)$/.test(href) || href === 'data/history.json' || /^reports\/\d+\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(href) || /^https:\/\/github\.com\//.test(href);
  for (const hash of ['#/reports', '#/builds', '#/run/5000000001', '#/report/5000000001/j91-s4', '#/report/5000000001/loose-abc123']) {
    const { sandbox, dom } = await bootApp(JSON.stringify(h), hash);
    const text = viewText(dom);
    assert.ok(!text.includes('failed to render'), hash + ': ' + text.slice(0, 200));
    for (const href of hrefs(dom)) assert.ok(allowed(href), hash + ': unexpected href ' + href);
    for (const f of dom.app.querySelectorAll('iframe')) assert.ok(f.getAttribute('src') === null, hash + ': iframe src must not be set from a rejected path');
    if (hash === '#/run/5000000001') {
      // The job link fell back to the URL built from validated integers; the run link too.
      assert.ok(hrefs(dom).includes('https://github.com/acme/widgets/actions/runs/5000000001/job/91'), 'job URL rebuilt');
      assert.ok(hrefs(dom).includes('https://github.com/acme/widgets/actions/runs/5000000001'), 'run URL rebuilt');
      assert.ok(!hrefs(dom).some(x => /commit/.test(x)), 'no commit link for an invalid sha');
    }
    if (hash === '#/report/5000000001/j91-s4') assert.match(text, /no file on the site/);
    assert.equal(sandbox.buildMonitor.data().repositoryUrl, 'https://github.com/acme/widgets', 'repositoryUrl on a foreign host is replaced by the derived one');
  }
});

test('scripts/serve.js serves a generated site over HTTP (index, data, 404, no path traversal)', async () => {
  const { spawn } = require('child_process');
  const dir = tmpDir('serve');
  generateSite({ history: smokeHistory(), siteDir: dir });
  fs.mkdirSync(path.join(dir, 'reports', '5000000001', 'j91-s4'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', '5000000001', 'j91-s4', 'report.html'), '<!doctype html><title>r</title>');
  fs.writeFileSync(path.join(path.dirname(dir), 'outside-' + path.basename(dir) + '.txt'), 'secret');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'serve.js'), dir, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('serve.js did not start: ' + out)), 10000);
      child.stdout.on('data', d => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
      child.stderr.on('data', d => { out += d; });
      child.on('exit', code => { clearTimeout(timer); reject(new Error('serve.js exited with ' + code + ': ' + out)); });
    });
    const index = await fetch(url);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    assert.ok((await index.text()).includes('build-monitor-data'));
    const data = await fetch(url + 'data/history.json');
    assert.equal(data.status, 200);
    assert.match(data.headers.get('content-type'), /application\/json/);
    assert.equal((await data.json()).repository, 'acme/widgets');
    const report = await fetch(url + 'reports/5000000001/j91-s4/report.html');
    assert.equal(report.status, 200);
    assert.equal((await fetch(url + 'reports/5000000001/nope/report.html')).status, 404);
    const traversal = await fetch(url + '..%2Foutside-' + path.basename(dir) + '.txt');
    assert.ok(traversal.status === 403 || traversal.status === 404, 'traversal refused: ' + traversal.status);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally {
    child.kill();
  }
});

test('smoke: without inline data the app fetches data/history.json and reports a 404 clearly', async () => {
  const dom = makeDom('');
  const fetched = [];
  const sandbox = {
    console, URL, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => { },
    requestAnimationFrame: fn => { fn(); return 1; },
    addEventListener: () => { },
    getComputedStyle: () => ({ getPropertyValue: () => '#2a78d6' }),
    document: dom.document,
    location: { hash: '#/reports', protocol: 'https:' },
    fetch: (url, opts) => { fetched.push({ url, opts }); return Promise.resolve({ status: 404, ok: false, text: () => Promise.resolve('') }); },
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SITE, 'model.js'), 'utf8'), sandbox, { filename: 'model.js' });
  vm.runInContext(fs.readFileSync(path.join(SITE, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 25));
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, 'data/history.json');
  assert.equal(fetched[0].opts.cache, 'no-cache');
  assert.match(viewText(dom), /No history published yet/);
});

test('smoke: file: protocol explains scripts/serve.js instead of fetching', async () => {
  const dom = makeDom('');
  const sandbox = {
    console, URL, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => { },
    requestAnimationFrame: fn => { fn(); return 1; },
    addEventListener: () => { },
    getComputedStyle: () => ({ getPropertyValue: () => '#2a78d6' }),
    document: dom.document,
    location: { hash: '#/reports', protocol: 'file:' },
    fetch: () => { throw new Error('must not fetch over file:'); },
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SITE, 'model.js'), 'utf8'), sandbox, { filename: 'model.js' });
  vm.runInContext(fs.readFileSync(path.join(SITE, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 25));
  const text = viewText(dom);
  assert.match(text, /file system/);
  assert.match(text, /scripts\/serve\.js/);
});
