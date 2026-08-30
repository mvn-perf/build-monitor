/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Finds which job and step of the current workflow run the code is executing
 * in, from inside that job. Derived from mvn-perf/build-dashboard (attach.js).
 */
'use strict';

const { warning, sleep, fmtMs } = require('./util');
const { GitHubApi } = require('./github-api');

/**
 * Finds the current job and the step that produced the report. Never throws —
 * a report is still useful without attribution.
 *
 * Job: the explicit `jobName`, else the single in-progress job on this runner
 * (disambiguated by step timing when hosted runner names collide), else the job
 * whose name is the job key / a matrix expansion of it.
 *
 * Step: the explicit `stepName`, else the step that was running when the
 * report was written. The Jobs API lags the runner by a few seconds, so the
 * Maven step may still show as in_progress: a step whose window contains the
 * report's mtime wins over "the last completed step"; when the snapshot is too
 * old to decide, it is re-fetched a couple of times.
 *
 * @param {object} ctx { repository, runId, runAttempt, jobKey, jobName, runnerName, reportWrittenAt }
 * @param {string} token
 * @param {string} [stepName]
 * @param {object} [opts] { api } — an existing GitHubApi (tests)
 * @returns {Promise<{job: {id, name, htmlUrl}|null, step: {number, name}|null, how: string}>}
 */
async function locateJobAndStep(ctx, token, stepName, opts) {
  const none = { job: null, step: null, how: 'no-api' };
  if (!ctx.repository || !ctx.runId) return none;
  if (!token) { warning('build-monitor: no github-token; the report is attributed to the job by name only'); return none; }
  const api = (opts && opts.api) || new GitHubApi({ token, maxAttempts: 2 });
  const fetchJobs = () => api.paginate(`/repos/${ctx.repository}/actions/runs/${ctx.runId}/attempts/${ctx.runAttempt || 1}/jobs`, {}, 'jobs', { timeoutMs: 20000 });

  let jobs;
  try {
    jobs = await fetchJobs();
  } catch (e) {
    warning(`build-monitor: could not list this run's jobs (${e.message}); does the job grant "actions: read"? Attributing by job name only.`);
    return none;
  }

  let job = null;
  let how = '';
  for (let round = 0; round < 3 && !job; round++) {
    if (round) { await sleep(2000 * round); try { jobs = await fetchJobs(); } catch (e) { break; } }
    const running = jobs.filter(j => j.status === 'in_progress');
    if (ctx.jobName) {
      const cands = running.filter(j => j.name === ctx.jobName);
      if (cands.length === 1) { job = cands[0]; how = 'job-name'; break; }
      if (cands.length > 1) warning(`build-monitor: ${cands.length} in-progress jobs are named "${ctx.jobName}"`);
    }
    if (ctx.runnerName) {
      let cands = running.filter(j => j.runner_name === ctx.runnerName);
      if (cands.length > 1 && ctx.reportWrittenAt) {
        // Hosted runner names are reused: keep the jobs that were already running when the report was written.
        cands = cands.filter(j => j.started_at && Date.parse(j.started_at) <= ctx.reportWrittenAt + 1000);
      }
      if (cands.length === 1) { job = cands[0]; how = 'runner'; break; }
    }
    if (ctx.jobKey) {
      const cands = running.filter(j => j.name === ctx.jobKey || j.name.startsWith(ctx.jobKey + ' ('));
      if (cands.length === 1) { job = cands[0]; how = 'job-key'; break; }
    }
    if (!running.length) continue;   // the API has not caught up with this job yet
    break;
  }
  if (!job) {
    const running = jobs.filter(j => j.status === 'in_progress').map(j => `"${j.name}"`).join(', ') || '(none)';
    warning(`build-monitor: could not identify this job among the in-progress jobs of run ${ctx.runId} (${running}); pass job-name: <the job's display name> (matrix expressions are fine) so the report is attributed to the right job and step`);
    return { job: null, step: null, how: 'job-not-found' };
  }

  let steps = (job.steps || []).slice().sort((a, b) => a.number - b.number);
  let step = null;
  if (stepName) {
    const cands = steps.filter(s => s.name === stepName);
    step = cands.length ? cands[cands.length - 1] : null;
    if (!step) warning(`build-monitor: no step named "${stepName}" in job "${job.name}"; falling back to the step that produced the report`);
    else how += '/step-name';
  }
  for (let round = 0; round < 3 && !step; round++) {
    if (round) {
      await sleep(2000 * round);
      try { jobs = await fetchJobs(); } catch (e) { break; }
      const fresh = jobs.find(j => j.id === job.id);
      if (fresh) steps = (fresh.steps || []).slice().sort((a, b) => a.number - b.number);
    }
    const at = ctx.reportWrittenAt;
    const completed = steps.filter(s => s.status === 'completed' && s.conclusion !== 'skipped');
    if (at) {
      // The step whose window contains the report's mtime produced it (lag-safe).
      const containing = steps.filter(s => s.started_at && Date.parse(s.started_at) <= at + 1000 && (!s.completed_at || Date.parse(s.completed_at) >= at - 1000) && s.conclusion !== 'skipped');
      if (containing.length) { step = containing[containing.length - 1]; how += '/report-time'; break; }
      const before = completed.filter(s => s.completed_at && Date.parse(s.completed_at) <= at + 1000);
      const snapshotStale = !steps.some(s => s.status === 'in_progress') && before.length && Date.parse(before[before.length - 1].completed_at) < at - 1000;
      if (snapshotStale && round < 2) continue;   // the API is behind: retry
      if (before.length) { step = before[before.length - 1]; how += '/previous-step'; break; }
    }
    const current = steps.find(s => s.status === 'in_progress');
    const before = completed.filter(s => !current || s.number < current.number);
    if (before.length) { step = before[before.length - 1]; how += '/previous-step'; break; }
    if (round === 2) how += '/no-step';
  }
  return {
    job: { id: job.id, name: job.name, htmlUrl: job.html_url || null },
    step: step ? { number: step.number, name: step.name } : null,
    how,
  };
}

module.exports = { locateJobAndStep, fmtMs };
