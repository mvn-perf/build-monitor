/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const { sleep, debug, warning } = require('./util');

const API_VERSION = '2022-11-28';

class HttpError extends Error {
  constructor(status, message, body, headers) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/**
 * Tiny GitHub REST client on top of the global fetch (Node 18+): auth, JSON,
 * Link-header pagination, rate-limit waits, transient-error retries and the
 * two-hop artifact download (API -> 302 -> blob storage, no auth on hop two).
 */
class GitHubApi {
  constructor(opts) {
    const o = opts || {};
    this.token = o.token || '';
    this.apiUrl = (o.apiUrl || process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    this.userAgent = o.userAgent || 'mvn-perf/build-monitor';
    this.fetch = o.fetch || globalThis.fetch;
    this.maxAttempts = o.maxAttempts || 4;
    /** Rate-limit waits allowed per request, on top of maxAttempts (they are not failures). */
    this.maxRateLimitWaits = o.maxRateLimitWaits === undefined ? 2 : o.maxRateLimitWaits;
    this.maxRateLimitWaitMs = o.maxRateLimitWaitMs || 65 * 60 * 1000;
    this.requests = 0;
    this.rateLimitRemaining = null;
    if (typeof this.fetch !== 'function') throw new Error('global fetch is not available (Node 18+ required)');
  }

  headers(extra) {
    const h = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': this.userAgent,
    };
    if (this.token) h['Authorization'] = 'Bearer ' + this.token;
    return Object.assign(h, extra || {});
  }

  url(pathOrUrl, query) {
    let u = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : this.apiUrl + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
    if (query) {
      const params = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (params.length) {
        u += (u.includes('?') ? '&' : '?') + params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
      }
    }
    return u;
  }

  /**
   * Performs one request with retries. Resolves to { status, headers, json | buffer }.
   * `raw: true` returns the body as a Buffer; `redirect: 'manual'` exposes 3xx.
   */
  async raw(pathOrUrl, opts) {
    const o = opts || {};
    const url = this.url(pathOrUrl, o.query);
    let attempt = 0;
    let rateLimitWaits = 0;
    let lastErr;
    while (attempt < this.maxAttempts) {
      attempt++;
      let res;
      try {
        this.requests++;
        res = await this.fetch(url, {
          method: o.method || 'GET',
          headers: o.noAuth ? Object.assign({ 'User-Agent': this.userAgent }, o.headers || {}) : this.headers(o.headers),
          redirect: o.redirect || 'follow',
          body: o.body,
          signal: AbortSignal.timeout(o.timeoutMs || 60000),
        });
      } catch (e) {
        lastErr = e;
        debug(`fetch ${url} failed (attempt ${attempt}): ${e.message}`);
        await sleep(backoff(attempt));
        continue;
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining !== null && !o.noAuth) this.rateLimitRemaining = parseInt(remaining, 10);

      if (res.status >= 200 && res.status < 400) {
        if (o.raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
        if (res.status === 204 || res.status === 304 || (res.status >= 300)) return { status: res.status, headers: res.headers, json: null };
        const text = await res.text();
        return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
      }

      const text = await res.text().catch(() => '');
      const retryAfter = res.headers.get('retry-after');
      const isRateLimited = (res.status === 403 || res.status === 429) && (remaining === '0' || /rate limit/i.test(text) || retryAfter);
      if (isRateLimited && rateLimitWaits < this.maxRateLimitWaits) {
        // A rate-limit wait is not a failed attempt: wait until the window resets
        // (bounded), then retry the same attempt.
        rateLimitWaits++;
        attempt--;
        let waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 0;
        const reset = res.headers.get('x-ratelimit-reset');
        if (!waitMs && reset) waitMs = Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) + 1000;
        if (!waitMs) waitMs = backoff(attempt + 1) * 10;
        waitMs = Math.min(waitMs, this.maxRateLimitWaitMs);
        warning(`GitHub API rate limited on ${redact(url)}; waiting ${Math.round(waitMs / 1000)} s for the window to reset`);
        await sleep(waitMs);
        continue;
      }
      if ((res.status >= 500 || res.status === 408) && attempt < this.maxAttempts) {
        debug(`HTTP ${res.status} on ${url}; retrying`);
        await sleep(backoff(attempt));
        continue;
      }
      throw new HttpError(res.status, `HTTP ${res.status} ${o.method || 'GET'} ${redact(url)}: ${text.slice(0, 300)}`, text, res.headers);
    }
    throw lastErr || new Error('request failed: ' + redact(url));
  }

  /** JSON request with a JSON body (POST/PATCH/PUT/DELETE). */
  async send(method, pathOrUrl, body, opts) {
    const o = Object.assign({ method, timeoutMs: 60000 }, opts || {});
    if (body !== undefined) {
      o.body = JSON.stringify(body);
      o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    }
    const r = await this.raw(pathOrUrl, o);
    return r.json;
  }

  async get(pathOrUrl, query, opts) {
    const r = await this.raw(pathOrUrl, Object.assign({ query }, opts || {}));
    return r.json;
  }

  /** Follows `Link: rel="next"` and concatenates `key` arrays (or whole pages when key is absent). */
  async paginate(pathOrUrl, query, key, opts) {
    const o = opts || {};
    const all = [];
    let url = this.url(pathOrUrl, Object.assign({ per_page: 100 }, query || {}));
    let pages = 0;
    while (url) {
      const r = await this.raw(url, { timeoutMs: o.timeoutMs });
      const page = key ? (r.json && r.json[key]) || [] : r.json || [];
      all.push(...page);
      pages++;
      if (o.max && all.length >= o.max) break;
      if (o.stop && o.stop(page, all)) break;
      url = nextLink(r.headers.get('link'));
      if (o.maxPages && pages >= o.maxPages) break;
    }
    return o.max ? all.slice(0, o.max) : all;
  }

  /**
   * Downloads an artifact zip. The API answers 302 to a short-lived blob URL that
   * must be fetched WITHOUT the Authorization header (the blob host rejects it).
   */
  async downloadArtifact(repo, artifactId, opts) {
    const path = `/repos/${repo}/actions/artifacts/${artifactId}/zip`;
    const first = await this.raw(path, { redirect: 'manual', raw: true, timeoutMs: (opts && opts.timeoutMs) || 120000 });
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      if (!location) throw new Error('artifact redirect without Location header');
      const second = await this.raw(location, { noAuth: true, raw: true, timeoutMs: (opts && opts.timeoutMs) || 300000 });
      return second.buffer;
    }
    return first.buffer;
  }
}

/**
 * What a failed request means, so callers can tell a missing permission from a
 * rate limit or a compare-and-swap conflict:
 *   'rate-limit'  primary/secondary limit (retry-after, remaining 0, "rate limit" text)
 *   'permission'  the token cannot do this ("Resource not accessible by integration"...)
 *   'not-found'   404
 *   'conflict'    a non-fast-forward ref update / existing ref (Git Data API CAS)
 *   'other'
 */
function classifyError(err) {
  if (!err || typeof err.status !== 'number') return 'other';
  const body = String(err.body || err.message || '');
  const headers = err.headers;
  const retryAfter = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const remaining = headers && typeof headers.get === 'function' ? headers.get('x-ratelimit-remaining') : null;
  if ((err.status === 403 || err.status === 429) && (retryAfter || remaining === '0' || /rate limit/i.test(body))) return 'rate-limit';
  if (err.status === 403 || err.status === 401) return 'permission';
  if (err.status === 404) return 'not-found';
  if ((err.status === 422 || err.status === 409) && /not a fast forward|not a fast-forward|Reference already exists|is at .* but expected|Reference cannot be updated/i.test(body)) return 'conflict';
  if (err.status === 422 && /Resource not accessible|protected branch|rule violations|Required status check|Changes must be made through/i.test(body)) return 'permission';
  return 'other';
}

/** The API's own message from an error body, when it is JSON. */
function apiMessage(err) {
  try { const j = JSON.parse(err.body); if (j && j.message) return String(j.message); } catch (e) { /* not JSON */ }
  return err && err.message ? String(err.message) : String(err);
}

function backoff(attempt) { return Math.min(30000, 500 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250); }

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

function redact(url) { return url.replace(/([?&](sig|token|sv|se)=)[^&]+/g, '$1…'); }

module.exports = { GitHubApi, HttpError, nextLink, classifyError, apiMessage };
