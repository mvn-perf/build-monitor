/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * End-to-end tests of the `report` action against the fake GitHub: the action
 * runs in-process through run({ fetch, sleep }) with the environment a runner
 * would provide, plus one spawn of report/index.js against fake.serve().
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, keyFor, reportLabels, describeFailure } = require('../src/report');
const { GitStoreError } = require('../src/gitstore');
const { createFakeGitHub } = require('./fake-github');
const { tmpDir, fakeReportHtml, fixtureModel, fakeRun, withEnv, captureOutputs } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const REPO = 'acme/widgets';
const RUN_ID = 777;
const JOB_ID = 7770;
const TOKEN = 'ghs_s3cretT0kenValueXYZ';
const INBOX = `build-monitor-inbox/${RUN_ID}`;
const SITE = 'https://acme.github.io/widgets/';
/** The job started 100 s ago; the Maven step ran from +6 s to +90 s, the report step is running now. */
const BASE = Date.now() - 100000;
const REPORT_WRITTEN_AT = BASE + 60000;
const fastSleep = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A run with one in-progress build job (this one) and a completed lint job. */
function scenario(extra) {
  const runObj = fakeRun({
    id: RUN_ID, baseMs: BASE, status: 'in_progress', repository: REPO, jobs: [
      { id: JOB_ID, name: 'build', runnerName: 'GitHub Actions 7', steps: [
        { number: 1, name: 'Set up job', start: 2, end: 4 },
        { number: 2, name: 'Run actions/checkout@v4', start: 4, end: 6 },
        { number: 3, name: 'Build with Maven', start: 6, end: 90 },
        { number: 4, name: 'Publish mvn-lens report', start: 90, end: 95, status: 'in_progress' },
      ] },
      { id: JOB_ID + 1, name: 'lint', runnerName: 'GitHub Actions 8', status: 'completed', steps: [
        { number: 1, name: 'Set up job', start: 2, end: 4 },
        { number: 2, name: 'Lint', start: 4, end: 20 },
      ] },
    ],
  });
  return createFakeGitHub(Object.assign({ repository: REPO, runs: [runObj] }, extra || {}));
}

/** The runner environment of the build job; null unsets a variable (CI leaks its own GITHUB_* otherwise). */
function actionEnv(cap, extra) {
  const env = {
    GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: String(RUN_ID), GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'build', RUNNER_NAME: 'GitHub Actions 7', GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_WORKFLOW_REF: 'acme/widgets/.github/workflows/ci.yml@refs/heads/main', GITHUB_WORKFLOW: 'CI', GITHUB_EVENT_PATH: null, GITHUB_TOKEN: null,
    'INPUT_GITHUB-TOKEN': TOKEN, INPUT_GITHUB_TOKEN: null, INPUT_REPORT: null, 'INPUT_STEP-NAME': null, INPUT_STEP_NAME: null,
    'INPUT_JOB-NAME': null, INPUT_JOB_NAME: null, INPUT_LABEL: null, 'INPUT_INBOX-PREFIX': null, INPUT_INBOX_PREFIX: null,
    'INPUT_SITE-URL': null, INPUT_SITE_URL: null, INPUT_COMPRESS: null, 'INPUT_IF-NO-FILES-FOUND': null, INPUT_IF_NO_FILES_FOUND: null,
    'INPUT_FAIL-ON-ERROR': null, INPUT_FAIL_ON_ERROR: null, 'INPUT_COMMIT-MESSAGE': null, INPUT_COMMIT_MESSAGE: null,
  };
  return Object.assign(env, cap ? cap.env : {}, extra || {});
}

/** A workspace holding target/mvnlens/report.html written during the Maven step. */
function workspace(model, htmlOpts) {
  const dir = tmpDir('report');
  const file = writeReport(path.join(dir, 'target', 'mvnlens', 'report.html'), model, htmlOpts);
  return { dir, file };
}

function writeReport(file, model, htmlOpts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fakeReportHtml(model || fixtureModel(), Object.assign({ pako: true }, htmlOpts || {})));
  const t = REPORT_WRITTEN_AT / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

async function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

/** Runs the action in-process from `dir` with the given env overrides; returns { res, out, summary, stdout }. */
async function runReport(fake, dir, envExtra, opts) {
  const cap = captureOutputs();
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, enc, cb) => { chunks.push(String(chunk)); if (typeof enc === 'function') enc(); else if (cb) cb(); return true; };
  let res;
  try {
    res = await inDir(dir, () => withEnv(actionEnv(cap, envExtra), () => run(Object.assign({ fetch: fake.fetch, sleep: fastSleep }, opts || {}))));
  } finally {
    process.stdout.write = write;
  }
  return { res, out: cap.outputs(), summary: cap.summary(), stdout: chunks.join('') };
}

/** Asynchronous spawn (the fake HTTP server lives in this process: a spawnSync would block it). */
function spawnNode(args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, Object.assign({}, opts, { stdio: ['ignore', 'pipe', 'pipe'] }));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function inboxFile(fake, p) { return fake.store.readFile(INBOX, p); }
function inboxMeta(fake, key) { return JSON.parse(String(inboxFile(fake, `reports/${RUN_ID}/${key}/meta.json`))); }

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('publishes the compressed report and meta.json to the run inbox ref; outputs and summary', async () => {
  const fake = scenario();
  const ws = workspace();
  const { res, out, summary, stdout } = await runReport(fake, ws.dir);

  assert.equal(res.exitCode, 0, stdout);
  const head = fake.store.headOf(INBOX);
  assert.ok(head, 'refs/heads/build-monitor-inbox/777 was created');
  assert.deepEqual(fake.store.listDir(INBOX, `reports/${RUN_ID}/j${JOB_ID}-s3`), ['meta.json', 'report.html']);
  const html = String(inboxFile(fake, `reports/${RUN_ID}/j${JOB_ID}-s3/report.html`));
  assert.match(html, /<script id="mvnlens-data" type="application\/json">gzip:/, 'the model block is gzip+base64');
  assert.ok(html.length < fs.statSync(ws.file).size, 'smaller than the original');

  const meta = inboxMeta(fake, `j${JOB_ID}-s3`);
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.repository, REPO);
  assert.equal(meta.serverUrl, 'https://github.com');
  assert.equal(meta.runId, RUN_ID);
  assert.equal(meta.runNumber, 42);
  assert.equal(meta.runAttempt, 1);
  assert.equal(meta.workflowRef, 'acme/widgets/.github/workflows/ci.yml@refs/heads/main');
  assert.equal(meta.jobKey, 'build');
  assert.equal(meta.jobId, JOB_ID);
  assert.equal(meta.jobName, 'build');
  assert.equal(meta.jobUrl, `https://github.com/${REPO}/actions/runs/${RUN_ID}/job/${JOB_ID}`);
  assert.equal(meta.runnerName, 'GitHub Actions 7');
  assert.equal(meta.stepNumber, 3);
  assert.equal(meta.stepName, 'Build with Maven');
  assert.equal(meta.stepResolution, 'runner/report-time');
  assert.equal(meta.label, null);
  assert.equal(meta.key, `j${JOB_ID}-s3`);
  assert.ok(Date.parse(meta.collectedAt) > Date.now() - 60000);
  assert.equal(meta.reports.length, 1);
  const rep = meta.reports[0];
  assert.equal(rep.file, 'report.html');
  assert.equal(rep.originalPath, 'target/mvnlens/report.html');
  assert.equal(rep.label, null);
  assert.equal(rep.summarySource, 'html');
  assert.equal(rep.compressed, true);
  assert.equal(rep.bytes, Buffer.byteLength(html));
  assert.equal(rep.summary.totalMs, 7975);
  assert.equal(rep.summary.modules, undefined, 'modules are dropped from the summary');
  assert.ok(rep.summary.moduleCount >= 1);

  assert.equal(out.found, 'true');
  assert.equal(out.published, 'true');
  assert.equal(out.key, `j${JOB_ID}-s3`);
  assert.equal(out['report-path'], `reports/${RUN_ID}/j${JOB_ID}-s3/report.html`);
  assert.equal(out['monitor-url'], `${SITE}#/run/${RUN_ID}`);
  assert.equal(out['report-url'], `${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3`);
  assert.equal(out['job-id'], String(JOB_ID));
  assert.equal(out['step-name'], 'Build with Maven');
  assert.equal(out['maven-total-ms'], '7975');
  assert.equal(out['commit-sha'], head);
  assert.equal(out.reason, '');
  assert.deepEqual(res.outputs, out);

  assert.match(summary, /^#### mvn-lens report — build › Build with Maven\n/);
  assert.match(summary, /Maven `clean verify` · \*\*8\.0 s\*\* total · wall 7\.6 s · CPU 903 ms · OK/);
  assert.ok(summary.includes(`[report](${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3)`), summary);
  assert.ok(summary.includes(`[monitoring](${SITE}#/run/${RUN_ID})`), summary);

  const commit = fake.store.commit(head);
  assert.equal(commit.message, 'Add mvn-lens report: build › Build with Maven');
  assert.deepEqual(commit.parents, []);
  assert.equal(commit.author.name, 'github-actions[bot]');
  assert.ok(!stdout.includes('::warning::'), stdout);
  assert.match(stdout, /re-encoded as gzip\+base64/);
});

test('a second run with identical content publishes nothing new: same commit sha, still published', async () => {
  const fake = scenario();
  const ws = workspace();
  const first = await runReport(fake, ws.dir);
  const head = fake.store.headOf(INBOX);
  const second = await runReport(fake, ws.dir);
  assert.equal(second.res.exitCode, 0);
  assert.equal(second.out.published, 'true');
  assert.equal(second.out.key, first.out.key);
  assert.equal(second.out['commit-sha'], head);
  assert.equal(fake.store.headOf(INBOX), head, 'no new commit');
  assert.equal(fake.store.commitsOf(INBOX).length, 1);
  assert.match(second.stdout, /already up to date/);
  const blobPosts = fake.calls.filter(c => c.method === 'POST' && c.path.endsWith('/git/blobs'));
  assert.equal(blobPosts.length, 2, 'report.html and meta.json were uploaded once, by the first run');
});

test('same key with different content: the key gets a -2 suffix and a warning', async () => {
  const fake = scenario();
  const ws = workspace();
  const first = await runReport(fake, ws.dir);
  assert.equal(first.out.key, `j${JOB_ID}-s3`);
  const model = fixtureModel();
  model.session.totalMs = 9999;
  writeReport(ws.file, model);
  const second = await runReport(fake, ws.dir);
  assert.equal(second.res.exitCode, 0);
  assert.equal(second.out.published, 'true');
  assert.equal(second.out.key, `j${JOB_ID}-s3-2`);
  assert.equal(second.out['report-path'], `reports/${RUN_ID}/j${JOB_ID}-s3-2/report.html`);
  assert.equal(second.out['report-url'], `${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3-2`);
  assert.match(second.stdout, /::warning::.*already exists in the inbox.*using key j7770-s3-2/);
  assert.deepEqual(fake.store.listDir(INBOX, `reports/${RUN_ID}`), [`j${JOB_ID}-s3`, `j${JOB_ID}-s3-2`]);
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3-2`).reports[0].summary.totalMs, 9999);
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3`).reports[0].summary.totalMs, 7975, 'the first set is untouched');
  assert.equal(fake.store.commitsOf(INBOX).length, 2);

  // A third, again different report → -3 (the head is re-read each time).
  model.session.totalMs = 1234;
  writeReport(ws.file, model);
  const third = await runReport(fake, ws.dir);
  assert.equal(third.out.key, `j${JOB_ID}-s3-3`);
});

test('the inbox of a run can hold reports from several jobs; each commit builds on the previous head', async () => {
  const fake = scenario();
  fake.store.seedBranch(INBOX, { [`reports/${RUN_ID}/j1-s2/report.html`]: '<html>other job</html>', [`reports/${RUN_ID}/j1-s2/meta.json`]: '{}' });
  const before = fake.store.headOf(INBOX);
  const ws = workspace();
  const { res, out } = await runReport(fake, ws.dir);
  assert.equal(res.exitCode, 0);
  assert.equal(out.published, 'true');
  assert.deepEqual(fake.store.listDir(INBOX, `reports/${RUN_ID}`), ['j1-s2', `j${JOB_ID}-s3`]);
  assert.deepEqual(fake.store.commit(out['commit-sha']).parents, [before]);
});

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

test('read-only token (fork pull request): warning with the permission hint, published=false, exit 0; fail-on-error → exit 1', async () => {
  const fake = scenario({ readOnly: true });
  const ws = workspace();
  const { res, out, summary, stdout } = await runReport(fake, ws.dir);
  assert.equal(res.exitCode, 0);
  assert.equal(out.found, 'true');
  assert.equal(out.published, 'false');
  assert.match(out.reason, /contents: write/);
  assert.match(out.reason, /Resource not accessible by integration/);
  assert.match(out.reason, /forks/);
  assert.equal(out.key, `j${JOB_ID}-s3`, 'the key was computed (job and step were located through the read API)');
  assert.equal(out['job-id'], String(JOB_ID));
  assert.equal(out['commit-sha'], '');
  assert.equal(out['monitor-url'], `${SITE}#/run/${RUN_ID}`, 'the monitoring link is still printed');
  assert.match(stdout, /::warning::.*not published.*contents: write/);
  assert.ok(!stdout.includes('::error::'));
  assert.match(summary, /^#### mvn-lens report — build › Build with Maven\n/);
  assert.match(summary, /not published: the token cannot write/);
  assert.ok(!summary.includes('[report]('), 'no viewer link for an unpublished report');
  assert.equal(fake.store.headOf(INBOX), null);

  const strict = await runReport(fake, ws.dir, { 'INPUT_FAIL-ON-ERROR': 'true' });
  assert.equal(strict.res.exitCode, 1);
  assert.equal(strict.out.published, 'false');
  assert.match(strict.stdout, /::error::.*contents: write/);
});

test('no report: if-no-files-found warn (exit 0) / error (exit 1) / ignore (exit 0); found=false, no summary', async () => {
  const fake = scenario();
  const dir = tmpDir('empty');
  const warn = await runReport(fake, dir);
  assert.equal(warn.res.exitCode, 0);
  assert.equal(warn.out.found, 'false');
  assert.equal(warn.out.published, 'false');
  assert.match(warn.out.reason, /no mvn-lens report found for target\/mvnlens\/report\.html/);
  assert.equal(warn.out.key, '');
  assert.match(warn.stdout, /::warning::.*no mvn-lens report found/);
  assert.equal(warn.summary, '');

  const err = await runReport(fake, dir, { 'INPUT_IF-NO-FILES-FOUND': 'error', INPUT_REPORT: 'nowhere/*.html' });
  assert.equal(err.res.exitCode, 1);
  assert.equal(err.out.found, 'false');
  assert.match(err.stdout, /::error::.*no mvn-lens report found for nowhere\/\*\.html/);

  const ignore = await runReport(fake, dir, { 'INPUT_IF-NO-FILES-FOUND': 'ignore' });
  assert.equal(ignore.res.exitCode, 0);
  assert.equal(ignore.out.found, 'false');
  assert.ok(!ignore.stdout.includes('::warning::') && !ignore.stdout.includes('::error::'), ignore.stdout);
  assert.equal(fake.calls.length, 0, 'no API request without a report');
  assert.equal(fake.store.headOf(INBOX), null);
});

test('a matched file without an embedded mvn-lens model is not published', async () => {
  const fake = scenario();
  const dir = tmpDir('nomodel');
  fs.mkdirSync(path.join(dir, 'target', 'mvnlens'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'target', 'mvnlens', 'report.html'), '<html><body>not a report</body></html>');
  const { res, out, stdout } = await runReport(fake, dir);
  assert.equal(res.exitCode, 0);
  assert.equal(out.found, 'false');
  assert.equal(out.published, 'false');
  assert.match(out.reason, /none embeds an mvn-lens model/);
  assert.match(stdout, /::warning::.*no embedded mvn-lens model/);
  assert.equal(fake.store.headOf(INBOX), null);
});

test('rate limit exhaustion and a lost CAS budget map to their reasons (exit 0, or 1 with fail-on-error)', async () => {
  const limited = scenario({ rateLimit: { times: 1000 } });
  const ws = workspace();
  const rl = await runReport(limited, ws.dir, null, { apiOptions: { maxRateLimitWaits: 0 } });
  assert.equal(rl.res.exitCode, 0);
  assert.equal(rl.out.found, 'true');
  assert.equal(rl.out.published, 'false');
  assert.equal(rl.out.reason, 'GitHub API rate limited');
  assert.match(rl.stdout, /::warning::.*rate limited/);

  const busy = scenario();
  busy.store.seedBranch(INBOX, { [`reports/${RUN_ID}/j1-s2/meta.json`]: '{}' });
  let races = 0;
  busy.hook(({ method, path: p }) => {
    if (method === 'PATCH' && p.includes('/git/refs/')) { races++; busy.store.seedBranch(INBOX, { [`racer-${races}.txt`]: String(races) }); }
  });
  const cas = await runReport(busy, ws.dir, null, { budgetMs: 1 });
  assert.equal(cas.res.exitCode, 0);
  assert.equal(cas.out.published, 'false');
  assert.equal(cas.out.reason, 'could not commit within the time budget');
  assert.ok(races >= 1, 'at least one ref update raced');
  assert.equal(busy.store.readFile(INBOX, `reports/${RUN_ID}/j${JOB_ID}-s3/report.html`), null);

  const strict = await runReport(busy, ws.dir, { 'INPUT_FAIL-ON-ERROR': 'true' }, { budgetMs: 1 });
  assert.equal(strict.res.exitCode, 1);
  assert.match(strict.stdout, /::error::.*could not commit within the time budget/);
});

test('an invalid inbox-prefix is reported as a reason (warning; error with fail-on-error), never thrown', async () => {
  const fake = scenario();
  const ws = workspace();
  const { res, out } = await runReport(fake, ws.dir, { 'INPUT_INBOX-PREFIX': 'bad prefix' });
  assert.equal(res.exitCode, 0);
  assert.equal(out.found, 'true');
  assert.equal(out.published, 'false');
  assert.match(out.reason, /inbox-prefix/);
  const strict = await runReport(fake, ws.dir, { 'INPUT_INBOX-PREFIX': 'bad prefix', 'INPUT_FAIL-ON-ERROR': 'true' });
  assert.equal(strict.res.exitCode, 1);
});

test('outside a workflow run (no GITHUB_REPOSITORY / GITHUB_RUN_ID): found, not published, clear reason, exit 0', async () => {
  const fake = scenario();
  const ws = workspace();
  const { res, out, stdout } = await runReport(fake, ws.dir, { GITHUB_REPOSITORY: null, GITHUB_RUN_ID: null, 'INPUT_FAIL-ON-ERROR': 'true' });
  assert.equal(res.exitCode, 0, 'a local run is not a failure even with fail-on-error');
  assert.equal(out.found, 'true');
  assert.equal(out.published, 'false');
  assert.match(out.reason, /GITHUB_REPOSITORY \/ GITHUB_RUN_ID/);
  assert.equal(out['maven-total-ms'], '7975');
  assert.equal(out['monitor-url'], '');
  assert.equal(out.key, '');
  assert.equal(fake.calls.length, 0);
  assert.match(stdout, /Maven clean verify/);
  assert.ok(!stdout.includes('::error::'));

  const noToken = await runReport(fake, ws.dir, { 'INPUT_GITHUB-TOKEN': '' });
  assert.equal(noToken.res.exitCode, 0);
  assert.equal(noToken.out.published, 'false');
  assert.match(noToken.out.reason, /github-token is empty/);
  assert.match(noToken.stdout, /::warning::/);
});

// ---------------------------------------------------------------------------
// Attribution, labels, options
// ---------------------------------------------------------------------------

test('attribution: explicit job-name (+ step-name), runner name, and an unresolved job → "<job key>-<random>" key', async () => {
  const fake = scenario();
  const ws = workspace();

  const byName = await runReport(fake, ws.dir, { RUNNER_NAME: 'somewhere else', GITHUB_JOB: 'zzz', 'INPUT_JOB-NAME': 'build', 'INPUT_STEP-NAME': 'Build with Maven' });
  assert.equal(byName.out.key, `j${JOB_ID}-s3`);
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3`).stepResolution, 'job-name/step-name');
  assert.equal(byName.out['step-name'], 'Build with Maven');

  const byRunner = await runReport(fake, ws.dir, { GITHUB_JOB: 'zzz', INPUT_LABEL: 'runner' });
  assert.equal(byRunner.out.key, `j${JOB_ID}-s3-runner`);
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3-runner`).stepResolution, 'runner/report-time');

  const byKey = await runReport(fake, ws.dir, { RUNNER_NAME: 'somewhere else', INPUT_LABEL: 'key' });
  assert.equal(byKey.out.key, `j${JOB_ID}-s3-key`);
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3-key`).stepResolution, 'job-key/report-time');

  const lost = await runReport(fake, ws.dir, { RUNNER_NAME: 'somewhere else', GITHUB_JOB: 'Java (25)', 'INPUT_STEP-NAME': 'Build with Maven' });
  assert.equal(lost.res.exitCode, 0);
  assert.equal(lost.out.published, 'true', 'an unattributed report is still published');
  assert.match(lost.out.key, /^Java-25-[0-9a-z]{6}$/, lost.out.key);
  assert.equal(lost.out['job-id'], '');
  assert.equal(lost.out['step-name'], 'Build with Maven', 'the step-name input is echoed even when unresolved');
  const meta = inboxMeta(fake, lost.out.key);
  assert.equal(meta.jobId, null);
  assert.equal(meta.jobName, null);
  assert.equal(meta.jobKey, 'Java (25)');
  assert.equal(meta.stepNumber, null);
  assert.equal(meta.stepName, 'Build with Maven');
  assert.equal(meta.stepResolution, 'job-not-found');
  assert.match(lost.stdout, /::warning::.*could not identify this job/);
  assert.match(lost.summary, /^#### mvn-lens report — Java \(25\) › Build with Maven\n/);
  assert.equal(fake.store.commit(lost.out['commit-sha']).message, 'Add mvn-lens report: Java (25) › Build with Maven');
});

test('label: appended to the key (sanitised) and recorded verbatim in meta.json', async () => {
  const fake = scenario();
  const ws = workspace();
  const { out } = await runReport(fake, ws.dir, { INPUT_LABEL: 'integration tests' });
  assert.equal(out.key, `j${JOB_ID}-s3-integration-tests`);
  assert.equal(out['report-url'], `${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3-integration-tests`);
  const meta = inboxMeta(fake, out.key);
  assert.equal(meta.label, 'integration tests');
  assert.equal(meta.key, out.key);
});

test('several matches: report.html + report-2.html in one key with distinguishing labels; extra files never move the key', async () => {
  const fake = scenario();
  const dir = tmpDir('multi');
  writeReport(path.join(dir, 'core', 'target', 'mvnlens', 'report.html'));
  const m2 = fixtureModel();
  m2.session.totalMs = 4242;
  writeReport(path.join(dir, 'web', 'target', 'mvnlens', 'report.html'), m2);
  const { res, out, summary } = await runReport(fake, dir, { INPUT_REPORT: '**/target/mvnlens/report.html' });
  assert.equal(res.exitCode, 0);
  assert.equal(out.published, 'true');
  assert.equal(out.key, `j${JOB_ID}-s3`);
  assert.equal(out['maven-total-ms'], '7975', 'the first match is the primary report');
  assert.deepEqual(fake.store.listDir(INBOX, `reports/${RUN_ID}/j${JOB_ID}-s3`), ['meta.json', 'report-2.html', 'report.html']);
  const meta = inboxMeta(fake, `j${JOB_ID}-s3`);
  assert.deepEqual(meta.reports.map(r => [r.file, r.originalPath, r.label, r.summary.totalMs]), [
    ['report.html', 'core/target/mvnlens/report.html', 'core', 7975],
    ['report-2.html', 'web/target/mvnlens/report.html', 'web', 4242],
  ]);
  assert.match(summary, /^#### mvn-lens reports — /);
  assert.match(summary, /2 reports/);

  // Comma-separated list, same files → identical set, nothing new.
  const again = await runReport(fake, dir, { INPUT_REPORT: 'core/target/mvnlens/report.html, web/target/mvnlens/report.html' });
  assert.equal(again.out.key, `j${JOB_ID}-s3`);
  assert.equal(again.out['commit-sha'], out['commit-sha']);
});

test('compress: false publishes the original bytes; a report without pako is published as is', async () => {
  const fake = scenario();
  const ws = workspace();
  const plain = await runReport(fake, ws.dir, { INPUT_COMPRESS: 'false' });
  assert.equal(plain.out.published, 'true');
  const stored = inboxFile(fake, `reports/${RUN_ID}/j${JOB_ID}-s3/report.html`);
  assert.ok(Buffer.compare(stored, fs.readFileSync(ws.file)) === 0, 'byte-identical');
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3`).reports[0].compressed, false);
  assert.match(plain.stdout, /compression disabled/);

  // No pako in the renderer → compressReportHtml declines, the reason is logged, the report is still published.
  const noPako = workspace(null, { pako: false });
  const kept = await runReport(fake, noPako.dir, { INPUT_LABEL: 'nopako' });
  assert.equal(kept.out.published, 'true');
  assert.match(kept.stdout, /not compressed \(renderer has no gzip decoder\)/);
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3-nopako`).reports[0].compressed, false);
  assert.ok(!String(inboxFile(fake, `reports/${RUN_ID}/j${JOB_ID}-s3-nopako/report.html`)).includes('gzip:'));
});

test('the repository sample report with label "sample" (what the CI self-test publishes)', async () => {
  const fake = scenario();
  const { res, out } = await runReport(fake, ROOT, { INPUT_REPORT: 'test/fixtures/sample-report/report.html', INPUT_LABEL: 'sample' });
  assert.equal(res.exitCode, 0);
  assert.equal(out.found, 'true');
  assert.equal(out.published, 'true');
  assert.equal(out.key, `j${JOB_ID}-s3-sample`);
  assert.equal(out['maven-total-ms'], '7975');
  const meta = inboxMeta(fake, out.key);
  assert.equal(meta.reports[0].compressed, false, 'the sample has no pako: left alone');
  assert.equal(meta.reports[0].originalPath, 'test/fixtures/sample-report/report.html');
});

test('site-url input and inbox-prefix input are honoured', async () => {
  const fake = scenario();
  const ws = workspace();
  const { out } = await runReport(fake, ws.dir, { 'INPUT_SITE-URL': 'https://ci.example.org/monitor', 'INPUT_INBOX-PREFIX': 'refs/heads/ci-inbox' });
  assert.equal(out.published, 'true');
  assert.equal(out['monitor-url'], `https://ci.example.org/monitor/#/run/${RUN_ID}`);
  assert.equal(out['report-url'], `https://ci.example.org/monitor/#/report/${RUN_ID}/j${JOB_ID}-s3`);
  assert.ok(fake.store.headOf(`ci-inbox/${RUN_ID}`), 'committed under the custom prefix');
  assert.equal(fake.store.headOf(INBOX), null);
  assert.ok(!fake.calls.some(c => c.path.endsWith('/pages')), 'no Pages lookup when site-url is given');
});

test('the token never appears in outputs, the job summary or the log', async () => {
  const fake = scenario();
  const ws = workspace();
  const ok = await runReport(fake, ws.dir);
  const denied = await runReport(scenario({ readOnly: true }), ws.dir, { 'INPUT_FAIL-ON-ERROR': 'true' });
  for (const r of [ok, denied]) {
    const text = JSON.stringify(r.out) + r.summary + r.stdout;
    assert.ok(!text.includes(TOKEN), 'token leaked: ' + text.slice(0, 500));
  }
  assert.ok(fake.calls.every(c => c.headers.authorization === `Bearer ${TOKEN}`), 'every request carried the token');
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('keyFor: job/step keys, random keys from the job key, sanitised labels, always a valid key', () => {
  const { isValidKey } = require('../src/history');
  assert.equal(keyFor({ job: { id: 12 }, step: { number: 5 } }, 'build', null), 'j12-s5');
  assert.equal(keyFor({ job: { id: 12 }, step: null }, 'build', 'x'), 'j12-x');
  assert.equal(keyFor({ job: { id: 12 }, step: { number: 5 } }, 'build', 'Java 25 / linux'), 'j12-s5-Java-25-linux');
  assert.equal(keyFor({ job: { id: 12 }, step: { number: 5 } }, 'build', '../..'), 'j12-s5', 'a label without safe characters is dropped from the key');
  assert.match(keyFor({ job: null, step: null }, 'build', null), /^build-[0-9a-z]{6}$/);
  assert.match(keyFor({ job: null, step: null }, null, null), /^job-[0-9a-z]{6}$/);
  assert.match(keyFor({ job: null, step: null }, '_private job', 'L'), /^private-job-[0-9a-z]{6}-L$/);
  assert.match(keyFor({ job: null, step: null }, '.', null), /^job-[0-9a-z]{6}$/, 'a job key without safe characters falls back to "job"');
  for (const k of [keyFor({ job: null }, 'x'.repeat(200), 'y'.repeat(200)), keyFor({ job: { id: 1 }, step: { number: 2 } }, null, '...---___')]) {
    assert.ok(isValidKey(k) && /^[A-Za-z0-9]/.test(k), k);
  }
  const keys = new Set();
  for (let i = 0; i < 50; i++) keys.add(keyFor({ job: null }, 'b', null));
  assert.equal(keys.size, 50, 'random suffixes differ');
});

test('reportLabels: grand-parent directory names, or the first ancestor level that tells the files apart', () => {
  assert.deepEqual(reportLabels(['/w/a/target/mvnlens/report.html', '/w/b/target/mvnlens/report.html']), ['a', 'b']);
  assert.deepEqual(reportLabels(['/w/target/mvnlens/report.html', '/w/target/scenario/report.html']), ['mvnlens', 'scenario'], 'only the parent differs');
  assert.deepEqual(reportLabels(['/w/x/one/r.html', '/w/y/two/r.html']), ['x', 'y']);
  assert.deepEqual(reportLabels(['/w/same/deep/r1.html', '/w/same/deep/r2.html']), ['same', 'same']);
});

test('describeFailure: permission / rate-limit / conflict reasons, anything else is unexpected', () => {
  const perm = describeFailure(new GitStoreError('permission', 'create blob in acme/widgets: Resource not accessible by integration (HTTP 403)'));
  assert.match(perm.reason, /Resource not accessible by integration/);
  assert.match(perm.reason, /grant contents: write to this job \(pull requests from forks have a read-only token\)/);
  assert.equal(perm.unexpected, false);
  assert.deepEqual(describeFailure(new GitStoreError('rate-limit', 'x')).reason, 'GitHub API rate limited');
  assert.deepEqual(describeFailure(new GitStoreError('conflict', 'x')).reason, 'could not commit within the time budget');
  assert.equal(describeFailure(new GitStoreError('other', 'repository has no commits yet')).unexpected, true);
  assert.equal(describeFailure(new TypeError('boom')).reason, 'boom');
  assert.equal(describeFailure(new TypeError('boom')).unexpected, true);
});

// ---------------------------------------------------------------------------
// Spawn: the real entry point against the fake over HTTP
// ---------------------------------------------------------------------------

test('report/index.js runs as a process against fake.serve(): GITHUB_OUTPUT and exit codes', async () => {
  const fake = scenario();
  const { url, close } = await fake.serve();
  try {
    const ws = workspace();
    const cap = captureOutputs();
    const runAction = (extra) => {
      const env = Object.assign({}, process.env, actionEnv(cap, Object.assign({ GITHUB_API_URL: url }, extra || {})));
      for (const k of Object.keys(env)) if (env[k] === null || env[k] === undefined) delete env[k];
      return spawnNode([path.join(ROOT, 'report', 'index.js')], { cwd: ws.dir, env });
    };
    const ok = await runAction();
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const out = cap.outputs();
    assert.equal(out.found, 'true');
    assert.equal(out.published, 'true');
    assert.equal(out.key, `j${JOB_ID}-s3`);
    assert.equal(out['commit-sha'], fake.store.headOf(INBOX));
    assert.equal(out['report-url'], `${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3`);
    assert.match(String(inboxFile(fake, `reports/${RUN_ID}/j${JOB_ID}-s3/report.html`)), /gzip:/);
    assert.match(cap.summary(), /#### mvn-lens report — build › Build with Maven/);
    assert.ok(!ok.stdout.includes(TOKEN) && !ok.stderr.includes(TOKEN));

    cap.reset();
    fake.opts.readOnly = true;
    const denied = await runAction({ 'INPUT_FAIL-ON-ERROR': 'true', INPUT_LABEL: 'again' });
    assert.equal(denied.status, 1, denied.stdout + denied.stderr);
    assert.equal(cap.outputs().published, 'false');
    assert.match(cap.outputs().reason, /contents: write/);
    assert.match(denied.stdout, /::error::/);
  } finally {
    await close();
  }
});
