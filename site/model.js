/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Build monitor — pure data model of the monitoring page (no DOM). Loaded in the
 * browser (window.BuildMonitorModel) and under require() by the tests.
 *
 * Everything that becomes a URL is either a lookup key validated by a regex, a
 * stored report path re-validated with the processor's rule, or an external
 * https URL whose host equals the history's serverUrl host (safeHttpUrl).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.BuildMonitorModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------------
  // Validation rules (mirror src/history.js — keep in sync)
  // ------------------------------------------------------------------------
  var RUN_ID_RE = /^\d{1,20}$/;
  var SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}';
  /** One report-directory key — the same rule as history.isValidKey (a leading '_' is legal: GitHub job keys may start with one). */
  var KEY_RE = new RegExp('^' + SEGMENT + '$');
  var REPORT_PATH_RE = new RegExp('^reports/\\d{1,20}/' + SEGMENT + '/' + SEGMENT + '$');
  var REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
  var WORKFLOW_FILE_RE = /^[A-Za-z0-9_.-]{1,200}$/;
  var DEFAULT_SERVER_URL = 'https://github.com';

  function isValidRunId(s) { return typeof s === 'string' && RUN_ID_RE.test(s); }
  function isValidKey(s) { return typeof s === 'string' && KEY_RE.test(s) && s !== '.' && s !== '..'; }
  /** `reports/<runId>/<key>/<file>` with safe characters only — the same rule as history.isValidReportPath. */
  function isValidReportPath(p) {
    if (typeof p !== 'string' || !REPORT_PATH_RE.test(p)) return false;
    var segs = p.split('/');
    for (var i = 0; i < segs.length; i++) if (segs[i] === '.' || segs[i] === '..') return false;
    return true;
  }
  function isValidRepository(r) { return typeof r === 'string' && REPOSITORY_RE.test(r) && r.indexOf('..') < 0; }
  /** A positive safe integer (ids, run numbers, step numbers), else null. */
  function safeInt(v) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  // ------------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------------
  /**
   * `#/reports` (default) · `#/report/<runId>/<key>` · `#/builds` · `#/run/<id>`.
   * Parameters are lookup keys only; anything that does not match falls back to
   * the reports view (never throws).
   */
  function parseRoute(hash) {
    var s = typeof hash === 'string' ? hash : '';
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s.charAt(0) !== '/') s = '/' + s;
    s = s.replace(/\/+$/, '') || '/';
    var m;
    if (s === '/' || s === '/reports') return { name: 'reports' };
    if (s === '/builds') return { name: 'builds' };
    if ((m = /^\/run\/([^/]+)$/.exec(s)) && isValidRunId(m[1])) return { name: 'run', runId: m[1] };
    if ((m = /^\/report\/([^/]+)\/([^/]+)$/.exec(s)) && isValidRunId(m[1]) && isValidKey(m[2])) return { name: 'report', runId: m[1], key: m[2] };
    return { name: 'reports' };
  }
  function routeHash(route) {
    if (!route) return '#/reports';
    if (route.name === 'builds') return '#/builds';
    if (route.name === 'run' && isValidRunId(String(route.runId))) return '#/run/' + route.runId;
    if (route.name === 'report' && isValidRunId(String(route.runId)) && isValidKey(route.key)) return '#/report/' + route.runId + '/' + route.key;
    return '#/reports';
  }
  function runHref(run) { var id = run && run.id !== undefined ? String(run.id) : ''; return isValidRunId(id) ? '#/run/' + id : '#/reports'; }
  /** In-page viewer route of an entry, or null when the key cannot be a route parameter. */
  function reportHref(run, entry) {
    var id = run && run.id !== undefined ? String(run.id) : '';
    if (!isValidRunId(id) || !entry || !isValidKey(entry.key)) return null;
    return '#/report/' + id + '/' + entry.key;
  }

  // ------------------------------------------------------------------------
  // URLs
  // ------------------------------------------------------------------------
  function serverHost(serverUrl) {
    try { return new URL(serverUrl || DEFAULT_SERVER_URL).host.toLowerCase(); } catch (e) { return 'github.com'; }
  }
  /**
   * Returns the URL when it is https and its host equals the history's server
   * host (github.com by default), else null. Rejects credentials in the URL.
   */
  function safeHttpUrl(u, serverUrl) {
    if (typeof u !== 'string' || !u || u.length > 2000) return null;
    var url;
    try { url = new URL(u); } catch (e) { return null; }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.host.toLowerCase() !== serverHost(serverUrl)) return null;
    return url.href;
  }
  function repoUrl(ctx) {
    var c = ctx || {};
    var direct = safeHttpUrl(c.repositoryUrl, c.serverUrl);
    if (direct) return direct.replace(/\/+$/, '');
    if (!isValidRepository(c.repository)) return null;
    var base = safeHttpUrl(c.serverUrl || DEFAULT_SERVER_URL, c.serverUrl);
    return base ? base.replace(/\/+$/, '') + '/' + c.repository : null;
  }
  /** GitHub run page: the stored html_url when safe, else built from validated integers. */
  function runUrl(run, ctx) {
    var c = ctx || {};
    var stored = run ? safeHttpUrl(run.htmlUrl, c.serverUrl) : null;
    if (stored) return stored;
    var id = run ? safeInt(run.id) : null;
    return id ? githubRunUrl(c, id) : null;
  }
  /** `<serverUrl>/<repository>/actions/runs/<runId>` from a validated id (pending state, unknown runs). */
  function githubRunUrl(ctx, runId) {
    var id = safeInt(runId);
    var base = repoUrl(ctx);
    return id && base ? base + '/actions/runs/' + id : null;
  }
  function jobUrl(run, job, ctx) {
    var c = ctx || {};
    var stored = job ? safeHttpUrl(job.htmlUrl, c.serverUrl) : null;
    if (stored) return stored;
    var rid = runUrl(run, c);
    var jid = job ? safeInt(job.id) : null;
    return rid && jid ? rid + '/job/' + jid : null;
  }
  /** Deep link to a step's log; without a step number the job page; null when nothing safe is known. */
  function stepUrl(run, job, stepNumber, ctx) {
    var base = jobUrl(run, job, ctx);
    if (!base) return null;
    var n = safeInt(stepNumber);
    return n ? base + '#step:' + n + ':1' : base;
  }
  /** The workflow page (`/actions/workflows/<file>`), or the Actions tab when the file name is unknown. */
  function workflowUrl(ctx, workflowPath) {
    var base = repoUrl(ctx);
    if (!base) return null;
    var file = typeof workflowPath === 'string' ? workflowPath.split('/').pop() : '';
    return file && WORKFLOW_FILE_RE.test(file) && file !== '.' && file !== '..' ? base + '/actions/workflows/' + file : base + '/actions';
  }
  function commitUrl(run, ctx) {
    var base = repoUrl(ctx);
    return base && run && typeof run.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(run.sha) ? base + '/commit/' + run.sha : null;
  }
  /**
   * The best GitHub link of an mvn-lens entry: the step log when the step is
   * known, else the job page, else the run page — with a tooltip naming how the
   * report was attributed (entry.attribution) and why the link degraded.
   */
  function stepLink(run, entry, ctx) {
    var e = entry || {};
    var jobs = (run && run.jobs) || [];
    var jid = safeInt(e.jobId);
    var job = null;
    for (var i = 0; i < jobs.length && jid; i++) if (safeInt(jobs[i].id) === jid) { job = jobs[i]; break; }
    if (!job && jid) job = { id: jid, htmlUrl: e.jobUrl || null };
    var how = e.attribution ? String(e.attribution) : 'none';
    var n = safeInt(e.stepNumber);
    var href;
    if (job && n && (href = stepUrl(run, job, n, ctx))) {
      return { href: href, kind: 'step', label: 'GitHub step ↗', title: 'Step ' + n + (e.stepName ? ' “' + e.stepName + '”' : '') + ' of job ' + (job.name || e.jobName || jid) + ' (attributed by ' + how + ')' };
    }
    if (job && (href = jobUrl(run, job, ctx))) {
      return { href: href, kind: 'job', label: 'GitHub job ↗', title: 'Step unknown — linking to the job ' + (job.name || e.jobName || jid) + ' (attributed by ' + how + ')' };
    }
    href = runUrl(run, ctx);
    if (href) return { href: href, kind: 'run', label: 'GitHub run ↗', title: 'Job unknown — linking to the run (attribution: ' + how + ')' };
    return null;
  }

  // ------------------------------------------------------------------------
  // Normalisation
  // ------------------------------------------------------------------------
  function parseMs(s) { if (!s) return null; var t = Date.parse(s); return isFinite(t) ? t : null; }
  function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function strOrNull(v) { return v === undefined || v === null ? null : String(v); }

  /**
   * Turns a history.json object into the view model: ms timestamps, arrays
   * guaranteed, report paths re-validated (invalid → null), a run index, the
   * mvn-lens series and a few dataset facts. Never throws on bad input.
   */
  function normalize(raw) {
    var d = raw && typeof raw === 'object' ? raw : {};
    var serverUrl = safeHttpUrl(strOrNull(d.serverUrl), strOrNull(d.serverUrl)) ? String(d.serverUrl).replace(/\/+$/, '') : DEFAULT_SERVER_URL;
    var repository = isValidRepository(d.repository) ? d.repository : null;
    var ctx = { serverUrl: serverUrl, repository: repository, repositoryUrl: strOrNull(d.repositoryUrl) };
    var workflows = {};
    if (d.workflows && typeof d.workflows === 'object' && !Array.isArray(d.workflows)) {
      Object.keys(d.workflows).forEach(function (k) {
        var w = d.workflows[k];
        if (w && typeof w === 'object') workflows[k] = { id: w.id !== undefined ? w.id : k, name: strOrNull(w.name), path: strOrNull(w.path), state: strOrNull(w.state) };
      });
    }
    var runs = (Array.isArray(d.runs) ? d.runs : []).filter(function (r) { return r && typeof r === 'object' && safeInt(r.id); }).map(function (r) { return normalizeRun(r); });
    runs.forEach(function (r) {
      var wk = String(r.workflowId);
      if (!workflows[wk]) workflows[wk] = { id: r.workflowId, name: r.workflowName, path: r.workflowPath, state: null };
    });
    runs.sort(function (a, b) { return b.createdMs - a.createdMs || b.id - a.id; });
    var byId = {};
    runs.forEach(function (r) { byId[String(r.id)] = r; });
    var branches = uniq(runs.map(function (r) { return r.branch; }));
    var defaultBranch = strOrNull(d.defaultBranch);
    return {
      schemaVersion: numOrNull(d.schemaVersion),
      repository: repository,
      repositoryUrl: repoUrl(ctx),
      serverUrl: serverUrl,
      defaultBranch: defaultBranch,
      siteUrl: strOrNull(d.siteUrl),
      generatedAt: strOrNull(d.generatedAt),
      generatedMs: parseMs(d.generatedAt),
      stats: d.stats && typeof d.stats === 'object' ? { reportsCount: numOrNull(d.stats.reportsCount), reportsBytes: numOrNull(d.stats.reportsBytes) } : { reportsCount: null, reportsBytes: null },
      workflows: workflows,
      runs: runs,
      byId: byId,
      branches: branches,
      isSingleBranch: branches.length <= 1,
      hasDefaultBranchRuns: !!defaultBranch && runs.some(function (r) { return r.branch === defaultBranch; }),
      series: seriesOf(runs),
      ctx: ctx,
    };
  }

  function normalizeRun(r) {
    var run = {
      id: safeInt(r.id),
      workflowId: r.workflowId !== undefined && r.workflowId !== null ? r.workflowId : 0,
      workflowName: strOrNull(r.workflowName),
      workflowPath: strOrNull(r.workflowPath),
      runNumber: safeInt(r.runNumber) || 0,
      attempt: safeInt(r.attempt) || 1,
      event: strOrNull(r.event),
      status: strOrNull(r.status),
      conclusion: strOrNull(r.conclusion),
      branch: strOrNull(r.branch),
      sha: strOrNull(r.sha),
      headRepository: strOrNull(r.headRepository),
      title: strOrNull(r.title),
      actor: strOrNull(r.actor),
      htmlUrl: strOrNull(r.htmlUrl),
      createdAt: strOrNull(r.createdAt),
      startedAt: strOrNull(r.startedAt),
      completedAt: strOrNull(r.completedAt),
      updatedAt: strOrNull(r.updatedAt),
      durationMs: numOrNull(r.durationMs),
      queueMs: numOrNull(r.queueMs),
      jobs: [],
      mvnLens: [],
    };
    run.createdMs = parseMs(run.createdAt) || 0;
    run.startedMs = parseMs(run.startedAt) || run.createdMs;
    run.completedMs = parseMs(run.completedAt);
    run.jobs = (Array.isArray(r.jobs) ? r.jobs : []).filter(function (j) { return j && typeof j === 'object'; }).map(function (j) {
      var job = {
        id: safeInt(j.id), name: strOrNull(j.name) || '', status: strOrNull(j.status), conclusion: strOrNull(j.conclusion),
        startedAt: strOrNull(j.startedAt), completedAt: strOrNull(j.completedAt), durationMs: numOrNull(j.durationMs),
        runnerName: strOrNull(j.runnerName), runnerGroup: strOrNull(j.runnerGroup), labels: Array.isArray(j.labels) ? j.labels.map(String) : [],
        htmlUrl: strOrNull(j.htmlUrl), steps: [],
      };
      job.startedMs = parseMs(job.startedAt);
      job.completedMs = parseMs(job.completedAt);
      job.steps = (Array.isArray(j.steps) ? j.steps : []).filter(function (s) { return s && typeof s === 'object'; }).map(function (s) {
        var st = { number: safeInt(s.number), name: strOrNull(s.name) || '', status: strOrNull(s.status), conclusion: strOrNull(s.conclusion), startedAt: strOrNull(s.startedAt), completedAt: strOrNull(s.completedAt), durationMs: numOrNull(s.durationMs) };
        st.startedMs = parseMs(st.startedAt);
        st.completedMs = parseMs(st.completedAt);
        return st;
      });
      return job;
    });
    run.mvnLens = (Array.isArray(r.mvnLens) ? r.mvnLens : []).filter(function (e) { return e && typeof e === 'object'; }).map(function (e) {
      var entry = {
        key: strOrNull(e.key), dir: strOrNull(e.dir), path: strOrNull(e.path),
        jobId: safeInt(e.jobId), jobName: strOrNull(e.jobName), jobUrl: strOrNull(e.jobUrl),
        stepNumber: safeInt(e.stepNumber), stepName: strOrNull(e.stepName), label: strOrNull(e.label),
        attempt: safeInt(e.attempt), attribution: strOrNull(e.attribution), superseded: e.superseded === true,
        collectedAt: strOrNull(e.collectedAt), bytes: numOrNull(e.bytes),
        reports: [],
      };
      entry.reports = (Array.isArray(e.reports) ? e.reports : []).filter(function (x) { return x && typeof x === 'object'; }).map(function (x) {
        return {
          name: strOrNull(x.name), label: strOrNull(x.label),
          path: isValidReportPath(x.path) ? x.path : null,      // the only value that becomes an iframe src / href
          summary: x.summary && typeof x.summary === 'object' ? x.summary : null,
          summarySource: strOrNull(x.summarySource), bytes: numOrNull(x.bytes),
        };
      });
      entry.summary = entry.reports.length ? entry.reports[0].summary : null;
      return entry;
    });
    return run;
  }

  // ------------------------------------------------------------------------
  // Series (one Maven build identity across runs) and report rows
  // ------------------------------------------------------------------------
  /** Stable identity of a Maven build across runs: workflow + job + step + label (history.mavenSeriesKey). */
  function mavenSeriesKey(workflowPath, jobName, stepName, label) {
    return [workflowPath || '', jobName || '', stepName || '', label || ''].map(function (s) { return String(s); }).join(' ');
  }
  function entryKey(run, entry) { return mavenSeriesKey(run.workflowPath, entry.jobName, entry.stepName, entry.label); }
  function seriesTitle(s) {
    var t = s.workflowName || s.workflowPath || 'workflow';
    t += ' · ' + (s.jobName || 'unattributed');
    if (s.stepName) t += ' › ' + s.stepName;
    if (s.label) t += ' · ' + s.label;
    return t;
  }
  /** The series of the given runs (superseded entries are not part of any series). Points newest first. */
  function seriesOf(runs) {
    var map = {};
    (runs || []).forEach(function (r) {
      (r.mvnLens || []).forEach(function (e) {
        if (e.superseded) return;
        var key = entryKey(r, e);
        var s = map[key] || (map[key] = { key: key, workflowId: r.workflowId, workflowName: r.workflowName, workflowPath: r.workflowPath, jobName: e.jobName, stepName: e.stepName, label: e.label, points: [] });
        s.points.push({ run: r, entry: e, report: e.reports[0] || null, summary: e.summary || null });
      });
    });
    var list = Object.keys(map).map(function (k) { return map[k]; });
    list.forEach(function (s) { s.title = seriesTitle(s); s.points.sort(function (a, b) { return b.run.createdMs - a.run.createdMs || b.run.id - a.run.id; }); });
    list.sort(function (a, b) { return cmp(a.workflowName, b.workflowName) || cmp(a.jobName, b.jobName) || cmp(a.stepName, b.stepName) || cmp(a.label, b.label); });
    return list;
  }
  function cmp(a, b) { return String(a || '').localeCompare(String(b || '')); }

  /**
   * One row per mvn-lens entry of the given runs (runs newest first, entries by
   * job then step). opts: { showSuperseded, series (key), maven ('' | 'ok' | 'failed') }.
   */
  function reportRows(runs, opts) {
    var o = opts || {};
    var rows = [];
    (runs || []).forEach(function (r) {
      var entries = (r.mvnLens || []).slice().sort(function (a, b) { return cmp(a.jobName, b.jobName) || (a.stepNumber || 0) - (b.stepNumber || 0) || cmp(a.label, b.label) || cmp(a.key, b.key); });
      entries.forEach(function (e) {
        if (e.superseded && !o.showSuperseded) return;
        var key = entryKey(r, e);
        if (o.series && key !== o.series) return;
        var s = e.summary;
        var st = mavenStatus(s);
        if (o.maven === 'ok' && st !== 'ok') return;
        if (o.maven === 'failed' && st !== 'failed') return;
        rows.push({ run: r, entry: e, report: e.reports[0] || null, summary: s, seriesKey: key, mavenStatus: st });
      });
    });
    return rows;
  }
  /** 'ok' | 'failed' | 'unknown' from a summary's Maven status. */
  function mavenStatus(summary) {
    if (!summary || !summary.status) return 'unknown';
    var s = String(summary.status).toUpperCase();
    if (s === 'OK' || s === 'SUCCESS') return 'ok';
    return 'failed';
  }
  /** Keys whose value is the same on every row (candidates for auto-hiding); needs ≥ 2 rows. */
  function constantColumns(rows, getters) {
    var out = [];
    if (!rows || rows.length < 2) return out;
    Object.keys(getters).forEach(function (k) {
      var first = getters[k](rows[0]);
      var same = true;
      for (var i = 1; i < rows.length && same; i++) if (getters[k](rows[i]) !== first) same = false;
      if (same) out.push(k);
    });
    return out;
  }

  // ------------------------------------------------------------------------
  // Filters
  // ------------------------------------------------------------------------
  var RANGES = ['7d', '30d', '90d', '1y', 'all'];
  var RANGE_LABELS = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '1y': '1 year', all: 'All' };
  var STATUSES = ['', 'success', 'failure', 'completed', 'running'];
  function rangeMs(range) { return { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[range] ? { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[range] * 86400000 : null; }
  function defaultFilters(model) {
    var m = model || {};
    return { range: '90d', branch: m.defaultBranch && !m.isSingleBranch && m.hasDefaultBranchRuns ? m.defaultBranch : '', event: '', status: '', workflow: '', text: '' };
  }
  /** Merges a saved filter object into the defaults, keeping only values that exist in this dataset. */
  function sanitizeFilters(saved, model) {
    var f = defaultFilters(model);
    var runs = (model && model.runs) || [];
    if (!saved || typeof saved !== 'object') return f;
    if (RANGES.indexOf(saved.range) >= 0) f.range = saved.range;
    if (saved.branch === '' || (typeof saved.branch === 'string' && runs.some(function (r) { return r.branch === saved.branch; }))) f.branch = saved.branch;
    if (saved.event === '' || (typeof saved.event === 'string' && runs.some(function (r) { return r.event === saved.event; }))) f.event = saved.event;
    if (STATUSES.indexOf(saved.status) >= 0) f.status = saved.status;
    if (saved.workflow === '' || (typeof saved.workflow === 'string' && runs.some(function (r) { return String(r.workflowId) === saved.workflow; }))) f.workflow = saved.workflow;
    return f;
  }
  function runState(r) { return r.status === 'completed' ? (r.conclusion || 'neutral') : 'running'; }
  /** Case-insensitive substring match over the run's descriptive fields, jobs, steps and mvn-lens entries. */
  function runMatchesText(r, text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return true;
    var hay = [r.title, r.branch, r.actor, r.sha, r.event, r.workflowName, r.conclusion, '#' + r.runNumber, String(r.id)];
    (r.jobs || []).forEach(function (j) { hay.push(j.name, j.runnerName); (j.steps || []).forEach(function (s) { hay.push(s.name); }); });
    (r.mvnLens || []).forEach(function (e) { hay.push(e.jobName, e.stepName, e.label, e.key); if (e.summary) hay.push(e.summary.jdkVersion, e.summary.mavenVersion, (e.summary.goals || []).join(' ')); });
    for (var i = 0; i < hay.length; i++) if (hay[i] && String(hay[i]).toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }
  /** filters: { range, branch, event, status, workflow, text }; `now` is injectable for tests. */
  function applyFilters(runs, filters, now) {
    var f = filters || {};
    var since = rangeMs(f.range);
    var cutoff = since ? (now || Date.now()) - since : 0;
    return (runs || []).filter(function (r) {
      if (cutoff && r.createdMs < cutoff) return false;
      if (f.branch && r.branch !== f.branch) return false;
      if (f.event && r.event !== f.event) return false;
      if (f.workflow && String(r.workflowId) !== String(f.workflow)) return false;
      if (f.status === 'success' && runState(r) !== 'success') return false;
      if (f.status === 'failure' && runState(r) !== 'failure') return false;
      if (f.status === 'completed' && r.status !== 'completed') return false;
      if (f.status === 'running' && r.status === 'completed') return false;
      if (f.text && !runMatchesText(r, f.text)) return false;
      return true;
    });
  }

  // ------------------------------------------------------------------------
  // Formatting & conclusions
  // ------------------------------------------------------------------------
  var CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'startup_failure', 'stale', 'running'];
  var STATE_LABELS = { success: 'Success', failure: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', timed_out: 'Timed out', running: 'Running', neutral: 'Neutral', action_required: 'Action required', startup_failure: 'Startup failure', stale: 'Stale', queued: 'Queued', in_progress: 'In progress', waiting: 'Waiting', pending: 'Pending' };
  function stateLabel(s) { return STATE_LABELS[s] || String(s || ''); }
  function stateClass(s) { return CONCLUSIONS.indexOf(s) >= 0 ? s : (s === 'in_progress' || s === 'queued' || s === 'waiting' || s === 'pending' ? 'running' : 'neutral'); }
  function jobState(j) { return j.status === 'completed' ? (j.conclusion || 'neutral') : (j.status || 'queued'); }

  function formatMs(ms) {
    if (ms === null || ms === undefined || typeof ms !== 'number' || !isFinite(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' s';
    var total = Math.round(s);                       // round first, so 119.6 s is "2m 00s", never "1m 60s"
    var m = Math.floor(total / 60), rs = total % 60;
    if (m < 60) return m + 'm ' + (rs < 10 ? '0' : '') + rs + 's';
    var hh = Math.floor(m / 60);
    return hh + 'h ' + (m % 60 < 10 ? '0' : '') + (m % 60) + 'm';
  }
  function formatSecAxis(sec) {
    var total = Math.round(sec);
    if (total < 60) return total + 's';
    var m = Math.floor(total / 60), s = total % 60;
    if (m < 60) return m + 'm' + (s ? (s < 10 ? '0' : '') + s + 's' : '');
    return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
  }
  function formatBytes(b) {
    b = Number(b);
    if (!isFinite(b) || b <= 0) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(1) : String(Math.round(b))) + ' ' + u[i];
  }
  function formatRel(ms, now) {
    if (!ms) return '—';
    var diff = (now || Date.now()) - ms, m = Math.round(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var hh = Math.round(m / 60);
    if (hh < 48) return hh + ' h ago';
    return Math.round(hh / 24) + ' days ago';
  }
  function shortSha(sha) { return sha ? String(sha).slice(0, 7) : ''; }
  function uniq(arr) { var seen = {}; return arr.filter(function (x) { if (x === null || x === undefined || x === '') return false; if (seen[x]) return false; seen[x] = 1; return true; }); }
  function median(nums) { if (!nums.length) return null; var a = nums.slice().sort(function (x, y) { return x - y; }); var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function percentile(nums, p) { if (!nums.length) return null; var a = nums.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))]; }

  return {
    RUN_ID_RE: RUN_ID_RE, KEY_RE: KEY_RE, REPORT_PATH_RE: REPORT_PATH_RE, DEFAULT_SERVER_URL: DEFAULT_SERVER_URL,
    RANGES: RANGES, RANGE_LABELS: RANGE_LABELS, STATUSES: STATUSES, CONCLUSIONS: CONCLUSIONS,
    isValidRunId: isValidRunId, isValidKey: isValidKey, isValidReportPath: isValidReportPath, isValidRepository: isValidRepository, safeInt: safeInt,
    parseRoute: parseRoute, routeHash: routeHash, runHref: runHref, reportHref: reportHref,
    safeHttpUrl: safeHttpUrl, repoUrl: repoUrl, runUrl: runUrl, githubRunUrl: githubRunUrl, jobUrl: jobUrl, stepUrl: stepUrl, stepLink: stepLink, workflowUrl: workflowUrl, commitUrl: commitUrl,
    normalize: normalize, normalizeRun: normalizeRun,
    mavenSeriesKey: mavenSeriesKey, entryKey: entryKey, seriesOf: seriesOf, seriesTitle: seriesTitle, reportRows: reportRows, mavenStatus: mavenStatus, constantColumns: constantColumns,
    rangeMs: rangeMs, defaultFilters: defaultFilters, sanitizeFilters: sanitizeFilters, applyFilters: applyFilters, runMatchesText: runMatchesText,
    runState: runState, jobState: jobState, stateLabel: stateLabel, stateClass: stateClass,
    formatMs: formatMs, formatSecAxis: formatSecAxis, formatBytes: formatBytes, formatRel: formatRel, shortSha: shortSha,
    uniq: uniq, median: median, percentile: percentile,
  };
});
