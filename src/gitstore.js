/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const crypto = require('crypto');
const util = require('./util');
const { debug, warning } = util;
const { classifyError, apiMessage } = require('./github-api');

/** Commit identity used when the caller supplies none (the Actions bot). */
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_SEGMENT = 200;
const MAX_PATH = 4096;

/**
 * A failed store operation, classified so callers can react without parsing
 * messages: kind 'permission' | 'rate-limit' | 'conflict' | 'not-found' | 'other'.
 */
class GitStoreError extends Error {
  constructor(kind, message, opts) {
    super(message, opts && opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'GitStoreError';
    this.kind = kind;
    if (opts && opts.status !== undefined) this.status = opts.status;
  }
}

/**
 * Validates a POSIX repository path: relative, no '\', no '.'/'..'/empty
 * segment, segments ≤ 200 chars, total ≤ 4096. Returns the path.
 */
function validatePath(p) {
  if (typeof p !== 'string' || p === '') throw new GitStoreError('other', `invalid path: ${JSON.stringify(p)} (empty)`);
  if (p.length > MAX_PATH) throw new GitStoreError('other', `invalid path: longer than ${MAX_PATH} characters`);
  if (p.includes('\\')) throw new GitStoreError('other', `invalid path ${JSON.stringify(p)}: backslash (use POSIX separators)`);
  if (p.startsWith('/')) throw new GitStoreError('other', `invalid path ${JSON.stringify(p)}: must be relative (no leading '/')`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new GitStoreError('other', `invalid path ${JSON.stringify(p)}: control character`);
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new GitStoreError('other', `invalid path ${JSON.stringify(p)}: '${seg}' segment`);
    if (seg.length > MAX_SEGMENT) throw new GitStoreError('other', `invalid path ${JSON.stringify(p)}: segment longer than ${MAX_SEGMENT} characters`);
  }
  return p;
}

/** True when the error is a compare-and-swap loss on a ref (retry material). */
function isCasConflict(err) { return classifyError(err) === 'conflict'; }

/** 'refs/heads/x' / 'heads/x' / 'x' → 'heads/x', validated against git ref rules. */
function normalizeRef(ref) {
  let r = String(ref == null ? '' : ref).trim();
  if (r.startsWith('refs/')) r = r.slice('refs/'.length);
  if (!/^(heads|tags)\//.test(r)) r = 'heads/' + r;
  const name = r.replace(/^(heads|tags)\//, '');
  if (name === '' || /[\s~^:?*[\\\u0000-\u001f\u007f]|\.\.|@{/.test(name) || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.split('/').some(s => s === '' || s.startsWith('.'))) {
    throw new GitStoreError('other', `invalid ref name: ${JSON.stringify(String(ref))}`);
  }
  return r;
}

function encodeRef(ref) { return ref.split('/').map(encodeURIComponent).join('/'); }

function normalizePerson(p, fallbackName, fallbackEmail) {
  if (!p) return { name: fallbackName, email: fallbackEmail };
  const out = { name: String(p.name || fallbackName), email: String(p.email || fallbackEmail) };
  if (p.date) out.date = String(p.date);
  return out;
}

/**
 * Content-addressed store on GitHub's Git Data API: read refs/trees/blobs,
 * and publish files to a branch with optimistic concurrency (CAS on the ref,
 * bounded retries). One instance per repo; tree reads are cached (tree shas
 * are immutable, so the cache never goes stale).
 */
class GitStore {
  constructor(opts) {
    const o = opts || {};
    if (!o.api) throw new Error('GitStore: api (GitHubApi) is required');
    if (!o.repo || !/^[^/\s]+\/[^/\s]+$/.test(o.repo)) throw new Error(`GitStore: repo must be 'owner/name', got ${JSON.stringify(o.repo)}`);
    this.api = o.api;
    this.repo = o.repo;
    this._trees = new Map(); // treeSha → entries (immutable)
  }

  _path(p) { return `/repos/${this.repo}/${p}`; }

  _wrap(e, context) {
    if (e instanceof GitStoreError) return e;
    if (e && typeof e.status === 'number') return new GitStoreError(classifyError(e), `${context}: ${apiMessage(e)} (HTTP ${e.status})`, { status: e.status, cause: e });
    return new GitStoreError('other', `${context}: ${e && e.message ? e.message : String(e)}`, { cause: e });
  }

  _emptyRepo(e) {
    return e && e.status === 409 && /empty/i.test(String(e.body || e.message || ''));
  }

  /** 'heads/gh-pages' → { sha, treeSha, parents } | null (404). 409 empty repo → clear GitStoreError. */
  async readRef(ref) {
    const r = normalizeRef(ref);
    let res;
    try {
      res = await this.api.get(this._path(`git/ref/${encodeRef(r)}`));
    } catch (e) {
      if (e && e.status === 404) return null;
      if (this._emptyRepo(e)) throw new GitStoreError('other', `repository ${this.repo} has no commits yet (empty Git repository); push an initial commit before using build-monitor`, { status: 409, cause: e });
      throw this._wrap(e, `read ref ${r} of ${this.repo}`);
    }
    const obj = res && res.object;
    if (!obj || !SHA_RE.test(String(obj.sha || ''))) throw new GitStoreError('other', `read ref ${r} of ${this.repo}: malformed API response`);
    if (obj.type !== 'commit') throw new GitStoreError('other', `ref ${r} of ${this.repo} points at a ${obj.type}, not a commit`);
    let commit;
    try {
      commit = await this.api.get(this._path(`git/commits/${obj.sha}`));
    } catch (e) {
      throw this._wrap(e, `read commit ${obj.sha} of ${this.repo}`);
    }
    if (!commit || !commit.tree || !SHA_RE.test(String(commit.tree.sha || ''))) throw new GitStoreError('other', `read commit ${obj.sha} of ${this.repo}: malformed API response`);
    return { sha: obj.sha, treeSha: commit.tree.sha, parents: (commit.parents || []).map(p => p.sha) };
  }

  /** One tree level → [{ path, mode, type, sha, size }] (cached per instance). */
  async readTree(treeSha) {
    if (!SHA_RE.test(String(treeSha || ''))) throw new GitStoreError('other', `readTree: invalid tree sha ${JSON.stringify(treeSha)}`);
    const key = String(treeSha).toLowerCase();
    if (this._trees.has(key)) return this._trees.get(key);
    let res;
    try {
      res = await this.api.get(this._path(`git/trees/${key}`));
    } catch (e) {
      throw this._wrap(e, `read tree ${key} of ${this.repo}`);
    }
    if (!res || !Array.isArray(res.tree)) throw new GitStoreError('other', `read tree ${key} of ${this.repo}: malformed API response`);
    if (res.truncated) warning(`tree ${key} of ${this.repo} was truncated by the API; some entries are missing`);
    const entries = res.tree.map(e => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, size: e.size }));
    this._trees.set(key, entries);
    return entries;
  }

  /**
   * Walks 'a/b/c' one tree level per segment → the entry or null. Only regular
   * blobs (100644/100755) and trees are returned; symlinks/submodules are not.
   */
  async findEntry(treeSha, path) {
    validatePath(path);
    const segs = path.split('/');
    let current = treeSha;
    for (let i = 0; i < segs.length; i++) {
      const entries = await this.readTree(current);
      const e = entries.find(x => x.path === segs[i]);
      if (!e) return null;
      if (i === segs.length - 1) {
        if (e.type === 'tree') return e;
        if (e.type === 'blob' && (e.mode === '100644' || e.mode === '100755')) return e;
        return null;
      }
      if (e.type !== 'tree') return null;
      current = e.sha;
    }
    return null;
  }

  /** Entries of the sub-tree at `path` ('' → the root tree), or [] when absent. */
  async listDir(treeSha, path) {
    if (path === undefined || path === null || path === '') return this.readTree(treeSha);
    const e = await this.findEntry(treeSha, path);
    if (!e || e.type !== 'tree') return [];
    return this.readTree(e.sha);
  }

  /**
   * Blob bytes via the raw media type (base64 JSON as fallback). Throws
   * GitStoreError('other') when `size` (checked first) or the body exceeds
   * `maxBytes`.
   */
  async readBlob(sha, opts) {
    const o = opts || {};
    if (!SHA_RE.test(String(sha || ''))) throw new GitStoreError('other', `readBlob: invalid blob sha ${JSON.stringify(sha)}`);
    const max = o.maxBytes;
    if (max !== undefined && o.size !== undefined && o.size !== null && Number(o.size) > max) {
      throw new GitStoreError('other', `blob ${sha} is ${o.size} bytes, over the ${max}-byte limit`);
    }
    let res;
    try {
      res = await this.api.raw(this._path(`git/blobs/${String(sha).toLowerCase()}`), { raw: true, headers: { 'Accept': 'application/vnd.github.raw+json' }, timeoutMs: 120000 });
    } catch (e) {
      throw this._wrap(e, `read blob ${sha} of ${this.repo}`);
    }
    let buf = res.buffer;
    const contentType = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
    if (/^application\/json/i.test(contentType)) {
      // The raw media type was not honoured: unwrap the base64 JSON envelope.
      try {
        const body = JSON.parse(buf.toString('utf8'));
        if (body && body.encoding === 'base64' && typeof body.content === 'string') buf = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
      } catch (e) { /* not the JSON envelope after all: keep the raw bytes */ }
    }
    if (max !== undefined && buf.length > max) throw new GitStoreError('other', `blob ${sha} is ${buf.length} bytes, over the ${max}-byte limit`);
    return buf;
  }

  /** All refs under a prefix ('heads/build-monitor-inbox/') → [{ ref: 'refs/heads/…', sha }]. */
  async listRefs(prefix) {
    const p = String(prefix || '').replace(/^refs\//, '');
    if (!p) throw new GitStoreError('other', 'listRefs: prefix is required');
    let rows;
    try {
      rows = await this.api.paginate(this._path(`git/matching-refs/${encodeRef(p)}`));
    } catch (e) {
      if (this._emptyRepo(e)) throw new GitStoreError('other', `repository ${this.repo} has no commits yet (empty Git repository)`, { status: 409, cause: e });
      throw this._wrap(e, `list refs ${p} of ${this.repo}`);
    }
    const full = 'refs/' + p;
    return (rows || [])
      .filter(r => r && typeof r.ref === 'string' && r.ref.startsWith(full) && r.object && SHA_RE.test(String(r.object.sha || '')))
      .map(r => ({ ref: r.ref, sha: r.object.sha }));
  }

  /** Deletes a ref → true; already gone (404 / "Reference does not exist") → false. */
  async deleteRef(ref) {
    const r = normalizeRef(ref);
    try {
      await this.api.send('DELETE', this._path(`git/refs/${encodeRef(r)}`));
      return true;
    } catch (e) {
      if (e && (e.status === 404 || (e.status === 422 && /Reference does not exist/i.test(String(e.body || e.message || ''))))) return false;
      throw this._wrap(e, `delete ref ${r} of ${this.repo}`);
    }
  }

  /** Uploads a blob (base64) → its sha (verified against the local hash). */
  async createBlob(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
    let res;
    try {
      res = await this.api.send('POST', this._path('git/blobs'), { content: buf.toString('base64'), encoding: 'base64' }, { timeoutMs: 120000 });
    } catch (e) {
      throw this._wrap(e, `create blob in ${this.repo}`);
    }
    if (!res || !SHA_RE.test(String(res.sha || ''))) throw new GitStoreError('other', `create blob in ${this.repo}: malformed API response`);
    const local = GitStore.blobSha(buf);
    if (res.sha.toLowerCase() !== local) warning(`blob sha mismatch in ${this.repo}: API ${res.sha}, local ${local} (upload-skip optimisation disabled for this blob)`);
    return res.sha;
  }

  /** git's blob hash: sha1('blob <len>\0' + bytes) — equals GitHub's sha for the same bytes. */
  static blobSha(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
    return crypto.createHash('sha1').update(`blob ${buf.length}\0`, 'latin1').update(buf).digest('hex');
  }

  /**
   * Publishes files to a branch in one commit, with CAS retries.
   *
   *   commitFiles({ ref, files, message, author?, budgetMs = 180000,
   *                 sleep = util.sleep, onConflict?, orphan = false })
   *
   * files: { path, content: Buffer|string [, mode] } uploads a blob;
   *        { path, type: 'tree'|'blob', sha } grafts an existing object.
   * Returns { sha, changed, created, attempts, uploaded, skipped }; throws
   * GitStoreError('conflict') when the budget runs out losing CAS races.
   */
  async commitFiles(p) {
    const o = p || {};
    const ref = normalizeRef(o.ref);
    if (!ref.startsWith('heads/')) throw new GitStoreError('other', `commitFiles: only branch refs are supported, got ${ref}`);
    const message = o.message || 'Update build monitor';
    const person = normalizePerson(o.author, BOT_NAME, BOT_EMAIL);
    const budgetMs = o.budgetMs === undefined ? 180000 : Number(o.budgetMs);
    const sleep = o.sleep || util.sleep;
    const orphan = !!o.orphan;
    const deadline = Date.now() + Math.max(0, budgetMs);
    let files = prepareFiles(o.files);

    const uploaded = [];
    const skipped = [];
    const knownShas = new Set(); // blob shas confirmed to exist on the server (uploaded or seen in a head tree)
    let attempts = 0;
    let rateLimitWaits = 0;
    let head = null;
    let headFresh = false;

    for (;;) {
      try {
        if (!headFresh) { head = await this.readRef(ref); headFresh = true; }
        await this._uploadMissing(files, head, knownShas, uploaded, skipped);
        // Idempotence: every entry already at the wanted sha ⇒ nothing to do.
        // (For orphan the point is squashing history, so only a root commit counts as done.)
        if (head && (!orphan || head.parents.length === 0) && await this._allMatch(files, head.treeSha)) {
          debug(`commitFiles ${ref}: unchanged at ${head.sha}`);
          return { sha: head.sha, changed: false, created: false, attempts, uploaded, skipped };
        }
        const treeEntries = files.map(f => ({ path: f.path, mode: f.mode, type: f.type, sha: f.sha }));
        let sha;
        let created = false;
        if (!head || orphan) {
          const tree = await this.api.send('POST', this._path('git/trees'), { tree: treeEntries });
          const commit = await this.api.send('POST', this._path('git/commits'), { message, tree: tree.sha, parents: [], author: person, committer: person });
          if (head) {
            await this.api.send('PATCH', this._path(`git/refs/${encodeRef(ref)}`), { sha: commit.sha, force: true });
          } else {
            await this.api.send('POST', this._path('git/refs'), { ref: 'refs/' + ref, sha: commit.sha });
            created = true;
          }
          sha = commit.sha;
        } else {
          const tree = await this.api.send('POST', this._path('git/trees'), { base_tree: head.treeSha, tree: treeEntries });
          const commit = await this.api.send('POST', this._path('git/commits'), { message, tree: tree.sha, parents: [head.sha], author: person, committer: person });
          await this.api.send('PATCH', this._path(`git/refs/${encodeRef(ref)}`), { sha: commit.sha, force: false });
          sha = commit.sha;
        }
        debug(`commitFiles ${ref}: ${created ? 'created' : 'updated'} → ${sha} (${attempts} retry attempt(s))`);
        return { sha, changed: true, created, attempts, uploaded, skipped };
      } catch (e) {
        const kind = e instanceof GitStoreError ? e.kind : classifyError(e);
        headFresh = false;

        if (kind === 'rate-limit') {
          // GitHubApi normally absorbs these; one escaping here gets a single
          // bounded wait (retry-after, ≤ 60 s) that does NOT count as an attempt.
          rateLimitWaits++;
          const waitMs = Math.min(retryAfterMs(e), 60000);
          if (rateLimitWaits > 10 || Date.now() + waitMs > deadline) {
            throw this._wrap(e, `commit to ${ref} of ${this.repo} rate limited beyond the ${budgetMs} ms budget`);
          }
          debug(`commitFiles ${ref}: rate limited, waiting ${waitMs} ms`);
          await sleep(waitMs);
          continue;
        }
        if (kind !== 'conflict') throw this._wrap(e, `commit to ${ref} of ${this.repo} failed`);

        attempts++;
        if (Date.now() >= deadline) {
          throw new GitStoreError('conflict', `could not update ${ref} of ${this.repo}: lost the compare-and-swap race ${attempts} time(s) within the ${budgetMs} ms budget (${apiMessage(e)})`, { status: e && e.status, cause: e });
        }
        // Full jitter: random(200 ms … min(10 s, 500 ms × 2^attempts)).
        const cap = Math.min(10000, 500 * Math.pow(2, attempts));
        const waitMs = 200 + Math.floor(Math.random() * Math.max(1, cap - 200));
        debug(`commitFiles ${ref}: ref moved (${apiMessage(e)}); retry ${attempts} in ${waitMs} ms`);
        await sleep(waitMs);
        head = await this.readRef(ref);
        headFresh = true;
        if (o.onConflict) {
          const replacement = await o.onConflict(head);
          if (Array.isArray(replacement)) files = prepareFiles(replacement);
        }
      }
    }
  }

  /** Uploads content blobs not yet known to the server; fills uploaded/skipped path lists. */
  async _uploadMissing(files, head, knownShas, uploaded, skipped) {
    for (const f of files) {
      if (!f.content || knownShas.has(f.sha)) continue;
      if (head) {
        const entry = await this.findEntry(head.treeSha, f.path);
        if (entry && entry.type === 'blob' && entry.sha === f.sha) {
          knownShas.add(f.sha);
          if (!skipped.includes(f.path)) skipped.push(f.path);
          continue;
        }
      }
      const sha = await this.createBlob(f.content);
      if (sha.toLowerCase() === f.sha) knownShas.add(f.sha);
      uploaded.push(f.path);
    }
  }

  /** True when every entry already exists in the tree with the same sha (and kind/mode). */
  async _allMatch(files, treeSha) {
    for (const f of files) {
      const entry = await this.findEntry(treeSha, f.path);
      if (!entry || entry.sha !== f.sha) return false;
      if (f.type === 'tree' ? entry.type !== 'tree' : (entry.type !== 'blob' || entry.mode !== f.mode)) return false;
    }
    return true;
  }
}

/** Normalizes and validates commitFiles entries; rejects duplicates and nested overlaps. */
function prepareFiles(list) {
  if (!Array.isArray(list) || list.length === 0) throw new GitStoreError('other', 'commitFiles: files must be a non-empty array');
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') throw new GitStoreError('other', 'commitFiles: invalid file entry');
    validatePath(f.path);
    if (f.content !== undefined && f.content !== null) {
      if (f.type !== undefined && f.type !== 'blob') throw new GitStoreError('other', `commitFiles: entry ${f.path} mixes content with type '${f.type}'`);
      if (!Buffer.isBuffer(f.content) && typeof f.content !== 'string') throw new GitStoreError('other', `commitFiles: content of ${f.path} must be a Buffer or string`);
      const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
      const mode = f.mode === '100755' ? '100755' : '100644';
      out.push({ path: f.path, type: 'blob', mode, content: buf, sha: GitStore.blobSha(buf) });
    } else if (f.type === 'tree' || f.type === 'blob') {
      if (!SHA_RE.test(String(f.sha || ''))) throw new GitStoreError('other', `commitFiles: graft ${f.path} needs a 40-hex sha`);
      const mode = f.type === 'tree' ? '040000' : (f.mode === '100755' ? '100755' : '100644');
      out.push({ path: f.path, type: f.type, mode, sha: String(f.sha).toLowerCase() });
    } else {
      throw new GitStoreError('other', `commitFiles: entry ${f.path} needs either content or { type, sha }`);
    }
  }
  const paths = new Set();
  for (const f of out) {
    if (paths.has(f.path)) throw new GitStoreError('other', `commitFiles: duplicate path ${f.path}`);
    paths.add(f.path);
  }
  for (const f of out) {
    const segs = f.path.split('/');
    let prefix = '';
    for (let i = 0; i < segs.length - 1; i++) {
      prefix = prefix ? prefix + '/' + segs[i] : segs[i];
      if (paths.has(prefix)) throw new GitStoreError('other', `commitFiles: ${f.path} is nested under entry ${prefix} in the same call`);
    }
  }
  return out;
}

function retryAfterMs(e) {
  const headers = e && e.headers;
  const ra = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const s = ra ? parseInt(ra, 10) : NaN;
  return Number.isFinite(s) && s > 0 ? s * 1000 : 1000;
}

module.exports = { GitStore, GitStoreError, validatePath, isCasConflict, BOT_NAME, BOT_EMAIL };
