/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/runs');
const { fakeRun, isoAt } = require('./helpers');

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

test('buildRunRecord normalises a run and its jobs/steps with durations, queue time and completion', () => {
  const s = fakeRun({ id: 7, baseMs: T0, mavenSec: 100, workflowId: 3, workflowName: 'CI', branch: 'feat', title: 'Fix it', event: 'pull_request', runNumber: 55 });
  const rec = R.buildRunRecord(s, s.jobs);
  assert.equal(rec.id, 7);
  assert.equal(rec.workflowId, 3);
  assert.equal(rec.workflowName, 'CI');
  assert.equal(rec.workflowPath, '.github/workflows/ci.yml');
  assert.equal(rec.runNumber, 55);
  assert.equal(rec.attempt, 1);
  assert.equal(rec.event, 'pull_request');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.conclusion, 'success');
  assert.equal(rec.branch, 'feat');
  assert.equal(rec.sha, s.head_sha);
  assert.equal(rec.headRepository, 'acme/widgets');
  assert.equal(rec.title, 'Fix it');
  assert.equal(rec.actor, 'octocat');
  assert.equal(rec.htmlUrl, s.html_url);
  assert.equal(rec.createdAt, s.created_at);
  assert.equal(rec.startedAt, s.run_started_at, 'run_started_at is the start of the latest attempt');
  assert.equal(rec.updatedAt, s.updated_at);
  assert.equal(rec.completedAt, s.jobs[0].completed_at, 'the last job end, not updated_at');
  assert.equal(rec.durationMs, Date.parse(s.jobs[0].completed_at) - Date.parse(s.run_started_at));
  assert.equal(rec.queueMs, 1000, 'measured from run_started_at, not created_at');
  assert.deepEqual(rec.mvnLens, []);
  assert.equal(rec.jobs.length, 1);
  const job = rec.jobs[0];
  assert.equal(job.id, 70);
  assert.equal(job.name, 'build');
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  assert.equal(job.runnerName, s.jobs[0].runner_name);
  assert.equal(job.runnerGroup, 'GitHub Actions');
  assert.deepEqual(job.labels, ['ubuntu-latest']);
  assert.equal(job.htmlUrl, s.jobs[0].html_url);
  assert.equal(job.durationMs, Date.parse(s.jobs[0].completed_at) - Date.parse(s.jobs[0].started_at));
  assert.equal(job.steps.length, 5);
  assert.deepEqual(job.steps.map(st => st.number), [1, 2, 3, 4, 9]);
  assert.equal(job.steps[2].name, 'Build with Maven');
  assert.equal(job.steps[2].durationMs, 100000);
  assert.equal(job.steps[2].conclusion, 'success');
  assert.equal(job.steps[2].startedAt, s.jobs[0].steps[2].started_at);

  // A re-run three days later: queue time from the new run_started_at, duration from the new jobs.
  const later = T0 + 3 * 86400000;
  const rerun = Object.assign({}, s, { run_attempt: 2, run_started_at: new Date(later).toISOString() });
  rerun.jobs = s.jobs.map(j => Object.assign({}, j, { started_at: new Date(later + 5000).toISOString(), completed_at: new Date(later + 65000).toISOString() }));
  const rec2 = R.buildRunRecord(rerun, rerun.jobs);
  assert.equal(rec2.attempt, 2);
  assert.equal(rec2.queueMs, 5000);
  assert.equal(rec2.durationMs, 65000);
  assert.equal(rec2.completedAt, rerun.jobs[0].completed_at);

  // Without jobs: completion falls back to updated_at, no queue time.
  const nojobs = R.buildRunRecord(Object.assign({}, s, { jobs: [] }), []);
  assert.equal(nojobs.completedAt, s.updated_at);
  assert.equal(nojobs.queueMs, null);
  assert.equal(nojobs.durationMs, Date.parse(s.updated_at) - Date.parse(s.run_started_at));
  assert.deepEqual(nojobs.jobs, []);
  assert.deepEqual(R.buildRunRecord(Object.assign({}, s, { jobs: undefined }), undefined).jobs, []);

  // In progress: no completion, no duration; the running job/step have no end.
  const running = fakeRun({ id: 8, baseMs: T0, status: 'in_progress', steps: [{ number: 1, name: 'Set up job', start: 2, end: 4 }, { number: 2, name: 'Build with Maven', start: 4, end: 4, status: 'in_progress' }] });
  const rec3 = R.buildRunRecord(running, running.jobs);
  assert.equal(rec3.status, 'in_progress');
  assert.equal(rec3.conclusion, null);
  assert.equal(rec3.completedAt, null);
  assert.equal(rec3.durationMs, null);
  assert.equal(rec3.jobs[0].completedAt, null);
  assert.equal(rec3.jobs[0].durationMs, null);
  assert.equal(rec3.jobs[0].conclusion, null);
  assert.equal(rec3.jobs[0].steps[1].status, 'in_progress');
  assert.equal(rec3.jobs[0].steps[1].completedAt, null);
  assert.equal(rec3.jobs[0].steps[1].durationMs, null);

  // Sparse API objects: everything optional.
  const sparse = R.buildRunRecord({ id: 9, status: 'completed', head_commit: { message: 'first line\nsecond' } }, [{ id: 1, name: 'j', started_at: 'garbage' }]);
  assert.equal(sparse.title, 'first line');
  assert.equal(sparse.actor, null);
  assert.equal(sparse.attempt, 1);
  assert.equal(sparse.headRepository, null);
  assert.equal(sparse.startedAt, null);
  assert.equal(sparse.completedAt, null, 'no jobs ends and no updated_at');
  assert.equal(sparse.durationMs, null);
  assert.equal(sparse.queueMs, null);
  assert.equal(sparse.jobs[0].durationMs, null);
  assert.deepEqual(sparse.jobs[0].steps, []);
  assert.deepEqual(sparse.jobs[0].labels, []);
  const fromActor = R.buildRunRecord({ id: 10, actor: { login: 'a' }, triggering_actor: { login: 'b' }, display_title: 't' }, []);
  assert.equal(fromActor.actor, 'b', 'triggering_actor wins');
  assert.equal(fromActor.status, null);
});

test('attribute resolves a report to its job/step by jobId, runner, job name, job key or the key convention', () => {
  const s = fakeRun({ id: 1, baseMs: T0, jobs: [
    { id: 11, name: 'Java 25 (ubuntu-latest)', runnerName: 'GitHub Actions 2' },
    { id: 12, name: 'Java 25 (windows-latest)', runnerName: 'GitHub Actions 3' },
    { id: 13, name: 'Javadoc', runnerName: 'GitHub Actions 2' },
    { id: 14, name: 'Build with Maven', runnerName: 'GitHub Actions 5', steps: [
      { number: 1, name: 'Set up job', start: 1, end: 2 }, { number: 2, name: 'Build with Maven', start: 2, end: 30 }, { number: 3, name: 'Build with Maven', start: 30, end: 60 },
    ] },
  ] });
  const run = R.buildRunRecord(s, s.jobs);
  const j11 = run.jobs[0];

  // jobId (most reliable), then stepNumber, then stepName
  let a = R.attribute(run, { jobId: 11, stepNumber: 3 }, 'x');
  assert.equal(a.how, 'jobId');
  assert.equal(a.job, j11);
  assert.equal(a.step.number, 3);
  a = R.attribute(run, { jobId: '11', stepName: 'Build with Maven' }, 'x');
  assert.equal(a.how, 'jobId');
  assert.equal(a.step.number, 3, 'string ids are fine');
  a = R.attribute(run, { jobId: 11, stepNumber: 99, stepName: 'Build with Maven' }, 'x');
  assert.equal(a.step.number, 3, 'an unknown step number falls back to the step name');
  a = R.attribute(run, { jobId: 11 }, 'x');
  assert.equal(a.how, 'jobId/job-only');
  assert.equal(a.step, null);
  a = R.attribute(run, { jobId: 14, stepName: 'Build with Maven' }, 'x');
  assert.equal(a.step.number, 3, 'the last step of that name');
  // a jobId of an earlier attempt is not part of this run any more: stale, never re-attributed
  a = R.attribute(run, { jobId: 999, runnerName: 'GitHub Actions 3', jobName: 'Javadoc', jobKey: 'javadoc' }, 'j12-s3');
  assert.deepEqual(a, { job: null, step: null, how: 'stale-job' });

  // runner name: unique → match; shared hosted name → ambiguous → next signal
  a = R.attribute(run, { runnerName: 'GitHub Actions 3', stepName: 'Build with Maven' }, 'x');
  assert.equal(a.how, 'runnerName');
  assert.equal(a.job.id, 12);
  assert.equal(a.step.number, 3);
  a = R.attribute(run, { runnerName: 'GitHub Actions 2', jobName: 'Javadoc', stepNumber: 3 }, 'x');
  assert.equal(a.how, 'jobName', 'two jobs on that runner name: the job name decides');
  assert.equal(a.job.id, 13);
  a = R.attribute(run, { runnerName: 'GitHub Actions 2' }, 'x');
  assert.deepEqual(a, { job: null, step: null, how: 'none' });

  // job name
  a = R.attribute(run, { jobName: 'Java 25 (windows-latest)', stepName: 'nope' }, 'x');
  assert.equal(a.how, 'jobName/job-only');
  assert.equal(a.job.id, 12);
  // job key: exact name or matrix expansion "key (…)"; ambiguous when several legs match
  a = R.attribute(run, { jobKey: 'Javadoc', stepNumber: 2 }, 'x');
  assert.equal(a.how, 'jobKey');
  assert.equal(a.job.id, 13);
  assert.equal(a.step.name, 'Run actions/checkout@v4');
  a = R.attribute(run, { jobKey: 'Java 25', stepNumber: 2 }, 'x');
  assert.equal(a.job, null, 'two matrix legs of "Java 25 (…)" are ambiguous');
  assert.equal(a.how, 'none');
  a = R.attribute(run, { jobKey: 'other' }, 'x');
  assert.equal(a.job, null);

  // the key convention j<jobId>-s<step>[-label] when meta is absent or unhelpful
  a = R.attribute(run, null, 'j12-s3');
  assert.equal(a.how, 'key');
  assert.equal(a.job.id, 12);
  assert.equal(a.step.number, 3);
  a = R.attribute(run, undefined, 'j12-s3-it04-T4');
  assert.equal(a.step.number, 3, 'label suffix ignored');
  a = R.attribute(run, {}, 'j12');
  assert.equal(a.how, 'key/job-only');
  assert.equal(a.job.id, 12);
  assert.equal(a.step, null);
  a = R.attribute(run, { stepNumber: 2 }, 'j12-s77');
  assert.equal(a.how, 'key', 'unknown step number in the key: meta.stepNumber used');
  assert.equal(a.step.number, 2);
  a = R.attribute(run, null, 'j999-s1');
  assert.deepEqual(a, { job: null, step: null, how: 'none' });
  a = R.attribute(run, null, 'build-abc123');
  assert.deepEqual(a, { job: null, step: null, how: 'none' });
  a = R.attribute(run, null, 'j12x-s3');
  assert.deepEqual(a, { job: null, step: null, how: 'none' }, 'the id must be a whole segment');
  a = R.attribute(run, null, null);
  assert.deepEqual(a, { job: null, step: null, how: 'none' });
  a = R.attribute({ jobs: undefined }, { jobName: 'x' }, 'j1-s1');
  assert.deepEqual(a, { job: null, step: null, how: 'none' });
});

test('attribute: a report of another attempt without a job id is never joined to the re-run job', () => {
  // Run 1 was re-run: `jobs?filter=latest` returns the attempt-2 jobs only. The
  // attempt-1 report kept its own runner name / job name / job key, and every
  // one of them matches the attempt-2 job — the join must be refused instead.
  const s = fakeRun({ id: 1, baseMs: T0, attempt: 2, jobs: [
    { id: 21, name: 'Java 25 (ubuntu-latest)', runnerName: 'GitHub Actions 2', steps: [
      { number: 1, name: 'Set up job', start: 1, end: 2 }, { number: 3, name: 'Build with Maven', start: 2, end: 60 },
    ] },
  ] });
  const run = R.buildRunRecord(s, s.jobs);
  assert.equal(run.attempt, 2);
  const stale = { runAttempt: 1, jobId: null, runnerName: 'GitHub Actions 2', jobName: 'Java 25 (ubuntu-latest)', jobKey: 'java', stepNumber: 3, stepName: 'Build with Maven' };

  assert.deepEqual(R.attribute(run, stale, 'java-a1b2c3'), { job: null, step: null, how: 'stale-attempt' },
    'neither the runner name, the job name nor the job key may reach the attempt-2 job');
  assert.deepEqual(R.attribute(run, stale, 'j21-s3'), { job: null, step: null, how: 'stale-attempt' },
    'the key convention is refused too: it names a job of this attempt, not of attempt 1');

  // The report of THIS attempt still joins by every signal it used to.
  const current = Object.assign({}, stale, { runAttempt: 2 });
  let a = R.attribute(run, current, 'java-a1b2c3');
  assert.equal(a.how, 'runnerName');
  assert.equal(a.job.id, 21);
  assert.equal(a.step.number, 3);
  a = R.attribute(run, Object.assign({}, current, { runnerName: null }), 'java-a1b2c3');
  assert.equal(a.how, 'jobName');
  // A job id is the one signal that identifies an attempt on its own (ids never repeat).
  a = R.attribute(run, Object.assign({}, stale, { jobId: 21 }), 'x');
  assert.equal(a.how, 'jobId', 'an attempt-1 meta naming a job of this attempt is that job (ids are unique per attempt)');
  assert.deepEqual(R.attribute(run, Object.assign({}, stale, { jobId: 999 }), 'x'), { job: null, step: null, how: 'stale-job' });
  // A meta without an attempt (or a run without one) keeps the old fallbacks: nothing to compare.
  assert.equal(R.attribute(run, Object.assign({}, stale, { runAttempt: null }), 'x').how, 'runnerName');
  assert.equal(R.attribute(run, Object.assign({}, stale, { runAttempt: 'two' }), 'x').how, 'runnerName');
  assert.equal(R.attribute(Object.assign({}, run, { attempt: null }), stale, 'x').how, 'runnerName');
});

test('needsRefresh: incomplete, changed, re-run, forced or explicitly requested runs are fetched again', () => {
  const existing = { id: 5, status: 'completed', updatedAt: '2026-01-01T00:00:00Z', attempt: 1 };
  const same = { id: 5, status: 'completed', updated_at: '2026-01-01T00:00:00Z', run_attempt: 1 };
  assert.equal(R.needsRefresh(existing, same), false);
  assert.equal(R.needsRefresh(existing, same, {}), false);
  assert.equal(R.needsRefresh(null, same), true, 'unknown run');
  assert.equal(R.needsRefresh(undefined, same), true);
  assert.equal(R.needsRefresh(existing, same, { forceRefresh: true }), true);
  assert.equal(R.needsRefresh(existing, same, { runIds: [5] }), true, 'explicitly requested');
  assert.equal(R.needsRefresh(existing, same, { runIds: [6] }), false);
  assert.equal(R.needsRefresh(Object.assign({}, existing, { status: 'in_progress' }), same), true, 'history entry incomplete');
  assert.equal(R.needsRefresh(existing, Object.assign({}, same, { status: 'in_progress' })), true, 'API says incomplete');
  assert.equal(R.needsRefresh(existing, Object.assign({}, same, { updated_at: '2026-01-02T00:00:00Z' })), true, 'updated since');
  assert.equal(R.needsRefresh(existing, Object.assign({}, same, { run_attempt: 2 })), true, 're-run');
});

test('matchesWorkflow accepts id, name, path and file name (case-insensitively)', () => {
  const wf = { id: 12, name: 'CI Build', path: '.github/workflows/ci.yml' };
  for (const sel of ['12', 'ci build', 'CI Build', 'ci.yml', '.github/workflows/ci.yml', 'CI.YML', ' ci.yml ', '.GITHUB/WORKFLOWS/CI.YML']) assert.ok(R.matchesWorkflow(wf, sel), sel);
  for (const sel of ['ci', '13', 'ci.yaml', 'workflows/ci.yml', '', '   ', 'CI Build ', '.github/workflows/CI Build']) {
    if (sel === 'CI Build ') continue;   // trimmed: matches
    assert.ok(!R.matchesWorkflow(wf, sel), `must not match ${JSON.stringify(sel)}`);
  }
  assert.ok(R.matchesWorkflow(wf, 'CI Build '), 'selectors are trimmed');
  assert.ok(R.matchesWorkflow({ id: 12 }, '12'), 'missing name/path');
  assert.ok(!R.matchesWorkflow({ id: 12 }, 'x'));
  assert.ok(R.matchesWorkflow({ id: 1, path: '.github/workflows/build-monitor.yml' }, 'build-monitor.yml'));
});

test('isForkRun compares the head repository with the monitored one', () => {
  const own = fakeRun({ id: 1, baseMs: T0 });
  const fork = fakeRun({ id: 2, baseMs: T0, headRepository: 'forker/widgets' });
  assert.equal(R.isForkRun(own, 'acme/widgets'), false);
  assert.equal(R.isForkRun(own, 'ACME/Widgets'), false, 'case-insensitive');
  assert.equal(R.isForkRun(fork, 'acme/widgets'), true);
  assert.equal(R.isForkRun({ head_repository: null }, 'acme/widgets'), false, 'unknown head repository is not a fork');
  assert.equal(R.isForkRun({ head_repository: {} }, 'acme/widgets'), false);
  assert.equal(R.isForkRun({}, 'acme/widgets'), false);
  assert.equal(R.isForkRun(null, 'acme/widgets'), false);
});

test('stepUrl deep-links to a step log, degrading to the job page', () => {
  const s = fakeRun({ id: 3, baseMs: T0 });
  const run = R.buildRunRecord(s, s.jobs);
  const job = run.jobs[0];
  assert.equal(R.stepUrl(run, job, 3), 'https://github.com/acme/widgets/actions/runs/3/job/30#step:3:1');
  assert.equal(R.stepUrl(run, job, null), 'https://github.com/acme/widgets/actions/runs/3/job/30');
  assert.equal(R.stepUrl(run, job, 0), 'https://github.com/acme/widgets/actions/runs/3/job/30');
  assert.equal(R.stepUrl(run, Object.assign({}, job, { htmlUrl: null }), 3), 'https://github.com/acme/widgets/actions/runs/3/job/30#step:3:1', 'built from the run URL when the job has none');
  assert.equal(R.stepUrl(Object.assign({}, run, { htmlUrl: null }), Object.assign({}, job, { htmlUrl: null }), 3), null);
  assert.equal(R.stepUrl(run, null, 3), null);
  assert.equal(R.stepUrl(null, null, 3), null);
  assert.equal(R.stepUrl(null, job, 2), 'https://github.com/acme/widgets/actions/runs/3/job/30#step:2:1');
});

test('fakeRun helper produces API-shaped runs (single and multi-job)', () => {
  const single = fakeRun({ id: 4, baseMs: T0 });
  assert.equal(single.jobs.length, 1);
  assert.equal(single.jobs[0].id, 40);
  assert.equal(single.jobs[0].completed_at, isoAt(T0, 70));
  assert.equal(single.updated_at, isoAt(T0, 75));
  const multi = fakeRun({ id: 5, baseMs: T0, jobs: [{ id: 501, name: 'a' }, { name: 'b', status: 'in_progress', steps: [{ number: 1, name: 's', start: 1, end: 2 }] }] });
  assert.equal(multi.jobs.length, 2);
  assert.equal(multi.jobs[0].id, 501);
  assert.equal(multi.jobs[1].id, 51, 'derived from run id and index when not given');
  assert.equal(multi.jobs[1].name, 'b');
  assert.equal(multi.jobs[1].status, 'in_progress');
  assert.equal(multi.jobs[1].conclusion, null);
  assert.equal(multi.jobs[1].completed_at, null);
  assert.equal(multi.jobs[0].completed_at, isoAt(T0, 70));
});
