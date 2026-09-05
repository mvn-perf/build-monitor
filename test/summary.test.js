/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * End-to-end tests of the summary action (src/summary.js) against the fake
 * GitHub: a run of three jobs (the third is the summary job itself, in
 * progress) and an inbox ref seeded the way the report action writes it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { createFakeGitHub, response } = require('./fake-github');
const { fakeRun, fakeReportHtml, fixtureModel, withEnv, captureOutputs } = require('./helpers');
const { summarizeModel } = require('../src/mvnlens');
const summary = require('../src/summary');

const REPO = 'acme/widgets';
const RUN_ID = 777;
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const TOKEN = 'ghs_secret_token_do_not_print';
const SITE = 'https://acme.github.io/widgets/';
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN_ID}`;
const INBOX = `build-monitor-inbox/${RUN_ID}`;
const JAVA = 7701;
const JAVADOC = 7702;
const MONITORING = 7703;

/** The mvn-lens summary the fixture model produces: totalMs 7975 ("8.0 s"), status "OK". */
const MODEL_SUMMARY = summarizeModel(fixtureModel());
const HTML = fakeReportHtml(fixtureModel());

function mavenSteps(mavenSec) {
  return [
    { number: 1, name: 'Set up job', start: 2, end: 4 },
    { number: 2, name: 'Run actions/checkout@v4', start: 4, end: 6 },
    { number: 3, name: 'Set up JDK', start: 6, end: 20 },
    { number: 4, name: 'Cache', start: 20, end: 30 },
    { number: 5, name: 'Print versions', start: 30, end: 31 },
    { number: 6, name: 'Build with Maven', start: 31, end: 31 + mavenSec },
    { number: 7, name: 'Publish mvn-lens report', start: 31 + mavenSec, end: 35 + mavenSec },
    { number: 9, name: 'Complete job', start: 35 + mavenSec, end: 36 + mavenSec },
  ];
}

/**
 * A fake GitHub with run 777: "Java 25 (ubuntu-latest)" (success, 4m 47s),
 * "Javadoc" (failure, 2m 24s) and "Monitoring" (in progress — the job running
 * this action, on runner "GitHub Actions 13"). `fakeOpts` extend the fake's
 * scenario (readOnly, pages…), `extraJobs` add jobs to the run.
 */
function scenario(fakeOpts, extraJobs, runOpts) {
  const run = fakeRun(Object.assign({ id: RUN_ID, baseMs: T0, repository: REPO, jobs: [
    { id: JAVA, name: 'Java 25 (ubuntu-latest)', runnerName: 'GitHub Actions 11', steps: mavenSteps(252) },
    { id: JAVADOC, name: 'Javadoc', runnerName: 'GitHub Actions 12', conclusion: 'failure', steps: [
      { number: 1, name: 'Set up job', start: 2, end: 4 },
      { number: 2, name: 'Run actions/checkout@v4', start: 4, end: 6 },
      { number: 3, name: 'Set up JDK', start: 6, end: 20 },
      { number: 4, name: 'Generate Javadoc', start: 20, end: 140, conclusion: 'failure' },
      { number: 5, name: 'Publish mvn-lens report', start: 140, end: 144 },
      { number: 8, name: 'Complete job', start: 144, end: 145 },
    ] },
    { id: MONITORING, name: 'Monitoring', runnerName: 'GitHub Actions 13', status: 'in_progress', start: 300, steps: [
      { number: 1, name: 'Set up job', start: 300, end: 302 },
      { number: 2, name: 'Run mvn-perf/build-monitor/summary@main', start: 302, end: 302, status: 'in_progress' },
    ] },
  ].concat(extraJobs || []) }, runOpts || {}));
  return createFakeGitHub(Object.assign({ repository: REPO, runs: [run] }, fakeOpts || {}));
}

/** A meta.json as the report action writes it (schemaVersion 1), with overrides. */
function metaJson(p) {
  return JSON.stringify(Object.assign({
    schemaVersion: 1, repository: REPO, serverUrl: 'https://github.com', runId: RUN_ID, runNumber: 42, runAttempt: 1,
    workflowRef: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, runnerName: null, stepResolution: 'step-name', label: null,
    collectedAt: new Date(T0).toISOString(),
    reports: [{ file: 'report.html', originalPath: 'target/mvnlens/report.html', label: null, summary: MODEL_SUMMARY, summarySource: 'html', compressed: false, bytes: HTML.length }],
  }, p));
}

const JAVA_META = { jobId: JAVA, jobName: 'Java 25 (ubuntu-latest)', jobKey: 'java', stepNumber: 6, stepName: 'Build with Maven' };
const JAVADOC_META = { jobId: JAVADOC, jobName: 'Javadoc', jobKey: 'javadoc', stepNumber: 4, stepName: 'Generate Javadoc' };

/** Seeds the run's inbox ref: `keys` maps a key to meta overrides, a raw meta.json string, or null (no meta.json). */
function seedInbox(fake, keys) {
  const files = {};
  for (const [key, meta] of Object.entries(keys)) {
    files[`reports/${RUN_ID}/${key}/report.html`] = HTML;
    if (meta === null) continue;
    files[`reports/${RUN_ID}/${key}/meta.json`] = typeof meta === 'string' ? meta : metaJson(Object.assign({ key }, meta));
  }
  return fake.store.seedBranch(INBOX, files);
}

/** The environment of the summary step of the "Monitoring" job (null = unset). */
function baseEnv(cap, extra) {
  return Object.assign({
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_RUN_ID: String(RUN_ID), GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'monitoring', RUNNER_NAME: 'GitHub Actions 13',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, GITHUB_WORKFLOW: 'CI', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: null,
    GITHUB_TOKEN: null, 'INPUT_GITHUB-TOKEN': TOKEN, INPUT_GITHUB_TOKEN: null, 'INPUT_INBOX-PREFIX': null, INPUT_INBOX_PREFIX: null,
    'INPUT_SITE-URL': null, INPUT_SITE_URL: null, INPUT_TITLE: null, 'INPUT_FAIL-ON-ERROR': null, INPUT_FAIL_ON_ERROR: null,
  }, cap.env, extra || {});
}

async function runSummary(fake, extraEnv, fetchImpl) {
  const cap = captureOutputs();
  const result = await withEnv(baseEnv(cap, extraEnv), () => summary.run({ fetch: fetchImpl || fake.fetch }));
  return { result, outputs: cap.outputs(), summary: cap.summary() };
}

/** The table rows of a summary (header and separator excluded). */
function tableRows(md) {
  return md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Job ') && !l.startsWith('|---'));
}

const stepLink = (jobId, n) => `[GitHub step ↗](https://github.com/${REPO}/actions/runs/${RUN_ID}/job/${jobId}#step:${n}:1)`;
const viewer = (key) => `${SITE}#/report/${RUN_ID}/${key}`;

// ---------------------------------------------------------------------------

test('run link, one row per job, viewer + step links, the summary job as "this job", outputs', async () => {
  const fake = scenario();
  seedInbox(fake, { 'j7701-s6': JAVA_META, 'j7702-s4': JAVADOC_META });
  const r = await runSummary(fake);
  assert.equal(r.result.exitCode, 0);
  const md = r.summary;
  assert.match(md, /^## Build monitoring\n/);
  assert.ok(md.includes(`**[Open this run in the monitoring page ↗](${SITE}#/run/${RUN_ID})** · [mvn-lens reports](${SITE}#/reports) · [Builds](${SITE}#/builds)`), md);
  assert.ok(md.includes('| Job | Result | Duration | Maven | mvn-lens report |\n|---|---|---|---|---|\n'), md);
  assert.deepEqual(tableRows(md), [
    `| Java 25 (ubuntu-latest) | ✅ success | 4m 47s | 8.0 s · OK | [report](${viewer('j7701-s6')}) · ${stepLink(JAVA, 6)} |`,
    `| Javadoc | ❌ failure | 2m 24s | 8.0 s · OK | [report](${viewer('j7702-s4')}) · ${stepLink(JAVADOC, 4)} |`,
    '| Monitoring | ⏳ this job | — | — | — |',
  ]);
  assert.ok(md.includes(`🔎 _To go further: the more in-depth mvn-lens report of every Maven build above will be on the monitoring page ([${SITE}](${SITE})) a few minutes after this summary: [Build monitor ↗](https://github.com/${REPO}/actions/workflows/build-monitor.yml) processes this run once it completes, then GitHub Pages publishes the page._`), md);
  assert.ok(!md.includes('No mvn-lens report'), md);
  assert.ok(!md.includes('⚠️'), md);
  assert.ok(!md.includes(TOKEN), 'the token must never reach the summary');
  assert.deepEqual(r.outputs, { 'monitor-url': `${SITE}#/run/${RUN_ID}`, 'reports-count': '2' });
  assert.deepEqual(r.result.outputs, r.outputs);
  // One snapshot: the jobs of this attempt once, the ref once, the rest by sha — and no write at all.
  assert.equal(fake.calls.filter(c => /\/actions\/runs\/777\/attempts\/1\/jobs/.test(c.path)).length, 1);
  assert.equal(fake.calls.filter(c => /\/git\/ref\//.test(c.path)).length, 1);
  assert.ok(fake.calls.every(c => c.method === 'GET'), fake.calls.map(c => c.method + ' ' + c.path).join('\n'));
  assert.ok(fake.calls.every(c => c.headers.authorization === `Bearer ${TOKEN}`));
});

test('site-url: the input wins, else the Pages API, else the conventional URL', async () => {
  const withPages = scenario({ pages: { html_url: 'https://acme.github.io/widgets-pages/' } });
  let r = await runSummary(withPages);
  assert.equal(r.outputs['monitor-url'], 'https://acme.github.io/widgets-pages/#/run/777');
  r = await runSummary(withPages, { 'INPUT_SITE-URL': 'https://ci.example.org/monitor' });
  assert.equal(r.outputs['monitor-url'], 'https://ci.example.org/monitor/#/run/777');
  assert.ok(r.summary.includes('[mvn-lens reports](https://ci.example.org/monitor/#/reports)'), r.summary);
  r = await runSummary(scenario());
  assert.equal(r.outputs['monitor-url'], `${SITE}#/run/777`);
});

test('no inbox ref: the jobs table plus the "no report" note; reports-count 0', async () => {
  const fake = scenario();
  const r = await runSummary(fake);
  assert.equal(r.result.exitCode, 0);
  const md = r.summary;
  assert.ok(md.includes(`**[Open this run in the monitoring page ↗](${SITE}#/run/${RUN_ID})**`), md);
  assert.deepEqual(tableRows(md), [
    '| Java 25 (ubuntu-latest) | ✅ success | 4m 47s | — | — |',
    '| Javadoc | ❌ failure | 2m 24s | — | — |',
    '| Monitoring | ⏳ this job | — | — | — |',
  ]);
  assert.ok(md.includes('\nNo mvn-lens report was published for this run.\n'), md);
  assert.ok(!md.includes('To go further'), 'no "a few minutes after this summary" promise when nothing was published: ' + md);
  assert.ok(!md.includes('⚠️'), md);
  assert.deepEqual(r.outputs, { 'monitor-url': `${SITE}#/run/${RUN_ID}`, 'reports-count': '0' });
});

test('bad ids, unreadable or oversized meta: attribution falls back to the key; stray entries are skipped', async () => {
  const fake = scenario();
  fake.store.seedBranch(INBOX, {
    [`reports/${RUN_ID}/j7701-s6/report.html`]: HTML,
    [`reports/${RUN_ID}/j7701-s6/meta.json`]: metaJson({ key: 'j7701-s6', jobId: 'abc', stepNumber: -3, jobName: 42 }),
    [`reports/${RUN_ID}/j7702-s4/report.html`]: HTML,
    [`reports/${RUN_ID}/j7702-s4/meta.json`]: '{not json',
    [`reports/${RUN_ID}/j7702-s3/report.html`]: HTML,
    [`reports/${RUN_ID}/j7702-s3/meta.json`]: '{' + ' '.repeat(summary.MAX_META_BYTES) + '}',
    [`reports/${RUN_ID}/custom-9f8e7d/report.html`]: HTML,
    [`reports/${RUN_ID}/custom-9f8e7d/meta.json`]: metaJson({ key: 'custom-9f8e7d', jobId: 'x', jobName: 'Nope | gone', stepNumber: 2 }),
    [`reports/${RUN_ID}/bad key!/report.html`]: HTML,
    [`reports/${RUN_ID}/stray.txt`]: 'x',
    [`reports/${RUN_ID}/no-report-here/notes.md`]: 'nothing to show',
    [`reports/999/j1-s1/report.html`]: HTML,
  });
  const r = await runSummary(fake);
  assert.equal(r.result.exitCode, 0);
  const md = r.summary;
  assert.deepEqual(tableRows(md), [
    // ids unusable → the key j7701-s6 names job and step; the summary numbers of the meta are still shown
    `| Java 25 (ubuntu-latest) | ✅ success | 4m 47s | 8.0 s · OK | [report](${viewer('j7701-s6')}) · ${stepLink(JAVA, 6)} |`,
    // two keys of one job (meta unreadable / too big): one line each, ordered by step
    `| Javadoc | ❌ failure | 2m 24s | —<br>— | [report](${viewer('j7702-s3')}) · ${stepLink(JAVADOC, 3)}<br>[report](${viewer('j7702-s4')}) · ${stepLink(JAVADOC, 4)} |`,
    '| Monitoring | ⏳ this job | — | — | — |',
    `| unattributed (custom-9f8e7d) · Nope \\| gone | — | — | 8.0 s · OK | [report](${viewer('custom-9f8e7d')}) · [GitHub run ↗](${RUN_URL}) |`,
  ]);
  for (const absent of ['bad key', 'stray', 'no-report-here', '/999/']) assert.ok(!md.includes(absent), `${absent} must not appear:\n${md}`);
  assert.ok(!md.includes('⚠️'), 'unreadable metas are logged, not shown as problems');
  assert.equal(r.outputs['reports-count'], '4');
  // the oversized meta was rejected on its tree-entry size, never downloaded
  assert.ok(!fake.calls.some(c => c.path.includes(fake.store.blobSha(Buffer.from('{' + ' '.repeat(summary.MAX_META_BYTES) + '}')))));
});

test('a job with two labelled reports gets two report links in its row', async () => {
  const fake = scenario();
  seedInbox(fake, {
    'j7701-s6-fast': Object.assign({ label: 'fast' }, JAVA_META),
    'j7701-s6-slow': Object.assign({ label: 'slow [x]' }, JAVA_META),
  });
  const r = await runSummary(fake);
  assert.equal(tableRows(r.summary)[0],
    `| Java 25 (ubuntu-latest) | ✅ success | 4m 47s | 8.0 s · OK<br>8.0 s · OK | [report · fast](${viewer('j7701-s6-fast')}) · ${stepLink(JAVA, 6)}<br>[report · slow \\[x\\]](${viewer('j7701-s6-slow')}) · ${stepLink(JAVA, 6)} |`);
  assert.equal(r.outputs['reports-count'], '2');
  assert.equal(tableRows(r.summary).length, 3);
});

test('without meta the label comes from the key; meta.stepName resolves the step when the number is missing', async () => {
  const fake = scenario();
  seedInbox(fake, {
    'j7701-s6-nightly': null,
    'javadoc-a1b2c3': { jobId: null, jobName: 'Javadoc', stepNumber: null, stepName: 'Generate Javadoc' },
  });
  const r = await runSummary(fake);
  const rows = tableRows(r.summary);
  assert.ok(rows[0].includes(`[report · nightly](${viewer('j7701-s6-nightly')}) · ${stepLink(JAVA, 6)}`), rows[0]);
  assert.ok(rows[1].includes(`[report](${viewer('javadoc-a1b2c3')}) · ${stepLink(JAVADOC, 4)}`), rows[1]);
  assert.equal(rows.length, 3);
});

test('user-controlled strings are escaped in the Markdown', async () => {
  const fake = scenario(null, [{ id: 7704, name: 'weird | job_name <x>', runnerName: 'GitHub Actions 14', steps: mavenSteps(10) }]);
  seedInbox(fake, { 'j7704-s6': { jobId: 7704, jobName: 'weird | job_name <x>', stepNumber: 6, label: 'a|b_c' } });
  const r = await runSummary(fake, { INPUT_TITLE: 'My *CI* summary' });
  const md = r.summary;
  assert.match(md, /^## My \\\*CI\\\* summary\n/);
  const row = tableRows(md).find(l => l.startsWith('| weird'));
  assert.ok(row && row.startsWith('| weird \\| job\\_name \\<x\\> | ✅ success |'), row);
  assert.ok(row.includes(`[report · a\\|b\\_c](${viewer('j7704-s6')})`), row);
  assert.ok(!md.includes('<x>'), md);
  assert.equal(tableRows(md).length, 4);
});

test('the summary job is recognised by GITHUB_JOB when the runner name does not match; otherwise it is "in progress"', async () => {
  const fake = scenario();
  let r = await runSummary(fake, { RUNNER_NAME: 'somewhere else', GITHUB_JOB: 'Monitoring' });
  assert.equal(tableRows(r.summary)[2], '| Monitoring | ⏳ this job | — | — | — |');
  r = await runSummary(fake, { RUNNER_NAME: 'somewhere else', GITHUB_JOB: 'other' });
  assert.equal(tableRows(r.summary)[2], '| Monitoring | ⏳ in progress | — | — | — |');
});

test('a report of an earlier attempt stays unattributed, with its attempt and a link to its job', async () => {
  const fake = scenario(null, null, { attempt: 2 });
  seedInbox(fake, {
    'j6601-s6': Object.assign({}, JAVA_META, { jobId: 6601, runAttempt: 1 }),
    'j7701-s6': Object.assign({}, JAVA_META, { runAttempt: 2 }),
  });
  const r = await runSummary(fake, { GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(r.result.exitCode, 0, r.summary);
  const rows = tableRows(r.summary);
  assert.equal(rows[0], `| Java 25 (ubuntu-latest) | ✅ success | 4m 47s | 8.0 s · OK | [report](${viewer('j7701-s6')}) · ${stepLink(JAVA, 6)} |`);
  assert.equal(rows[3], `| unattributed (j6601-s6) · Java 25 (ubuntu-latest) · attempt 1 | — | — | 8.0 s · OK | [report](${viewer('j6601-s6')}) · ${stepLink(6601, 6)} |`);
  assert.ok(fake.calls.some(c => /\/attempts\/2\/jobs/.test(c.path)));
  assert.equal(r.outputs['reports-count'], '2');
});

test('an attempt-1 report without a job id is never joined by job name to the re-run job', async () => {
  const fake = scenario(null, null, { attempt: 2 });
  seedInbox(fake, {
    'j7701-s6': Object.assign({}, JAVA_META, { runAttempt: 2 }),
    // Same job name, published by attempt 1, with no usable job id (locate.js could not resolve it).
    'java-a1b2c3': Object.assign({}, JAVA_META, { jobId: null, runAttempt: 1 }),
  });
  const r = await runSummary(fake, { GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(r.result.exitCode, 0, r.summary);
  const rows = tableRows(r.summary);
  // The re-run job keeps its own report only: no second link, and no step deep link into steps that never produced it.
  assert.equal(rows[0], `| Java 25 (ubuntu-latest) | ✅ success | 4m 47s | 8.0 s · OK | [report](${viewer('j7701-s6')}) · ${stepLink(JAVA, 6)} |`);
  assert.equal(rows.length, 4);
  assert.equal(rows[3], `| unattributed (java-a1b2c3) · Java 25 (ubuntu-latest) · attempt 1 | — | — | 8.0 s · OK | [report](${viewer('java-a1b2c3')}) · [GitHub run ↗](${RUN_URL}) |`);
  assert.equal(r.outputs['reports-count'], '2');
});

test('attributeKeys: an entry of another attempt is unattributed even when its name is unique', () => {
  const jobs = [{ id: JAVA, name: 'Java 25 (ubuntu-latest)', steps: [{ number: 6, name: 'Build with Maven' }] }];
  const meta = summary.normalizeMeta({ jobName: 'Java 25 (ubuntu-latest)', stepNumber: 6, runAttempt: 1, reports: [] });
  const key = { key: 'java-a1b2c3', meta, reports: [{ name: 'report.html' }] };
  assert.equal(summary.attributeKeys([key], jobs, 2)[0].job, null, 'attempt 1 report, attempt 2 jobs');
  assert.equal(summary.attributeKeys([key], jobs, 2)[0].how, 'stale-attempt');
  const same = summary.attributeKeys([key], jobs, 1)[0];
  assert.equal(same.how, 'meta.jobName', 'the same attempt still joins by name');
  assert.equal(same.job.id, JAVA);
  assert.equal(summary.attributeKeys([key], jobs)[0].how, 'meta.jobName', 'no attempt known: unchanged behaviour');
});

test('a read-only token is enough: the summary only reads', async () => {
  const fake = scenario({ readOnly: true });
  seedInbox(fake, { 'j7701-s6': JAVA_META, 'j7702-s4': JAVADOC_META });
  const r = await runSummary(fake);
  assert.equal(r.result.exitCode, 0);
  assert.ok(!r.summary.includes('⚠️'), r.summary);
  assert.equal(r.outputs['reports-count'], '2');
  assert.equal(tableRows(r.summary).length, 3);
  assert.ok(fake.calls.every(c => c.method === 'GET'));
});

test('jobs API failure: warning in the summary, link still present, exit 0 (1 with fail-on-error)', async () => {
  const fake = scenario();
  seedInbox(fake, { 'j7701-s6': JAVA_META });
  const failing = (status, message) => async (url, init) => (/\/attempts\/1\/jobs/.test(String(url)) ? response(status, JSON.stringify({ message })) : fake.fetch(url, init));

  let r = await runSummary(fake, null, failing(500, 'boom'));
  assert.equal(r.result.exitCode, 0);
  const md = r.summary;
  assert.ok(md.includes(`**[Open this run in the monitoring page ↗](${SITE}#/run/${RUN_ID})**`), md);
  assert.match(md, /\n> ⚠️ could not list the jobs of run 777 \(boom\); does the job grant "actions: read"\?\n/);
  // the inbox was still read: its report is listed, unattributed (nothing to join with), with the job link from its meta
  assert.deepEqual(tableRows(md), [
    `| unattributed (j7701-s6) · Java 25 (ubuntu-latest) | — | — | 8.0 s · OK | [report](${viewer('j7701-s6')}) · ${stepLink(JAVA, 6)} |`,
  ]);
  assert.deepEqual(r.outputs, { 'monitor-url': `${SITE}#/run/${RUN_ID}`, 'reports-count': '1' });
  assert.ok(!md.includes(TOKEN));

  r = await runSummary(fake, { 'INPUT_FAIL-ON-ERROR': 'true' }, failing(403, 'Resource not accessible by integration'));
  assert.equal(r.result.exitCode, 1);
  assert.ok(r.summary.includes('Resource not accessible by integration'), r.summary);
  assert.ok(r.summary.includes(`(${SITE}#/run/${RUN_ID})`), r.summary);
  assert.equal(r.outputs['monitor-url'], `${SITE}#/run/${RUN_ID}`);
});

test('inbox ref unreadable: warning, jobs table still written', async () => {
  const fake = scenario();
  const failing = async (url, init) => (/\/git\/ref\//.test(String(url)) ? response(403, JSON.stringify({ message: 'Resource not accessible by integration' })) : fake.fetch(url, init));
  const r = await runSummary(fake, null, failing);
  assert.equal(r.result.exitCode, 0);
  assert.match(r.summary, /> ⚠️ could not read the inbox ref heads\/build-monitor-inbox\/777 \(.*Resource not accessible by integration.*\); does the job grant "contents: read"\?/);
  assert.equal(tableRows(r.summary).length, 3);
  assert.ok(!r.summary.includes('No mvn-lens report was published'), 'unknown is not "none"');
  assert.ok(r.summary.includes(`🔎 _To go further: any mvn-lens report published by the Maven jobs of this run will be on the monitoring page ([${SITE}](${SITE})) a few minutes after this summary:`), 'the promise is hedged when the inbox could not be read: ' + r.summary);
  assert.equal(r.outputs['reports-count'], '0');
});

test('invalid inbox-prefix: warning, nothing read from git, link present', async () => {
  const fake = scenario();
  const r = await runSummary(fake, { 'INPUT_INBOX-PREFIX': 'bad prefix' });
  assert.equal(r.result.exitCode, 0);
  assert.match(r.summary, /> ⚠️ inbox-prefix "bad prefix" contains characters git refuses/);
  assert.ok(!fake.calls.some(c => c.path.includes('/git/')));
  assert.equal(tableRows(r.summary).length, 3);
});

test('no token: warning, the link is still written, nothing is read', async () => {
  const fake = scenario();
  const r = await runSummary(fake, { 'INPUT_GITHUB-TOKEN': '' });
  assert.equal(r.result.exitCode, 0);
  assert.ok(r.summary.includes(`**[Open this run in the monitoring page ↗](${SITE}#/run/${RUN_ID})**`), r.summary);
  assert.match(r.summary, /> ⚠️ no github-token/);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(r.outputs, { 'monitor-url': `${SITE}#/run/${RUN_ID}`, 'reports-count': '0' });
});

test('outside GitHub Actions: heading + warning, empty monitor-url, exit 0', async () => {
  const fake = scenario();
  const r = await runSummary(fake, { GITHUB_REPOSITORY: null, GITHUB_RUN_ID: null });
  assert.equal(r.result.exitCode, 0);
  assert.match(r.summary, /^## Build monitoring\n\n_The monitoring page URL is unknown: set the `site-url` input\._\n/);
  assert.match(r.summary, /> ⚠️ GITHUB\\_REPOSITORY \/ GITHUB\\_RUN\\_ID are not set/, 'problem texts are escaped too (they embed API messages)');
  assert.ok(r.summary.includes('will be on the monitoring page a few minutes after this summary: the Build monitor workflow processes this run once it completes'), r.summary);
  assert.deepEqual(r.outputs, { 'monitor-url': '', 'reports-count': '0' });
  assert.equal(fake.calls.length, 0);
});

test('renderSummary: pure rendering of a minimal state', () => {
  const md = summary.renderSummary({ title: 'T', urls: { site: SITE, run: `${SITE}#/run/1`, reports: `${SITE}#/reports`, builds: `${SITE}#/builds` }, runId: 1, runUrl: null, jobs: [], entries: [], thisJobId: null, inboxPresent: true, problems: [], workflowUrl: null });
  assert.equal(md, [
    '## T',
    '',
    `**[Open this run in the monitoring page ↗](${SITE}#/run/1)** · [mvn-lens reports](${SITE}#/reports) · [Builds](${SITE}#/builds)`,
    '',
    'The inbox of this run holds no mvn-lens report.',
    '',
  ].join('\n'));
  const one = summary.renderSummary({ title: 'T', urls: { site: SITE, run: `${SITE}#/run/1`, reports: `${SITE}#/reports`, builds: `${SITE}#/builds` }, runId: 1, runUrl: null, jobs: [], entries: [{ key: 'j1-s2', how: 'key', job: null, meta: null }], thisJobId: null, inboxPresent: true, problems: [], workflowUrl: null });
  assert.ok(one.endsWith(`\n\n🔎 _To go further: the more in-depth mvn-lens report of every Maven build above will be on the monitoring page ([${SITE}](${SITE})) a few minutes after this summary: the Build monitor workflow processes this run once it completes, then GitHub Pages publishes the page._\n`), one);
});

test('summary/index.js runs as a child process against the fake served over HTTP', async () => {
  const fake = scenario();
  seedInbox(fake, { 'j7701-s6': JAVA_META });
  const { url, close } = await fake.serve();
  const cap = captureOutputs();
  const env = Object.assign({}, process.env, baseEnv(cap, { GITHUB_API_URL: url }));
  for (const k of Object.keys(env)) if (env[k] === null || env[k] === undefined) delete env[k];
  const root = path.join(__dirname, '..');
  let out = '';
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'summary', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', resolve);
  });
  await close();
  assert.equal(code, 0, out);
  assert.ok(out.includes(`::add-mask::${TOKEN}`), 'the token is masked at startup:\n' + out);
  assert.ok(!out.split(`::add-mask::${TOKEN}`).join('').includes(TOKEN), 'the token appears nowhere else in the log:\n' + out);
  assert.ok(out.includes('build-monitor summary: 3 job(s), 1 report(s) in heads/build-monitor-inbox/777'), out);
  assert.deepEqual(cap.outputs(), { 'monitor-url': `${SITE}#/run/${RUN_ID}`, 'reports-count': '1' });
  const md = cap.summary();
  assert.ok(md.includes(`[report](${viewer('j7701-s6')}) · ${stepLink(JAVA, 6)}`), md);
  assert.ok(md.includes('| Monitoring | ⏳ this job |'), md);
  assert.ok(!md.includes(TOKEN));
});
