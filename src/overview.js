/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * The Overview page of an mvn-lens report, as a GitHub job summary.
 *
 * The `report` action runs right after the Maven step with the whole report
 * on disk, so it can put what the dashboard's Overview tab shows — the
 * duration banner, the seven stat cards and the Project / Build timeline,
 * CPU and memory usage / Module wall time / Lifecycle phase time / Issues /
 * Warnings sections, plus the Tests tab's failed and slowest tests, with what
 * went wrong first (Issues, Warnings, Tests) — into the job summary while the
 * full report is still on its way to the monitoring page. Two halves:
 *
 *   overviewOf(model)      reduces a TimelineModel to a small plain object;
 *                          every computation mirrors renderOverview() in
 *                          mvn-lens's dashboard.js (same fallbacks, same
 *                          orderings, same machine-wide CPU / memory witness)
 *   renderOverview(ov)     turns that object into GitHub-flavoured Markdown:
 *                          the charts become tables with text bars, the
 *                          <details> sections stay <details> sections
 *
 * Reference: mvn-perf/mvn-lens main at c31c25f (2026-09-02) — the Overview
 * without the per-JVM "CPU usage" and "GC pause" tables PR #25 removed.
 *
 * The model is build output: names, messages and numbers can be anything, so
 * every string is validated, truncated and Markdown-escaped, and every table
 * is capped — the summary is an overview, the report has the rest.
 */
'use strict';

const { fmtMs, fmtBytes, escapeMd } = require('./util');

/** Rows kept per table / list (a step summary is capped at 1 MiB by GitHub; the report has everything). */
const MAX_PROJECT_MODULES = 50;
const MAX_BAR_ROWS = 25;
const MAX_TIMELINE_ROWS = 30;
const MAX_ISSUES = 20;
const MAX_WARNINGS = 20;
/** Failed tests listed (model.failedTests is uncapped) and slowest tests ranked (the dashboard's "Top 10 slowest tests"). */
const MAX_FAILED_TESTS = 50;
const MAX_SLOWEST_TESTS = 10;
/** Mermaid gantt directive: bars twice the default height and 16 px labels, so the chart reads on the run page. */
const GANTT_INIT = '%%{init: {"gantt": {"barHeight": 40, "barGap": 8, "fontSize": 16, "sectionFontSize": 16, "topPadding": 60, "leftPadding": 110}}}%%';
/** Longest label / message kept from the model. */
const MAX_LABEL = 120;
const MAX_MESSAGE = 300;
/** Text bar width, in block characters. */
const BAR_WIDTH = 20;
/** The parent Maven JVM's label in model.cpu / model.memory / model.gc (assigned by the mvn-lens aggregator). */
const PARENT_JVM = 'maven';

const DASH = '—';
const DOT = '·';
const BLOCK = '█';
/** The gantt axis gets at most this many ticks: the tick spacing is the finest of GANTT_TICKS that keeps under it. */
const MAX_TICKS = 10;
const GANTT_TICKS = [[1, 'second'], [2, 'second'], [5, 'second'], [10, 'second'], [15, 'second'], [30, 'second'], [1, 'minute'], [2, 'minute'], [5, 'minute'], [10, 'minute'], [15, 'minute'], [30, 'minute'], [1, 'hour'], [2, 'hour'], [6, 'hour']];
const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000 };
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
/** Words Mermaid's gantt lexer recognises at the start of a line: a task name starting with one would be read as that statement. */
const GANTT_KEYWORDS = /^(gantt|title|section|dateFormat|axisFormat|tickInterval|todayMarker|includes|excludes|inclusiveEndDates|topAxis|weekday|weekend|click|accTitle|accDescr)\b/;

// ---------------------------------------------------------------------------
// Model → overview data
// ---------------------------------------------------------------------------

/**
 * The Overview of a TimelineModel as a plain object (numbers are finite or
 * null, strings are trimmed, truncated and never empty). Never throws on a
 * malformed model: a field that is not what it should be counts as absent.
 */
function overviewOf(model) {
  const m = obj(model);
  const s = obj(m.session);
  const modules = arr(m.modules).filter(isObj);
  const jit = arr(m.jit).filter(isObj);
  const cpu = arr(m.cpu).filter(isObj);
  const memory = arr(m.memory).filter(isObj);
  const issues = arr(m.issues).filter(isObj);
  const warnings = arr(m.warnings);

  const machineCpu = machineCpuSummary(cpu);
  const machineMem = machineMemorySeries(memory);

  return {
    schemaVersion: 1,
    build: {
      gav: [str(s.groupId), str(s.artifactId), str(s.version)].filter(Boolean).join(':') || null,
      goals: arr(s.goals).map(g => str(g)).filter(Boolean),
      status: str(s.status),
      mavenVersion: str(s.mavenVersion) || str(s.maven),
      jdkVersion: str(s.jdkVersion) || str(s.jdk),
    },
    hero: { totalMs: num(s.totalMs), wallMs: num(s.wallMs) },
    cards: {
      cpu: { cpuMs: num(s.cpuMs), wallMs: num(s.wallMs) },
      threads: { threads: num(s.threads), builderId: str(s.builderId) },
      forks: forksOf(modules),
      slowestGoal: slowestGoalOf(m, modules),
      gcPause: { gcMs: num(s.gcMs), gcCount: num(s.gcCount) },
      c2: c2Of(jit),
      slowestTest: slowestTestOf(m.slowestTest),
    },
    project: projectOf(modules, s),
    moduleTimes: capped(moduleTimesOf(modules), MAX_BAR_ROWS),
    phaseTimes: capped(phaseTimesOf(modules), MAX_BAR_ROWS),
    timeline: timelineOf(modules, s, machineCpu, machineMem),
    tests: testsOf(m),
    issues: issuesOf(issues),
    warnings: {
      count: warnings.length,
      items: warnings.slice(0, MAX_WARNINGS).map(w => message(warningText(w))),
    },
  };
}

/** A warning is a string in the model; anything else is shown the way the dashboard shows it (its message, else its JSON). */
function warningText(w) {
  if (typeof w === 'string') return w;
  if (isObj(w)) return str(w.message) || safeJson(w);
  return w === null || w === undefined ? null : safeJson(w);
}

/** Surefire/Failsafe forks: the total over the reactor and how many modules forked. */
function forksOf(modules) {
  let totalForks = 0;
  let modulesWithForks = 0;
  for (const mod of modules) {
    const n = num(mod.forkCount) || 0;
    totalForks += n;
    if (n > 0) modulesWithForks++;
  }
  return { totalForks, modulesWithForks, moduleCount: modules.length };
}

/** model.slowestMojo, else the longest mojo of every module (what the dashboard falls back to). */
function slowestGoalOf(m, modules) {
  let mojo = isObj(m.slowestMojo) ? m.slowestMojo : null;
  if (!mojo) {
    for (const mod of modules) {
      for (const mj of arr(mod.mojos).filter(isObj)) {
        if (!mojo || (num(mj.durationMs) || 0) > (num(mojo.durationMs) || 0)) mojo = mj;
      }
    }
  }
  if (!mojo) return null;
  return { goal: label(mojo.goal) || label(mojo.name), plugin: label(mojo.plugin), phase: label(mojo.phase), moduleKey: label(mojo.moduleKey), durationMs: num(mojo.durationMs) };
}

/** Total C2 (tier-4) compilation time across every JVM: compiler-thread CPU work, meaningful to sum. */
function c2Of(jit) {
  const c2 = jit.filter(e => num(e.level) !== null && num(e.level) >= 4);
  return { count: c2.length, ms: c2.reduce((t, e) => t + (num(e.durationMs) || 0), 0) };
}

/** The dashboard shows `name || method`; the summary keeps the class and method apart so the cell can wrap. */
function slowestTestOf(t) {
  if (!isObj(t)) return null;
  let full = str(t.name);
  const className = str(t.className);
  const method = str(t.methodName) || str(t.method);
  if (!full) full = className && method ? `${className}#${method}` : (className || method || str(t.displayName));
  if (!full) return null;
  const hash = full.indexOf('#');
  const cls = hash >= 0 ? full.slice(0, hash) : full;
  const rest = hash >= 0 ? full.slice(hash + 1) : null;
  // A fully-qualified class name reads better without its package; anything with spaces or brackets is not one.
  const simple = /^[\w$.]+$/.test(cls) && cls.includes('.') ? cls.slice(cls.lastIndexOf('.') + 1) : cls;
  return { name: label(full), className: label(simple), method: label(rest), durationMs: num(t.durationMs) };
}

/**
 * The two lists of the dashboard's Tests pane that matter once a build is
 * over: every failed test — model.failedTests is complete and uncapped; a
 * fast failure is not among the ranked tests, so that list is the only
 * source (reports written before it existed fall back to the failures among
 * the ranked tests, as the dashboard does) — and the slowest tests: model.tests
 * ranks up to ten per framework, combined and re-ranked here into the pane's
 * "Top 10 slowest tests".
 */
function testsOf(m) {
  const ranked = [];
  const byFramework = obj(m.tests);
  for (const key of Object.keys(byFramework)) for (const t of arr(byFramework[key])) if (isObj(t)) ranked.push(t);
  const failed = Array.isArray(m.failedTests) ? m.failedTests.filter(isObj) : ranked.filter(isFailedTest);
  const slowest = ranked.slice().sort((a, b) => testDuration(b) - testDuration(a)).slice(0, MAX_SLOWEST_TESTS);
  return {
    failed: { count: failed.length, items: failed.slice(0, MAX_FAILED_TESTS).map(testItem) },
    slowest: { ranked: ranked.length, items: slowest.map(testItem) },
  };
}
/** Like the dashboard: the duration, else the longest invocation. */
function testDuration(t) { return num(t.durationMs) || num(t.durationMaxMs) || 0; }
function testStatus(t) { return (str(t.status) || str(t.outcome) || '').toUpperCase(); }
/** The dashboard's isFailedTest: older reports carry the framework's own word ("ERRORED", "FAILURE"…). */
function isFailedTest(t) { const s = testStatus(t); return s.includes('FAIL') || s.includes('ERROR'); }
function testItem(t) {
  const named = slowestTestOf(t) || {};
  return {
    name: named.name || null, className: named.className || null, method: named.method || null,
    module: moduleArtifact(str(t.module) || str(t.moduleKey)), framework: label(t.framework),
    durationMs: testDuration(t), status: label(testStatus(t)),
  };
}
/** "org.assertj:assertj-core:4.0.0-SNAPSHOT" → "assertj-core" (the table has no room for the coordinates; the full report has them). */
function moduleArtifact(gav) {
  if (!gav) return null;
  const parts = gav.split(':');
  return label(parts.length >= 2 && parts[1] ? parts[1] : gav);
}

/** The reactor: coordinates, packaging counts ("13 jar, 1 pom") and the modules in build order. */
function projectOf(modules, s) {
  const sorted = modules.slice().sort((a, b) => (num(a.reactorIndex) || 0) - (num(b.reactorIndex) || 0));
  const byPack = new Map();
  for (const mod of sorted) {
    const p = packagingOf(mod);
    byPack.set(p, (byPack.get(p) || 0) + 1);
  }
  return {
    gav: [str(s.groupId), str(s.artifactId), str(s.version)].filter(Boolean).join(':') || null,
    moduleCount: sorted.length,
    packagings: Array.from(byPack, ([packaging, count]) => ({ packaging, count })),
    modules: sorted.slice(0, MAX_PROJECT_MODULES).map(mod => ({ name: moduleLabel(mod), packaging: packagingOf(mod) })),
  };
}

function packagingOf(mod) { return label(mod.packaging) || 'jar'; }
function moduleLabel(mod) { return label(mod.name) || label(mod.artifactId) || label(mod.moduleKey) || '?'; }

/** Wall-clock time per reactor module, longest first (a parallel build's modules overlap, so these can exceed the wall time). */
function moduleTimesOf(modules) {
  return modules.map(mod => ({ label: moduleLabel(mod), ms: num(mod.wallMs) || 0 }))
    .filter(it => it.ms > 0)
    .sort((a, b) => b.ms - a.ms);
}

/** Goal-execution time per lifecycle phase, summed over every module; goals bound to no phase group as "(no phase)". */
function phaseTimesOf(modules) {
  const totals = new Map();
  for (const mod of modules) {
    for (const mj of arr(mod.mojos).filter(isObj)) {
      const key = label(mj.phase) || '(no phase)';
      totals.set(key, (totals.get(key) || 0) + (num(mj.durationMs) || 0));
    }
  }
  return Array.from(totals, ([lbl, ms]) => ({ label: lbl, ms })).filter(it => it.ms > 0).sort((a, b) => b.ms - a.ms);
}

function capped(items, max) {
  return { total: items.length, items: items.slice(0, max) };
}

/**
 * The "Build timeline, CPU and memory usage" section: one bar per module from
 * its build start to its build end (seconds since session start, the unit the
 * CPU and memory samples use), the machine-wide CPU average/maximum and the
 * machine-wide memory peak — the same witness the dashboard plots (the parent
 * Maven JVM's readings; see machineCpuSeries / machineMemorySeries).
 */
function timelineOf(modules, s, machineCpu, machineMem) {
  const mods = modules
    .filter(mod => (num(mod.startMs) || 0) > 0 && (num(mod.endMs) || 0) > num(mod.startMs))
    .sort((a, b) => (num(a.startMs) - num(b.startMs)) || ((num(a.reactorIndex) || 0) - (num(b.reactorIndex) || 0)));
  const base = num(s.startedAt) !== null ? num(s.startedAt) : (mods.length ? num(mods[0].startMs) : 0);
  // The duration comes from the millisecond stamps, like the dashboard's tooltip: a difference of two seconds values rounds differently.
  const items = mods.map(mod => ({ label: moduleLabel(mod), startSec: (num(mod.startMs) - base) / 1000, endSec: (num(mod.endMs) - base) / 1000, durationMs: num(mod.endMs) - num(mod.startMs) }));
  let xMin = 0;
  let xMax = 0;
  for (const it of items) {
    if (it.startSec < xMin) xMin = it.startSec;
    if (it.endSec > xMax) xMax = it.endSec;
  }
  if (machineCpu && machineCpu.lastSec > xMax) xMax = machineCpu.lastSec;
  if (machineMem && machineMem.lastSec > xMax) xMax = machineMem.lastSec;
  return {
    moduleCount: items.length,
    items: items.slice(0, MAX_TIMELINE_ROWS),
    xMin, xMax,
    cpu: machineCpu && machineCpu.avg !== null ? { avg: machineCpu.avg, max: machineCpu.max } : null,
    memory: machineMem ? { peakBytes: machineMem.peakBytes, avgBytes: machineMem.avgBytes, totalBytes: machineMem.totalBytes } : null,
  };
}

function issuesOf(issues) {
  const counts = { FATAL: 0, ERROR: 0, WARNING: 0 };
  for (const i of issues) {
    const sev = (str(i.severity) || '').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(counts, sev)) counts[sev]++;
  }
  return {
    count: issues.length,
    fatal: counts.FATAL, errors: counts.ERROR, warnings: counts.WARNING,
    items: issues.slice(0, MAX_ISSUES).map(i => ({
      severity: label((str(i.severity) || 'ERROR').toUpperCase()),
      source: label(i.source) || '?',
      coord: issueCoord(i),
      message: message(str(i.message) || str(i.exceptionType) || '(no message)'),
      exceptionType: label(i.exceptionType),
    })),
  };
}

/** "<moduleKey> <plugin>:<goal> @<executionId> (<phase>)", like the dashboard's formatIssueCoord. */
function issueCoord(i) {
  const parts = [];
  const moduleKey = label(i.moduleKey);
  const plugin = label(i.plugin);
  const goal = label(i.goal);
  const executionId = label(i.executionId);
  const phase = label(i.phase);
  if (moduleKey) parts.push(moduleKey);
  if (plugin || goal) parts.push((plugin || '') + (goal ? ':' + goal : ''));
  if (executionId && executionId !== 'default') parts.push('@' + executionId);
  if (phase) parts.push('(' + phase + ')');
  return parts.length ? parts.join(' ') : null;
}

// ---------------------------------------------------------------------------
// CPU (model.cpu: jdk.CPULoad samples, one series per JVM)
// ---------------------------------------------------------------------------

/**
 * One series per JVM in first-seen order, each sorted by time. A recording's
 * first sample has no previous-tick baseline and reads 0/0, so its load
 * values are dropped but its timestamp is kept as `anchorMs` — the left edge
 * of the interval the next sample measured. Single-sample series vanish.
 */
function prepareCpuSeries(cpu) {
  const order = [];
  const byJvm = new Map();
  for (const e of arr(cpu)) {
    if (!isObj(e)) continue;
    const j = str(e.jvm) || 'unknown';
    if (!byJvm.has(j)) { byJvm.set(j, []); order.push(j); }
    byJvm.get(j).push(e);
  }
  return order.map(j => {
    const samples = byJvm.get(j).slice().sort((a, b) => (num(a.timeMs) || 0) - (num(b.timeMs) || 0));
    const baseline = samples.shift();
    return { jvm: j, anchorMs: baseline ? (num(baseline.timeMs) || 0) : 0, samples };
  }).filter(sr => sr.samples.length > 0);
}

/** The machine-wide witness: the parent Maven JVM (alive for the whole session), else the longest series. */
function machineCpuSeries(series) {
  for (const sr of series) if (sr.jvm === PARENT_JVM) return sr;
  let longest = null;
  for (const sr of series) if (!longest || sr.samples.length > longest.samples.length) longest = sr;
  return longest;
}

/**
 * The machine-wide CPU curve the Overview's timeline section draws — the
 * witness's machineTotal share (systemPct: the whole box, non-Maven processes
 * included) over time — summarised for a text rendering: its time-weighted
 * average (each sample weighted by the interval it measured), its maximum and
 * the time of its last sample. Every value is a percentage of total machine
 * capacity (100% = every core busy). Null without samples.
 */
function machineCpuSummary(cpu) {
  const machine = machineCpuSeries(prepareCpuSeries(cpu));
  if (!machine) return null;
  let weighted = 0;
  let span = 0;
  let max = null;
  let prev = machine.anchorMs;
  let lastMs = 0;
  for (const e of machine.samples) {
    const t = num(e.timeMs) || 0;
    const v = num(e.systemPct);
    const gap = t - prev;
    if (gap > 0 && v !== null) {
      weighted += gap * v;
      span += gap;
    }
    if (v !== null && (max === null || v > max)) max = v;
    if (t > lastMs) lastMs = t;
    prev = t;
  }
  return { avg: span > 0 ? weighted / span : null, max, lastSec: lastMs / 1000 };
}

// ---------------------------------------------------------------------------
// Memory (model.memory: one flat array, rows tagged with their JVM and source)
// ---------------------------------------------------------------------------

/**
 * The machine-wide memory curve: jdk.PhysicalMemory rows ("physical") of the
 * parent Maven JVM, falling back to the JVM that sampled it most. Total RAM is
 * the largest reading (a truncated first sample must not shrink it). Returns
 * { peakBytes, avgBytes, totalBytes, lastSec } or null without readings.
 */
function machineMemorySeries(memory) {
  const byJvm = new Map();
  for (const e of arr(memory)) {
    if (!isObj(e) || str(e.source) !== 'physical') continue;
    const used = num(e.usedBytes);
    if (used === null || used <= 0) continue;
    const j = str(e.jvm) || 'unknown';
    if (!byJvm.has(j)) byJvm.set(j, { used: [], total: 0 });
    const sr = byJvm.get(j);
    sr.used.push({ x: (num(e.timeMs) || 0) / 1000, y: used });
    const t = num(e.totalBytes);
    if (t !== null && t > sr.total) sr.total = t;
  }
  let best = null;
  for (const [j, sr] of byJvm) {
    if (j === PARENT_JVM) { best = sr; break; }
    if (!best || sr.used.length > best.used.length) best = sr;
  }
  if (!best) return null;
  let peak = 0;
  let sum = 0;
  let lastSec = 0;
  for (const p of best.used) {
    if (p.y > peak) peak = p.y;
    sum += p.y;
    if (p.x > lastSec) lastSec = p.x;
  }
  return { peakBytes: peak, avgBytes: sum / best.used.length, totalBytes: best.total || null, lastSec };
}

// ---------------------------------------------------------------------------
// Overview data → Markdown
// ---------------------------------------------------------------------------

/**
 * The Overview as GitHub-flavoured Markdown: the duration banner, the stat
 * cards (one table), then one <details> section per dashboard section. Text
 * is escaped for Markdown; the <summary> lines hold constants only. Returns
 * the block with a trailing newline.
 */
function renderOverview(ov) {
  const o = isObj(ov) ? ov : overviewOf(null);
  const lines = [];
  lines.push(...heroLines(o));
  lines.push('');
  lines.push(...cardLines(o.cards || {}));
  lines.push('');
  // What went wrong first — the issues, the warnings, then the Tests pane's lists — then the Overview's own sections.
  lines.push(...issuesSection(o.issues));
  lines.push(...warningsSection(o.warnings));
  lines.push(...testsSection(o.tests));
  lines.push(...projectSection(o.project));
  lines.push(...timelineSection(o.timeline));
  lines.push(...barSection('Module wall time', 'Module', o.moduleTimes, 'module', 'Wall-clock time per reactor module, longest first. In a parallel build modules overlap in time, so these can sum to more than the build\'s total wall time.'));
  lines.push(...barSection('Lifecycle phase time', 'Phase', o.phaseTimes, 'phase', 'Total goal-execution time grouped by Maven lifecycle phase, summed across all modules. Goals bound to no phase (direct invocations) are grouped as "(no phase)".'));
  return lines.join('\n') + '\n';
}

/** "**Duration 1m 34s** · 1m 33s after extensions init" and the build's identity line. */
function heroLines(o) {
  const hero = obj(o.hero);
  const build = obj(o.build);
  const total = hero.totalMs || hero.wallMs;
  const sub = hero.totalMs && hero.wallMs !== null && hero.wallMs !== undefined ? `${fmtMs(hero.wallMs)} after extensions init` : 'after extensions init';
  const parts = [];
  const goals = (build.goals || []).join(' ').replace(/[`\r\n]/g, '').trim();
  parts.push(goals ? `Maven \`${goals}\`` : 'Maven');
  if (build.status) parts.push(statusText(build.status));
  if (build.gav) parts.push(escapeMd(build.gav));
  if (build.mavenVersion) parts.push(`Maven ${escapeMd(build.mavenVersion)}`);
  if (build.jdkVersion) parts.push(`JDK ${escapeMd(build.jdkVersion)}`);
  return [`**Duration ${fmtMs(total === 0 ? null : total)}** ${DOT} ${sub}  `, parts.join(` ${DOT} `)];
}

function statusText(status) {
  const u = String(status).toUpperCase();
  if (u === 'OK') return '✅ OK';
  if (u === 'FAILED' || u === 'FAILURE') return `❌ ${escapeMd(status)}`;
  return `⚪ ${escapeMd(status)}`;
}

/** The seven stat cards of the Overview as one table: label row, then "**value**<br>sub-line". */
function cardLines(c) {
  const cpu = obj(c.cpu);
  const threads = obj(c.threads);
  const forks = obj(c.forks);
  const goal = c.slowestGoal || null;
  const gcp = obj(c.gcPause);
  const c2 = obj(c.c2);
  const test = c.slowestTest || null;

  const cpuValue = cpu.wallMs && cpu.cpuMs !== null && cpu.cpuMs !== undefined
    ? `${Math.round(cpu.cpuMs / cpu.wallMs * 100)}% of machine`
    : (cpu.cpuMs !== null && cpu.cpuMs !== undefined ? fmtMs(cpu.cpuMs) : DASH);
  const cpuSub = cpu.cpuMs !== null && cpu.cpuMs !== undefined ? `${fmtMs(cpu.cpuMs)} machine-time ${DOT} all JVMs` : null;

  const threadsValue = threads.threads !== null && threads.threads !== undefined ? String(threads.threads) : DASH;
  const parallel = threads.threads !== null && threads.threads !== undefined && threads.threads > 1;
  const threadsSub = threads.builderId ? `${threads.builderId} ${DOT} ${parallel ? 'parallel' : 'sequential'}` : (parallel ? 'parallel' : 'sequential');

  const totalForks = forks.totalForks || 0;
  const jvmValue = totalForks > 0 ? String(totalForks) : (forks.moduleCount ? '0' : DASH);
  const jvmSub = totalForks > 0 ? `across ${forks.modulesWithForks} module${forks.modulesWithForks === 1 ? '' : 's'}` : 'no Surefire/Failsafe forks';

  const gcValue = gcp.gcMs !== null && gcp.gcMs !== undefined ? fmtMs(gcp.gcMs) : DASH;
  const gcSub = gcp.gcCount !== null && gcp.gcCount !== undefined ? `${gcp.gcCount} events` : null;

  const c2Value = c2.count ? fmtMs(c2.ms) : DASH;
  const c2Sub = c2.count ? `${c2.count} compilations` : null;

  const testValue = test ? (test.className || test.name || DASH) : DASH;
  const testSub = test ? [test.method ? `#${test.method}` : null, fmtMs(test.durationMs)].filter(Boolean).join(` ${DOT} `) : null;

  const cells = [
    card(cpuValue, cpuSub),
    card(threadsValue, threadsSub),
    card(jvmValue, jvmSub),
    card(goal ? (goal.goal || DASH) : DASH, goal && goal.durationMs !== null ? fmtMs(goal.durationMs) : null),
    card(gcValue, gcSub),
    card(c2Value, c2Sub),
    card(testValue, testSub),
  ];
  return [
    '| CPU | Threads | Surefire JVMs | Slowest goal | GC pause | C2 compile | Slowest test |',
    '|---|---|---|---|---|---|---|',
    row(cells),
  ];
}

function card(value, sub) {
  return `**${escapeMd(value || DASH)}**` + (sub ? `<br>${escapeMd(sub)}` : '');
}

function projectSection(p) {
  const pr = obj(p);
  const modules = arr(pr.modules);
  const count = pr.moduleCount || 0;
  const body = [];
  if (!count) body.push('No module data.');
  else {
    const packs = arr(pr.packagings).map(x => `${x.count} ${escapeMd(x.packaging)}`).join(', ');
    body.push(`${pr.gav ? `${escapeMd(pr.gav)} ${DASH} ` : ''}${count} module${count === 1 ? '' : 's'}${packs ? `, packagings = ${packs}` : ''}. Listed in reactor build order.`, '');
    modules.forEach((mod, i) => body.push(`${i + 1}. ${escapeMd(mod.name)} \`${code(mod.packaging)}\``));
    if (count > modules.length) body.push(`${modules.length + 1}. … and ${count - modules.length} more module${count - modules.length === 1 ? '' : 's'}`);
  }
  return details('Project', count ? `${count} module${count === 1 ? '' : 's'}` : null, body);
}

/** The module Gantt as a Mermaid gantt chart, then the machine CPU / memory figures. */
function timelineSection(t) {
  const tl = obj(t);
  const items = arr(tl.items);
  const count = tl.moduleCount || 0;
  const badge = count ? `${count} module${count === 1 ? '' : 's'}` : null;
  if (!items.length && !tl.cpu && !tl.memory) return details('Build timeline, CPU and memory usage', badge, ['No timeline data.']);
  const body = ['One bar per reactor module, from its build start to its build end (time since session start); bars overlap only where modules built in parallel. Below it, the machine-wide CPU and memory usage over the same window (100% = every core busy). The full mvn-lens report adds the per-phase breakdown and the per-JVM curves in its Timeline tab.', ''];
  if (items.length) {
    body.push(...ganttChart(items, tl.xMax), '');
    if (count > items.length) body.push(`… ${count - items.length} more module${count - items.length === 1 ? '' : 's'}: the chart shows the first ${items.length} to start.`, '');
  }
  if (tl.cpu) body.push(`**Machine CPU usage** ${DOT} average ${fmtPct(tl.cpu.avg)}, maximum ${fmtPct(tl.cpu.max)}  `);
  if (tl.memory) {
    const mem = tl.memory;
    const total = mem.totalBytes ? ` of ${fmtBytes(mem.totalBytes)} (${fmtPct(mem.peakBytes / mem.totalBytes * 100)})` : '';
    body.push(`**Machine memory usage** ${DOT} peak ${fmtBytes(mem.peakBytes)}${total}, average ${fmtBytes(mem.avgBytes)}  `);
  }
  return details('Build timeline, CPU and memory usage', badge, body);
}

/** A horizontal bar chart as a table: label, duration, a bar proportional to the longest. */
function barSection(title, column, data, noun, intro) {
  const d = obj(data);
  const items = arr(d.items);
  const total = d.total || 0;
  const badge = total ? `${total} ${noun}${total === 1 ? '' : 's'}` : null;
  if (!items.length) return details(title, badge, ['No timing data.']);
  const max = Math.max(...items.map(it => it.ms));
  const body = [intro, '', `| ${column} | Time | |`, '|---|---:|---|'];
  for (const it of items) body.push(row([escapeMd(it.label), fmtMs(it.ms), bar(it.ms, max)]));
  if (total > items.length) body.push(row([`… ${total - items.length} more ${noun}${total - items.length === 1 ? '' : 's'}`, '', '']));
  return details(title, badge, body);
}

function issuesSection(i) {
  const is = obj(i);
  const count = is.count || 0;
  if (!count) return details('Issues', null, ['No build issues recorded. Failed goals, projects, and forks would appear here.']);
  const sev = [];
  if (is.fatal) sev.push(`${is.fatal} fatal`);
  if (is.errors) sev.push(`${is.errors} error${is.errors === 1 ? '' : 's'}`);
  if (is.warnings) sev.push(`${is.warnings} warning${is.warnings === 1 ? '' : 's'}`);
  const body = [`**${count} issue${count === 1 ? '' : 's'} recorded**${sev.length ? ` ${DOT} ${sev.join(` ${DOT} `)}` : ''}`, ''];
  for (const it of arr(is.items)) {
    const icon = it.severity === 'WARNING' ? '⚠️' : '❌';
    let line = `- ${icon} **${escapeMd(it.severity)}** ${DOT} ${escapeMd(it.source)}`;
    if (it.coord) line += ` ${DOT} ${escapeMd(it.coord)}`;
    line += ` ${DASH} ${escapeMd(it.message)}`;
    if (it.exceptionType && it.exceptionType !== it.message) line += ` \`${code(it.exceptionType)}\``;
    body.push(line);
  }
  const more = count - arr(is.items).length;
  if (more > 0) body.push(`- … ${more} more issue${more === 1 ? '' : 's'} (see the report)`);
  return details('Issues', `${count} issue${count === 1 ? '' : 's'}`, body);
}

function warningsSection(w) {
  const ws = obj(w);
  const count = ws.count || 0;
  if (!count) return details('Warnings', null, ['No warnings.']);
  const body = arr(ws.items).map(t => `- ${escapeMd(t)}`);
  const more = count - arr(ws.items).length;
  if (more > 0) body.push(`- … ${more} more warning${more === 1 ? '' : 's'} (see the report)`);
  return details('Warnings', String(count), body);
}

// ---------------------------------------------------------------------------
// Markdown pieces
// ---------------------------------------------------------------------------

/**
 * A section: a <details> block that starts open, so the whole summary shows
 * without a click and a reader can still fold what they are done with. GitHub
 * renders the Markdown inside it as long as a blank line separates it from
 * the HTML tags — so the body sits between two blank lines. The <summary> is
 * raw HTML, not Markdown: `title` and `badge` are constants and counts here,
 * and HTML-escaped regardless.
 */
function details(title, badge, bodyLines) {
  return [
    '<details open>',
    `<summary><b>${escapeHtml(title)}</b>${badge ? ` ${DOT} ${escapeHtml(badge)}` : ''}</summary>`,
    '',
    ...bodyLines,
    '',
    '</details>',
    '',
  ];
}

/** The Tests pane's two lists: every failed test (status and duration), then the slowest tests, ranked. Open: after a build these are what one looks for. */
function testsSection(t) {
  const ts = obj(t);
  const failed = obj(ts.failed);
  const slowest = obj(ts.slowest);
  const failedItems = arr(failed.items);
  const slowItems = arr(slowest.items);
  const nFailed = num(failed.count) || 0;
  if (!nFailed && !slowItems.length) return details('Tests', null, ['No test data.']);
  const badge = [nFailed ? `${nFailed} failed` : 'no failure', slowItems.length ? `${slowItems.length} slowest` : null].filter(Boolean).join(` ${DOT} `);
  const body = [];
  if (nFailed) {
    body.push(`**${nFailed} failed test${nFailed === 1 ? '' : 's'}** ${DOT} every failure of the build, whatever its duration`, '');
    body.push('| Test | Module | Framework | Duration | Status |', '|---|---|---|---:|---|');
    for (const it of failedItems) body.push(row([testCell(it), escapeMd(it.module || DASH), escapeMd(it.framework || DASH), fmtMs(it.durationMs), `❌ ${escapeMd(it.status || 'FAILED')}`]));
    if (nFailed > failedItems.length) body.push(row([`… ${nFailed - failedItems.length} more`, '', '', '', '']));
    body.push('');
  } else {
    body.push('No failed test.', '');
  }
  if (slowItems.length) {
    body.push(`**${slowItems.length} slowest test${slowItems.length === 1 ? '' : 's'}** ${DOT} mvn-lens ranks up to ${MAX_SLOWEST_TESTS} per test framework; failures are listed above in full, so a fast failing test is not here`, '');
    body.push('| # | Test | Module | Framework | Duration |', '|---:|---|---|---|---:|');
    slowItems.forEach((it, i) => body.push(row([String(i + 1), testCell(it), escapeMd(it.module || DASH), escapeMd(it.framework || DASH), fmtMs(it.durationMs)])));
  }
  return details('Tests', badge, body);
}
/** "**Class**<br>#method", as on the Slowest test card. */
function testCell(it) {
  const cls = it.className || it.name || '?';
  return it.method ? `**${escapeMd(cls)}**<br>#${escapeMd(it.method)}` : `**${escapeMd(cls)}**`;
}

function row(cells) { return '| ' + cells.join(' | ') + ' |'; }

/** A bar proportional to `max`, at least one block for anything positive. */
function bar(ms, max) {
  if (!(ms > 0) || !(max > 0)) return '';
  return BLOCK.repeat(Math.max(1, Math.round(ms / max * BAR_WIDTH)));
}

/**
 * The module Gantt as a Mermaid gantt chart (GitHub draws Mermaid fences in
 * job summaries): one task per module, from its build start to its build end,
 * so bars are as long as the modules took and overlap only where modules
 * really built in parallel. Times are clock times of "today" (dateFormat
 * HH:mm:ss.SSS) rather than epoch stamps: Mermaid formats the axis in the
 * viewer's local time, and only a time of day reads 00:00 … in every zone.
 * The axis shows minutes and seconds (hours too past an hour) with a tick
 * spacing giving at most MAX_TICKS ticks. Each name carries the module's
 * duration: a 16 ms module in a 90 s build is a bar too thin to see.
 */
function ganttChart(items, xMax) {
  const spanMs = Math.max(0, Math.round((num(xMax) || 0) * 1000));
  const lines = [
    '```mermaid', GANTT_INIT, 'gantt',
    '    dateFormat HH:mm:ss.SSS',
    `    axisFormat ${spanMs >= HOUR_MS ? '%H:%M:%S' : '%M:%S'}`,
    `    tickInterval ${tickInterval(spanMs)}`,
    '    todayMarker off',
    '    section Modules',
  ];
  items.forEach((it, i) => {
    const start = Math.max(0, Math.round((num(it.startSec) || 0) * 1000));
    const end = Math.max(start + 1, Math.round((num(it.endSec) || 0) * 1000));
    const duration = num(it.durationMs) !== null ? it.durationMs : end - start;
    lines.push(`    ${ganttText(`${it.label} (${fmtMs(duration)})`)} :m${i + 1}, ${clock(start)}, ${clock(end)}`);
  });
  lines.push('```');
  return lines;
}
function tickInterval(spanMs) {
  for (const [n, unit] of GANTT_TICKS) if (spanMs / (n * UNIT_MS[unit]) <= MAX_TICKS) return `${n}${unit}`;
  return '12hour';
}
/** A time of day, HH:mm:ss.SSS, of a millisecond offset (clamped to one day). */
function clock(ms) {
  const t = Math.min(Math.max(0, ms), DAY_MS - 1);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(Math.floor(t / HOUR_MS), 2)}:${pad(Math.floor(t % HOUR_MS / 60000), 2)}:${pad(Math.floor(t % 60000 / 1000), 2)}.${pad(t % 1000, 3)}`;
}
/**
 * A task name Mermaid's gantt grammar takes as a name: ":" ends the name, "#"
 * and ";" end a statement in older grammars, "%%" opens a comment, a backtick
 * run could close the Markdown fence, and a leading keyword would be read as
 * that statement.
 */
function ganttText(s) {
  const t = String(s).replace(/[:#;%`]/g, ' ').replace(/\s+/g, ' ').trim() || '?';
  return GANTT_KEYWORDS.test(t) ? `${DOT} ${t}` : t;
}

function fmtPct(v) {
  const n = num(v);
  return n === null ? DASH : `${n.toFixed(1)}%`;
}

/** Text for a code span: no backticks, no line breaks. */
function code(v) { return String(v === undefined || v === null ? '' : v).replace(/[`\r\n]/g, ''); }

function escapeHtml(v) {
  return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isObj(v) ? v : {}; }
function arr(v) { return Array.isArray(v) ? v : []; }

/** A finite number, else null (strings are not numbers here: the model is JSON the renderer wrote as numbers). */
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** A trimmed, non-empty string (numbers are accepted, objects are not), else null. */
function str(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A short label from the model: one line, at most MAX_LABEL characters. */
function label(v) {
  const s = str(v);
  return s ? truncate(s.replace(/\s+/g, ' '), MAX_LABEL) : null;
}

/** A message from the model: one line, at most MAX_MESSAGE characters. */
function message(v) {
  const s = str(v);
  return s ? truncate(s.replace(/\s+/g, ' '), MAX_MESSAGE) : '(no message)';
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

module.exports = {
  overviewOf, renderOverview,
  machineCpuSummary, prepareCpuSeries, machineMemorySeries, slowestTestOf, issueCoord,
  MAX_PROJECT_MODULES, MAX_BAR_ROWS, MAX_TIMELINE_ROWS, MAX_ISSUES, MAX_WARNINGS, MAX_LABEL, MAX_MESSAGE, MAX_FAILED_TESTS, MAX_SLOWEST_TESTS,
  GANTT_INIT,
};
