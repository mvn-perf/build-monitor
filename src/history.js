/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, sanitizeName } = require('./util');

const SCHEMA_VERSION = 1;

/**
 * history.json — the monitoring page's persistent dataset (data/history.json).
 *
 * {
 *   schemaVersion: 1,
 *   repository: "owner/repo", repositoryUrl, serverUrl, defaultBranch, siteUrl,
 *   generatedAt: ISO,
 *   stats: { reportsCount, reportsBytes },   // over every mvnLens entry (recomputed by the processor)
 *   workflows: { "<id>": { id, name, path, state } },
 *   runs: [ RunRecord … ]           // newest first
 * }
 *
 * RunRecord {
 *   id, workflowId, workflowName, workflowPath, runNumber, attempt, event,
 *   status, conclusion, branch, sha, headRepository, title, actor, htmlUrl,
 *   createdAt, startedAt, completedAt, updatedAt   (ISO strings)
 *   durationMs, queueMs,
 *   jobs: [ { id, name, status, conclusion, startedAt, completedAt, durationMs,
 *             runnerName, runnerGroup, labels, htmlUrl,
 *             steps: [ { number, name, status, conclusion, startedAt, completedAt, durationMs } ] } ],
 *   mvnLens: [ MvnLensEntry … ]
 * }
 *
 * MvnLensEntry {
 *   key ("j<jobId>-s<step>[-label]" or "<jobKey>-<rand6>[-label]"), dir ("reports/<runId>/<key>"),
 *   path (the primary report: "<dir>/report.html"),
 *   jobId, jobName, jobUrl, stepNumber, stepName, label, attempt, attribution, superseded,
 *   collectedAt, bytes (all report files),
 *   reports: [ { name, label, path (site-relative), summary (no modules), summarySource, bytes } ]
 * }
 */

function emptyHistory(repository) {
  return {
    schemaVersion: SCHEMA_VERSION, repository: repository || null, repositoryUrl: null, serverUrl: null, defaultBranch: null, siteUrl: null,
    generatedAt: null, stats: { reportsCount: 0, reportsBytes: 0 }, workflows: {}, runs: [],
  };
}

function loadHistory(file, repository) {
  if (!file || !fs.existsSync(file)) return emptyHistory(repository);
  return parseHistory(fs.readFileSync(file, 'utf8'), repository);
}

/** Parses history.json text (from a file or a git blob). Invalid JSON is an error: never silently start over. */
function parseHistory(text, repository) {
  const raw = JSON.parse(String(text));
  return normalizeHistory(raw, repository);
}

function normalizeHistory(raw, repository) {
  const h = emptyHistory(repository);
  if (!raw || typeof raw !== 'object') return h;
  if (raw.schemaVersion && raw.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`history.json schema ${raw.schemaVersion} is newer than this action supports (${SCHEMA_VERSION}); upgrade the action`);
  }
  if (raw.repository && repository && raw.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`history.json belongs to ${raw.repository}, not ${repository}; use a different branch/site-dir`);
  }
  h.repository = raw.repository || repository || null;
  h.repositoryUrl = raw.repositoryUrl || null;
  h.serverUrl = raw.serverUrl || null;
  h.defaultBranch = raw.defaultBranch || null;
  h.siteUrl = raw.siteUrl || null;
  h.generatedAt = raw.generatedAt || null;
  if (raw.stats && typeof raw.stats === 'object') {
    h.stats = { reportsCount: Number(raw.stats.reportsCount) || 0, reportsBytes: Number(raw.stats.reportsBytes) || 0 };
  }
  h.workflows = raw.workflows && typeof raw.workflows === 'object' ? raw.workflows : {};
  h.runs = Array.isArray(raw.runs) ? raw.runs.filter(r => r && typeof r.id === 'number') : [];
  for (const r of h.runs) {
    if (!Array.isArray(r.jobs)) r.jobs = [];
    r.mvnLens = Array.isArray(r.mvnLens) ? r.mvnLens.filter(e => e && typeof e === 'object') : [];
    for (const e of r.mvnLens) {
      e.reports = Array.isArray(e.reports) ? e.reports.filter(x => x && typeof x === 'object') : [];
      // Report paths are the only history values that become URLs/files: they must
      // look exactly like what the processor produces.
      if (e.dir !== undefined && e.dir !== null && !isValidReportDir(e.dir)) e.dir = null;
      for (const rep of e.reports) {
        if (rep.path !== null && rep.path !== undefined && !isValidReportPath(rep.path)) rep.path = null;
      }
    }
  }
  sortRuns(h);
  return h;
}

const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}';
const REPORT_DIR_RE = new RegExp(`^reports/\\d{1,20}/${SEGMENT}$`);
const REPORT_PATH_RE = new RegExp(`^reports/\\d{1,20}/${SEGMENT}/${SEGMENT}$`);

/** `reports/<runId>/<key>` with safe characters only. */
function isValidReportDir(p) {
  return typeof p === 'string' && REPORT_DIR_RE.test(p) && !p.split('/').some(seg => seg === '..' || seg === '.');
}
/** `reports/<runId>/<key>/<file>` with safe characters only — no `..`, no absolute paths, no separators inside names. */
function isValidReportPath(p) {
  return typeof p === 'string' && REPORT_PATH_RE.test(p) && !p.split('/').some(seg => seg === '..' || seg === '.');
}
/** A single report-directory key (what the report step produces). */
function isValidKey(k) {
  return typeof k === 'string' && new RegExp(`^${SEGMENT}$`).test(k) && k !== '.' && k !== '..';
}

function serializeHistory(history) {
  return JSON.stringify(history) + '\n';
}

function saveHistory(file, history) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, serializeHistory(history));
}

function sortRuns(history) {
  history.runs.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.id - a.id);
}

function findRun(history, id) { return history.runs.find(r => r.id === id) || null; }

function upsertRun(history, run) {
  const i = history.runs.findIndex(r => r.id === run.id);
  if (i >= 0) history.runs[i] = run; else history.runs.push(run);
}

/**
 * Keeps at most `maxRunsPerWorkflow` run records per workflow (newest first).
 * Report files are never touched — retention of files is deliberately not
 * managed by this action. Returns the dropped records.
 */
function trimRuns(history, maxRunsPerWorkflow) {
  const max = Number(maxRunsPerWorkflow) || 0;
  if (max <= 0) return [];
  sortRuns(history);
  const perWorkflow = new Map();
  const dropped = [];
  const kept = [];
  for (const run of history.runs) {
    const key = String(run.workflowId);
    const n = (perWorkflow.get(key) || 0) + 1;
    perWorkflow.set(key, n);
    if (n > max) dropped.push(run); else kept.push(run);
  }
  history.runs = kept;
  return dropped;
}

/** Stable identity of a Maven build across runs: workflow + job + step + label. */
function mavenSeriesKey(workflowPath, jobName, stepName, label) {
  return [workflowPath || '', jobName || '', stepName || '', label || ''].map(s => String(s)).join(' ');
}

/** Site-relative directory of one report set. */
function reportDirFor(runId, key) {
  return `reports/${runId}/${sanitizeName(key, 120)}`;
}

module.exports = {
  SCHEMA_VERSION, emptyHistory, loadHistory, parseHistory, normalizeHistory, serializeHistory, saveHistory, sortRuns,
  findRun, upsertRun, trimRuns, mavenSeriesKey, reportDirFor, isValidReportPath, isValidReportDir, isValidKey,
};
