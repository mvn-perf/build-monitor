/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const util = require('../src/util');
const { tmpDir, withEnv, captureOutputs } = require('./helpers');

test('getInput reads INPUT_<NAME> with the hyphen and underscore spellings, trims and defaults', async () => {
  await withEnv({ 'INPUT_GITHUB-TOKEN': ' tok ', INPUT_MAX_RUNS: ' 12 ', INPUT_FLAG: 'Yes', INPUT_EMPTY: '', INPUT_SITE_DIR: '' }, () => {
    assert.equal(util.getInput('github-token'), 'tok');
    assert.equal(util.getInput('github-token', { trimWhitespace: false }), ' tok ');
    assert.equal(util.getInput('max-runs'), '12', 'INPUT_MAX_RUNS is an alias of INPUT_MAX-RUNS');
    assert.equal(util.getIntInput('max-runs', 5, 1, 10), 10, 'clamped to max');
    assert.equal(util.getIntInput('max-runs', 5, 20, 30), 20, 'clamped to min');
    assert.equal(util.getIntInput('missing-int', 5), 5);
    assert.equal(util.getBooleanInput('flag', false), true);
    assert.equal(util.getBooleanInput('missing', true), true);
    assert.equal(util.getBooleanInput('missing', false), false);
    assert.equal(util.getBooleanInput('empty', true), true, 'an empty value means the default');
    assert.equal(util.getInput('missing', { default: 'd' }), 'd');
    assert.equal(util.getInput('empty', { default: 'd' }), 'd', 'an empty value means the default');
    assert.equal(util.getInput('missing'), '');
    assert.throws(() => util.getInput('missing', { required: true }), /required/);
  });
  await withEnv({ INPUT_FLAG: 'maybe', INPUT_N: 'x' }, () => {
    assert.throws(() => util.getBooleanInput('flag', false), /not a boolean/);
    assert.throws(() => util.getIntInput('n', 1), /not an integer/);
  });
  assert.equal(process.env.INPUT_FLAG, undefined, 'withEnv restored the environment');
});

test('parseList splits on newlines and commas and drops blanks', () => {
  assert.deepEqual(util.parseList('a, b\n c ,,\n'), ['a', 'b', 'c']);
  assert.deepEqual(util.parseList(''), []);
  assert.deepEqual(util.parseList(null), []);
  assert.deepEqual(util.parseList('single'), ['single']);
  assert.deepEqual(util.parseList('CI\r\nRelease build'), ['CI', 'Release build']);
});

test('setOutput and appendSummary write GITHUB_OUTPUT / GITHUB_STEP_SUMMARY', async () => {
  const cap = captureOutputs();
  await withEnv(cap.env, () => {
    util.setOutput('site-url', 'https://x/\nsecond line');
    util.setOutput('count', 3);
    util.setOutput('empty', null);
    util.appendSummary('## Title');
    util.appendSummary('line');
  });
  const raw = fs.readFileSync(cap.env.GITHUB_OUTPUT, 'utf8');
  assert.match(raw, /^site-url<<ghadelimiter_\w+\r?\nhttps:\/\/x\/\r?\nsecond line\r?\nghadelimiter_\w+/);
  assert.deepEqual(cap.outputs(), { 'site-url': 'https://x/\nsecond line', count: '3', empty: '' });
  assert.match(cap.summary(), /^## Title\r?\nline\r?\n$/);
  cap.reset();
  assert.deepEqual(cap.outputs(), {});
  await withEnv({ GITHUB_OUTPUT: null, GITHUB_STEP_SUMMARY: null }, () => {
    util.setOutput('no-file', 'x');          // logs instead of throwing
    util.appendSummary('nowhere');
  });
});

test('glob supports **, * and ? and literal paths', () => {
  const root = tmpDir('glob');
  for (const f of ['a/target/mvnlens/report.html', 'b/c/target/mvnlens/report.html', 'target/mvnlens/report.html', 'target/mvnlens/model.json', 'x.html']) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), f);
  }
  const rel = (list) => list.map(p => util.toPosix(path.relative(root, p))).sort();
  assert.deepEqual(rel(util.glob('**/target/mvnlens/report.html', root)), ['a/target/mvnlens/report.html', 'b/c/target/mvnlens/report.html', 'target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('**/report.html', root)), ['a/target/mvnlens/report.html', 'b/c/target/mvnlens/report.html', 'target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('target/mvnlens/*.html', root)), ['target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('target/**/*', root)), ['target/mvnlens/model.json', 'target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('?.html', root)), ['x.html']);
  assert.deepEqual(rel(util.glob('target/mvnlens/report.html', root)), ['target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('nope/*.html', root)), []);
  assert.deepEqual(rel(util.glob('nope/report.html', root)), []);
  assert.deepEqual(rel(util.glob('target', root)), [], 'a directory is not a match');
  assert.deepEqual(rel(util.glob(path.join(root, 'a', '**', '*.html'), root)), ['a/target/mvnlens/report.html'], 'absolute pattern');
  assert.deepEqual(rel(util.glob('b\\c\\target\\mvnlens\\*.html', root)), ['b/c/target/mvnlens/report.html'], 'backslashes accepted');
  assert.deepEqual(rel(util.glob('a/target/mvnlens/report.html', root)), ['a/target/mvnlens/report.html']);
  assert.deepEqual(util.listFiles(path.join(root, 'nope')), []);
  assert.deepEqual(util.listFiles(path.join(root, 'target')).sort(), ['mvnlens/model.json', 'mvnlens/report.html']);
});

test('sanitizeName keeps path-safe characters only', () => {
  assert.equal(util.sanitizeName('JDK 21 · windows-latest / build:1'), 'JDK-21-windows-latest-build-1');
  assert.equal(util.sanitizeName('Java 25 (ubuntu-latest)'), 'Java-25-ubuntu-latest');
  assert.equal(util.sanitizeName('   '), 'unnamed');
  assert.equal(util.sanitizeName(null), 'unnamed');
  assert.equal(util.sanitizeName('a'.repeat(300), 10).length, 10);
  assert.equal(util.sanitizeName('../../etc/passwd'), '.._.._etc_passwd'.replace(/_/g, '-'));
  assert.equal(util.sanitizeName('--x--'), 'x');
  assert.equal(util.sanitizeName('a.b_c-d'), 'a.b_c-d');
});

test('posixJoin, toPosix and isWithin', () => {
  assert.equal(util.posixJoin('a', 'b/c', '/d/'), 'a/b/c/d');
  assert.equal(util.posixJoin('a\\b', 'c'), 'a/b/c');
  assert.equal(util.posixJoin('', null, undefined, 'x'), 'x');
  assert.equal(util.posixJoin(), '');
  assert.equal(util.posixJoin('//a//b//'), 'a/b');
  assert.equal(util.posixJoin('reports', 123, 'key'), 'reports/123/key');
  assert.equal(util.toPosix('a\\b\\c'), 'a/b/c');
  const base = tmpDir('within');
  assert.equal(util.isWithin(base, base), true);
  assert.equal(util.isWithin(base, path.join(base, 'x', 'y')), true);
  assert.equal(util.isWithin(base, path.join(base, '..', 'other')), false);
  assert.equal(util.isWithin(base, path.join(base, '..')), false);
});

test('safeInt accepts positive safe integers only', () => {
  assert.equal(util.safeInt(5), 5);
  assert.equal(util.safeInt('5'), 5);
  assert.equal(util.safeInt(' 42 '), 42);
  assert.equal(util.safeInt('0'), null);
  assert.equal(util.safeInt(0), null);
  assert.equal(util.safeInt(-1), null);
  assert.equal(util.safeInt('-1'), null);
  assert.equal(util.safeInt(1.5), null);
  assert.equal(util.safeInt('1.5'), null);
  assert.equal(util.safeInt('1e3'), null);
  assert.equal(util.safeInt('abc'), null);
  assert.equal(util.safeInt(''), null);
  assert.equal(util.safeInt(null), null);
  assert.equal(util.safeInt(undefined), null);
  assert.equal(util.safeInt(NaN), null);
  assert.equal(util.safeInt(Infinity), null);
  assert.equal(util.safeInt('99999999999999999999'), null, 'beyond Number.MAX_SAFE_INTEGER');
  assert.equal(util.safeInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(util.safeInt({}), null);
});

test('fmtMs and fmtBytes render human-readable values', () => {
  assert.equal(util.fmtMs(null), '\u2014');
  assert.equal(util.fmtMs(undefined), '\u2014');
  assert.equal(util.fmtMs('x'), '\u2014');
  assert.equal(util.fmtMs(0), '0 ms');
  assert.equal(util.fmtMs(999), '999 ms');
  assert.equal(util.fmtMs(1500), '1.5 s');
  assert.equal(util.fmtMs('59999'), '60.0 s');
  assert.equal(util.fmtMs(60000), '1m 00s');
  assert.equal(util.fmtMs(282000), '4m 42s');
  assert.equal(util.fmtMs(3600000), '1h 00m');
  assert.equal(util.fmtMs(3600000 * 2 + 5 * 60000), '2h 05m');
  assert.equal(util.fmtBytes(0), '0 B');
  assert.equal(util.fmtBytes(1023), '1023 B');
  assert.equal(util.fmtBytes(1024), '1.0 KB');
  assert.equal(util.fmtBytes(1536), '1.5 KB');
  assert.equal(util.fmtBytes(2.9 * 1024 * 1024), '2.9 MB');
  assert.equal(util.fmtBytes(1.25 * 1024 * 1024 * 1024), '1.25 GB');
  assert.equal(util.fmtBytes(null), '0 B');
  assert.equal(util.fmtBytes('abc'), '0 B');
});

test('escapeMd neutralises Markdown table / link syntax and newlines', () => {
  assert.equal(util.escapeMd('a|b'), 'a\\|b');
  assert.equal(util.escapeMd('*bold* _it_ `code`'), '\\*bold\\* \\_it\\_ \\`code\\`');
  assert.equal(util.escapeMd('[x](y)'), '\\[x\\](y)');
  assert.equal(util.escapeMd('<script>'), '\\<script\\>');
  assert.equal(util.escapeMd('back\\slash'), 'back\\\\slash');
  assert.equal(util.escapeMd('line1\nline2\r\nline3'), 'line1 line2 line3');
  assert.equal(util.escapeMd(null), '');
  assert.equal(util.escapeMd(undefined), '');
  assert.equal(util.escapeMd(42), '42');
  assert.equal(util.escapeMd('Java 25 (ubuntu-latest)'), 'Java 25 (ubuntu-latest)');
});

test('mapLimit keeps result order and bounds concurrency', async () => {
  const items = [50, 10, 30, 5, 20, 1, 15];
  let inFlight = 0;
  let peak = 0;
  const order = [];
  const results = await util.mapLimit(items, 3, async (ms, i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await util.sleep(ms);
    order.push(i);
    inFlight--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(results, items.map((ms, i) => `${i}:${ms}`), 'results in input order');
  assert.ok(peak <= 3, `at most 3 in flight (peak ${peak})`);
  assert.ok(peak >= 2, 'actually ran concurrently');
  assert.notDeepEqual(order, [0, 1, 2, 3, 4, 5, 6], 'completion order differs from input order');
  assert.deepEqual(await util.mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await util.mapLimit([1, 2], 0, async x => x * 2), [2, 4], 'a limit below 1 still runs');
  assert.deepEqual(await util.mapLimit([1, 2, 3], 10, async x => x), [1, 2, 3], 'a limit above the item count is fine');
  await assert.rejects(util.mapLimit([1, 2], 2, async x => { if (x === 2) throw new Error('boom'); return x; }), /boom/);
});

test('parseIsoMs, isoNow, readJson/writeJson, ensureDir/rmrf/exists and copyDir', () => {
  assert.equal(util.parseIsoMs('2026-01-01T00:00:00Z'), Date.UTC(2026, 0, 1));
  assert.equal(util.parseIsoMs('garbage'), null);
  assert.equal(util.parseIsoMs(null), null);
  assert.match(util.isoNow(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const dir = tmpDir('files');
  const file = path.join(dir, 'sub', 'deep', 'x.json');
  util.writeJson(file, { a: 1 }, true);
  assert.deepEqual(util.readJson(file), { a: 1 });
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  util.writeJson(file, { b: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"b":2}');
  const dest = path.join(dir, 'copy');
  fs.writeFileSync(path.join(dir, 'sub', 'skip.txt'), 'skip');
  util.copyDir(path.join(dir, 'sub'), dest, { skip: n => n === 'skip.txt' });
  assert.ok(util.exists(path.join(dest, 'deep', 'x.json')));
  assert.ok(!util.exists(path.join(dest, 'skip.txt')));
  util.rmrf(dest);
  assert.ok(!util.exists(dest));
  util.rmrf(path.join(dir, 'never-existed'));
});
