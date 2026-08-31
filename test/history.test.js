/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../src/history');
const { tmpDir } = require('./helpers');

function run(id, wf, createdAt, reports, extra) {
  return Object.assign({
    id, workflowId: wf, createdAt, jobs: [],
    mvnLens: reports ? [{ key: 'k' + id, dir: `reports/${id}/k${id}`, reports: reports.map(p => ({ name: 'report.html', path: p, summary: { totalMs: 1 } })) }] : [],
  }, extra || {});
}

test('load/save round-trip, normalisation and newest-first ordering', () => {
  const dir = tmpDir('hist');
  const file = path.join(dir, 'data', 'history.json');
  const fresh = H.loadHistory(file, 'a/b');
  assert.equal(fresh.schemaVersion, H.SCHEMA_VERSION);
  assert.equal(fresh.runs.length, 0);
  assert.equal(fresh.repository, 'a/b');
  assert.deepEqual(fresh.workflows, {});
  assert.deepEqual(H.emptyHistory(), Object.assign(H.emptyHistory('x/y'), { repository: null }));
  const h = H.emptyHistory('a/b');
  h.runs.push(run(1, 1, '2026-01-01T00:00:00Z'), run(2, 1, '2026-01-02T00:00:00Z'), run(3, 1, '2026-01-02T00:00:00Z'));
  H.saveHistory(file, h);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('}\n'));
  assert.equal(H.serializeHistory(h), JSON.stringify(h) + '\n');
  const back = H.loadHistory(file, 'a/b');
  assert.deepEqual(back.runs.map(r => r.id), [3, 2, 1], 'newest first, id breaks ties');
  assert.equal(back.repository, 'a/b');
  assert.equal(H.findRun(back, 2).id, 2);
  assert.equal(H.findRun(back, 99), null);
  assert.throws(() => H.parseHistory('{not json', 'a/b'), SyntaxError, 'invalid JSON never silently starts over');
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, 'nope');
  assert.throws(() => H.loadHistory(badFile, 'a/b'), SyntaxError, 'a corrupt file never silently starts over');
});

test('normalizeHistory refuses a newer schema or another repository, and tolerates junk', () => {
  assert.throws(() => H.normalizeHistory({ schemaVersion: H.SCHEMA_VERSION + 1, repository: 'a/b', runs: [] }, 'a/b'), /newer than this action/);
  assert.throws(() => H.normalizeHistory({ schemaVersion: 99, runs: [] }, 'a/b'), /newer than this action/);
  assert.throws(() => H.normalizeHistory({ schemaVersion: 1, repository: 'x/y', runs: [] }, 'a/b'), /belongs to x\/y, not a\/b/);
  const same = H.normalizeHistory({ repository: 'A/B', runs: [] }, 'a/b');
  assert.equal(same.repository, 'A/B', 'repository names compare case-insensitively');
  assert.equal(H.normalizeHistory({ runs: [] }, 'a/b').repository, 'a/b', 'missing repository is filled in');
  assert.equal(H.normalizeHistory({ repository: 'x/y', runs: [] }).repository, 'x/y', 'no expected repository: anything goes');
  assert.equal(H.normalizeHistory(null, 'a/b').runs.length, 0);
  assert.equal(H.normalizeHistory('str', 'a/b').runs.length, 0);
  assert.equal(H.normalizeHistory({ runs: 'nope', workflows: 'nope' }, 'a/b').runs.length, 0);
  assert.deepEqual(H.normalizeHistory({ runs: 'nope', workflows: 'nope' }, 'a/b').workflows, {});

  const h = H.normalizeHistory({
    repository: 'a/b', repositoryUrl: 'https://github.com/a/b', defaultBranch: 'main', siteUrl: 'https://a.github.io/b/', generatedAt: '2026-01-01T00:00:00Z',
    workflows: { 1: { id: 1, name: 'CI' } },
    runs: [
      { id: 1, createdAt: '2026-01-01T00:00:00Z', mvnLens: 'junk' },
      { id: '2', createdAt: '2026-01-01T00:00:00Z' },
      { bogus: true },
      null,
      { id: 3, createdAt: '2026-01-02T00:00:00Z', jobs: 'x', mvnLens: [{ key: 'k', reports: 'x' }, null, 'str'] },
    ],
  }, 'a/b');
  assert.equal(h.repositoryUrl, 'https://github.com/a/b');
  assert.equal(h.defaultBranch, 'main');
  assert.equal(h.siteUrl, 'https://a.github.io/b/');
  assert.equal(h.generatedAt, '2026-01-01T00:00:00Z');
  assert.equal(h.workflows[1].name, 'CI');
  assert.deepEqual(h.runs.map(r => r.id), [3, 1], 'entries without a numeric id are dropped');
  assert.deepEqual(h.runs[1].jobs, []);
  assert.deepEqual(h.runs[1].mvnLens, []);
  assert.deepEqual(h.runs[0].jobs, []);
  assert.equal(h.runs[0].mvnLens.length, 1);
  assert.deepEqual(h.runs[0].mvnLens[0].reports, []);
});

test('normalizeHistory drops report paths and dirs that do not look like what the processor writes', () => {
  const bad = ['../../../evil', '/etc/passwd', 'reports/1/a/../b/report.html', 'reports/1/a/report.html/extra', 'reports/x/a/report.html', 'reports/1/a', 'reports/1/a/b/c', 'reports/1/%2e%2e/report.html', 'reports\\1\\a\\report.html', 'reports/1/.hidden/report.html', 'reports/1/a/.report.html', 'reports/1/a/re port.html', 'https://evil/report.html', 'reports/1//report.html', ''];
  const good = ['reports/1/a/report.html', 'reports/123456789/j11-s3-label_x.y/report-2.html', 'reports/1/a/report.html'];
  const h = H.normalizeHistory({
    repository: 'a/b',
    runs: [{ id: 1, createdAt: '2026-01-01T00:00:00Z', mvnLens: [
      { key: 'a', dir: 'reports/1/a', reports: bad.map(p => ({ name: 'r', path: p, summary: { totalMs: 5 } })).concat(good.map(p => ({ name: 'ok', path: p })), ['junk', null, 42]) },
      { key: 'b', dir: '../evil', reports: [] },
      { key: 'c', dir: 'reports/1/c/deeper', reports: [] },
      { key: 'd', dir: 'reports\\1\\d', reports: [] },
      { key: 'e', dir: null, reports: [{ name: 'n', path: null }, { name: 'u' }] },
    ] }],
  }, 'a/b');
  const entries = h.runs[0].mvnLens;
  assert.equal(entries.length, 5);
  const reps = entries[0].reports;
  assert.equal(reps.length, bad.length + good.length, 'non-object entries dropped, others kept');
  for (let i = 0; i < bad.length; i++) assert.equal(reps[i].path, null, `invalid path nulled: ${JSON.stringify(bad[i])}`);
  for (let i = 0; i < bad.length; i++) assert.equal(reps[i].summary.totalMs, 5, 'the summary survives for the trend');
  for (let i = 0; i < good.length; i++) assert.equal(reps[bad.length + i].path, good[i]);
  assert.equal(entries[0].dir, 'reports/1/a');
  assert.equal(entries[1].dir, null);
  assert.equal(entries[2].dir, null);
  assert.equal(entries[3].dir, null);
  assert.equal(entries[4].dir, null, 'null stays null');
  assert.equal(entries[4].reports[0].path, null);
  assert.equal(entries[4].reports[1].path, undefined, 'absent stays absent');
});

test('isValidKey / isValidReportDir / isValidReportPath accept the processor conventions only', () => {
  for (const k of ['j11-s3', 'j11-s3-it04-T4', 'build-abc123', 'a', 'A_b.c-d', '0', 'x'.repeat(120)]) assert.ok(H.isValidKey(k), `key ${k}`);
  for (const k of ['', '.', '..', '.hidden', '%2e%2e', 'a/b', 'a\\b', 'a b', 'a|b', 'a?b', 'x'.repeat(121), null, undefined, 42, 'é', 'a\nb', '-']) {
    if (k === '-') continue;   // a leading dash is allowed by the segment grammar (sanitizeName never produces it, harmless)
    assert.ok(!H.isValidKey(k), `key ${JSON.stringify(k)} must be invalid`);
  }
  for (const d of ['reports/1/a', 'reports/123456789012345/j11-s3-label', 'reports/1/x.y_z-w']) assert.ok(H.isValidReportDir(d), `dir ${d}`);
  for (const d of ['reports/1', 'reports/1/a/b', 'reports/a/b', 'reports/1/..', 'reports/1/.', 'reports/1/.a', 'reports/1/%2e', 'reports\\1\\a', '/reports/1/a', 'reports/1/a/', 'Reports/1/a', 'reports/-1/a', 'reports/1/a b', '', null]) {
    assert.ok(!H.isValidReportDir(d), `dir ${JSON.stringify(d)} must be invalid`);
  }
  for (const p of ['reports/1/a/report.html', 'reports/1/a/meta.json', 'reports/1/a/report-2.html', 'reports/1/j11-s3-l/report.html']) assert.ok(H.isValidReportPath(p), `path ${p}`);
  for (const p of ['reports/1/a', 'reports/1/a/b/c', 'reports/1/../a/report.html', 'reports/1/a/..', 'reports/1/a/.', 'reports/1/a/.hidden', 'reports/1/%2e%2e/r.html', 'reports/1/a/%2e%2e', 'reports\\1\\a\\report.html', '/reports/1/a/report.html', 'reports/1/a/report.html/', 'reports/1/a//report.html', 'reports/1/a/re port.html', 'https://x/reports/1/a/report.html', '', null, 5]) {
    assert.ok(!H.isValidReportPath(p), `path ${JSON.stringify(p)} must be invalid`);
  }
});

test('trimRuns keeps the newest N runs per workflow and reports what it dropped', () => {
  const h = H.emptyHistory('a/b');
  for (let i = 1; i <= 6; i++) h.runs.push(run(i, 1, `2026-01-0${i}T00:00:00Z`, [`reports/${i}/a/report.html`]));
  for (let i = 11; i <= 13; i++) h.runs.push(run(i, 2, `2026-02-${i}T00:00:00Z`, [`reports/${i}/a/report.html`]));
  h.runs.push(run(21, 3, '2025-12-31T00:00:00Z'));
  assert.deepEqual(H.trimRuns(h, 0), [], 'no limit');
  assert.equal(h.runs.length, 10);
  assert.deepEqual(H.trimRuns(h, 'x'), [], 'a non-number is no limit');
  const dropped = H.trimRuns(h, 4);
  assert.deepEqual(dropped.map(r => r.id).sort((a, b) => a - b), [1, 2], 'the oldest runs of workflow 1 only');
  assert.deepEqual(h.runs.filter(r => r.workflowId === 1).map(r => r.id), [6, 5, 4, 3]);
  assert.deepEqual(h.runs.filter(r => r.workflowId === 2).map(r => r.id), [13, 12, 11]);
  assert.deepEqual(h.runs.filter(r => r.workflowId === 3).map(r => r.id), [21]);
  assert.equal(h.runs.find(r => r.id === 3).mvnLens[0].reports[0].path, 'reports/3/a/report.html', 'report files/paths are never touched');
  const droppedAll = H.trimRuns(h, 1);
  assert.deepEqual(h.runs.map(r => r.id), [13, 6, 21]);
  assert.equal(droppedAll.length, 5);
});

test('upsertRun replaces by id, sortRuns orders by createdAt, mavenSeriesKey and reportDirFor are stable', () => {
  const h = H.emptyHistory('a/b');
  H.upsertRun(h, run(1, 1, '2026-01-01T00:00:00Z'));
  H.upsertRun(h, Object.assign(run(1, 1, '2026-01-01T00:00:00Z'), { status: 'completed' }));
  H.upsertRun(h, run(2, 1, '2026-01-03T00:00:00Z'));
  H.upsertRun(h, run(3, 1, 'garbage date'));
  assert.equal(h.runs.length, 3);
  assert.equal(h.runs[0].status, 'completed');
  H.sortRuns(h);
  assert.deepEqual(h.runs.map(r => r.id), [2, 1, 3], 'unparseable dates sink to the bottom');
  assert.equal(H.reportDirFor(42, 'j1-s3 weird/name'), 'reports/42/j1-s3-weird-name');
  assert.ok(H.isValidReportDir(H.reportDirFor(42, 'j1-s3 weird/name')));
  assert.equal(H.reportDirFor(42, '../../x'), 'reports/42/.._.._x'.replace(/_/g, '-'));
  assert.equal(H.mavenSeriesKey('.github/workflows/ci.yml', 'build (17)', 'Build', null), '.github/workflows/ci.yml build (17) Build ');
  assert.equal(H.mavenSeriesKey(null, undefined, '', 'lbl'), '   lbl');
});
