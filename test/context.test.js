/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../src/context');
const { HttpError } = require('../src/github-api');
const { tmpDir } = require('./helpers');

const BASE_ENV = {
  GITHUB_REPOSITORY: 'Acme/Widgets', GITHUB_SERVER_URL: 'https://github.com/', GITHUB_API_URL: 'https://api.github.com',
  GITHUB_RUN_ID: '123456', GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'build', RUNNER_NAME: 'GitHub Actions 7',
  GITHUB_WORKFLOW_REF: 'Acme/Widgets/.github/workflows/ci.yml@refs/heads/main', GITHUB_WORKFLOW: 'CI', GITHUB_EVENT_NAME: 'push',
  GITHUB_SHA: 'abc123', GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'octocat',
};

test('githubContext parses the GITHUB_* environment and the workflow_run event payload', () => {
  const dir = tmpDir('ctx');
  const eventFile = path.join(dir, 'event.json');
  const payload = {
    action: 'completed',
    workflow_run: {
      id: 999, run_attempt: 3, status: 'completed', conclusion: 'failure', event: 'pull_request', workflow_id: 55, name: 'CI', path: '.github/workflows/ci.yml',
      head_branch: 'feature/x', head_sha: 'cafebabe', head_repository: { full_name: 'forker/Widgets' }, html_url: 'https://github.com/Acme/Widgets/actions/runs/999',
    },
    workflow: { id: 55, name: 'CI', path: '.github/workflows/ci.yml' },
  };
  fs.writeFileSync(eventFile, JSON.stringify(payload));
  const ctx = C.githubContext(Object.assign({}, BASE_ENV, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventFile }));
  assert.equal(ctx.repository, 'Acme/Widgets');
  assert.equal(ctx.owner, 'Acme');
  assert.equal(ctx.repoName, 'Widgets');
  assert.equal(ctx.serverUrl, 'https://github.com', 'trailing slash removed');
  assert.equal(ctx.apiUrl, 'https://api.github.com');
  assert.equal(ctx.runId, 123456);
  assert.equal(ctx.runNumber, 42);
  assert.equal(ctx.runAttempt, 2);
  assert.equal(ctx.jobKey, 'build');
  assert.equal(ctx.runnerName, 'GitHub Actions 7');
  assert.equal(ctx.workflowRef, BASE_ENV.GITHUB_WORKFLOW_REF);
  assert.equal(ctx.workflowPath, '.github/workflows/ci.yml');
  assert.equal(ctx.workflowName, 'CI');
  assert.equal(ctx.eventName, 'workflow_run');
  assert.equal(ctx.sha, 'abc123');
  assert.equal(ctx.refName, 'main');
  assert.equal(ctx.actor, 'octocat');
  assert.equal(ctx.isGitHubCom, true);
  assert.equal(ctx.event.action, 'completed');
  assert.deepEqual(C.triggeringRun(ctx), {
    id: 999, attempt: 3, status: 'completed', conclusion: 'failure', event: 'pull_request', workflowId: 55, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml',
    headBranch: 'feature/x', headSha: 'cafebabe', headRepository: 'forker/Widgets', htmlUrl: 'https://github.com/Acme/Widgets/actions/runs/999',
  });
});

test('githubContext is defensive: missing, malformed and unreadable values become null / defaults', () => {
  const empty = C.githubContext({});
  assert.equal(empty.repository, null);
  assert.equal(empty.owner, null);
  assert.equal(empty.repoName, null);
  assert.equal(empty.serverUrl, 'https://github.com');
  assert.equal(empty.apiUrl, 'https://api.github.com');
  assert.equal(empty.runId, null);
  assert.equal(empty.runNumber, null);
  assert.equal(empty.runAttempt, 1);
  assert.equal(empty.jobKey, null);
  assert.equal(empty.workflowPath, null);
  assert.equal(empty.event, null);
  assert.equal(empty.isGitHubCom, true);
  assert.equal(C.triggeringRun(empty), null);
  assert.equal(C.triggeringRun(null), null);

  const dir = tmpDir('ctx');
  const broken = path.join(dir, 'event.json');
  fs.writeFileSync(broken, '{not json');
  const bad = C.githubContext({
    GITHUB_REPOSITORY: 'not a repo', GITHUB_RUN_ID: '-5', GITHUB_RUN_ATTEMPT: 'x', GITHUB_SERVER_URL: 'https://ghe.example.com',
    GITHUB_EVENT_PATH: broken, GITHUB_WORKFLOW_REF: 'garbage', GITHUB_JOB: '   ',
  });
  assert.equal(bad.repository, null, 'a malformed GITHUB_REPOSITORY is not used');
  assert.equal(bad.runId, null);
  assert.equal(bad.runAttempt, 1);
  assert.equal(bad.event, null, 'invalid JSON payload is ignored');
  assert.equal(bad.workflowPath, null);
  assert.equal(bad.jobKey, null, 'blank strings are null');
  assert.equal(bad.isGitHubCom, false);
  assert.equal(C.githubContext({ GITHUB_EVENT_PATH: path.join(dir, 'missing.json') }).event, null);
  assert.equal(C.githubContext({ GITHUB_EVENT_PATH: dir }).event, null, 'a directory is not a payload');

  const list = path.join(dir, 'list.json');
  fs.writeFileSync(list, '[1,2]');
  assert.equal(C.githubContext({ GITHUB_EVENT_PATH: list }).event, null, 'a payload must be an object');

  // workflow_run without a usable id, or an event of another kind
  assert.equal(C.triggeringRun({ event: { workflow_run: { id: 'abc' } } }), null);
  assert.equal(C.triggeringRun({ event: { workflow_run: 'x' } }), null);
  assert.equal(C.triggeringRun({ event: { workflow_dispatch: {} } }), null);
  const minimal = C.triggeringRun({ event: { workflow_run: { id: 7 } } });
  assert.equal(minimal.id, 7);
  assert.equal(minimal.attempt, 1);
  assert.equal(minimal.headRepository, null);
  assert.equal(minimal.workflowId, null);
});

test('defaultSiteUrl follows the github.io convention, handles owner.github.io repos and GHES', () => {
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets', serverUrl: 'https://github.com' }), 'https://acme.github.io/Widgets/');
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets' }), 'https://acme.github.io/Widgets/', 'github.com by default');
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets' }, 'docs'), 'https://acme.github.io/Widgets/docs/');
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets' }, '/site/sub/'), 'https://acme.github.io/Widgets/site/sub/');
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets' }, './'), 'https://acme.github.io/Widgets/');
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets' }, 'a\\b'), 'https://acme.github.io/Widgets/a/b/');
  assert.equal(C.defaultSiteUrl({ repository: 'octo/octo.github.io' }), 'https://octo.github.io/');
  assert.equal(C.defaultSiteUrl({ repository: 'Octo/Octo.GitHub.io' }, 'monitor'), 'https://octo.github.io/monitor/');
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets', serverUrl: 'https://ghe.example.com/' }), 'https://ghe.example.com/pages/Acme/Widgets/');
  assert.equal(C.defaultSiteUrl({ repository: 'Acme/Widgets', serverUrl: 'https://ghe.example.com' }, 'x'), 'https://ghe.example.com/pages/Acme/Widgets/x/');
  assert.equal(C.defaultSiteUrl(C.githubContext(BASE_ENV)), 'https://acme.github.io/Widgets/', 'accepts a full context');
  assert.equal(C.defaultSiteUrl({ repository: null }), null);
  assert.equal(C.defaultSiteUrl({}), null);
  assert.equal(C.defaultSiteUrl(null), null);
});

/** A GitHubApi stand-in whose GET /pages answers with `pages` (an object) or throws it (an Error). */
function apiStub(pages) {
  const calls = [];
  return {
    calls,
    async get(p) {
      calls.push(p);
      if (pages instanceof Error) throw pages;
      return pages;
    },
  };
}

test('resolveSiteUrl: input wins, then the Pages API, then the convention; exactly one trailing slash', async () => {
  const ctx = C.githubContext(BASE_ENV);
  const api = apiStub({ html_url: 'https://widgets.example.com/' });
  assert.equal(await C.resolveSiteUrl({ api, repository: 'Acme/Widgets', input: 'https://custom.example.org/mon', siteDir: '', ctx }), 'https://custom.example.org/mon/');
  assert.equal(api.calls.length, 0, 'the input short-circuits the API');
  assert.equal(await C.resolveSiteUrl({ api, repository: 'Acme/Widgets', input: 'https://custom.example.org/mon///', siteDir: 'docs', ctx }), 'https://custom.example.org/mon/docs/');
  assert.equal(await C.resolveSiteUrl({ input: '  https://a.b/  ', siteDir: 'docs/' }), 'https://a.b/docs/', 'works without api or repository');

  assert.equal(await C.resolveSiteUrl({ api, repository: 'Acme/Widgets', input: '', siteDir: '', ctx }), 'https://widgets.example.com/');
  assert.deepEqual(api.calls, ['/repos/Acme/Widgets/pages']);
  assert.equal(await C.resolveSiteUrl({ api, repository: 'Acme/Widgets', siteDir: 'sub', ctx }), 'https://widgets.example.com/sub/');
  const noSlash = apiStub({ html_url: 'https://acme.github.io/Widgets' });
  assert.equal(await C.resolveSiteUrl({ api: noSlash, repository: 'Acme/Widgets', ctx }), 'https://acme.github.io/Widgets/');

  const notFound = apiStub(new HttpError(404, 'HTTP 404 GET /repos/Acme/Widgets/pages: {"message":"Not Found"}', '{"message":"Not Found"}', { get: () => null }));
  assert.equal(await C.resolveSiteUrl({ api: notFound, repository: 'Acme/Widgets', siteDir: null, ctx }), 'https://acme.github.io/Widgets/', '404 (Pages not enabled) falls back');
  const forbidden = apiStub(new HttpError(403, 'HTTP 403', '{"message":"Resource not accessible by integration"}', { get: () => null }));
  assert.equal(await C.resolveSiteUrl({ api: forbidden, repository: 'Acme/Widgets', siteDir: 'docs', ctx }), 'https://acme.github.io/Widgets/docs/', '403 (no pages: read) falls back');
  const crash = apiStub(new Error('fetch failed'));
  assert.equal(await C.resolveSiteUrl({ api: crash, repository: 'Acme/Widgets', ctx }), 'https://acme.github.io/Widgets/', 'network errors fall back');
  const junk = apiStub({ html_url: 'not a url' });
  assert.equal(await C.resolveSiteUrl({ api: junk, repository: 'Acme/Widgets', ctx }), 'https://acme.github.io/Widgets/', 'a non-http html_url is ignored');
  const nothing = apiStub(null);
  assert.equal(await C.resolveSiteUrl({ api: nothing, repository: 'Acme/Widgets', ctx }), 'https://acme.github.io/Widgets/');

  assert.equal(await C.resolveSiteUrl({ api: notFound, ctx }), 'https://acme.github.io/Widgets/', 'repository taken from ctx');
  const ghes = C.githubContext(Object.assign({}, BASE_ENV, { GITHUB_SERVER_URL: 'https://ghe.example.com' }));
  assert.equal(await C.resolveSiteUrl({ api: notFound, ctx: ghes, siteDir: 'm' }), 'https://ghe.example.com/pages/Acme/Widgets/m/');
  assert.equal(await C.resolveSiteUrl({ api: notFound }), null, 'nothing to derive from');
  assert.equal(await C.resolveSiteUrl({}), null);
  const weird = apiStub({ html_url: 'https://x/' });
  assert.equal(await C.resolveSiteUrl({ api: weird, repository: 'bad repo name' }), null, 'a malformed repository never reaches the API');
  assert.equal(weird.calls.length, 0);
});

test('monitorUrls builds the viewer routes and refuses invalid ids / keys', () => {
  const u = C.monitorUrls('https://acme.github.io/Widgets', 123, 'j11-s3-label');
  assert.deepEqual(u, {
    site: 'https://acme.github.io/Widgets/',
    run: 'https://acme.github.io/Widgets/#/run/123',
    report: 'https://acme.github.io/Widgets/#/report/123/j11-s3-label',
    reports: 'https://acme.github.io/Widgets/#/reports',
    builds: 'https://acme.github.io/Widgets/#/builds',
  });
  assert.equal(C.monitorUrls('https://acme.github.io/Widgets///', '123').run, 'https://acme.github.io/Widgets/#/run/123', 'string ids and extra slashes are normalised');
  const noKey = C.monitorUrls('https://s/', 5);
  assert.equal(noKey.report, null);
  assert.equal(noKey.run, 'https://s/#/run/5');
  assert.equal(C.monitorUrls('https://s/', 5, '../evil').report, null);
  assert.equal(C.monitorUrls('https://s/', 5, 'a/b').report, null);
  assert.equal(C.monitorUrls('https://s/', 5, '.hidden').report, null);
  assert.equal(C.monitorUrls('https://s/', 'abc', 'k').run, null);
  assert.equal(C.monitorUrls('https://s/', 0, 'k').run, null);
  const none = C.monitorUrls(null, 5, 'k');
  assert.deepEqual(none, { site: null, run: null, report: null, reports: null, builds: null });
  assert.equal(C.monitorUrls('   ', 5, 'k').site, null);
});

test('inboxRef / parseInboxRef round-trip with and without a trailing slash on the prefix', () => {
  assert.equal(C.inboxRef(undefined, 123), 'heads/build-monitor-inbox/123');
  assert.equal(C.inboxRef('', '123'), 'heads/build-monitor-inbox/123');
  assert.equal(C.inboxRef('build-monitor-inbox/', 123), 'heads/build-monitor-inbox/123');
  assert.equal(C.inboxRef('build-monitor-inbox', 123), 'heads/build-monitor-inbox/123', 'missing trailing slash added');
  assert.equal(C.inboxRef('ci/inbox', 7), 'heads/ci/inbox/7');
  assert.equal(C.inboxRef('refs/heads/x/', 7), 'heads/x/7');
  assert.equal(C.inboxRef('heads/x', 7), 'heads/x/7');
  assert.equal(C.inboxRef('/x//y/', 7), 'heads/x/y/7');
  assert.throws(() => C.inboxRef('x', 0), /invalid run id/);
  assert.throws(() => C.inboxRef('x', 'abc'), /invalid run id/);
  assert.throws(() => C.inboxRef('x', null), /invalid run id/);
  assert.throws(() => C.inboxRef('x', 1.5), /invalid run id/);
  for (const bad of ['a b', 'x..y', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'x@{y', '.hidden', 'a/.b/', 'x.lock', 'x.lock/y', 'x.', 'refs/heads/', 'heads/', '/']) {
    assert.throws(() => C.inboxRef(bad, 1), new RegExp('inbox-prefix'), `prefix ${JSON.stringify(bad)} must be rejected`);
  }
  assert.throws(() => C.normalizeInboxPrefix('a\tb'), /inbox-prefix/);
  assert.equal(C.normalizeInboxPrefix('build-monitor-inbox'), 'build-monitor-inbox/');
  assert.equal(C.DEFAULT_INBOX_PREFIX, 'build-monitor-inbox/');

  for (const prefix of [undefined, 'build-monitor-inbox', 'build-monitor-inbox/']) {
    assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/123', prefix), 123, `refs/heads form with prefix ${prefix}`);
    assert.equal(C.parseInboxRef('heads/build-monitor-inbox/123', prefix), 123, `heads form with prefix ${prefix}`);
    assert.equal(C.parseInboxRef('build-monitor-inbox/123', prefix), 123, `bare form with prefix ${prefix}`);
  }
  assert.equal(C.parseInboxRef(C.inboxRef('ci/inbox', 9876543210), 'ci/inbox'), 9876543210);
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/123', 'other/'), null, 'another prefix');
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox-old/123'), null, 'the prefix must match a whole segment');
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/123/extra'), null);
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/abc'), null);
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/0'), null, 'zero is not a run id');
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/-1'), null);
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/1e3'), null);
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/12.5'), null);
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/'), null);
  assert.equal(C.parseInboxRef('refs/heads/build-monitor-inbox/99999999999999999999'), null, 'beyond a safe integer');
  assert.equal(C.parseInboxRef('refs/heads/gh-pages'), null);
  assert.equal(C.parseInboxRef('refs/tags/build-monitor-inbox/123'), null, 'tags are not inbox refs');
  assert.equal(C.parseInboxRef(null), null);
  assert.equal(C.parseInboxRef(123), null);
  assert.equal(C.parseInboxRef('refs/heads/x/1', 'a b'), null, 'an invalid prefix never matches');
});

test('workflowFileUrl links to the workflow page from a path, a file name or a workflow ref', () => {
  const ctx = C.githubContext(BASE_ENV);
  assert.equal(C.workflowFileUrl(ctx, '.github/workflows/build-monitor.yml'), 'https://github.com/Acme/Widgets/actions/workflows/build-monitor.yml');
  assert.equal(C.workflowFileUrl(ctx, 'build-monitor.yml'), 'https://github.com/Acme/Widgets/actions/workflows/build-monitor.yml');
  assert.equal(C.workflowFileUrl(ctx, 'Acme/Widgets/.github/workflows/build-monitor.yml@refs/heads/main'), 'https://github.com/Acme/Widgets/actions/workflows/build-monitor.yml');
  assert.equal(C.workflowFileUrl(ctx), 'https://github.com/Acme/Widgets/actions/workflows/ci.yml', 'defaults to the context workflow');
  assert.equal(C.workflowFileUrl({ repository: 'a/b', serverUrl: 'https://ghe.example.com/', workflowRef: 'a/b/.github/workflows/x.yaml@refs/heads/dev' }), 'https://ghe.example.com/a/b/actions/workflows/x.yaml');
  assert.equal(C.workflowFileUrl({ repository: 'a/b', serverUrl: 'https://github.com' }, 'dir\\odd name.yml'), 'https://github.com/a/b/actions/workflows/odd%20name.yml');
  assert.equal(C.workflowFileUrl({ repository: 'a/b' }, '.github/workflows/'), null);
  assert.equal(C.workflowFileUrl({ repository: 'a/b' }, '..'), null);
  assert.equal(C.workflowFileUrl({ repository: 'a/b' }), null, 'no workflow known');
  assert.equal(C.workflowFileUrl({ repository: null, serverUrl: 'https://github.com' }, 'x.yml'), null);
  assert.equal(C.workflowFileUrl(null, 'x.yml'), null);
  assert.equal(C.workflowPathOf('a/b/.github/workflows/x.yml@refs/heads/main'), '.github/workflows/x.yml');
  assert.equal(C.workflowPathOf('x.yml'), null);
  assert.equal(C.workflowPathOf(null), null);
});
