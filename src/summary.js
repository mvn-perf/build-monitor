/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * The "summary" action: the final job of a monitored workflow run. It reads
 * the run's jobs and — in one snapshot — the reports those jobs published to
 * the run's inbox ref (refs/heads/<inbox-prefix><run id>), then writes the
 * monitoring link and a per-job table (result, duration, Maven total,
 * mvn-lens report + GitHub step links) to the job summary. Read-only: it
 * needs `actions: read` and `contents: read`. It never fails the workflow
 * unless `fail-on-error` is set: every problem becomes a warning, and the
 * summary still carries the monitoring link.
 */
'use strict';

const util = require('./util');
const { GitHubApi, apiMessage } = require('./github-api');
const { GitStore } = require('./gitstore');
const context = require('./context');
const { isValidKey } = require('./history');

const { log, debug, warning, getInput, getBooleanInput, setOutput, appendSummary, addMask, safeInt, fmtMs, parseIsoMs, escapeMd } = util;

const DEFAULT_TITLE = 'Build monitoring';
/** A meta.json is a few KB; anything bigger is not something to parse on a runner. */
const MAX_META_BYTES = 1024 * 1024;
/** Upper bound of one rate-limit wait: the last job of a run must not hang for an hour. */
const MAX_RATE_LIMIT_WAIT_MS = 3 * 60 * 1000;
/** The report files of a key directory (the report action writes report.html; several files keep the prefix). */
const REPORT_FILE_RE = /^report[^/]*\.html$/i;
/** Key convention of the report action: j<jobId>-s<step>[-label]. */
const KEY_RE = /^j(\d+)(?:-s(\d+))?(?:-|$)/;
/** A URL we accept from the API for a Markdown link (no whitespace, no parentheses that would break the link). */
const URL_RE = /^https?:\/\/[^\s()<>]+$/;

const ARROW = '↗';
const DOT = '·';
const DASH = '—';
const HOURGLASS = '⏳';
const WARN = '⚠️';

/** Result cell per job conclusion (jobs that are not completed get the hourglass). */
const RESULTS = {
  success: '✅ success',
  failure: '❌ failure',
  timed_out: '❌ timed out',
  startup_failure: '❌ startup failure',
  cancelled: `${WARN} cancelled`,
  action_required: `${WARN} action required`,
  stale: `${WARN} stale`,
  skipped: '⏭️ skipped',
  neutral: '⚪ neutral',
};

function readInputs() {
  let failOnError = false;
  try { failOnError = getBooleanInput('fail-on-error', false); } catch (e) { warning(`build-monitor summary: ${e.message}; assuming false`); }
  return {
    token: getInput('github-token', { default: process.env.GITHUB_TOKEN || '' }),
    inboxPrefix: getInput('inbox-prefix', { default: context.DEFAULT_INBOX_PREFIX }),
    siteUrl: getInput('site-url'),
    title: getInput('title', { default: DEFAULT_TITLE }) || DEFAULT_TITLE,
    failOnError,
  };
}

/**
 * Entry point. Reads process.env (INPUT_*, GITHUB_*), writes the job summary
 * and the outputs, and resolves to { exitCode, outputs }. `fetch` is injected
 * by tests; `sleep` is accepted for symmetry with the other entry points (the
 * summary never waits on its own — the API client handles retries).
 */
async function run(opts) {
  const o = opts || {};
  const inputs = readInputs();
  addMask(inputs.token);
  const ctx = context.githubContext();
  const problems = [];
  const problem = (msg) => { warning(`build-monitor summary: ${msg}`); problems.push(msg); };

  const repository = ctx.repository;
  const runId = ctx.runId;
  const attempt = ctx.runAttempt || 1;
  const runUrl = repository && runId ? `${ctx.serverUrl}/${repository}/actions/runs/${runId}` : null;
  const api = new GitHubApi({ token: inputs.token, fetch: o.fetch, apiUrl: ctx.apiUrl, maxAttempts: 3, maxRateLimitWaitMs: MAX_RATE_LIMIT_WAIT_MS });

  let canRead = true;
  if (!repository || !runId) {
    problem('GITHUB_REPOSITORY / GITHUB_RUN_ID are not set (not running in a GitHub Actions job?); the jobs and reports of the run cannot be read');
    canRead = false;
  } else if (!inputs.token) {
    problem('no github-token: the jobs and the reports of this run cannot be read (default: ${{ github.token }})');
    canRead = false;
  }

  // Site URL: input → GET /repos/{r}/pages (failures ignored) → https://<owner>.github.io/<repo>/.
  const siteUrl = await context.resolveSiteUrl({ api: canRead ? api : null, repository, input: inputs.siteUrl, ctx });
  const urls = context.monitorUrls(siteUrl, runId);

  // The run's jobs (this attempt).
  let jobs = null;
  if (canRead) {
    try {
      jobs = await api.paginate(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, {}, 'jobs', { timeoutMs: 30000 });
    } catch (e) {
      problem(`could not list the jobs of run ${runId} (${apiMessage(e)}); does the job grant "actions: read"?`);
    }
  }

  // The run's inbox ref: one snapshot (the head commit's tree; everything below is read by sha).
  let inbox = null;
  if (canRead) {
    let ref = null;
    try { ref = context.inboxRef(inputs.inboxPrefix, runId); } catch (e) { problem(e.message); }
    if (ref) {
      try {
        inbox = await readInbox(new GitStore({ api, repo: repository }), ref, runId);
      } catch (e) {
        problem(`could not read the inbox ref ${ref} (${e.message}); does the job grant "contents: read"?`);
      }
    }
  }

  const keys = inbox ? inbox.keys : [];
  const entries = attributeKeys(keys, jobs);
  for (const e of entries) debug(`report ${e.key}: ${e.how}${e.job ? ` job ${e.job.id} "${e.job.name}"` : ''}${e.stepNumber ? ` step ${e.stepNumber}` : ''}`);
  const thisJob = findThisJob(jobs, ctx);
  const reportsCount = keys.reduce((n, k) => n + k.reports.length, 0);

  appendSummary(renderSummary({
    title: inputs.title, urls, runId, runUrl, attempt, jobs, entries, thisJobId: thisJob ? thisJob.id : null,
    inboxPresent: inbox ? inbox.present : null, problems,
    workflowUrl: context.workflowFileUrl(ctx, 'build-monitor.yml'),
  }));

  const monitorUrl = urls.run || '';
  setOutput('monitor-url', monitorUrl);
  setOutput('reports-count', reportsCount);
  log(`build-monitor summary: ${jobs ? jobs.length : '?'} job(s), ${reportsCount} report(s)${inbox && inbox.present ? ` in ${inbox.ref}` : ''}; monitoring page: ${monitorUrl || '(unknown)'}`);
  return { exitCode: problems.length && inputs.failOnError ? 1 : 0, outputs: { 'monitor-url': monitorUrl, 'reports-count': String(reportsCount) } };
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/**
 * Reads the inbox ref of a run in one snapshot:
 * reports/<runId>/<key>/{report*.html, meta.json}. Directories without a
 * report file, with a name that is not a valid key, and stray blobs are
 * skipped; an unreadable meta.json (too big, not JSON, wrong shape) leaves
 * the key without meta. Returns { ref, sha, present, keys: [{ key, meta,
 * reports: [{ name, sha, bytes }] }] }; `present` is false when the ref does
 * not exist.
 */
async function readInbox(store, ref, runId) {
  const head = await store.readRef(ref);
  if (!head) return { ref, sha: null, present: false, keys: [] };
  const dirs = await store.listDir(head.treeSha, `reports/${runId}`);
  const keys = [];
  for (const d of dirs) {
    if (d.type !== 'tree') { debug(`inbox ${ref}: reports/${runId}/${d.path} is not a directory; skipped`); continue; }
    if (!isValidKey(d.path)) { debug(`inbox ${ref}: reports/${runId}/${JSON.stringify(d.path)} is not a valid key; skipped`); continue; }
    const files = await store.readTree(d.sha);
    const reports = files
      .filter(f => f.type === 'blob' && REPORT_FILE_RE.test(f.path))
      .map(f => ({ name: f.path, sha: f.sha, bytes: Number.isFinite(Number(f.size)) ? Number(f.size) : null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!reports.length) { debug(`inbox ${ref}: ${d.path} has no report file; skipped`); continue; }
    const metaEntry = files.find(f => f.type === 'blob' && f.path === 'meta.json');
    let meta = null;
    if (metaEntry) {
      try {
        const buf = await store.readBlob(metaEntry.sha, { maxBytes: MAX_META_BYTES, size: metaEntry.size });
        meta = normalizeMeta(JSON.parse(buf.toString('utf8')));
        if (!meta) throw new Error('not a JSON object');
      } catch (e) {
        warning(`build-monitor summary: meta.json of ${d.path} is unreadable (${e.message}); the report is attributed by its key only`);
        meta = null;
      }
    }
    keys.push({ key: d.path, meta, reports });
  }
  keys.sort((a, b) => a.key.localeCompare(b.key));
  return { ref, sha: head.sha, present: true, keys };
}

/** The fields of a report meta.json the summary uses, validated (ids through safeInt); null when it is not an object. */
function normalizeMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reports = Array.isArray(raw.reports) ? raw.reports.filter(r => r && typeof r === 'object' && !Array.isArray(r)) : [];
  const summaries = reports.map(r => r.summary).filter(s => s && typeof s === 'object' && !Array.isArray(s));
  if (!summaries.length && raw.summary && typeof raw.summary === 'object' && !Array.isArray(raw.summary)) summaries.push(raw.summary);
  return {
    jobId: safeInt(raw.jobId),
    jobName: str(raw.jobName),
    jobKey: str(raw.jobKey),
    runnerName: str(raw.runnerName),
    stepNumber: safeInt(raw.stepNumber),
    stepName: str(raw.stepName),
    label: str(raw.label),
    runId: safeInt(raw.runId),
    runAttempt: safeInt(raw.runAttempt),
    summaries: summaries.map(s => ({ totalMs: finite(s.totalMs), wallMs: finite(s.wallMs), status: str(s.status), moduleCount: finite(s.moduleCount) })),
  };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Joins inbox keys with the run's jobs: meta.jobId → meta.jobName (when
 * unique) → the key convention j<jobId>-s<step>. The step number comes from
 * meta.stepNumber, the key, or meta.stepName looked up in the job's steps.
 * Returns one entry per key: { key, meta, reports, summaries, label, job,
 * stepNumber, how }; `job` is null for unattributed keys.
 */
function attributeKeys(keys, jobs) {
  const list = Array.isArray(jobs) ? jobs.filter(j => j && typeof j === 'object') : [];
  const out = [];
  for (const k of keys) {
    const meta = k.meta;
    const m = KEY_RE.exec(k.key);
    let job = null;
    let how = 'unattributed';
    if (meta && meta.jobId) {
      // A job id that is not part of this attempt belongs to an earlier one: no name fallback (it would land on the re-run job).
      job = list.find(j => j.id === meta.jobId) || null;
      how = job ? 'meta.jobId' : (list.length ? 'stale-job' : 'unattributed');
    } else {
      if (meta && meta.jobName) {
        const cands = list.filter(j => j.name === meta.jobName);
        if (cands.length === 1) { job = cands[0]; how = 'meta.jobName'; }
      }
      if (!job && m) {
        job = list.find(j => j.id === Number(m[1])) || null;
        if (job) how = 'key';
      }
    }
    let stepNumber = (meta && meta.stepNumber) || (m && m[2] ? safeInt(m[2]) : null);
    if (!stepNumber && job && meta && meta.stepName && Array.isArray(job.steps)) {
      const cands = job.steps.filter(st => st && st.name === meta.stepName);
      if (cands.length) stepNumber = safeInt(cands[cands.length - 1].number);
    }
    // Without meta the label is what follows j<id>-s<n>- in the key.
    const label = meta ? meta.label : (m && k.key.length > m[0].length && m[0].endsWith('-') ? k.key.slice(m[0].length) : null);
    out.push({ key: k.key, meta, reports: k.reports, summaries: meta ? meta.summaries : [], label, job, stepNumber, how });
  }
  out.sort((a, b) => (a.stepNumber || 1e9) - (b.stepNumber || 1e9) || a.key.localeCompare(b.key));
  return out;
}

/** The job this action runs in: the in-progress job on this runner, else the one named like GITHUB_JOB (matrix legs included). */
function findThisJob(jobs, ctx) {
  const running = (Array.isArray(jobs) ? jobs : []).filter(j => j && j.status === 'in_progress');
  if (ctx.runnerName) {
    const cands = running.filter(j => j.runner_name === ctx.runnerName);
    if (cands.length === 1) return cands[0];
  }
  if (ctx.jobKey) {
    const cands = running.filter(j => typeof j.name === 'string' && (j.name === ctx.jobKey || j.name.startsWith(ctx.jobKey + ' (')));
    if (cands.length === 1) return cands[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * The job-summary Markdown. `s`: { title, urls (context.monitorUrls), runId,
 * runUrl, jobs (array | null when they could not be read), entries
 * (attributeKeys), thisJobId, inboxPresent (true | false | null = unknown),
 * problems: [string], workflowUrl }. Every user-controlled string goes
 * through escapeMd; URLs are built from validated ids and keys.
 */
function renderSummary(s) {
  const urls = s.urls || {};
  const lines = [`## ${escapeMd(s.title || DEFAULT_TITLE)}`, ''];
  if (urls.run) lines.push(`**[Open this run in the monitoring page ${ARROW}](${urls.run})** ${DOT} [mvn-lens reports](${urls.reports}) ${DOT} [Builds](${urls.builds})`);
  else if (urls.site) lines.push(`**[Open the monitoring page ${ARROW}](${urls.site})**`);
  else lines.push('_The monitoring page URL is unknown: set the `site-url` input._');
  lines.push('');
  const problems = Array.isArray(s.problems) ? s.problems : [];
  if (problems.length) {
    for (const p of problems) lines.push(`> ${WARN} ${escapeMd(p)}`);
    lines.push('');
  }

  const rows = tableRows(s);
  if (rows.length) lines.push('| Job | Result | Duration | Maven | mvn-lens report |', '|---|---|---|---|---|', ...rows, '');
  if (s.inboxPresent === false) lines.push('No mvn-lens report was published for this run.', '');
  else if (s.inboxPresent === true && !(s.entries || []).length) lines.push('The inbox of this run holds no mvn-lens report.', '');

  lines.push(s.workflowUrl
    ? `_Refreshed by [Build monitor ${ARROW}](${s.workflowUrl}) once this run completes; GitHub Pages may need a few minutes to publish._`
    : '_Refreshed by the Build monitor workflow once this run completes; GitHub Pages may need a few minutes to publish._');
  return lines.join('\n') + '\n';
}

function tableRows(s) {
  const entries = Array.isArray(s.entries) ? s.entries : [];
  const byJob = new Map();
  const unattributed = [];
  for (const e of entries) {
    if (!e.job) { unattributed.push(e); continue; }
    if (!byJob.has(e.job.id)) byJob.set(e.job.id, []);
    byJob.get(e.job.id).push(e);
  }
  const rows = [];
  for (const job of Array.isArray(s.jobs) ? s.jobs : []) {
    if (!job || typeof job !== 'object') continue;
    const mine = byJob.get(job.id) || [];
    const isThis = s.thisJobId !== null && s.thisJobId !== undefined && job.id === s.thisJobId;
    rows.push(row(escapeMd(job.name || `job ${job.id}`), resultCell(job, isThis), durationCell(job), mavenCell(mine), reportCell(mine, s)));
  }
  for (const e of unattributed) {
    let who = `unattributed (${escapeMd(e.key)})`;
    if (e.meta && e.meta.jobName) who += ` ${DOT} ${escapeMd(e.meta.jobName)}`;
    if (e.meta && e.meta.runAttempt && s.attempt && e.meta.runAttempt !== s.attempt) who += ` ${DOT} attempt ${e.meta.runAttempt}`;
    rows.push(row(who, DASH, DASH, mavenCell([e]), reportCell([e], s)));
  }
  return rows;
}

function row() { return '| ' + Array.prototype.join.call(arguments, ' | ') + ' |'; }

function resultCell(job, isThis) {
  if (isThis) return `${HOURGLASS} this job`;
  if (job.status !== 'completed') {
    const status = String(job.status || 'pending');
    return `${HOURGLASS} ${status === 'in_progress' ? 'in progress' : escapeMd(status.replace(/_/g, ' '))}`;
  }
  const c = job.conclusion === null || job.conclusion === undefined ? '' : String(job.conclusion);
  return RESULTS[c] || escapeMd((c || 'unknown').replace(/_/g, ' '));
}

function durationCell(job) {
  const a = parseIsoMs(job.started_at);
  const b = parseIsoMs(job.completed_at);
  return a && b ? fmtMs(Math.max(0, b - a)) : DASH;
}

/** One line per report entry: "<Maven total> · <status>" (several summaries of one entry joined with " / "). */
function mavenCell(entries) {
  const parts = entries.map(e => {
    const sums = e.summaries || [];
    return sums.length ? sums.map(sum => `${fmtMs(sum.totalMs)} ${DOT} ${sum.status ? escapeMd(sum.status) : DASH}`).join(' / ') : DASH;
  });
  return parts.length ? parts.join('<br>') : DASH;
}

/** One line per report entry: "[report](viewer) · [GitHub step ↗](job#step:n:1)" (job / run links when less is known). */
function reportCell(entries, s) {
  const site = s.urls ? s.urls.site : null;
  const parts = entries.map(e => {
    const viewer = context.monitorUrls(site, s.runId, e.key).report;
    let text = e.label ? `report ${DOT} ${escapeMd(e.label)}` : 'report';
    if (e.reports && e.reports.length > 1) text += ` (${e.reports.length} files)`;
    const first = viewer ? `[${text}](${viewer})` : `${text} (no monitoring page URL)`;
    const job = e.job || (e.meta && e.meta.jobId ? { id: e.meta.jobId } : null);
    const gh = githubLink(job, e.stepNumber, s.runUrl);
    return gh ? `${first} ${DOT} ${gh}` : first;
  });
  return parts.length ? parts.join('<br>') : DASH;
}

/** Deep link to the step's log; degrades to the job page (no step), then to the run page (no job). */
function githubLink(job, stepNumber, runUrl) {
  let base = null;
  if (job && typeof job.html_url === 'string' && URL_RE.test(job.html_url)) base = job.html_url;
  else if (job && safeInt(job.id) && runUrl) base = `${runUrl}/job/${safeInt(job.id)}`;
  if (base) return stepNumber ? `[GitHub step ${ARROW}](${base}#step:${stepNumber}:1)` : `[GitHub job ${ARROW}](${base})`;
  return runUrl ? `[GitHub run ${ARROW}](${runUrl})` : null;
}

// ---------------------------------------------------------------------------

function str(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function finite(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
}

module.exports = { run, readInputs, readInbox, normalizeMeta, attributeKeys, findThisJob, renderSummary, DEFAULT_TITLE, MAX_META_BYTES };
