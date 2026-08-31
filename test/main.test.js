/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * End-to-end tests of the root processor (src/main.js) against the in-memory
 * fake GitHub: workflow_run payload → graft + history, second invocation no-op,
 * sweep, superseded attempts, CAS conflict re-merge, dry run, fork policy,
 * permission failure, site-dir, and one spawn of src/index.js over HTTP.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, markSuperseded, slimSummary } = require('../src/main');
const { summarizeModel } = require('../src/mvnlens');
const { createFakeGitHub } = require('./fake-github');
const { tmpDir, fakeReportHtml, fixtureModel, fakeRun, withEnv, captureOutputs } = require('./helpers');

const REPO = 'acme/widgets';
const PAGES = { html_url: 'https://acme.github.io/widgets/' };
const SITE = 'https://acme.github.io/widgets/';
const WORKFLOWS = [
  { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  { id: 2, name: 'Build monitor', path: '.github/workflows/build-monitor.yml', state: 'active' },
];
const NOW = Date.now();
const fastSleep = () => new Promise(r => setImmediate(r));

/** A completed CI run with two jobs (ids <id>1 and <id>2), created (400 - id) hours ago. */
function ciRun(id, extra) {
  return fakeRun(Object.assign({
    id, baseMs: NOW - (400 - id) * 3600000, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml',
    jobs: [{ id: id * 10 + 1, name: 'Java 25 (ubuntu-latest)' }, { id: id * 10 + 2, name: 'Javadoc' }],
  }, extra || {}));
}

/** A run of the processor's own workflow (never monitored unless include-self). */
function selfRun(id) {
  return fakeRun({ id, baseMs: NOW - 3600000, workflowId: 2, workflowName: 'Build monitor', workflowPath: '.github/workflows/build-monitor.yml', jobs: [{ id: id * 10 + 1, name: 'monitor' }] });
}

/** The workflow_run event payload file for `run` (fields the processor reads, overridable). */
function eventFile(run, overrides) {
  const wr = Object.assign({
    id: run.id, run_attempt: run.run_attempt, status: 'completed', conclusion: run.conclusion, event: run.event,
    workflow_id: run.workflow_id, name: run.name, path: run.path, head_branch: run.head_branch, head_sha: run.head_sha,
    head_repository: { full_name: run.head_repository.full_name }, html_url: run.html_url,
  }, overrides || {});
  const file = path.join(tmpDir('event'), 'event.json');
  fs.writeFileSync(file, JSON.stringify({ action: 'completed', workflow_run: wr, workflow: { id: wr.workflow_id, name: wr.name, path: wr.path } }));
  return file;
}

/** meta.json as the report step writes it (schemaVersion 1). */
function meta(run, job, stepNumber, extra) {
  return Object.assign({
    schemaVersion: 1, repository: REPO, serverUrl: 'https://github.com', runId: run.id, runNumber: run.run_number, runAttempt: run.run_attempt,
    workflowRef: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, jobKey: 'build', jobId: job.id, jobName: job.name, jobUrl: job.html_url,
    runnerName: job.runner_name, stepNumber, stepName: 'Build with Maven', stepResolution: 'explicit', label: null, key: `j${job.id}-s${stepNumber}`,
    collectedAt: '2026-08-31T10:00:00.000Z',
    reports: [{ file: 'report.html', originalPath: 'target/mvnlens/report.html', label: null, summary: summarizeModel(fixtureModel(), { modules: true }), summarySource: 'html', compressed: true, bytes: 1234 }],
  }, extra || {});
}

/** Commits report sets to the run's inbox ref: sets = [{ key, html, meta }]. */
function seedInbox(fake, run, sets) {
  const files = {};
  for (const s of sets) {
    files[`reports/${run.id}/${s.key}/report.html`] = s.html;
    if (s.meta !== null) files[`reports/${run.id}/${s.key}/meta.json`] = JSON.stringify(s.meta || {});
  }
  return fake.store.seedBranch(`build-monitor-inbox/${run.id}`, files);
}

/** The processor's environment: a workflow_dispatch of "Build monitor" by default; null deletes a variable. */
function baseEnv(extra) {
  return Object.assign({
    GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_RUN_ID: '999', GITHUB_RUN_NUMBER: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'monitor', GITHUB_WORKFLOW: 'Build monitor',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/build-monitor.yml@refs/heads/main`,
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: null, GITHUB_TOKEN: null, GITHUB_ACTIONS: null, RUNNER_DEBUG: null, BUILD_MONITOR_DEBUG: null,
    INPUT_GITHUB_TOKEN: 'secret-token', INPUT_REPOSITORY: null, INPUT_BRANCH: null, INPUT_SITE_DIR: null, INPUT_SITE_URL: null, INPUT_TITLE: null,
    INPUT_INBOX_PREFIX: null, INPUT_WORKFLOWS: null, INPUT_EXCLUDE_WORKFLOWS: null, INPUT_INCLUDE_SELF: null, INPUT_RUN_ID: null, INPUT_SWEEP_RUNS: null,
    INPUT_LOOKBACK_DAYS: null, INPUT_INCLUDE_FORK_RUNS: null, INPUT_CONCURRENCY: null, INPUT_REQUEST_PAGES_BUILD: null, INPUT_DRY_RUN: null, INPUT_OUTPUT_DIR: null,
  }, extra || {});
}

/** Runs the processor in-process against `fake`; returns { exitCode, outputs, summary, fileOutputs, stdout }. */
async function invoke(fake, envExtra) {
  const cap = captureOutputs();
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = function (chunk) { chunks.push(String(chunk)); return write.apply(process.stdout, arguments); };
  let res;
  try {
    res = await withEnv(Object.assign(baseEnv(), cap.env, envExtra || {}), () => run({ fetch: fake.fetch, sleep: fastSleep }));
  } finally {
    process.stdout.write = write;
  }
  return Object.assign({}, res, { summary: cap.summary(), fileOutputs: cap.outputs(), stdout: chunks.join('') });
}

/**
 * Commits API-shaped tree entries to a run's inbox ref, on top of what is
 * already there. Unlike `seedInbox` this can write modes the report step never
 * writes — a symlink (120000), a sub-directory — which is exactly what the
 * processor must refuse to publish.
 */
function seedInboxTree(fake, runId, entries) {
  const ref = fake.store.refName(`build-monitor-inbox/${runId}`);
  const head = fake.store.refs.get(ref) || null;
  const treeSha = fake.store.overlayTree(head ? fake.store.commit(head).tree : null, entries);
  const sha = fake.store.putCommit({ tree: treeSha, parents: head ? [head] : [], message: 'raw inbox seed' });
  fake.store.refs.set(ref, sha);
  return sha;
}

/** The ::warning:: annotations of one invocation. */
function warningsOf(res) {
  return res.stdout.split('\n').filter(l => l.startsWith('::warning::'));
}

function historyOf(fake, branch, siteDir) {
  const buf = fake.store.readFile(branch || 'gh-pages', (siteDir ? siteDir + '/' : '') + 'data/history.json');
  assert.ok(buf, 'data/history.json is on the branch');
  return JSON.parse(String(buf));
}

function mutatingCalls(fake, from) {
  return fake.calls.slice(from || 0).filter(c => c.method !== 'GET' && c.method !== 'HEAD');
}

/** Asynchronous spawn (the fake HTTP server lives in this process: spawnSync would block it). */
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

/** Scenario: run 300 with two report sets in its inbox. */
function scenario300(extra) {
  const run300 = ciRun(300, extra && extra.run);
  const fake = createFakeGitHub(Object.assign({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: PAGES }, extra && extra.scenario));
  const html1 = fakeReportHtml(fixtureModel(), { gzip: true, pako: true });
  const html2 = fakeReportHtml(fixtureModel());
  const [j1, j2] = run300.jobs;
  seedInbox(fake, run300, [
    { key: `j${j1.id}-s3`, html: html1, meta: meta(run300, j1, 3) },
    { key: `j${j2.id}-s3`, html: html2, meta: meta(run300, j2, 3) },
  ]);
  return { fake, run300, j1, j2, html1, html2, event: eventFile(run300, extra && extra.event) };
}

// ---------------------------------------------------------------------------
// (1) + (2) workflow_run → graft + history; second invocation is a no-op
// ---------------------------------------------------------------------------

test('workflow_run: grafts the inbox into a new gh-pages, records the run, deletes the ref, requests a Pages build; a repeat is a no-op', async () => {
  const { fake, run300, j1, j2, html1, html2, event } = scenario300();
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(res.outputs['site-url'], SITE);
  assert.equal(res.outputs['runs-processed'], '1');
  assert.equal(res.outputs['runs-total'], '1');
  assert.equal(res.outputs['reports-collected'], '2');
  assert.equal(res.outputs['commit-sha'], fake.store.headOf('gh-pages'));
  assert.equal(res.outputs['reports-bytes'], String(Buffer.byteLength(html1) + Buffer.byteLength(html2)));
  assert.deepEqual(res.fileOutputs, res.outputs, 'GITHUB_OUTPUT carries the same outputs');

  // The branch: the three content files plus the grafted report trees (byte-identical, meta.json included).
  assert.deepEqual(fake.store.listDir('gh-pages', ''), ['.nojekyll', 'data', 'index.html', 'reports']);
  assert.deepEqual(fake.store.listDir('gh-pages', 'reports/300'), [`j${j1.id}-s3`, `j${j2.id}-s3`]);
  assert.ok(fake.store.readFile('gh-pages', `reports/300/j${j1.id}-s3/report.html`).equals(Buffer.from(html1, 'utf8')), 'report 1 grafted byte-identical');
  assert.equal(String(fake.store.readFile('gh-pages', `reports/300/j${j2.id}-s3/report.html`)), html2);
  assert.ok(fake.store.readFile('gh-pages', `reports/300/j${j1.id}-s3/meta.json`), 'meta.json travels with the graft');
  assert.equal(String(fake.store.readFile('gh-pages', '.nojekyll')), '');
  const index = String(fake.store.readFile('gh-pages', 'index.html'));
  assert.ok(index.includes('<title>Build monitor · acme/widgets</title>'), 'default title names the repository');
  assert.ok(index.includes('<script id="build-monitor-data" type="application/json"></script>'), 'no inline dataset');
  // Report bytes never travel: only the three content blobs were uploaded.
  assert.equal(fake.calls.filter(c => c.method === 'POST' && c.path.endsWith('/git/blobs')).length, 3);
  assert.equal(fake.store.commitsOf('gh-pages').length, 1);

  // The history.
  const hist = historyOf(fake);
  assert.equal(hist.schemaVersion, 1);
  assert.equal(hist.repository, REPO);
  assert.equal(hist.repositoryUrl, 'https://github.com/acme/widgets');
  assert.equal(hist.serverUrl, 'https://github.com');
  assert.equal(hist.defaultBranch, 'main');
  assert.equal(hist.siteUrl, SITE);
  assert.ok(Date.parse(hist.generatedAt) >= NOW - 1000);
  assert.deepEqual(hist.stats, { reportsCount: 2, reportsBytes: Buffer.byteLength(html1) + Buffer.byteLength(html2) });
  assert.deepEqual(Object.keys(hist.workflows), ['1'], 'only the triggering workflow is monitored by default');
  assert.equal(hist.runs.length, 1);
  const r = hist.runs[0];
  assert.equal(r.id, 300);
  assert.equal(r.status, 'completed');
  assert.equal(r.conclusion, 'success');
  assert.equal(r.jobs.length, 2);
  assert.equal(r.jobs[0].steps.length, 5);
  assert.equal(r.mvnLens.length, 2);
  const e1 = r.mvnLens.find(e => e.key === `j${j1.id}-s3`);
  const e2 = r.mvnLens.find(e => e.key === `j${j2.id}-s3`);
  assert.ok(e1 && e2);
  assert.equal(e1.dir, `reports/300/j${j1.id}-s3`);
  assert.equal(e1.path, `reports/300/j${j1.id}-s3/report.html`);
  assert.equal(e1.jobId, j1.id);
  assert.equal(e1.jobName, 'Java 25 (ubuntu-latest)');
  assert.equal(e1.jobUrl, j1.html_url);
  assert.equal(e1.stepNumber, 3);
  assert.equal(e1.stepName, 'Build with Maven');
  assert.equal(e1.attribution, 'jobId');
  assert.equal(e1.attempt, 1);
  assert.equal(e1.superseded, false);
  assert.equal(e1.label, null);
  assert.equal(e1.collectedAt, '2026-08-31T10:00:00.000Z');
  assert.equal(e1.bytes, Buffer.byteLength(html1));
  assert.equal(e1.reports.length, 1);
  assert.equal(e1.reports[0].name, 'report.html');
  assert.equal(e1.reports[0].path, `reports/300/j${j1.id}-s3/report.html`);
  assert.equal(e1.reports[0].bytes, Buffer.byteLength(html1));
  assert.equal(e1.reports[0].summarySource, 'meta');
  assert.equal(typeof e1.reports[0].summary.totalMs, 'number');
  assert.equal(e1.reports[0].summary.modules, undefined, 'modules are not stored');
  assert.ok(e1.reports[0].summary.moduleCount >= 0);
  assert.deepEqual(Object.keys(e1.reports[0].summary.environment).sort(), ['availableProcessors', 'githubActions', 'mvnd', 'osName']);
  assert.equal(e2.jobId, j2.id);
  assert.equal(e2.jobName, 'Javadoc');
  assert.equal(e2.jobUrl, j2.html_url);

  // Inbox ref gone, Pages build requested, summary written.
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), false, 'inbox ref deleted after the commit');
  assert.ok(fake.calls.some(c => c.method === 'POST' && c.path === `/repos/${REPO}/pages/builds`), 'POST /pages/builds');
  assert.ok(res.summary.includes('### Build monitor'));
  assert.ok(res.summary.includes(SITE));
  assert.ok(res.summary.includes(`[CI #${run300.run_number}](${SITE}#/run/300)`), 'run row links the monitoring page');
  assert.ok(res.summary.includes('Pages build requested'));
  assert.ok(res.summary.includes('1 inbox ref(s) deleted'));

  // (2) The same event again: everything is already there — no commit, no Pages build, exit 0.
  const commitsBefore = fake.store.commitsOf('gh-pages');
  const mark = fake.calls.length;
  const again = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(again.exitCode, 0);
  assert.equal(again.outputs.published, 'false');
  assert.equal(again.outputs['runs-processed'], '1', 'the event run is re-read');
  assert.equal(again.outputs['runs-total'], '1');
  assert.equal(again.outputs['reports-collected'], '0');
  assert.equal(again.outputs['commit-sha'], commitsBefore[0]);
  assert.deepEqual(fake.store.commitsOf('gh-pages'), commitsBefore, 'no new commit');
  assert.deepEqual(mutatingCalls(fake, mark), [], 'no mutating request at all');
  assert.deepEqual(historyOf(fake), hist, 'history byte-for-byte unchanged (generatedAt kept)');
  assert.ok(again.summary.includes('Nothing new to publish'));
});

// ---------------------------------------------------------------------------
// (3) + (8) sweep on workflow_dispatch: no event, all workflows but self
// ---------------------------------------------------------------------------

test('sweep: runs missing from the history are recorded; without an event every workflow but this one is monitored', async () => {
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [ciRun(297), ciRun(298), ciRun(299), ciRun(300), selfRun(500)], pages: null });
  // Seed the history with run 297 only (explicit run-id, sweep disabled).
  let res = await invoke(fake, { INPUT_RUN_ID: '297', INPUT_SWEEP_RUNS: '0', INPUT_WORKFLOWS: 'CI' });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(historyOf(fake).runs.map(r => r.id), [297]);
  assert.equal(fake.calls.filter(c => /actions\/workflows\/\d+\/runs/.test(c.path)).length, 0, 'sweep-runs 0 lists nothing');

  // A plain workflow_dispatch: sweep picks up 298, 299, 300 (297 is unchanged and not fetched again).
  const mark = fake.calls.length;
  res = await invoke(fake, {});
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(res.outputs['runs-processed'], '3');
  assert.equal(res.outputs['runs-total'], '4');
  const hist = historyOf(fake);
  assert.deepEqual(hist.runs.map(r => r.id), [300, 299, 298, 297], 'newest first');
  assert.deepEqual(Object.keys(hist.workflows), ['1'], 'the Build monitor workflow itself is excluded');
  assert.ok(!fake.calls.slice(mark).some(c => c.path.includes('/actions/runs/500/')), 'runs of the own workflow are not fetched');
  assert.ok(!fake.calls.slice(mark).some(c => c.path.includes('/actions/runs/297/')), 'unchanged runs are not fetched again');
  assert.ok(fake.calls.slice(mark).some(c => /actions\/workflows\/1\/runs\?.*created=%3E%3D\d{4}-\d{2}-\d{2}/.test(c.path)), 'sweep uses the created filter');
  // Pages is not enabled here (404): a warning, not a failure.
  assert.ok(res.summary.includes('Pages build Pages not enabled'));

  // include-self monitors the processor's own workflow too.
  res = await invoke(fake, { INPUT_INCLUDE_SELF: 'true' });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(historyOf(fake).runs.map(r => r.id), [500, 300, 299, 298, 297]);
  assert.deepEqual(Object.keys(historyOf(fake).workflows).sort(), ['1', '2']);

  // A re-run (attempt 2) of a recorded run is refreshed by the sweep.
  const r299 = fake.scenario.runs.find(r => r.id === 299);
  r299.run_attempt = 2;
  for (const j of r299.jobs) j.run_attempt = 2;
  r299.updated_at = new Date(NOW).toISOString();
  res = await invoke(fake, {});
  assert.equal(res.outputs['runs-processed'], '1');
  assert.equal(historyOf(fake).runs.find(r => r.id === 299).attempt, 2);
});

// ---------------------------------------------------------------------------
// (4) superseded
// ---------------------------------------------------------------------------

test('superseded: the report of an earlier attempt of the same job/step is kept but marked', async () => {
  const run300 = ciRun(300, { attempt: 2 });
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: PAGES });
  const j = run300.jobs[0];
  const staleJob = Object.assign({}, j, { id: 2999, html_url: `https://github.com/${REPO}/actions/runs/300/job/2999` });   // attempt-1 job: not in the latest attempt
  const html = fakeReportHtml(fixtureModel());
  seedInbox(fake, run300, [
    { key: 'j2999-s3', html, meta: meta(run300, staleJob, 3, { runAttempt: 1 }) },
    { key: `j${j.id}-s3`, html, meta: meta(run300, j, 3, { runAttempt: 2 }) },
    { key: `j${j.id}-s3-perf`, html, meta: meta(run300, j, 3, { runAttempt: 2, label: 'perf', key: `j${j.id}-s3-perf` }) },
  ]);
  const res = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(res.exitCode, 0);
  const r = historyOf(fake).runs[0];
  assert.equal(r.attempt, 2);
  const old = r.mvnLens.find(e => e.key === 'j2999-s3');
  const cur = r.mvnLens.find(e => e.key === `j${j.id}-s3`);
  const perf = r.mvnLens.find(e => e.key === `j${j.id}-s3-perf`);
  assert.equal(old.superseded, true);
  assert.equal(old.attempt, 1);
  assert.equal(old.attribution, 'stale-job');
  assert.equal(old.jobId, 2999, 'the stale job id from meta is kept');
  assert.equal(old.jobName, j.name, 'job name from meta');
  assert.equal(old.jobUrl, null, 'no job of the latest attempt → no URL is persisted from unvalidated meta (the page derives <run>/job/<id>)');
  assert.equal(old.stepNumber, 3);
  assert.equal(cur.superseded, false);
  assert.equal(cur.attempt, 2);
  assert.equal(cur.attribution, 'jobId');
  assert.equal(perf.superseded, false, 'a different label is a different series');
  assert.equal(perf.label, 'perf');
  assert.deepEqual(historyOf(fake).stats, { reportsCount: 3, reportsBytes: 3 * Buffer.byteLength(html) });
});

test('superseded: an earlier attempt without a job id is not re-attributed to the re-run job', async () => {
  // The report step of attempt 1 could not identify its job (no "actions: read",
  // or the Jobs API had not caught up): meta.jobId is null and the key is
  // <jobKey>-<rand6>. Its jobName/runnerName still match the attempt-2 job of
  // the same matrix leg — joining them would deep-link the attempt-1 report
  // into attempt 2's log. The summary action refuses that join; so must the
  // processor, which reads jobs?filter=latest (attempt 2 only).
  const run300 = ciRun(300, { attempt: 2 });
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: PAGES });
  const j = run300.jobs[0];
  const html = fakeReportHtml(fixtureModel());
  const blind = Object.assign(meta(run300, j, 3, { runAttempt: 1, key: 'build-a1b2c3' }), { jobId: null, jobUrl: null });
  assert.equal(blind.jobName, j.name, 'the attempt-1 meta carries the job name of this matrix leg');
  assert.equal(blind.runnerName, j.runner_name, 'and the runner name, which hosted runners reuse');
  seedInbox(fake, run300, [
    { key: 'build-a1b2c3', html, meta: blind },
    { key: `j${j.id}-s3`, html, meta: meta(run300, j, 3, { runAttempt: 2 }) },
  ]);
  const res = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(res.exitCode, 0);
  const r = historyOf(fake).runs[0];
  const old = r.mvnLens.find(e => e.key === 'build-a1b2c3');
  const cur = r.mvnLens.find(e => e.key === `j${j.id}-s3`);

  assert.equal(old.attribution, 'stale-attempt', 'no job of this attempt is claimed for it');
  assert.equal(old.jobId, null, 'and no job id is invented: the page degrades the link to the run');
  assert.equal(old.jobUrl, null);
  assert.notEqual(cur.jobId, null);
  assert.equal(old.attempt, 1);
  assert.equal(old.jobName, blind.jobName, 'the name still comes from meta — it is what the report itself claims');
  assert.equal(old.stepNumber, 3, 'as does the step it recorded, unresolved against this attempt');
  assert.equal(old.stepName, 'Build with Maven');
  assert.equal(old.superseded, true, 'same job name / step / label at a higher attempt: still superseded');
  assert.equal(cur.superseded, false);
  assert.equal(cur.attribution, 'jobId');
  assert.equal(cur.jobId, j.id);
  // The report itself is published either way: attribution never gates the graft.
  assert.ok(fake.store.readFile('gh-pages', 'reports/300/build-a1b2c3/report.html'), 'the attempt-1 report is on the site');
  assert.equal(historyOf(fake).stats.reportsCount, 2);
});

test('markSuperseded / slimSummary (pure helpers)', () => {
  const list = [
    { key: 'a', jobName: 'build', stepNumber: 3, label: null, attempt: 1 },
    { key: 'b', jobName: 'build', stepNumber: 3, label: null, attempt: 2 },
    { key: 'c', jobName: 'build', stepNumber: 3, label: null, attempt: 2 },   // same attempt: not superseded
    { key: 'd', jobName: 'build', stepNumber: 4, label: null, attempt: 1 },
    { key: 'e', jobName: null, stepName: null, label: 'x', attempt: 1 },
    { key: 'f', jobName: 'other', stepName: 'Build', label: null, attempt: 1 },
    { key: 'g', jobName: 'other', stepName: 'Build', label: null, attempt: 3 },
  ];
  markSuperseded(list);
  assert.deepEqual(list.map(e => [e.key, e.superseded]), [['a', true], ['b', false], ['c', false], ['d', false], ['e', false], ['f', true], ['g', false]]);

  const full = summarizeModel(fixtureModel(), { modules: true });
  assert.ok(Array.isArray(full.modules));
  const slim = slimSummary(full);
  assert.equal(slim.modules, undefined);
  assert.equal(slim.totalMs, full.totalMs);
  assert.equal(slim.moduleCount, full.moduleCount);
  assert.deepEqual(slim.goals, full.goals);
  assert.deepEqual(Object.keys(slim.environment).sort(), ['availableProcessors', 'githubActions', 'mvnd', 'osName']);
  assert.equal(slimSummary(null), null);
  assert.equal(slimSummary('x'), null);
  assert.equal(slimSummary({ totalMs: 5 }).environment, null);
});

// ---------------------------------------------------------------------------
// (5) CAS conflict
// ---------------------------------------------------------------------------

test('conflict: a competing commit that touches other files is kept (retry on the new head)', async () => {
  const { fake, j1, event } = scenario300();
  fake.store.seedBranch('gh-pages', { 'README.md': 'the site branch' });
  let raced = 0;
  fake.hook(({ method, path: p }) => {
    if (method === 'PATCH' && p.includes('/git/refs/heads/gh-pages') && raced === 0) {
      raced++;
      fake.store.seedBranch('gh-pages', { 'CNAME': 'monitor.example.test' });
    }
  });
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(raced, 1);
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(String(fake.store.readFile('gh-pages', 'README.md')), 'the site branch');
  assert.equal(String(fake.store.readFile('gh-pages', 'CNAME')), 'monitor.example.test');
  assert.ok(fake.store.readFile('gh-pages', 'data/history.json'));
  assert.ok(fake.store.readFile('gh-pages', 'index.html'));
  assert.ok(fake.store.readFile('gh-pages', `reports/300/j${j1.id}-s3/report.html`));
  assert.equal(fake.store.commitsOf('gh-pages').length, 3, 'seed, rival, ours');
  assert.deepEqual(historyOf(fake).runs.map(r => r.id), [300]);
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), false);
});

test('conflict: a competing history.json is re-read and re-merged (their run and ours both survive)', async () => {
  const { fake, event } = scenario300();
  const theirRun = { id: 250, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 250, attempt: 1, event: 'push', status: 'completed', conclusion: 'failure', branch: 'main', createdAt: new Date(NOW - 200 * 3600000).toISOString(), jobs: [], mvnLens: [] };
  const theirs = { schemaVersion: 1, repository: REPO, generatedAt: '2026-08-30T00:00:00.000Z', workflows: {}, runs: [theirRun] };
  fake.store.seedBranch('gh-pages', { 'data/history.json': JSON.stringify({ schemaVersion: 1, repository: REPO, workflows: {}, runs: [] }) });
  let raced = 0;
  fake.hook(({ method, path: p }) => {
    if (method === 'PATCH' && p.includes('/git/refs/heads/gh-pages') && raced === 0) {
      raced++;
      fake.store.seedBranch('gh-pages', { 'data/history.json': JSON.stringify(theirs) });
    }
  });
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(raced, 1);
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(res.outputs['runs-total'], '2');
  const hist = historyOf(fake);
  assert.deepEqual(hist.runs.map(r => r.id), [300, 250]);
  assert.equal(hist.runs[0].mvnLens.length, 2);
  assert.equal(hist.runs[1].conclusion, 'failure');
  assert.deepEqual(hist.stats.reportsCount, 2);
  assert.ok(res.summary.includes('Published commit'));
});

// ---------------------------------------------------------------------------
// (6) dry run
// ---------------------------------------------------------------------------

test('dry-run writes the site to output-dir and touches no ref', async () => {
  const { fake, event } = scenario300();
  const outDir = path.join(tmpDir('dry'), 'site');
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event, INPUT_DRY_RUN: 'true', INPUT_OUTPUT_DIR: outDir, INPUT_TITLE: 'Widgets CI' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'false');
  assert.equal(res.outputs['commit-sha'], '');
  assert.equal(res.outputs['runs-processed'], '1');
  assert.equal(res.outputs['runs-total'], '1');
  assert.equal(res.outputs['reports-collected'], '2');
  assert.equal(res.outputs['site-url'], SITE);
  for (const f of ['index.html', 'data/history.json', '.nojekyll']) assert.ok(fs.existsSync(path.join(outDir, f)), f);
  assert.ok(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8').includes('<title>Widgets CI</title>'));
  const hist = JSON.parse(fs.readFileSync(path.join(outDir, 'data', 'history.json'), 'utf8'));
  assert.equal(hist.runs.length, 1);
  assert.equal(hist.runs[0].mvnLens.length, 2);
  assert.equal(hist.siteUrl, SITE);
  assert.ok(!fs.existsSync(path.join(outDir, 'reports')), 'reports are not copied');
  assert.equal(fake.store.headOf('gh-pages'), null, 'no branch created');
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), true, 'inbox ref untouched');
  assert.deepEqual(mutatingCalls(fake), [], 'no POST/PATCH/DELETE at all');
  assert.ok(res.summary.includes('Dry run'));
});

// ---------------------------------------------------------------------------
// (7) fork policy
// ---------------------------------------------------------------------------

test('fork runs are skipped (their inbox ref is left alone) unless include-fork-runs', async () => {
  const { fake, event } = scenario300({ run: { headRepository: 'forker/widgets' }, event: { head_repository: { full_name: 'forker/widgets' } } });
  let res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['runs-processed'], '0');
  assert.equal(res.outputs['runs-total'], '0');
  assert.equal(res.outputs['reports-collected'], '0');
  assert.equal(res.outputs.published, 'true', 'the (empty) site is still created');
  assert.deepEqual(historyOf(fake).runs, []);
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), true, 'inbox ref of a skipped run is left alone');
  assert.ok(!fake.calls.some(c => c.path.includes('/actions/runs/300/jobs')), 'jobs of a skipped run are not fetched');
  assert.ok(res.summary.includes('1 fork run(s)'));

  res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event, INPUT_INCLUDE_FORK_RUNS: 'true' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['runs-processed'], '1');
  assert.equal(res.outputs['reports-collected'], '2');
  assert.equal(historyOf(fake).runs[0].headRepository, 'forker/widgets');
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), false);
});

// ---------------------------------------------------------------------------
// Recovery, site-dir, failures
// ---------------------------------------------------------------------------

test('report sets already on the branch but missing from the history are re-read (no graft); history entries are kept as they are', async () => {
  const run300 = ciRun(300);
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: PAGES });
  const [j1, j2] = run300.jobs;
  const html = fakeReportHtml(fixtureModel());
  const kept = { key: `j${j2.id}-s3`, dir: `reports/300/j${j2.id}-s3`, path: `reports/300/j${j2.id}-s3/report.html`, jobId: j2.id, jobName: 'renamed by hand', jobUrl: null, stepNumber: 3, stepName: 'Build with Maven', label: null, attempt: 1, attribution: 'jobId', superseded: false, collectedAt: '2026-08-01T00:00:00.000Z', bytes: 42, reports: [{ name: 'report.html', label: null, path: `reports/300/j${j2.id}-s3/report.html`, summary: null, summarySource: null, bytes: 42 }] };
  const bad = { key: 'evil', dir: '../../etc', reports: [] };
  fake.store.seedBranch('gh-pages', {
    'data/history.json': JSON.stringify({ schemaVersion: 1, repository: REPO, workflows: {}, runs: [{ id: 300, workflowId: 1, createdAt: run300.created_at, status: 'completed', jobs: [], mvnLens: [kept, bad] }] }),
    [`reports/300/j${j1.id}-s3/report.html`]: html,
    [`reports/300/j${j1.id}-s3/meta.json`]: JSON.stringify(meta(run300, j1, 3)),
    [`reports/300/j${j2.id}-s3/report.html`]: html,
    'reports/300/not a key!/report.html': html,
  });
  const res = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['reports-collected'], '0', 'nothing grafted');
  const r = historyOf(fake).runs[0];
  assert.deepEqual(r.mvnLens.map(e => e.key).sort(), [`j${j1.id}-s3`, `j${j2.id}-s3`]);
  const recovered = r.mvnLens.find(e => e.key === `j${j1.id}-s3`);
  assert.equal(recovered.jobName, 'Java 25 (ubuntu-latest)');
  assert.equal(recovered.bytes, Buffer.byteLength(html));
  assert.equal(recovered.reports[0].summarySource, 'meta');
  const untouched = r.mvnLens.find(e => e.key === `j${j2.id}-s3`);
  assert.equal(untouched.jobName, 'renamed by hand', 'existing entries are not re-attributed');
  assert.equal(untouched.bytes, 42);
  assert.equal(r.jobs.length, 2, 'the run record itself is refreshed');
  assert.equal(historyOf(fake).stats.reportsBytes, Buffer.byteLength(html) + 42);
});

test('site-dir: everything lives under the sub-directory and the site URL gets the suffix', async () => {
  const { fake, j1, event } = scenario300();
  fake.store.seedBranch('gh-pages', { 'index.md': 'other content of the branch' });
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event, INPUT_SITE_DIR: '/monitor/' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['site-url'], SITE + 'monitor/');
  assert.deepEqual(fake.store.listDir('gh-pages', ''), ['index.md', 'monitor']);
  assert.deepEqual(fake.store.listDir('gh-pages', 'monitor'), ['.nojekyll', 'data', 'index.html', 'reports']);
  assert.ok(fake.store.readFile('gh-pages', `monitor/reports/300/j${j1.id}-s3/report.html`));
  const hist = historyOf(fake, 'gh-pages', 'monitor');
  assert.equal(hist.siteUrl, SITE + 'monitor/');
  assert.equal(hist.runs[0].mvnLens[0].dir, `reports/300/j${j1.id}-s3`, 'report dirs stay site-relative');
  // Second run: still a no-op with a site-dir.
  const commits = fake.store.commitsOf('gh-pages');
  const again = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event, INPUT_SITE_DIR: 'monitor' });
  assert.equal(again.outputs.published, 'false');
  assert.deepEqual(fake.store.commitsOf('gh-pages'), commits);
});

test('a read-only token fails the run with exit code 1, published=false, inbox untouched', async () => {
  const { fake, event } = scenario300({ scenario: { readOnly: true } });
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(res.exitCode, 1);
  assert.equal(res.outputs.published, 'false');
  assert.equal(res.outputs['commit-sha'], '');
  assert.equal(res.outputs['site-url'], SITE, 'outputs known so far are still set');
  assert.equal(fake.store.headOf('gh-pages'), null);
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), true);
  assert.ok(res.summary.includes('**Failed:**'));
  assert.ok(/contents: write/.test(res.summary));
});

test('a Pages build that is not permitted is a warning, not a failure', async () => {
  const { fake, event } = scenario300();
  fake.hook(({ method, path: p }) => {
    if (method === 'POST' && p.endsWith('/pages/builds')) fake.opts.readOnly = true;   // 403 on the build request only
    if (method === 'DELETE') fake.opts.readOnly = false;
  });
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.ok(res.summary.includes('Pages build not permitted'));
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), false, 'the inbox ref is still deleted');

  // request-pages-build: false never asks.
  const other = scenario300();
  await invoke(other.fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: other.event, INPUT_REQUEST_PAGES_BUILD: 'false' });
  assert.ok(!other.fake.calls.some(c => c.path.endsWith('/pages/builds')));
});

test('configuration errors are reported without a stack trace (exit code 1)', async () => {
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [] });
  let res = await invoke(fake, { INPUT_REPOSITORY: 'not a repo' });
  assert.equal(res.exitCode, 1);
  assert.equal(res.outputs.published, 'false');
  res = await invoke(fake, { INPUT_GITHUB_TOKEN: null });
  assert.equal(res.exitCode, 1);
  res = await invoke(fake, { INPUT_BRANCH: 'bad..name' });
  assert.equal(res.exitCode, 1);
  res = await invoke(fake, { INPUT_SITE_DIR: '../outside' });
  assert.equal(res.exitCode, 1);
  res = await invoke(fake, { INPUT_INBOX_PREFIX: 'has space/' });
  assert.equal(res.exitCode, 1);
  res = await invoke(fake, { INPUT_DRY_RUN: 'maybe' });
  assert.equal(res.exitCode, 1);
  assert.deepEqual(mutatingCalls(fake), []);
  // A corrupt history.json is never silently replaced.
  fake.store.seedBranch('gh-pages', { 'data/history.json': '{not json' });
  res = await invoke(fake, {});
  assert.equal(res.exitCode, 1);
  assert.equal(fake.store.commitsOf('gh-pages').length, 1);
  assert.ok(res.summary.includes('unusable'));
});

test('a workflows input that matches nothing records nothing but still creates the site', async () => {
  const { fake, event } = scenario300();
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event, INPUT_WORKFLOWS: 'Nightly' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['runs-total'], '0');
  assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), true, 'the inbox of an unmonitored run is left alone');
  assert.deepEqual(historyOf(fake).workflows, {});
});

// ---------------------------------------------------------------------------
// Inbox refs are only deleted when nothing can still land in them
// ---------------------------------------------------------------------------

test('a run still in progress is recorded and grafted, but its inbox ref is kept until it completes (dry run first, like the CI self-test)', async () => {
  const running = ciRun(300, { status: 'in_progress' });
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [running, selfRun(500)], pages: PAGES });
  const j1 = running.jobs[0];
  const html = fakeReportHtml(fixtureModel(), { gzip: true, pako: true });
  seedInbox(fake, running, [{ key: `j${j1.id}-s3`, html, meta: meta(running, j1, 3) }]);
  const inboxRef = 'refs/heads/build-monitor-inbox/300';

  // 1. The shape of .github/workflows/ci.yml's self-test: no event, dry run, workflows: CI, include-self.
  const outDir = path.join(tmpDir('selftest'), 'build-monitor-site');
  let res = await invoke(fake, { INPUT_DRY_RUN: 'true', INPUT_OUTPUT_DIR: outDir, INPUT_WORKFLOWS: 'CI', INPUT_INCLUDE_SELF: 'true' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'false');
  assert.equal(res.outputs['runs-processed'], '1');
  assert.equal(res.outputs['reports-collected'], '1');
  for (const f of ['index.html', 'data/history.json', '.nojekyll']) assert.ok(fs.existsSync(path.join(outDir, f)), f);
  assert.deepEqual(mutatingCalls(fake), []);
  assert.ok(fake.store.refs.has(inboxRef));

  // 2. For real: the run is in the history as in progress, its report is on the branch, the ref stays.
  let mark = fake.calls.length;
  res = await invoke(fake, {});
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(res.outputs['reports-collected'], '1');
  let hist = historyOf(fake);
  assert.equal(hist.runs[0].status, 'in_progress');
  assert.equal(hist.runs[0].conclusion, null);
  assert.equal(hist.runs[0].mvnLens.length, 1);
  assert.ok(fake.store.readFile('gh-pages', `reports/300/j${j1.id}-s3/report.html`).equals(Buffer.from(html, 'utf8')));
  assert.ok(fake.store.refs.has(inboxRef), 'the inbox of a running run is kept');
  assert.ok(!fake.calls.slice(mark).some(c => c.method === 'DELETE'), 'no DELETE at all');

  // 3. The run completes: picked up as "incomplete" (and by its inbox ref), refreshed, ref deleted; the report is not uploaded again.
  fake.scenario.runs.splice(fake.scenario.runs.indexOf(running), 1, ciRun(300));
  mark = fake.calls.length;
  res = await invoke(fake, {});
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(res.outputs['runs-processed'], '1');
  hist = historyOf(fake);
  assert.equal(hist.runs[0].status, 'completed');
  assert.equal(hist.runs[0].conclusion, 'success');
  assert.equal(hist.runs[0].mvnLens.length, 1);
  assert.equal(fake.store.refs.has(inboxRef), false, 'deleted once the run completed');
  assert.equal(fake.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/git/blobs')).length, 1, 'only data/history.json changed');
});

test('an inbox ref that moved after the snapshot is kept, and its new report set is grafted by the next invocation', async () => {
  const { fake, j1, j2, event } = scenario300();
  const late = fakeReportHtml(fixtureModel(), { id: 'mvnflight-data' });
  const inboxRef = 'refs/heads/build-monitor-inbox/300';
  let listings = 0;
  fake.hook(({ method, path: p }) => {
    // The 2nd listing is the one right before the deletion: a report step pushes in between.
    if (method === 'GET' && p.includes('/git/matching-refs/heads/build-monitor-inbox') && ++listings === 2) {
      fake.store.seedBranch('build-monitor-inbox/300', { [`reports/300/j${j2.id}-s4-late/report.html`]: late, [`reports/300/j${j2.id}-s4-late/meta.json`]: JSON.stringify(meta(fake.scenario.runs[0], j2, 4, { label: 'late' })) });
    }
  });
  let res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(listings, 2);
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(res.outputs['reports-collected'], '2');
  assert.ok(fake.store.refs.has(inboxRef), 'moved ref is not deleted');
  assert.ok(!fake.calls.some(c => c.method === 'DELETE'));
  assert.deepEqual(fake.store.listDir('gh-pages', 'reports/300'), [`j${j1.id}-s3`, `j${j2.id}-s3`]);

  fake.hook(null);
  res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.equal(res.outputs['reports-collected'], '3', 'every key of the inbox is grafted (two of them already there)');
  assert.deepEqual(fake.store.listDir('gh-pages', 'reports/300'), [`j${j1.id}-s3`, `j${j2.id}-s3`, `j${j2.id}-s4-late`]);
  assert.equal(String(fake.store.readFile('gh-pages', `reports/300/j${j2.id}-s4-late/report.html`)), late);
  const r = historyOf(fake).runs[0];
  assert.equal(r.mvnLens.length, 3);
  const lateEntry = r.mvnLens.find(e => e.key === `j${j2.id}-s4-late`);
  assert.equal(lateEntry.label, 'late');
  assert.equal(lateEntry.stepNumber, 4);
  assert.equal(lateEntry.superseded, false);
  assert.equal(fake.store.refs.has(inboxRef), false, 'deleted now that it is fully grafted');
  assert.equal(historyOf(fake).stats.reportsCount, 3);
});

// ---------------------------------------------------------------------------
// The inbox is untrusted input: nothing but validated report files is published
// ---------------------------------------------------------------------------

test('an inbox key is never grafted wholesale: symlinks, sub-directories and stray files never reach the site', async () => {
  const run300 = ciRun(300);
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: PAGES });
  const [j1, j2] = run300.jobs;
  const html = fakeReportHtml(fixtureModel());
  const keyA = `j${j1.id}-s3`;   // a real report set, with junk written next to it
  const keyB = `j${j2.id}-s3`;   // report.html is a SYMLINK: this set holds no report at all
  seedInboxTree(fake, 300, [
    { path: `reports/300/${keyA}/report.html`, mode: '100644', type: 'blob', content: html },
    { path: `reports/300/${keyA}/meta.json`, mode: '100644', type: 'blob', content: JSON.stringify(meta(run300, j1, 3)) },
    { path: `reports/300/${keyA}/script.js`, mode: '100644', type: 'blob', content: 'alert(1)' },
    { path: `reports/300/${keyA}/runner`, mode: '100755', type: 'blob', content: '#!/bin/sh\nexit 0\n' },
    { path: `reports/300/${keyA}/sub/report.html`, mode: '100644', type: 'blob', content: '<html>nested</html>' },
    { path: `reports/300/${keyB}/report.html`, mode: '120000', type: 'blob', content: '../../../data/history.json' },
    { path: `reports/300/${keyB}/meta.json`, mode: '100644', type: 'blob', content: JSON.stringify(meta(run300, j2, 3)) },
  ]);
  const res = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['reports-collected'], '1', 'one report file published');
  assert.equal(res.outputs['reports-bytes'], String(Buffer.byteLength(html)), 'the counted bytes are the bytes published');

  // Only the validated files are on the branch.
  assert.deepEqual(fake.store.listDir('gh-pages', 'reports/300'), [keyA], 'the symlink-only set is not published at all');
  assert.deepEqual(fake.store.listDir('gh-pages', `reports/300/${keyA}`), ['meta.json', 'report.html']);
  assert.equal(String(fake.store.readFile('gh-pages', `reports/300/${keyA}/report.html`)), html);
  for (const gone of [`reports/300/${keyA}/script.js`, `reports/300/${keyA}/runner`, `reports/300/${keyA}/sub/report.html`, `reports/300/${keyB}/report.html`]) {
    assert.equal(fake.store.readFile('gh-pages', gone), null, `${gone} must not be published`);
  }
  // Every graft is a blob graft of a file we validated; no key tree travels.
  const trees = fake.calls.filter(c => c.method === 'POST' && c.path.endsWith('/git/trees'));
  assert.equal(trees.length, 1);
  assert.deepEqual(trees[0].body.tree.filter(e => e.type === 'tree'), [], 'no tree entry is grafted');
  assert.deepEqual(trees[0].body.tree.filter(e => e.path.startsWith('reports/')).map(e => e.path).sort(),
    [`reports/300/${keyA}/meta.json`, `reports/300/${keyA}/report.html`]);

  // And the history records the report file only — never the symlink.
  const r = historyOf(fake).runs[0];
  assert.deepEqual(r.mvnLens.map(e => e.key), [keyA]);
  assert.deepEqual(r.mvnLens[0].reports.map(x => x.name), ['report.html']);
  assert.equal(r.mvnLens[0].bytes, Buffer.byteLength(html));
  assert.deepEqual(historyOf(fake).stats, { reportsCount: 1, reportsBytes: Buffer.byteLength(html) });

  const warns = warningsOf(res).join('\n');
  assert.match(warns, new RegExp(`reports/300/${keyA}/script\\.js \\(blob, mode 100644\\) is not an mvn-lens report file`));
  assert.match(warns, new RegExp(`reports/300/${keyA}/runner \\(blob, mode 100755\\) is not an mvn-lens report file`));
  assert.match(warns, new RegExp(`reports/300/${keyA}/sub \\(tree, mode 040000\\) is not an mvn-lens report file`));
  assert.match(warns, new RegExp(`reports/300/${keyB}/report\\.html \\(blob, mode 120000\\) is not an mvn-lens report file`));
  assert.match(warns, new RegExp(`reports/300/${keyB} \\(inbox\\) holds no report\\.html`));

  // A second invocation is still a no-op (blob grafts are idempotent like the tree graft was).
  const commits = fake.store.commitsOf('gh-pages');
  const again = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(again.outputs.published, 'false');
  assert.deepEqual(fake.store.commitsOf('gh-pages'), commits);
});

test('a meta.json with wrong types is coerced before it reaches history.json', async () => {
  const run300 = ciRun(300);
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: PAGES });
  const j1 = run300.jobs[0];
  const html = fakeReportHtml(fixtureModel());
  const crafted = meta(run300, j1, 3);
  crafted.reports[0].summary = Object.assign({}, crafted.reports[0].summary, {
    goals: 'verify',                                     // a string, not a list
    totalMs: '4711', wallMs: { ms: 1 }, gcCount: null,   // not numbers
    status: ['OK'], jdkVersion: 25,                      // not strings
    environment: { availableProcessors: [], osName: {}, mvnd: 'yes', githubActions: 0, cpuModel: 'leaked' },
  });
  seedInbox(fake, run300, [{ key: `j${j1.id}-s3`, html, meta: crafted }]);
  const res = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(res.exitCode, 0);
  const s = historyOf(fake).runs[0].mvnLens[0].reports[0].summary;
  assert.deepEqual(s.goals, [], 'a string never becomes the goals list the table joins');
  assert.equal(s.totalMs, null);
  assert.equal(s.wallMs, null);
  assert.equal(s.gcCount, null);
  assert.equal(s.status, null);
  assert.equal(s.jdkVersion, null);
  assert.deepEqual(s.environment, { availableProcessors: null, osName: null, mvnd: true, githubActions: false });
  assert.equal(s.environment.cpuModel, undefined, 'unknown environment keys are dropped');
  assert.equal(s.moduleCount, crafted.reports[0].summary.moduleCount, 'well-typed fields survive');
});

test('slimSummary coerces every field it keeps', () => {
  const slim = slimSummary({
    goals: ['clean', 42, 'verify'], threads: 4, totalMs: NaN, cpuMs: Infinity, moduleCount: 12, endedAt: 1234,
    startedAt: '2026-08-31T10:00:00Z', mavenVersion: '3.9.9', builderId: { id: 1 },
    slowestMojo: ['plugin'], issueSeverities: { warn: 2, nested: { n: 1 } },
    modules: [{ artifactId: 'a' }],
    environment: { availableProcessors: 8, osName: 'Linux', mvnd: 0, githubActions: 'true' },
  });
  assert.deepEqual(slim.goals, ['clean', 'verify'], 'non-string goals are dropped');
  assert.equal(slim.threads, 4);
  assert.equal(slim.totalMs, null, 'NaN is not a finite number');
  assert.equal(slim.cpuMs, null, 'Infinity is not a finite number');
  assert.equal(slim.moduleCount, 12);
  assert.equal(slim.endedAt, 1234);
  assert.equal(slim.startedAt, null, 'startedAt is epoch ms, not a string');
  assert.equal(slim.mavenVersion, '3.9.9');
  assert.equal(slim.builderId, null);
  assert.equal(slim.slowestMojo, null, 'an array is not a slowest-mojo record');
  assert.deepEqual(slim.issueSeverities, { warn: 2 }, 'nested objects are dropped');
  assert.equal(slim.modules, undefined);
  assert.deepEqual(slim.environment, { availableProcessors: 8, osName: 'Linux', mvnd: false, githubActions: true });
  assert.equal(slimSummary({ environment: ['x'] }).environment, null);
  assert.equal(slimSummary({ goals: 'verify' }).goals.length, 0);
});

// ---------------------------------------------------------------------------
// Inbox deletion races: DELETE /git/refs has no expected-sha
// ---------------------------------------------------------------------------

test('a report that lands between the last listing and the DELETE is not wiped (the ref is re-read first)', async () => {
  const { fake, j2, event } = scenario300();
  const late = fakeReportHtml(fixtureModel());
  const inboxRef = 'refs/heads/build-monitor-inbox/300';
  const lateKey = `j${j2.id}-s9-late`;
  let reads = 0;
  fake.hook(({ method, path: p }) => {
    // Read 1 is the snapshot taken while processing; read 2 is the one
    // deleteGraftedInboxRefs makes immediately before the DELETE.
    if (method === 'GET' && p === `/repos/${REPO}/git/ref/heads/build-monitor-inbox/300` && ++reads === 2) {
      fake.store.seedBranch('build-monitor-inbox/300', {
        [`reports/300/${lateKey}/report.html`]: late,
        [`reports/300/${lateKey}/meta.json`]: JSON.stringify(meta(fake.scenario.runs[0], j2, 9, { label: 'late', key: lateKey })),
      });
    }
  });
  const res = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(reads, 2, 'the ref is re-read immediately before the DELETE');
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.published, 'true');
  assert.ok(fake.store.refs.has(inboxRef), 'the ref is kept: deleting it would have wiped the late report');
  assert.ok(!fake.calls.some(c => c.method === 'DELETE'), 'no DELETE at all');
  assert.ok(fake.store.readFile('build-monitor-inbox/300', `reports/300/${lateKey}/report.html`), 'the late report survives');
  assert.match(warningsOf(res).join('\n'), /inbox ref refs\/heads\/build-monitor-inbox\/300 moved from [0-9a-f]{7} to [0-9a-f]{7}/);

  // The next invocation grafts it and only then deletes the ref.
  fake.hook(null);
  const again = await invoke(fake, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event });
  assert.equal(again.exitCode, 0);
  assert.equal(String(fake.store.readFile('gh-pages', `reports/300/${lateKey}/report.html`)), late);
  assert.equal(fake.store.refs.has(inboxRef), false, 'deleted now that everything in it is on the site');
});

test('the inbox ref of a re-run is kept while only the earlier attempt has been grafted', async () => {
  const run300 = ciRun(300, { attempt: 2 });
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [run300], pages: PAGES });
  const j1 = run300.jobs[0];
  const staleJob = Object.assign({}, j1, { id: 2999 });
  const html = fakeReportHtml(fixtureModel());
  const inboxRef = 'refs/heads/build-monitor-inbox/300';
  // Only attempt 1's report has landed; attempt 2's `report` steps push to the SAME ref.
  seedInbox(fake, run300, [{ key: 'j2999-s3', html, meta: meta(run300, staleJob, 3, { runAttempt: 1, key: 'j2999-s3' }) }]);
  let res = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['reports-collected'], '1');
  assert.ok(fake.store.refs.has(inboxRef), 'kept: run is at attempt 2, the grafted report is from attempt 1');
  assert.ok(!fake.calls.some(c => c.method === 'DELETE'), 'no DELETE at all');
  assert.match(res.stdout, /kept: run 300 is at attempt 2 but the grafted reports are from attempt 1/);

  // Attempt 2's report lands: the ref now carries the current attempt and may go.
  seedInbox(fake, run300, [{ key: `j${j1.id}-s3`, html, meta: meta(run300, j1, 3, { runAttempt: 2 }) }]);
  res = await invoke(fake, { INPUT_RUN_ID: '300', INPUT_SWEEP_RUNS: '0' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs['reports-collected'], '2');
  assert.equal(fake.store.refs.has(inboxRef), false, 'deleted once attempt 2 is grafted too');
  assert.deepEqual(historyOf(fake).runs[0].mvnLens.map(e => [e.key, e.attempt, e.superseded]),
    [['j2999-s3', 1, true], [`j${j1.id}-s3`, 2, false]]);
});

// ---------------------------------------------------------------------------
// (9) spawn src/index.js over the HTTP fake
// ---------------------------------------------------------------------------

test('src/index.js processes a workflow_run event end to end over HTTP (spawn)', async () => {
  const { fake, j1, html1, event } = scenario300();
  const served = await fake.serve();
  try {
    const cap = captureOutputs();
    const env = Object.assign({}, process.env, baseEnv({ GITHUB_API_URL: served.url, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event, GITHUB_ACTIONS: 'true' }), cap.env);
    for (const k of Object.keys(env)) if (env[k] === null || env[k] === undefined) delete env[k];
    const child = await spawnAsync(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, timeout: 120000 });
    assert.equal(child.status, 0, `exit ${child.status}\n${child.stdout}\n${child.stderr}`);
    assert.ok(child.stdout.includes('::add-mask::secret-token'), 'token masked at startup');
    assert.ok(child.stdout.includes('::group::'));
    const out = cap.outputs();
    assert.equal(out.published, 'true');
    assert.equal(out['runs-total'], '1');
    assert.equal(out['reports-collected'], '2');
    assert.equal(out['site-url'], SITE);
    assert.equal(out['commit-sha'], fake.store.headOf('gh-pages'));
    assert.ok(fake.store.readFile('gh-pages', `reports/300/j${j1.id}-s3/report.html`).equals(Buffer.from(html1, 'utf8')));
    assert.equal(fake.store.refs.has('refs/heads/build-monitor-inbox/300'), false);
    assert.ok(cap.summary().includes('### Build monitor'));
  } finally {
    await served.close();
  }
});
