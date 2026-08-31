/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubApi, HttpError } = require('../src/github-api');
const { GitStore, GitStoreError, validatePath, isCasConflict, BOT_NAME, BOT_EMAIL } = require('../src/gitstore');
const { createFakeGitHub, EMPTY_TREE_SHA } = require('./fake-github');

const REPO = 'acme/widgets';
const fastSleep = () => new Promise(r => setImmediate(r));

function setup(scenario) {
  const fake = createFakeGitHub(Object.assign({ repository: REPO }, scenario || {}));
  const api = new GitHubApi({ token: 'x', fetch: fake.fetch, maxRateLimitWaits: 0 });
  const store = new GitStore({ api, repo: REPO });
  return { fake, api, store };
}
function blobPosts(fake, from) {
  return fake.calls.slice(from || 0).filter(c => c.method === 'POST' && c.path.endsWith('/git/blobs'));
}

// ---------------------------------------------------------------------------
// Hashing: local shas must equal the API's (and real git's)
// ---------------------------------------------------------------------------

test('blobSha equals the API sha for ASCII, non-ASCII and binary content', async () => {
  const { store } = setup();
  // Known git values: `printf 'hello\n' | git hash-object --stdin`, same for the utf-8 string.
  assert.equal(GitStore.blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(GitStore.blobSha(Buffer.from('héllo wörld ✓', 'utf8')), '145e092020d377158210cd10f27ee304abc5b430');
  for (const content of [Buffer.from('hello\n'), Buffer.from('héllo wörld ✓', 'utf8'), Buffer.from([0, 1, 2, 254, 255]), Buffer.alloc(0)]) {
    assert.equal(GitStore.blobSha(content), await store.createBlob(content));
  }
  assert.equal(GitStore.blobSha('str'), GitStore.blobSha(Buffer.from('str', 'utf8')));
});

test('the fake store hashes trees exactly like git (sort order, nesting, empty tree)', () => {
  const { fake } = setup();
  const one = fake.store.seedBranch('one', { 'hello.txt': 'hello\n' });
  assert.equal(fake.store.commit(one).tree, 'aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7'); // git mktree
  // 'sub.txt' sorts before the directory 'sub/' — git's tree order.
  const two = fake.store.seedBranch('two', { 'sub.txt': 'hello\n', 'sub/hello.txt': 'hello\n' });
  assert.equal(fake.store.commit(two).tree, 'cdd7314d1f3ecd9a85b6cfa53be42887127e0fe7'); // git mktree
  assert.equal(EMPTY_TREE_SHA, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

// ---------------------------------------------------------------------------
// commitFiles
// ---------------------------------------------------------------------------

test('commitFiles creates the branch when absent (root commit, bot identity)', async () => {
  const { fake, store } = setup();
  const res = await store.commitFiles({
    ref: 'heads/gh-pages',
    files: [
      { path: 'index.html', content: '<html>site</html>' },
      { path: '.nojekyll', content: '' },
      { path: 'data/history.json', content: '{"runs":[]}' },
    ],
    message: 'initial site',
    sleep: fastSleep,
  });
  assert.equal(res.created, true);
  assert.equal(res.changed, true);
  assert.equal(res.attempts, 0);
  assert.deepEqual(res.uploaded.sort(), ['.nojekyll', 'data/history.json', 'index.html']);
  assert.deepEqual(res.skipped, []);
  assert.equal(fake.store.headOf('gh-pages'), res.sha);
  const commit = fake.store.commit(res.sha);
  assert.deepEqual(commit.parents, []);
  assert.equal(commit.message, 'initial site');
  assert.equal(commit.author.name, BOT_NAME);
  assert.equal(commit.author.email, BOT_EMAIL);
  assert.equal(commit.committer.name, BOT_NAME);
  assert.deepEqual(fake.store.listDir('gh-pages', ''), ['.nojekyll', 'data', 'index.html']);
  assert.equal(String(fake.store.readFile('gh-pages', 'data/history.json')), '{"runs":[]}');
});

test('commitFiles updates an existing branch, preserving siblings via base_tree (nested path)', async () => {
  const { fake, store } = setup();
  const seedSha = fake.store.seedBranch('gh-pages', { 'other/keep.txt': 'keep me', 'index.html': 'v1' });
  const res = await store.commitFiles({
    ref: 'gh-pages', // bare branch name is normalized to heads/gh-pages
    files: [
      { path: 'reports/123/j1-s3/report.html', content: '<html>report</html>' },
      { path: 'index.html', content: 'v2' },
    ],
    message: 'add report',
    author: { name: 'Custom', email: 'custom@example.test' },
    sleep: fastSleep,
  });
  assert.equal(res.created, false);
  assert.equal(res.changed, true);
  const commit = fake.store.commit(res.sha);
  assert.deepEqual(commit.parents, [seedSha]);
  assert.equal(commit.author.name, 'Custom');
  assert.equal(String(fake.store.readFile('gh-pages', 'other/keep.txt')), 'keep me');
  assert.equal(String(fake.store.readFile('gh-pages', 'index.html')), 'v2');
  assert.equal(String(fake.store.readFile('gh-pages', 'reports/123/j1-s3/report.html')), '<html>report</html>');
  assert.equal(fake.store.commitsOf('gh-pages').length, 2);
});

test('commitFiles is idempotent: a second identical call commits nothing', async () => {
  const { fake, store } = setup();
  const files = [
    { path: 'reports/123/j1-s3/report.html', content: '<html>report</html>' },
    { path: 'index.html', content: 'v1' },
  ];
  const first = await store.commitFiles({ ref: 'heads/gh-pages', files, sleep: fastSleep });
  const mark = fake.calls.length;
  const second = await store.commitFiles({ ref: 'heads/gh-pages', files, sleep: fastSleep });
  assert.equal(second.changed, false);
  assert.equal(second.created, false);
  assert.equal(second.sha, first.sha);
  assert.equal(second.attempts, 0);
  assert.deepEqual(second.uploaded, []);
  assert.deepEqual(second.skipped.sort(), ['index.html', 'reports/123/j1-s3/report.html']);
  assert.equal(fake.store.headOf('gh-pages'), first.sha);
  assert.equal(fake.calls.slice(mark).filter(c => c.method !== 'GET').length, 0, 'no mutating request on the no-op call');
});

test('commitFiles skips uploading a blob the head already has, but keeps it in the tree', async () => {
  const { fake, store } = setup();
  fake.store.seedBranch('gh-pages', { 'index.html': 'same content' });
  const mark = fake.calls.length;
  const res = await store.commitFiles({
    ref: 'heads/gh-pages',
    files: [{ path: 'index.html', content: 'same content' }, { path: 'new.txt', content: 'fresh' }],
    sleep: fastSleep,
  });
  assert.equal(res.changed, true);
  assert.deepEqual(res.skipped, ['index.html']);
  assert.deepEqual(res.uploaded, ['new.txt']);
  assert.equal(blobPosts(fake, mark).length, 1, 'only the new blob is uploaded');
  assert.equal(String(fake.store.readFile('gh-pages', 'index.html')), 'same content');
  assert.equal(String(fake.store.readFile('gh-pages', 'new.txt')), 'fresh');
});

test('commitFiles retries after a CAS conflict and keeps both writers’ files', async () => {
  const { fake, store } = setup();
  fake.store.seedBranch('gh-pages', { 'seed.txt': 'seed' });
  let raced = 0;
  fake.hook(({ method, path }) => {
    if (method === 'PATCH' && path.includes('/git/refs/') && raced === 0) {
      raced++;
      fake.store.seedBranch('gh-pages', { 'rival.txt': 'rival' });
    }
  });
  const res = await store.commitFiles({ ref: 'heads/gh-pages', files: [{ path: 'mine.txt', content: 'mine' }], sleep: fastSleep });
  assert.equal(raced, 1);
  assert.ok(res.attempts >= 1, `attempts ${res.attempts}`);
  assert.equal(res.changed, true);
  for (const [file, content] of [['seed.txt', 'seed'], ['rival.txt', 'rival'], ['mine.txt', 'mine']]) {
    assert.equal(String(fake.store.readFile('gh-pages', file)), content, file);
  }
  assert.equal(fake.store.headOf('gh-pages'), res.sha);
  assert.equal(fake.store.commitsOf('gh-pages').length, 3); // seed, rival, ours
});

test('commitFiles retries when the branch is created concurrently (Reference already exists)', async () => {
  const { fake, store } = setup();
  let raced = 0;
  fake.hook(({ method, path }) => {
    if (method === 'POST' && path.endsWith('/git/refs') && raced === 0) {
      raced++;
      fake.store.seedBranch('gh-pages', { 'rival.txt': 'rival' });
    }
  });
  const res = await store.commitFiles({ ref: 'heads/gh-pages', files: [{ path: 'mine.txt', content: 'mine' }], sleep: fastSleep });
  assert.equal(res.changed, true);
  assert.equal(res.created, false, 'the retry lands on the branch the rival created');
  assert.ok(res.attempts >= 1);
  assert.equal(String(fake.store.readFile('gh-pages', 'rival.txt')), 'rival');
  assert.equal(String(fake.store.readFile('gh-pages', 'mine.txt')), 'mine');
});

test('onConflict may replace the file list; replacement blobs are uploaded', async () => {
  const { fake, store } = setup();
  fake.store.seedBranch('gh-pages', { 'index.html': 'old' });
  let raced = 0;
  fake.hook(({ method, path }) => {
    if (method === 'PATCH' && path.includes('/git/refs/') && raced === 0) {
      raced++;
      fake.store.seedBranch('gh-pages', { 'rival.txt': 'rival' });
    }
  });
  const seen = [];
  const res = await store.commitFiles({
    ref: 'heads/gh-pages',
    files: [{ path: 'index.html', content: 'v1' }],
    sleep: fastSleep,
    onConflict: (head) => {
      seen.push(head);
      return [{ path: 'index.html', content: 'v2-remerged' }];
    },
  });
  assert.equal(res.changed, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sha, fake.store.commitsOf('gh-pages')[1], 'onConflict sees the rival head');
  assert.ok(Array.isArray(seen[0].parents) && seen[0].treeSha, 'head has treeSha and parents');
  assert.equal(String(fake.store.readFile('gh-pages', 'index.html')), 'v2-remerged');
  assert.equal(String(fake.store.readFile('gh-pages', 'rival.txt')), 'rival');
  assert.ok(fake.store.objects.has(GitStore.blobSha('v2-remerged')), 'replacement blob uploaded');
  assert.ok(res.uploaded.includes('index.html'));
});

test('a tree graft copies a subtree from another branch without re-uploading blobs', async () => {
  const { fake, store } = setup();
  const report = '<html>' + 'x'.repeat(5000) + '</html>';
  fake.store.seedBranch('build-monitor-inbox/123', {
    'reports/123/j55-s3/report.html': report,
    'reports/123/j55-s3/meta.json': '{"runId":123}',
  });
  fake.store.seedBranch('gh-pages', { 'index.html': 'site' });
  const inbox = await store.readRef('heads/build-monitor-inbox/123');
  const entry = await store.findEntry(inbox.treeSha, 'reports/123/j55-s3');
  assert.equal(entry.type, 'tree');
  const mark = fake.calls.length;
  const res = await store.commitFiles({
    ref: 'heads/gh-pages',
    files: [
      { path: 'site/reports/123/j55-s3', type: 'tree', sha: entry.sha },
      { path: 'index.html', content: 'site' }, // unchanged → skipped
    ],
    sleep: fastSleep,
  });
  assert.equal(res.changed, true);
  assert.deepEqual(res.uploaded, []);
  assert.deepEqual(res.skipped, ['index.html']);
  assert.equal(blobPosts(fake, mark).length, 0, 'no blob upload for the graft');
  assert.equal(String(fake.store.readFile('gh-pages', 'site/reports/123/j55-s3/report.html')), report);
  assert.equal(String(fake.store.readFile('gh-pages', 'site/reports/123/j55-s3/meta.json')), '{"runId":123}');
  // Grafting the same subtree again is a no-op.
  const res2 = await store.commitFiles({
    ref: 'heads/gh-pages',
    files: [{ path: 'site/reports/123/j55-s3', type: 'tree', sha: entry.sha }],
    sleep: fastSleep,
  });
  assert.equal(res2.changed, false);
});

test('a blob graft references an existing blob by sha', async () => {
  const { fake, store } = setup();
  fake.store.seedBranch('inbox', { 'a/data.txt': 'payload' });
  const inbox = await store.readRef('heads/inbox');
  const entry = await store.findEntry(inbox.treeSha, 'a/data.txt');
  const res = await store.commitFiles({ ref: 'heads/gh-pages', files: [{ path: 'copy.txt', type: 'blob', sha: entry.sha }], sleep: fastSleep });
  assert.equal(res.created, true);
  assert.equal(String(fake.store.readFile('gh-pages', 'copy.txt')), 'payload');
});

test('mixing a graft with a file nested under it throws', async () => {
  const { store } = setup();
  await assert.rejects(
    store.commitFiles({
      ref: 'heads/gh-pages',
      files: [
        { path: 'reports/1', type: 'tree', sha: EMPTY_TREE_SHA },
        { path: 'reports/1/extra.txt', content: 'x' },
      ],
      sleep: fastSleep,
    }),
    (e) => e instanceof GitStoreError && /nested under entry reports\/1/.test(e.message),
  );
  await assert.rejects(
    store.commitFiles({ ref: 'heads/x', files: [{ path: 'a.txt', content: '1' }, { path: 'a.txt', content: '2' }], sleep: fastSleep }),
    /duplicate path/,
  );
  await assert.rejects(store.commitFiles({ ref: 'heads/x', files: [], sleep: fastSleep }), /non-empty/);
});

test('orphan:true rewrites the branch as a single parentless commit (force)', async () => {
  const { fake, store } = setup();
  fake.store.seedBranch('gh-pages', { 'index.html': 'v1', 'stale.txt': 'stale' });
  fake.store.seedBranch('gh-pages', { 'index.html': 'v2' });
  assert.equal(fake.store.commitsOf('gh-pages').length, 2);
  const res = await store.commitFiles({
    ref: 'heads/gh-pages',
    orphan: true,
    files: [{ path: 'index.html', content: 'squashed' }],
    sleep: fastSleep,
  });
  assert.equal(res.changed, true);
  assert.equal(res.created, false);
  assert.deepEqual(fake.store.commitsOf('gh-pages'), [res.sha], 'history squashed to one commit');
  assert.deepEqual(fake.store.commit(res.sha).parents, []);
  assert.equal(String(fake.store.readFile('gh-pages', 'index.html')), 'squashed');
  assert.equal(fake.store.readFile('gh-pages', 'stale.txt'), null, 'tree built without base');
  const patch = fake.calls.find(c => c.method === 'PATCH' && c.path.includes('/git/refs/'));
  assert.equal(patch.body.force, true);
  // Re-running the same orphan publish is a no-op (already a root commit with that tree).
  const res2 = await store.commitFiles({ ref: 'heads/gh-pages', orphan: true, files: [{ path: 'index.html', content: 'squashed' }], sleep: fastSleep });
  assert.equal(res2.changed, false);
  assert.equal(fake.store.headOf('gh-pages'), res.sha);
});

test('commitFiles throws kind conflict when the budget is exhausted by CAS races', async () => {
  const { fake, store } = setup();
  fake.store.seedBranch('gh-pages', { 'index.html': 'v1' });
  let races = 0;
  fake.hook(({ method, path }) => {
    if (method === 'PATCH' && path.includes('/git/refs/')) {
      races++;
      fake.store.seedBranch('gh-pages', { ['rival-' + races + '.txt']: 'r' });
    }
  });
  await assert.rejects(
    store.commitFiles({ ref: 'heads/gh-pages', files: [{ path: 'mine.txt', content: 'mine' }], budgetMs: 40, sleep: fastSleep }),
    (e) => {
      assert.ok(e instanceof GitStoreError);
      assert.equal(e.kind, 'conflict');
      assert.match(e.message, /compare-and-swap|budget/i);
      return true;
    },
  );
  assert.ok(races >= 1);
});

test('readOnly token → GitStoreError kind permission carrying the API message', async () => {
  const { fake, store } = setup({ readOnly: true });
  fake.store.seedBranch('gh-pages', { 'index.html': 'v1' });
  await assert.rejects(
    store.commitFiles({ ref: 'heads/gh-pages', files: [{ path: 'x.txt', content: 'x' }], sleep: fastSleep }),
    (e) => {
      assert.ok(e instanceof GitStoreError);
      assert.equal(e.kind, 'permission');
      assert.match(e.message, /Resource not accessible by integration/);
      assert.equal(e.status, 403);
      return true;
    },
  );
});

test('escaped rate limits are waited out (not counted as attempts), then the publish succeeds', async () => {
  const { fake, store } = setup({ rateLimit: { times: 3 } });
  let waits = 0;
  const countingSleep = (ms) => { waits++; assert.ok(ms >= 200 || ms === 1000, `wait ${ms}`); return Promise.resolve(); };
  const res = await store.commitFiles({
    ref: 'heads/gh-pages',
    files: [{ path: 'index.html', content: 'site' }, { path: '.nojekyll', content: '' }],
    sleep: countingSleep,
  });
  assert.equal(res.changed, true);
  assert.equal(res.created, true);
  assert.equal(res.attempts, 0, 'rate-limit waits are not CAS attempts');
  assert.equal(waits, 3, 'one bounded wait per escaped rate limit');
  assert.equal(String(fake.store.readFile('gh-pages', 'index.html')), 'site');
});

test('empty repository → clear error', async () => {
  const { store } = setup({ empty: true });
  await assert.rejects(store.readRef('heads/gh-pages'), (e) => e instanceof GitStoreError && /no commits yet/.test(e.message));
  await assert.rejects(
    store.commitFiles({ ref: 'heads/gh-pages', files: [{ path: 'x', content: 'x' }], sleep: fastSleep }),
    (e) => e instanceof GitStoreError && /no commits yet/.test(e.message),
  );
  await assert.rejects(store.listRefs('heads/build-monitor-inbox/'), /no commits yet/);
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('readRef returns null for a missing ref and {sha, treeSha, parents} for a branch', async () => {
  const { fake, store } = setup();
  assert.equal(await store.readRef('heads/nope'), null);
  const seed = fake.store.seedBranch('main', { 'a.txt': 'a' });
  const head = await store.readRef('heads/main');
  assert.equal(head.sha, seed);
  assert.equal(head.treeSha, fake.store.commit(seed).tree);
  assert.deepEqual(head.parents, []);
});

test('findEntry / listDir walk one level at a time', async () => {
  const { fake, store } = setup();
  fake.store.seedBranch('main', { 'reports/123/j1-s3/report.html': '<html>', 'reports/123/j1-s3/meta.json': '{}', 'index.html': 'x' });
  const { treeSha } = await store.readRef('heads/main');
  const blob = await store.findEntry(treeSha, 'reports/123/j1-s3/report.html');
  assert.equal(blob.type, 'blob');
  assert.equal(blob.mode, '100644');
  assert.equal(blob.size, 6);
  const dir = await store.findEntry(treeSha, 'reports/123');
  assert.equal(dir.type, 'tree');
  assert.equal(await store.findEntry(treeSha, 'reports/999'), null);
  assert.equal(await store.findEntry(treeSha, 'index.html/nested'), null, 'walking through a blob');
  assert.deepEqual((await store.listDir(treeSha, 'reports/123/j1-s3')).map(e => e.path).sort(), ['meta.json', 'report.html']);
  assert.deepEqual((await store.listDir(treeSha, '')).map(e => e.path).sort(), ['index.html', 'reports']);
  assert.deepEqual(await store.listDir(treeSha, 'missing/dir'), []);
});

test('readBlob honours the raw media type, the base64 fallback and the size cap', async () => {
  const { fake, api, store } = setup();
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i % 256));
  fake.store.seedBranch('main', { 'data.bin': bytes });
  const { treeSha } = await store.readRef('heads/main');
  const entry = await store.findEntry(treeSha, 'data.bin');

  assert.deepEqual(await store.readBlob(entry.sha, { maxBytes: 1000, size: entry.size }), bytes);

  const mark = fake.calls.length;
  await assert.rejects(store.readBlob(entry.sha, { maxBytes: 10, size: entry.size }), (e) => e instanceof GitStoreError && e.kind === 'other' && /over the 10-byte limit/.test(e.message));
  assert.equal(fake.calls.length, mark, 'size is checked before any request');
  await assert.rejects(store.readBlob(entry.sha, { maxBytes: 10 }), /over the 10-byte limit/); // no size hint → checked on the body

  // A server ignoring the raw Accept header answers the base64 JSON envelope.
  const stripAccept = (url, init) => {
    const headers = Object.assign({}, init && init.headers);
    delete headers.Accept;
    delete headers.accept;
    return fake.fetch(url, Object.assign({}, init, { headers }));
  };
  const store2 = new GitStore({ api: new GitHubApi({ token: 'x', fetch: stripAccept, maxRateLimitWaits: 0 }), repo: REPO });
  assert.deepEqual(await store2.readBlob(entry.sha, { maxBytes: 1000 }), bytes);
});

test('listRefs filters by full prefix and paginates; deleteRef is idempotent', async () => {
  const { fake, store } = setup();
  for (const b of ['build-monitor-inbox/101', 'build-monitor-inbox/102', 'build-monitor-inbox-other', 'main']) {
    fake.store.seedBranch(b, { 'f.txt': b });
  }
  const refs = await store.listRefs('heads/build-monitor-inbox/');
  assert.deepEqual(refs.map(r => r.ref), ['refs/heads/build-monitor-inbox/101', 'refs/heads/build-monitor-inbox/102']);
  assert.equal(refs[0].sha, fake.store.headOf('build-monitor-inbox/101'));

  for (let i = 0; i < 105; i++) fake.store.seedBranch(`many/${1000 + i}`, { 'f.txt': String(i) });
  assert.equal((await store.listRefs('heads/many/')).length, 105, 'paginated past the 100-per-page limit');

  assert.equal(await store.deleteRef('heads/build-monitor-inbox/101'), true);
  assert.equal(await store.deleteRef('heads/build-monitor-inbox/101'), false, 'already gone');
  assert.equal(await store.readRef('heads/build-monitor-inbox/101'), null);
  assert.equal((await store.listRefs('heads/build-monitor-inbox/')).length, 1);
});

// ---------------------------------------------------------------------------
// validatePath / isCasConflict
// ---------------------------------------------------------------------------

test('validatePath accepts sane POSIX paths and rejects escapes', () => {
  assert.equal(validatePath('reports/123/j1-s3/report.html'), 'reports/123/j1-s3/report.html');
  assert.equal(validatePath('.nojekyll'), '.nojekyll');
  assert.equal(validatePath('a-b_c.d/e f'), 'a-b_c.d/e f');
  for (const bad of ['../x', 'a/../b', 'a/..', '/abs', 'a\\b', 'a//b', 'a/', '', '.', 'a/.', 'a/./b', 'x'.repeat(201), ('a/'.repeat(2100)) + 'b', 'a\u0000b', null, 42]) {
    assert.throws(() => validatePath(bad), GitStoreError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isCasConflict recognises CAS losses only', () => {
  const h = (entries) => ({ get: (k) => (entries && k in entries ? entries[k] : null) });
  assert.equal(isCasConflict(new HttpError(422, 'x', '{"message":"Update is not a fast forward"}', h())), true);
  assert.equal(isCasConflict(new HttpError(422, 'x', '{"message":"Reference already exists"}', h())), true);
  assert.equal(isCasConflict(new HttpError(404, 'x', '{"message":"Not Found"}', h())), false);
  assert.equal(isCasConflict(new Error('boom')), false);
});

// ---------------------------------------------------------------------------
// The fake's Actions/Pages routes (contract for the other suites)
// ---------------------------------------------------------------------------

function miniRun(p) {
  const iso = (h) => new Date(Date.UTC(2026, 0, p.day || 1, h)).toISOString();
  return {
    id: p.id, name: 'CI', workflow_id: p.workflowId || 7, path: '.github/workflows/ci.yml',
    run_number: p.id, run_attempt: p.attempt || 1, event: 'push', status: 'completed', conclusion: p.conclusion || 'success',
    head_branch: p.branch || 'main', head_sha: 'deadbeef'.repeat(5), display_title: `run ${p.id}`,
    html_url: `https://github.com/${REPO}/actions/runs/${p.id}`,
    created_at: iso(1), updated_at: iso(2), run_started_at: iso(1),
    jobs: (p.jobs || [1]).map((n, i) => ({
      id: p.id * 100 + i, run_id: p.id, run_attempt: typeof n === 'object' ? n.attempt : (p.attempt || 1),
      name: `job-${i}`, status: 'completed', conclusion: 'success',
      started_at: iso(1), completed_at: iso(2), html_url: `https://github.com/${REPO}/actions/runs/${p.id}/job/${p.id * 100 + i}`,
      steps: [{ number: 1, name: 'step', status: 'completed', conclusion: 'success', started_at: iso(1), completed_at: iso(2) }],
    })),
  };
}

test('fake Actions routes: workflows, runs with created filter + pagination, jobs, attempts, pages', async () => {
  const runs = [miniRun({ id: 1, day: 1 }), miniRun({ id: 2, day: 10 }), miniRun({ id: 3, day: 20, attempt: 2, jobs: [{ attempt: 1 }, { attempt: 2 }] })];
  const { api } = setup({ workflows: [{ id: 7, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }], runs, pages: { html_url: 'https://acme.github.io/widgets/' } });

  const wfs = await api.get(`/repos/${REPO}/actions/workflows`);
  assert.equal(wfs.total_count, 1);
  assert.equal(wfs.workflows[0].id, 7);

  const all = await api.paginate(`/repos/${REPO}/actions/workflows/7/runs`, { per_page: 1 }, 'workflow_runs');
  assert.deepEqual(all.map(r => r.id), [3, 2, 1], 'newest first, across Link pages');
  const since = await api.get(`/repos/${REPO}/actions/workflows/7/runs`, { created: '>=2026-01-05' });
  assert.deepEqual(since.workflow_runs.map(r => r.id), [3, 2]);

  const run3 = await api.get(`/repos/${REPO}/actions/runs/3`);
  assert.equal(run3.run_attempt, 2);
  assert.equal(run3.jobs, undefined, 'the run object does not embed jobs');

  const latest = await api.get(`/repos/${REPO}/actions/runs/3/jobs`, { filter: 'latest' });
  assert.deepEqual(latest.jobs.map(j => j.run_attempt), [2]);
  const allJobs = await api.get(`/repos/${REPO}/actions/runs/3/jobs`, { filter: 'all' });
  assert.equal(allJobs.total_count, 2);
  const attempt1 = await api.get(`/repos/${REPO}/actions/runs/3/attempts/1/jobs`);
  assert.deepEqual(attempt1.jobs.map(j => j.run_attempt), [1]);
  await assert.rejects(api.get(`/repos/${REPO}/actions/runs/99`), (e) => e.status === 404);

  const pages = await api.get(`/repos/${REPO}/pages`);
  assert.equal(pages.html_url, 'https://acme.github.io/widgets/');
  const build = await api.send('POST', `/repos/${REPO}/pages/builds`);
  assert.equal(build.status, 'queued');
});

test('fake Git Data validation: unknown shas are 422, refs POST/PATCH/DELETE behave like GitHub', async () => {
  const { fake, api } = setup();
  const missing = 'deadbeef'.repeat(5);
  await assert.rejects(api.send('POST', `/repos/${REPO}/git/trees`, { tree: [{ path: 'x', mode: '100644', type: 'blob', sha: missing }] }), (e) => e.status === 422 && /does not exist/.test(e.body));
  await assert.rejects(api.send('POST', `/repos/${REPO}/git/trees`, { base_tree: missing, tree: [{ path: 'x', mode: '100644', type: 'blob', sha: missing }] }), (e) => e.status === 422);
  await assert.rejects(api.send('POST', `/repos/${REPO}/git/commits`, { message: 'm', tree: missing }), (e) => e.status === 422);

  const head = fake.store.seedBranch('main', { 'a.txt': 'a' });
  await assert.rejects(api.send('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: head }), (e) => e.status === 422 && /Reference already exists/.test(e.body));
  await assert.rejects(api.send('PATCH', `/repos/${REPO}/git/refs/heads/ghost`, { sha: head }), (e) => e.status === 422 && /Reference does not exist/.test(e.body));
  await assert.rejects(api.send('DELETE', `/repos/${REPO}/git/refs/heads/ghost`), (e) => e.status === 422);

  // Non-fast-forward: moving main back to a parentless rival commit needs force.
  const rivalTree = fake.store.overlayTree(null, [{ path: 'r.txt', mode: '100644', type: 'blob', content: 'r' }]);
  const rival = fake.store.putCommit({ tree: rivalTree, parents: [], message: 'rival' });
  await assert.rejects(api.send('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: rival, force: false }), (e) => e.status === 422 && /not a fast forward/.test(e.body));
  const forced = await api.send('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: rival, force: true });
  assert.equal(forced.object.sha, rival);
});

test('serve() exposes the same fake over HTTP for spawn tests', async () => {
  const { fake } = setup();
  fake.store.seedBranch('gh-pages', { 'index.html': 'v1' });
  const { url, close } = await fake.serve();
  try {
    const api = new GitHubApi({ token: 't', apiUrl: url, maxRateLimitWaits: 0 });
    const store = new GitStore({ api, repo: REPO });
    const head = await store.readRef('heads/gh-pages');
    assert.equal(head.sha, fake.store.headOf('gh-pages'));
    const res = await store.commitFiles({ ref: 'heads/gh-pages', files: [{ path: 'new.txt', content: 'over http' }], sleep: fastSleep });
    assert.equal(res.changed, true);
    assert.equal(String(fake.store.readFile('gh-pages', 'new.txt')), 'over http');
    assert.deepEqual(await store.readBlob(GitStore.blobSha('over http'), { maxBytes: 100 }), Buffer.from('over http'));
    for (let i = 0; i < 105; i++) fake.store.seedBranch(`many/${i}`, { f: String(i) });
    assert.equal((await store.listRefs('heads/many/')).length, 105, 'Link pagination points back at the local server');
  } finally {
    await close();
  }
});
