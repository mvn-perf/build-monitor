/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * The GitHub Actions context (GITHUB_* / RUNNER_* environment and the event
 * payload) and the URLs derived from it: the monitoring site, the viewer
 * routes, the inbox refs the report step pushes to, and workflow file links.
 * Everything here is pure apart from reading the event payload file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { safeInt, debug, posixJoin } = require('./util');
const { isValidKey } = require('./history');

const DEFAULT_INBOX_PREFIX = 'build-monitor-inbox/';
/** An event payload larger than this is not something we want to parse on a runner. */
const MAX_EVENT_BYTES = 32 * 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Reads the workflow-run context from the environment (defaults to process.env).
 * Numbers are validated with util.safeInt (null when absent or malformed),
 * strings are trimmed and null when empty; the event payload is parsed from
 * GITHUB_EVENT_PATH when the file exists and is valid JSON (null otherwise).
 */
function githubContext(env) {
  const e = env || process.env;
  const rawRepo = str(e.GITHUB_REPOSITORY);
  const repository = rawRepo && REPO_RE.test(rawRepo) ? rawRepo : null;
  if (rawRepo && !repository) debug(`GITHUB_REPOSITORY does not look like owner/name: ${rawRepo}`);
  const [owner, repoName] = splitRepo(repository);
  const serverUrl = trimSlashes(str(e.GITHUB_SERVER_URL) || 'https://github.com');
  const apiUrl = trimSlashes(str(e.GITHUB_API_URL) || 'https://api.github.com');
  const workflowRef = str(e.GITHUB_WORKFLOW_REF);
  return {
    repository,
    owner,
    repoName,
    serverUrl,
    apiUrl,
    runId: safeInt(e.GITHUB_RUN_ID),
    runNumber: safeInt(e.GITHUB_RUN_NUMBER),
    runAttempt: safeInt(e.GITHUB_RUN_ATTEMPT) || 1,
    jobKey: str(e.GITHUB_JOB),
    runnerName: str(e.RUNNER_NAME),
    workflowRef,
    /** ".github/workflows/x.yml" of the workflow this action runs in (from GITHUB_WORKFLOW_REF), or null. */
    workflowPath: workflowPathOf(workflowRef),
    workflowName: str(e.GITHUB_WORKFLOW),
    eventName: str(e.GITHUB_EVENT_NAME),
    event: readEvent(e.GITHUB_EVENT_PATH),
    sha: str(e.GITHUB_SHA),
    refName: str(e.GITHUB_REF_NAME),
    actor: str(e.GITHUB_ACTOR),
    isGitHubCom: isGitHubCom(serverUrl),
  };
}

/** The run that triggered a `workflow_run` event (from ctx.event.workflow_run), or null. */
function triggeringRun(ctx) {
  const wr = ctx && ctx.event && typeof ctx.event === 'object' ? ctx.event.workflow_run : null;
  if (!wr || typeof wr !== 'object') return null;
  const id = safeInt(wr.id);
  if (!id) return null;
  return {
    id,
    attempt: safeInt(wr.run_attempt) || 1,
    status: str(wr.status),
    conclusion: str(wr.conclusion),
    event: str(wr.event),
    workflowId: safeInt(wr.workflow_id),
    workflowName: str(wr.name),
    workflowPath: str(wr.path),
    headBranch: str(wr.head_branch),
    headSha: str(wr.head_sha),
    headRepository: wr.head_repository && typeof wr.head_repository === 'object' ? str(wr.head_repository.full_name) : null,
    htmlUrl: str(wr.html_url),
  };
}

/**
 * The GitHub Pages URL a repository gets by convention, with one trailing slash:
 * github.com → https://<owner>.github.io/<name>/ (https://<owner>.github.io/ for
 * the user/organisation site repository), GHES → <serverUrl>/pages/<owner>/<name>/.
 * `siteDir` (a directory inside the Pages branch) is appended when given.
 * Returns null without a repository.
 */
function defaultSiteUrl(ctx, siteDir) {
  const [owner, name] = splitRepo(ctx && ctx.repository);
  if (!owner || !name) return null;
  const serverUrl = trimSlashes(str(ctx.serverUrl) || 'https://github.com');
  let base;
  if (isGitHubCom(serverUrl)) {
    const o = owner.toLowerCase();
    const userSite = name.toLowerCase() === `${o}.github.io`;
    base = `https://${o}.github.io/` + (userSite ? '' : name + '/');
  } else {
    base = `${serverUrl}/pages/${owner}/${name}/`;
  }
  return withSiteDir(base, siteDir);
}

/**
 * The monitoring site URL, with exactly one trailing slash: the `site-url`
 * input when given, else the Pages URL the API reports (GET /repos/{r}/pages —
 * needs `pages: read`; every failure is ignored), else the conventional URL.
 * `siteDir/` is appended in every case. Null when nothing can be derived.
 */
async function resolveSiteUrl(p) {
  const o = p || {};
  const ctx = o.ctx || null;
  const repository = str(o.repository) || (ctx && ctx.repository) || null;
  let base = str(o.input);
  if (!base && o.api && repository && REPO_RE.test(repository)) {
    try {
      const pages = await o.api.get(`/repos/${repository}/pages`);
      const url = pages && typeof pages.html_url === 'string' ? pages.html_url.trim() : '';
      if (/^https?:\/\/\S+$/i.test(url)) base = url;
      else debug(`GET /repos/${repository}/pages returned no html_url`);
    } catch (e) {
      debug(`GET /repos/${repository}/pages failed (${e && e.message}); using the conventional Pages URL`);
    }
  }
  if (!base) base = defaultSiteUrl({ repository, serverUrl: ctx && ctx.serverUrl }, null);
  if (!base) return null;
  return withSiteDir(trimSlashes(base) + '/', o.siteDir);
}

/**
 * The monitoring page routes for a run / report. `run` needs a valid run id,
 * `report` additionally a valid key; those are null otherwise, and everything
 * is null without a site URL.
 */
function monitorUrls(siteUrl, runId, key) {
  const site = str(siteUrl) ? trimSlashes(str(siteUrl)) + '/' : null;
  const id = safeInt(runId);
  const k = key !== undefined && key !== null && isValidKey(String(key)) ? String(key) : null;
  return {
    site,
    run: site && id ? `${site}#/run/${id}` : null,
    report: site && id && k ? `${site}#/report/${id}/${k}` : null,
    reports: site ? `${site}#/reports` : null,
    builds: site ? `${site}#/builds` : null,
  };
}

/**
 * Normalises an inbox prefix into the branch-name prefix `…/` (default
 * 'build-monitor-inbox/'): strips 'refs/heads/' / 'heads/' / leading slashes,
 * adds the trailing slash and rejects anything git would refuse as a ref name.
 */
function normalizeInboxPrefix(prefix) {
  let p = prefix === undefined || prefix === null ? '' : String(prefix).trim();
  if (!p) p = DEFAULT_INBOX_PREFIX;
  p = p.replace(/^\/+/, '');
  if (p.startsWith('refs/heads/')) p = p.slice('refs/heads/'.length);
  else if (p.startsWith('heads/')) p = p.slice('heads/'.length);
  p = p.replace(/\/+/g, '/').replace(/^\/+/, '');
  if (!p.endsWith('/')) p += '/';
  const bad = p === '/' ? 'is empty'
    : (/[\s~^:?*[\\]/.test(p) || hasControlChar(p)) ? 'contains characters git refuses in ref names'
      : /\.\.|@\{/.test(p) ? 'contains ".." or "@{"'
        : p.split('/').slice(0, -1).some(seg => seg === '' || seg.startsWith('.') || seg.endsWith('.lock') || seg.endsWith('.')) ? 'has a segment git refuses (empty, starting with ".", ending with "." or ".lock")'
          : null;
  if (bad) throw new Error(`inbox-prefix "${prefix}" ${bad}`);
  return p;
}

/** The inbox ref of a run: `heads/<prefix><runId>`. Throws on an invalid run id or prefix. */
function inboxRef(prefix, runId) {
  const id = safeInt(runId);
  if (!id) throw new Error(`inboxRef: invalid run id ${JSON.stringify(runId)}`);
  return `heads/${normalizeInboxPrefix(prefix)}${id}`;
}

/**
 * The run id an inbox ref name encodes ('refs/heads/<prefix><id>', 'heads/<prefix><id>'
 * or the bare branch name), or null when the name is not an inbox ref of that prefix.
 */
function parseInboxRef(refName, prefix) {
  if (typeof refName !== 'string') return null;
  let p;
  try { p = normalizeInboxPrefix(prefix); } catch (e) { return null; }
  let name = refName.trim();
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  else if (name.startsWith('heads/')) name = name.slice('heads/'.length);
  if (!name.startsWith(p)) return null;
  const rest = name.slice(p.length);
  if (!/^\d{1,16}$/.test(rest)) return null;
  return safeInt(rest);
}

/**
 * Link to a workflow's page: `<serverUrl>/<repository>/actions/workflows/<file>`.
 * `path` may be a workflow path ('.github/workflows/ci.yml'), a bare file name or
 * a GITHUB_WORKFLOW_REF ('owner/repo/.github/workflows/ci.yml@refs/heads/main');
 * when omitted the context's own workflow is used. Null when unknown.
 */
function workflowFileUrl(ctx, p) {
  if (!ctx || !ctx.repository || !REPO_RE.test(String(ctx.repository))) return null;
  let file = str(p);
  if (file) {
    const fromRef = workflowPathOf(file);
    if (fromRef) file = fromRef;
  } else {
    file = str(ctx.workflowPath) || workflowPathOf(str(ctx.workflowRef));
  }
  if (!file) return null;
  file = file.replace(/\\/g, '/');
  if (file.endsWith('/')) return null;   // a directory, not a workflow file
  const base = path.posix.basename(file);
  if (!base || base === '.' || base === '..') return null;
  const serverUrl = trimSlashes(str(ctx.serverUrl) || 'https://github.com');
  return `${serverUrl}/${ctx.repository}/actions/workflows/${encodeURIComponent(base)}`;
}

// ---------------------------------------------------------------------------

function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function trimSlashes(s) { return String(s).replace(/\/+$/, ''); }

function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

function splitRepo(repository) {
  const r = str(repository);
  if (!r || !REPO_RE.test(r)) return [null, null];
  const i = r.indexOf('/');
  return [r.slice(0, i), r.slice(i + 1)];
}

function isGitHubCom(serverUrl) {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    return host === 'github.com' || host === 'www.github.com';
  } catch (e) {
    return false;
  }
}

/** ".github/workflows/x.yml" from "owner/repo/.github/workflows/x.yml@refs/heads/main" (null for anything else). */
function workflowPathOf(ref) {
  const m = /^[^/\s@]+\/[^/\s@]+\/(.+?)@[^@]*$/.exec(ref || '');
  return m ? m[1] : null;
}

function withSiteDir(base, siteDir) {
  const segs = posixJoin(siteDir).split('/').filter(s => s && s !== '.');
  return segs.length ? base + segs.join('/') + '/' : base;
}

function readEvent(file) {
  const f = str(file);
  if (!f) return null;
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return null;
    if (st.size > MAX_EVENT_BYTES) { debug(`event payload ${f} is ${st.size} bytes; ignored`); return null; }
    const ev = JSON.parse(fs.readFileSync(f, 'utf8'));
    return ev && typeof ev === 'object' && !Array.isArray(ev) ? ev : null;
  } catch (e) {
    debug(`event payload ${f} unreadable: ${e.message}`);
    return null;
  }
}

module.exports = {
  DEFAULT_INBOX_PREFIX,
  githubContext, triggeringRun, defaultSiteUrl, resolveSiteUrl, monitorUrls,
  inboxRef, parseInboxRef, normalizeInboxPrefix, workflowFileUrl, workflowPathOf,
};
