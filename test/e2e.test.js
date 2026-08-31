/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * The whole chain against ONE fake GitHub, in the order a real run goes
 * through it: two build jobs of run 300 publish their reports with the
 * `report` action (in-process, from their own workspaces), the final job
 * writes the `summary`, then the processor (a workflow_run event) grafts the
 * inbox into gh-pages together with data/history.json and index.html — and
 * the site's model reads that history back to the very GitHub step.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const report = require('../src/report');
const summary = require('../src/summary');
const main = require('../src/main');
const { fmtMs } = require('../src/util');
const { summarizeModel } = require('../src/mvnlens');
const M = require('../site/model');
const { createFakeGitHub } = require('./fake-github');
const { tmpDir, fakeReportHtml, fixtureModel, fakeRun, withEnv, captureOutputs } = require('./helpers');

const REPO = 'acme/widgets';
const SERVER = 'https://github.com';
const SITE = 'https://acme.github.io/widgets/';
const RUN_ID = 300;
const JAVA = 3001;
const JAVADOC = 3002;
const MONITORING = 3003;
const INBOX = `build-monitor-inbox/${RUN_ID}`;
const TOKEN = 'ghs_e2e_secret_token_never_printed';
const WORKFLOWS = [
  { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  { id: 2, name: 'Build monitor', path: '.github/workflows/build-monitor.yml', state: 'active' },
];
/** The run started 10 minutes ago; every step time below is seconds after BASE. */
const BASE = Date.now() - 600000;
const JAVA_REPORT_AT = BASE + 100000;      // inside "Build with Maven" (6 s … 126 s)
const JAVADOC_REPORT_AT = BASE + 40000;    // inside "Generate Javadoc" (6 s … 66 s)
const fastSleep = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------------------
// The run, as the Jobs API would show it once everything has completed, and
// the phases it goes through (jobs are mutated in place: the fake serves the
// live objects).
// ---------------------------------------------------------------------------

function finalRun() {
  return fakeRun({
    id: RUN_ID, baseMs: BASE, repository: REPO, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: 300,
    jobs: [
      { id: JAVA, name: 'Java 25 (ubuntu-latest)', runnerName: 'GitHub Actions 21', steps: [
        { number: 1, name: 'Set up job', start: 2, end: 4 },
        { number: 2, name: 'Run actions/checkout@v7', start: 4, end: 6 },
        { number: 3, name: 'Build with Maven', start: 6, end: 126 },
        { number: 4, name: 'Publish mvn-lens report', start: 126, end: 130 },
        { number: 8, name: 'Complete job', start: 130, end: 131 },
      ] },
      { id: JAVADOC, name: 'Javadoc', runnerName: 'GitHub Actions 22', steps: [
        { number: 1, name: 'Set up job', start: 2, end: 4 },
        { number: 2, name: 'Run actions/checkout@v7', start: 4, end: 6 },
        { number: 3, name: 'Generate Javadoc', start: 6, end: 66 },
        { number: 4, name: 'Publish mvn-lens report', start: 66, end: 70 },
        { number: 8, name: 'Complete job', start: 70, end: 71 },
      ] },
      { id: MONITORING, name: 'Monitoring', runnerName: 'GitHub Actions 23', start: 140, steps: [
        { number: 1, name: 'Set up job', start: 140, end: 142 },
        { number: 2, name: 'Run mvn-perf/build-monitor/summary@main', start: 142, end: 150 },
        { number: 6, name: 'Complete job', start: 150, end: 151 },
      ] },
    ],
  });
}

const FINAL = finalRun();
const clone = (o) => JSON.parse(JSON.stringify(o));
/** Completed snapshot of every job by id (a re-run job registers its own). */
const FINAL_JOBS = new Map(FINAL.jobs.map(j => [j.id, j]));

/** Puts a live job in one of its states: 'queued', running at step `at` ('running'), or 'done' (the final snapshot). */
function jobState(live, id, state, at) {
  const job = live.jobs.find(j => j.id === id);
  const final = FINAL_JOBS.get(id);
  if (state === 'done') { Object.assign(job, clone(final)); return; }
  if (state === 'queued') { Object.assign(job, { status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] }); return; }
  Object.assign(job, {
    status: 'in_progress', conclusion: null, completed_at: null,
    steps: final.steps.map(s => {
      if (s.number < at) return clone(s);
      if (s.number === at) return Object.assign(clone(s), { status: 'in_progress', conclusion: null, completed_at: null });
      return Object.assign(clone(s), { status: 'queued', conclusion: null, started_at: null, completed_at: null });
    }),
  });
}

function runState(live, state) {
  if (state === 'done') Object.assign(live, { status: 'completed', conclusion: 'success', updated_at: FINAL.updated_at });
  else Object.assign(live, { status: 'in_progress', conclusion: null, updated_at: new Date(BASE + 60000).toISOString() });
}

// ---------------------------------------------------------------------------
// Environment and process plumbing
// ---------------------------------------------------------------------------

const INPUT_NAMES = [
  'report', 'step-name', 'job-name', 'label', 'github-token', 'inbox-prefix', 'site-url', 'compress', 'if-no-files-found', 'fail-on-error', 'commit-message',
  'title', 'repository', 'branch', 'site-dir', 'workflows', 'exclude-workflows', 'include-self', 'run-id', 'sweep-runs', 'lookback-days',
  'include-fork-runs', 'concurrency', 'request-pages-build', 'dry-run', 'output-dir',
];
/** Every input of the three actions unset, in both spellings (the machine running the tests may carry some). */
const NO_INPUTS = {};
for (const n of INPUT_NAMES) { NO_INPUTS['INPUT_' + n.toUpperCase()] = null; NO_INPUTS['INPUT_' + n.toUpperCase().replace(/-/g, '_')] = null; }

/** The environment of a job of the CI run (null = unset). */
function ciEnv(cap, extra) {
  return Object.assign({
    GITHUB_ACTIONS: null, RUNNER_DEBUG: null, BUILD_MONITOR_DEBUG: null, GITHUB_TOKEN: null, GITHUB_EVENT_PATH: null,
    GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: SERVER, GITHUB_API_URL: 'https://api.github.com',
    GITHUB_RUN_ID: String(RUN_ID), GITHUB_RUN_NUMBER: '300', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW: 'CI', GITHUB_EVENT_NAME: 'push',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, GITHUB_JOB: null, RUNNER_NAME: null,
  }, NO_INPUTS, { 'INPUT_GITHUB-TOKEN': TOKEN }, cap.env, extra || {});
}

/** The environment of the processor's own workflow run, triggered by the workflow_run event in `eventPath`. */
function processorEnv(cap, eventPath, extra) {
  return ciEnv(cap, Object.assign({
    GITHUB_RUN_ID: '999', GITHUB_RUN_NUMBER: '7', GITHUB_JOB: 'monitor', GITHUB_WORKFLOW: 'Build monitor',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/build-monitor.yml@refs/heads/main`,
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath,
  }, extra || {}));
}

/** Captures everything written to stdout while fn runs (annotations, logs); restored afterwards. */
async function quietly(fn) {
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, enc, cb) => { chunks.push(String(chunk)); if (typeof enc === 'function') enc(); else if (cb) cb(); return true; };
  try {
    const result = await fn();
    return { result, stdout: chunks.join('') };
  } finally {
    process.stdout.write = write;
  }
}

async function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

/** A job workspace holding target/mvnlens/report.html, written at `writtenAt` (ms) by the Maven step. */
function workspace(model, writtenAt) {
  const dir = tmpDir('e2e');
  const file = path.join(dir, 'target', 'mvnlens', 'report.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fakeReportHtml(model, { pako: true }));
  fs.utimesSync(file, writtenAt / 1000, writtenAt / 1000);
  return { dir, file };
}

async function runReport(fake, ws, envExtra) {
  const cap = captureOutputs();
  const { result, stdout } = await quietly(() => inDir(ws.dir, () => withEnv(ciEnv(cap, envExtra), () => report.run({ fetch: fake.fetch, sleep: fastSleep }))));
  return { res: result, out: cap.outputs(), summary: cap.summary(), stdout };
}

async function runSummary(fake, envExtra) {
  const cap = captureOutputs();
  const { result, stdout } = await quietly(() => withEnv(ciEnv(cap, envExtra), () => summary.run({ fetch: fake.fetch, sleep: fastSleep })));
  return { res: result, out: cap.outputs(), summary: cap.summary(), stdout };
}

async function runProcessor(fake, eventPath, envExtra) {
  const cap = captureOutputs();
  const { result, stdout } = await quietly(() => withEnv(processorEnv(cap, eventPath, envExtra), () => main.run({ fetch: fake.fetch, sleep: fastSleep })));
  return { res: result, out: cap.outputs(), summary: cap.summary(), stdout };
}

function eventFile(live) {
  const wr = {
    id: live.id, run_attempt: live.run_attempt, status: 'completed', conclusion: live.conclusion, event: live.event,
    workflow_id: live.workflow_id, name: live.name, path: live.path, head_branch: live.head_branch, head_sha: live.head_sha,
    head_repository: { full_name: live.head_repository.full_name }, html_url: live.html_url,
  };
  const file = path.join(tmpDir('e2e-event'), 'event.json');
  fs.writeFileSync(file, JSON.stringify({ action: 'completed', workflow_run: wr, workflow: { id: wr.workflow_id, name: wr.name, path: wr.path } }));
  return file;
}

const tableRows = md => md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Job ') && !l.startsWith('|---'));
const jobUrl = id => `${SERVER}/${REPO}/actions/runs/${RUN_ID}/job/${id}`;
const stepLink = (id, n) => `[GitHub step ↗](${jobUrl(id)}#step:${n}:1)`;
const viewer = key => `${SITE}#/report/${RUN_ID}/${key}`;
const jobDuration = id => { const j = FINAL.jobs.find(x => x.id === id); return fmtMs(Date.parse(j.completed_at) - Date.parse(j.started_at)); };

function assertClean(stdout, what) {
  assert.ok(!stdout.includes('::error::'), `${what}: no error annotation expected:\n${stdout}`);
  assert.ok(!stdout.includes('::warning::'), `${what}: no warning expected:\n${stdout}`);
  assert.ok(!stdout.includes(TOKEN), `${what}: the token must never be printed`);
}

// ---------------------------------------------------------------------------

test('report (two jobs) → summary (final job) → build-monitor (workflow_run): one run, one fake GitHub, one site', async (t) => {
  const live = clone(FINAL);
  const fake = createFakeGitHub({ repository: REPO, workflows: WORKFLOWS, runs: [live], pages: { html_url: SITE } });
  const javaModel = fixtureModel();
  const javadocModel = fixtureModel();
  javadocModel.session.totalMs = 12345;
  javadocModel.session.goals = ['javadoc:javadoc'];
  const javaKey = `j${JAVA}-s3`;
  const javadocKey = `j${JAVADOC}-s3`;
  const inboxFiles = {};   // what the report steps committed, byte for byte
  let javaReport;
  let javadocReport;

  await t.test('job 1 (Java 25) publishes its compressed report to the inbox ref, attributed by job-name', async () => {
    runState(live, 'running');
    jobState(live, JAVA, 'running', 4);
    jobState(live, JAVADOC, 'running', 4);
    jobState(live, MONITORING, 'queued');
    const ws = workspace(javaModel, JAVA_REPORT_AT);
    javaReport = await runReport(fake, ws, { GITHUB_JOB: 'java', RUNNER_NAME: 'GitHub Actions 21', 'INPUT_JOB-NAME': 'Java 25 (ubuntu-latest)' });
    assertClean(javaReport.stdout, 'report job 1');
    assert.equal(javaReport.res.exitCode, 0);
    assert.equal(javaReport.out.found, 'true');
    assert.equal(javaReport.out.published, 'true');
    assert.equal(javaReport.out.key, javaKey);
    assert.equal(javaReport.out['job-id'], String(JAVA));
    assert.equal(javaReport.out['step-name'], 'Build with Maven');
    assert.equal(javaReport.out['report-path'], `reports/${RUN_ID}/${javaKey}/report.html`);
    assert.equal(javaReport.out['monitor-url'], `${SITE}#/run/${RUN_ID}`);
    assert.equal(javaReport.out['report-url'], viewer(javaKey));
    assert.equal(javaReport.out['maven-total-ms'], String(javaModel.session.totalMs));
    assert.equal(javaReport.out['commit-sha'], fake.store.headOf(INBOX));
    assert.ok(javaReport.summary.includes(`[report](${viewer(javaKey)})`) && javaReport.summary.includes(`[monitoring](${SITE}#/run/${RUN_ID})`), javaReport.summary);

    const html = fake.store.readFile(INBOX, `reports/${RUN_ID}/${javaKey}/report.html`);
    assert.ok(html, 'report.html is in the inbox');
    assert.match(String(html), /<script id="mvnlens-data" type="application\/json">gzip:/, 'the model block is gzip+base64');
    assert.ok(html.length < fs.statSync(ws.file).size, 'smaller than the file on disk');
    const meta = JSON.parse(String(fake.store.readFile(INBOX, `reports/${RUN_ID}/${javaKey}/meta.json`)));
    assert.equal(meta.jobId, JAVA);
    assert.equal(meta.jobName, 'Java 25 (ubuntu-latest)');
    assert.equal(meta.stepNumber, 3);
    assert.equal(meta.stepName, 'Build with Maven');
    assert.equal(meta.stepResolution, 'job-name/report-time');
    assert.equal(meta.runAttempt, 1);
    assert.equal(meta.reports[0].compressed, true);
    assert.equal(meta.reports[0].bytes, html.length);
    inboxFiles[`${javaKey}/report.html`] = html;
    inboxFiles[`${javaKey}/meta.json`] = fake.store.readFile(INBOX, `reports/${RUN_ID}/${javaKey}/meta.json`);
  });

  await t.test('job 2 (Javadoc) publishes on top of job 1\'s commit, attributed by runner name', async () => {
    jobState(live, JAVA, 'done');   // job 1 has finished meanwhile; job 2 is at its publish step
    const before = fake.store.headOf(INBOX);
    const ws = workspace(javadocModel, JAVADOC_REPORT_AT);
    javadocReport = await runReport(fake, ws, { GITHUB_JOB: 'javadoc', RUNNER_NAME: 'GitHub Actions 22' });
    assertClean(javadocReport.stdout, 'report job 2');
    assert.equal(javadocReport.res.exitCode, 0);
    assert.equal(javadocReport.out.published, 'true');
    assert.equal(javadocReport.out.key, javadocKey);
    assert.equal(javadocReport.out['job-id'], String(JAVADOC));
    assert.equal(javadocReport.out['step-name'], 'Generate Javadoc');
    assert.equal(javadocReport.out['maven-total-ms'], '12345');
    assert.equal(javadocReport.out['monitor-url'], javaReport.out['monitor-url'], 'both jobs print the same monitoring link');
    const head = fake.store.headOf(INBOX);
    assert.deepEqual(fake.store.commit(head).parents, [before], 'a child of job 1\'s commit (compare-and-swap on the shared ref)');
    assert.deepEqual(fake.store.commitsOf(INBOX).length, 2);
    assert.deepEqual(fake.store.listDir(INBOX, `reports/${RUN_ID}`), [javaKey, javadocKey]);
    assert.ok(fake.store.readFile(INBOX, `reports/${RUN_ID}/${javaKey}/report.html`).equals(inboxFiles[`${javaKey}/report.html`]), 'job 1\'s report untouched');
    const meta = JSON.parse(String(fake.store.readFile(INBOX, `reports/${RUN_ID}/${javadocKey}/meta.json`)));
    assert.equal(meta.jobId, JAVADOC);
    assert.equal(meta.stepNumber, 3);
    assert.equal(meta.stepResolution, 'runner/report-time');
    assert.equal(meta.reports[0].summary.totalMs, 12345);
    inboxFiles[`${javadocKey}/report.html`] = fake.store.readFile(INBOX, `reports/${RUN_ID}/${javadocKey}/report.html`);
    inboxFiles[`${javadocKey}/meta.json`] = fake.store.readFile(INBOX, `reports/${RUN_ID}/${javadocKey}/meta.json`);
  });

  await t.test('the final job writes the monitoring link and one row per job with viewer + step links', async () => {
    jobState(live, JAVADOC, 'done');
    jobState(live, MONITORING, 'running', 2);
    const mark = fake.calls.length;
    const r = await runSummary(fake, { GITHUB_JOB: 'monitoring', RUNNER_NAME: 'GitHub Actions 23' });
    assertClean(r.stdout, 'summary');
    assert.equal(r.res.exitCode, 0);
    assert.equal(r.out['monitor-url'], `${SITE}#/run/${RUN_ID}`);
    assert.equal(r.out['monitor-url'], javaReport.out['monitor-url'], 'the summary links what the report steps linked');
    assert.equal(r.out['reports-count'], '2');
    const md = r.summary;
    assert.match(md, /^## Build monitoring\n/);
    assert.ok(md.includes(`**[Open this run in the monitoring page ↗](${SITE}#/run/${RUN_ID})** · [mvn-lens reports](${SITE}#/reports) · [Builds](${SITE}#/builds)`), md);
    assert.deepEqual(tableRows(md), [
      `| Java 25 (ubuntu-latest) | ✅ success | ${jobDuration(JAVA)} | 8.0 s · OK | [report](${viewer(javaKey)}) · ${stepLink(JAVA, 3)} |`,
      `| Javadoc | ✅ success | ${jobDuration(JAVADOC)} | 12.3 s · OK | [report](${viewer(javadocKey)}) · ${stepLink(JAVADOC, 3)} |`,
      '| Monitoring | ⏳ this job | — | — | — |',
    ]);
    assert.ok(md.includes(`[report](${javaReport.out['report-url']})`), 'the viewer link equals the report step\'s report-url output');
    assert.ok(md.includes(`[Build monitor ↗](${SERVER}/${REPO}/actions/workflows/build-monitor.yml)`), md);
    assert.ok(!md.includes('⚠️'), md);
    assert.ok(!md.includes(TOKEN));
    assert.deepEqual(fake.calls.slice(mark).filter(c => c.method !== 'GET'), [], 'the summary is read-only');
    assert.ok(fake.store.refs.has(`refs/heads/${INBOX}`), 'the inbox ref is left for the processor');
  });

  let hist;
  let event;
  await t.test('workflow_run: the processor grafts both report sets into gh-pages, writes the history, deletes the inbox ref', async () => {
    runState(live, 'done');
    jobState(live, MONITORING, 'done');
    event = eventFile(live);
    const mark = fake.calls.length;
    const r = await runProcessor(fake, event);
    assertClean(r.stdout, 'processor');
    assert.equal(r.res.exitCode, 0);
    assert.equal(r.out.published, 'true');
    assert.equal(r.out['site-url'], SITE);
    assert.equal(r.out['runs-processed'], '1');
    assert.equal(r.out['runs-total'], '1');
    assert.equal(r.out['reports-collected'], '2');
    assert.equal(r.out['commit-sha'], fake.store.headOf('gh-pages'));
    const bytes = inboxFiles[`${javaKey}/report.html`].length + inboxFiles[`${javadocKey}/report.html`].length;
    assert.equal(r.out['reports-bytes'], String(bytes));
    assert.deepEqual(r.res.outputs, r.out);

    // gh-pages: the site files plus the two report sets, byte-identical to what the report steps committed.
    assert.deepEqual(fake.store.listDir('gh-pages', ''), ['.nojekyll', 'data', 'index.html', 'reports']);
    assert.deepEqual(fake.store.listDir('gh-pages', `reports/${RUN_ID}`), [javaKey, javadocKey]);
    for (const [file, content] of Object.entries(inboxFiles)) {
      const onSite = fake.store.readFile('gh-pages', `reports/${RUN_ID}/${file}`);
      assert.ok(onSite && onSite.equals(content), `${file} grafted byte-identical`);
    }
    assert.ok(String(fake.store.readFile('gh-pages', 'index.html')).includes('<script id="build-monitor-data" type="application/json"></script>'), 'index.html without inline data');
    assert.equal(String(fake.store.readFile('gh-pages', '.nojekyll')), '');
    assert.equal(fake.calls.slice(mark).filter(c => c.method === 'POST' && c.path.endsWith('/git/blobs')).length, 3, 'only history.json, index.html and .nojekyll were uploaded — the reports were grafted by sha');
    assert.equal(fake.calls.slice(mark).filter(c => c.method === 'POST' && c.path === `/repos/${REPO}/pages/builds`).length, 1, 'one Pages build requested');
    assert.equal(fake.store.refs.has(`refs/heads/${INBOX}`), false, 'the inbox ref is gone');
    assert.ok(fake.store.refs.has('refs/heads/gh-pages'));
    assert.ok(r.summary.includes(`[CI #300](${SITE}#/run/${RUN_ID})`), r.summary);

    // The history links each report to the right job and step.
    hist = JSON.parse(String(fake.store.readFile('gh-pages', 'data/history.json')));
    assert.equal(hist.schemaVersion, 1);
    assert.equal(hist.repository, REPO);
    assert.equal(hist.serverUrl, SERVER);
    assert.equal(hist.siteUrl, SITE);
    assert.deepEqual(hist.stats, { reportsCount: 2, reportsBytes: bytes });
    assert.deepEqual(Object.keys(hist.workflows), ['1']);
    assert.equal(hist.runs.length, 1);
    const run = hist.runs[0];
    assert.equal(run.id, RUN_ID);
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'success');
    assert.deepEqual(run.jobs.map(j => j.id), [JAVA, JAVADOC, MONITORING]);
    assert.equal(run.mvnLens.length, 2);
    const expect = [
      { key: javaKey, jobId: JAVA, jobName: 'Java 25 (ubuntu-latest)', stepName: 'Build with Maven', totalMs: javaModel.session.totalMs },
      { key: javadocKey, jobId: JAVADOC, jobName: 'Javadoc', stepName: 'Generate Javadoc', totalMs: 12345 },
    ];
    for (const x of expect) {
      const e = run.mvnLens.find(y => y.key === x.key);
      assert.ok(e, `entry ${x.key}`);
      assert.equal(e.dir, `reports/${RUN_ID}/${x.key}`);
      assert.equal(e.path, `reports/${RUN_ID}/${x.key}/report.html`);
      assert.equal(e.jobId, x.jobId);
      assert.equal(e.jobName, x.jobName);
      assert.equal(e.jobUrl, jobUrl(x.jobId));
      assert.equal(e.stepNumber, 3);
      assert.equal(e.stepName, x.stepName);
      assert.equal(e.attribution, 'jobId');
      assert.equal(e.attempt, 1);
      assert.equal(e.superseded, false);
      assert.equal(e.label, null);
      assert.equal(e.bytes, inboxFiles[`${x.key}/report.html`].length);
      assert.equal(e.reports.length, 1);
      assert.equal(e.reports[0].name, 'report.html');
      assert.equal(e.reports[0].path, e.path);
      assert.equal(e.reports[0].bytes, e.bytes);
      assert.equal(e.reports[0].summarySource, 'meta');
      assert.equal(e.reports[0].summary.totalMs, x.totalMs);
      assert.equal(e.reports[0].summary.modules, undefined, 'modules are not stored');
    }
  });

  await t.test('the site model reads that history back to the GitHub step, and the report URLs route to the viewer', async () => {
    const m = M.normalize(hist);
    assert.equal(m.serverUrl, SERVER);
    assert.equal(m.stats.reportsCount, 2);
    const run = m.byId[String(RUN_ID)];
    assert.ok(run, 'run 300 is indexed');
    assert.equal(run.mvnLens.length, 2);
    for (const [key, id] of [[javaKey, JAVA], [javadocKey, JAVADOC]]) {
      const e = run.mvnLens.find(x => x.key === key);
      assert.equal(e.reports[0].path, `reports/${RUN_ID}/${key}/report.html`, 'the path survives the strict re-validation (it becomes the iframe src)');
      const link = M.stepLink(run, e, m.ctx);
      assert.equal(link.kind, 'step');
      assert.equal(link.href, `${jobUrl(id)}#step:3:1`);
      assert.equal(M.reportHref(run, e), `#/report/${RUN_ID}/${key}`);
      const route = M.parseRoute(new URL(viewer(key)).hash);
      assert.equal(route.name, 'report');
      assert.equal(String(route.runId), String(RUN_ID));
      assert.equal(route.key, key);
    }
    assert.equal(m.series.length, 2, 'two Maven series: one per job › step');
  });

  await t.test('the same event again is a no-op: nothing uploaded, no commit, no Pages build, history byte-identical', async () => {
    const commits = fake.store.commitsOf('gh-pages');
    const before = String(fake.store.readFile('gh-pages', 'data/history.json'));
    const mark = fake.calls.length;
    const r = await runProcessor(fake, event);
    assertClean(r.stdout, 'processor (again)');
    assert.equal(r.res.exitCode, 0);
    assert.equal(r.out.published, 'false');
    assert.equal(r.out['reports-collected'], '0');
    assert.equal(r.out['commit-sha'], commits[0]);
    assert.deepEqual(fake.store.commitsOf('gh-pages'), commits);
    assert.deepEqual(fake.calls.slice(mark).filter(c => c.method !== 'GET'), [], 'read-only');
    assert.equal(String(fake.store.readFile('gh-pages', 'data/history.json')), before);
  });

  await t.test('a re-run of job 1 (attempt 2) supersedes its attempt-1 report; the other job\'s report stays current', async () => {
    // Attempt 2 re-runs the Java job only: a new job id, the old one is no longer part of the latest attempt.
    const JAVA2 = 3011;
    const rerun = clone(FINAL.jobs.find(j => j.id === JAVA));
    Object.assign(rerun, { id: JAVA2, run_attempt: 2, html_url: jobUrl(JAVA2), runner_name: 'GitHub Actions 31' });
    FINAL_JOBS.set(JAVA2, clone(rerun));
    live.jobs.push(rerun);
    live.run_attempt = 2;
    runState(live, 'running');
    jobState(live, JAVA2, 'running', 4);
    const model = fixtureModel();
    model.session.totalMs = 7000;
    const ws = workspace(model, JAVA_REPORT_AT);
    const r2 = await runReport(fake, ws, { GITHUB_JOB: 'java', RUNNER_NAME: 'GitHub Actions 31', GITHUB_RUN_ATTEMPT: '2', 'INPUT_JOB-NAME': 'Java 25 (ubuntu-latest)' });
    assertClean(r2.stdout, 'report attempt 2');
    assert.equal(r2.out.published, 'true');
    assert.equal(r2.out.key, `j${JAVA2}-s3`);

    runState(live, 'done');
    jobState(live, JAVA2, 'done');
    Object.assign(live, { run_attempt: 2 });
    const r = await runProcessor(fake, eventFile(live));
    assertClean(r.stdout, 'processor (attempt 2)');
    assert.equal(r.res.exitCode, 0);
    assert.equal(r.out.published, 'true');
    assert.equal(r.out['reports-collected'], '1');
    const h = JSON.parse(String(fake.store.readFile('gh-pages', 'data/history.json')));
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].attempt, 2);
    const entries = h.runs[0].mvnLens;
    // The attempt-1 entries are kept as the history recorded them (no re-attribution); only `superseded` moves.
    assert.deepEqual(entries.map(e => [e.key, e.attempt, e.superseded, e.attribution]).sort(), [
      [`j${JAVA2}-s3`, 2, false, 'jobId'],
      [javaKey, 1, true, 'jobId'],
      [javadocKey, 1, false, 'jobId'],
    ].sort());
    const stale = entries.find(e => e.key === javaKey);
    assert.equal(stale.jobName, 'Java 25 (ubuntu-latest)', 'kept from the history');
    assert.equal(stale.jobUrl, jobUrl(JAVA), 'kept from the history');
    assert.deepEqual(h.runs[0].jobs.map(j => j.id), [JAVA2], 'the latest attempt lists the re-run job only');
    const fresh = entries.find(e => e.key === `j${JAVA2}-s3`);
    assert.equal(fresh.jobUrl, jobUrl(JAVA2));
    assert.equal(fresh.reports[0].summary.totalMs, 7000);
    assert.deepEqual(fake.store.listDir('gh-pages', `reports/${RUN_ID}`), [javaKey, javadocKey, `j${JAVA2}-s3`], 'every report set stays on the site');
    assert.equal(fake.store.refs.has(`refs/heads/${INBOX}`), false);
    assert.deepEqual(h.stats, { reportsCount: 3, reportsBytes: entries.reduce((n, e) => n + e.bytes, 0) });
    const m = M.normalize(h);
    assert.equal(m.series.length, 2, 'the superseded report does not open a third series');
  });
});
