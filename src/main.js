/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Entry point of the root "Build monitor" action — the independent processing
 * that runs once a monitored workflow has completed. It reads the site branch
 * (gh-pages) and the per-run inbox refs the `report` steps pushed to, records
 * the runs (jobs, steps, mvn-lens reports) in data/history.json, grafts the
 * report trees into the site BY SHA (the report bytes are never re-uploaded),
 * commits everything in one compare-and-swap commit, requests a Pages build
 * and deletes the grafted inbox refs. Derived from mvn-perf/build-dashboard.
 */
'use strict';

const path = require('path');
const util = require('./util');
const { GitHubApi, classifyError, apiMessage } = require('./github-api');
const { GitStore, GitStoreError } = require('./gitstore');
const context = require('./context');
const runs = require('./runs');
const history = require('./history');
const { renderIndexHtml, generateSite } = require('./site');

const { log, debug, warning, getInput, getBooleanInput, getIntInput, parseList, setOutput, appendSummary, escapeMd, posixJoin, safeInt, isoNow, mapLimit, fmtBytes, fmtMs } = util;

/** data/history.json larger than this is refused (per-run detail files are the documented follow-up past ~10 MB). */
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
/** A meta.json blob larger than this is ignored (a real one is a few KB). */
const MAX_META_BYTES = 1024 * 1024;
/** GitHub Pages serves sites up to 1 GB: warn well before. */
const REPORTS_WARN_BYTES = 700 * 1024 * 1024;
/** CAS budget of the gh-pages commit (SPEC: 10 min) and the longest rate-limit wait. */
const COMMIT_BUDGET_MS = 10 * 60 * 1000;
const RATE_LIMIT_WAIT_MS = 10 * 60 * 1000;
/** Report files inside a key directory (the report step writes report.html; several reports of one step get suffixes). */
const REPORT_FILE_RE = /^report[A-Za-z0-9._-]*\.html$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BAD_BRANCH_RE = /[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|^-|\.lock$|(^|\/)\.|\.$/;
/** Most recent runs listed in the job summary. */
const SUMMARY_ROWS = 25;

/** Summary fields kept in history.json (SPEC: no `modules`, a slim `environment`). */
const SUMMARY_FIELDS = [
  'schemaVersion', 'groupId', 'artifactId', 'version', 'goals', 'threads', 'builderId', 'mavenVersion', 'jdkVersion', 'status',
  'startedAt', 'endedAt', 'totalMs', 'wallMs', 'cpuMs', 'gcMs', 'gcCount', 'jitMs', 'c2Ms', 'downloadMs', 'downloadBytes', 'downloadCount',
  'moduleCount', 'slowestMojo', 'slowestTest', 'testCount', 'testMs', 'issueCount', 'issueSeverities',
];
const ENVIRONMENT_FIELDS = ['availableProcessors', 'osName', 'mvnd', 'githubActions'];

/** A configuration / environment problem the user can fix (reported, exit code 1, never a stack trace). */
class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readInputs(ctx) {
  const repository = getInput('repository', { default: ctx.repository || '' });
  if (!REPO_RE.test(repository)) throw new ConfigError(`repository must be "owner/name", got "${repository}"`);
  const token = getInput('github-token', { default: process.env.GITHUB_TOKEN || '' });
  if (!token) throw new ConfigError('github-token is required (default: ${{ github.token }})');
  const branch = getInput('branch', { default: 'gh-pages' });
  if (!branch || BAD_BRANCH_RE.test(branch)) throw new ConfigError(`branch "${branch}" is not a valid branch name`);
  let inboxPrefix;
  try {
    inboxPrefix = context.normalizeInboxPrefix(getInput('inbox-prefix', { default: context.DEFAULT_INBOX_PREFIX }));
  } catch (e) {
    throw new ConfigError(e.message);
  }
  const runIds = [];
  for (const raw of parseList(getInput('run-id'))) {
    const id = safeInt(raw);
    if (id) { if (!runIds.includes(id)) runIds.push(id); } else warning(`run-id "${raw}" is not a run id; ignored`);
  }
  const outputDirInput = getInput('output-dir');
  return {
    repository, token, branch, inboxPrefix, runIds,
    siteDir: normalizeSiteDir(getInput('site-dir')),
    siteUrl: getInput('site-url'),
    title: getInput('title'),
    workflows: parseList(getInput('workflows')),
    excludeWorkflows: parseList(getInput('exclude-workflows')),
    includeSelf: getBooleanInput('include-self', false),
    sweepRuns: getIntInput('sweep-runs', 20, 0, 1000),
    lookbackDays: getIntInput('lookback-days', 90, 1, 3650),
    includeForkRuns: getBooleanInput('include-fork-runs', false),
    concurrency: getIntInput('concurrency', 4, 1, 16),
    requestPagesBuild: getBooleanInput('request-pages-build', true),
    dryRun: getBooleanInput('dry-run', false),
    outputDir: path.resolve(outputDirInput || 'build-monitor-site'),
  };
}

/** `site-dir` as a POSIX directory relative to the branch root ('' = root). */
function normalizeSiteDir(input) {
  const dir = posixJoin(input);
  if (!dir) return '';
  for (const seg of dir.split('/')) {
    if (seg === '.' || seg === '..') throw new ConfigError(`site-dir "${input}" must be a relative directory inside the branch`);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Report sets (one key directory = one mvn-lens report set of a run)
// ---------------------------------------------------------------------------

function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function httpUrl(v) {
  return typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim()) ? v.trim() : null;
}

/** The summary as stored in history.json: the headline numbers only (no modules, slim environment). */
function slimSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const out = {};
  for (const k of SUMMARY_FIELDS) if (summary[k] !== undefined) out[k] = summary[k];
  if (summary.environment && typeof summary.environment === 'object') {
    out.environment = {};
    for (const k of ENVIRONMENT_FIELDS) if (summary.environment[k] !== undefined) out.environment[k] = summary.environment[k];
  } else {
    out.environment = null;
  }
  return out;
}

/**
 * Builds the MvnLensEntry of one key directory (`reports/<runId>/<key>`) from
 * its tree entries: meta.json (≤ 1 MB, written by the report step inside the
 * build job) gives the attribution hints and the summaries, the report*.html
 * blobs give the files and their sizes. Nothing but meta.json is downloaded.
 * Returns null when the directory holds no report file.
 */
async function buildEntry(p) {
  const { store, run, key, entries, source } = p;
  const dir = `reports/${run.id}/${key}`;
  let meta = null;
  const metaEntry = entries.find(e => e.path === 'meta.json' && e.type === 'blob');
  if (metaEntry) {
    try {
      const buf = await store.readBlob(metaEntry.sha, { maxBytes: MAX_META_BYTES, size: metaEntry.size });
      const parsed = JSON.parse(buf.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
      else warning(`run ${run.id}: ${dir}/meta.json (${source}) is not an object; attributing by key only`);
    } catch (e) {
      warning(`run ${run.id}: ${dir}/meta.json (${source}) unreadable (${e.message}); attributing by key only`);
    }
  }
  const files = entries
    .filter(e => e.type === 'blob' && REPORT_FILE_RE.test(e.path) && history.isValidReportPath(`${dir}/${e.path}`))
    .sort((a, b) => (a.path === 'report.html' ? -1 : 0) - (b.path === 'report.html' ? -1 : 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of entries) {
    if (e.type === 'blob' && /\.html?$/i.test(e.path) && !files.includes(e)) warning(`run ${run.id}: ${dir}/${e.path} (${source}) is not a report file name; not listed`);
  }
  if (!files.length) {
    warning(`run ${run.id}: ${dir} (${source}) holds no report.html; ignored`);
    return null;
  }
  const metaReports = meta && Array.isArray(meta.reports) ? meta.reports.filter(r => r && typeof r === 'object') : [];
  const reports = files.map(f => {
    const mr = metaReports.find(r => r.file === f.path) || null;
    const summary = mr ? slimSummary(mr.summary) : null;
    return {
      name: f.path,
      label: mr && mr.label ? String(mr.label) : null,
      path: `${dir}/${f.path}`,
      summary,
      summarySource: summary ? 'meta' : null,
      bytes: Number(f.size) || 0,
    };
  });
  const a = runs.attribute(run, meta, key);
  const job = a.job;
  const step = a.step;
  return {
    key,
    dir,
    path: reports[0].path,
    jobId: job ? job.id : safeInt(meta && meta.jobId),
    jobName: job ? job.name : str(meta && (meta.jobName || meta.jobKey)),
    jobUrl: job ? job.htmlUrl || null : httpUrl(meta && meta.jobUrl),
    stepNumber: step ? step.number : safeInt(meta && meta.stepNumber),
    stepName: step ? step.name : str(meta && meta.stepName),
    label: str(meta && meta.label),
    attempt: safeInt(meta && meta.runAttempt) || run.attempt || 1,
    attribution: a.how,
    superseded: false,
    collectedAt: str(meta && meta.collectedAt) || isoNow(),
    bytes: reports.reduce((n, r) => n + (r.bytes || 0), 0),
    reports,
  };
}

/** Entries sharing (jobName, stepNumber|stepName, label): every one below the highest attempt is superseded. */
function markSuperseded(entries) {
  const groupOf = e => JSON.stringify([e.jobName || '', e.stepNumber || e.stepName || '', e.label || '']);
  const best = new Map();
  for (const e of entries) {
    const g = groupOf(e);
    const att = safeInt(e.attempt) || 1;
    if (!best.has(g) || att > best.get(g)) best.set(g, att);
  }
  for (const e of entries) e.superseded = (safeInt(e.attempt) || 1) < best.get(groupOf(e));
}

/** Deterministic order (no locale-dependent comparison: the serialized history must not churn between runners). */
function sortEntries(entries) {
  entries.sort((a, b) => (a.jobId || 0) - (b.jobId || 0) || (a.stepNumber || 0) - (b.stepNumber || 0) || (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0));
}

/** Merges report entries into a run record: `theirs` first, `ours` override by key; superseded recomputed. */
function mergeEntries(theirs, ours) {
  const byKey = new Map();
  for (const e of theirs || []) if (e && typeof e === 'object' && history.isValidReportDir(e.dir)) byKey.set(String(e.key || e.dir), e);
  for (const e of ours || []) byKey.set(String(e.key), e);
  const list = Array.from(byKey.values());
  markSuperseded(list);
  sortEntries(list);
  return list;
}

/** `{ reportsCount, reportsBytes }` over every entry of the history. */
function computeStats(hist) {
  let reportsCount = 0;
  let reportsBytes = 0;
  for (const run of hist.runs) {
    for (const e of run.mvnLens || []) {
      reportsCount += Array.isArray(e.reports) ? e.reports.length : 0;
      reportsBytes += Number(e.bytes) || 0;
    }
  }
  return { reportsCount, reportsBytes };
}

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

/**
 * Runs the action. Reads process.env (INPUT_*, GITHUB_*); `fetch` and `sleep`
 * are injectable for tests. Never throws for expected failures (configuration,
 * permissions, API errors): they are reported with ::error and exit code 1.
 *
 * @param {{ fetch?: Function, sleep?: Function }} [deps]
 * @returns {Promise<{ exitCode: number, outputs: object }>}
 */
async function run(deps) {
  const d = deps || {};
  const sleep = typeof d.sleep === 'function' ? d.sleep : util.sleep;
  const ctx = context.githubContext();
  const outputs = {};
  const state = { siteUrl: null, runsProcessed: 0, runsTotal: 0, reportsCollected: 0, commitSha: null, published: false, reportsBytes: 0 };
  const emit = () => {
    const set = (name, value) => { outputs[name] = value === undefined || value === null ? '' : String(value); setOutput(name, outputs[name]); };
    set('site-url', state.siteUrl || '');
    set('runs-processed', state.runsProcessed);
    set('runs-total', state.runsTotal);
    set('reports-collected', state.reportsCollected);
    set('commit-sha', state.commitSha || '');
    set('published', state.published ? 'true' : 'false');
    set('reports-bytes', state.reportsBytes);
  };

  let inputs;
  try {
    inputs = readInputs(ctx);
  } catch (e) {
    util.error(`build-monitor: ${e.message}`);
    emit();
    return { exitCode: 1, outputs };
  }
  util.addMask(inputs.token);
  const api = new GitHubApi({ token: inputs.token, apiUrl: ctx.apiUrl, fetch: d.fetch, maxRateLimitWaitMs: RATE_LIMIT_WAIT_MS });
  const store = new GitStore({ api, repo: inputs.repository });
  try {
    await execute({ ctx, inputs, api, store, sleep, state });
    emit();
    return { exitCode: 0, outputs };
  } catch (e) {
    if (e instanceof ConfigError || e instanceof GitStoreError || (e && typeof e.status === 'number')) {
      util.error(`build-monitor: ${e.message}`);
      emit();
      appendSummary(`### Build monitor\n\n**Failed:** ${escapeMd(e.message)}\n`);
      return { exitCode: 1, outputs };
    }
    throw e;
  }
}

async function execute(p) {
  const { ctx, inputs, api, store, sleep, state } = p;
  const repo = inputs.repository;
  const ref = 'heads/' + inputs.branch;
  const historyPath = posixJoin(inputs.siteDir, 'data', 'history.json');
  const trig = context.triggeringRun(ctx);
  const stats = { runsFailed: 0, forkRunsSkipped: 0, notMonitored: 0, refsDeleted: 0, grafts: 0, graftedBytes: 0 };

  // ---- 1. Site URL ----------------------------------------------------------
  const siteUrl = await context.resolveSiteUrl({ api, repository: repo, input: inputs.siteUrl, siteDir: inputs.siteDir, ctx });
  state.siteUrl = siteUrl;
  const title = inputs.title || `Build monitor · ${repo}`;
  log(`Repository ${repo}, site branch ${inputs.branch}${inputs.siteDir ? '/' + inputs.siteDir : ''}, monitoring page ${siteUrl || '(unknown)'}${inputs.dryRun ? ' — DRY RUN' : ''}`);

  // ---- 2. Current site + repository facts + workflows ------------------------
  util.group(`Reading ${inputs.branch}`);
  const head = await store.readRef(ref);
  let hist;
  let prevText = null;   // data/history.json exactly as it is on the branch (unchanged content ⇒ no commit)
  let prevSha = null;
  if (head) {
    const entry = await store.findEntry(head.treeSha, historyPath);
    if (entry && entry.type === 'blob') {
      const buf = await store.readBlob(entry.sha, { maxBytes: MAX_HISTORY_BYTES, size: entry.size });
      prevText = buf.toString('utf8');
      prevSha = entry.sha;
      hist = parseHistoryOrFail(prevText, repo, `${inputs.branch}:${historyPath}`);
      log(`History: ${hist.runs.length} run(s) in ${historyPath} (${fmtBytes(buf.length)}) at ${head.sha.slice(0, 7)}`);
    } else {
      hist = history.emptyHistory(repo);
      log(`History: ${historyPath} does not exist on ${inputs.branch} yet; starting empty`);
    }
  } else {
    hist = history.emptyHistory(repo);
    log(`Branch ${inputs.branch} does not exist yet; it will be created`);
  }
  let repoInfo = null;
  try {
    repoInfo = await api.get(`/repos/${repo}`);
  } catch (e) {
    if (classifyError(e) === 'permission' || e.status === 404) throw new ConfigError(`GET /repos/${repo} failed: ${apiMessage(e)} — is the token allowed to read ${repo}?`);
    debug(`GET /repos/${repo} failed: ${e.message}`);
  }
  const facts = {
    repositoryUrl: (repoInfo && repoInfo.html_url) || hist.repositoryUrl || `${ctx.serverUrl}/${repo}`,
    defaultBranch: (repoInfo && repoInfo.default_branch) || hist.defaultBranch || null,
    serverUrl: ctx.serverUrl,
    siteUrl: siteUrl || hist.siteUrl || null,
  };

  const allWorkflows = await api.paginate(`/repos/${repo}/actions/workflows`, {}, 'workflows');
  let selectors = inputs.workflows;
  let selectorSource = 'the workflows input';
  if (!selectors.length && trig) {
    selectors = [trig.workflowId ? String(trig.workflowId) : (trig.workflowPath || trig.workflowName)].filter(Boolean);
    selectorSource = `the triggering workflow_run (${trig.workflowPath || trig.workflowName || trig.workflowId})`;
  } else if (!selectors.length) {
    selectorSource = inputs.includeSelf ? 'every workflow' : 'every workflow but this one';
  }
  const exclude = inputs.excludeWorkflows.slice();
  if (!inputs.includeSelf && ctx.workflowPath) exclude.push(ctx.workflowPath);
  const selected = allWorkflows.filter(wf => wf && wf.path && !String(wf.path).startsWith('dynamic/')
    && (!selectors.length || selectors.some(s => runs.matchesWorkflow(wf, s)))
    && !exclude.some(s => runs.matchesWorkflow(wf, s)));
  const selectedIds = new Set(selected.map(wf => wf.id));
  log(`Workflows (${selectorSource}): ${selected.map(w => `${w.name} (${w.path})`).join(', ') || '(none)'}`);
  if (!selected.length && selectors.length) warning(`no workflow of ${repo} matches ${selectors.map(s => `"${s}"`).join(', ')}; nothing to monitor`);
  util.endGroup();

  // ---- 3. The run set -------------------------------------------------------
  util.group('Selecting runs');
  const wanted = new Map();   // id → { sources: [], summary|null }
  const want = (id, source, summary) => {
    const w = wanted.get(id) || { sources: [], summary: null };
    if (!w.sources.includes(source)) w.sources.push(source);
    if (summary && !w.summary) w.summary = summary;
    wanted.set(id, w);
  };
  for (const id of inputs.runIds) want(id, 'run-id');
  if (trig) want(trig.id, 'event');
  const inbox = new Map();   // runId → { ref, sha }
  for (const r of await store.listRefs('heads/' + inputs.inboxPrefix)) {
    const id = context.parseInboxRef(r.ref, inputs.inboxPrefix);
    if (!id) { debug(`ref ${r.ref} is not an inbox ref of a run; ignored`); continue; }
    inbox.set(id, r);
    want(id, 'inbox');
  }
  for (const r of hist.runs) if (r.status !== 'completed') want(r.id, 'incomplete');
  if (inputs.sweepRuns > 0 && selected.length) {
    const since = new Date(Date.now() - inputs.lookbackDays * 86400000).toISOString().slice(0, 10);
    for (const wf of selected) {
      let list = [];
      try {
        list = await api.paginate(`/repos/${repo}/actions/workflows/${wf.id}/runs`, { created: '>=' + since }, 'workflow_runs', { max: inputs.sweepRuns });
      } catch (e) {
        if (classifyError(e) === 'permission') throw new ConfigError(`listing the runs of ${wf.name} failed: ${apiMessage(e)} — the job needs "actions: read"`);
        warning(`sweep: the runs of ${wf.name} could not be listed (${e.message})`);
      }
      let picked = 0;
      for (const s of list) {
        if (!s || !safeInt(s.id)) continue;
        // Missing from the history, or changed since (status, attempt, updated_at).
        if (runs.needsRefresh(history.findRun(hist, s.id), s)) { want(s.id, 'sweep', s); picked++; }
      }
      debug(`sweep ${wf.name}: ${list.length} run(s) since ${since}, ${picked} to (re)process`);
    }
  }
  log(`Runs: ${wanted.size} candidate(s) — ${inputs.runIds.length} from run-id, ${trig ? 1 : 0} from the event, ${inbox.size} inbox ref(s), ${hist.runs.filter(r => r.status !== 'completed').length} incomplete in the history, sweep of ${inputs.sweepRuns} run(s) per workflow`);
  util.endGroup();

  // ---- 4. Per run: record + report sets + grafts ----------------------------
  util.group('Processing runs');
  const todo = Array.from(wanted.entries()).map(([id, w]) => ({ id, sources: w.sources, summary: w.summary })).sort((a, b) => b.id - a.id);
  const processed = [];   // { id, record, grafts, inboxRef, files, bytes }
  await mapLimit(todo, inputs.concurrency, async (t) => {
    try {
      let s = t.summary;
      if (!s) {
        try {
          s = await api.get(`/repos/${repo}/actions/runs/${t.id}`);
        } catch (e) {
          if (classifyError(e) === 'permission') throw new ConfigError(`GET /actions/runs/${t.id} failed: ${apiMessage(e)} — the job needs "actions: read"`);
          if (e.status === 404) { warning(`run ${t.id} (${t.sources.join(', ')}) does not exist in ${repo}; skipped${inbox.has(t.id) ? ' (its inbox ref is left alone)' : ''}`); stats.runsFailed++; return; }
          throw e;
        }
      }
      if (!selectedIds.has(s.workflow_id)) {
        stats.notMonitored++;
        debug(`run ${t.id} belongs to workflow "${s.name}" (${s.path}), which is not monitored; skipped`);
        return;
      }
      if (!inputs.includeForkRuns && runs.isForkRun(s, repo)) {
        stats.forkRunsSkipped++;
        log(`  run ${t.id} comes from a fork (${s.head_repository.full_name}); skipped (include-fork-runs is false)`);
        return;
      }
      const jobs = await api.paginate(`/repos/${repo}/actions/runs/${t.id}/jobs`, { filter: 'latest' }, 'jobs');
      const record = runs.buildRunRecord(s, jobs);
      const existing = history.findRun(hist, t.id);
      const entries = new Map();
      // (a) what the history already knows (dir re-validated: it becomes a URL)
      for (const e of (existing && existing.mvnLens) || []) {
        if (e && typeof e === 'object' && history.isValidReportDir(e.dir)) entries.set(String(e.key || e.dir), e);
        else debug(`run ${t.id}: dropping a history entry with an invalid report dir`);
      }
      // (b) key directories already on the site branch but missing from the history (meta re-read)
      if (head) {
        for (const de of await store.listDir(head.treeSha, posixJoin(inputs.siteDir, 'reports', String(t.id)))) {
          if (de.type !== 'tree' || !history.isValidKey(de.path) || entries.has(de.path)) continue;
          const entry = await buildEntry({ store, run: record, key: de.path, entries: await store.readTree(de.sha), source: inputs.branch });
          if (entry) entries.set(de.path, entry);
        }
      }
      // (c) the run's inbox ref: grafted by sha into the site tree
      const grafts = [];
      let inboxRef = null;
      let inboxSha = null;
      let files = 0;
      let bytes = 0;
      const ib = inbox.get(t.id);
      if (ib) {
        const ih = await store.readRef(ib.ref);
        if (ih) {
          inboxRef = ib.ref;
          inboxSha = ih.sha;
          for (const ke of await store.listDir(ih.treeSha, `reports/${t.id}`)) {
            if (ke.type !== 'tree') continue;
            if (!history.isValidKey(ke.path)) { warning(`run ${t.id}: inbox key "${ke.path}" is not a valid key; ignored`); continue; }
            const entry = await buildEntry({ store, run: record, key: ke.path, entries: await store.readTree(ke.sha), source: 'inbox' });
            if (!entry) continue;
            entries.set(ke.path, entry);
            grafts.push({ path: posixJoin(inputs.siteDir, 'reports', String(t.id), ke.path), type: 'tree', sha: ke.sha });
            files += entry.reports.length;
            bytes += entry.bytes;
          }
          if (!grafts.length) warning(`run ${t.id}: inbox ref ${ib.ref} holds no report set; it is left in place`);
        }
      }
      record.mvnLens = mergeEntries([], Array.from(entries.values()));
      processed.push({ id: t.id, record, grafts, inboxRef, inboxSha, files, bytes });
      log(`  #${record.runNumber} ${record.workflowName} (${record.branch}) ${record.status}/${record.conclusion || '-'} ${fmtMs(record.durationMs)} · ${record.jobs.length} job(s) · ${record.mvnLens.length} report set(s)${grafts.length ? `, ${grafts.length} from the inbox (${fmtBytes(bytes)})` : ''} [${t.sources.join(', ')}]`);
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      stats.runsFailed++;
      warning(`run ${t.id} skipped: ${e.message}`);
    }
  });
  processed.sort((a, b) => b.id - a.id);
  util.endGroup();

  // ---- 5. Merge -------------------------------------------------------------
  const workflowRecords = {};
  for (const wf of selected) workflowRecords[String(wf.id)] = { id: wf.id, name: wf.name, path: wf.path, state: wf.state };
  const mergeInto = (h) => {
    for (const wf of Object.values(workflowRecords)) h.workflows[String(wf.id)] = wf;
    for (const x of processed) {
      const theirs = history.findRun(h, x.id);
      if (theirs && theirs !== x.record) x.record.mvnLens = mergeEntries(theirs.mvnLens, x.record.mvnLens);
      history.upsertRun(h, x.record);
    }
    history.sortRuns(h);
  };
  mergeInto(hist);

  // ---- 6. Render ------------------------------------------------------------
  const indexHtml = renderIndexHtml({ title, dataset: null });
  const allGrafts = [];
  for (const x of processed) allGrafts.push(...x.grafts);
  const renderFiles = (h, previousText) => {
    finalizeHistory(h, facts);
    // generatedAt moves only when the content moved: an unchanged site is not a new commit (nor a Pages build).
    let text = history.serializeHistory(h);
    if (previousText === null || text !== previousText || !h.generatedAt) {
      h.generatedAt = isoNow();
      text = history.serializeHistory(h);
    }
    return [
      { path: historyPath, content: text },
      { path: posixJoin(inputs.siteDir, 'index.html'), content: indexHtml },
      { path: posixJoin(inputs.siteDir, '.nojekyll'), content: '' },
    ];
  };
  let files = renderFiles(hist, prevText);
  if (hist.stats.reportsBytes >= REPORTS_WARN_BYTES) {
    warning(`the mvn-lens reports on ${inputs.branch} total ${fmtBytes(hist.stats.reportsBytes)}; GitHub Pages serves sites up to 1 GB — retention is not built yet (delete the branch and re-run to reset the site)`);
  }
  stats.grafts = processed.reduce((n, x) => n + x.files, 0);
  stats.graftedBytes = processed.reduce((n, x) => n + x.bytes, 0);

  // ---- 7. Publish (or dry run) ----------------------------------------------
  let commit = null;
  let pages = null;
  if (inputs.dryRun) {
    const out = generateSite({ history: hist, siteDir: inputs.outputDir, title, siteUrl });
    log(`Dry run: site written to ${inputs.outputDir} (${fmtBytes(out.bytes)} index, ${hist.runs.length} run(s)); ${allGrafts.length} report set(s) would be grafted, nothing pushed, inbox refs untouched`);
  } else {
    util.group(`Publishing to ${inputs.branch}`);
    const numbers = processed.slice(0, 5).map(x => '#' + x.record.runNumber).join(', ');
    const message = processed.length
      ? `Build monitor: ${numbers}${processed.length > 5 ? ` and ${processed.length - 5} more` : ''}${stats.grafts ? ` (${stats.grafts} report file(s))` : ''}`
      : 'Build monitor: refresh';
    try {
      commit = await store.commitFiles({
        ref, files: files.concat(allGrafts), message, budgetMs: COMMIT_BUDGET_MS, sleep,
        // Somebody else moved the branch: merge what this invocation computed into THEIR history — but only
        // re-read it when its blob actually changed (a commit touching other files keeps our rendering).
        onConflict: async (newHead) => {
          if (!newHead) return undefined;
          const entry = await store.findEntry(newHead.treeSha, historyPath);
          const sha = entry && entry.type === 'blob' ? entry.sha : null;
          if (sha === prevSha) { debug(`conflict on ${ref}: ${historyPath} unchanged, retrying with the same files`); return undefined; }
          let theirs;
          let theirText = null;
          if (sha) {
            theirText = (await store.readBlob(sha, { maxBytes: MAX_HISTORY_BYTES, size: entry.size })).toString('utf8');
            theirs = parseHistoryOrFail(theirText, repo, `${inputs.branch}:${historyPath} (after a concurrent update)`);
          } else {
            theirs = history.emptyHistory(repo);
          }
          prevSha = sha;
          prevText = theirText;
          mergeInto(theirs);
          hist = theirs;
          files = renderFiles(theirs, theirText);
          log(`Merged ${processed.length} run(s) into the concurrently updated history (${theirs.runs.length} runs)`);
          return files.concat(allGrafts);
        },
      });
    } catch (e) {
      if (e instanceof GitStoreError) {
        const hint = e.kind === 'permission' ? ' — the job needs "contents: write" and the branch must accept pushes from the token'
          : e.kind === 'conflict' ? ' — the branch kept moving; the next invocation will retry (inbox refs are kept)'
            : '';
        throw new ConfigError(`publishing to ${inputs.branch} failed: ${e.message}${hint}`);
      }
      throw e;
    }
    state.commitSha = commit.sha;
    state.published = !!commit.changed;
    if (commit.changed) log(`${commit.created ? 'Created' : 'Updated'} ${inputs.branch} → ${commit.sha} (${commit.uploaded.length} blob(s) uploaded, ${allGrafts.length} tree(s) grafted${commit.attempts ? `, ${commit.attempts} CAS retry(ies)` : ''})`);
    else log(`${inputs.branch} is already up to date at ${commit.sha}; nothing to publish`);
    util.endGroup();

    // ---- 8. Pages build + inbox cleanup -------------------------------------
    if (commit.changed && inputs.requestPagesBuild) {
      try {
        await api.send('POST', `/repos/${repo}/pages/builds`);
        pages = 'requested';
        log('Requested a GitHub Pages build');
      } catch (e) {
        const kind = classifyError(e);
        if (kind === 'permission') {
          pages = 'not permitted';
          warning(`could not request a GitHub Pages build (${apiMessage(e)}): grant "pages: write" so the site is rebuilt; pushes made with GITHUB_TOKEN do not trigger Pages builds`);
        } else if (e.status === 404) {
          pages = 'Pages not enabled';
          warning(`GitHub Pages is not enabled for ${repo} (POST /pages/builds → 404): Settings → Pages → Build and deployment → "Deploy from a branch", branch ${inputs.branch}, folder /${inputs.siteDir ? ' (or configure a custom folder)' : '(root)'}`);
        } else if (e.status === 409) {
          pages = 'already queued';
          log('A GitHub Pages build is already queued');
        } else {
          pages = 'failed';
          warning(`could not request a GitHub Pages build: ${apiMessage(e)}`);
        }
      }
    }
    await deleteGraftedInboxRefs({ store, inputs, processed, stats });
  }

  // ---- 9. Outputs + job summary --------------------------------------------
  state.runsProcessed = processed.length;
  state.runsTotal = hist.runs.length;
  state.reportsCollected = stats.grafts;
  state.reportsBytes = hist.stats.reportsBytes;

  const code = s => '`' + String(s).replace(/[`\r\n]/g, '') + '`';
  const lines = ['### Build monitor', ''];
  lines.push(inputs.dryRun
    ? `Dry run — site written to ${code(inputs.outputDir)}${siteUrl ? ` (monitoring page: ${siteUrl})` : ''}`
    : (siteUrl ? `Monitoring page: ${siteUrl}` : 'Monitoring page: (unknown — set `site-url`)'));
  lines.push('');
  lines.push('| Workflows | Runs processed | Runs in history | Reports grafted | Reports on the site | API requests |');
  lines.push('|---|---|---|---|---|---|');
  const wfNames = selected.map(w => escapeMd(w.name));
  lines.push(`| ${wfNames.length ? wfNames.slice(0, 5).join(', ') + (wfNames.length > 5 ? ` (+${wfNames.length - 5})` : '') : '—'} | ${processed.length} | ${hist.runs.length} | ${stats.grafts} (${fmtBytes(stats.graftedBytes)}) | ${hist.stats.reportsCount} (${fmtBytes(hist.stats.reportsBytes)}) | ${api.requests} |`);
  lines.push('');
  if (inputs.dryRun) lines.push('Nothing published (dry run).');
  else if (commit && commit.changed) lines.push(`Published commit ${code(commit.sha.slice(0, 7))} to ${code(inputs.branch)}${pages ? ` · Pages build ${pages}` : ''}${stats.refsDeleted ? ` · ${stats.refsDeleted} inbox ref(s) deleted` : ''}.`);
  else lines.push(`Nothing new to publish (${code(inputs.branch)} at ${code(commit ? commit.sha.slice(0, 7) : '?')}).`);
  if (processed.length) {
    lines.push('');
    lines.push('| Run | Branch | Result | Duration | Reports |');
    lines.push('|---|---|---|---|---|');
    for (const x of processed.slice(0, SUMMARY_ROWS)) {
      const r = x.record;
      const label = `${escapeMd(r.workflowName || 'run')} #${r.runNumber}`;
      const urls = context.monitorUrls(siteUrl, r.id);
      const link = urls.run ? `[${label}](${urls.run})` : label;
      const result = r.status === 'completed' ? (r.conclusion || 'completed') : (r.status || '?');
      lines.push(`| ${link} | ${escapeMd(r.branch || '')} | ${escapeMd(result)} | ${fmtMs(r.durationMs)} | ${r.mvnLens.length}${x.files ? ` (+${x.files} grafted)` : ''} |`);
    }
    if (processed.length > SUMMARY_ROWS) lines.push(`| … ${processed.length - SUMMARY_ROWS} more | | | | |`);
  }
  const skipped = [];
  if (stats.forkRunsSkipped) skipped.push(`${stats.forkRunsSkipped} fork run(s)`);
  if (stats.notMonitored) skipped.push(`${stats.notMonitored} run(s) of unmonitored workflows`);
  if (stats.runsFailed) skipped.push(`${stats.runsFailed} run(s) that could not be processed (see the log)`);
  if (skipped.length) { lines.push(''); lines.push(`Skipped: ${skipped.join(', ')}.`); }
  appendSummary(lines.join('\n') + '\n');

  log(`Done: ${processed.length} run(s) processed, ${hist.runs.length} in the history, ${stats.grafts} report file(s) grafted; ${api.requests} API request(s), rate limit remaining ${api.rateLimitRemaining === null ? '?' : api.rateLimitRemaining}`);
  if (stats.runsFailed) warning(`${stats.runsFailed} run(s) could not be processed; see the log above`);
}

/**
 * Deletes the inbox refs whose report sets are now on the site branch. Only
 * the refs of COMPLETED runs go (a run that is still in progress may still be
 * pushing reports; its inbox is grafted again — by sha, for free — once it
 * completes), and only when the ref still points at the commit that was
 * grafted (a push after the snapshot would otherwise be lost). Failures here
 * are warnings: a leftover ref costs one more graft next time, never data.
 */
async function deleteGraftedInboxRefs(p) {
  const { store, inputs, processed, stats } = p;
  const candidates = processed.filter(x => x.inboxRef && x.grafts.length);
  if (!candidates.length) return;
  const todo = [];
  for (const x of candidates) {
    if (x.record.status === 'completed') todo.push(x);
    else log(`  inbox ref ${x.inboxRef} kept: run ${x.id} is still ${x.record.status || 'in progress'} (grafted again when it completes)`);
  }
  if (!todo.length) return;
  let current;
  try {
    current = new Map((await store.listRefs('heads/' + inputs.inboxPrefix)).map(r => [r.ref, r.sha]));
  } catch (e) {
    warning(`inbox refs could not be listed again before deletion (${e.message}); ${todo.length} ref(s) kept — they are grafted again next time (harmless)`);
    return;
  }
  for (const x of todo) {
    const sha = current.get(x.inboxRef);
    if (!sha) { debug(`${x.inboxRef} is already gone`); continue; }
    if (sha !== x.inboxSha) {
      warning(`inbox ref ${x.inboxRef} moved from ${x.inboxSha.slice(0, 7)} to ${sha.slice(0, 7)} after it was read (a report step pushed meanwhile); kept so the next invocation grafts the new reports`);
      continue;
    }
    try {
      if (await store.deleteRef(x.inboxRef)) { stats.refsDeleted++; debug(`deleted ${x.inboxRef}`); }
    } catch (e) {
      warning(`inbox ref ${x.inboxRef} could not be deleted (${e.message}); its reports are on ${inputs.branch} already and it will be grafted again next time (harmless)`);
    }
  }
  if (stats.refsDeleted) log(`Deleted ${stats.refsDeleted} inbox ref(s)`);
}

/** Sets the top-level facts in a fixed key order (the serialized text must be stable across invocations). */
function finalizeHistory(h, facts) {
  h.repositoryUrl = facts.repositoryUrl;
  h.defaultBranch = facts.defaultBranch;
  h.siteUrl = facts.siteUrl;
  h.serverUrl = facts.serverUrl;
  h.stats = computeStats(h);
}

function parseHistoryOrFail(text, repo, where) {
  try {
    return history.parseHistory(text, repo);
  } catch (e) {
    throw new ConfigError(`${where} is unusable: ${e.message}. Fix the file or delete the branch (this resets the site) and re-run.`);
  }
}

module.exports = { run, readInputs, buildEntry, markSuperseded, mergeEntries, slimSummary, computeStats, ConfigError };
