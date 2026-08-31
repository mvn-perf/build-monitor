/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { locateJobAndStep } = require('../src/locate');
const { GitHubApi } = require('../src/github-api');

const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const noSleep = async () => {};

/**
 * A GitHubApi whose fetch answers the jobs endpoint with successive snapshots
 * (the last one repeats). `calls` counts the jobs requests; `fail` makes every
 * request answer with that HTTP status.
 */
function snapshotApi(snapshots, opts) {
  const o = opts || {};
  const state = { calls: 0, urls: [] };
  const fetch = async (url) => {
    state.urls.push(String(url));
    if (o.fail) return response(o.fail, JSON.stringify({ message: o.message || 'Resource not accessible by integration' }));
    if (!/\/repos\/acme\/widgets\/actions\/runs\/777\/attempts\/1\/jobs/.test(url)) return response(404, '{"message":"Not Found"}');
    const snap = snapshots[Math.min(state.calls, snapshots.length - 1)];
    state.calls++;
    return response(200, JSON.stringify({ total_count: snap.length, jobs: snap }));
  };
  const api = new GitHubApi({ token: 'tok', fetch, maxAttempts: 1 });
  return { api, state };
}

function response(status, body) {
  const h = new Map([['x-ratelimit-remaining', '999'], ['content-type', 'application/json']]);
  return { status, ok: status < 300, headers: { get: k => h.get(k.toLowerCase()) || null }, text: async () => body, arrayBuffer: async () => Buffer.from(body).buffer };
}

function ctx(extra) {
  return Object.assign({ repository: 'acme/widgets', runId: 777, runAttempt: 1, jobKey: 'build', jobName: null, runnerName: 'GitHub Actions 42', reportWrittenAt: null }, extra || {});
}

function step(number, name, startMs, endMs, extra) {
  return Object.assign({
    number, name,
    status: endMs === null ? 'in_progress' : 'completed',
    conclusion: endMs === null ? null : 'success',
    started_at: startMs === null ? null : iso(startMs),
    completed_at: endMs === null ? null : iso(endMs),
  }, extra || {});
}

/** Two matrix legs, both in progress; the Maven step of job 11 is over, the report step runs. */
function baseJobs() {
  return [
    { id: 11, name: 'build (17)', status: 'in_progress', runner_name: 'GitHub Actions 42', started_at: iso(T0), html_url: 'https://github.com/acme/widgets/actions/runs/777/job/11', steps: [
      step(1, 'Set up job', T0, T0 + 2000),
      step(2, 'Run actions/checkout@v4', T0 + 2000, T0 + 4000),
      step(3, 'Build with Maven', T0 + 4000, T0 + 64000),
      step(4, 'Skipped thing', T0 + 64000, T0 + 64000, { conclusion: 'skipped' }),
      step(5, 'Run mvn-perf/build-monitor/report@main', T0 + 64000, null),
    ] },
    { id: 12, name: 'build (21)', status: 'in_progress', runner_name: 'GitHub Actions 43', started_at: iso(T0), steps: [] },
    { id: 13, name: 'lint', status: 'completed', conclusion: 'success', runner_name: 'GitHub Actions 42', started_at: iso(T0 - 100000), steps: [] },
  ];
}

test('degrades to no-api without repository, run id, token or a readable jobs list', async () => {
  const { api, state } = snapshotApi([baseJobs()]);
  assert.deepEqual(await locateJobAndStep(ctx({ repository: '' }), 'tok', null, { api, sleep: noSleep }), { job: null, step: null, how: 'no-api' });
  assert.deepEqual(await locateJobAndStep(ctx({ runId: null }), 'tok', null, { api, sleep: noSleep }), { job: null, step: null, how: 'no-api' });
  assert.deepEqual(await locateJobAndStep(ctx(), '', null, { api, sleep: noSleep }), { job: null, step: null, how: 'no-api' });
  assert.equal(state.calls, 0, 'no request was made');
  const forbidden = snapshotApi([], { fail: 403 });
  assert.deepEqual(await locateJobAndStep(ctx(), 'tok', null, { api: forbidden.api, sleep: noSleep }), { job: null, step: null, how: 'no-api' });
  const notFound = snapshotApi([baseJobs()]);
  assert.deepEqual(await locateJobAndStep(ctx({ runId: 778 }), 'tok', null, { api: notFound.api, sleep: noSleep }), { job: null, step: null, how: 'no-api' });
});

test('job by explicit job-name, step by explicit step-name (last of that name)', async () => {
  const jobs = baseJobs();
  jobs[0].steps.push(step(6, 'Build with Maven', T0 + 70000, T0 + 80000));
  const { api, state } = snapshotApi([jobs]);
  const r = await locateJobAndStep(ctx({ jobName: 'build (17)', runnerName: 'unknown' }), 'tok', 'Build with Maven', { api, sleep: noSleep });
  assert.deepEqual(r.job, { id: 11, name: 'build (17)', htmlUrl: 'https://github.com/acme/widgets/actions/runs/777/job/11' });
  assert.deepEqual(r.step, { number: 6, name: 'Build with Maven' });
  assert.equal(r.how, 'job-name/step-name');
  assert.equal(state.calls, 1);

  // Unknown step name: warns and falls back to "the step that produced the report" (previous completed step).
  const r2 = await locateJobAndStep(ctx({ jobName: 'build (17)' }), 'tok', 'nope', { api: snapshotApi([baseJobs()]).api, sleep: noSleep });
  assert.equal(r2.how, 'job-name/previous-step');
  assert.equal(r2.step.number, 3, 'the last completed non-skipped step before the running one');

  // Two in-progress jobs with the same name: ambiguous, next signal (runner) decides.
  const dup = baseJobs();
  dup[1].name = 'build (17)';
  const r3 = await locateJobAndStep(ctx({ jobName: 'build (17)' }), 'tok', null, { api: snapshotApi([dup]).api, sleep: noSleep });
  assert.equal(r3.job.id, 11);
  assert.equal(r3.how, 'runner/previous-step');
});

test('job by runner name, disambiguated by the report mtime when hosted runner names collide', async () => {
  const r = await locateJobAndStep(ctx(), 'tok', null, { api: snapshotApi([baseJobs()]).api, sleep: noSleep });
  assert.equal(r.job.id, 11);
  assert.equal(r.how, 'runner/previous-step', 'the completed lint job on the same runner name is ignored');

  // Both in-progress legs report the same runner name; only job 11 was running when the report was written.
  const jobs = baseJobs();
  jobs[1].runner_name = 'GitHub Actions 42';
  jobs[1].started_at = iso(T0 + 70000);
  const at = T0 + 30000;
  const r2 = await locateJobAndStep(ctx({ reportWrittenAt: at }), 'tok', null, { api: snapshotApi([jobs]).api, sleep: noSleep });
  assert.equal(r2.job.id, 11);
  assert.equal(r2.how, 'runner/report-time');
  assert.equal(r2.step.number, 3, 'the step whose window contains the mtime');

  // Same collision without a report time: ambiguous → job key "build (…)" is ambiguous too → not found.
  const r3 = await locateJobAndStep(ctx(), 'tok', null, { api: snapshotApi([jobs]).api, sleep: noSleep });
  assert.deepEqual(r3, { job: null, step: null, how: 'job-not-found' });
});

test('job by job key: exact name or a matrix expansion "key (…)" when unique', async () => {
  const jobs = baseJobs();
  jobs[1].status = 'completed';   // only one in-progress "build (…)" leg remains
  const r = await locateJobAndStep(ctx({ runnerName: 'nowhere' }), 'tok', null, { api: snapshotApi([jobs]).api, sleep: noSleep });
  assert.equal(r.job.id, 11);
  assert.equal(r.how, 'job-key/previous-step');

  const exact = baseJobs();
  exact[0].name = 'build';
  exact[1].name = 'deploy';   // otherwise "build (21)" also matches the matrix expansion of the key
  const r2 = await locateJobAndStep(ctx({ runnerName: 'nowhere' }), 'tok', null, { api: snapshotApi([exact]).api, sleep: noSleep });
  assert.equal(r2.job.id, 11);
  assert.equal(r2.how, 'job-key/previous-step');

  const r3 = await locateJobAndStep(ctx({ runnerName: 'nowhere', jobKey: 'javadoc' }), 'tok', null, { api: snapshotApi([baseJobs()]).api, sleep: noSleep });
  assert.equal(r3.how, 'job-not-found');
  const r4 = await locateJobAndStep(ctx({ runnerName: 'nowhere', jobKey: null }), 'tok', null, { api: snapshotApi([baseJobs()]).api, sleep: noSleep });
  assert.equal(r4.how, 'job-not-found');
});

test('step by the report-time window even when the API still shows the Maven step running (lag)', async () => {
  const jobs = baseJobs();
  jobs[0].steps = [
    step(1, 'Set up job', T0, T0 + 2000),
    step(2, 'Set up JDK 17', T0 + 2000, T0 + 10000),
    step(3, 'Build with Maven', T0 + 10000, null),
  ];
  const at = T0 + 50000;
  const { api, state } = snapshotApi([jobs]);
  const r = await locateJobAndStep(ctx({ jobName: 'build (17)', reportWrittenAt: at }), 'tok', null, { api, sleep: noSleep });
  assert.equal(r.job.id, 11);
  assert.deepEqual(r.step, { number: 3, name: 'Build with Maven' });
  assert.equal(r.how, 'job-name/report-time');
  assert.equal(state.calls, 1, 'no re-fetch needed');

  // The mtime falls on the boundary: the Maven step it closes wins over the step that starts there
  // (the report step cannot have produced a file written before it had run a second); step 4 is skipped.
  const done = baseJobs();
  const r2 = await locateJobAndStep(ctx({ reportWrittenAt: T0 + 64000 }), 'tok', null, { api: snapshotApi([done]).api, sleep: noSleep });
  assert.deepEqual(r2.step, { number: 3, name: 'Build with Maven' }, 'the step that was already running, not the one starting at the mtime');
  const r3 = await locateJobAndStep(ctx({ reportWrittenAt: T0 + 60000 }), 'tok', null, { api: snapshotApi([done]).api, sleep: noSleep });
  assert.equal(r3.step.number, 3);
  assert.equal(r3.how, 'runner/report-time');
});

// ---------------------------------------------------------------------------
// The step after Maven must never win (assertj run 33402133042)
// ---------------------------------------------------------------------------

/** ISO with the whole-second truncation the Jobs API applies to step timestamps. */
const apiIso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

/** A step as the Jobs API serves it: second-truncated timestamps, `null` end while running. */
function apiStep(number, name, startMs, endMs) {
  return {
    number, name,
    status: endMs === null ? 'in_progress' : 'completed',
    conclusion: endMs === null ? null : 'success',
    started_at: apiIso(startMs),
    completed_at: endMs === null ? null : apiIso(endMs),
  };
}

function assertjJob(id, name, runner, steps) {
  return { id, name, status: 'in_progress', runner_name: runner, started_at: apiIso(T0), html_url: `https://github.com/acme/widgets/actions/runs/777/job/${id}`, steps };
}

test('the step after Maven never wins: the report mtime lands in the last second of the Maven step', async () => {
  // Job 99524395972 "Kotlin 2.1.21": step 6 "Test" 14:32:57 → 14:34:37 (Maven), step 7
  // "Publish the mvn-lens build report" 14:34:37 → …; mvn-lens wrote report.html at 14:34:36.8,
  // so the API's truncated started_at of step 7 is *before* the mtime.
  const maven = { start: T0 + 20000, end: T0 + 120000 };
  const at = maven.end - 200;
  const oracle = [assertjJob(99524395972, 'Kotlin 2.1.21', 'GitHub Actions 21', [
    apiStep(1, 'Set up job', T0, T0 + 2000),
    apiStep(2, 'Run actions/checkout@v5', T0 + 2000, T0 + 6000),
    apiStep(3, 'Set up JDK 25', T0 + 6000, T0 + 12000),
    apiStep(4, 'Cache the Maven repository', T0 + 12000, T0 + 16000),
    apiStep(5, 'Build', T0 + 16000, maven.start),
    apiStep(6, 'Test', maven.start, maven.end),
    apiStep(7, 'Publish the mvn-lens build report', maven.end, null),
  ])];
  const r = await locateJobAndStep(ctx({ jobName: 'Kotlin 2.1.21', runnerName: 'GitHub Actions 21', reportWrittenAt: at }), 'tok', null, { api: snapshotApi([oracle]).api, sleep: noSleep });
  assert.equal(r.job.id, 99524395972);
  assert.deepEqual(r.step, { number: 6, name: 'Test' }, 'the Maven step, not the report step that started in the same second');
  assert.equal(r.how, 'job-name/report-time');

  // The java layout publishes the test report between Maven and the mvn-lens step: both later steps
  // start within the mtime's second, and neither produced the file.
  const java = [assertjJob(99524395000, 'Java 25 (ubuntu-latest)', 'GitHub Actions 22', [
    apiStep(1, 'Set up job', T0, T0 + 2000),
    apiStep(2, 'Run actions/checkout@v5', T0 + 2000, T0 + 6000),
    apiStep(3, 'Set up JDK 25', T0 + 6000, T0 + 12000),
    apiStep(4, 'Cache the Maven repository', T0 + 12000, T0 + 16000),
    apiStep(5, 'Build', T0 + 16000, maven.start),
    apiStep(6, 'Test', maven.start, maven.end),
    apiStep(7, 'Publish Test Report', maven.end, maven.end + 700),
    apiStep(8, 'Publish the mvn-lens build report', maven.end + 700, null),
  ])];
  const r2 = await locateJobAndStep(ctx({ jobName: null, jobKey: 'java', runnerName: 'GitHub Actions 22', reportWrittenAt: at }), 'tok', null, { api: snapshotApi([java]).api, sleep: noSleep });
  assert.deepEqual(r2.step, { number: 6, name: 'Test' }, 'neither "Publish Test Report" nor the mvn-lens step');
  assert.equal(r2.how, 'runner/report-time');

  // Job 99524396224 "Javadoc": "Generate Javadoc" (5) then "Upload Javadoc" (6).
  const javadoc = [assertjJob(99524396224, 'Javadoc', 'GitHub Actions 23', [
    apiStep(1, 'Set up job', T0, T0 + 2000),
    apiStep(2, 'Run actions/checkout@v5', T0 + 2000, T0 + 6000),
    apiStep(3, 'Set up JDK 25', T0 + 6000, T0 + 12000),
    apiStep(4, 'Cache the Maven repository', T0 + 12000, T0 + 16000),
    apiStep(5, 'Generate Javadoc', T0 + 16000, maven.end),
    apiStep(6, 'Upload Javadoc', maven.end, null),
  ])];
  const r3 = await locateJobAndStep(ctx({ jobName: 'Javadoc', runnerName: 'GitHub Actions 23', reportWrittenAt: at }), 'tok', null, { api: snapshotApi([javadoc]).api, sleep: noSleep });
  assert.deepEqual(r3.step, { number: 5, name: 'Generate Javadoc' });
});

test('a step that started less than a second before the mtime is still taken when nothing else contains it', async () => {
  const jobs = baseJobs();
  jobs[0].steps = [
    step(1, 'Set up job', T0, T0 + 2000),
    step(2, 'Run actions/checkout@v4', T0 + 2000, T0 + 4000),
    step(3, 'Write a report by hand', T0 + 40000, null),
  ];
  // Nothing was running around the mtime except step 3, which had run for 400 ms: the wider tolerance applies.
  const r = await locateJobAndStep(ctx({ jobName: 'build (17)', reportWrittenAt: T0 + 40400 }), 'tok', null, { api: snapshotApi([jobs]).api, sleep: noSleep });
  assert.deepEqual(r.step, { number: 3, name: 'Write a report by hand' });
  assert.equal(r.how, 'job-name/report-time');
});

test('previous-step fallback re-fetches a stale snapshot before settling', async () => {
  // The report was written at T0+90 s, but the first snapshots end at T0+64 s with nothing running: stale.
  const stale = baseJobs();
  stale[0].steps = stale[0].steps.slice(0, 3);
  const fresh = baseJobs();
  fresh[0].steps = [
    step(1, 'Set up job', T0, T0 + 2000),
    step(2, 'Run actions/checkout@v4', T0 + 2000, T0 + 4000),
    step(3, 'Build with Maven', T0 + 4000, T0 + 64000),
    step(4, 'Integration tests', T0 + 64000, T0 + 90000),
    step(5, 'Run mvn-perf/build-monitor/report@main', T0 + 90000, null),
  ];
  const at = T0 + 90000;
  const slept = [];
  const { api, state } = snapshotApi([stale, stale, fresh]);
  const r = await locateJobAndStep(ctx({ reportWrittenAt: at }), 'tok', null, { api, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(r.job.id, 11);
  assert.equal(state.calls, 3, 'two re-fetches');
  assert.deepEqual(slept, [2000, 4000], 'growing delays, injected');
  assert.deepEqual(r.step, { number: 4, name: 'Integration tests' }, 'the step the fresh snapshot shows running when the report was written');
  assert.equal(r.how, 'runner/report-time');

  // Still stale after the last round: the last completed step before the mtime is taken.
  const s2 = snapshotApi([stale]);
  const r2 = await locateJobAndStep(ctx({ reportWrittenAt: at }), 'tok', null, { api: s2.api, sleep: noSleep });
  assert.equal(s2.state.calls, 3);
  assert.equal(r2.step.number, 3);
  assert.equal(r2.how, 'runner/previous-step');

  // maxRounds bounds the re-fetches.
  const s3 = snapshotApi([stale]);
  const r3 = await locateJobAndStep(ctx({ reportWrittenAt: at }), 'tok', null, { api: s3.api, sleep: noSleep, maxRounds: 1 });
  assert.equal(s3.state.calls, 1);
  assert.equal(r3.how, 'runner/previous-step');

  // A failing re-fetch of a stale snapshot gives up on the step but keeps the job.
  let n = 0;
  const flaky = new GitHubApi({ token: 'tok', maxAttempts: 1, fetch: async () => {
    n++;
    if (n > 1) return response(500, 'boom');
    return response(200, JSON.stringify({ total_count: 3, jobs: stale }));
  } });
  const r4 = await locateJobAndStep(ctx({ reportWrittenAt: at }), 'tok', null, { api: flaky, sleep: noSleep });
  assert.equal(r4.job.id, 11, 'the job attribution survives');
  assert.equal(r4.step, null);
  assert.equal(r4.how, 'runner');
});

test('no step at all: /no-step; an empty in-progress list is retried until the API catches up', async () => {
  const bare = baseJobs();
  bare[0].steps = [];
  const r = await locateJobAndStep(ctx({ jobName: 'build (17)' }), 'tok', null, { api: snapshotApi([bare]).api, sleep: noSleep });
  assert.equal(r.job.id, 11);
  assert.equal(r.step, null);
  assert.equal(r.how, 'job-name/no-step');

  // Nothing in progress yet on the first two snapshots; the third lists the job.
  const none = baseJobs().map(j => Object.assign({}, j, { status: 'queued' }));
  const { api, state } = snapshotApi([none, none, baseJobs()]);
  const r2 = await locateJobAndStep(ctx({ jobName: 'build (17)' }), 'tok', null, { api, sleep: noSleep });
  assert.equal(r2.job.id, 11);
  assert.equal(state.calls, 3);

  // Never catches up: job-not-found with the hint (no throw).
  const s3 = snapshotApi([none]);
  const r3 = await locateJobAndStep(ctx({ jobName: 'build (17)' }), 'tok', null, { api: s3.api, sleep: noSleep });
  assert.deepEqual(r3, { job: null, step: null, how: 'job-not-found' });
  assert.equal(s3.state.calls, 3);
});

test('job-not-found when no signal identifies the job among the in-progress ones', async () => {
  const r = await locateJobAndStep(ctx({ runnerName: 'unknown runner', jobName: 'nope' }), 'tok', 'Build with Maven', { api: snapshotApi([baseJobs()]).api, sleep: noSleep });
  assert.deepEqual(r, { job: null, step: null, how: 'job-not-found' });
  const r2 = await locateJobAndStep(ctx({ runnerName: null, jobKey: null, jobName: null }), 'tok', null, { api: snapshotApi([baseJobs()]).api, sleep: noSleep });
  assert.deepEqual(r2, { job: null, step: null, how: 'job-not-found' });
});
