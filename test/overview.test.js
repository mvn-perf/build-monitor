/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * src/overview.js: the Overview of an mvn-lens report as job-summary
 * Markdown. The computations are checked against hand-computed values (the
 * same arithmetic as mvn-lens's dashboard.js renderOverview), the rendering
 * against the exact Markdown, and both against malformed and oversized models.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ov = require('../src/overview');
const { fixtureModel, FIXTURES } = require('./helpers');

const { overviewOf, renderOverview, machineCpuSummary, machineMemorySeries, slowestTestOf, issueCoord } = ov;

/**
 * A real assertj model, downsampled (test/fixtures/model-assertj.json). Origin:
 * the mvn-lens report of assertj CI run 33852101842, job "Kotlin 2.2.21"
 * (reports/33852101842/j100956996317-s6/report.html on mvn-perf.github.io/assertj).
 * session, environment, modules (with their mojos), issues and warnings are kept
 * whole; the sample series are thinned to keep the file small: per JVM every
 * 12th cpu sample, every 4th gc event, every 4th physical memory row plus the
 * first 10 heap rows, and the first 20 jit entries overall. The derived figures
 * (GC pause, C2 compile, machine CPU / memory) are therefore those of the
 * fixture, not of the original report; the assertions below recompute them.
 */
function assertjModel() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'model-assertj.json'), 'utf8'));
}

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''}: ${actual} != ${expected}`);
}

// ---------------------------------------------------------------------------
// Cards and hero
// ---------------------------------------------------------------------------

test('overviewOf: the hero and the seven cards of the fixture model', () => {
  const o = overviewOf(fixtureModel());
  assert.equal(o.schemaVersion, 1);
  assert.deepEqual(o.build, { gav: 'org.mvnlens.it:it04-multi-module:1.0-SNAPSHOT', goals: ['clean', 'verify'], status: 'OK', mavenVersion: '3.9.16', jdkVersion: '17.0.8.1' });
  assert.deepEqual(o.hero, { totalMs: 7975, wallMs: 7573 });
  assert.deepEqual(o.cards.cpu, { cpuMs: 903, wallMs: 7573 });
  assert.deepEqual(o.cards.threads, { threads: 1, builderId: 'singlethreaded' });
  assert.deepEqual(o.cards.forks, { totalForks: 4, modulesWithForks: 4, moduleCount: 5 });
  assert.deepEqual(o.cards.slowestGoal, { goal: 'test', plugin: 'org.apache.maven.plugins:maven-surefire-plugin', phase: 'test', moduleKey: 'org.mvnlens.it:lib-a:1.0-SNAPSHOT', durationMs: 1651 });
  assert.deepEqual(o.cards.gcPause, { gcMs: 0, gcCount: 17 });
  assert.deepEqual(o.cards.c2, { count: 45, ms: 9919 });
  assert.deepEqual(o.cards.slowestTest, { name: 'liba.LibATest#name', className: 'LibATest', method: 'name', durationMs: 133 });
});

test('overviewOf: the slowest goal falls back to the longest mojo of the reactor, C2 counts tier-4 compilations only', () => {
  const model = fixtureModel();
  delete model.slowestMojo;
  model.jit = [{ level: 4, durationMs: 100 }, { level: 3, durationMs: 1000 }, { level: 1, durationMs: 1000 }, { level: null, durationMs: 1000 }, { durationMs: 1000 }, { level: 5, durationMs: 50 }];
  const o = overviewOf(model);
  const longest = model.modules.flatMap(m => m.mojos).sort((a, b) => b.durationMs - a.durationMs)[0];
  assert.ok(longest.durationMs > 0 && longest.goal !== 'test', 'the fixture keeps no surefire mojo: the fallback differs from the recorded slowestMojo');
  assert.equal(o.cards.slowestGoal.goal, longest.goal);
  assert.equal(o.cards.slowestGoal.durationMs, longest.durationMs, 'the longest mojo of all modules');
  assert.deepEqual(o.cards.c2, { count: 2, ms: 150 });
  model.modules = [];
  assert.equal(overviewOf(model).cards.slowestGoal, null);
});

test('slowestTestOf: the class and the method apart, the package dropped, every shape of the model', () => {
  assert.deepEqual(slowestTestOf({ name: 'a.b.CTest#m', durationMs: 5 }), { name: 'a.b.CTest#m', className: 'CTest', method: 'm', durationMs: 5 });
  assert.deepEqual(slowestTestOf({ className: 'a.b.CTest', methodName: 'm', durationMs: 5 }), { name: 'a.b.CTest#m', className: 'CTest', method: 'm', durationMs: 5 });
  assert.deepEqual(slowestTestOf({ className: 'a.b.CTest', method: 'm' }), { name: 'a.b.CTest#m', className: 'CTest', method: 'm', durationMs: null });
  assert.deepEqual(slowestTestOf({ displayName: 'name()' }), { name: 'name()', className: 'name()', method: null, durationMs: null });
  assert.deepEqual(slowestTestOf({ name: 'Some test with spaces.and dots' }), { name: 'Some test with spaces.and dots', className: 'Some test with spaces.and dots', method: null, durationMs: null });
  assert.deepEqual(slowestTestOf({ name: 'CTest#m' }), { name: 'CTest#m', className: 'CTest', method: 'm', durationMs: null });
  assert.equal(slowestTestOf({ durationMs: 5 }), null);
  assert.equal(slowestTestOf(null), null);
  assert.equal(slowestTestOf('x'), null);
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test('overviewOf: project (reactor order, packaging counts, jar by default), module wall times, lifecycle phases', () => {
  const o = overviewOf({
    session: { groupId: 'g', artifactId: 'a', version: '1' },
    modules: [
      { reactorIndex: 2, name: 'Two', wallMs: 200, mojos: [{ phase: 'compile', durationMs: 50 }, { phase: ' test ', durationMs: 120 }, { durationMs: 7 }, { phase: '', durationMs: 3 }] },
      { reactorIndex: 0, artifactId: 'zero', packaging: 'pom', wallMs: 0, mojos: [{ phase: 'compile', durationMs: 10 }] },
      { reactorIndex: 1, moduleKey: 'g:one:1', packaging: '  ', wallMs: 1000, mojos: 'nope' },
      { reactorIndex: 3, name: 'Three', packaging: 'war', mojos: [{ phase: 'compile', durationMs: 0 }] },
    ],
  });
  assert.deepEqual(o.project, {
    gav: 'g:a:1', moduleCount: 4,
    packagings: [{ packaging: 'pom', count: 1 }, { packaging: 'jar', count: 2 }, { packaging: 'war', count: 1 }],
    modules: [{ name: 'zero', packaging: 'pom' }, { name: 'g:one:1', packaging: 'jar' }, { name: 'Two', packaging: 'jar' }, { name: 'Three', packaging: 'war' }],
  });
  assert.deepEqual(o.moduleTimes, { total: 2, items: [{ label: 'g:one:1', ms: 1000 }, { label: 'Two', ms: 200 }] }, 'zero and missing wall times are dropped, longest first');
  assert.deepEqual(o.phaseTimes, { total: 3, items: [{ label: 'test', ms: 120 }, { label: 'compile', ms: 60 }, { label: '(no phase)', ms: 10 }] }, 'summed across modules, trimmed, unbound goals grouped');
});

test('machineCpuSummary: the parent JVM\'s machine share, time-weighted, its maximum and its last sample (hand-computed)', () => {
  const cpu = [
    { jvm: 'maven', timeMs: 0, systemPct: 0, processPct: 0 },        // the baseline sample: dropped, it anchors the series
    { jvm: 'maven', timeMs: 4000, systemPct: 25, processPct: 10 },   // out of order on purpose: the series is sorted by time
    { jvm: 'maven', timeMs: 1000, systemPct: 50, processPct: 20 },
    { jvm: 'maven', timeMs: 2000, systemPct: 100, processPct: 40 },
    { jvm: 'fork:a', timeMs: 1500, systemPct: 0, processPct: 0 },    // a fork's own readings never stand for the machine
    { jvm: 'fork:a', timeMs: 2000, systemPct: 60, processPct: 60 },
    { jvm: 'fork:a', timeMs: 9000, systemPct: 80, processPct: 80 },
    { jvm: 'fork:lonely', timeMs: 100, systemPct: 1, processPct: 1 }, // a single sample is no series
    null, 'junk', 42,
  ];
  const s = machineCpuSummary(cpu);
  close(s.avg, 50, 'machine: (1000×50 + 1000×100 + 2000×25) / 4000');
  assert.equal(s.max, 100);
  assert.equal(s.lastSec, 4);
  assert.equal(machineCpuSummary([]), null);
  assert.equal(machineCpuSummary([{ jvm: 'maven', timeMs: 5 }]), null, 'one sample only');
  assert.deepEqual(machineCpuSummary([{ jvm: 'maven', timeMs: 0 }, { jvm: 'maven', timeMs: 1000 }]), { avg: null, max: null, lastSec: 1 }, 'samples without a value');
});

test('machineCpuSummary: without the parent JVM the longest series is the machine witness', () => {
  const s = machineCpuSummary([
    { jvm: 'fork:short', timeMs: 0 }, { jvm: 'fork:short', timeMs: 1000, systemPct: 10, processPct: 10 },
    { jvm: 'fork:long', timeMs: 0 }, { jvm: 'fork:long', timeMs: 1000, systemPct: 30, processPct: 30 }, { jvm: 'fork:long', timeMs: 2000, systemPct: 50, processPct: 50 },
  ]);
  close(s.avg, 40, 'fork:long systemPct, time-weighted');
  assert.equal(s.max, 50);
  assert.equal(s.lastSec, 2);
});

test('machineMemorySeries: the parent JVM\'s physical readings, the largest total, zero readings ignored', () => {
  const m = machineMemorySeries([
    { jvm: 'maven', source: 'physical', timeMs: 1000, usedBytes: 100, totalBytes: 1000 },
    { jvm: 'maven', source: 'physical', timeMs: 2000, usedBytes: 300, totalBytes: 900 },
    { jvm: 'maven', source: 'physical', timeMs: 3000, usedBytes: 200, totalBytes: 1000 },
    { jvm: 'maven', source: 'physical', timeMs: 4000, usedBytes: 0, totalBytes: 1000 },
    { jvm: 'maven', source: 'heap', timeMs: 3000, usedBytes: 5000, totalBytes: 9000 },
    { jvm: 'fork:a', source: 'physical', timeMs: 1500, usedBytes: 999, totalBytes: 1000 },
  ]);
  assert.deepEqual(m, { peakBytes: 300, avgBytes: 200, totalBytes: 1000, lastSec: 3 });
  const fallback = machineMemorySeries([
    { jvm: 'fork:a', source: 'physical', timeMs: 1000, usedBytes: 10, totalBytes: 100 },
    { jvm: 'fork:b', source: 'physical', timeMs: 1000, usedBytes: 20, totalBytes: 100 },
    { jvm: 'fork:b', source: 'physical', timeMs: 2000, usedBytes: 40, totalBytes: 100 },
  ]);
  assert.deepEqual(fallback, { peakBytes: 40, avgBytes: 30, totalBytes: 100, lastSec: 2 }, 'the JVM that sampled it most');
  assert.equal(machineMemorySeries([{ jvm: 'maven', source: 'heap', usedBytes: 5 }]), null);
  assert.equal(machineMemorySeries([]), null);
});

test('overviewOf: the build timeline (session start as the origin, modules without a window dropped, the window stretched to the last sample)', () => {
  const o = overviewOf({
    session: { startedAt: 10000 },
    modules: [
      { reactorIndex: 1, name: 'B', startMs: 11000, endMs: 12500 },
      { reactorIndex: 0, name: 'A', startMs: 10500, endMs: 11000 },
      { reactorIndex: 2, name: 'no window', startMs: 0, endMs: 0 },
      { reactorIndex: 3, name: 'inverted', startMs: 12000, endMs: 11000 },
    ],
    cpu: [{ jvm: 'maven', timeMs: 0 }, { jvm: 'maven', timeMs: 4000, systemPct: 40, processPct: 20 }],
    memory: [{ jvm: 'maven', source: 'physical', timeMs: 5000, usedBytes: 50, totalBytes: 100 }],
  });
  assert.deepEqual(o.timeline, {
    moduleCount: 2,
    items: [{ label: 'A', startSec: 0.5, endSec: 1, durationMs: 500 }, { label: 'B', startSec: 1, endSec: 2.5, durationMs: 1500 }],
    xMin: 0, xMax: 5,
    cpu: { avg: 40, max: 40 },
    memory: { peakBytes: 50, avgBytes: 50, totalBytes: 100 },
  });
  const noStart = overviewOf({ modules: [{ name: 'A', startMs: 10500, endMs: 11000 }] });
  assert.deepEqual(noStart.timeline.items, [{ label: 'A', startSec: 0, endSec: 0.5, durationMs: 500 }], 'the first module start is the origin when the session has none');
});

test('overviewOf: issues with their coordinates and counts, warnings of both shapes', () => {
  const o = overviewOf({
    issues: [
      { severity: 'error', source: 'mojo', moduleKey: 'g:a:1', plugin: 'p', goal: 'g', executionId: 'default', phase: 'test', message: 'boom', exceptionType: 'X' },
      { severity: 'WARNING', source: 'fork', moduleKey: 'g:b:1', executionId: 'e1', exceptionType: 'Y' },
      { severity: 'FATAL', message: 'dead' },
      { severity: 'odd', message: 'x' },
      {},
    ],
    warnings: ['plain', { message: 'shaped' }, { code: 7 }, 42, null],
  });
  assert.equal(o.issues.count, 5);
  assert.deepEqual([o.issues.fatal, o.issues.errors, o.issues.warnings], [1, 1, 1]);
  assert.deepEqual(o.issues.items, [
    { severity: 'ERROR', source: 'mojo', coord: 'g:a:1 p:g (test)', message: 'boom', exceptionType: 'X' },
    { severity: 'WARNING', source: 'fork', coord: 'g:b:1 @e1', message: 'Y', exceptionType: 'Y' },
    { severity: 'FATAL', source: '?', coord: null, message: 'dead', exceptionType: null },
    { severity: 'ODD', source: '?', coord: null, message: 'x', exceptionType: null },
    { severity: 'ERROR', source: '?', coord: null, message: '(no message)', exceptionType: null },
  ]);
  assert.deepEqual(o.warnings, { count: 5, items: ['plain', 'shaped', '{"code":7}', '42', '(no message)'] });
  assert.equal(issueCoord({ plugin: 'p' }), 'p');
  assert.equal(issueCoord({ goal: 'g', executionId: 'run-1' }), ':g @run-1');
  assert.equal(issueCoord({}), null);
});

// ---------------------------------------------------------------------------
// Caps and robustness
// ---------------------------------------------------------------------------

test('overviewOf: every list is capped and every string truncated to one line', () => {
  const long = 'x'.repeat(500);
  const model = {
    modules: Array.from({ length: 60 }, (_, i) => ({ reactorIndex: i, name: `m${i}\n${long}`, wallMs: 1000 - i, startMs: 1000 + i, endMs: 2000 + i, mojos: [{ phase: `p${i}`, durationMs: 100 - i }] })),
    issues: Array.from({ length: 25 }, (_, i) => ({ severity: 'ERROR', message: `issue ${i} ${long}` })),
    warnings: Array.from({ length: 25 }, (_, i) => `warning ${i}\r\n${long}`),
  };
  const o = overviewOf(model);
  assert.equal(o.project.moduleCount, 60);
  assert.equal(o.project.modules.length, ov.MAX_PROJECT_MODULES);
  assert.equal(o.project.modules[0].name.length, ov.MAX_LABEL);
  assert.ok(o.project.modules[0].name.startsWith('m0 xxx') && o.project.modules[0].name.endsWith('…'), o.project.modules[0].name);
  assert.deepEqual([o.moduleTimes.total, o.moduleTimes.items.length], [60, ov.MAX_BAR_ROWS]);
  assert.deepEqual([o.phaseTimes.total, o.phaseTimes.items.length], [60, ov.MAX_BAR_ROWS]);
  assert.deepEqual([o.timeline.moduleCount, o.timeline.items.length], [60, ov.MAX_TIMELINE_ROWS]);
  assert.deepEqual([o.issues.count, o.issues.items.length], [25, ov.MAX_ISSUES]);
  assert.equal(o.issues.items[0].message.length, ov.MAX_MESSAGE);
  assert.deepEqual([o.warnings.count, o.warnings.items.length], [25, ov.MAX_WARNINGS]);
  assert.ok(o.warnings.items[0].startsWith('warning 0 xxx') && !o.warnings.items[0].includes('\n'));
  const md = renderOverview(o);
  assert.ok(md.includes('51. … and 10 more modules'), md);
  assert.ok(md.includes('| … 35 more modules |  |  |'), md);
  assert.ok(md.includes('| … 35 more phases |  |  |'), md);
  assert.ok(md.includes('```\n\n… 30 more modules: the chart shows the first 30 to start.\n'), md);
  assert.equal((md.match(/^ {4}[^ ].* :m\d+, \d\d:\d\d:\d\d\.\d{3}, \d\d:\d\d:\d\d\.\d{3}$/gm) || []).length, ov.MAX_TIMELINE_ROWS, 'one gantt task per charted module');
  assert.ok(md.includes('- … 5 more issues (see the report)'), md);
  assert.ok(md.includes('- … 5 more warnings (see the report)'), md);
  assert.ok(Buffer.byteLength(md, 'utf8') < 64 * 1024, `${Buffer.byteLength(md, 'utf8')} bytes`);
});

test('overviewOf and renderOverview never throw on a malformed model', () => {
  const empty = [
    null, undefined, 'report', 42, [], {},
    { session: 'x', modules: 'y', jit: {}, gc: 7, cpu: [null, 1, {}, { jvm: 3, timeMs: 'now' }], memory: [{ source: 'physical', usedBytes: 'many' }], issues: [1, 'x', null], warnings: 'w', slowestTest: 'nope', slowestMojo: [] },
  ];
  for (const m of empty) {
    const o = overviewOf(m);
    assert.equal(o.schemaVersion, 1);
    const md = renderOverview(o);
    assert.match(md, /^\*\*Duration —\*\* · after extensions init/);
    assert.ok(md.includes('No module data.') && md.includes('No timeline data.') && md.includes('No timing data.') && md.includes('No test data.') && md.includes('No build issues recorded.') && md.includes('No warnings.'), md);
    assert.ok(!md.includes('CPU usage</b>') && !md.includes('GC pause</b>'), 'the per-JVM tables mvn-lens dropped from its Overview (PR #25) are not rendered');
  }
  // Wrong types inside otherwise plausible fields: every field counts as absent, the module still shows.
  const typed = overviewOf({ session: { totalMs: 'a', wallMs: NaN, cpuMs: Infinity, threads: '4', goals: 'verify', status: {} }, modules: [{ mojos: [null, { durationMs: '5' }], forkCount: '2', wallMs: -1 }] });
  assert.deepEqual(typed.hero, { totalMs: null, wallMs: null });
  assert.deepEqual(typed.build.goals, []);
  assert.deepEqual(typed.project.modules, [{ name: '?', packaging: 'jar' }]);
  assert.deepEqual(typed.cards.forks, { totalForks: 0, modulesWithForks: 0, moduleCount: 1 });
  const md = renderOverview(typed);
  assert.match(md, /^\*\*Duration —\*\* · after extensions init {2}\nMaven\n/);
  assert.ok(md.includes('| **—** | **—**<br>sequential | **0**<br>no Surefire/Failsafe forks | **—** | **—** | **—** | **—** |'), md);
  assert.equal(renderOverview(null), renderOverview(overviewOf(null)));
  assert.equal(renderOverview('x'), renderOverview(overviewOf(null)));
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

test('renderOverview: the hero, the cards table and the sections, with model text escaped for Markdown', () => {
  const model = {
    session: { groupId: 'g', artifactId: 'a|b', version: '1', goals: ['clean', 'ver`ify'], status: 'FAILED', threads: 4, builderId: 'multithreaded', totalMs: 65000, wallMs: 64000, cpuMs: 128000, gcMs: 1500, gcCount: 3, mavenVersion: '3.9', jdkVersion: '21' },
    modules: [
      { reactorIndex: 0, name: 'core <script>', packaging: 'jar', wallMs: 1000, forkCount: 2, startMs: 0, endMs: 0, mojos: [{ phase: 'test', durationMs: 900, goal: 'test', plugin: 'surefire' }] },
      { reactorIndex: 1, name: 'web_app*', wallMs: 100, forkCount: 0, mojos: [{ phase: 'compile', durationMs: 10 }] },
      { reactorIndex: 2, name: 'tiny', wallMs: 10, mojos: [] },
    ],
    jit: [{ level: 4, durationMs: 2500 }],
    slowestMojo: { goal: 'test', durationMs: 900 },
    slowestTest: { name: 'a.b.C_Test#m_1', durationMs: 42 },
  };
  const md = renderOverview(overviewOf(model));
  const lines = md.split('\n');
  assert.equal(lines[0], '**Duration 1m 05s** · 1m 04s after extensions init  ');
  assert.equal(lines[1], 'Maven `clean verify` · ❌ FAILED · g:a\\|b:1 · Maven 3.9 · JDK 21');
  assert.equal(lines[2], '');
  assert.equal(lines[3], '| CPU | Threads | Surefire JVMs | Slowest goal | GC pause | C2 compile | Slowest test |');
  assert.equal(lines[4], '|---|---|---|---|---|---|---|');
  assert.equal(lines[5], '| **200% of machine**<br>2m 08s machine-time · all JVMs | **4**<br>multithreaded · parallel | **2**<br>across 1 module | **test**<br>900 ms | **1.5 s**<br>3 events | **2.5 s**<br>1 compilations | **C\\_Test**<br>#m\\_1 · 42 ms |');
  assert.ok(md.includes('1. core \\<script\\> `jar`\n2. web\\_app\\* `jar`\n3. tiny `jar`'), md);
  assert.ok(md.includes('| core \\<script\\> | 1.0 s | ████████████████████ |\n| web\\_app\\* | 100 ms | ██ |\n| tiny | 10 ms | █ |'), md, 'bars are proportional to the longest, never empty');
  assert.ok(md.includes('| test | 900 ms | ████████████████████ |\n| compile | 10 ms | █ |'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Build timeline, CPU and memory usage</b></summary>\n\nNo timeline data.\n\n</details>'), md, 'no module has a build window');
  assert.ok(md.includes('<details open>\n<summary><b>Project</b> · 3 modules</summary>'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Module wall time</b> · 3 modules</summary>'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Lifecycle phase time</b> · 2 phases</summary>'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Issues</b></summary>\n\nNo build issues recorded.'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Warnings</b></summary>\n\nNo warnings.'), md);
  assert.ok(!/<summary>[^\n]*(script|web_app)/.test(md), 'model text never reaches a <summary> line (raw HTML there)');
  assert.ok(!md.includes('<script>'), 'raw model text is escaped');
  assert.ok(md.endsWith('</details>\n\n'), JSON.stringify(md.slice(-30)));
});

test('renderOverview: the timeline gantt with the machine CPU and memory figures, the issue and warning lists', () => {
  const model = {
    session: { startedAt: 1000, totalMs: 3000, wallMs: 3000 },
    modules: [
      { reactorIndex: 0, name: 'first', startMs: 1000, endMs: 2000, wallMs: 1000 },
      { reactorIndex: 1, name: 'second', startMs: 2000, endMs: 4000, wallMs: 2000 },
    ],
    cpu: [
      { jvm: 'maven', timeMs: 0 }, { jvm: 'maven', timeMs: 1000, systemPct: 50, processPct: 25 }, { jvm: 'maven', timeMs: 3000, systemPct: 80, processPct: 40 },
      { jvm: 'fork:x|y', timeMs: 1000 }, { jvm: 'fork:x|y', timeMs: 2000, systemPct: 90, processPct: 60 },
    ],
    memory: [{ jvm: 'maven', source: 'physical', timeMs: 1000, usedBytes: 4 * 1024 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 * 1024 }],
    gc: [{ jvm: 'maven', pauseMs: 12 }, { jvm: 'fork:x|y', pauseMs: 3 }, { jvm: 'fork:x|y', pauseMs: 4 }],
    issues: [{ severity: 'WARNING', source: 'fork', moduleKey: 'g:m:1', message: 'slow [fork]' }, { severity: 'ERROR', source: 'mojo', message: 'failed', exceptionType: 'E' }],
    warnings: ['one', 'two'],
  };
  const md = renderOverview(overviewOf(model));
  assert.ok(md.includes('bars overlap only where modules built in parallel. Below it, the machine-wide CPU and memory usage'), md);
  assert.ok(md.includes(`\`\`\`mermaid\n${ov.GANTT_INIT}\ngantt\n    dateFormat HH:mm:ss.SSS\n    axisFormat %M:%S\n    tickInterval 1second\n    todayMarker off\n    section Modules\n    first (1.0 s) :m1, 00:00:00.000, 00:00:01.000\n    second (2.0 s) :m2, 00:00:01.000, 00:00:03.000\n\`\`\`\n\n**Machine CPU usage**`), md);
  assert.ok(md.includes('**Machine CPU usage** · average 70.0%, maximum 80.0%  \n**Machine memory usage** · peak 4.00 GB of 16.00 GB (25.0%), average 4.00 GB  '), md);
  const order = ['<b>Issues</b>', '<b>Warnings</b>', '<b>Tests</b>', '<b>Project</b>', '<b>Build timeline, CPU and memory usage</b>', '<b>Module wall time</b>', '<b>Lifecycle phase time</b>'];
  assert.deepEqual(md.match(/<b>[^<]+<\/b>/g), order, 'what went wrong first (issues, warnings, the Tests pane\'s lists), then the other sections of the dashboard Overview in its order, nothing else');
  assert.ok(md.includes('<details open>\n<summary><b>Issues</b> · 2 issues</summary>\n\n**2 issues recorded** · 1 error · 1 warning\n\n- ⚠️ **WARNING** · fork · g:m:1 — slow \\[fork\\]\n- ❌ **ERROR** · mojo — failed `E`\n'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Warnings</b> · 2</summary>\n\n- one\n- two\n'), md);
});

test('renderOverview: the timeline is a Mermaid gantt — one task per module with its duration, clock times since session start, at most ten ticks, names that cannot break the chart', () => {
  const base = 1788509419213;
  const mod = (i, name, startMs, endMs) => ({ reactorIndex: i, name, startMs: base + startMs, endMs: base + endMs, wallMs: endMs - startMs });

  // The module windows of a real assertj build (run 33852101842): 93.3 s, with 539 ms, 16 ms, 205 ms and 9 ms modules
  // around the two long ones. Text lanes of 30 cells drew each short module over a cell of its neighbour, which read as
  // modules building in parallel in a singlethreaded build; the gantt draws every bar at its true start and end.
  const sequential = {
    session: { startedAt: base, wallMs: 93296, totalMs: 93590, threads: 1, builderId: 'singlethreaded' },
    modules: [mod(0, 'Build', 1526, 2065), mod(1, 'Parent', 2066, 2082), mod(2, 'Core', 2082, 70851), mod(3, 'Tests', 70852, 71057), mod(4, 'IT', 71058, 71067), mod(5, 'Kotlin', 71068, 93296)],
  };
  const md = renderOverview(overviewOf(sequential));
  // The init directive: bars twice Mermaid's default height and 16 px labels (the defaults are 20 px bars and 11 px text).
  assert.ok(md.includes('```mermaid\n%%{init: {"gantt": {"barHeight": 40, "barGap": 8, "fontSize": 16, "sectionFontSize": 16, "topPadding": 60, "leftPadding": 110}}}%%\ngantt\n'), md);
  assert.ok(md.includes([
    '```mermaid', ov.GANTT_INIT, 'gantt', '    dateFormat HH:mm:ss.SSS', '    axisFormat %M:%S', '    tickInterval 10second', '    todayMarker off', '    section Modules',
    '    Build (539 ms) :m1, 00:00:01.526, 00:00:02.065',
    '    Parent (16 ms) :m2, 00:00:02.066, 00:00:02.082',
    '    Core (1m 09s) :m3, 00:00:02.082, 00:01:10.851',
    '    Tests (205 ms) :m4, 00:01:10.852, 00:01:11.057',
    '    IT (9 ms) :m5, 00:01:11.058, 00:01:11.067',
    '    Kotlin (22.2 s) :m6, 00:01:11.068, 00:01:33.296',
    '```', '',
  ].join('\n')), md);
  assert.ok(!md.includes('| Timeline |') && !md.includes('░'), 'no text lanes any more: ' + md);

  // Names: the characters that end a Mermaid task name or open a comment are replaced, a leading keyword is prefixed so
  // it is not read as a statement; tasks are listed in start order and parallel modules keep their real windows.
  const odd = { session: { startedAt: base, threads: 4 }, modules: [mod(0, 'section: core #1; 50% `done`', 0, 2000), mod(1, 'B', 1000, 3000), mod(2, 'title', 20, 60)] };
  const g = renderOverview(overviewOf(odd));
  assert.ok(g.includes('    · section core 1 50 done (2.0 s) :m1, 00:00:00.000, 00:00:02.000\n    · title (40 ms) :m2, 00:00:00.020, 00:00:00.060\n    B (2.0 s) :m3, 00:00:01.000, 00:00:03.000\n```'), g);

  // Past an hour the axis shows hours and the ticks get coarser (2 h → 8 ticks of 15 min).
  const long = { session: { startedAt: base }, modules: [mod(0, 'X', 0, 2 * 3600 * 1000 + 1)] };
  const l = renderOverview(overviewOf(long));
  assert.ok(l.includes('    axisFormat %H:%M:%S\n    tickInterval 15minute\n'), l);
  assert.ok(l.includes('    X (2h 00m) :m1, 00:00:00.000, 02:00:00.001\n'), l);
});

test('overviewOf / renderOverview: the Tests section lists every failed test (model.failedTests, uncapped in the model) and the ten slowest tests across frameworks', () => {
  const t = (name, ms, extra) => Object.assign({ name, className: name.split('#')[0], methodName: name.split('#')[1], durationMs: ms, framework: 'JUNIT5', module: 'g:core:1', status: 'PASSED' }, extra);
  const model = {
    tests: {
      junitPlatform: Array.from({ length: 10 }, (_, i) => t(`a.b.Jupiter_Test#case_${i}`, 1000 - i * 10)),
      testng: [t('c.NgTest#slow', 5000, { framework: 'TESTNG', module: 'g:web:1' }), t('c.NgTest#fast', 5)],
      junit4: [t('d.OldTest#legacy', 0, { durationMaxMs: 950, framework: 'JUNIT4' })],   // no durationMs: the longest invocation, as the dashboard ranks it
    },
    failedTests: [t('a.b.Jupiter_Test#broken', 12, { status: 'FAILED' }), t('c.NgTest#errored', 3, { framework: 'TESTNG', status: 'ERRORED', module: 'g:web:1' })],
  };
  const o = overviewOf(model).tests;
  assert.equal(o.failed.count, 2);
  assert.deepEqual(o.failed.items[0], { name: 'a.b.Jupiter_Test#broken', className: 'Jupiter_Test', method: 'broken', module: 'core', framework: 'JUNIT5', durationMs: 12, status: 'FAILED' });
  assert.equal(o.slowest.ranked, 13);
  assert.deepEqual(o.slowest.items.map(i => `${i.className}#${i.method} ${i.durationMs}`), [
    'NgTest#slow 5000', 'Jupiter_Test#case_0 1000', 'Jupiter_Test#case_1 990', 'Jupiter_Test#case_2 980', 'Jupiter_Test#case_3 970',
    'Jupiter_Test#case_4 960', 'Jupiter_Test#case_5 950', 'OldTest#legacy 950', 'Jupiter_Test#case_6 940', 'Jupiter_Test#case_7 930',
  ]);

  const md = renderOverview(overviewOf(model));
  assert.ok(md.includes('<details open>\n<summary><b>Tests</b> · 2 failed · 10 slowest</summary>\n\n**2 failed tests** · every failure of the build, whatever its duration\n\n| Test | Module | Framework | Duration | Status |\n|---|---|---|---:|---|\n| **Jupiter\\_Test**<br>#broken | core | JUNIT5 | 12 ms | ❌ FAILED |\n| **NgTest**<br>#errored | web | TESTNG | 3 ms | ❌ ERRORED |\n\n**10 slowest tests** · mvn-lens ranks up to 10 per test framework; failures are listed above in full, so a fast failing test is not here\n\n| # | Test | Module | Framework | Duration |\n|---:|---|---|---|---:|\n| 1 | **NgTest**<br>#slow | web | TESTNG | 5.0 s |\n| 2 | **Jupiter\\_Test**<br>#case\\_0 | core | JUNIT5 | 1.0 s |\n'), md);

  // Reports written before model.failedTests existed: the failures among the ranked tests, by the dashboard's substring rule.
  const old = overviewOf({ tests: { junit4: [t('x.T#a', 1, { status: 'FAILURE' }), t('x.T#b', 2, { outcome: 'ERROR', status: undefined }), t('x.T#c', 3)] } }).tests;
  assert.deepEqual(old.failed.items.map(i => i.method), ['a', 'b']);

  // Caps, and the section without any test data.
  const many = overviewOf({ failedTests: Array.from({ length: 60 }, (_, i) => t(`x.T#f${i}`, 1, { status: 'FAILED' })) });
  assert.equal(many.tests.failed.items.length, ov.MAX_FAILED_TESTS);
  const manyMd = renderOverview(many);
  assert.ok(manyMd.includes('<summary><b>Tests</b> · 60 failed</summary>') && manyMd.includes('| … 10 more |  |  |  |  |'), manyMd);
  assert.ok(renderOverview(overviewOf({})).includes('<details open>\n<summary><b>Tests</b></summary>\n\nNo test data.\n\n</details>'));
});

test('renderOverview: the fixture and a real (downsampled) assertj model render every section', () => {
  const md = renderOverview(overviewOf(assertjModel()));
  assert.match(md, /^\*\*Duration 1m 34s\*\* · 1m 33s after extensions init {2}\nMaven `verify` · ✅ OK · org\.assertj:assertj-build:4\.0\.0-SNAPSHOT · Maven 3\.9\.16 · JDK 25\.0\.4\n/);
  assert.ok(md.includes('| **59% of machine**<br>54.7 s machine-time · all JVMs | **1**<br>singlethreaded · sequential | **2**<br>across 2 modules | **test**<br>33.7 s | **2.2 s**<br>167 events |'), md);
  assert.ok(md.includes('| **Char2DArrays\\_assertHasDimensions\\_Test**<br>#should\\_delegate\\_to\\_Arrays2D · 495 ms |'), md);
  assert.ok(md.includes('org.assertj:assertj-build:4.0.0-SNAPSHOT — 6 modules, packagings = 4 pom, 2 jar. Listed in reactor build order.'), md);
  assert.ok(md.includes('| AssertJ Core | 1m 09s | ████████████████████ |'), md);
  assert.ok(md.includes('| test | 37.8 s | ████████████████████ |'), md);
  assert.ok(md.includes('    tickInterval 10second\n    todayMarker off\n    section Modules\n    AssertJ Build (539 ms) :m1, 00:00:01.526, 00:00:02.065\n    AssertJ Parent (16 ms) :m2, 00:00:02.066, 00:00:02.082\n    AssertJ Core (1m 09s) :m3, 00:00:02.082, 00:01:10.851\n'), md);
  assert.ok(md.includes('**Machine CPU usage** · average 63.2%, maximum 97.5%  \n**Machine memory usage** · peak 3.17 GB of 15.61 GB (20.3%), average 2.42 GB  \n'), md);
  assert.ok(md.includes('No build issues recorded.') && md.includes('No warnings.'), md);
  assert.ok(md.includes('<details open>\n<summary><b>Tests</b> · no failure · 3 slowest</summary>\n\nNo failed test.\n\n**3 slowest tests** · mvn-lens ranks up to 10 per test framework; failures are listed above in full, so a fast failing test is not here\n\n| # | Test | Module | Framework | Duration |\n|---:|---|---|---|---:|\n| 1 | **Char2DArrays\\_assertHasDimensions\\_Test**<br>#should\\_delegate\\_to\\_Arrays2D | assertj-core | JUNIT5 | 495 ms |\n| 2 | **Iterables\\_assertDoesNotHaveDuplicates\\_Test**<br>#should\\_pass\\_within\\_time\\_constraints | assertj-core | JUNIT5 | 209 ms |\n'), md);
  assert.ok(!md.includes('fork:assertj-core:default-test:2839'), 'no per-JVM table: the JVM labels appear nowhere in the Overview');

  const small = renderOverview(overviewOf(fixtureModel()));
  assert.ok(small.includes('| Library A | 3.1 s | ████████████████████ |'), small);
});

test('overviewOf: the machine CPU and memory figures of the assertj fixture, recomputed from its "maven" JVM samples', () => {
  const m = assertjModel();
  // CPU: the parent JVM's samples in time order, the first (baseline) sample dropped, the average weighted by the gap to the previous sample.
  const cpu = m.cpu.filter(c => c.jvm === 'maven').sort((a, b) => a.timeMs - b.timeMs);
  assert.equal(cpu.length, 77, 'every 12th sample of the 3 JVMs: 77 for maven');
  let weighted = 0;
  let span = 0;
  let max = 0;
  for (let i = 1; i < cpu.length; i++) {
    const gap = cpu[i].timeMs - cpu[i - 1].timeMs;
    assert.ok(gap > 0 && Number.isFinite(cpu[i].systemPct));
    weighted += gap * cpu[i].systemPct;
    span += gap;
    max = Math.max(max, cpu[i].systemPct);
  }
  // Memory: the parent JVM's physical rows with a positive usedBytes; peak and plain average of them, the largest totalBytes.
  const mem = m.memory.filter(r => r.jvm === 'maven' && r.source === 'physical' && r.usedBytes > 0);
  assert.equal(mem.length, 24);
  const peak = Math.max(...mem.map(r => r.usedBytes));
  const avg = mem.reduce((s, r) => s + r.usedBytes, 0) / mem.length;
  const total = Math.max(...mem.map(r => r.totalBytes));

  const t = overviewOf(m).timeline;
  close(t.cpu.avg, weighted / span, 'machine CPU average');
  assert.equal(t.cpu.max, max);
  assert.equal(t.memory.peakBytes, peak);
  close(t.memory.avgBytes, avg, 'machine memory average');
  assert.equal(t.memory.totalBytes, total);
  // The rendered figures above (63.2%, 97.5%, 3.17 GB, 15.61 GB, 20.3%, 2.42 GB) are these numbers formatted.
  assert.equal(Math.round(weighted / span * 10) / 10, 63.2);
  assert.equal(Math.round(max * 10) / 10, 97.5);
  assert.equal(Math.round(peak / 1024 ** 3 * 100) / 100, 3.17);
  assert.equal(Math.round(total / 1024 ** 3 * 100) / 100, 15.61);
  assert.equal(Math.round(peak / total * 1000) / 10, 20.3);
  assert.equal(Math.round(avg / 1024 ** 3 * 100) / 100, 2.42);
});

test('renderOverview: hero fallbacks (no total, no wall, a zero total)', () => {
  assert.match(renderOverview(overviewOf({ session: { wallMs: 5000 } })), /^\*\*Duration 5\.0 s\*\* · after extensions init/);
  assert.match(renderOverview(overviewOf({ session: { totalMs: 0, wallMs: 5000 } })), /^\*\*Duration 5\.0 s\*\* · after extensions init/);
  assert.match(renderOverview(overviewOf({ session: { totalMs: 6000 } })), /^\*\*Duration 6\.0 s\*\* · after extensions init/);
  assert.match(renderOverview(overviewOf({ session: { status: 'UNKNOWN' } })), /^\*\*Duration —\*\* · after extensions init {2}\nMaven · ⚪ UNKNOWN\n/);
  assert.match(renderOverview(overviewOf({ session: { cpuMs: 1234 } })), /\| \*\*1\.2 s\*\*<br>1\.2 s machine-time · all JVMs \|/, 'CPU without a wall time is the raw figure');
  assert.match(renderOverview(overviewOf({ session: { threads: 2 } })), /\| \*\*2\*\*<br>parallel \|/);
  assert.match(renderOverview(overviewOf({ modules: [{ name: 'a' }] })), /\| \*\*0\*\*<br>no Surefire\/Failsafe forks \|/);
});
