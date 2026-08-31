/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Regression tests for review fixes whose home suite belongs to another agent.
 *
 * `report`: an unexpected error (a bug here, an API shape the code does not
 * handle) used to travel through finish() as a plain warning with its stack
 * hidden behind RUNNER_DEBUG — the failure was invisible in the log of the job
 * it happened in. It must now print the stack as an error annotation while
 * keeping the documented exit-code policy (monitoring never breaks a build
 * unless fail-on-error), and the expected failure kinds must stay quiet.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { run, finish, ISSUES_URL, PERMISSION_HINT } = require('../src/report');
const { GitStoreError } = require('../src/gitstore');
const { tmpDir, fakeReportHtml, fixtureModel, withEnv, captureOutputs } = require('./helpers');

/** The result object run() builds before publish() fills it in. */
function emptyResult() {
  return {
    found: false, published: false, noFiles: false, local: false,
    reports: [], summary: null, key: null, reportPath: null, urls: null,
    jobId: null, stepName: null, where: null, commitSha: null, reason: null,
  };
}

/** Runs `fn` with stdout captured (workflow commands included). */
async function capture(fn) {
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, enc, cb) => { chunks.push(String(chunk)); if (typeof enc === 'function') enc(); else if (cb) cb(); return true; };
  try {
    const value = await fn();
    return { value, stdout: chunks.join('') };
  } finally {
    process.stdout.write = write;
  }
}

const annotations = (stdout, kind) => stdout.split('\n').filter(l => l.startsWith(`::${kind}::`));

/** finish() with the debug flags off, outputs and summary captured. */
async function runFinish(failure, inputs) {
  const cap = captureOutputs();
  const env = Object.assign({ RUNNER_DEBUG: null, BUILD_MONITOR_DEBUG: null }, cap.env);
  const { value, stdout } = await capture(() => withEnv(env, () => finish(emptyResult(), Object.assign({ failOnError: false, ifNoFiles: 'warn' }, inputs || {}), failure)));
  return { res: value, stdout, outputs: cap.outputs() };
}

// ---------------------------------------------------------------------------
// finish(): unexpected errors are visible, expected ones keep the policy
// ---------------------------------------------------------------------------

test('report: an unexpected error prints its stack as an error annotation, without failing the step', async () => {
  const boom = new TypeError('summary.totalMs is not a function');
  const { res, stdout, outputs } = await runFinish(boom);

  const errors = annotations(stdout, 'error');
  assert.equal(errors.length, 1, `expected exactly one ::error:: annotation carrying the stack:\n${stdout}`);
  assert.ok(errors[0].includes('TypeError: summary.totalMs is not a function'), errors[0]);
  assert.match(errors[0], /%0A\s+at /, 'the stack frames are in the annotation (newlines are escaped as %0A)');
  assert.ok(errors[0].includes(ISSUES_URL), 'the annotation says where to report the bug');
  assert.ok(!stdout.includes('[debug]'), 'the stack is not only behind RUNNER_DEBUG');

  // The documented policy is unchanged: a bug in the monitoring does not break the build.
  assert.equal(res.exitCode, 0);
  assert.equal(annotations(stdout, 'warning').length, 1, stdout);
  assert.match(stdout, /::warning::build-monitor: mvn-lens report not published: summary\.totalMs is not a function/);
  assert.equal(outputs.published, 'false');
  assert.equal(outputs.reason, 'summary.totalMs is not a function');
});

test('report: fail-on-error keeps the stack annotation and fails the step', async () => {
  const { res, stdout } = await runFinish(new TypeError('boom'), { failOnError: true });
  const errors = annotations(stdout, 'error');
  assert.equal(res.exitCode, 1);
  assert.equal(errors.length, 2, `the stack and the failure message:\n${stdout}`);
  assert.ok(errors[0].includes('TypeError: boom'), errors[0]);
  assert.ok(errors[1].includes('mvn-lens report not published: boom'), errors[1]);
});

test('report: the expected failure kinds keep the documented policy — a warning, no stack, exit 0', async () => {
  const cases = [
    new GitStoreError('permission', 'create blob in acme/widgets: Resource not accessible by integration (HTTP 403)'),
    new GitStoreError('rate-limit', 'secondary rate limit'),
    new GitStoreError('conflict', '9 attempts in 180 s'),
  ];
  for (const failure of cases) {
    const { res, stdout, outputs } = await runFinish(failure);
    assert.equal(res.exitCode, 0, stdout);
    assert.deepEqual(annotations(stdout, 'error'), [], `${failure.kind}: no error annotation, no stack:\n${stdout}`);
    assert.equal(annotations(stdout, 'warning').length, 1, stdout);
    assert.ok(!stdout.includes('%0A'), `${failure.kind}: no stack in the log:\n${stdout}`);
    assert.equal(outputs.published, 'false');
    assert.ok(outputs.reason, 'the reason output still explains the failure');
  }
  const permission = await runFinish(cases[0]);
  assert.ok(permission.outputs.reason.includes(PERMISSION_HINT), permission.outputs.reason);
});

// ---------------------------------------------------------------------------
// The same, through run(): a broken API response reaches the log with a stack
// ---------------------------------------------------------------------------

test('report: run() surfaces an unexpected API failure with its stack and still exits 0', async () => {
  const dir = tmpDir('review-fixes');
  const file = path.join(dir, 'target', 'mvnlens', 'report.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fakeReportHtml(fixtureModel(), { pako: true }));

  const cap = captureOutputs();
  const env = Object.assign({
    GITHUB_REPOSITORY: 'acme/widgets', GITHUB_RUN_ID: '777', GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'build', RUNNER_NAME: 'GitHub Actions 7', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com', GITHUB_WORKFLOW_REF: null, GITHUB_EVENT_PATH: null,
    GITHUB_ACTIONS: null, RUNNER_DEBUG: null, BUILD_MONITOR_DEBUG: null, GITHUB_TOKEN: null,
    'INPUT_GITHUB-TOKEN': 'ghs_s3cretT0kenValueXYZ', INPUT_GITHUB_TOKEN: null,
    INPUT_REPORT: null, 'INPUT_STEP-NAME': null, INPUT_STEP_NAME: null, 'INPUT_JOB-NAME': null, INPUT_JOB_NAME: null,
    INPUT_LABEL: null, 'INPUT_INBOX-PREFIX': null, INPUT_INBOX_PREFIX: null, 'INPUT_SITE-URL': null, INPUT_SITE_URL: null,
    INPUT_COMPRESS: null, 'INPUT_IF-NO-FILES-FOUND': null, INPUT_IF_NO_FILES_FOUND: null,
    'INPUT_FAIL-ON-ERROR': null, INPUT_FAIL_ON_ERROR: null, 'INPUT_COMMIT-MESSAGE': null, INPUT_COMMIT_MESSAGE: null,
  }, cap.env);
  // A response object the API client cannot read: the TypeError it raises is
  // exactly the class of bug the fix makes visible.
  const brokenFetch = async () => ({ status: 200 });

  const prev = process.cwd();
  process.chdir(dir);
  let out;
  try {
    out = await capture(() => withEnv(env, () => run({ fetch: brokenFetch, sleep: () => Promise.resolve() })));
  } finally {
    process.chdir(prev);
  }

  const errors = annotations(out.stdout, 'error');
  assert.equal(out.value.exitCode, 0, out.stdout);
  assert.equal(errors.length, 1, `expected the stack as the only error annotation:\n${out.stdout}`);
  assert.ok(errors[0].includes(ISSUES_URL), errors[0]);
  assert.match(errors[0], /%0A\s+at /, errors[0]);
  assert.equal(out.value.outputs.published, 'false');
  assert.ok(out.value.outputs.reason, 'the reason output explains what happened');
});
