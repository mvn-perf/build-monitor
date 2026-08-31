/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Workflow-run records (run → jobs → steps) built from the Actions API, and the
 * attribution of an mvn-lens report directory to a job/step of that run.
 * Derived from mvn-perf/build-dashboard (collect.js).
 */
'use strict';

const path = require('path');
const { parseIsoMs } = require('./util');

/** Matches a workflow against a user selector: id, name, path, file name. */
function matchesWorkflow(wf, selector) {
  const sel = String(selector).trim();
  if (!sel) return false;
  const low = sel.toLowerCase();
  const base = path.posix.basename(wf.path || '');
  return String(wf.id) === sel
    || (wf.name || '').toLowerCase() === low
    || (wf.path || '').toLowerCase() === low
    || base.toLowerCase() === low
    || ('.github/workflows/' + low) === (wf.path || '').toLowerCase();
}

/** A run whose head repository is not the repository being monitored (pull request from a fork). */
function isForkRun(summary, repo) {
  const head = summary && summary.head_repository;
  if (!head || !head.full_name) return false;
  return String(head.full_name).toLowerCase() !== String(repo).toLowerCase();
}

/** Whether a run already in the history must be fetched again given its current API summary. */
function needsRefresh(existing, summary, o) {
  const opts = o || {};
  if (!existing || opts.forceRefresh) return true;
  if (Array.isArray(opts.runIds) && opts.runIds.includes(summary.id)) return true;
  if (existing.status !== 'completed' || summary.status !== 'completed') return true;
  if (existing.updatedAt !== summary.updated_at) return true;
  if (existing.attempt !== summary.run_attempt) return true;
  return false;
}

/**
 * Normalises a run summary (GET /actions/runs/{id}) and its jobs
 * (GET /actions/runs/{id}/jobs?filter=latest) into a history RunRecord.
 */
function buildRunRecord(s, jobs) {
  const jobRecs = (jobs || []).map(j => {
    const started = parseIsoMs(j.started_at);
    const completed = parseIsoMs(j.completed_at);
    return {
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion || null,
      startedAt: j.started_at || null,
      completedAt: j.completed_at || null,
      durationMs: started && completed ? Math.max(0, completed - started) : null,
      runnerName: j.runner_name || null,
      runnerGroup: j.runner_group_name || null,
      labels: Array.isArray(j.labels) ? j.labels : [],
      htmlUrl: j.html_url || null,
      steps: (j.steps || []).map(st => {
        const a = parseIsoMs(st.started_at);
        const b = parseIsoMs(st.completed_at);
        return {
          number: st.number,
          name: st.name,
          status: st.status,
          conclusion: st.conclusion || null,
          startedAt: st.started_at || null,
          completedAt: st.completed_at || null,
          durationMs: a && b ? Math.max(0, b - a) : null,
        };
      }),
    };
  });
  const createdMs = parseIsoMs(s.created_at);
  // run_started_at is the start of the LATEST attempt (created_at stays that of attempt 1).
  const startedAt = s.run_started_at || s.created_at;
  const startedMs = parseIsoMs(startedAt);
  const jobEnds = jobRecs.map(j => parseIsoMs(j.completedAt)).filter(Boolean);
  const jobStarts = jobRecs.map(j => parseIsoMs(j.startedAt)).filter(Boolean);
  let completedAt = null;
  if (s.status === 'completed') {
    completedAt = jobEnds.length ? new Date(Math.max(...jobEnds)).toISOString() : (s.updated_at || null);
  }
  const completedMs = parseIsoMs(completedAt);
  const queueBaseMs = startedMs || createdMs;
  return {
    id: s.id,
    workflowId: s.workflow_id,
    workflowName: s.name || null,
    workflowPath: s.path || null,
    runNumber: s.run_number,
    attempt: s.run_attempt || 1,
    event: s.event || null,
    status: s.status || null,
    conclusion: s.conclusion || null,
    branch: s.head_branch || null,
    sha: s.head_sha || null,
    headRepository: s.head_repository && s.head_repository.full_name ? s.head_repository.full_name : null,
    title: s.display_title || (s.head_commit && s.head_commit.message ? String(s.head_commit.message).split('\n')[0] : null),
    actor: (s.triggering_actor && s.triggering_actor.login) || (s.actor && s.actor.login) || null,
    htmlUrl: s.html_url || null,
    createdAt: s.created_at || null,
    startedAt: startedAt || null,
    completedAt,
    updatedAt: s.updated_at || null,
    durationMs: startedMs && completedMs ? Math.max(0, completedMs - startedMs) : null,
    queueMs: queueBaseMs && jobStarts.length ? Math.max(0, Math.min(...jobStarts) - queueBaseMs) : null,
    jobs: jobRecs,
    mvnLens: [],
  };
}

/** A positive whole number, or null (meta.json is data written by a build job). */
function attemptOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** True when meta says the report was published by an attempt other than the one `run` describes. */
function isOtherAttempt(run, meta) {
  const metaAttempt = attemptOf(meta && meta.runAttempt);
  const runAttempt = attemptOf(run && run.attempt);
  return !!metaAttempt && !!runAttempt && metaAttempt !== runAttempt;
}

/**
 * Resolves the job and step an mvn-lens report directory belongs to, most
 * reliable signal first: meta.jobId → runner name → job name → job key → the
 * directory key convention `j<jobId>-s<step>`. Returns how the match was made;
 * `stale-job` when meta names a job that is not part of the latest attempt,
 * `stale-attempt` when the report was published by another attempt and carries
 * no job id.
 *
 * `run.jobs` are the jobs of the LATEST attempt (`jobs?filter=latest`), so a
 * report published by an earlier attempt must never be joined to them by
 * runner name, job name, job key or the key convention: those all repeat
 * across attempts and would hang an attempt-1 report on the attempt-2 job,
 * with a step link into the wrong log. Only a job id identifies an attempt
 * (ids are unique per attempt), which is why it keeps its fallback-free path.
 * The `summary` action applies the same rule (src/summary.js#attributeKeys).
 */
function attribute(run, meta, key) {
  const jobs = run.jobs || [];
  let job = null;
  let how = 'none';
  if (meta) {
    if (meta.jobId) {
      job = jobs.find(j => j.id === Number(meta.jobId)) || null;
      if (!job) return { job: null, step: null, how: 'stale-job' };
      how = 'jobId';
    } else if (isOtherAttempt(run, meta)) {
      return { job: null, step: null, how: 'stale-attempt' };
    }
    if (!job && meta.runnerName) {
      const cands = jobs.filter(j => j.runnerName === meta.runnerName);
      if (cands.length === 1) { job = cands[0]; how = 'runnerName'; }
    }
    if (!job && meta.jobName) {
      const cands = jobs.filter(j => j.name === meta.jobName);
      if (cands.length === 1) { job = cands[0]; how = 'jobName'; }
    }
    if (!job && meta.jobKey) {
      const cands = jobs.filter(j => j.name === meta.jobKey || j.name.startsWith(meta.jobKey + ' ('));
      if (cands.length === 1) { job = cands[0]; how = 'jobKey'; }
    }
  }
  if (!job) {
    const m = /^j(\d+)(?:-s(\d+))?(?:-|$)/.exec(key || '');
    if (m) {
      job = jobs.find(j => j.id === Number(m[1])) || null;
      if (job) {
        how = 'key';
        if (m[2]) {
          const st = job.steps.find(s => s.number === Number(m[2]));
          if (st) return { job, step: st, how };
        }
      }
    }
  }
  if (!job) return { job: null, step: null, how };
  let step = null;
  if (meta && meta.stepNumber) step = job.steps.find(s => s.number === Number(meta.stepNumber)) || null;
  if (!step && meta && meta.stepName) {
    const cands = job.steps.filter(s => s.name === meta.stepName);
    step = cands.length ? cands[cands.length - 1] : null;
  }
  return { job, step, how: step ? how : how + '/job-only' };
}

/** GitHub deep link to a step's log. */
function stepUrl(run, job, stepNumber) {
  const base = (job && job.htmlUrl) || (run && run.htmlUrl && job ? `${run.htmlUrl}/job/${job.id}` : null);
  if (!base) return null;
  return stepNumber ? `${base}#step:${stepNumber}:1` : base;
}

module.exports = { matchesWorkflow, isForkRun, needsRefresh, buildRunRecord, attribute, stepUrl };
