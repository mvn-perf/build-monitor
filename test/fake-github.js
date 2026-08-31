/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

/**
 * A stateful in-memory fake of the GitHub REST API (Git Data + a slice of
 * Actions/Pages), shared by every test suite. Objects are hashed exactly like
 * git does (blob/tree/commit shas are real), so what the store computes for a
 * given content equals what api.github.com would answer, and tests can pin
 * known values.
 *
 *   const fake = createFakeGitHub({ repository: 'acme/widgets', runs: [...] });
 *   const api = new GitHubApi({ token: 't', fetch: fake.fetch });
 *   fake.hook(({ method, path }) => { if (method === 'PATCH') fake.store.seedBranch('gh-pages', { 'x': '1' }); });
 *   const { url, close } = await fake.serve();   // for spawn tests (GITHUB_API_URL=url)
 */

const crypto = require('crypto');
const http = require('http');

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA_RE = /^[0-9a-f]{40}$/;

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function gitObjectSha(type, body) { return sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'latin1'), body])); }
function blobSha(buf) { return gitObjectSha('blob', buf); }

/** git orders tree entries by name, comparing directories as if their name ended with '/'. */
function treeEntryCompare(a, b) {
  const an = Buffer.from(a.type === 'tree' ? a.path + '/' : a.path, 'utf8');
  const bn = Buffer.from(b.type === 'tree' ? b.path + '/' : b.path, 'utf8');
  return Buffer.compare(an, bn);
}
function apiMode(mode, type) {
  if (type === 'tree') return '040000';
  return mode === '100755' ? '100755' : (mode === '120000' ? '120000' : '100644');
}
function gitMode(mode, type) { return type === 'tree' ? '40000' : apiMode(mode, type); }

class ApiError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || null; }
}

// ---------------------------------------------------------------------------
// Object store
// ---------------------------------------------------------------------------

function createStore() {
  const objects = new Map();
  const refs = new Map();
  let clock = 1700000000; // fake commit timestamps: monotonic, deterministic

  function putBlob(buf) {
    const sha = blobSha(buf);
    if (!objects.has(sha)) objects.set(sha, { type: 'blob', data: buf });
    return sha;
  }

  /** entries: [{ path, mode, type, sha }] (one level) → tree sha, stored. */
  function putTree(entries) {
    const sorted = entries.slice().sort(treeEntryCompare);
    const parts = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${gitMode(e.mode, e.type)} ${e.path}\0`, 'utf8'));
      parts.push(Buffer.from(e.sha, 'hex'));
    }
    const body = Buffer.concat(parts);
    const sha = gitObjectSha('tree', body);
    if (!objects.has(sha)) objects.set(sha, { type: 'tree', entries: sorted.map(e => ({ path: e.path, mode: apiMode(e.mode, e.type), type: e.type, sha: e.sha })) });
    return sha;
  }

  function putCommit(c) {
    const ts = c.date ? Math.floor(Date.parse(c.date) / 1000) : clock++;
    const author = c.author || { name: 'Test', email: 'test@example.test' };
    const committer = c.committer || author;
    const lines = [`tree ${c.tree}`];
    for (const p of c.parents) lines.push(`parent ${p}`);
    lines.push(`author ${author.name} <${author.email}> ${ts} +0000`);
    lines.push(`committer ${committer.name} <${committer.email}> ${ts} +0000`);
    const body = Buffer.from(lines.join('\n') + '\n\n' + (c.message || ''), 'utf8');
    const sha = gitObjectSha('commit', body);
    if (!objects.has(sha)) {
      objects.set(sha, { type: 'commit', commit: { tree: c.tree, parents: c.parents.slice(), message: c.message || '', author: Object.assign({ date: new Date(ts * 1000).toISOString() }, author), committer: Object.assign({ date: new Date(ts * 1000).toISOString() }, committer) } });
    }
    return sha;
  }

  function obj(sha, type) {
    const o = typeof sha === 'string' ? objects.get(sha.toLowerCase()) : null;
    if (!o || (type && o.type !== type)) return null;
    return o;
  }
  function tree(sha) { const o = obj(sha, 'tree'); return o ? o.entries : null; }
  function blob(sha) { const o = obj(sha, 'blob'); return o ? o.data : null; }
  function commit(sha) { const o = obj(sha, 'commit'); return o ? o.commit : null; }

  // --- overlay: a mutable directory view over a base tree (lazy expansion) ---
  function dirNode(sha) { return { type: 'tree', sha, children: null }; }
  function expand(node) {
    if (node.children) return node.children;
    node.children = new Map();
    if (node.sha) {
      const entries = tree(node.sha);
      if (!entries) throw new ApiError(422, `Tree SHA ${node.sha} does not exist`);
      for (const e of entries) node.children.set(e.path, e.type === 'tree' ? dirNode(e.sha) : { type: e.type, mode: e.mode, sha: e.sha });
    }
    node.sha = null; // dirty from now on
    return node.children;
  }
  function splitPath(p) {
    if (typeof p !== 'string' || p === '' || p.startsWith('/') || /\\/.test(p)) throw new ApiError(422, `Invalid path: ${JSON.stringify(p)}`);
    const segs = p.split('/');
    for (const s of segs) if (s === '' || s === '.' || s === '..') throw new ApiError(422, `Invalid path: ${JSON.stringify(p)}`);
    return segs;
  }
  function setEntry(root, path, entry) {
    const segs = splitPath(path);
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const children = expand(node);
      let next = children.get(segs[i]);
      if (!next || next.type !== 'tree') { next = dirNode(null); next.children = new Map(); children.set(segs[i], next); }
      node = next;
    }
    const children = expand(node);
    const name = segs[segs.length - 1];
    if (entry === null) {
      children.delete(name);
    } else {
      children.set(name, entry.type === 'tree' ? dirNode(entry.sha) : { type: 'blob', mode: entry.mode, sha: entry.sha });
    }
  }
  function materialize(node) {
    if (!node.children) return node.sha;
    const entries = [];
    for (const [name, child] of node.children) {
      if (child.type === 'tree') {
        const sha = materialize(child);
        if (sha === EMPTY_TREE_SHA) continue; // git does not keep empty directories
        entries.push({ path: name, mode: '040000', type: 'tree', sha });
      } else {
        entries.push({ path: name, mode: child.mode, type: 'blob', sha: child.sha });
      }
    }
    return putTree(entries);
  }

  /**
   * Applies API-shaped entries onto baseTreeSha (null ⇒ empty). Entry with
   * `sha: null` deletes the path; `content` (utf-8) creates the blob.
   */
  function overlayTree(baseTreeSha, entries) {
    if (baseTreeSha !== null && baseTreeSha !== undefined && !tree(baseTreeSha)) throw new ApiError(422, `base_tree ${baseTreeSha} is not a valid tree sha`);
    const root = dirNode(baseTreeSha || null);
    if (!baseTreeSha) root.children = new Map();
    for (const e of entries) {
      if (!e || typeof e !== 'object') throw new ApiError(422, 'Invalid tree entry');
      if (e.sha === null) { setEntry(root, e.path, null); continue; }
      const type = e.type || 'blob';
      if (type === 'tree') {
        if (!SHA_RE.test(String(e.sha || ''))) throw new ApiError(422, `Invalid tree sha for ${e.path}`);
        if (!tree(e.sha)) throw new ApiError(422, `Tree SHA ${e.sha} does not exist`);
        setEntry(root, e.path, { type: 'tree', sha: e.sha.toLowerCase() });
      } else if (type === 'blob') {
        const mode = e.mode === undefined ? '100644' : String(e.mode);
        if (!['100644', '100755', '120000'].includes(mode)) throw new ApiError(422, `Invalid mode ${mode} for ${e.path}`);
        let sha = e.sha;
        if (sha === undefined && typeof e.content === 'string') sha = putBlob(Buffer.from(e.content, 'utf8'));
        if (!SHA_RE.test(String(sha || ''))) throw new ApiError(422, `Invalid blob sha for ${e.path}`);
        if (!blob(sha)) throw new ApiError(422, `Blob SHA ${sha} does not exist`);
        setEntry(root, e.path, { type: 'blob', mode, sha: sha.toLowerCase() });
      } else {
        throw new ApiError(422, `Unsupported tree entry type ${type}`);
      }
    }
    return materialize(root);
  }

  function refName(branch) {
    const b = String(branch);
    if (b.startsWith('refs/')) return b;
    if (b.startsWith('heads/') || b.startsWith('tags/')) return 'refs/' + b;
    return 'refs/heads/' + b;
  }
  function headOf(branch) { return refs.get(refName(branch)) || null; }
  function treeOf(branch) { const c = commit(headOf(branch)); return c ? c.tree : null; }

  /** Walks a tree by path; returns the entry or null. '' → a synthetic root entry. */
  function entryAt(treeSha, path) {
    if (!treeSha) return null;
    if (!path) return { path: '', mode: '040000', type: 'tree', sha: treeSha };
    let sha = treeSha;
    const segs = String(path).split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const entries = tree(sha);
      if (!entries) return null;
      const e = entries.find(x => x.path === segs[i]);
      if (!e) return null;
      if (i === segs.length - 1) return e;
      if (e.type !== 'tree') return null;
      sha = e.sha;
    }
    return null;
  }

  /**
   * Adds one commit to `branch` (created when absent) carrying `files`
   * ({ path: Buffer|string|null }) on top of the current head's tree, so
   * previous files survive; `null` deletes a path. `{ replace: true }` starts
   * from an empty tree instead (still a child commit); `{ orphan: true }`
   * makes a parentless commit (and replaces the ref).
   */
  function seedBranch(branch, files, opts) {
    const o = opts || {};
    const ref = refName(branch);
    const head = refs.get(ref) || null;
    const base = head && !o.replace && !o.orphan ? commit(head).tree : null;
    const entries = [];
    for (const [p, v] of Object.entries(files || {})) {
      if (v === null) { entries.push({ path: p, sha: null }); continue; }
      const buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
      entries.push({ path: p, mode: '100644', type: 'blob', sha: putBlob(buf) });
    }
    const treeSha = overlayTree(base, entries);
    const sha = putCommit({ tree: treeSha, parents: head && !o.orphan ? [head] : [], message: o.message || `seed ${branch}`, author: o.author });
    refs.set(ref, sha);
    return sha;
  }

  function readFile(branch, path) {
    const e = entryAt(treeOf(branch), path);
    return e && e.type === 'blob' ? blob(e.sha) : null;
  }
  function listDir(branch, path) {
    const e = entryAt(treeOf(branch), path || '');
    if (!e || e.type !== 'tree') return [];
    return tree(e.sha).map(x => x.path).sort();
  }
  function commitsOf(branch) {
    const out = [];
    let sha = headOf(branch);
    const seen = new Set();
    while (sha && !seen.has(sha)) {
      seen.add(sha);
      out.push(sha);
      const c = commit(sha);
      sha = c && c.parents.length ? c.parents[0] : null;
    }
    return out;
  }
  /** True when `ancestor` is reachable from `sha` through parent links (or equal). */
  function isAncestor(ancestor, sha) {
    const queue = [sha];
    const seen = new Set();
    while (queue.length) {
      const s = queue.shift();
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = commit(s);
      if (c) queue.push(...c.parents);
    }
    return false;
  }

  return {
    objects, refs, EMPTY_TREE_SHA,
    putBlob, putTree, putCommit, overlayTree, blob, tree, commit, entryAt, refName, isAncestor,
    seedBranch, readFile, listDir, headOf, treeOf, commitsOf, blobSha,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function createFakeGitHub(scenario) {
  const sc = Object.assign({ repository: 'acme/widgets', defaultBranch: 'main', workflows: [], runs: [], pages: null, readOnly: false, rateLimit: null, empty: false, token: null }, scenario || {});
  const repo = sc.repository;
  const store = createStore();
  const calls = [];
  const hooks = [];
  const opts = sc; // live: tests may flip fake.opts.readOnly etc. between requests
  let rateLimitLeft = sc.rateLimit && sc.rateLimit.times ? Number(sc.rateLimit.times) : 0;

  function hook(fn) { if (fn === null) hooks.length = 0; else hooks.push(fn); }

  function json(status, body, headers) { return { status, body: Buffer.from(JSON.stringify(body), 'utf8'), headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {}) }; }
  function notFound(what) { return json(404, { message: 'Not Found' + (what ? ': ' + what : ''), documentation_url: 'https://docs.github.com/rest' }); }
  function err(e) { return json(e.status, Object.assign({ message: e.message, documentation_url: 'https://docs.github.com/rest' }, e.extra || {})); }

  function refObject(name) { return { ref: name, node_id: 'REF_' + sha1(name).slice(0, 16), url: `https://api.github.com/repos/${repo}/git/${name}`, object: { type: 'commit', sha: store.refs.get(name), url: `https://api.github.com/repos/${repo}/git/commits/${store.refs.get(name)}` } }; }
  function commitObject(sha) {
    const c = store.commit(sha);
    return { sha, node_id: 'C_' + sha.slice(0, 16), url: `https://api.github.com/repos/${repo}/git/commits/${sha}`, html_url: `https://github.com/${repo}/commit/${sha}`, message: c.message, author: c.author, committer: c.committer, tree: { sha: c.tree, url: `https://api.github.com/repos/${repo}/git/trees/${c.tree}` }, parents: c.parents.map(p => ({ sha: p, url: `https://api.github.com/repos/${repo}/git/commits/${p}` })), verification: { verified: false, reason: 'unsigned' } };
  }
  function treeEntryOut(e, prefix) {
    const out = { path: prefix ? prefix + '/' + e.path : e.path, mode: e.mode, type: e.type, sha: e.sha, url: `https://api.github.com/repos/${repo}/git/${e.type === 'tree' ? 'trees' : 'blobs'}/${e.sha}` };
    if (e.type === 'blob') out.size = store.blob(e.sha).length;
    return out;
  }
  function treeObject(sha, recursive) {
    const entries = [];
    (function walk(t, prefix) {
      for (const e of store.tree(t)) {
        entries.push(treeEntryOut(e, prefix));
        if (recursive && e.type === 'tree') walk(e.sha, prefix ? prefix + '/' + e.path : e.path);
      }
    })(sha, '');
    return { sha, url: `https://api.github.com/repos/${repo}/git/trees/${sha}`, tree: entries, truncated: false };
  }
  function runOut(r, attempt) {
    const out = {};
    for (const k of Object.keys(r)) if (k !== 'jobs' && k !== 'artifacts') out[k] = r[k];
    if (attempt) out.run_attempt = attempt;
    return out;
  }
  function jobAttempt(run, job) { return job.run_attempt || run.run_attempt || 1; }

  /** per_page/page slicing with a GitHub-style Link header. */
  function paged(u, items, key, extra) {
    const perPage = Math.max(1, Math.min(100, Number(u.searchParams.get('per_page') || 30) || 30));
    const page = Math.max(1, Number(u.searchParams.get('page') || 1) || 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const lastPage = Math.max(1, Math.ceil(items.length / perPage));
    const links = [];
    const withPage = (n) => { const x = new URL(u); x.searchParams.set('page', String(n)); return x.toString(); };
    if (page < lastPage) { links.push(`<${withPage(page + 1)}>; rel="next"`); links.push(`<${withPage(lastPage)}>; rel="last"`); }
    if (page > 1) { links.push(`<${withPage(page - 1)}>; rel="prev"`); links.push(`<${withPage(1)}>; rel="first"`); }
    const headers = links.length ? { link: links.join(', ') } : {};
    const body = key ? Object.assign({ total_count: items.length }, extra || {}, { [key]: slice }) : slice;
    return json(200, body, headers);
  }

  function createdFilter(expr) {
    if (!expr) return () => true;
    const day = (s) => Date.parse(s.length === 10 ? s + 'T00:00:00Z' : s);
    let m;
    if ((m = /^>=?(.+)$/.exec(expr))) { const t = day(m[1]); return r => Date.parse(r.created_at) >= t; }
    if ((m = /^<=?(.+)$/.exec(expr))) { const t = day(m[1]); return r => Date.parse(r.created_at) <= t; }
    if ((m = /^(.+)\.\.(.+)$/.exec(expr))) { const a = day(m[1]); const b = day(m[2]) + 86400000; return r => Date.parse(r.created_at) >= a && Date.parse(r.created_at) < b; }
    const t = day(expr);
    return r => Date.parse(r.created_at) >= t && Date.parse(r.created_at) < t + 86400000;
  }

  function findRun(id) { return sc.runs.find(r => String(r.id) === String(id)) || null; }

  /** Routes a request; returns { status, body: Buffer, headers }. */
  function route(method, u, headers, bodyText) {
    const accept = headers.get('accept') || '';
    const prefix = `/repos/${repo}/`;
    const pathname = u.pathname;
    if (pathname.toLowerCase() !== `/repos/${repo}`.toLowerCase() && !pathname.toLowerCase().startsWith(prefix.toLowerCase())) return notFound();
    const rest = pathname.length > prefix.length ? pathname.slice(prefix.length) : '';
    let body = null;
    if (bodyText) { try { body = JSON.parse(bodyText); } catch (e) { return json(400, { message: 'Problems parsing JSON' }); } }
    const mutating = method !== 'GET' && method !== 'HEAD';
    const isGit = rest.startsWith('git/');

    if (opts.readOnly && mutating) return json(403, { message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest' });
    if (mutating && rateLimitLeft > 0) {
      rateLimitLeft--;
      return json(403, { message: 'API rate limit exceeded for installation ID 1234.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' }, { 'retry-after': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '1000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1) });
    }
    if (opts.empty && isGit) return json(409, { message: 'Git Repository is empty.', documentation_url: 'https://docs.github.com/rest' });

    let m;
    // --- repository / actions / pages ---
    if (method === 'GET' && rest === '') {
      const [owner, name] = repo.split('/');
      return json(200, { id: 1, name, full_name: repo, owner: { login: owner }, private: false, html_url: `https://github.com/${repo}`, default_branch: sc.defaultBranch, has_pages: !!sc.pages });
    }
    if (method === 'GET' && rest === 'actions/workflows') {
      const wfs = sc.workflows.map(w => Object.assign({ state: 'active', html_url: `https://github.com/${repo}/blob/${sc.defaultBranch}/${w.path}` }, w));
      return paged(u, wfs, 'workflows');
    }
    if (method === 'GET' && (m = /^actions\/workflows\/([^/]+)\/runs$/.exec(rest))) {
      const id = decodeURIComponent(m[1]);
      const wf = sc.workflows.find(w => String(w.id) === id || (w.path && w.path.split('/').pop() === id));
      if (!wf) return notFound();
      const branch = u.searchParams.get('branch');
      const event = u.searchParams.get('event');
      const status = u.searchParams.get('status');
      const created = createdFilter(u.searchParams.get('created'));
      const runs = sc.runs
        .filter(r => r.workflow_id === wf.id && (!branch || r.head_branch === branch) && (!event || r.event === event) && (!status || r.status === status || r.conclusion === status) && created(r))
        .sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || (b.id - a.id))
        .map(r => runOut(r));
      return paged(u, runs, 'workflow_runs');
    }
    if (method === 'GET' && (m = /^actions\/runs\/(\d+)$/.exec(rest))) {
      const r = findRun(m[1]);
      return r ? json(200, runOut(r)) : notFound();
    }
    if (method === 'GET' && (m = /^actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(rest))) {
      const r = findRun(m[1]);
      const n = Number(m[2]);
      if (!r || n < 1 || n > (r.run_attempt || 1)) return notFound();
      return json(200, runOut(r, n));
    }
    if (method === 'GET' && (m = /^actions\/runs\/(\d+)\/jobs$/.exec(rest))) {
      const r = findRun(m[1]);
      if (!r) return notFound();
      const filter = u.searchParams.get('filter') || 'latest';
      if (filter !== 'latest' && filter !== 'all') return json(422, { message: 'Invalid filter' });
      const latest = r.run_attempt || 1;
      const jobs = (r.jobs || []).filter(j => filter === 'all' || jobAttempt(r, j) === latest);
      return paged(u, jobs, 'jobs');
    }
    if (method === 'GET' && (m = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(rest))) {
      const r = findRun(m[1]);
      const n = Number(m[2]);
      if (!r || n < 1 || n > (r.run_attempt || 1)) return notFound();
      return paged(u, (r.jobs || []).filter(j => jobAttempt(r, j) === n), 'jobs');
    }
    if (method === 'GET' && (m = /^actions\/jobs\/(\d+)$/.exec(rest))) {
      for (const r of sc.runs) for (const j of r.jobs || []) if (String(j.id) === m[1]) return json(200, j);
      return notFound();
    }
    if (method === 'GET' && rest === 'pages') {
      if (!sc.pages) return notFound();
      return json(200, Object.assign({ url: `https://api.github.com/repos/${repo}/pages`, status: 'built', source: { branch: 'gh-pages', path: '/' }, build_type: 'legacy', public: true }, sc.pages));
    }
    if (method === 'POST' && rest === 'pages/builds') {
      if (!sc.pages) return notFound();
      return json(201, { url: `https://api.github.com/repos/${repo}/pages/builds/latest`, status: 'queued' });
    }
    if (method === 'GET' && rest === 'pages/builds/latest') {
      if (!sc.pages) return notFound();
      return json(200, { status: 'built', error: { message: null } });
    }

    // --- Git Data ---
    if (method === 'POST' && rest === 'git/blobs') {
      if (!body || typeof body.content !== 'string') return json(422, { message: 'Invalid request.\n\n"content" wasn\'t supplied.' });
      const enc = body.encoding || 'utf-8';
      if (enc !== 'base64' && enc !== 'utf-8') return json(422, { message: `Invalid encoding ${enc}` });
      const buf = enc === 'base64' ? Buffer.from(body.content.replace(/\s+/g, ''), 'base64') : Buffer.from(body.content, 'utf8');
      const sha = store.putBlob(buf);
      return json(201, { sha, url: `https://api.github.com/repos/${repo}/git/blobs/${sha}` });
    }
    if (method === 'GET' && (m = /^git\/blobs\/([0-9a-fA-F]{40})$/.exec(rest))) {
      const sha = m[1].toLowerCase();
      const data = store.blob(sha);
      if (!data) return notFound();
      if (/\braw\b/.test(accept)) return { status: 200, body: data, headers: { 'content-type': 'application/vnd.github.raw+json; charset=utf-8', 'content-length': String(data.length) } };
      const b64 = data.toString('base64').replace(/(.{60})/g, '$1\n');
      return json(200, { sha, node_id: 'B_' + sha.slice(0, 16), size: data.length, url: `https://api.github.com/repos/${repo}/git/blobs/${sha}`, content: b64 + (b64.endsWith('\n') ? '' : '\n'), encoding: 'base64' });
    }
    if (method === 'POST' && rest === 'git/trees') {
      if (!body || !Array.isArray(body.tree) || body.tree.length === 0) return json(422, { message: 'Invalid request.\n\nFor \'properties/tree\', nil is not an array of at least 1 item.' });
      let base = body.base_tree;
      if (base !== undefined && base !== null && !SHA_RE.test(String(base))) return json(422, { message: `base_tree is not a valid sha: ${base}` });
      if (base) base = String(base).toLowerCase();
      try {
        const sha = store.overlayTree(base || null, body.tree);
        return json(201, treeObject(sha, false));
      } catch (e) { if (e instanceof ApiError) return err(e); throw e; }
    }
    if (method === 'GET' && (m = /^git\/trees\/([0-9a-fA-F]{40})$/.exec(rest))) {
      const sha = m[1].toLowerCase();
      if (!store.tree(sha)) return notFound();
      const rec = u.searchParams.get('recursive');
      return json(200, treeObject(sha, rec !== null && rec !== '' && rec !== '0' && rec !== 'false'));
    }
    if (method === 'POST' && rest === 'git/commits') {
      if (!body || typeof body.message !== 'string' || !SHA_RE.test(String(body.tree || ''))) return json(422, { message: 'Invalid request.\n\n"tree" and "message" are required.' });
      if (!store.tree(body.tree.toLowerCase())) return json(422, { message: `Tree SHA does not exist: ${body.tree}` });
      const parents = Array.isArray(body.parents) ? body.parents : [];
      for (const p of parents) if (!SHA_RE.test(String(p || '')) || !store.commit(p.toLowerCase())) return json(422, { message: `Parent SHA does not exist or is not a commit: ${p}` });
      for (const who of ['author', 'committer']) {
        const v = body[who];
        if (v !== undefined && (!v || typeof v.name !== 'string' || typeof v.email !== 'string' || !v.name || !v.email)) return json(422, { message: `Invalid ${who}: name and email are required` });
      }
      const sha = store.putCommit({ tree: body.tree.toLowerCase(), parents: parents.map(p => p.toLowerCase()), message: body.message, author: body.author, committer: body.committer || body.author, date: body.author && body.author.date });
      return json(201, commitObject(sha));
    }
    if (method === 'GET' && (m = /^git\/commits\/([0-9a-fA-F]{40})$/.exec(rest))) {
      const sha = m[1].toLowerCase();
      return store.commit(sha) ? json(200, commitObject(sha)) : notFound();
    }
    if (method === 'GET' && (m = /^git\/ref\/(.+)$/.exec(rest))) {
      const name = 'refs/' + decodeURIComponent(m[1]);
      return store.refs.has(name) ? json(200, refObject(name)) : notFound();
    }
    if (method === 'GET' && (m = /^git\/matching-refs\/(.*)$/.exec(rest))) {
      const p = 'refs/' + decodeURIComponent(m[1]);
      const names = Array.from(store.refs.keys()).filter(n => n.startsWith(p)).sort();
      return paged(u, names.map(refObject), null);
    }
    if (method === 'POST' && rest === 'git/refs') {
      if (!body || typeof body.ref !== 'string' || !/^refs\/[^/]+\/.+/.test(body.ref) || /(^|\/)\.\.?(\/|$)|\.lock$|\/$|[\s~^:?*[\\]/.test(body.ref)) return json(422, { message: 'Reference name must be formatted as refs/heads/<name> or refs/tags/<name>' });
      if (!SHA_RE.test(String(body.sha || ''))) return json(422, { message: 'Invalid request.\n\n"sha" is not a valid sha.' });
      if (store.refs.has(body.ref)) return json(422, { message: 'Reference already exists', documentation_url: 'https://docs.github.com/rest/git/refs#create-a-reference' });
      if (!store.commit(body.sha.toLowerCase())) return json(422, { message: 'Object does not exist' });
      store.refs.set(body.ref, body.sha.toLowerCase());
      return json(201, refObject(body.ref));
    }
    if (method === 'PATCH' && (m = /^git\/refs\/(.+)$/.exec(rest))) {
      const name = 'refs/' + decodeURIComponent(m[1]);
      if (!store.refs.has(name)) return json(422, { message: 'Reference does not exist' });
      if (!body || !SHA_RE.test(String(body.sha || ''))) return json(422, { message: 'Invalid request.\n\n"sha" is not a valid sha.' });
      const sha = body.sha.toLowerCase();
      if (!store.commit(sha)) return json(422, { message: 'Object does not exist' });
      const current = store.refs.get(name);
      if (!body.force && sha !== current && !store.isAncestor(current, sha)) return json(422, { message: 'Update is not a fast forward', documentation_url: 'https://docs.github.com/rest/git/refs#update-a-reference' });
      store.refs.set(name, sha);
      return json(200, refObject(name));
    }
    if (method === 'DELETE' && (m = /^git\/refs\/(.+)$/.exec(rest))) {
      const name = 'refs/' + decodeURIComponent(m[1]);
      if (!store.refs.has(name)) return json(422, { message: 'Reference does not exist' });
      store.refs.delete(name);
      return { status: 204, body: Buffer.alloc(0), headers: {} };
    }
    return notFound(`${method} ${pathname}`);
  }

  function headerMap(h) {
    const map = new Map();
    if (!h) return map;
    if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => map.set(String(k).toLowerCase(), String(v)));
    else for (const [k, v] of Object.entries(h)) map.set(String(k).toLowerCase(), String(v));
    return { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null), entries: () => map.entries() };
  }

  async function handle(method, u, headers, bodyText) {
    const path = u.pathname + (u.search || '');
    let parsedBody = null;
    if (bodyText) { try { parsedBody = JSON.parse(bodyText); } catch (e) { parsedBody = bodyText; } }
    calls.push({ method, url: u.toString(), path, headers: Object.fromEntries(headers.entries()), body: parsedBody });
    for (const fn of hooks) await fn({ method, path, pathname: u.pathname, url: u.toString(), body: parsedBody, headers });
    if (opts.token && headers.get('authorization') !== `Bearer ${opts.token}` && headers.get('authorization') !== `token ${opts.token}`) {
      return json(401, { message: 'Bad credentials' });
    }
    return route(method, u, headers, bodyText);
  }

  async function fetchImpl(url, init) {
    const i = init || {};
    const method = String(i.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    let bodyText = '';
    if (i.body !== undefined && i.body !== null) bodyText = Buffer.isBuffer(i.body) ? i.body.toString('utf8') : String(i.body);
    const res = await handle(method, u, headerMap(i.headers), bodyText);
    return response(res.status, res.body, res.headers);
  }

  /** Serves the same router over HTTP for spawn tests (point GITHUB_API_URL at `url`). */
  function serve() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const origin = `http://127.0.0.1:${server.address().port}`;
          const u = new URL(req.url, origin);
          handle(String(req.method).toUpperCase(), u, headerMap(req.headers), Buffer.concat(chunks).toString('utf8')).then(r => {
            const headers = Object.assign({ 'x-ratelimit-remaining': '999', 'x-ratelimit-limit': '1000' }, r.headers || {});
            if (r.status !== 204) headers['content-length'] = String(r.body.length);
            res.writeHead(r.status, headers);
            res.end(r.status === 204 ? undefined : r.body);
          }).catch(e => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: 'fake server error: ' + e.message }));
          });
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        resolve({ url, server, close: () => new Promise(r => server.close(() => r())) });
      });
    });
  }

  return { fetch: fetchImpl, calls, store, hook, serve, opts, scenario: sc };
}

/** A fetch-Response look-alike (status, ok, headers.get, text, arrayBuffer, json). */
function response(status, body, headers) {
  const h = new Map(Object.entries(Object.assign({ 'x-ratelimit-remaining': '999', 'x-ratelimit-limit': '1000' }, headers || {})).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  return {
    status, ok: status >= 200 && status < 300, statusText: '',
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null), forEach: (fn) => h.forEach((v, k) => fn(v, k)) },
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
}

module.exports = { createFakeGitHub, createStore, response, blobSha, gitObjectSha, EMPTY_TREE_SHA };
