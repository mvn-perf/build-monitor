/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Shared test helpers. Other test files may APPEND new exported functions
 * here; existing ones are not edited (several agents share this file).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const FIXTURES = path.join(__dirname, 'fixtures');

/** A fresh temporary directory (under RUNNER_TEMP on a runner, os.tmpdir() otherwise). */
function tmpDir(prefix) {
  const base = process.env.RUNNER_TEMP && fs.existsSync(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : os.tmpdir();
  return fs.mkdtempSync(path.join(base, (prefix || 'bm') + '-'));
}

/** What a real mvn-lens renderer carries before the data block (the pako banner) and after it (the gzip decoder). */
const PAKO_BANNER = '/*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT) */';
const PAKO_SCRIPT = `<script>${PAKO_BANNER}\n(function(){window.pako={ungzip:function(b,o){return "";}};})();</script>`;
const DECODER_SCRIPT = '<script>/* mvn-lens dashboard bootstrap: reads the embedded JSON */\n'
  + 'var el=document.getElementById("mvnlens-data");var raw=el?el.textContent:"";var text=raw;\n'
  + 'if(raw.indexOf("gzip:")===0){var bytes=Uint8Array.from(atob(raw.slice(5)),function(c){return c.charCodeAt(0)});'
  + 'text=window.pako ? window.pako.ungzip(bytes, { to: "string" }) : "";}\n'
  + 'window.MVNLENS_MODEL=JSON.parse(text||"null");</script>';

/**
 * A small but real-shaped mvn-lens report: the template markup around a model.
 * opts: { gzip: embed as "gzip:"+base64, pako: include the pako banner before the
 * block and the gzip decoder after it (so compressReportHtml applies), id: the
 * data block id (default "mvnlens-data"; "mvnflight-data" is the legacy id) }.
 */
function fakeReportHtml(model, opts) {
  const o = opts || {};
  const json = JSON.stringify(model).replace(/<\/script/gi, m => '<\\' + m.slice(1));   // case-preserving, like the renderer
  const payload = o.gzip ? 'gzip:' + zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64') : json;
  const head = o.pako ? PAKO_SCRIPT + '\n' : '';
  const tail = o.pako ? DECODER_SCRIPT : '<script>console.log("dashboard")</script>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>mvn-lens</title></head><body>
<div id="app"></div>
${head}<script id="${o.id || 'mvnlens-data'}" type="application/json">${payload}</script>
${tail}
</body></html>`;
}

/** A fresh copy of the small fixture model (test/fixtures/model-small.json). */
function fixtureModel() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'model-small.json'), 'utf8'));
}

function isoAt(baseMs, offsetSec) { return new Date(baseMs + offsetSec * 1000).toISOString(); }

const DEFAULT_STEPS = (mavenSec) => [
  { number: 1, name: 'Set up job', start: 2, end: 4 },
  { number: 2, name: 'Run actions/checkout@v4', start: 4, end: 6 },
  { number: 3, name: 'Build with Maven', start: 6, end: 6 + mavenSec },
  { number: 4, name: 'Publish mvn-lens report', start: 6 + mavenSec, end: 8 + mavenSec },
  { number: 9, name: 'Complete job', start: 8 + mavenSec, end: 9 + mavenSec },
];

/**
 * Fabricates an API-shaped workflow run (GET /actions/runs/{id}) with its jobs
 * (as `.jobs`, the shape of GET …/runs/{id}/jobs) starting at `p.baseMs`.
 * One job by default (p.jobId / p.jobName / p.runnerName / p.steps), or several
 * with p.jobs = [{ id, name, runnerName, steps, status, conclusion, labels }].
 * Step specs are { number, name, start, end (seconds after baseMs), conclusion }.
 */
function fakeRun(p) {
  const base = p.baseMs;
  const repo = p.repository || 'acme/widgets';
  const mavenSec = p.mavenSec || 60;
  const status = p.status || 'completed';
  const conclusion = status === 'completed' ? (p.conclusion || 'success') : null;
  const specs = p.jobs || [{ id: p.jobId || p.id * 10, name: p.jobName || 'build', runnerName: p.runnerName, steps: p.steps, status, conclusion, labels: p.labels }];
  const jobs = specs.map((j, i) => {
    const steps = j.steps || DEFAULT_STEPS(mavenSec);
    const jstatus = j.status || status;
    const jconc = jstatus === 'completed' ? (j.conclusion || conclusion || 'success') : null;
    const end = Math.max(...steps.map(s => s.end)) + 1;
    const jobId = j.id || (p.id * 10 + i);
    return {
      id: jobId, run_id: p.id, run_attempt: p.attempt || 1, name: j.name || 'build', status: jstatus, conclusion: jconc,
      created_at: isoAt(base, 0), started_at: isoAt(base, j.start === undefined ? 2 : j.start), completed_at: jstatus === 'completed' ? isoAt(base, end) : null,
      runner_name: j.runnerName || `GitHub Actions ${1000 + p.id + i}`, runner_group_name: 'GitHub Actions', labels: j.labels || ['ubuntu-latest'],
      html_url: `https://github.com/${repo}/actions/runs/${p.id}/job/${jobId}`, workflow_name: p.workflowName || 'CI', head_branch: p.branch || 'main',
      steps: steps.map(s => ({
        number: s.number, name: s.name, status: s.status || 'completed', conclusion: s.status && s.status !== 'completed' ? null : (s.conclusion || 'success'),
        started_at: isoAt(base, s.start), completed_at: s.status && s.status !== 'completed' ? null : isoAt(base, s.end),
      })),
    };
  });
  const end = Math.max(...jobs.map(j => j.completed_at ? (Date.parse(j.completed_at) - base) / 1000 : 0), 0);
  return {
    id: p.id, name: p.workflowName || 'CI', workflow_id: p.workflowId || 1, path: p.workflowPath || '.github/workflows/ci.yml',
    run_number: p.runNumber || p.id, run_attempt: p.attempt || 1, event: p.event || 'push', status, conclusion,
    head_branch: p.branch || 'main', head_sha: p.sha || ('deadbeef' + p.id).padEnd(40, '0'), display_title: p.title || `commit ${p.id}`,
    head_repository: { full_name: p.headRepository || repo },
    actor: { login: p.actor || 'octocat' }, triggering_actor: { login: p.actor || 'octocat' },
    html_url: `https://github.com/${repo}/actions/runs/${p.id}`,
    created_at: isoAt(base, 0), updated_at: isoAt(base, end + 5), run_started_at: isoAt(base, 1),
    jobs,
  };
}

/**
 * Runs `fn` with process.env overridden by `vars` (null/undefined deletes a
 * variable) and restores the previous values afterwards, also when fn is async
 * or throws. Returns fn's result.
 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined || vars[k] === null) delete process.env[k];
    else process.env[k] = String(vars[k]);
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Parses a GITHUB_OUTPUT file (heredoc records and name=value lines) into { name: value }. */
function parseOutputs(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = /^([^=<]+)<<(\S+)$/.exec(line);
    if (m) {
      const vals = [];
      i++;
      while (i < lines.length && lines[i] !== m[2]) { vals.push(lines[i]); i++; }
      out[m[1]] = vals.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Temporary GITHUB_OUTPUT / GITHUB_STEP_SUMMARY files: `env` to pass to withEnv
 * (or a child process), `outputs()` the parsed outputs, `summary()` the summary
 * markdown, `reset()` empties both files.
 */
function captureOutputs(dir) {
  const d = dir || tmpDir('outputs');
  const outFile = path.join(d, 'github-output.txt');
  const sumFile = path.join(d, 'step-summary.md');
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(sumFile, '');
  return {
    dir: d,
    env: { GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
    outputs: () => parseOutputs(fs.readFileSync(outFile, 'utf8')),
    summary: () => fs.readFileSync(sumFile, 'utf8'),
    reset: () => { fs.writeFileSync(outFile, ''); fs.writeFileSync(sumFile, ''); },
  };
}

module.exports = { FIXTURES, PAKO_BANNER, tmpDir, fakeReportHtml, fixtureModel, fakeRun, isoAt, withEnv, captureOutputs, parseOutputs };
