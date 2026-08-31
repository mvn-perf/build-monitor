/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Build monitor — single-page monitoring site for history.json.
 *
 * Routes (hash):   #/reports                 mvn-lens reports (default): filters, table grouped by run, trends
 *                  #/report/<runId>/<key>    in-page viewer of one report (sandboxed iframe)
 *                  #/builds                  run durations per workflow, step stacks per job, runs table
 *                  #/run/<id>                one run: header, its reports, jobs & steps (timeline + table)
 *
 * Everything user-controlled (step names, branch names, titles…) is inserted
 * as text nodes through the element builder below — the page never assigns
 * HTML strings to the DOM. External links pass through
 * BuildMonitorModel.safeHttpUrl; report paths are re-validated at use.
 */
(function () {
  'use strict';

  var M = window.BuildMonitorModel;
  var BASE_TITLE = document.title || 'Build monitor';
  var STORAGE_PREFIX = 'build-monitor.filters.';
  var POLL_MS = 30000;
  /** Pending pages stop polling after this many fruitless checks (~10 minutes). */
  var MAX_POLLS = 20;
  var HISTORY_FILE = 'data/history.json';
  var SPARK_CAP = 50;

  // ------------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------------
  /** The inline block is empty (normal), plain JSON, or "gzip:" + base64(gzip(json)). Resolves null when empty. */
  function readInline() {
    var node = document.getElementById('build-monitor-data');
    var raw = node ? (node.textContent || '').trim() : '';
    if (!raw) return Promise.resolve(null);
    if (raw.indexOf('gzip:') !== 0) {
      try { return Promise.resolve(JSON.parse(raw)); } catch (e) { return Promise.reject(loadError('parse', 'the embedded dataset is not valid JSON (' + String(e) + ')')); }
    }
    if (typeof DecompressionStream === 'undefined') return Promise.reject(loadError('parse', 'this browser cannot inflate the compressed dataset (DecompressionStream unsupported)'));
    var bytes;
    try {
      var bin = atob(raw.slice(5));
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      return Promise.reject(loadError('parse', 'the embedded dataset is not valid base64 (' + String(e) + ')'));
    }
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text().then(function (json) { return JSON.parse(json); })
        .catch(function (e) { throw loadError('parse', 'the embedded dataset could not be inflated (' + String(e) + ')'); });
    } catch (e) {
      return Promise.reject(loadError('parse', String(e)));
    }
  }
  function loadError(kind, message) { return { kind: kind, message: message }; }
  /** Fetches data/history.json; rejects with { kind: 'file' | '404' | 'http' | 'network' | 'parse', message }. */
  function fetchHistory(cacheMode) {
    if (location.protocol === 'file:') return Promise.reject(loadError('file', 'opened from the file system'));
    if (typeof fetch !== 'function') return Promise.reject(loadError('network', 'fetch is not available in this browser'));
    var p;
    try { p = fetch(HISTORY_FILE, { cache: cacheMode || 'no-cache', credentials: 'same-origin' }); } catch (e) { return Promise.reject(loadError('network', String(e))); }
    return p.then(function (res) {
      if (res.status === 404) throw loadError('404', 'no history published yet');
      if (!res.ok) throw loadError('http', 'HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
      return res.text().then(function (text) {
        try { return JSON.parse(text); } catch (e) { throw loadError('parse', HISTORY_FILE + ' is not valid JSON (' + String(e) + ')'); }
      });
    }, function (e) { throw loadError(location.protocol === 'file:' ? 'file' : 'network', String(e && e.message || e)); });
  }
  function loadData() {
    return readInline().then(function (inline) {
      if (inline) return { data: inline, source: 'inline' };
      return fetchHistory('no-cache').then(function (data) { return { data: data, source: 'fetch' }; });
    });
  }

  // ------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------
  var DATA = null;          // normalized model (BuildMonitorModel.normalize)
  var SOURCE = null;        // 'inline' | 'fetch'
  var LOAD_ERROR = null;    // { kind, message } when nothing could be loaded
  var RUNS = [], WORKFLOWS = {}, BY_ID = {}, CTX = {}, REPO = '', REPO_URL = null;
  var filters = M.defaultFilters(null);
  /** Reports-view extras (series / Maven status / superseded toggle are persisted with the filters; job = builds chart selection per workflow). */
  var extras = { series: '', maven: '', showSuperseded: false, job: {} };

  function boot(raw) {
    DATA = M.normalize(raw);
    RUNS = DATA.runs; WORKFLOWS = DATA.workflows; BY_ID = DATA.byId; CTX = DATA.ctx;
    REPO = DATA.repository || ''; REPO_URL = DATA.repositoryUrl;
    filters = loadFilters();
    LOAD_ERROR = null;
    // The header shows the dataset (repository link, generatedAt, run and report
    // counts), so it must be rebuilt — a pending page that polled its dataset in
    // would otherwise keep the "Updated — · 0 runs" shell it was created with.
    navEl = null;
  }

  // ------------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (p) { el.style[p] = v[p]; });
      else el.setAttribute(k, v === true ? '' : v);
    });
    append(el, children);
    return el;
  }
  function append(el, children) {
    if (children === undefined || children === null || children === false) return el;
    if (Array.isArray(children)) { children.forEach(function (c) { append(el, c); }); return el; }
    el.appendChild(typeof children === 'string' || typeof children === 'number' ? document.createTextNode(String(children)) : children);
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function fmtMs(ms) { return M.formatMs(ms); }
  function fmtDate(ms) { if (!ms) return '—'; var d = new Date(ms); return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function fmtDateTick(ms, spanMs) {
    var d = new Date(ms);
    if (spanMs < 2 * 86400000) return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (spanMs < 300 * 86400000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  }
  function badge(state) { var cls = M.stateClass(state); return h('span', { class: 'badge ' + cls }, [h('span', { class: 'dot' }), M.stateLabel(state)]); }
  /**
   * Maven result of a report: a green / red badge for a status that says so,
   * and the raw status shown dim for anything else — mvn-lens writes "UNKNOWN"
   * when the session never ended (a cancelled job), which is not a failure.
   */
  function mavenBadge(summary, status) {
    var st = status || M.mavenStatus(summary);
    if (st === 'ok') return badge('success');
    if (st === 'failed') return badge('failure');
    var raw = summary && summary.status ? String(summary.status) : '';
    return h('span', { class: 'dim', title: raw ? 'Maven status ' + raw : 'The report carries no Maven status', text: raw || '—' });
  }
  function mavenColor(summary) {
    var st = M.mavenStatus(summary);
    return st === 'ok' ? cssVar('--good') : (st === 'failed' ? cssVar('--critical') : cssVar('--muted'));
  }
  function link(href, text, cls, title) { return h('a', { href: href, class: cls || null, title: title || null }, text); }
  /** External link — the single choke point: anything that is not https on the server host renders as plain text. */
  function extLink(href, text, cls, title) {
    var safe = M.safeHttpUrl(href, CTX.serverUrl);
    if (!safe) return h('span', { class: 'dim ' + (cls || ''), title: 'no safe link available', text: typeof text === 'string' ? text.replace(/\s*↗$/, '') : '' });
    return h('a', { href: safe, class: cls || null, title: title || null, target: '_blank', rel: 'noopener noreferrer' }, text);
  }
  /** Link to a report file on this site (relative path re-validated). */
  function reportFileLink(path, text, cls, title) {
    if (!M.isValidReportPath(path)) return null;
    return h('a', { href: path, class: cls || null, title: title || null, target: '_blank', rel: 'noopener noreferrer' }, text);
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function withAlpha(hex, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
    var n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function stateColor(state) {
    if (state === 'success') return cssVar('--good');
    if (state === 'failure' || state === 'timed_out' || state === 'startup_failure') return cssVar('--critical');
    if (state === 'running') return cssVar('--series-1');
    if (state === 'action_required' || state === 'stale') return cssVar('--warning');
    return cssVar('--muted');
  }
  function seriesColors() { var c = []; for (var i = 1; i <= 8; i++) c.push(cssVar('--series-' + i)); return c; }
  /** "1 run" / "2 runs" — a word that is its own plural ("series") keeps its form. */
  function plural(n, word) { return n + ' ' + word + (n === 1 || word === 'series' ? '' : 's'); }
  function entryTitle(e) {
    var t = e.jobName || 'unattributed';
    if (e.stepName) t += ' › ' + e.stepName; else if (e.stepNumber) t += ' › step ' + e.stepNumber;
    if (e.label) t += ' · ' + e.label;
    return t;
  }

  // ------------------------------------------------------------------------
  // Filters (shared bar, persisted per repository)
  // ------------------------------------------------------------------------
  function storageKey() { return STORAGE_PREFIX + (REPO || 'default'); }
  /** Restores the shared filters and the reports-view extras saved for this repository (values that no longer exist in the dataset are dropped). */
  function loadFilters() {
    var saved = null;
    try { var raw = localStorage.getItem(storageKey()); if (raw) saved = JSON.parse(raw); } catch (e) { /* storage unavailable */ }
    var s = saved && typeof saved === 'object' ? saved : {};
    extras.series = typeof s.series === 'string' && DATA.series.some(function (x) { return x.key === s.series; }) ? s.series : '';
    extras.maven = s.maven === 'ok' || s.maven === 'failed' ? s.maven : '';
    extras.showSuperseded = s.showSuperseded === true;
    return M.sanitizeFilters(s, DATA);
  }
  function saveFilters() {
    var out = { range: filters.range, branch: filters.branch, event: filters.event, status: filters.status, workflow: filters.workflow, series: extras.series, maven: extras.maven, showSuperseded: extras.showSuperseded };
    try { localStorage.setItem(storageKey(), JSON.stringify(out)); } catch (e) { /* ignore */ }
  }
  function setExtra(name, value) { extras[name] = value; saveFilters(); render(); }
  function filteredRuns() { return M.applyFilters(RUNS, filters); }

  function select(name, label, options, current, onchange) {
    var sel = h('select', { 'aria-label': label, onchange: function () { onchange(sel.value); } },
      options.map(function (o) { return h('option', { value: o[0], selected: o[0] === current ? true : null, text: o[1] }); }));
    return h('label', null, [label, sel]);
  }
  function renderFilters(countText, withWorkflow) {
    var branches = M.uniq(RUNS.map(function (r) { return r.branch; })).sort();
    var events = M.uniq(RUNS.map(function (r) { return r.event; })).sort();
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Date range' }, M.RANGES.map(function (r) {
      return h('button', { type: 'button', class: filters.range === r ? 'active' : null, text: M.RANGE_LABELS[r], onclick: function () { filters.range = r; saveFilters(); render(); } });
    }));
    function set(name) { return function (v) { filters[name] = v; saveFilters(); render(); }; }
    var wfIds = Object.keys(WORKFLOWS).filter(function (id) { return RUNS.some(function (r) { return String(r.workflowId) === id; }); })
      .sort(function (a, b) { return String(WORKFLOWS[a].name || '').localeCompare(String(WORKFLOWS[b].name || '')); });
    return h('div', { class: 'filters' }, [
      seg,
      withWorkflow && wfIds.length > 1 ? select('workflow', 'Workflow', [['', 'All workflows']].concat(wfIds.map(function (id) { return [id, WORKFLOWS[id].name || WORKFLOWS[id].path || ('workflow ' + id)]; })), filters.workflow, set('workflow')) : null,
      select('branch', 'Branch', [['', 'All branches']].concat(branches.map(function (b) { return [b, b]; })), filters.branch, set('branch')),
      select('event', 'Event', [['', 'All events']].concat(events.map(function (e) { return [e, e]; })), filters.event, set('event')),
      select('status', 'Status', [['', 'Any status'], ['success', 'Successful'], ['failure', 'Failed'], ['completed', 'Completed'], ['running', 'Running']], filters.status, set('status')),
      h('span', { class: 'count', text: countText || '' }),
    ]);
  }
  var textTimer = null;
  function textInput(placeholder) {
    var input = h('input', { type: 'search', id: 'bm-text', placeholder: placeholder, value: filters.text || '', 'aria-label': 'Search', autocomplete: 'off',
      oninput: function () { var v = input.value; if (textTimer) clearTimeout(textTimer); textTimer = setTimeout(function () { filters.text = v; render({ focus: 'bm-text' }); }, 250); } });
    return h('label', null, ['Search', input]);
  }

  // ------------------------------------------------------------------------
  // Charts (Chart.js) — instances are destroyed on every re-render
  // ------------------------------------------------------------------------
  var charts = [];
  function destroyCharts() { charts.forEach(function (c) { try { c.destroy(); } catch (e) { /* ignore */ } }); charts = []; }
  function chartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.font.family = cssVar('--font') || 'system-ui, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = cssVar('--ink-2');
    Chart.defaults.borderColor = cssVar('--grid');
    Chart.defaults.animation = false;
    Chart.defaults.plugins.tooltip.backgroundColor = cssVar('--ink');
    Chart.defaults.plugins.tooltip.titleColor = cssVar('--page');
    Chart.defaults.plugins.tooltip.bodyColor = cssVar('--page');
    Chart.defaults.plugins.tooltip.padding = 8;
    Chart.defaults.plugins.tooltip.displayColors = false;
  }
  function chartBox(cls, label) { var canvas = h('canvas', { role: 'img', 'aria-label': label || 'chart' }); return { box: h('div', { class: cls || 'chart' }, canvas), canvas: canvas }; }
  function makeChart(canvas, config) { if (!window.Chart) return null; var c = new Chart(canvas.getContext('2d'), config); charts.push(c); return c; }
  function later(fn) { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn); else setTimeout(fn, 0); }
  function goRun(run) { location.hash = M.runHref(run); }

  /** Run-duration-over-time: points coloured by conclusion, a thin guide line when the runs form one branch series. */
  function completedRuns(runs) { return runs.filter(function (r) { return r.durationMs !== null && r.durationMs !== undefined; }); }
  function durationChart(canvas, runs) {
    var pts = completedRuns(runs).map(function (r) { return { x: r.createdMs, y: r.durationMs / 1000, run: r }; }).sort(function (a, b) { return a.x - b.x; });
    if (!pts.length) return null;
    var oneBranch = !!filters.branch || DATA.isSingleBranch || M.uniq(runs.map(function (r) { return r.branch; })).length === 1;
    var span = Math.max(1, pts[pts.length - 1].x - pts[0].x);
    var colors = pts.map(function (p) { return stateColor(M.runState(p.run)); });
    return makeChart(canvas, {
      type: 'line',
      data: { datasets: [{ label: 'Duration', data: pts, parsing: false, showLine: oneBranch, borderColor: withAlpha(cssVar('--axis'), 0.9), borderWidth: 2, tension: 0,
        pointBackgroundColor: colors, pointBorderColor: colors, pointRadius: 4, pointHoverRadius: 7, pointHitRadius: 12 }] },
      options: {
        maintainAspectRatio: false, responsive: true,
        interaction: { mode: 'nearest', intersect: false },
        onClick: function (ev, els) { if (els.length) { var p = pts[els[0].index]; if (p) goRun(p.run); } },
        onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: { type: 'linear', ticks: { maxTicksLimit: 9, callback: function (v) { return fmtDateTick(v, span); } }, grid: { display: false }, border: { color: cssVar('--axis') } },
          y: { beginAtZero: true, ticks: { maxTicksLimit: 6, callback: M.formatSecAxis }, grid: { color: cssVar('--grid') }, border: { display: false }, title: { display: true, text: 'Run duration', color: cssVar('--muted') } },
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: function (items) { var r = items[0].raw.run; return '#' + r.runNumber + ' · ' + (r.branch || '') + ' · ' + fmtDate(r.createdMs); },
          label: function (item) { var r = item.raw.run; return [fmtMs(r.durationMs) + ' · ' + M.stateLabel(M.runState(r)), (r.title || '').slice(0, 80)]; },
        } } },
      },
    });
  }
  function statusLegend(extraItems) {
    var items = [['success', 'Success'], ['failure', 'Failed'], ['cancelled', 'Cancelled'], ['running', 'Running']].map(function (s) {
      return h('span', { class: 'item' }, [h('span', { class: 'sw', style: { background: stateColor(s[0]) } }), s[1]]);
    });
    (extraItems || []).forEach(function (i) { items.push(i); });
    return h('div', { class: 'legend' }, items);
  }

  /** Stacked bars: one bar per run, one segment per step (top 7 by total time, rest folded into "Other steps"). */
  function stepStackChart(canvas, jobName, runsAsc) {
    var totals = {};
    var per = runsAsc.map(function (r) {
      var job = r.jobs.filter(function (j) { return j.name === jobName; })[0];
      var m = {};
      if (job) job.steps.forEach(function (s) { if (s.durationMs) { m[s.name] = (m[s.name] || 0) + s.durationMs; totals[s.name] = (totals[s.name] || 0) + s.durationMs; } });
      return { run: r, job: job, steps: m };
    });
    var names = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    var top = names.slice(0, 7);
    var rest = names.slice(7);
    var palette = seriesColors();
    var datasets = top.map(function (name, i) {
      return { label: name, backgroundColor: palette[i], borderColor: cssVar('--surface'), borderWidth: 1, data: per.map(function (p) { return (p.steps[name] || 0) / 1000; }) };
    });
    if (rest.length) datasets.push({ label: 'Other steps (' + rest.length + ')', backgroundColor: cssVar('--muted'), borderColor: cssVar('--surface'), borderWidth: 1, data: per.map(function (p) { return rest.reduce(function (a, n) { return a + (p.steps[n] || 0); }, 0) / 1000; }) });
    var labels = per.map(function (p) { return '#' + p.run.runNumber; });
    var alt = h('ul', { class: 'sr-only' }, names.slice(0, 12).map(function (n) { return h('li', { text: n + ': ' + fmtMs(totals[n]) + ' in total over ' + per.length + ' runs' }); }));
    canvas.parentNode.appendChild(alt);
    canvas.setAttribute('aria-label', 'Step durations of job ' + jobName + ' across ' + per.length + ' runs, stacked per step');
    return makeChart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        maintainAspectRatio: false, responsive: true,
        interaction: { mode: 'index', intersect: false },
        onClick: function (ev, els) { if (els.length) goRun(per[els[0].index].run); },
        onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 20 }, border: { color: cssVar('--axis') } },
          y: { stacked: true, beginAtZero: true, ticks: { maxTicksLimit: 6, callback: M.formatSecAxis }, grid: { color: cssVar('--grid') }, border: { display: false } },
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: false, padding: 12 } },
          tooltip: { callbacks: {
            title: function (items) { var p = per[items[0].dataIndex]; return '#' + p.run.runNumber + ' · ' + (p.run.branch || '') + ' · ' + fmtDate(p.run.createdMs); },
            label: function (item) { return item.dataset.label + ': ' + fmtMs(item.raw * 1000); },
            footer: function (items) { var p = per[items[0].dataIndex]; return p.job ? 'Job: ' + fmtMs(p.job.durationMs) + ' · ' + M.stateLabel(M.jobState(p.job)) : ''; },
          } },
        },
      },
    });
  }

  /** Sparkline of the Maven total time of one series (points by Maven status, click → run). */
  function sparkChart(canvas, points) {
    var pts = points.filter(function (p) { return p.summary && typeof p.summary.totalMs === 'number'; })
      .map(function (p) { return { x: p.run.createdMs, y: p.summary.totalMs / 1000, p: p }; })
      .sort(function (a, b) { return a.x - b.x; });
    if (!pts.length) return null;
    var colors = pts.map(function (q) { return mavenColor(q.p.summary); });
    return makeChart(canvas, {
      type: 'line',
      data: { datasets: [{ label: 'Maven total', data: pts, parsing: false, showLine: true, borderColor: withAlpha(cssVar('--series-2'), 0.7), borderWidth: 1.5, tension: 0,
        pointBackgroundColor: colors, pointBorderColor: colors, pointRadius: 2.5, pointHoverRadius: 6, pointHitRadius: 10 }] },
      options: {
        maintainAspectRatio: false, responsive: true, layout: { padding: 4 },
        interaction: { mode: 'nearest', intersect: false },
        onClick: function (ev, els) { if (els.length) { var q = pts[els[0].index]; if (q) goRun(q.p.run); } },
        onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: { x: { type: 'linear', display: false }, y: { beginAtZero: true, display: false } },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: function (items) { var r = items[0].raw.p.run; return '#' + r.runNumber + ' · ' + (r.branch || '') + ' · ' + fmtDate(r.createdMs); },
          label: function (item) { var s = item.raw.p.summary; return ['Maven total ' + fmtMs(s.totalMs) + ' · ' + (s.status || ''), 'click to open the run']; },
        } } },
      },
    });
  }

  // ------------------------------------------------------------------------
  // Reports view
  // ------------------------------------------------------------------------
  function viewReports() {
    var runs = filteredRuns();
    var frag = document.createDocumentFragment();
    var allSeries = DATA.series;
    if (extras.series && !allSeries.some(function (s) { return s.key === extras.series; })) extras.series = '';
    var rows = M.reportRows(runs, { showSuperseded: extras.showSuperseded, series: extras.series, maven: extras.maven });
    var supersededCount = M.reportRows(runs, { showSuperseded: true, series: extras.series, maven: extras.maven }).length - M.reportRows(runs, { showSuperseded: false, series: extras.series, maven: extras.maven }).length;
    frag.appendChild(renderFilters(plural(rows.length, 'report') + ' in ' + plural(runs.length, 'run'), true));
    var cb = h('input', { type: 'checkbox', checked: extras.showSuperseded ? true : null, onchange: function () { setExtra('showSuperseded', cb.checked); } });
    frag.appendChild(h('div', { class: 'filters extras' }, [
      allSeries.length > 1 ? select('series', 'Job › step', [['', 'All jobs / steps']].concat(allSeries.map(function (s) { return [s.key, s.title]; })), extras.series, function (v) { setExtra('series', v); }) : null,
      select('maven', 'Maven', [['', 'Any Maven status'], ['ok', 'Maven OK'], ['failed', 'Maven failed']], extras.maven, function (v) { setExtra('maven', v); }),
      textInput('job, step, branch, title, JDK…'),
      h('label', { class: 'toggle', title: 'A report is superseded when a later attempt of the same run published a report for the same job and step.' }, [cb, 'Show superseded' + (supersededCount ? ' (' + supersededCount + ')' : '')]),
    ]));

    if (!RUNS.length) { frag.appendChild(h('p', { class: 'empty', text: 'No runs recorded yet — the page fills up once the Build monitor workflow has processed a run.' })); return frag; }
    // Table first (one-click access to the reports is the primary use), then the trends strip.
    if (!rows.length) {
      var anyReport = RUNS.some(function (r) { return r.mvnLens.length; });
      frag.appendChild(h('p', { class: 'empty', text: anyReport ? 'No reports match the current filters.' : 'No mvn-lens report published yet. Add the mvn-perf/build-monitor/report step after your Maven step.' }));
    } else {
      frag.appendChild(reportsTable(rows, { grouped: true }));
    }
    frag.appendChild(trendsStrip(runs));
    return frag;
  }

  /** Per-series sparklines of the runs in range (newest 50 per series); collapsed when there are more than 4 series. */
  function trendsStrip(runs) {
    var series = M.seriesOf(runs).filter(function (s) { return !extras.series || s.key === extras.series; });
    var withTimings = series.filter(function (s) { return s.points.some(function (p) { return p.summary && typeof p.summary.totalMs === 'number'; }); });
    if (!withTimings.length) return h('div');
    var open = withTimings.length <= 4;
    var details = h('details', { class: 'trends', open: open ? true : null });
    details.appendChild(h('summary', null, [h('b', { text: 'Trends' }), ' · Maven total time of ' + plural(withTimings.length, 'series') + ' over the runs in range (newest ' + SPARK_CAP + ' per series) · click a point to open the run']));
    var grid = h('div', { class: 'spark-grid' });
    withTimings.forEach(function (s) {
      var pts = s.points.slice(0, SPARK_CAP);
      var totals = pts.filter(function (p) { return p.summary && typeof p.summary.totalMs === 'number'; }).map(function (p) { return p.summary.totalMs; });
      var last = pts[0];
      var b = chartBox('spark', 'Maven total time of ' + s.title + ', ' + totals.length + ' reports');
      var active = extras.series === s.key;
      grid.appendChild(h('div', { class: 'spark-card' }, [
        h('div', { class: 't' }, h('button', { type: 'button', class: 'link' + (active ? ' active' : ''), title: active ? 'Show every series' : 'Show only this series in the table', text: s.title, onclick: function () { setExtra('series', active ? '' : s.key); } })),
        h('div', { class: 's' }, [h('span', null, ['last ', h('b', { text: last && last.summary ? fmtMs(last.summary.totalMs) : '—' })]), h('span', null, ['median ', h('b', { text: fmtMs(M.median(totals)) })]), h('span', { text: plural(pts.length, 'report') })]),
        b.box,
      ]));
      later(function () { if (b.canvas.isConnected !== false) sparkChart(b.canvas, pts); });
    });
    details.appendChild(grid);
    return details;
  }

  /**
   * Reports table. opts.grouped: header rows per run (#n · branch · conclusion · duration · when).
   * Constant columns (same value on every row) are hidden and listed under the table.
   */
  var COLUMNS = [
    { id: 'entry', label: 'Job › step', cell: function (row) { var e = row.entry; return h('td', { class: 'wrap' }, [e.jobName ? e.jobName : h('span', { class: 'dim', text: 'unattributed' }), e.stepName ? [' › ', e.stepName] : (e.stepNumber ? h('span', { class: 'dim', text: ' › step ' + e.stepNumber }) : null), e.label ? h('span', { class: 'dim', text: ' · ' + e.label }) : null, e.superseded ? [' ', h('span', { class: 'chip muted', title: 'Replaced by the report of a later attempt of this run', text: 'superseded' })] : null, e.attempt && e.attempt > 1 ? h('span', { class: 'dim small', text: ' (attempt ' + e.attempt + ')' }) : null]); } },
    { id: 'goals', label: 'Goals', hideable: true, key: function (row) { var s = row.summary; return s ? (s.goals || []).join(' ') + (s.threads > 1 ? ' -T' + s.threads : '') : ''; }, cell: function (row) { return h('td', { class: 'mono small', text: this.key(row) }); } },
    { id: 'total', label: 'Maven total', num: true, cell: function (row) { return h('td', { class: 'num', text: fmtMs(row.summary ? row.summary.totalMs : null) }); } },
    { id: 'wall', label: 'Wall', num: true, cell: function (row) { return h('td', { class: 'num dim', text: fmtMs(row.summary ? row.summary.wallMs : null) }); } },
    { id: 'cpu', label: 'CPU', num: true, cell: function (row) { return h('td', { class: 'num dim', text: fmtMs(row.summary ? row.summary.cpuMs : null) }); } },
    { id: 'gc', label: 'GC', num: true, hideable: true, key: function (row) { return row.summary ? fmtMs(row.summary.gcMs) : '—'; }, cell: function (row) { return h('td', { class: 'num dim', text: this.key(row) }); } },
    { id: 'status', label: 'Status', hideable: true, key: function (row) { return row.summary && row.summary.status ? String(row.summary.status) : ''; }, cell: function (row) { return h('td', null, mavenBadge(row.summary, row.mavenStatus)); } },
    { id: 'modules', label: 'Modules', num: true, hideable: true, key: function (row) { return row.summary && row.summary.moduleCount !== undefined && row.summary.moduleCount !== null ? String(row.summary.moduleCount) : ''; }, cell: function (row) { return h('td', { class: 'num dim', text: this.key(row) }); } },
    { id: 'jdk', label: 'JDK', hideable: true, key: function (row) { return row.summary && row.summary.jdkVersion ? String(row.summary.jdkVersion) : ''; }, cell: function (row) { return h('td', { class: 'dim small', text: this.key(row) }); } },
    { id: 'maven', label: 'Maven', hideable: true, key: function (row) { var s = row.summary; return s ? [s.mavenVersion ? String(s.mavenVersion) : null, s.environment && s.environment.mvnd ? 'mvnd' : null].filter(Boolean).join(' · ') : ''; }, cell: function (row) { return h('td', { class: 'dim small', text: this.key(row) }); } },
    { id: 'report', label: 'Report', cell: function (row) { return h('td', null, reportCell(row)); } },
    { id: 'github', label: 'GitHub', cell: function (row) { var l = M.stepLink(row.run, row.entry, CTX); return h('td', null, l ? extLink(l.href, l.label, null, l.title) : h('span', { class: 'dim', text: '—' })); } },
  ];
  function reportCell(row) {
    var rep = row.report;
    var href = M.reportHref(row.run, row.entry);
    var size = rep && rep.bytes ? M.formatBytes(rep.bytes) : (row.entry.bytes ? M.formatBytes(row.entry.bytes) : '');
    var items = [];
    if (rep && M.isValidReportPath(rep.path) && href) items.push(link(href, 'Report', 'chip', 'Open the mvn-lens report in this page' + (size ? ' (' + size + ')' : '')));
    else if (rep && M.isValidReportPath(rep.path)) items.push(reportFileLink(rep.path, 'Report ↗', 'chip', 'Open the mvn-lens report' + (size ? ' (' + size + ')' : '')));
    else items.push(h('span', { class: 'chip muted', title: 'The report file is not on the site', text: 'no file' }));
    if (row.entry.reports.length > 1) items.push(h('span', { class: 'dim small', text: ' +' + (row.entry.reports.length - 1) }));
    return items;
  }
  function reportsTable(rows, opts) {
    var o = opts || {};
    var hidden = [];
    var getters = {};
    COLUMNS.forEach(function (c) { if (c.hideable) getters[c.id] = c.key.bind(c); });
    M.constantColumns(rows, getters).forEach(function (id) { hidden.push(id); });
    var cols = COLUMNS.filter(function (c) { return hidden.indexOf(c.id) < 0; });
    var body = h('tbody');
    var lastRun = null;
    rows.forEach(function (row) {
      var r = row.run;
      if (o.grouped && r !== lastRun) {
        lastRun = r;
        var wf = WORKFLOWS[String(r.workflowId)] || {};
        body.appendChild(h('tr', { class: 'group' }, h('td', { colspan: String(cols.length) }, h('div', { class: 'g' }, [
          link(M.runHref(r), '#' + r.runNumber, null, 'Run details'),
          h('span', { class: 'dim', text: wf.name || r.workflowName || '' }),
          h('span', { text: r.branch || '' }),
          badge(M.runState(r)),
          h('span', { class: 'dim', text: fmtMs(r.durationMs) }),
          h('span', { class: 'dim', title: fmtDate(r.createdMs), text: M.formatRel(r.createdMs) }),
          r.title ? h('span', { class: 'dim small', title: r.title, text: r.title.length > 70 ? r.title.slice(0, 70) + '…' : r.title }) : null,
          r.attempt > 1 ? h('span', { class: 'dim small', text: 'attempt ' + r.attempt }) : null,
          extLink(M.runUrl(r, CTX), 'GitHub ↗', 'small'),
        ]))));
      }
      body.appendChild(h('tr', { class: row.entry.superseded ? 'superseded' : null }, cols.map(function (c) { return c.cell(row); })));
    });
    var table = h('div', { class: 'table-wrap' }, h('table', null, [h('thead', null, h('tr', null, cols.map(function (c) { return h('th', { class: c.num ? 'num' : null, text: c.label }); }))), body]));
    if (!hidden.length) return table;
    var note = hidden.map(function (id) { var c = COLUMNS.filter(function (x) { return x.id === id; })[0]; var v = c.key(rows[0]); return c.label + ': ' + (v === '' ? '—' : v); });
    return h('div', null, [table, h('p', { class: 'note', text: 'Same on every row (hidden): ' + note.join(' · ') })]);
  }

  // ------------------------------------------------------------------------
  // Report viewer
  // ------------------------------------------------------------------------
  var viewerIndex = 0;
  function viewViewer(route, run, entry) {
    var reports = entry.reports.filter(function (rep) { return M.isValidReportPath(rep.path); });
    if (viewerIndex >= reports.length) viewerIndex = 0;
    var rep = reports[viewerIndex] || null;
    var wf = WORKFLOWS[String(run.workflowId)] || {};
    var s = entry.summary;
    var l = M.stepLink(run, entry, CTX);
    var job = run.jobs.filter(function (j) { return entry.jobId && j.id === entry.jobId; })[0] || null;
    var ctx = h('div', { class: 'ctx' }, [
      h('span', null, [h('b', { text: wf.name || run.workflowName || 'workflow' }), ' ', link(M.runHref(run), '#' + run.runNumber, null, 'Run details')]),
      h('span', { class: 'sep', text: '·' }), h('span', { text: run.branch || '' }),
      h('span', { class: 'sep', text: '·' }), h('span', { title: entry.attribution ? 'attributed by ' + entry.attribution : null }, [h('b', { text: entry.jobName || 'unattributed' }), entry.stepName ? ' › ' + entry.stepName : '', entry.label ? h('span', { class: 'dim', text: ' · ' + entry.label }) : null]),
      s ? [h('span', { class: 'sep', text: '·' }), h('span', null, ['Maven ', h('b', { text: fmtMs(s.totalMs) }), ' ', mavenBadge(s)])] : null,
      entry.superseded ? [h('span', { class: 'sep', text: '·' }), h('span', { class: 'chip muted', title: 'Replaced by the report of a later attempt', text: 'superseded' })] : null,
      reports.length > 1 ? h('select', { 'aria-label': 'Report file', onchange: function (ev) { viewerIndex = Number(ev.target.value) || 0; render(); } }, reports.map(function (x, i) { return h('option', { value: String(i), selected: i === viewerIndex ? true : null, text: x.name || x.path.split('/').pop() }); })) : null,
    ]);
    // [GitHub step ↗] [GitHub job ↗] [Run details] [Open raw ↗] — the step link degrades to the job (once) or to the run.
    var jobHref = job || entry.jobId ? M.jobUrl(run, job || { id: entry.jobId, htmlUrl: entry.jobUrl }, CTX) : null;
    var links = h('div', { class: 'links' }, [
      l && l.kind === 'step' ? extLink(l.href, 'GitHub step ↗', null, l.title) : null,
      jobHref ? extLink(jobHref, 'GitHub job ↗', null, l && l.kind === 'job' ? l.title : 'The job on GitHub') : (l && l.kind === 'run' ? extLink(l.href, 'GitHub run ↗', null, l.title) : null),
      link(M.runHref(run), 'Run details', null, 'Jobs, steps and every report of this run'),
      rep ? reportFileLink(rep.path, 'Open raw ↗', null, 'Open the report file itself in a new tab' + (rep.bytes ? ' (' + M.formatBytes(rep.bytes) + ')' : '')) : null,
    ]);
    var bar = h('div', { class: 'viewer-bar' }, [link('#/reports', '← Reports', 'back'), ctx, links]);
    var frame = h('div', { class: 'viewer-frame' });
    if (rep) {
      var size = rep.bytes || entry.bytes;
      var loading = h('div', { class: 'loading', text: 'Loading the report' + (size ? ' (' + M.formatBytes(size) + ')' : '') + '…' });
      var iframe = h('iframe', { title: 'mvn-lens report ' + entryTitle(entry), sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads', referrerpolicy: 'no-referrer', loading: 'eager', onload: function () { loading.className = 'loading done'; } });
      iframe.setAttribute('src', rep.path);    // path re-validated above (isValidReportPath)
      frame.appendChild(loading);
      frame.appendChild(iframe);
    } else {
      frame.appendChild(h('div', { class: 'loading', text: 'This report has no file on the site (its path was rejected or the file was never published).' }));
    }
    return h('div', { class: 'viewer' }, [bar, frame]);
  }

  // ------------------------------------------------------------------------
  // Builds view
  // ------------------------------------------------------------------------
  function viewBuilds() {
    var runs = filteredRuns();
    var frag = document.createDocumentFragment();
    frag.appendChild(renderFilters(plural(runs.length, 'run'), true));
    frag.appendChild(h('div', { class: 'filters extras' }, [textInput('title, branch, actor, job, step…')]));
    if (!RUNS.length) { frag.appendChild(h('p', { class: 'empty', text: 'No runs recorded yet — the page fills up once the Build monitor workflow has processed a run.' })); return frag; }
    if (!runs.length) { frag.appendChild(h('p', { class: 'empty', text: 'No runs match the current filters.' })); return frag; }

    var durations = completedRuns(runs).map(function (r) { return r.durationMs; });
    var completed = runs.filter(function (r) { return r.status === 'completed'; });
    var ok = completed.filter(function (r) { return r.conclusion === 'success'; }).length;
    var reports = 0; runs.forEach(function (r) { r.mvnLens.forEach(function (e) { if (!e.superseded) reports++; }); });
    frag.appendChild(h('div', { class: 'tiles' }, [
      tile('Runs', String(runs.length)),
      tile('Success rate', completed.length ? Math.round(100 * ok / completed.length) + '%' : '—', completed.length ? ok + ' / ' + completed.length : null),
      tile('Median duration', fmtMs(M.median(durations))), tile('p90 duration', fmtMs(M.percentile(durations, 0.9))),
      tile('mvn-lens reports', String(reports), reports ? link('#/reports', 'reports →') : null),
    ]));

    var ids = M.uniq(runs.map(function (r) { return String(r.workflowId); })).sort(function (a, b) { return String((WORKFLOWS[a] || {}).name || '').localeCompare(String((WORKFLOWS[b] || {}).name || '')); });
    var cards = h('div', { class: 'cards' });
    ids.forEach(function (id) {
      var wf = WORKFLOWS[id] || {};
      var wruns = runs.filter(function (r) { return String(r.workflowId) === id; });
      var done = completedRuns(wruns);
      var wc = wruns.filter(function (r) { return r.status === 'completed'; });
      var wok = wc.filter(function (r) { return r.conclusion === 'success'; }).length;
      var last = wruns[0];
      var jobNames = {};
      wruns.forEach(function (r) { r.jobs.forEach(function (j) { jobNames[j.name] = (jobNames[j.name] || 0) + 1; }); });
      var names = Object.keys(jobNames).sort(function (a, b) { return jobNames[b] - jobNames[a] || a.localeCompare(b); });
      var chosen = extras.job[id] && names.indexOf(extras.job[id]) >= 0 ? extras.job[id] : '';
      var sel = names.length ? h('select', { 'aria-label': 'Chart of ' + (wf.name || 'workflow'), onchange: function () { extras.job[id] = sel.value; render(); } },
        [h('option', { value: '', selected: chosen === '' ? true : null, text: 'Run duration' })].concat(names.map(function (n) { return h('option', { value: n, selected: chosen === n ? true : null, text: 'Job: ' + n + ' (steps)' }); }))) : null;
      var box = chartBox('chart tall', chosen ? 'Step durations of job ' + chosen : (wf.name || 'workflow') + ' run duration over time, ' + done.length + ' completed runs');
      var MAX_BARS = 60;
      var asc = wruns.slice().sort(function (a, b) { return a.createdMs - b.createdMs; });
      var shown = asc.slice(-MAX_BARS);
      cards.appendChild(h('div', { class: 'card ' + (ids.length === 1 ? 'wide' : '') }, [
        h('div', { class: 'card-head' }, [
          h('h2', null, wf.path ? extLink(M.workflowUrl(CTX, wf.path), wf.name || wf.path || ('workflow ' + id), null, 'The workflow on GitHub') : h('span', { text: wf.name || ('workflow ' + id) })),
          h('div', { class: 'stats' }, [
            h('span', null, [h('b', { text: String(wruns.length) }), ' runs']),
            h('span', null, ['median ', h('b', { text: fmtMs(M.median(done.map(function (r) { return r.durationMs; }))) })]),
            h('span', null, ['success ', h('b', { text: wc.length ? Math.round(100 * wok / wc.length) + '%' : '—' })]),
            last ? h('span', null, ['last ', h('a', { href: M.runHref(last), title: 'Run details' }, badge(M.runState(last))), ' ', h('span', { class: 'dim', text: M.formatRel(last.createdMs) })]) : null,
            sel,
          ]),
        ]),
        chosen || done.length ? box.box : h('p', { class: 'empty', text: wruns.length ? 'No completed runs in range yet.' : 'No runs in range.' }),
        chosen ? h('p', { class: 'note', text: 'One bar per run (oldest to newest), one segment per step; the 7 steps with the most total time are shown individually. Click a bar to open the run.' + (asc.length > MAX_BARS ? ' Showing the last ' + MAX_BARS + ' of ' + asc.length + ' runs.' : '') }) : (done.length ? statusLegend([h('span', { class: 'item dim', text: 'click a point to open the run' })]) : null),
      ]));
      if (chosen) later(function () { stepStackChart(box.canvas, chosen, shown); });
      else if (done.length) later(function () { durationChart(box.canvas, wruns); });
    });
    frag.appendChild(cards);
    frag.appendChild(h('section', null, [h('h2', { text: 'Runs' }), runsTable(runs)]));
    return frag;
  }
  function tile(k, v, sub) { return h('div', { class: 'tile' }, [h('div', { class: 'k', text: k }), h('div', { class: 'v' }, [typeof v === 'object' ? v : String(v), sub ? h('small', null, sub) : null])]); }

  function jobsSummary(r) {
    var ok = 0, failed = 0, skipped = 0, other = 0;
    r.jobs.forEach(function (j) {
      var st = M.jobState(j);
      if (st === 'success') ok++; else if (st === 'failure' || st === 'timed_out' || st === 'startup_failure') failed++; else if (st === 'skipped' || st === 'cancelled') skipped++; else other++;
    });
    var parts = [];
    if (ok) parts.push(h('span', { class: 'good', text: ok + ' ok' }));
    if (failed) parts.push(h('span', { class: 'bad', text: failed + ' failed' }));
    if (skipped) parts.push(h('span', { class: 'dim', text: skipped + ' skipped' }));
    if (other) parts.push(h('span', { class: 'dim', text: other + ' running' }));
    var out = [];
    parts.forEach(function (p, i) { if (i) out.push(h('span', { class: 'dim', text: ' · ' })); out.push(p); });
    return out.length ? out : h('span', { class: 'dim', text: '—' });
  }
  function runsTable(runs) {
    var rows = runs.map(function (r) {
      var reports = r.mvnLens.filter(function (e) { return !e.superseded; }).length;
      return h('tr', null, [
        h('td', { title: fmtDate(r.createdMs), text: fmtDate(r.createdMs) }),
        h('td', { text: r.workflowName || (WORKFLOWS[String(r.workflowId)] || {}).name || '' }),
        h('td', null, link(M.runHref(r), '#' + r.runNumber, null, 'Run details')),
        h('td', { text: r.branch || '' }),
        h('td', { class: 'dim', text: r.event || '' }),
        h('td', { class: 'wrap' }, [r.title || '', r.attempt > 1 ? h('span', { class: 'dim small', text: ' (attempt ' + r.attempt + ')' }) : null]),
        h('td', { class: 'dim', text: r.actor || '' }),
        h('td', null, badge(M.runState(r))),
        h('td', { class: 'num', text: fmtMs(r.durationMs) }),
        h('td', null, jobsSummary(r)),
        h('td', null, reports ? link(M.runHref(r), reports + ' mvn-lens', 'chip', 'Reports of this run') : ''),
        h('td', null, extLink(M.runUrl(r, CTX), 'GitHub ↗')),
        h('td', null, link(M.runHref(r), 'details')),
      ]);
    });
    return h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, ['When', 'Workflow', 'Run', 'Branch', 'Event', 'Title', 'By', 'Conclusion', 'Duration', 'Jobs', 'Reports', '', ''].map(function (t) { return h('th', { class: t === 'Duration' ? 'num' : null, text: t }); }))),
      h('tbody', null, rows),
    ]));
  }

  // ------------------------------------------------------------------------
  // Run page
  // ------------------------------------------------------------------------
  function viewRun(r) {
    var frag = document.createDocumentFragment();
    var wf = WORKFLOWS[String(r.workflowId)] || {};
    frag.appendChild(crumbs([['#/builds', 'Builds'], [null, (wf.name || r.workflowName || 'workflow') + ' #' + r.runNumber]]));
    frag.appendChild(h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [
        h('h1', null, [(wf.name || r.workflowName || '') + ' #' + r.runNumber + ' ', badge(M.runState(r))]),
        h('div', { class: 'sub', text: r.title || '' }),
      ]),
      h('div', { class: 'actions' }, [extLink(M.runUrl(r, CTX), 'Open on GitHub ↗'), wf.path ? extLink(M.workflowUrl(CTX, wf.path), 'Workflow ↗') : null]),
    ]));
    frag.appendChild(h('div', { class: 'card' }, h('div', { class: 'kv' }, [
      kv('Duration', fmtMs(r.durationMs)), kv('Queued', fmtMs(r.queueMs)), kv('Started', fmtDate(r.startedMs)), kv('Finished', r.completedMs ? fmtDate(r.completedMs) : (r.status === 'completed' ? '—' : 'running')),
      kv('Branch', r.branch || '—'), kv('Commit', M.commitUrl(r, CTX) ? extLink(M.commitUrl(r, CTX), M.shortSha(r.sha), 'sha') : (r.sha ? h('span', { class: 'sha', text: M.shortSha(r.sha) }) : '—')), kv('Event', r.event || '—'), kv('Triggered by', r.actor || '—'),
      kv('Attempt', String(r.attempt || 1)), kv('Jobs', String(r.jobs.length)), r.headRepository && r.headRepository !== REPO ? kv('Head repository', r.headRepository) : null,
    ])));

    var sec = h('section', null, [h('h2', { text: 'mvn-lens reports' })]);
    var rows = M.reportRows([r], { showSuperseded: extras.showSuperseded });
    var superseded = r.mvnLens.filter(function (e) { return e.superseded; }).length;
    if (superseded) {
      var cb = h('input', { type: 'checkbox', checked: extras.showSuperseded ? true : null, onchange: function () { setExtra('showSuperseded', cb.checked); } });
      sec.appendChild(h('div', { class: 'table-tools' }, [h('label', null, [cb, 'Show superseded (' + superseded + ')'])]));
    }
    if (!rows.length) sec.appendChild(h('p', { class: 'empty', text: r.mvnLens.length ? 'Every report of this run is superseded.' : (r.status === 'completed' ? 'No mvn-lens report was published for this run. Add the mvn-perf/build-monitor/report step after your Maven step to publish one.' : 'No report yet — reports appear once the Build monitor workflow has processed the completed run.') }));
    else sec.appendChild(reportsTable(rows, { grouped: false }));
    frag.appendChild(sec);

    frag.appendChild(h('section', null, [
      h('h2', { text: 'Jobs & steps' }),
      h('p', { class: 'sub', text: 'Jobs and their steps relative to the start of the run. A step profiled with mvn-lens carries a report chip; the orange bar under it is the Maven session itself.' }),
      timeline(r),
      jobsTable(r),
    ]));
    return frag;
  }
  function kv(k, v) { return h('div', null, [h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v)]); }

  /** Chips of the mvn-lens entries attributed to one job/step (viewer links). */
  function entryChips(entries) {
    var chips = [];
    entries.forEach(function (e) {
      var href = M.reportHref(e.run, e.entry);
      var text = 'mvn-lens' + (e.entry.label ? ' · ' + e.entry.label : '');
      if (e.entry.superseded) chips.push(h('span', { class: 'chip muted', title: 'Superseded by a later attempt', text: text + ' (superseded)' }));
      else if (href && e.entry.reports.some(function (rep) { return M.isValidReportPath(rep.path); })) chips.push(link(href, text, 'chip', 'Open the mvn-lens report of this step'));
      else chips.push(h('span', { class: 'chip muted', title: 'No report file on the site', text: text }));
    });
    return chips;
  }
  function entriesByJobStep(r) {
    var byJobStep = {}, byJob = {}, unattributed = [];
    r.mvnLens.forEach(function (e) {
      var item = { run: r, entry: e };
      if (e.jobId && e.stepNumber) (byJobStep[e.jobId + ':' + e.stepNumber] = byJobStep[e.jobId + ':' + e.stepNumber] || []).push(item);
      else if (e.jobId) (byJob[e.jobId] = byJob[e.jobId] || []).push(item);
      else unattributed.push(item);
    });
    return { byJobStep: byJobStep, byJob: byJob, unattributed: unattributed };
  }

  /** Expandable jobs table: one row per job, its steps (with step links and mvn-lens chips) shown on demand. */
  function jobsTable(r) {
    var idx = entriesByJobStep(r);
    var body = h('tbody');
    var groups = [];
    r.jobs.forEach(function (j) {
      var stepRows = [];
      var expanded = false;
      var btn = h('button', { type: 'button', class: 'tgl', 'aria-expanded': 'false', title: 'Show the steps of this job', text: '▸ ' + plural(j.steps.length, 'step'), onclick: function () { setOpen(!expanded); } });
      function setOpen(v) { expanded = v; btn.textContent = (v ? '▾ ' : '▸ ') + plural(j.steps.length, 'step'); btn.setAttribute('aria-expanded', String(v)); stepRows.forEach(function (tr) { tr.className = 'step-row' + (v ? '' : ' hidden'); }); }
      groups.push(setOpen);
      var jobEntries = idx.byJob[j.id] || [];
      body.appendChild(h('tr', null, [
        h('td', null, [btn, ' ', extLink(M.jobUrl(r, j, CTX), j.name, null, 'The job on GitHub')]),
        h('td', null, badge(M.jobState(j))),
        h('td', { class: 'num', text: fmtMs(j.durationMs) }),
        h('td', { class: 'dim small', text: [j.runnerName, j.labels && j.labels.length ? j.labels.join(', ') : null].filter(Boolean).join(' · ') }),
        h('td', null, jobEntries.length ? h('span', { class: 'inline-list' }, entryChips(jobEntries).map(function (c) { c.title = (c.title || '') + ' (step unknown)'; return c; })) : ''),
        h('td', null, extLink(M.jobUrl(r, j, CTX), 'GitHub job ↗')),
      ]));
      j.steps.forEach(function (s) {
        var ents = idx.byJobStep[j.id + ':' + s.number] || [];
        var tr = h('tr', { class: 'step-row hidden' }, [
          h('td', null, [h('span', { class: 'dim', text: (s.number || '') + '  ' }), h('span', { text: s.name })]),
          h('td', null, badge(M.jobState(s))),
          h('td', { class: 'num', text: fmtMs(s.durationMs) }),
          h('td', { class: 'dim small', text: s.startedMs ? new Date(s.startedMs).toLocaleTimeString() : '' }),
          h('td', null, ents.length ? h('span', { class: 'inline-list' }, entryChips(ents)) : ''),
          h('td', null, extLink(M.stepUrl(r, j, s.number, CTX), 'step ↗', 'small', 'The step log on GitHub')),
        ]);
        stepRows.push(tr);
        body.appendChild(tr);
      });
    });
    if (idx.unattributed.length) {
      body.appendChild(h('tr', null, [
        h('td', { class: 'dim', text: 'mvn-lens reports not attributed to a job' }), h('td'), h('td'), h('td'),
        h('td', null, h('span', { class: 'inline-list' }, entryChips(idx.unattributed))), h('td'),
      ]));
    }
    if (!r.jobs.length && !idx.unattributed.length) return h('p', { class: 'empty', text: 'No job information was recorded for this run.' });
    var tools = h('div', { class: 'table-tools' }, [
      h('button', { type: 'button', class: 'tgl', text: 'Expand all', onclick: function () { groups.forEach(function (f) { f(true); }); } }),
      h('button', { type: 'button', class: 'tgl', text: 'Collapse all', onclick: function () { groups.forEach(function (f) { f(false); }); } }),
    ]);
    return h('div', null, [tools, h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, ['Job / step', 'Status', 'Duration', 'Runner / started', 'mvn-lens', ''].map(function (t) { return h('th', { class: t === 'Duration' ? 'num' : null, text: t }); }))),
      body,
    ]))]);
  }

  /** HTML/CSS Gantt: label column + proportional bars, tooltip on hover (from build-dashboard). */
  function timeline(r) {
    var showSkipped = false;
    var wrap = h('div', { class: 'timeline' });
    var toolbar = h('div', { class: 'tl-toolbar' });
    var cb = h('input', { type: 'checkbox', onchange: function () { showSkipped = cb.checked; draw(); } });
    toolbar.appendChild(h('label', null, [cb, 'Show skipped steps']));
    toolbar.appendChild(h('span', { class: 'inline-list' }, [
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--bar-success') } }), 'success']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--critical') } }), 'failure']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--muted') } }), 'cancelled']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: 'repeating-linear-gradient(45deg, ' + cssVar('--series-1') + ' 0 3px, transparent 3px 6px)' } }), 'running']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--series-2'), height: '4px' } }), 'Maven session (mvn-lens)']),
    ]));
    wrap.appendChild(toolbar);
    var scroll = h('div', { class: 'tl-scroll' });
    wrap.appendChild(scroll);
    var idx = entriesByJobStep(r);

    function draw() {
      clear(scroll);
      var t0 = r.startedMs, t1 = r.completedMs || 0;
      r.jobs.forEach(function (j) {
        if (j.startedMs && j.startedMs < t0) t0 = j.startedMs;
        if (j.completedMs && j.completedMs > t1) t1 = j.completedMs;
        j.steps.forEach(function (s) { if (s.completedMs && s.completedMs > t1) t1 = s.completedMs; });
      });
      if (!t1 || t1 <= t0) t1 = Math.max(t0 + 1000, Date.now());
      var span = t1 - t0;
      var grid = h('div', { class: 'tl-grid' });
      var axis = h('div', { class: 'tl-axis' });
      var step = niceTick(span);
      for (var t = 0; t <= span; t += step) axis.appendChild(h('span', { class: 't', style: { left: (100 * t / span) + '%' }, text: M.formatSecAxis(t / 1000) }));
      grid.appendChild(h('div', { class: 'tl-axis-label', text: 'elapsed' }));
      grid.appendChild(axis);

      function track(bars) {
        var tr = h('div', { class: 'tl-track' });
        for (var t = step; t < span; t += step) tr.appendChild(h('span', { class: 'tl-tick', style: { left: (100 * t / span) + '%' } }));
        bars.forEach(function (b) { tr.appendChild(b); });
        return tr;
      }
      function bar(start, end, cls, tip) {
        if (!start) return null;
        var e = end || Date.now();
        var left = Math.max(0, 100 * (start - t0) / span);
        var width = Math.max(0.15, 100 * (e - start) / span);
        var el = h('div', { class: 'tl-bar ' + cls, style: { left: left + '%', width: Math.min(width, 100 - left) + '%' }, role: 'img', 'aria-label': tip().textContent });
        attachTip(el, tip);
        return el;
      }
      r.jobs.forEach(function (j) {
        var jstate = M.jobState(j);
        var jl = h('div', { class: 'tl-label' }, [
          h('span', { class: 'name', title: j.name }, extLink(M.jobUrl(r, j, CTX), j.name)),
          j.labels && j.labels.length ? h('span', { class: 'dim small', text: j.labels.join(', ') }) : null,
          h('span', { class: 'dur', text: fmtMs(j.durationMs) }),
        ]);
        grid.appendChild(h('div', { class: 'tl-row job' }, [jl, track([bar(j.startedMs, j.completedMs, jstate, function () { return tipContent(j.name, j.startedMs, j.completedMs, j.durationMs, M.stateLabel(jstate), (j.runnerName ? 'Runner: ' + j.runnerName : null)); })].filter(Boolean))]));
        j.steps.forEach(function (s) {
          if (!showSkipped && s.conclusion === 'skipped') return;
          var sstate = M.jobState(s);
          var ents = idx.byJobStep[j.id + ':' + s.number] || [];
          var sl = h('div', { class: 'tl-label' }, [h('span', { class: 'name', title: s.name, text: s.name }), entryChips(ents), h('span', { class: 'dur', text: fmtMs(s.durationMs) })]);
          var bars = [bar(s.startedMs, s.completedMs, sstate, function () { return tipContent(s.name, s.startedMs, s.completedMs, s.durationMs, M.stateLabel(sstate), null); })];
          ents.forEach(function (it) {
            var sm = it.entry.summary;
            if (sm && sm.startedAt && sm.endedAt) {
              var a = Math.max(sm.startedAt, s.startedMs || sm.startedAt), b = Math.min(sm.endedAt, s.completedMs || sm.endedAt);
              if (b > a) bars.push(bar(a, b, 'mvn', function () { return tipContent('Maven ' + (sm.goals || []).join(' '), sm.startedAt, sm.endedAt, sm.totalMs || sm.wallMs, sm.status || '', (sm.moduleCount != null ? sm.moduleCount + ' module(s) · ' : '') + (sm.threads > 1 ? '-T' + sm.threads + ' ' : '') + (sm.builderId || '')); }));
            }
          });
          grid.appendChild(h('div', { class: 'tl-row step' + (ents.length ? ' has-mvn' : '') }, [sl, track(bars.filter(Boolean))]));
        });
      });
      if (!r.jobs.length) grid.appendChild(h('div', { class: 'tl-label', style: { gridColumn: '1 / -1' }, text: 'No job information was recorded for this run.' }));
      if (idx.unattributed.length) {
        grid.appendChild(h('div', { class: 'tl-row step' }, [h('div', { class: 'tl-label' }, [h('span', { class: 'name', text: 'mvn-lens reports not attributed to a step' })]), h('div', { class: 'tl-track', style: { padding: '4px 8px' } }, entryChips(idx.unattributed))]));
      }
      scroll.appendChild(grid);
    }
    draw();
    return wrap;
  }
  function niceTick(spanMs) {
    var steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 4 * 3600000, 8 * 3600000, 12 * 3600000, 24 * 3600000];
    for (var i = 0; i < steps.length; i++) if (spanMs / steps[i] <= 12) return steps[i];
    return Math.ceil(spanMs / 12 / 86400000) * 86400000;
  }
  function tipContent(name, start, end, dur, state, extra) {
    return h('div', null, [h('b', { text: name }), h('div', { class: 'row' }, [h('span', { text: 'Duration' }), h('span', { text: fmtMs(dur) })]), h('div', { class: 'row' }, [h('span', { text: 'Started' }), h('span', { text: start ? new Date(start).toLocaleTimeString() : '—' })]), h('div', { class: 'row' }, [h('span', { text: 'Ended' }), h('span', { text: end ? new Date(end).toLocaleTimeString() : 'running' })]), state ? h('div', { class: 'row' }, [h('span', { text: 'Status' }), h('span', { text: state })]) : null, extra ? h('div', { class: 'dim', text: extra }) : null]);
  }
  var tipEl = null;
  function attachTip(el, content) {
    function show(ev) {
      if (!tipEl) { tipEl = h('div', { class: 'tl-tip' }); document.body.appendChild(tipEl); }
      clear(tipEl); tipEl.appendChild(content()); move(ev); tipEl.style.display = 'block';
    }
    function move(ev) { if (!tipEl) return; var x = ev.clientX + 14, y = ev.clientY + 14; if (x + 300 > window.innerWidth) x = ev.clientX - 310; tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px'; }
    function hide() { if (tipEl) tipEl.style.display = 'none'; }
    el.addEventListener('mouseenter', show); el.addEventListener('mousemove', move); el.addEventListener('mouseleave', hide);
    el.setAttribute('tabindex', '0'); el.addEventListener('focus', function () { var b = el.getBoundingClientRect(); show({ clientX: b.left, clientY: b.bottom }); }); el.addEventListener('blur', hide);
  }

  // ------------------------------------------------------------------------
  // Pending / error states
  // ------------------------------------------------------------------------
  function monitorWorkflowPath() {
    var ids = Object.keys(WORKFLOWS);
    for (var i = 0; i < ids.length; i++) {
      var w = WORKFLOWS[ids[i]];
      var base = w.path ? String(w.path).split('/').pop() : '';
      if (base === 'build-monitor.yml' || /build[ _-]?monitor/i.test(w.name || '')) return w.path;
    }
    return '.github/workflows/build-monitor.yml';
  }
  /** Unknown run/report id: the run is probably still being processed. Re-checks data/history.json every 30 s. */
  function viewPending(route) {
    var what = route.name === 'report' ? 'Report ' + route.key + ' of run ' + route.runId : 'Run ' + route.runId;
    var runLink = M.githubRunUrl(CTX, route.runId);
    var wfLink = M.workflowUrl(CTX, monitorWorkflowPath());
    var status = h('p', { class: 'dim small', id: 'bm-poll-status', text: pollStatusText() });
    return h('div', null, [
      crumbs([['#/reports', 'mvn-lens reports'], [null, what]]),
      h('div', { class: 'notice' }, [
        h('h2', { text: 'Waiting for the Build monitor workflow' }),
        h('p', { text: what + ' is not in the history yet. The history is refreshed by the Build monitor workflow once the run completes; GitHub Pages can take a few more minutes to publish it.' }),
        h('div', { class: 'links' }, [
          runLink ? extLink(runLink, 'Open the run on GitHub ↗') : null,
          wfLink ? extLink(wfLink, 'Build monitor workflow ↗') : null,
          link('#/reports', 'All reports'), link('#/builds', 'Builds'),
        ]),
        status,
      ]),
    ]);
  }
  function viewLoadError(err) {
    var body;
    if (err.kind === 'file') {
      body = [
        h('h2', { text: 'Opened from the file system' }),
        h('p', { text: 'Browsers do not let a page read ' + HISTORY_FILE + ' over file: URLs. Serve the site directory over HTTP and open it from there, for example:' }),
        h('pre', { text: 'node scripts/serve.js <site-dir>\n# then open the printed URL, e.g. http://127.0.0.1:8787/' }),
        h('p', { class: 'dim small', text: 'The published site (GitHub Pages) does not have this limitation.' }),
      ];
    } else if (err.kind === '404') {
      body = [
        h('h2', { text: 'No history published yet' }),
        h('p', { text: HISTORY_FILE + ' does not exist on this site. It is written by the Build monitor workflow once a monitored workflow run completes (or when you run the Build monitor workflow manually).' }),
        h('p', { class: 'dim small', id: 'bm-poll-status', text: pollStatusText() }),
      ];
    } else {
      body = [
        h('h2', { text: 'Could not load the history' }),
        h('p', { text: HISTORY_FILE + ': ' + err.message }),
        h('p', { class: 'dim small', id: 'bm-poll-status', text: pollStatusText() }),
      ];
    }
    return h('div', { class: 'notice ' + (err.kind === '404' ? '' : 'warn') }, body);
  }

  var poll = { timer: null, lastAt: null, lastResult: null, active: false, count: 0, route: null, gaveUp: false };
  function pollStatusText() {
    if (location.protocol === 'file:') return 'Automatic refresh is not possible from the file system — reload the page once the history has been published.';
    if (poll.gaveUp) {
      return 'Stopped checking ' + HISTORY_FILE + ' after ' + MAX_POLLS + ' attempts (' + Math.round(MAX_POLLS * POLL_MS / 60000) + ' min). '
        + 'Some runs never reach the history: a run of a pull request from a fork cannot publish a report (its token is read-only), '
        + 'and a run of a workflow the Build monitor does not monitor is never ingested. '
        + 'Open the run on GitHub with the link above to check it, then reload this page.';
    }
    var t = 'Checking ' + HISTORY_FILE + ' every ' + Math.round(POLL_MS / 1000) + ' s';
    if (poll.lastAt) t += ' · last check ' + new Date(poll.lastAt).toLocaleTimeString() + (poll.lastResult ? ' (' + poll.lastResult + ')' : '');
    return t + '.';
  }
  function routeResolves(route, model) {
    if (route.name === 'run') return !!model.byId[route.runId];
    if (route.name === 'report') { var r = model.byId[route.runId]; return !!(r && r.mvnLens.some(function (e) { return e.key === route.key; })); }
    return true;
  }
  /**
   * Polls data/history.json while a pending view is shown. It gives up after
   * MAX_POLLS fruitless checks: a run of a fork pull request or of an
   * unmonitored workflow is never ingested, and such a page would poll forever.
   * The counter is per pending route, so another unknown run starts fresh.
   */
  function startPolling(route) {
    var key = route ? M.routeHash(route) : '';
    if (poll.route !== key) { poll.route = key; poll.count = 0; poll.gaveUp = false; }
    if (poll.active || poll.gaveUp) return;
    poll.active = true;
    poll.timer = setInterval(function () {
      if (!poll.active) return;                    // stopped between two ticks
      fetchHistory('no-store').then(function (raw) {
        poll.lastAt = Date.now();
        var route = M.parseRoute(location.hash);
        var model = M.normalize(raw);
        if (!DATA || routeResolves(route, model) || model.runs.length !== RUNS.length || model.generatedAt !== DATA.generatedAt) {
          poll.lastResult = 'updated';
          boot(raw); SOURCE = 'fetch';
          render();
        } else {
          poll.lastResult = 'not there yet';
          countFruitlessPoll();
        }
      }, function (e) {
        poll.lastAt = Date.now();
        poll.lastResult = e && e.kind === '404' ? 'not published yet' : ('error: ' + (e && e.message || e));
        countFruitlessPoll();
      });
    }, POLL_MS);
  }
  function countFruitlessPoll() {
    poll.count++;
    if (poll.count >= MAX_POLLS) { stopPolling(); poll.gaveUp = true; }
    updatePollStatus();
  }
  function stopPolling() { if (poll.timer) clearInterval(poll.timer); poll.timer = null; poll.active = false; }
  function updatePollStatus() { var el = document.getElementById('bm-poll-status'); if (el) el.textContent = pollStatusText(); }

  // ------------------------------------------------------------------------
  // Shell + router
  // ------------------------------------------------------------------------
  function crumbs(items) {
    var el = h('div', { class: 'crumbs' });
    items.forEach(function (it, i) { if (i) el.appendChild(h('span', { class: 'sep', text: '›' })); el.appendChild(it[0] ? link(it[0], it[1]) : h('span', { text: it[1] })); });
    return el;
  }
  var navEl = null;
  function shell() {
    var app = document.getElementById('app');
    clear(app);
    var nav = h('nav', null, [h('a', { href: '#/reports', 'data-route': 'reports', text: 'mvn-lens reports' }), h('a', { href: '#/builds', 'data-route': 'builds', text: 'Builds' })]);
    var reportsCount = DATA && DATA.stats && DATA.stats.reportsCount !== null ? DATA.stats.reportsCount : null;
    app.appendChild(h('header', { class: 'top' }, [
      h('div', { class: 'brand' }, [link('#/reports', BASE_TITLE, 'title'), REPO ? h('span', { class: 'repo' }, REPO_URL ? extLink(REPO_URL, REPO) : REPO) : null]),
      nav,
      h('div', { class: 'meta', title: DATA && DATA.generatedAt ? DATA.generatedAt : '' }, [
        'Updated ' + (DATA && DATA.generatedMs ? M.formatRel(DATA.generatedMs) + ' · ' + fmtDate(DATA.generatedMs) : '—'),
        h('br'),
        h('span', { text: plural(RUNS.length, 'run') + (reportsCount !== null ? ' · ' + plural(reportsCount, 'report') + (DATA.stats.reportsBytes ? ' (' + M.formatBytes(DATA.stats.reportsBytes) + ')' : '') : '') }),
      ]),
    ]));
    app.appendChild(h('main', { id: 'view' }));
    app.appendChild(h('footer', null, ['Generated by ', extLink('https://github.com/mvn-perf/build-monitor', 'mvn-perf/build-monitor'), ' · ', link(HISTORY_FILE, 'history.json'), SOURCE === 'inline' ? ' (inlined)' : '']));
    return nav;
  }

  function render(opts) {
    var o = opts || {};
    if (!navEl) navEl = shell();
    chartDefaults();
    destroyCharts();
    if (tipEl) tipEl.style.display = 'none';
    var route = M.parseRoute(location.hash);
    var view = document.getElementById('view');
    clear(view);
    var content, title = BASE_TITLE, viewerMode = false, pending = false;
    try {
      if (LOAD_ERROR || !DATA) {
        content = viewLoadError(LOAD_ERROR || loadError('network', 'no data'));
        pending = LOAD_ERROR && LOAD_ERROR.kind !== 'file';
      } else if (route.name === 'run') {
        var r = BY_ID[route.runId];
        if (r) { content = viewRun(r); title = (r.workflowName || 'Run') + ' #' + r.runNumber + ' · ' + BASE_TITLE; }
        else { content = viewPending(route); pending = true; title = 'Run ' + route.runId + ' (pending) · ' + BASE_TITLE; }
      } else if (route.name === 'report') {
        var run = BY_ID[route.runId];
        var entry = run ? run.mvnLens.filter(function (e) { return e.key === route.key; })[0] : null;
        if (run && entry) { content = viewViewer(route, run, entry); viewerMode = true; title = entryTitle(entry) + ' #' + run.runNumber + ' · mvn-lens report · ' + BASE_TITLE; }
        else { content = viewPending(route); pending = true; title = 'Report (pending) · ' + BASE_TITLE; }
      } else if (route.name === 'builds') {
        content = viewBuilds(); title = 'Builds · ' + BASE_TITLE;
      } else {
        content = viewReports(); title = 'mvn-lens reports · ' + BASE_TITLE;
      }
    } catch (e) {
      if (window.console) console.error(e);
      content = h('p', { class: 'empty', text: 'This view failed to render: ' + (e && e.message ? e.message : String(e)) });
    }
    view.appendChild(content);
    document.body.className = viewerMode ? 'viewer-mode' : '';
    Array.prototype.forEach.call(navEl.querySelectorAll('a'), function (a) { a.classList.toggle('active', a.getAttribute('data-route') === route.name || (route.name === 'report' && a.getAttribute('data-route') === 'reports') || (route.name === 'run' && a.getAttribute('data-route') === 'builds')); });
    document.title = title;
    if (pending && location.protocol !== 'file:') startPolling(route); else stopPolling();
    if (o.focus) { var f = document.getElementById(o.focus); if (f) { try { f.focus(); var n = f.value.length; f.setSelectionRange(n, n); } catch (e) { /* ignore */ } } }
    else { try { window.scrollTo(0, 0); } catch (e) { /* non-browser environments */ } }
  }

  function start() {
    loadData().then(function (res) {
      boot(res.data); SOURCE = res.source;
    }, function (err) {
      LOAD_ERROR = err && err.kind ? err : loadError('network', String(err));
    }).then(function () {
      window.addEventListener('hashchange', function () { render(); });
      if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { render(); }); } catch (e) { /* old browsers */ } }
      render();
    });
  }
  window.buildMonitor = { render: render, start: start, model: M, data: function () { return DATA; }, filters: function () { return filters; }, extras: function () { return extras; } };
  start();
})();
