/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubApi, HttpError, nextLink, classifyError, apiMessage } = require('../src/github-api');

// Deliberately independent of test/fake-github.js: a tiny fetch stub is enough here.

function headersOf(map) {
  const m = new Map(Object.entries(map || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (k) => (m.has(k.toLowerCase()) ? m.get(k.toLowerCase()) : null) };
}
function httpErr(status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new HttpError(status, `HTTP ${status} GET https://api.github.com/x: ${text.slice(0, 100)}`, text, headersOf(headers));
}
function stubResponse(status, body, headers) {
  const buf = Buffer.from(body || '', 'utf8');
  const h = headersOf(Object.assign({ 'x-ratelimit-remaining': '999' }, headers || {}));
  return {
    status, ok: status >= 200 && status < 300, headers: h,
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

test('classifyError: rate limits (retry-after, remaining 0, message text)', () => {
  assert.equal(classifyError(httpErr(403, { message: 'whatever' }, { 'retry-after': '60' })), 'rate-limit');
  assert.equal(classifyError(httpErr(403, { message: 'whatever' }, { 'x-ratelimit-remaining': '0' })), 'rate-limit');
  assert.equal(classifyError(httpErr(403, { message: 'API rate limit exceeded for installation ID 1.' }, { 'x-ratelimit-remaining': '999' })), 'rate-limit');
  assert.equal(classifyError(httpErr(429, { message: 'You have exceeded a secondary rate limit.' })), 'rate-limit');
});

test('classifyError: permissions (403/401 without rate-limit markers, 422 rule violations)', () => {
  assert.equal(classifyError(httpErr(403, { message: 'Resource not accessible by integration' }, { 'x-ratelimit-remaining': '999' })), 'permission');
  assert.equal(classifyError(httpErr(403, { message: 'Must have admin rights to Repository.' }, { 'x-ratelimit-remaining': '999' })), 'permission');
  assert.equal(classifyError(httpErr(401, { message: 'Bad credentials' })), 'permission');
  assert.equal(classifyError(httpErr(422, { message: 'Repository rule violations found for refs/heads/gh-pages' })), 'permission');
  assert.equal(classifyError(httpErr(422, { message: 'refs/heads/main is a protected branch' })), 'permission');
  assert.equal(classifyError(httpErr(422, { message: 'Required status check "ci" is expected.' })), 'permission');
});

test('classifyError: CAS conflicts on the Git Data API', () => {
  assert.equal(classifyError(httpErr(422, { message: 'Update is not a fast forward' })), 'conflict');
  assert.equal(classifyError(httpErr(422, { message: 'Reference already exists' })), 'conflict');
  assert.equal(classifyError(httpErr(409, { message: 'refs/heads/gh-pages is at 0123abc but expected 4567def' })), 'conflict');
  assert.equal(classifyError(httpErr(422, { message: 'Reference cannot be updated' })), 'conflict');
  assert.equal(classifyError(httpErr(409, { message: 'Merge conflict' })), 'other', 'a plain 409 is not a CAS conflict');
});

test('classifyError: not-found and other', () => {
  assert.equal(classifyError(httpErr(404, { message: 'Not Found' })), 'not-found');
  assert.equal(classifyError(httpErr(500, 'Internal Server Error')), 'other');
  assert.equal(classifyError(httpErr(422, { message: 'Validation Failed' })), 'other');
  assert.equal(classifyError(new Error('ECONNRESET')), 'other');
  assert.equal(classifyError(null), 'other');
  assert.equal(classifyError(undefined), 'other');
});

// ---------------------------------------------------------------------------
// apiMessage
// ---------------------------------------------------------------------------

test('apiMessage prefers the JSON message and falls back to the error message', () => {
  assert.equal(apiMessage(httpErr(403, { message: 'Resource not accessible by integration', documentation_url: 'x' })), 'Resource not accessible by integration');
  const plain = httpErr(500, 'not json at all');
  assert.equal(apiMessage(plain), plain.message);
  assert.equal(apiMessage(new Error('boom')), 'boom');
});

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

test('send() serialises the JSON body, sets content-type and auth, and parses the reply', async () => {
  const seen = [];
  const fetchStub = async (url, init) => { seen.push({ url: String(url), init }); return stubResponse(201, '{"sha":"abc"}'); };
  const api = new GitHubApi({ token: 'tok-123', fetch: fetchStub, apiUrl: 'https://api.example.test' });

  const out = await api.send('POST', '/repos/a/b/git/blobs', { content: 'aGk=', encoding: 'base64' });
  assert.deepEqual(out, { sha: 'abc' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.example.test/repos/a/b/git/blobs');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].init.body), { content: 'aGk=', encoding: 'base64' });
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
  assert.equal(seen[0].init.headers['Authorization'], 'Bearer tok-123');
  assert.match(seen[0].init.headers['Accept'], /vnd\.github/);
  assert.ok(seen[0].init.headers['User-Agent']);
});

test('send() without a body sends none and handles 204', async () => {
  const seen = [];
  const fetchStub = async (url, init) => { seen.push(init); return stubResponse(204, ''); };
  const api = new GitHubApi({ token: 't', fetch: fetchStub });
  const out = await api.send('DELETE', '/repos/a/b/git/refs/heads/x');
  assert.equal(out, null);
  assert.equal(seen[0].method, 'DELETE');
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[0].headers['Content-Type'], undefined);
});

test('send() surfaces API errors as HttpError with status, body and headers', async () => {
  const api = new GitHubApi({ token: 't', fetch: async () => stubResponse(422, '{"message":"Reference already exists"}') });
  await assert.rejects(api.send('POST', '/repos/a/b/git/refs', { ref: 'refs/heads/x', sha: 'y' }), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 422);
    assert.match(String(e.body), /Reference already exists/);
    assert.equal(classifyError(e), 'conflict');
    return true;
  });
});

// ---------------------------------------------------------------------------
// nextLink
// ---------------------------------------------------------------------------

test('nextLink parses the rel="next" target', () => {
  assert.equal(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'), 'https://api.github.com/x?page=2');
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});
