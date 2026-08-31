/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * The `report` action (report/action.yml → report/index.js → run()). Runs
 * inside a build job right after the Maven step: finds the mvn-lens report(s),
 * works out which job and step of the current run produced them, re-encodes
 * the embedded model as gzip+base64 (lossless, the renderer inflates it) and
 * commits
 *   reports/<runId>/<key>/report.html   (+ report-2.html … for extra matches)
 *   reports/<runId>/<key>/meta.json     (attribution + Maven summary)
 * to the run's inbox ref (refs/heads/<inbox-prefix><runId>) through the Git
 * Data API — no artifact, no git binary, no checkout. The summary action reads
 * the inbox back into the run summary; the processor grafts it into the site
 * branch. Derived from mvn-perf/build-dashboard (mvn-lens/attach.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');
const { GitHubApi } = require('./github-api');
const { GitStore, GitStoreError } = require('./gitstore');
const { readReportSummary, compressReportHtml } = require('./mvnlens');
const { locateJobAndStep } = require('./locate');
const { githubContext, resolveSiteUrl, monitorUrls, inboxRef, DEFAULT_INBOX_PREFIX } = require('./context');
const { isValidKey } = require('./history');

const { log, warning, error, debug, getInput, getBooleanInput, parseList, setOutput, appendSummary, addMask, sanitizeName, toPosix, fmtMs, fmtBytes, escapeMd, isoNow } = util;

const DEFAULT_REPORT = 'target/mvnlens/report.html';
const DEFAULT_MESSAGE = 'Add mvn-lens report';
/** Time budget of the inbox commit (CAS retries against the run's other jobs) and of rate-limit waits. */
const DEFAULT_BUDGET_MS = 180000;
/** How many `-2`, `-3`… variants of a key are tried when the inbox already holds different content under it. */
const MAX_KEY_SUFFIX = 99;
const PERMISSION_HINT = 'grant contents: write to this job (pull requests from forks have a read-only token)';
const NO_FILES_MODES = ['warn', 'error', 'ignore'];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readInputs() {
  const rawMode = (getInput('if-no-files-found', { default: 'warn' }) || 'warn').toLowerCase();
  const ifNoFiles = NO_FILES_MODES.includes(rawMode) ? rawMode : 'warn';
  if (ifNoFiles !== rawMode) warning(`build-monitor: if-no-files-found "${rawMode}" is not one of ${NO_FILES_MODES.join(', ')}; using warn`);
  const patterns = parseList(getInput('report', { default: DEFAULT_REPORT }));
  return {
    patterns: patterns.length ? patterns : [DEFAULT_REPORT],
    stepName: getInput('step-name') || null,
    jobName: getInput('job-name') || null,
    label: getInput('label') || null,
    token: getInput('github-token', { default: process.env.GITHUB_TOKEN || '' }),
    inboxPrefix: getInput('inbox-prefix', { default: DEFAULT_INBOX_PREFIX }),
    siteUrl: getInput('site-url') || null,
    compress: getBooleanInput('compress', true),
    ifNoFiles,
    failOnError: getBooleanInput('fail-on-error', false),
    commitMessage: getInput('commit-message', { default: DEFAULT_MESSAGE }) || DEFAULT_MESSAGE,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the action from process.env (INPUT_*, GITHUB_*). Expected failures
 * (no report, read-only token, rate limit, CAS budget) never throw: they end
 * as a warning + outputs + exit code 0, or an error annotation + exit code 1
 * when `fail-on-error` (or `if-no-files-found: error`) says so.
 *
 * @param {object} [opts] { fetch, sleep } injectable for tests; also the test
 *   hooks `apiOptions` (extra GitHubApi constructor options) and `budgetMs`
 *   (commit budget, default 180 s).
 * @returns {Promise<{exitCode: number, outputs: object}>}
 */
async function run(opts) {
  const o = opts || {};
  const r = {
    found: false, published: false, noFiles: false, local: false,
    reports: [], summary: null, key: null, reportPath: null, urls: null,
    jobId: null, stepName: null, where: null, commitSha: null, reason: null,
  };
  let inputs = null;
  let failure = null;
  try {
    inputs = readInputs();
    addMask(inputs.token);
    await publish(inputs, r, o);
  } catch (e) {
    failure = e;
  }
  return finish(r, inputs, failure);
}

async function publish(inputs, r, o) {
  const ctx = githubContext(process.env);

  // ---- 1. Report files -------------------------------------------------------
  const files = findReports(inputs.patterns);
  if (!files.length) {
    r.noFiles = true;
    r.reason = `no mvn-lens report found for ${inputs.patterns.join(', ')} (is the mvn-lens extension declared in .mvn/extensions.xml?)`;
    return;
  }
  const reports = readReports(files, inputs.compress);
  if (!reports.length) {
    r.noFiles = true;
    r.reason = `${files.length} file(s) matched ${inputs.patterns.join(', ')} but none embeds an mvn-lens model; nothing to publish`;
    return;
  }
  r.found = true;
  r.reports = reports;
  r.summary = reports[0].summary;
  r.stepName = inputs.stepName;
  r.where = whereOf(null, inputs, ctx);
  logMaven(reports[0]);

  // ---- 2. Can this run publish at all? ----------------------------------------
  if (!ctx.repository || !ctx.runId) {
    r.local = true;
    r.reason = 'not running inside a GitHub Actions workflow run (GITHUB_REPOSITORY / GITHUB_RUN_ID are unset); nothing to publish';
    return;
  }
  if (!inputs.token) {
    r.reason = 'github-token is empty; pass the workflow token (it needs contents: write and actions: read)';
    return;
  }
  const ref = inboxRef(inputs.inboxPrefix, ctx.runId);
  const api = new GitHubApi(Object.assign({ token: inputs.token, fetch: o.fetch, apiUrl: ctx.apiUrl, maxRateLimitWaitMs: DEFAULT_BUDGET_MS }, o.apiOptions || {}));

  // ---- 3. Which job / step produced the report? ------------------------------
  const located = await locateJobAndStep({
    repository: ctx.repository, runId: ctx.runId, runAttempt: ctx.runAttempt, jobKey: ctx.jobKey,
    jobName: inputs.jobName, runnerName: ctx.runnerName, reportWrittenAt: reports[0].mtimeMs,
  }, inputs.token, inputs.stepName, { api, sleep: o.sleep });
  r.jobId = located.job ? located.job.id : null;
  r.stepName = located.step ? located.step.name : inputs.stepName;
  r.where = whereOf(located, inputs, ctx);
  log(`build-monitor: report attributed to ${r.where} (${located.how})`);

  // ---- 4. Key (unique within the run) ----------------------------------------
  const store = new GitStore({ api, repo: ctx.repository });
  const head = await store.readRef(ref);
  const chosen = await chooseKey(store, head, ctx.runId, keyFor(located, ctx.jobKey, inputs.label), reports);
  r.key = chosen.key;
  const dir = `reports/${ctx.runId}/${chosen.key}`;
  r.reportPath = `${dir}/report.html`;
  const siteUrl = await resolveSiteUrl({ api, repository: ctx.repository, input: inputs.siteUrl, ctx });
  r.urls = monitorUrls(siteUrl, ctx.runId, chosen.key);

  // ---- 5. Commit to the inbox ref ---------------------------------------------
  const entries = reports.map(rep => ({ path: `${dir}/${rep.name}`, content: rep.content }));
  if (chosen.upToDate) {
    log(`build-monitor: ${dir} already holds these exact reports; keeping its meta.json`);
  } else {
    entries.push({ path: `${dir}/meta.json`, content: JSON.stringify(buildMeta(ctx, inputs, located, chosen.key, reports), null, 2) + '\n' });
  }
  const res = await store.commitFiles({
    ref, files: entries,
    message: `${inputs.commitMessage}: ${oneLine(r.where)}`,
    budgetMs: o.budgetMs || DEFAULT_BUDGET_MS,
    sleep: o.sleep,
  });
  r.published = true;
  r.commitSha = res.sha;
  r.reason = null;
  const bytes = reports.reduce((t, rep) => t + rep.bytes, 0);
  log(`build-monitor: ${res.changed ? (res.created ? 'created' : 'updated') : 'already up to date:'} refs/${ref} @ ${res.sha} — ${dir} (${reports.length} report${reports.length > 1 ? 's' : ''}, ${fmtBytes(bytes)}${res.attempts ? `, ${res.attempts} CAS retr${res.attempts > 1 ? 'ies' : 'y'}` : ''}; ${api.requests} API requests)`);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Absolute paths matching the patterns, first match first, without duplicates. */
function findReports(patterns) {
  const files = [];
  for (const pat of patterns) {
    for (const f of util.glob(pat)) {
      const abs = path.resolve(f);
      if (!files.includes(abs)) files.push(abs);
    }
  }
  return files;
}

/**
 * Reads the matched files: only files that embed an mvn-lens model are kept
 * (the report HTML ends up on the Pages origin, so nothing else is published).
 * Each entry: { file, name ('report.html', 'report-2.html'…), content (Buffer),
 * sha, bytes, mtimeMs, summary, source, compressed, originalPath, label }.
 */
function readReports(files, compress) {
  const reports = [];
  const cwd = process.cwd();
  for (const file of files) {
    const { summary, source, error: err } = readReportSummary(file);
    if (!summary || source !== 'html') {
      warning(`build-monitor: ${file}: ${err || 'no embedded mvn-lens model'}; not published`);
      continue;
    }
    let content = fs.readFileSync(file);
    let compressed = false;
    if (compress) {
      const c = compressReportHtml(content.toString('utf8'));
      if (c.compressed) {
        content = Buffer.from(c.html, 'utf8');
        compressed = true;
        log(`build-monitor: ${file}: model re-encoded as gzip+base64, ${fmtBytes(c.before)} → ${fmtBytes(c.after)}`);
      } else {
        log(`build-monitor: ${file}: not compressed (${c.reason}), ${fmtBytes(c.before)}`);
      }
    } else {
      log(`build-monitor: ${file}: compression disabled, ${fmtBytes(content.length)}`);
    }
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (e) { /* attribution falls back to "previous step" */ }
    const rel = path.relative(cwd, file);
    reports.push({
      file, name: null, content, sha: GitStore.blobSha(content), bytes: content.length, mtimeMs,
      summary, source, compressed,
      originalPath: toPosix(!rel || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel),
      label: null,
    });
  }
  const labels = reports.length > 1 ? reportLabels(reports.map(rep => rep.file)) : [];
  reports.forEach((rep, i) => {
    rep.name = i === 0 ? 'report.html' : `report-${i + 1}.html`;
    rep.label = reports.length > 1 ? labels[i] : null;
  });
  return reports;
}

/**
 * Labels telling several reports apart: the name of each file's grand-parent
 * directory (like build-dashboard's attach.js — `a/target/mvnlens/report.html`
 * → 'target'), or, when that name is the same for every file, the first
 * ancestor level above it where the names differ (→ 'a', 'b'), else the
 * parent directory.
 */
function reportLabels(files) {
  const dirs = files.map(f => toPosix(path.resolve(f)).split('/').filter(Boolean).slice(0, -1).reverse());
  const depth = Math.max(0, ...dirs.map(d => d.length));
  const levels = [];
  for (let level = 1; level < depth; level++) levels.push(level);
  levels.push(0);
  for (const level of levels) {
    const names = dirs.map(d => d[level] || null);
    if (new Set(names).size > 1) return names;
  }
  return dirs.map(d => d[1] || d[0] || null);
}

// ---------------------------------------------------------------------------
// Key and meta
// ---------------------------------------------------------------------------

/** A key segment: safe characters only, never starting with '.', '_' or '-'. */
function keySegment(s, max) {
  return sanitizeName(s, max).replace(/^[._-]+/, '').replace(/[._-]+$/, '');
}

function randomSuffix() {
  return crypto.randomInt(0, 36 ** 6).toString(36).padStart(6, '0');
}

/** `j<jobId>[-s<step>][-<label>]` when the job is known, else `<jobKey>-<6 random chars>[-<label>]`. */
function keyFor(located, jobKey, label) {
  let key;
  if (located && located.job) key = `j${located.job.id}` + (located.step ? `-s${located.step.number}` : '');
  else key = `${keySegment(jobKey || 'job', 40) || 'job'}-${randomSuffix()}`;
  if (label) {
    const l = keySegment(label, 40);
    if (l) key += `-${l}`;
  }
  if (!isValidKey(key) || !/^[A-Za-z0-9]/.test(key)) throw new Error(`internal error: invalid report key ${JSON.stringify(key)}`);
  return key;
}

/**
 * The key to write under. When the inbox head already has report.html under
 * the wanted key with different content, `-2`, `-3`… are tried (with a
 * warning). `upToDate` is true when every report file is already there with
 * identical bytes and a meta.json exists — the commit is then a no-op.
 */
async function chooseKey(store, head, runId, baseKey, reports) {
  if (!head) return { key: baseKey, upToDate: false };
  for (let n = 1; n <= MAX_KEY_SUFFIX; n++) {
    const key = n === 1 ? baseKey : `${baseKey}-${n}`;
    const dir = `reports/${runId}/${key}`;
    const primary = await store.findEntry(head.treeSha, `${dir}/report.html`);
    if (!primary) return { key, upToDate: false };
    let same = primary.type === 'blob' && primary.sha === reports[0].sha;
    for (let i = 1; same && i < reports.length; i++) {
      const e = await store.findEntry(head.treeSha, `${dir}/${reports[i].name}`);
      same = !!e && e.type === 'blob' && e.sha === reports[i].sha;
    }
    if (same) {
      const meta = await store.findEntry(head.treeSha, `${dir}/meta.json`);
      return { key, upToDate: !!(meta && meta.type === 'blob') };
    }
    warning(`build-monitor: ${dir}/report.html already exists in the inbox of run ${runId} with different content; using key ${baseKey}-${n + 1} (pass a distinct label: when one step publishes several reports)`);
  }
  throw new Error(`more than ${MAX_KEY_SUFFIX} report sets named ${baseKey} in the inbox of run ${runId}`);
}

function buildMeta(ctx, inputs, located, key, reports) {
  const job = located.job || null;
  return {
    schemaVersion: 1,
    repository: ctx.repository,
    serverUrl: ctx.serverUrl,
    runId: ctx.runId,
    runNumber: ctx.runNumber,
    runAttempt: ctx.runAttempt,
    workflowRef: ctx.workflowRef,
    jobKey: ctx.jobKey,
    jobId: job ? job.id : null,
    jobName: job ? job.name : inputs.jobName,
    jobUrl: job ? (job.htmlUrl || `${ctx.serverUrl}/${ctx.repository}/actions/runs/${ctx.runId}/job/${job.id}`) : null,
    runnerName: ctx.runnerName,
    stepNumber: located.step ? located.step.number : null,
    stepName: located.step ? located.step.name : inputs.stepName,
    stepResolution: located.how,
    label: inputs.label,
    key,
    collectedAt: isoNow(),
    reports: reports.map(rep => ({
      file: rep.name,
      originalPath: rep.originalPath,
      label: rep.label,
      summary: rep.summary,
      summarySource: rep.source,
      compressed: rep.compressed,
      bytes: rep.bytes,
    })),
  };
}

/** "<job> › <step>" for logs, the commit message and the job summary. */
function whereOf(located, inputs, ctx) {
  const job = (located && located.job && located.job.name) || inputs.jobName || ctx.jobKey || 'unknown job';
  const step = (located && located.step && located.step.name) || inputs.stepName || null;
  return step ? `${job} › ${step}` : job;
}

function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function logMaven(rep) {
  const s = rep.summary;
  log(`build-monitor: Maven ${(s.goals || []).join(' ')} — total ${fmtMs(s.totalMs)}, wall ${fmtMs(s.wallMs)}, cpu ${fmtMs(s.cpuMs)}, ${s.moduleCount} module(s), status ${s.status || 'unknown'} (${rep.file})`);
}

// ---------------------------------------------------------------------------
// Outcome: annotations, outputs, job summary
// ---------------------------------------------------------------------------

/** Maps an error to the `reason` output, a log detail and whether it was unexpected. */
function describeFailure(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  if (e instanceof GitStoreError) {
    if (e.kind === 'permission') {
      const reason = `the token cannot write to the repository (${msg}); ${PERMISSION_HINT}`;
      return { reason, detail: reason, unexpected: false };
    }
    if (e.kind === 'rate-limit') return { reason: 'GitHub API rate limited', detail: `GitHub API rate limited (${msg})`, unexpected: false };
    if (e.kind === 'conflict') return { reason: 'could not commit within the time budget', detail: `could not commit within the time budget (${msg})`, unexpected: false };
  }
  return { reason: msg, detail: msg, unexpected: true };
}

function finish(r, inputs, failure) {
  const failOnError = inputs ? inputs.failOnError : true;
  let exitCode = 0;
  const fail = (msg) => { error(msg); exitCode = 1; };

  if (failure) {
    const f = describeFailure(failure);
    r.published = false;
    r.reason = f.reason;
    if (f.unexpected) debug(failure && failure.stack ? failure.stack : String(failure));
    const msg = `build-monitor: mvn-lens report not published: ${f.detail}`;
    if (failOnError) fail(msg); else warning(msg);
  } else if (r.noFiles) {
    const msg = `build-monitor: ${r.reason}`;
    if (inputs.ifNoFiles === 'error') fail(msg); else if (inputs.ifNoFiles === 'warn') warning(msg); else log(msg);
  } else if (!r.published) {
    const msg = `build-monitor: mvn-lens report not published: ${r.reason}`;
    if (r.local) log(msg); else if (failOnError) fail(msg); else warning(msg);
  }

  const total = r.summary && Number.isFinite(Number(r.summary.totalMs)) && Number(r.summary.totalMs) > 0 ? String(r.summary.totalMs) : '';
  const outputs = {
    found: r.found ? 'true' : 'false',
    published: r.published ? 'true' : 'false',
    key: r.key || '',
    'report-path': r.reportPath || '',
    'monitor-url': (r.urls && r.urls.run) || '',
    'report-url': (r.urls && r.urls.report) || '',
    'job-id': r.jobId === null || r.jobId === undefined ? '' : String(r.jobId),
    'step-name': r.stepName || '',
    'maven-total-ms': total,
    'commit-sha': r.commitSha || '',
    reason: r.published ? '' : (r.reason || ''),
  };
  for (const [k, v] of Object.entries(outputs)) setOutput(k, v);
  if (r.found) appendSummary(renderSummary(r));
  return { exitCode, outputs };
}

/** The one-line job summary block (heading + stats/links or the reason). */
function renderSummary(r) {
  const n = r.reports.length;
  const segs = statsSegments(r.summary);
  if (n > 1) segs.push(`${n} reports`);
  if (r.published) {
    if (r.urls && r.urls.report) segs.push(`[report](${r.urls.report})`);
    if (r.urls && r.urls.run) segs.push(`[monitoring](${r.urls.run})`);
  } else {
    segs.push(`not published: ${escapeMd(r.reason || 'unknown reason')}`);
  }
  return `#### mvn-lens report${n > 1 ? 's' : ''} — ${escapeMd(r.where || 'unknown job')}\n${segs.join(' · ')}`;
}

function statsSegments(s) {
  if (!s) return ['(no embedded model)'];
  const goals = (s.goals || []).join(' ').replace(/[`\r\n]/g, '').trim();
  const segs = [goals ? `Maven \`${goals}\`` : 'Maven', `**${fmtMs(s.totalMs)}** total`, `wall ${fmtMs(s.wallMs)}`, `CPU ${fmtMs(s.cpuMs)}`];
  if (s.status) segs.push(escapeMd(s.status));
  return segs;
}

module.exports = {
  run, readInputs, findReports, readReports, reportLabels, keyFor, chooseKey, buildMeta, describeFailure, renderSummary,
  DEFAULT_BUDGET_MS, PERMISSION_HINT,
};
