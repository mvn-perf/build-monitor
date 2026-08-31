/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../site/model');
const history = require('../src/history');

const NOW = Date.parse('2026-08-30T12:00:00Z');
function isoDaysAgo(days) { return new Date(NOW - days * 86400000).toISOString(); }

function rawHistory() {
  return {
    schemaVersion: 1,
    repository: 'acme/widgets',
    repositoryUrl: 'https://github.com/acme/widgets',
    serverUrl: 'https://github.com',
    defaultBranch: 'main',
    generatedAt: isoDaysAgo(0),
    stats: { reportsCount: 3, reportsBytes: 4500000 },
    workflows: { '1': { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' } },
    runs: [
      {
        id: 501, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 11, attempt: 2,
        event: 'push', status: 'completed', conclusion: 'success', branch: 'main', sha: 'a'.repeat(40),
        title: 'Fix flaky test', actor: 'octocat', htmlUrl: 'https://github.com/acme/widgets/actions/runs/501',
        createdAt: isoDaysAgo(2), startedAt: isoDaysAgo(2), completedAt: isoDaysAgo(2), durationMs: 300000, queueMs: 9000,
        jobs: [{
          id: 91, name: 'build', status: 'completed', conclusion: 'success', startedAt: isoDaysAgo(2), completedAt: isoDaysAgo(2),
          durationMs: 290000, runnerName: 'GitHub Actions 7', labels: ['ubuntu-latest'],
          htmlUrl: 'https://github.com/acme/widgets/actions/runs/501/job/91',
          steps: [{ number: 4, name: 'Build with Maven', status: 'completed', conclusion: 'success', startedAt: isoDaysAgo(2), completedAt: isoDaysAgo(2), durationMs: 200000 }],
        }],
        mvnLens: [
          { key: 'j91-s4', jobId: 91, jobName: 'build', jobUrl: 'https://github.com/acme/widgets/actions/runs/501/job/91', stepNumber: 4, stepName: 'Build with Maven', label: null, attempt: 2, attribution: 'jobId', superseded: false, collectedAt: isoDaysAgo(2), bytes: 100, reports: [{ name: 'report.html', path: 'reports/501/j91-s4/report.html', summary: { status: 'OK', totalMs: 200000 }, summarySource: 'meta', bytes: 100 }] },
          { key: 'j80-s4', jobId: 80, jobName: 'build', jobUrl: null, stepNumber: 4, stepName: 'Build with Maven', label: null, attempt: 1, attribution: 'stale-job', superseded: true, collectedAt: isoDaysAgo(2), bytes: 90, reports: [{ name: 'report.html', path: 'reports/501/j80-s4/report.html', summary: { status: 'FAILED', totalMs: 220000 }, summarySource: 'meta', bytes: 90 }] },
          { key: 'evil', jobId: null, jobName: null, stepNumber: null, stepName: null, label: 'sidecar', attempt: 2, attribution: 'none', superseded: false, reports: [{ name: 'report.html', path: '../../../etc/passwd', summary: { status: 'OK', totalMs: 1000 }, bytes: 10 }] },
        ],
      },
      {
        id: 400, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 10, attempt: 1,
        event: 'pull_request', status: 'completed', conclusion: 'failure', branch: 'feature/x', sha: 'b'.repeat(40),
        title: 'Try something', actor: 'hubot', htmlUrl: 'https://github.com/acme/widgets/actions/runs/400',
        createdAt: isoDaysAgo(40), startedAt: isoDaysAgo(40), completedAt: isoDaysAgo(40), durationMs: 500000, queueMs: 4000,
        jobs: [{ id: 71, name: 'build', status: 'completed', conclusion: 'failure', startedAt: isoDaysAgo(40), completedAt: isoDaysAgo(40), durationMs: 480000, htmlUrl: 'https://github.com/acme/widgets/actions/runs/400/job/71', steps: [{ number: 4, name: 'Build with Maven', status: 'completed', conclusion: 'failure', durationMs: 400000 }, { number: 6, name: 'Integration tests', status: 'completed', conclusion: 'skipped' }] }],
        mvnLens: [{ key: 'j71-s4', jobId: 71, jobName: 'build', stepNumber: 4, stepName: 'Build with Maven', label: null, attempt: 1, attribution: 'jobId', superseded: false, bytes: 80, reports: [{ name: 'report.html', path: 'reports/400/j71-s4/report.html', summary: { status: 'FAILED', totalMs: 210000, jdkVersion: '25' }, bytes: 80 }] }],
      },
      {
        id: 600, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 12, attempt: 1,
        event: 'push', status: 'in_progress', conclusion: null, branch: 'main', sha: 'c'.repeat(40),
        title: 'WIP', actor: 'octocat', htmlUrl: 'https://github.com/acme/widgets/actions/runs/600',
        createdAt: isoDaysAgo(0), startedAt: isoDaysAgo(0), durationMs: null, jobs: [], mvnLens: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// parseRoute
// ---------------------------------------------------------------------------

test('parseRoute resolves the four routes and defaults to reports', () => {
  assert.deepEqual(M.parseRoute(''), { name: 'reports' });
  assert.deepEqual(M.parseRoute('#/'), { name: 'reports' });
  assert.deepEqual(M.parseRoute('#/reports'), { name: 'reports' });
  assert.deepEqual(M.parseRoute('#/reports/'), { name: 'reports' });
  assert.deepEqual(M.parseRoute('#/builds'), { name: 'builds' });
  assert.deepEqual(M.parseRoute('#/builds/'), { name: 'builds' });
  assert.deepEqual(M.parseRoute('#/run/501'), { name: 'run', runId: '501' });
  assert.deepEqual(M.parseRoute('#/report/501/j91-s4'), { name: 'report', runId: '501', key: 'j91-s4' });
  assert.deepEqual(M.parseRoute('#/report/501/j91-s4.x_y-2'), { name: 'report', runId: '501', key: 'j91-s4.x_y-2' });
});

test('parseRoute rejects invalid ids, keys and traversal attempts (falls back to reports)', () => {
  const bad = [
    '#/run/abc', '#/run/-1', '#/run/1e3', '#/run/1 2', '#/run/' + '9'.repeat(21), '#/run/501/extra',
    '#/report/501', '#/report/501/', '#/report/abc/key', '#/report/501/..', '#/report/501/.',
    '#/report/501/../../etc', '#/report/501/%2e%2e', '#/report/501/a b', '#/report/501/a<script>',
    '#/report/501/.hidden', '#/report/501/a/'.slice(0, -1) + '/b/c', '#/report/501/a\\b',
    '#/report/501/' + 'a'.repeat(121), '#/unknown', '#/../..', 'javascript:alert(1)',
  ];
  for (const hash of bad) assert.deepEqual(M.parseRoute(hash), { name: 'reports' }, hash);
  // Boundary: 120 chars is the longest valid key (history.isValidKey); a leading '_' or '-' is legal (GitHub job keys may start with '_').
  assert.equal(M.parseRoute('#/report/1/' + 'a'.repeat(120)).name, 'report');
  assert.deepEqual(M.parseRoute('#/report/1/_build-a1b2c3'), { name: 'report', runId: '1', key: '_build-a1b2c3' });
  assert.deepEqual(M.parseRoute('#/report/1/-x'), { name: 'report', runId: '1', key: '-x' });
  assert.equal(M.parseRoute(null).name, 'reports');
  assert.equal(M.parseRoute(42).name, 'reports');
});

test('isValidKey agrees with src/history.isValidKey (the processor writes the keys the viewer routes)', () => {
  const cases = ['j91-s4', 'j91-s4-integration-tests', '_build-a1b2c3', '-lead', 'a', 'a'.repeat(120), 'a'.repeat(121), '.hidden', '.', '..', '', 'a b', 'a/b', 'a\\b', 'a<b', 'ünïcode', 'a.b_c-d', 'sample'];
  for (const k of cases) assert.equal(M.isValidKey(k), history.isValidKey(k), JSON.stringify(k));
  assert.equal(M.isValidKey(null), false);
  assert.equal(M.isValidKey(42), false);
  // The key the report action derives via history.reportDirFor is always routable.
  const dir = history.reportDirFor(501, 'Java 25 (ubuntu-latest)-x1y2z3');
  assert.ok(M.isValidKey(dir.split('/')[2]), dir);
});

test('routeHash and reportHref only build hashes from validated parameters', () => {
  assert.equal(M.routeHash({ name: 'run', runId: '501' }), '#/run/501');
  assert.equal(M.routeHash({ name: 'run', runId: '../x' }), '#/reports');
  assert.equal(M.routeHash({ name: 'report', runId: '501', key: 'j91-s4' }), '#/report/501/j91-s4');
  assert.equal(M.routeHash({ name: 'report', runId: '501', key: 'a/b' }), '#/reports');
  assert.equal(M.reportHref({ id: 501 }, { key: 'j91-s4' }), '#/report/501/j91-s4');
  assert.equal(M.reportHref({ id: 501 }, { key: '.bad' }), null, 'keys must not start with a dot');
  assert.equal(M.reportHref({ id: 501 }, { key: 'a b' }), null);
  assert.equal(M.reportHref({ id: 'nope' }, { key: 'j91-s4' }), null);
});

// ---------------------------------------------------------------------------
// safeHttpUrl
// ---------------------------------------------------------------------------

test('safeHttpUrl accepts https URLs on the server host only', () => {
  assert.equal(M.safeHttpUrl('https://github.com/acme/widgets/actions/runs/1'), 'https://github.com/acme/widgets/actions/runs/1');
  assert.equal(M.safeHttpUrl('https://GITHUB.com/x'), 'https://github.com/x', 'host comparison is case-insensitive');
  assert.equal(M.safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(M.safeHttpUrl('http://github.com/x'), null, 'http is rejected');
  assert.equal(M.safeHttpUrl('https://evil.com/x'), null);
  assert.equal(M.safeHttpUrl('https://github.com.evil.com/x'), null);
  assert.equal(M.safeHttpUrl('https://user:pw@github.com/x'), null, 'credentials rejected');
  assert.equal(M.safeHttpUrl('//github.com/x'), null);
  assert.equal(M.safeHttpUrl('data:text/html,x'), null);
  assert.equal(M.safeHttpUrl(''), null);
  assert.equal(M.safeHttpUrl(null), null);
  // GHES: the host comes from history.serverUrl.
  assert.equal(M.safeHttpUrl('https://ghe.corp.example/acme/w', 'https://ghe.corp.example'), 'https://ghe.corp.example/acme/w');
  assert.equal(M.safeHttpUrl('https://github.com/acme/w', 'https://ghe.corp.example'), null);
});

// ---------------------------------------------------------------------------
// URLs: stepUrl / jobUrl / stepLink fallbacks
// ---------------------------------------------------------------------------

test('jobUrl and stepUrl fall back from stored html_url to URLs built from validated integers', () => {
  const ctx = { serverUrl: 'https://github.com', repository: 'acme/widgets' };
  const run = { id: 501, htmlUrl: 'https://github.com/acme/widgets/actions/runs/501' };
  const jobWithUrl = { id: 91, htmlUrl: 'https://github.com/acme/widgets/actions/runs/501/job/91' };
  const jobBadUrl = { id: 92, htmlUrl: 'http://github.com/x' };
  assert.equal(M.stepUrl(run, jobWithUrl, 6, ctx), 'https://github.com/acme/widgets/actions/runs/501/job/91#step:6:1');
  assert.equal(M.stepUrl(run, jobWithUrl, null, ctx), 'https://github.com/acme/widgets/actions/runs/501/job/91');
  assert.equal(M.jobUrl(run, jobBadUrl, ctx), 'https://github.com/acme/widgets/actions/runs/501/job/92', 'unsafe html_url is replaced by a built URL');
  const runBadUrl = { id: 501, htmlUrl: 'https://evil.com/run' };
  assert.equal(M.jobUrl(runBadUrl, { id: 92 }, ctx), 'https://github.com/acme/widgets/actions/runs/501/job/92');
  assert.equal(M.jobUrl(runBadUrl, { id: 92 }, {}), null, 'nothing safe known → null');
  assert.equal(M.stepUrl(run, { id: 'x' }, 3, {}), null, 'an invalid job id and no stored job URL → no step link (never a run-level "#step" anchor)');
  assert.equal(M.stepUrl(run, null, 3, ctx), null);
  assert.equal(M.githubRunUrl(ctx, '000'), null, 'run id must be a positive integer');
  assert.equal(M.githubRunUrl(ctx, '42'), 'https://github.com/acme/widgets/actions/runs/42');
  assert.equal(M.githubRunUrl({ serverUrl: 'https://github.com', repository: 'acme/../x' }, 42), null, 'repository is validated');
});

test('stepLink degrades step → job → run and names the resolution in the tooltip', () => {
  const model = M.normalize(rawHistory());
  const run = model.byId['501'];
  const ctx = model.ctx;
  const step = M.stepLink(run, run.mvnLens[0], ctx);
  assert.equal(step.kind, 'step');
  assert.equal(step.href, 'https://github.com/acme/widgets/actions/runs/501/job/91#step:4:1');
  assert.match(step.title, /attributed by jobId/);
  // Stale job id (not part of the latest attempt) but a step number: link degrades to the built job URL.
  const stale = M.stepLink(run, run.mvnLens[1], ctx);
  assert.equal(stale.kind, 'step');
  assert.equal(stale.href, 'https://github.com/acme/widgets/actions/runs/501/job/80#step:4:1');
  // Job known, no step number.
  const jobOnly = M.stepLink(run, { jobId: 91, attribution: 'jobId/job-only' }, ctx);
  assert.equal(jobOnly.kind, 'job');
  assert.equal(jobOnly.label, 'GitHub job ↗');
  assert.match(jobOnly.title, /Step unknown/);
  // Nothing attributed: the run page.
  const none = M.stepLink(run, run.mvnLens[2], ctx);
  assert.equal(none.kind, 'run');
  assert.equal(none.href, 'https://github.com/acme/widgets/actions/runs/501');
  assert.match(none.title, /attribution: none/);
  // No safe URL anywhere.
  assert.equal(M.stepLink({ id: null, jobs: [] }, { jobId: null }, {}), null);
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

test('normalize adds ms fields, indexes runs and re-validates report paths', () => {
  const model = M.normalize(rawHistory());
  assert.equal(model.runs.length, 3);
  assert.equal(model.runs[0].id, 600, 'newest first');
  const run = model.byId['501'];
  assert.ok(run.createdMs > 0);
  assert.ok(run.jobs[0].startedMs > 0);
  assert.ok(run.jobs[0].steps[0].completedMs > 0);
  assert.equal(run.mvnLens[0].reports[0].path, 'reports/501/j91-s4/report.html');
  assert.equal(run.mvnLens[2].reports[0].path, null, 'traversal path is nulled');
  assert.equal(model.repository, 'acme/widgets');
  assert.equal(model.repositoryUrl, 'https://github.com/acme/widgets');
  assert.equal(model.defaultBranch, 'main');
  assert.equal(model.stats.reportsCount, 3);
  assert.equal(model.isSingleBranch, false);
  assert.ok(model.series.length >= 1);
});

test('normalize survives hostile or empty input', () => {
  assert.deepEqual(M.normalize(null).runs, []);
  assert.deepEqual(M.normalize('junk').runs, []);
  assert.deepEqual(M.normalize({ runs: 'nope', workflows: [] }).runs, []);
  const m = M.normalize({ repository: 'acme/../evil', serverUrl: 'javascript:x', runs: [{ id: 1, createdAt: 'not a date', jobs: null, mvnLens: [{ reports: [{ path: 'reports/1/a/b.html\\..' }] }] }] });
  assert.equal(m.repository, null, 'invalid repository dropped');
  assert.equal(m.serverUrl, 'https://github.com', 'invalid serverUrl falls back to github.com');
  assert.equal(m.runs[0].mvnLens[0].reports[0].path, null);
  const ghes = M.normalize({ serverUrl: 'https://ghe.corp.example/' });
  assert.equal(ghes.serverUrl, 'https://ghe.corp.example', 'trailing slash trimmed');
});

test('normalizeSummary keeps the known keys with coerced types and drops anything else', () => {
  const s = M.normalizeSummary({ goals: 'clean verify', totalMs: { ms: 5 }, wallMs: 1000, status: ['FAILED'], jdkVersion: 25, threads: '4', environment: ['nope'], extra: 'dropped' });
  assert.deepEqual(s.goals, [], 'a string is not a goal list');
  assert.equal(s.totalMs, null, 'an object is not a duration');
  assert.equal(s.wallMs, 1000);
  assert.equal(s.status, null, 'an array is not a status');
  assert.equal(s.jdkVersion, '25', 'a number becomes its string');
  assert.equal(s.threads, null, 'a numeric string is not a number');
  assert.equal(s.environment, null, 'an array is not an environment');
  assert.equal(s.extra, undefined, 'unknown keys are dropped');
  assert.deepEqual(M.normalizeSummary({ goals: ['clean', 'verify', { x: 1 }, null] }).goals, ['clean', 'verify']);
  assert.equal(M.normalizeSummary({ goals: new Array(200).fill('x') }).goals.length, 50, 'the goal list is capped');
  assert.equal(M.normalizeSummary(null), null);
  assert.equal(M.normalizeSummary([1, 2]), null);
  assert.equal(M.normalizeSummary('OK'), null);
  const env = M.normalizeSummary({ environment: { mvnd: true, availableProcessors: 8, osName: 'Linux', junk: { a: 1 } } }).environment;
  assert.deepEqual(env, { availableProcessors: 8, cpuCores: null, cpuThreads: null, memoryBytes: null, osName: 'Linux', jvmName: null, jvmVendor: null, mvnd: true, githubActions: null, c2DisabledBy: null });
});

test('a crafted summary in the history never makes the model throw', () => {
  const raw = rawHistory();
  raw.runs[0].mvnLens[0].reports[0].summary = { goals: 'clean verify', totalMs: { n: 1 }, environment: ['x'], status: 'OK', startedAt: 'yesterday' };
  const model = M.normalize(raw);
  const run = model.byId['501'];
  assert.deepEqual(run.mvnLens[0].summary.goals, []);
  assert.equal(run.mvnLens[0].summary.totalMs, null);
  assert.equal(run.mvnLens[0].summary.startedAt, null);
  assert.doesNotThrow(() => M.runMatchesText(run, 'clean'), 'the text search reads summary.goals');
  assert.equal(M.applyFilters(model.runs, { range: 'all', text: 'clean' }, NOW).length, 0);
  assert.doesNotThrow(() => M.reportRows(model.runs, { maven: 'ok' }));
  assert.ok(M.seriesOf(model.runs).length >= 1);
});

test('report path re-validation agrees with src/history.isValidReportPath', () => {
  const cases = [
    'reports/501/j91-s4/report.html',
    'reports/1/a/b',
    'reports/501/j91-s4/../report.html',
    '../reports/501/a/b',
    'reports/501/a',
    'reports/501/a/b/c',
    'reports/abc/a/b',
    'reports/501/' + 'a'.repeat(121) + '/b',
    'reports/501/.hidden/report.html',
    'reports/501\\a\\b',
    '/reports/501/a/b',
    'reports/501/a/report.html?x=1',
    'reports/501/a/report.html#frag',
    'other/501/a/b',
  ];
  for (const p of cases) {
    assert.equal(M.isValidReportPath(p), history.isValidReportPath(p), p);
  }
  assert.equal(M.isValidReportPath('reports/501/j91-s4/report.html'), true);
  assert.equal(M.isValidReportPath('reports/501/j91-s4/../report.html'), false);
});

test('mavenSeriesKey matches src/history.mavenSeriesKey', () => {
  assert.equal(M.mavenSeriesKey('.github/workflows/ci.yml', 'build', 'Build with Maven', null),
    history.mavenSeriesKey('.github/workflows/ci.yml', 'build', 'Build with Maven', null));
  assert.equal(M.mavenSeriesKey(null, null, null, 'x'), history.mavenSeriesKey(null, null, null, 'x'));
});

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

test('seriesOf groups by workflow+job+step+label and hides superseded entries', () => {
  const model = M.normalize(rawHistory());
  const series = M.seriesOf(model.runs);
  const main = series.find(s => s.jobName === 'build' && s.stepName === 'Build with Maven' && !s.label);
  assert.ok(main, 'main series exists');
  assert.equal(main.points.length, 2, 'run 501 (attempt 2 entry) + run 400 — the superseded attempt-1 entry is hidden');
  assert.ok(main.points.every(p => !p.entry.superseded));
  assert.equal(main.points[0].run.id, 501, 'points newest first');
  const sidecar = series.find(s => s.label === 'sidecar');
  assert.ok(sidecar, 'unattributed entry forms its own series');
  // A run whose only entry is superseded contributes no series point.
  const only = M.seriesOf([{ workflowPath: 'w', mvnLens: [{ superseded: true, reports: [], key: 'x' }], createdMs: 1, id: 1 }]);
  assert.equal(only.length, 0);
});

test('reportRows flattens entries, honours showSuperseded / series / maven filters', () => {
  const model = M.normalize(rawHistory());
  const rows = M.reportRows(model.runs);
  assert.equal(rows.length, 3, 'superseded hidden by default');
  const all = M.reportRows(model.runs, { showSuperseded: true });
  assert.equal(all.length, 4);
  const key = M.mavenSeriesKey('.github/workflows/ci.yml', 'build', 'Build with Maven', null);
  assert.equal(M.reportRows(model.runs, { series: key }).length, 2);
  assert.equal(M.reportRows(model.runs, { maven: 'failed' }).length, 1);
  assert.equal(M.reportRows(model.runs, { maven: 'ok' }).length, 2);
});

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

test('applyFilters: range, branch, event, status, text', () => {
  const model = M.normalize(rawHistory());
  const runs = model.runs;
  assert.equal(M.applyFilters(runs, { range: '7d' }, NOW).length, 2, '40-day-old run outside 7d');
  assert.equal(M.applyFilters(runs, { range: '90d' }, NOW).length, 3);
  assert.equal(M.applyFilters(runs, { range: 'all' }, NOW).length, 3);
  assert.equal(M.applyFilters(runs, { range: 'all', branch: 'main' }, NOW).length, 2);
  assert.equal(M.applyFilters(runs, { range: 'all', branch: 'feature/x' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', event: 'pull_request' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', status: 'success' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', status: 'failure' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', status: 'running' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', status: 'completed' }, NOW).length, 2);
  assert.equal(M.applyFilters(runs, { range: 'all', workflow: '1' }, NOW).length, 3);
  assert.equal(M.applyFilters(runs, { range: 'all', workflow: '99' }, NOW).length, 0);
  // Text search: title, branch, actor, step names, mvn-lens fields; case-insensitive.
  assert.equal(M.applyFilters(runs, { range: 'all', text: 'flaky' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', text: 'INTEGRATION TESTS' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', text: 'hubot' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', text: 'sidecar' }, NOW).length, 1);
  assert.equal(M.applyFilters(runs, { range: 'all', text: 'no-such-thing' }, NOW).length, 0);
  assert.equal(M.applyFilters(runs, { range: 'all', text: '  ' }, NOW).length, 3, 'blank text matches everything');
});

test('defaultFilters and sanitizeFilters keep only values that exist in the dataset', () => {
  const model = M.normalize(rawHistory());
  const def = M.defaultFilters(model);
  assert.equal(def.range, '90d');
  assert.equal(def.branch, 'main', 'default branch preselected when it has runs');
  const f = M.sanitizeFilters({ range: '7d', branch: 'feature/x', event: 'push', status: 'success', workflow: '1' }, model);
  assert.deepEqual([f.range, f.branch, f.event, f.status, f.workflow], ['7d', 'feature/x', 'push', 'success', '1']);
  const stale = M.sanitizeFilters({ range: 'bogus', branch: 'gone-branch', event: 'nope', status: 'weird', workflow: '9' }, model);
  assert.equal(stale.range, '90d');
  assert.equal(stale.branch, 'main', 'stale branch falls back to the default');
  assert.equal(stale.event, '');
  assert.equal(stale.status, '');
  assert.equal(stale.workflow, '');
  assert.deepEqual(M.sanitizeFilters('garbage', model).range, '90d');
});

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

test('constantColumns finds columns with a single distinct value (needs at least 2 rows)', () => {
  const rows = [{ a: 'x', b: '1' }, { a: 'x', b: '2' }];
  const getters = { a: r => r.a, b: r => r.b };
  assert.deepEqual(M.constantColumns(rows, getters), ['a']);
  assert.deepEqual(M.constantColumns(rows.slice(0, 1), getters), []);
  assert.deepEqual(M.constantColumns([], getters), []);
});

test('mavenStatus: OK/SUCCESS is ok, FAIL/ERROR is failed, anything else (mvn-lens "UNKNOWN") is unknown', () => {
  for (const s of ['OK', 'ok', 'SUCCESS', 'Success']) assert.equal(M.mavenStatus({ status: s }), 'ok', s);
  for (const s of ['FAILED', 'failure', 'BUILD FAILURE', 'ERROR', 'internal_error']) assert.equal(M.mavenStatus({ status: s }), 'failed', s);
  // mvn-lens sets UNKNOWN when the session never ended (a cancelled job): not a failure.
  for (const s of ['UNKNOWN', 'CANCELLED', 'weird', '']) assert.equal(M.mavenStatus({ status: s }), 'unknown', JSON.stringify(s));
  assert.equal(M.mavenStatus({}), 'unknown');
  assert.equal(M.mavenStatus(null), 'unknown');
});

test('the Maven filter counts an UNKNOWN status as neither ok nor failed', () => {
  const raw = rawHistory();
  raw.runs[0].mvnLens[0].reports[0].summary.status = 'UNKNOWN';
  const model = M.normalize(raw);
  assert.equal(M.reportRows(model.runs).find(r => r.entry.key === 'j91-s4').mavenStatus, 'unknown');
  assert.equal(M.reportRows(model.runs, { maven: 'failed' }).length, 1, 'only the genuinely failed report');
  assert.equal(M.reportRows(model.runs, { maven: 'ok' }).length, 1);
  assert.equal(M.reportRows(model.runs).length, 3, 'unfiltered rows are unaffected');
});

test('state helpers', () => {
  assert.equal(M.mavenStatus({ status: 'OK' }), 'ok');
  assert.equal(M.mavenStatus({ status: 'FAILED' }), 'failed');
  assert.equal(M.mavenStatus(null), 'unknown');
  assert.equal(M.runState({ status: 'completed', conclusion: 'failure' }), 'failure');
  assert.equal(M.runState({ status: 'in_progress' }), 'running');
  assert.equal(M.jobState({ status: 'queued' }), 'queued');
  assert.equal(M.stateClass('in_progress'), 'running');
  assert.equal(M.stateClass('<junk>'), 'neutral');
});

test('formatMs / formatBytes edge cases', () => {
  assert.equal(M.formatMs(null), '—');
  assert.equal(M.formatMs(950), '950 ms');
  assert.equal(M.formatMs(59500), '59.5 s');
  assert.equal(M.formatMs(119600), '2m 00s', 'rounds before splitting minutes');
  assert.equal(M.formatMs(3661000), '1h 01m');
  assert.equal(M.formatBytes(2900000), '2.8 MB');
  assert.equal(M.formatBytes(0), '0 B');
  assert.equal(M.formatBytes('x'), '0 B');
});

test('workflowUrl and commitUrl build only from validated pieces', () => {
  const ctx = { serverUrl: 'https://github.com', repository: 'acme/widgets' };
  assert.equal(M.workflowUrl(ctx, '.github/workflows/build-monitor.yml'), 'https://github.com/acme/widgets/actions/workflows/build-monitor.yml');
  assert.equal(M.workflowUrl(ctx, null), 'https://github.com/acme/widgets/actions', 'unknown file → Actions tab');
  assert.equal(M.workflowUrl(ctx, 'a/b/<evil>.yml'), 'https://github.com/acme/widgets/actions', 'bad file name → Actions tab');
  assert.equal(M.workflowUrl({}, 'ci.yml'), null);
  assert.equal(M.commitUrl({ sha: 'a'.repeat(40) }, ctx), 'https://github.com/acme/widgets/commit/' + 'a'.repeat(40));
  assert.equal(M.commitUrl({ sha: '../evil' }, ctx), null);
});
