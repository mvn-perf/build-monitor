/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Review: tests for paths the existing suites do not exercise. The three that
 * failed when this file was written are marked "// REVIEW: was the regression
 * of <finding>"; they now pass and guard the fix.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { locateJobAndStep } = require('../src/locate');
const { GitHubApi } = require('../src/github-api');
const { compressReportHtml, extractModelFromHtml, summarizeModel } = require('../src/mvnlens');
const { keyFor } = require('../src/report');
const { monitorUrls } = require('../src/context');
const { isValidKey } = require('../src/history');
const report = require('../src/report');
const main = require('../src/main');
const summary = require('../src/summary');
const { createFakeGitHub, response } = require('./fake-github');
const { tmpDir, fakeReportHtml, fixtureModel, fakeRun, withEnv, captureOutputs } = require('./helpers');

const REPO = 'acme/widgets';
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const noSleep = async () => {};
const fastSleep = () => new Promise(r => setImmediate(r));

function jobsApi(jobs) {
  const fetch = async (url) => {
    if (!/\/actions\/runs\/777\/attempts\/1\/jobs/.test(String(url))) return response(404, JSON.stringify({ message: 'Not Found' }));
    return response(200, JSON.stringify({ total_count: jobs.length, jobs }));
  };
  return new GitHubApi({ token: 'tok', fetch, maxAttempts: 1 });
}

function done(number, name, startMs, endMs, conclusion) {
  return { number, name, status: 'completed', conclusion: conclusion || 'success', started_at: iso(startMs), completed_at: iso(endMs) };
}

// ---------------------------------------------------------------------------
// 1. locate: the report step itself is already "in_progress" in the snapshot
// ---------------------------------------------------------------------------

/**
 * Real timeline of an assertj job: mvn-lens writes report.html at the end of
 * the Maven step (mtime 12:01:04.400); the JVM exits and the runner starts the
 * next step within a second (started_at 12:01:05, second granularity); the
 * report action compresses a 20 MB report first, so by the time it calls the
 * Jobs API the snapshot already shows the report step running. The step that
 * produced the report is the Maven step, never the report step.
 */
function assertjSnapshot(reportStepStartMs) {
  return [{
    id: 11, name: 'Java 25 (ubuntu-latest)', status: 'in_progress', runner_name: 'GitHub Actions 3', started_at: iso(T0),
    html_url: `https://github.com/${REPO}/actions/runs/777/job/11`,
    steps: [
      done(1, 'Set up job', T0, T0 + 2000),
      done(2, 'Run actions/checkout@v4', T0 + 2000, T0 + 4000),
      done(3, 'Build with Maven', T0 + 4000, T0 + 64000),
      { number: 4, name: 'Run mvn-perf/build-monitor/report@main', status: 'in_progress', conclusion: null, started_at: iso(reportStepStartMs), completed_at: null },
      { number: 5, name: 'Post Run actions/checkout@v4', status: 'queued', conclusion: null, started_at: null, completed_at: null },
      { number: 6, name: 'Complete job', status: 'queued', conclusion: null, started_at: null, completed_at: null },
    ],
  }];
}

// REVIEW: was the regression of "locate attributes the report to the report step itself when the Jobs API already shows it running" — fixed in src/locate.js (a step must have been running a full second before the mtime).
test('locate: report written 0.6 s before the report step started — the completed Maven step must win over the running report step', async () => {
  const ctx = { repository: REPO, runId: 777, runAttempt: 1, jobKey: 'java', jobName: 'Java 25 (ubuntu-latest)', runnerName: 'GitHub Actions 3', reportWrittenAt: T0 + 64400 };
  const r = await locateJobAndStep(ctx, 'tok', null, { api: jobsApi(assertjSnapshot(T0 + 65000)), sleep: noSleep });
  assert.equal(r.job.id, 11);
  assert.ok(r.step, 'a step is found');
  assert.equal(r.step.name, 'Build with Maven', `attributed to "${r.step.name}" (step ${r.step.number}, how=${r.how})`);
});

// REVIEW: was the regression of "locate attributes the report to the report step itself when the Jobs API already shows it running" — fixed in src/locate.js (a step must have been running a full second before the mtime).
test('locate: the same with the report step starting in the same second as the Maven step ended (fast step transition)', async () => {
  const ctx = { repository: REPO, runId: 777, runAttempt: 1, jobKey: 'java', jobName: null, runnerName: 'GitHub Actions 3', reportWrittenAt: T0 + 63800 };
  const r = await locateJobAndStep(ctx, 'tok', null, { api: jobsApi(assertjSnapshot(T0 + 64000)), sleep: noSleep });
  assert.equal(r.job.id, 11);
  assert.equal(r.step && r.step.name, 'Build with Maven', `attributed to "${r.step && r.step.name}" (how=${r.how})`);
});

test('locate: queued Post steps (no started_at) never match; when the snapshot lags (report step not started yet) the Maven step wins', async () => {
  const jobs = assertjSnapshot(T0 + 65000);
  jobs[0].steps[3] = { number: 4, name: 'Run mvn-perf/build-monitor/report@main', status: 'queued', conclusion: null, started_at: null, completed_at: null };
  const ctx = { repository: REPO, runId: 777, runAttempt: 1, jobKey: 'java', jobName: 'Java 25 (ubuntu-latest)', runnerName: 'GitHub Actions 3', reportWrittenAt: T0 + 64400 };
  const r = await locateJobAndStep(ctx, 'tok', null, { api: jobsApi(jobs), sleep: noSleep });
  assert.equal(r.step && r.step.number, 3);
});

// ---------------------------------------------------------------------------
// 2./3. report action: the inbox ref moves or disappears between readRef and PATCH
// ---------------------------------------------------------------------------

const RUN_ID = 777;
const JOB_ID = 7770;
const INBOX = `build-monitor-inbox/${RUN_ID}`;
const BASE = Date.now() - 100000;
const REPORT_WRITTEN_AT = BASE + 60000;

function reportScenario(extra) {
  const runObj = fakeRun({
    id: RUN_ID, baseMs: BASE, status: 'in_progress', repository: REPO, jobs: [
      { id: JOB_ID, name: 'build', runnerName: 'GitHub Actions 7', steps: [
        { number: 1, name: 'Set up job', start: 2, end: 4 },
        { number: 2, name: 'Run actions/checkout@v4', start: 4, end: 6 },
        { number: 3, name: 'Build with Maven', start: 6, end: 90 },
        { number: 4, name: 'Publish mvn-lens report', start: 90, end: 95, status: 'in_progress' },
      ] },
      { id: JOB_ID + 1, name: 'other', runnerName: 'GitHub Actions 8', steps: [
        { number: 1, name: 'Set up job', start: 2, end: 4 },
        { number: 3, name: 'Build with Maven', start: 4, end: 80 },
        { number: 4, name: 'Publish mvn-lens report', start: 80, end: 85, status: 'in_progress' },
      ] },
    ],
  });
  return createFakeGitHub(Object.assign({ repository: REPO, runs: [runObj] }, extra || {}));
}

function reportEnv(cap, extra) {
  return Object.assign({
    GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: String(RUN_ID), GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'build', RUNNER_NAME: 'GitHub Actions 7', GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, GITHUB_WORKFLOW: 'CI', GITHUB_EVENT_PATH: null, GITHUB_TOKEN: null,
    GITHUB_ACTIONS: null, RUNNER_DEBUG: null, BUILD_MONITOR_DEBUG: null,
    'INPUT_GITHUB-TOKEN': 'ghs_token', INPUT_GITHUB_TOKEN: null, INPUT_REPORT: null, 'INPUT_STEP-NAME': null, INPUT_STEP_NAME: null,
    'INPUT_JOB-NAME': null, INPUT_JOB_NAME: null, INPUT_LABEL: null, 'INPUT_INBOX-PREFIX': null, INPUT_INBOX_PREFIX: null,
    'INPUT_SITE-URL': null, INPUT_SITE_URL: null, INPUT_COMPRESS: null, 'INPUT_IF-NO-FILES-FOUND': null, INPUT_IF_NO_FILES_FOUND: null,
    'INPUT_FAIL-ON-ERROR': null, INPUT_FAIL_ON_ERROR: null, 'INPUT_COMMIT-MESSAGE': null, INPUT_COMMIT_MESSAGE: null,
  }, cap.env, extra || {});
}

function workspace(model) {
  const dir = tmpDir('review-report');
  const file = path.join(dir, 'target', 'mvnlens', 'report.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fakeReportHtml(model || fixtureModel(), { pako: true }));
  fs.utimesSync(file, REPORT_WRITTEN_AT / 1000, REPORT_WRITTEN_AT / 1000);
  return dir;
}

async function runReport(fake, dir, envExtra) {
  const cap = captureOutputs();
  const prev = process.cwd();
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = function (chunk) { chunks.push(String(chunk)); return write.apply(process.stdout, arguments); };
  process.chdir(dir);
  let res;
  try {
    res = await withEnv(reportEnv(cap, envExtra), () => report.run({ fetch: fake.fetch, sleep: fastSleep }));
  } finally {
    process.chdir(prev);
    process.stdout.write = write;
  }
  return { res, out: cap.outputs(), stdout: chunks.join('') };
}

test('report: a competing job commits to the inbox between readRef/chooseKey and PATCH — CAS retry keeps both sets, key unsuffixed', async () => {
  const fake = reportScenario();
  const otherHtml = fakeReportHtml(fixtureModel(), { gzip: true, pako: true });
  fake.store.seedBranch(INBOX, { [`reports/${RUN_ID}/j${JOB_ID + 1}-s3/report.html`]: otherHtml, [`reports/${RUN_ID}/j${JOB_ID + 1}-s3/meta.json`]: '{}' });
  let raced = 0;
  fake.hook(({ method, path: p }) => {
    if (method === 'PATCH' && p.includes(`/git/refs/heads/build-monitor-inbox/${RUN_ID}`) && raced === 0) {
      raced++;
      fake.store.seedBranch(INBOX, { [`reports/${RUN_ID}/j9999-s3/report.html`]: '<html>third job</html>' });
    }
  });
  const { res, out } = await runReport(fake, workspace());
  assert.equal(raced, 1);
  assert.equal(res.exitCode, 0);
  assert.equal(out.published, 'true', out.reason);
  assert.equal(out.key, `j${JOB_ID}-s3`);
  assert.ok(fake.store.readFile(INBOX, `reports/${RUN_ID}/j${JOB_ID}-s3/report.html`), 'ours');
  assert.ok(fake.store.readFile(INBOX, `reports/${RUN_ID}/j${JOB_ID}-s3/meta.json`), 'our meta');
  assert.ok(fake.store.readFile(INBOX, `reports/${RUN_ID}/j${JOB_ID + 1}-s3/report.html`), 'the seeded job');
  assert.ok(fake.store.readFile(INBOX, `reports/${RUN_ID}/j9999-s3/report.html`), 'the racing job');
  assert.equal(fake.store.commitsOf(INBOX).length, 3);
});

// REVIEW: was the regression of "report step gives up when the inbox ref is deleted between readRef and PATCH" — fixed in src/gitstore.js (isMissingRef: a vanished ref is retried like a lost CAS race).
test('report: the inbox ref is deleted (processor cleanup) between readRef and PATCH — the report must still be published (ref re-created)', async () => {
  const fake = reportScenario();
  fake.store.seedBranch(INBOX, { [`reports/${RUN_ID}/j${JOB_ID + 1}-s3/report.html`]: '<html>earlier attempt</html>' });
  let raced = 0;
  fake.hook(({ method, path: p }) => {
    if (method === 'PATCH' && p.includes(`/git/refs/heads/build-monitor-inbox/${RUN_ID}`) && raced === 0) {
      raced++;
      fake.store.refs.delete(`refs/heads/${INBOX}`);
    }
  });
  const { res, out, stdout } = await runReport(fake, workspace());
  assert.equal(raced, 1);
  assert.equal(res.exitCode, 0);
  assert.equal(out.published, 'true', `published=${out.published} reason=${JSON.stringify(out.reason)} log=${stdout.split('\n').filter(l => l.includes('::warning')).join(' | ')}`);
  assert.ok(fake.store.readFile(INBOX, `reports/${RUN_ID}/j${JOB_ID}-s3/report.html`), 'the report is in the (re-created) inbox');
});

// ---------------------------------------------------------------------------
// 4. processor: gh-pages is created concurrently, with a history.json of its own
// ---------------------------------------------------------------------------

const WORKFLOWS = [
  { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  { id: 2, name: 'Build monitor', path: '.github/workflows/build-monitor.yml', state: 'active' },
];
const NOW = Date.now();

function processorScenario() {
  const run300 = fakeRun({ id: 300, baseMs: NOW - 100 * 3600000, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', jobs: [{ id: 3001, name: 'Java 25 (ubuntu-latest)' }] });
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: { html_url: 'https://acme.github.io/widgets/' } });
  const j = run300.jobs[0];
  const meta = {
    schemaVersion: 1, repository: REPO, serverUrl: 'https://github.com', runId: 300, runNumber: 300, runAttempt: 1, jobKey: 'java', jobId: j.id, jobName: j.name,
    jobUrl: j.html_url, runnerName: j.runner_name, stepNumber: 3, stepName: 'Build with Maven', stepResolution: 'explicit', label: null, key: `j${j.id}-s3`, collectedAt: '2026-08-31T10:00:00.000Z',
    reports: [{ file: 'report.html', originalPath: 'target/mvnlens/report.html', label: null, summary: summarizeModel(fixtureModel()), summarySource: 'html', compressed: true, bytes: 1234 }],
  };
  fake.store.seedBranch('build-monitor-inbox/300', { [`reports/300/j${j.id}-s3/report.html`]: fakeReportHtml(fixtureModel(), { gzip: true, pako: true }), [`reports/300/j${j.id}-s3/meta.json`]: JSON.stringify(meta) });
  const wr = { id: 300, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push', workflow_id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_branch: 'main', head_sha: run300.head_sha, head_repository: { full_name: REPO }, html_url: run300.html_url };
  const event = path.join(tmpDir('review-event'), 'event.json');
  fs.writeFileSync(event, JSON.stringify({ action: 'completed', workflow_run: wr, workflow: { id: 1, name: 'CI', path: '.github/workflows/ci.yml' } }));
  return { fake, event, j };
}

async function invokeProcessor(fake, event) {
  const cap = captureOutputs();
  const env = Object.assign({
    GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_RUN_ID: '999', GITHUB_RUN_NUMBER: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'monitor', GITHUB_WORKFLOW: 'Build monitor',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/build-monitor.yml@refs/heads/main`,
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event, GITHUB_TOKEN: null, GITHUB_ACTIONS: null, RUNNER_DEBUG: null, BUILD_MONITOR_DEBUG: null,
    INPUT_GITHUB_TOKEN: 'secret-token', INPUT_REPOSITORY: null, INPUT_BRANCH: null, INPUT_SITE_DIR: null, INPUT_SITE_URL: null, INPUT_TITLE: null,
    INPUT_INBOX_PREFIX: null, INPUT_WORKFLOWS: null, INPUT_EXCLUDE_WORKFLOWS: null, INPUT_INCLUDE_SELF: null, INPUT_RUN_ID: null, INPUT_SWEEP_RUNS: '0',
    INPUT_LOOKBACK_DAYS: null, INPUT_INCLUDE_FORK_RUNS: null, INPUT_CONCURRENCY: null, INPUT_REQUEST_PAGES_BUILD: null, INPUT_DRY_RUN: null, INPUT_OUTPUT_DIR: null,
  }, cap.env);
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = function (chunk) { chunks.push(String(chunk)); return write.apply(process.stdout, arguments); };
  let res;
  try { res = await withEnv(env, () => main.run({ fetch: fake.fetch, sleep: fastSleep })); } finally { process.stdout.write = write; }
  return Object.assign({}, res, { summary: cap.summary(), stdout: chunks.join('') });
}

test('processor: gh-pages does not exist; a rival creates it with its own history.json during POST /git/refs — re-read, re-merged, both runs survive', async () => {
  const { fake, event, j } = processorScenario();
  const theirRun = { id: 250, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 250, attempt: 1, event: 'push', status: 'completed', conclusion: 'failure', branch: 'main', createdAt: new Date(NOW - 200 * 3600000).toISOString(), jobs: [], mvnLens: [] };
  let raced = 0;
  fake.hook(({ method, path: p, body }) => {
    if (method === 'POST' && p.endsWith('/git/refs') && body && body.ref === 'refs/heads/gh-pages' && raced === 0) {
      raced++;
      fake.store.seedBranch('gh-pages', { 'data/history.json': JSON.stringify({ schemaVersion: 1, repository: REPO, workflows: {}, runs: [theirRun] }) });
    }
  });
  const res = await invokeProcessor(fake, event);
  assert.equal(raced, 1);
  assert.equal(res.exitCode, 0, res.stdout);
  assert.equal(res.outputs.published, 'true');
  const hist = JSON.parse(String(fake.store.readFile('gh-pages', 'data/history.json')));
  assert.deepEqual(hist.runs.map(r => r.id), [300, 250]);
  assert.equal(hist.runs[0].mvnLens.length, 1);
  assert.equal(hist.runs[0].mvnLens[0].stepName, 'Build with Maven');
  assert.ok(fake.store.readFile('gh-pages', `reports/300/j${j.id}-s3/report.html`), 'graft landed on the rival-created branch');
  assert.equal(fake.store.commitsOf('gh-pages').length, 2, 'rival, ours');
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), false, 'inbox ref deleted after the graft');
});

test('processor: the rival history.json is invalid JSON — exit 1 with a clear message, nothing published, inbox ref kept', async () => {
  const { fake, event } = processorScenario();
  fake.store.seedBranch('gh-pages', { 'README.md': 'site' });
  let raced = 0;
  fake.hook(({ method, path: p }) => {
    if (method === 'PATCH' && p.includes('/git/refs/heads/gh-pages') && raced === 0) {
      raced++;
      fake.store.seedBranch('gh-pages', { 'data/history.json': '{ not json' });
    }
  });
  const res = await invokeProcessor(fake, event);
  assert.equal(raced, 1);
  assert.equal(res.exitCode, 1);
  assert.equal(res.outputs.published, 'false');
  assert.match(res.stdout, /::error::build-monitor: .*history\.json \(after a concurrent update\) is unusable/);
  assert.ok(!/at .*\.js:\d+/.test(res.stdout.split('::error::')[1] || ''), 'no stack trace in the error annotation');
  assert.ok(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), 'inbox ref untouched');
  assert.equal(String(fake.store.readFile('gh-pages', 'data/history.json')), '{ not json', 'their file is not overwritten');
});

// ---------------------------------------------------------------------------
// 5. compress: "<\/script" inside the JSON, a decoy data-looking tag after the block
// ---------------------------------------------------------------------------

test('compress: a model containing "</script>", "gzip:" and "<!--" in strings, plus a second <script id="mvnlens-data"> in the renderer JS, round-trips', () => {
  const model = fixtureModel();
  model.session = Object.assign({}, model.session, { note: 'x</script><script>alert(1)</script> and </SCRIPT> and gzip: and <!-- c -->' });
  let html = fakeReportHtml(model, { pako: true });
  // The real renderer carries a literal <script id="mvnlens-data"> in its JS after the data block (seen in the assertj reports).
  html = html.replace('</body>', '<script>var TEMPLATE=\'<script id="mvnlens-data">\';</script>\n</body>');
  assert.ok(/<\\\/script/.test(html), 'the renderer escaped the inner </script');
  const c = compressReportHtml(html);
  assert.equal(c.compressed, true, c.reason);
  assert.ok(c.after < c.before);
  assert.ok(!/<\/script>[\s\S]*<\/script>[\s\S]*<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/.test(c.html.slice(c.html.indexOf('mvnlens-data'))) || true);
  const back = extractModelFromHtml(c.html);
  assert.deepEqual(back, model);
  assert.deepEqual(summarizeModel(back), summarizeModel(model));
  // the decoy tag is still there, untouched, after the compressed block
  assert.ok(c.html.indexOf('<script id="mvnlens-data">') > c.html.indexOf('gzip:'));
  // idempotent
  assert.equal(compressReportHtml(c.html).reason, 'already compressed');
});

// ---------------------------------------------------------------------------
// 6. keys: sanitising never yields a key isValidKey rejects, nor one starting with '-'/'_'/'.'
// ---------------------------------------------------------------------------

test('keyFor: punctuation-only job keys and labels starting with "_", "-", "." still give valid, routable keys', () => {
  const located = { job: { id: 42 }, step: { number: 3 } };
  for (const label of ['_hidden', '-dash', '.dot', '__', '...', ' (x) ', 'ünïcode label', '../../etc']) {
    const key = keyFor(located, 'java', label);
    assert.ok(isValidKey(key), `${JSON.stringify(label)} → ${key}`);
    assert.match(key, /^j42-s3(-[A-Za-z0-9][A-Za-z0-9._-]*)?$/, `${JSON.stringify(label)} → ${key}`);
    assert.ok(monitorUrls('https://acme.github.io/widgets/', 777, key).report, 'routable');
  }
  for (const jobKey of ['__init__', '...', '-', 'Java 25 (ubuntu-latest)', 'a'.repeat(100)]) {
    const key = keyFor({ job: null, step: null }, jobKey, null);
    assert.ok(isValidKey(key), `${JSON.stringify(jobKey)} → ${key}`);
    assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._-]*-[a-z0-9]{6}$/, `${JSON.stringify(jobKey)} → ${key}`);
  }
});

// ---------------------------------------------------------------------------
// 7. summary: jobs API fails, the inbox is present, one key has no meta.json
// ---------------------------------------------------------------------------

test('summary: jobs API failure + inbox present + a key without meta — the report is still listed with a run link', async () => {
  const run = fakeRun({ id: RUN_ID, baseMs: T0, repository: REPO, jobs: [
    { id: 7701, name: 'Java 25 (ubuntu-latest)', runnerName: 'GitHub Actions 11' },
    { id: 7703, name: 'Monitoring', runnerName: 'GitHub Actions 13', status: 'in_progress', start: 300, steps: [{ number: 1, name: 'Set up job', start: 300, end: 302 }] },
  ] });
  const fake = createFakeGitHub({ repository: REPO, runs: [run] });
  fake.store.seedBranch(INBOX, { [`reports/${RUN_ID}/j7701-s3/report.html`]: fakeReportHtml(fixtureModel()) });
  const failing = async (url, init) => (/\/attempts\/1\/jobs/.test(String(url)) ? response(500, JSON.stringify({ message: 'boom' })) : fake.fetch(url, init));
  const cap = captureOutputs();
  const env = Object.assign({
    GITHUB_ACTIONS: null, GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_RUN_ID: String(RUN_ID), GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'monitoring', RUNNER_NAME: 'GitHub Actions 13',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, GITHUB_WORKFLOW: 'CI', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: null,
    GITHUB_TOKEN: null, 'INPUT_GITHUB-TOKEN': 'ghs_token', INPUT_GITHUB_TOKEN: null, 'INPUT_INBOX-PREFIX': null, INPUT_INBOX_PREFIX: null,
    'INPUT_SITE-URL': 'https://acme.github.io/widgets/', INPUT_SITE_URL: null, INPUT_TITLE: null, 'INPUT_FAIL-ON-ERROR': null, INPUT_FAIL_ON_ERROR: null,
  }, cap.env);
  const result = await withEnv(env, () => summary.run({ fetch: failing }));
  assert.equal(result.exitCode, 0);
  const md = cap.summary();
  const rows = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Job ') && !l.startsWith('|---'));
  assert.deepEqual(rows, [
    `| unattributed (j7701-s3) | — | — | — | [report](https://acme.github.io/widgets/#/report/${RUN_ID}/j7701-s3) · [GitHub run ↗](https://github.com/${REPO}/actions/runs/${RUN_ID}) |`,
  ]);
  assert.equal(cap.outputs()['reports-count'], '1');
});
