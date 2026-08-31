#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Generates a synthetic-but-realistic monitoring site so the page can be
 * previewed without a GitHub repository: two workflows over ~60 days, matrix
 * jobs with steps, mvn-lens entries in the history schema of this action —
 * including a superseded report (attempt 2) and an unattributed one.
 *
 *   node scripts/demo.js [outDir]     (default: .tmp/demo-site with the data
 *                                      inlined AND .tmp/demo-site-fetch without
 *                                      inline data, exercising the fetch path)
 *
 * Report files: every entry gets a real report file so the in-page viewer
 * works. A big real mvn-lens report is used when one is found ($DEMO_REPORT,
 * .tmp/demo-report.html, or a sibling mvn-lens checkout with built ITs) for the
 * most recent entries (cap $DEMO_MAX_REPORTS, default 10); everything else gets
 * the small fixture report. Preview with: node scripts/serve.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { generateSite } = require('../src/site');
const { summarizeModel } = require('../src/mvnlens');
const { emptyHistory, reportDirFor } = require('../src/history');
const { ensureDir, rmrf } = require('../src/util');

const ROOT = path.join(__dirname, '..');
const argDir = process.argv[2];
const targets = argDir
  ? [{ dir: path.resolve(argDir), inline: true }]
  : [
    { dir: path.join(ROOT, '.tmp', 'demo-site'), inline: true },
    { dir: path.join(ROOT, '.tmp', 'demo-site-fetch'), inline: false },
  ];

// Deterministic pseudo-random so the demo is reproducible.
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function jitter(base, pct) { return Math.round(base * (1 + (rnd() * 2 - 1) * pct)); }
function iso(ms) { return new Date(ms).toISOString(); }
function sha() { let s = ''; for (let i = 0; i < 40; i++) s += '0123456789abcdef'[Math.floor(rnd() * 16)]; return s; }

const FIXTURE_REPORT = path.join(ROOT, 'test', 'fixtures', 'sample-report', 'report.html');
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'model-small.json'), 'utf8'));
const realReport = findRealReport();
const MAX_REAL = Number(process.env.DEMO_MAX_REPORTS || 10);
const REPO = 'acme/widgets';
const SERVER = 'https://github.com';

const DAY = 86400000;
const now = Date.now();
let runId = 5000000000;
let jobId = 90000000000;
let ciNumber = 300;
let nightlyNumber = 60;
const branches = ['main', 'main', 'main', 'feature/faster-tests', 'renovate/junit', 'main'];
const actors = ['octocat', 'hubot', 'monalisa'];
const titles = ['Bump surefire to 3.5.2', 'Parallelise the reactor with -T4', 'Fix flaky LibATest', 'Cache the Maven repository', 'Merge pull request #42 from feature/faster-tests', 'Update dependencies', 'Refactor GreeterTest', 'Enable mvnd on CI'];

// files to write into every site dir: sitePath -> source file
const reportFiles = new Map();
let realCopies = 0;
let reportsCount = 0;
let reportsBytes = 0;

const history = emptyHistory(REPO);
history.repositoryUrl = `${SERVER}/${REPO}`;
history.serverUrl = SERVER;
history.defaultBranch = 'main';
history.workflows = {
  '1': { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  '2': { id: 2, name: 'Nightly perf', path: '.github/workflows/nightly.yml', state: 'active' },
  '3': { id: 3, name: 'Build monitor', path: '.github/workflows/build-monitor.yml', state: 'active' },
};

// A slow regression around day 35, fixed on day 47, to make the trend interesting.
function mavenBaseMs(dayIdx) { return dayIdx > 35 && dayIdx < 47 ? 165000 : 105000 - Math.min(20000, dayIdx * 300); }

for (let day = 60; day >= 0; day--) {
  const runsToday = day % 7 >= 5 ? (rnd() < 0.4 ? 1 : 0) : 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < runsToday; k++) {
    const created = now - day * DAY - Math.floor(rnd() * 12 * 3600000) - 3600000;
    const branch = branches[Math.floor(rnd() * branches.length)];
    const failing = rnd() < 0.12;
    const running = day === 0 && k === runsToday - 1;
    // One recent run demonstrates a re-run: attempt 2 with the attempt-1 report superseded.
    const rerun = day === 2 && k === 0;
    history.runs.push(ciRun({ created, branch, failing, running, rerun, dayIdx: 60 - day }));
  }
  if (rnd() < 0.7) history.runs.push(nightlyRun({ created: now - day * DAY - 2 * 3600000, dayIdx: 60 - day }));
}
history.runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
history.generatedAt = iso(now - 120000);
history.stats = { reportsCount, reportsBytes };

for (const t of targets) {
  rmrf(t.dir);
  ensureDir(t.dir);
  for (const [sitePath, src] of reportFiles) {
    const dest = path.join(t.dir, sitePath);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
  const out = generateSite({
    history,
    siteDir: t.dir,
    inline: t.inline,
    title: process.env.DEMO_TITLE || 'Build monitor · acme/widgets (demo)',
  });
  console.log(`${t.inline ? 'inline' : 'fetch '} demo: ${out.indexFile} (index ${(out.bytes / 1024).toFixed(0)} KiB, ${history.runs.length} runs, ${reportsCount} reports, ${realCopies} real report file(s))`);
}
console.log(`Preview: node scripts/serve.js ${path.relative(process.cwd(), targets[0].dir) || '.'}`);

// ---------------------------------------------------------------------------

function ciRun(p) {
  const id = runId++;
  const number = ciNumber++;
  const attempt = p.rerun ? 2 : 1;
  const started = p.created + jitter(15000, 0.8) + (attempt > 1 ? 600000 : 0);
  const matrix = [
    { name: 'Java 25 (ubuntu-24.04)', labels: ['ubuntu-24.04'], maven: mavenBaseMs(p.dayIdx), lens: true, its: true },
    { name: 'Java 25 (windows-2025)', labels: ['windows-2025'], maven: mavenBaseMs(p.dayIdx) * 1.6, lens: true },
    { name: 'Javadoc', labels: ['ubuntu-24.04'], maven: mavenBaseMs(p.dayIdx) * 0.5, lens: true },
  ];
  const jobs = [];
  const mvnLens = [];
  let runEnd = started;
  matrix.forEach((m, i) => {
    const jid = jobId++;
    const jobStart = started + jitter(3000, 0.5) + i * 800;
    let t = jobStart;
    const steps = [];
    function step(number, name, ms, conclusion) {
      const s = { number, name, status: 'completed', conclusion: conclusion || 'success', startedAt: iso(t), completedAt: iso(t + ms), durationMs: ms };
      steps.push(s); t += ms; return s;
    }
    step(1, 'Set up job', jitter(2500, 0.4));
    step(2, 'Run actions/checkout@v4', jitter(m.labels[0].startsWith('windows') ? 9000 : 2000, 0.4));
    step(3, 'Set up JDK', jitter(4000, 0.5));
    const mavenMs = jitter(m.maven, 0.12);
    const failedHere = p.failing && i === Math.floor(rnd() * matrix.length);
    const build = step(4, 'Build with Maven', failedHere ? Math.round(mavenMs * 0.6) : mavenMs, failedHere ? 'failure' : 'success');
    if (m.lens) {
      const summary = mavenSummary({ startedAt: Date.parse(build.startedAt) + jitter(1500, 0.3), totalMs: build.durationMs - jitter(2500, 0.3), status: failedHere ? 'FAILED' : 'OK', threads: p.dayIdx > 25 ? 4 : 1, dayIdx: p.dayIdx, jdk: i === 2 ? '21.0.4' : '25' });
      mvnLens.push(entry({ runId: id, jobId: jid, jobName: m.name, jobUrl: jobUrlOf(id, jid), step: build, summary, label: null, attempt, recent: p.dayIdx >= 55 }));
      step(5, 'Publish mvn-lens report', jitter(1800, 0.3));
    }
    if (m.its && !failedHere) {
      const its = step(6, 'Integration tests', jitter(140000, 0.15));
      const summary = mavenSummary({ startedAt: Date.parse(its.startedAt) + 800, totalMs: its.durationMs - 1500, status: 'OK', threads: 1, dayIdx: p.dayIdx, goals: ['-Prun-its', 'verify'], jdk: '25' });
      mvnLens.push(entry({ runId: id, jobId: jid, jobName: m.name, jobUrl: jobUrlOf(id, jid), step: its, summary, label: 'integration tests', attempt, recent: p.dayIdx >= 55 }));
      step(7, 'Publish mvn-lens report (ITs)', jitter(1800, 0.3));
    }
    step(12, 'Post Set up JDK', jitter(1200, 0.4));
    step(13, 'Post Run actions/checkout@v4', 400);
    step(14, 'Complete job', 300);
    const jobEnd = t;
    runEnd = Math.max(runEnd, jobEnd);
    jobs.push({ id: jid, name: m.name, status: 'completed', conclusion: failedHere ? 'failure' : 'success', startedAt: iso(jobStart), completedAt: iso(jobEnd), durationMs: jobEnd - jobStart, runnerName: 'GitHub Actions ' + (1000 + i), runnerGroup: 'GitHub Actions', labels: m.labels, htmlUrl: jobUrlOf(id, jid), steps });
  });
  if (p.rerun) {
    // The report of attempt 1 is still on the site: same job name and step, lower attempt, superseded.
    const staleJobId = jobId++;
    const build = jobs[0].steps[3];
    const summary = mavenSummary({ startedAt: Date.parse(build.startedAt) - 700000, totalMs: Math.round(build.durationMs * 1.1), status: 'FAILED', threads: 4, dayIdx: p.dayIdx, jdk: '25' });
    mvnLens.push(entry({ runId: id, jobId: staleJobId, jobName: jobs[0].name, jobUrl: jobUrlOf(id, staleJobId), step: build, summary, label: null, attempt: 1, attribution: 'stale-job', superseded: true, recent: false }));
  }
  if (p.dayIdx === 58 && !p.running) {
    // An unattributed report: its meta could not be matched to any job of the run.
    const summary = mavenSummary({ startedAt: started + 20000, totalMs: 95000, status: 'OK', threads: 1, dayIdx: p.dayIdx, jdk: '25' });
    mvnLens.push(entry({ runId: id, jobId: null, jobName: null, jobUrl: null, step: null, summary, label: 'sidecar build', attempt, attribution: 'none', recent: false }));
  }
  let status = 'completed';
  let conclusion = p.failing ? 'failure' : 'success';
  if (p.running) {
    status = 'in_progress'; conclusion = null;
    const j = jobs[jobs.length - 1];
    j.status = 'in_progress'; j.conclusion = null; j.completedAt = null; j.durationMs = null;
    j.steps = j.steps.slice(0, 4); j.steps[3].status = 'in_progress'; j.steps[3].conclusion = null; j.steps[3].completedAt = null; j.steps[3].durationMs = null;
    // The running job has not published its report yet: drop the entry and everything registered for it.
    const idx = mvnLens.findIndex(e => e.jobId === j.id);
    if (idx >= 0) unregister(mvnLens.splice(idx, 1)[0]);
  }
  return {
    id, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: number, attempt, event: p.branch === 'main' ? 'push' : 'pull_request',
    status, conclusion, branch: p.branch, sha: sha(), headRepository: REPO, title: titles[Math.floor(rnd() * titles.length)], actor: actors[Math.floor(rnd() * actors.length)],
    htmlUrl: `${SERVER}/${REPO}/actions/runs/${id}`, createdAt: iso(p.created), startedAt: iso(started), completedAt: p.running ? null : iso(runEnd), updatedAt: iso(runEnd + 3000),
    durationMs: p.running ? null : runEnd - started, queueMs: started - p.created, jobs, mvnLens,
  };
}

function nightlyRun(p) {
  const id = runId++;
  const number = nightlyNumber++;
  const started = p.created + jitter(20000, 0.5);
  const jobs = [];
  const mvnLens = [];
  let runEnd = started;
  const scenarios = [['default · T1', 1, 1.0], ['default · T4', 4, 0.55], ['smart · T4', 4, 0.48], ['mvnd', 4, 0.42]];
  scenarios.forEach((sc, i) => {
    const jid = jobId++;
    const jobStart = started + i * 5000;
    let t = jobStart;
    const steps = [];
    function step(number, name, ms, conclusion) { const s = { number, name, status: 'completed', conclusion: conclusion || 'success', startedAt: iso(t), completedAt: iso(t + ms), durationMs: ms }; steps.push(s); t += ms; return s; }
    step(1, 'Set up job', jitter(2500, 0.4));
    step(2, 'Run actions/checkout@v4', jitter(2000, 0.4));
    step(3, 'Warm the local repository (untimed)', jitter(25000, 0.2));
    const mavenMs = jitter(380000 * sc[2], 0.08);
    const build = step(4, 'Run profiled build', mavenMs);
    const summary = mavenSummary({ startedAt: Date.parse(build.startedAt) + 1200, totalMs: mavenMs - 2500, status: 'OK', threads: sc[1], dayIdx: p.dayIdx, mvnd: sc[0] === 'mvnd', jdk: '25' });
    mvnLens.push(entry({ runId: id, jobId: jid, jobName: sc[0], jobUrl: jobUrlOf(id, jid), step: build, summary, label: null, attempt: 1, recent: p.dayIdx >= 58 }));
    step(5, 'Publish mvn-lens report', jitter(1800, 0.3));
    step(9, 'Complete job', 300);
    runEnd = Math.max(runEnd, t);
    jobs.push({ id: jid, name: sc[0], status: 'completed', conclusion: 'success', startedAt: iso(jobStart), completedAt: iso(t), durationMs: t - jobStart, runnerName: 'GitHub Actions ' + (2000 + i), runnerGroup: 'GitHub Actions', labels: ['ubuntu-24.04'], htmlUrl: jobUrlOf(id, jid), steps });
  });
  return {
    id, workflowId: 2, workflowName: 'Nightly perf', workflowPath: '.github/workflows/nightly.yml', runNumber: number, attempt: 1, event: 'schedule', status: 'completed', conclusion: 'success',
    branch: 'main', sha: sha(), headRepository: REPO, title: 'Nightly perf', actor: 'github-actions', htmlUrl: `${SERVER}/${REPO}/actions/runs/${id}`,
    createdAt: iso(p.created), startedAt: iso(started), completedAt: iso(runEnd), updatedAt: iso(runEnd + 3000), durationMs: runEnd - started, queueMs: started - p.created, jobs, mvnLens,
  };
}

function jobUrlOf(id, jid) { return `${SERVER}/${REPO}/actions/runs/${id}/job/${jid}`; }

function mavenSummary(p) {
  const m = JSON.parse(JSON.stringify(model));
  m.session.startedAt = p.startedAt;
  m.session.endedAt = p.startedAt + p.totalMs;
  m.session.totalMs = p.totalMs;
  m.session.wallMs = Math.round(p.totalMs * 0.96);
  m.session.cpuMs = Math.round(p.totalMs * (p.threads > 1 ? 1.9 : 0.85));
  m.session.gcMs = jitter(p.totalMs * 0.03, 0.4);
  m.session.status = p.status;
  m.session.threads = p.threads;
  m.session.builderId = p.threads > 1 ? 'multithreaded' : 'singlethreaded';
  m.session.goals = p.goals || ['clean', 'verify'];
  m.session.jdkVersion = p.jdk || '25';
  const jitScale = p.totalMs / 8000;
  m.jit = m.jit.map(e => Object.assign({}, e, { durationMs: Math.round(e.durationMs * jitScale * 0.6) }));
  m.repoTransferSummary.millisDownloadedThisBuild = p.dayIdx % 9 === 0 ? jitter(45000, 0.3) : jitter(1200, 0.5);
  m.repoTransferSummary.bytesDownloadedThisBuild = p.dayIdx % 9 === 0 ? jitter(90e6, 0.3) : jitter(300000, 0.5);
  m.repoTransferSummary.artifactDownloadsCount = p.dayIdx % 9 === 0 ? 312 : 3;
  m.environment.mvnd = !!p.mvnd;
  m.environment.githubActions = true;
  m.modules = m.modules.map(mod => Object.assign({}, mod, { wallMs: jitter(mod.wallMs * jitScale, 0.2) }));
  return slimSummary(summarizeModel(m));
}

/** The summary fields history.json keeps (SPEC: no modules, slim environment). */
function slimSummary(s) {
  return {
    schemaVersion: s.schemaVersion,
    goals: s.goals, threads: s.threads, builderId: s.builderId,
    mavenVersion: s.mavenVersion, jdkVersion: s.jdkVersion, status: s.status,
    startedAt: s.startedAt, endedAt: s.endedAt,
    totalMs: s.totalMs, wallMs: s.wallMs, cpuMs: s.cpuMs, gcMs: s.gcMs, gcCount: s.gcCount,
    c2Ms: s.c2Ms, jitMs: s.jitMs,
    downloadMs: s.downloadMs, downloadBytes: s.downloadBytes, downloadCount: s.downloadCount,
    moduleCount: s.moduleCount, testCount: s.testCount, testMs: s.testMs, issueCount: s.issueCount,
    environment: s.environment ? { availableProcessors: s.environment.availableProcessors, osName: s.environment.osName, mvnd: s.environment.mvnd, githubActions: s.environment.githubActions } : null,
  };
}

/** One MvnLensEntry in the history schema; registers the report file to copy. */
function entry(p) {
  const key = p.jobId ? `j${p.jobId}-s${p.step.number}` + (p.label ? '-' + p.label.replace(/[^A-Za-z0-9._-]+/g, '-') : '') : `build-${Math.floor(rnd() * 1e6)}` + (p.label ? '-' + p.label.replace(/[^A-Za-z0-9._-]+/g, '-') : '');
  const dir = reportDirFor(p.runId, key);
  const useReal = realReport && p.recent && realCopies < MAX_REAL;
  const src = useReal ? realReport : FIXTURE_REPORT;
  if (useReal) realCopies++;
  const sitePath = `${dir}/report.html`;
  reportFiles.set(sitePath, src);
  const bytes = fs.statSync(src).size;
  reportsCount++;
  reportsBytes += bytes;
  return {
    key, dir, path: sitePath,
    jobId: p.jobId || null, jobName: p.jobName || null, jobUrl: p.jobUrl || null,
    stepNumber: p.step ? p.step.number : null, stepName: p.step ? p.step.name : null,
    label: p.label || null, attempt: p.attempt || 1,
    attribution: p.attribution || (p.jobId ? 'jobId' : 'none'),
    superseded: !!p.superseded,
    collectedAt: iso(now), bytes,
    reports: [{ name: 'report.html', path: sitePath, summary: p.summary, summarySource: 'meta', bytes }],
  };
}

/** Undoes entry(): forgets the report file and the stats contribution of an entry that is not part of the history after all. */
function unregister(e) {
  for (const rep of e.reports) {
    const src = reportFiles.get(rep.path);
    if (!src) continue;
    if (src === realReport) realCopies--;
    reportFiles.delete(rep.path);
    reportsCount--;
    reportsBytes -= rep.bytes;
  }
}

/** A big real mvn-lens report to make the viewer preview realistic. */
function findRealReport() {
  const candidates = [
    process.env.DEMO_REPORT || '',
    path.join(ROOT, '.tmp', 'demo-report.html'),
  ].filter(Boolean);
  for (const f of candidates) {
    try { if (fs.existsSync(f) && fs.statSync(f).isFile()) return f; } catch (e) { /* next */ }
  }
  // A sibling mvn-lens checkout with built integration tests.
  const itRoot = path.join(ROOT, '..', 'mvn-lens', 'mvn-lens-it', 'target', 'it');
  try {
    for (const it of fs.readdirSync(itRoot)) {
      const f = path.join(itRoot, it, 'target', 'mvnlens', 'report.html');
      if (fs.existsSync(f)) return f;
    }
  } catch (e) { /* none */ }
  return null;
}
