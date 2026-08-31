/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Action inputs / outputs (no @actions/core dependency: the runner passes
// inputs as INPUT_<NAME> environment variables and reads outputs from the
// file named by $GITHUB_OUTPUT).
// ---------------------------------------------------------------------------

/**
 * Reads an action input. The runner uppercases the input name and replaces
 * spaces with underscores; hyphens are kept ("github-token" -> INPUT_GITHUB-TOKEN).
 * Composite actions must forward inputs explicitly through `env:`, and there a
 * hyphen is awkward, so INPUT_GITHUB_TOKEN is accepted as an alias.
 */
function getInput(name, opts) {
  const o = opts || {};
  const upper = name.toUpperCase().replace(/ /g, '_');
  const candidates = ['INPUT_' + upper, 'INPUT_' + upper.replace(/-/g, '_')];
  let raw;
  for (const c of candidates) {
    if (process.env[c] !== undefined && process.env[c] !== '') { raw = process.env[c]; break; }
  }
  if (raw === undefined) {
    if (o.required) throw new Error(`Input required and not supplied: ${name}`);
    return o.default === undefined ? '' : o.default;
  }
  return o.trimWhitespace === false ? raw : raw.trim();
}

function getBooleanInput(name, def) {
  const v = getInput(name, { default: def === undefined ? '' : String(def) }).toLowerCase();
  if (v === '') return !!def;
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`Input "${name}" is not a boolean: ${v}`);
}

function getIntInput(name, def, min, max) {
  const v = getInput(name, { default: String(def) });
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Input "${name}" is not an integer: ${v}`);
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** Splits a newline- or comma-separated list input. */
function parseList(value) {
  if (!value) return [];
  return String(value).split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const str = value === undefined || value === null ? '' : String(value);
  if (!file) { log(`[output] ${name}=${str}`); return; }
  const delim = 'ghadelimiter_' + Math.random().toString(36).slice(2);
  fs.appendFileSync(file, `${name}<<${delim}${os.EOL}${str}${os.EOL}${delim}${os.EOL}`);
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, markdown + os.EOL);
}

// ---------------------------------------------------------------------------
// Logging (GitHub workflow commands when running on a runner)
// ---------------------------------------------------------------------------

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function log(msg) { process.stdout.write(String(msg) + '\n'); }
function debug(msg) { if (process.env.RUNNER_DEBUG === '1' || process.env.BUILD_MONITOR_DEBUG) log('[debug] ' + msg); }
function warning(msg) { process.stdout.write(`::warning::${escapeData(msg)}\n`); }
function notice(msg) { process.stdout.write(`::notice::${escapeData(msg)}\n`); }
function error(msg) { process.stdout.write(`::error::${escapeData(msg)}\n`); }
function group(title) { process.stdout.write(`::group::${escapeData(title)}\n`); }
function endGroup() { process.stdout.write('::endgroup::\n'); }

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, obj, pretty) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, pretty ? JSON.stringify(obj, null, 2) + '\n' : JSON.stringify(obj));
}

/** Recursively copies src into dest (files are overwritten, extra dest files kept). `opts.skip(name)` excludes entries. */
function copyDir(src, dest, opts) {
  const skip = opts && opts.skip;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, opts);
    else fs.copyFileSync(s, d);
  }
}

/** True when `target` is `base` itself or a path strictly inside it (no `..` escape, same drive). */
function isWithin(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Asks the runner to mask a value in the job log (GitHub only masks the literal secret it knows). */
function addMask(value) {
  if (value && process.env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${escapeData(value)}\n`);
}

/** Lists files under dir (relative POSIX paths). */
function listFiles(dir, base) {
  const out = [];
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Minimal glob (supports `**`, `*`, `?`), relative to cwd or absolute.
 * Node 20 has no fs.glob, and the action carries no dependencies.
 */
function glob(pattern, cwd) {
  const root = cwd || process.cwd();
  const norm = pattern.replace(/\\/g, '/');
  if (!/[*?]/.test(norm)) {
    const p = path.isAbsolute(norm) ? norm : path.join(root, norm);
    return exists(p) && fs.statSync(p).isFile() ? [p] : [];
  }
  const abs = path.isAbsolute(norm);
  const parts = norm.split('/').filter((s, i) => s !== '' || i === 0);
  // Split into a literal prefix directory and the wildcard remainder.
  let i = 0;
  const prefix = [];
  while (i < parts.length && !/[*?]/.test(parts[i])) { prefix.push(parts[i]); i++; }
  const startDir = abs ? (prefix.join('/') || '/') : path.join(root, ...prefix);
  const rest = parts.slice(i);
  const re = new RegExp('^' + rest.map(seg => {
    if (seg === '**') return '(?:.*/)?';
    return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/';
  }).join('').replace(/\/$/, '') + '$');
  const results = [];
  for (const rel of listFiles(startDir)) {
    if (re.test(rel)) results.push(path.join(startDir, rel));
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Artifact- and path-safe name: keeps [A-Za-z0-9._-] (existing dashes included), collapses each run of other characters to one '-'. */
function sanitizeName(s, max) {
  const out = String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const lim = max || 120;
  return (out || 'unnamed').slice(0, lim);
}

function parseIsoMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function isoNow() { return new Date().toISOString(); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Runs `fn(item)` over items with at most `limit` in flight; results in order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.max(1, Math.min(limit, items.length)); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function toPosix(p) { return p.replace(/\\/g, '/'); }

/** Joins POSIX path segments, dropping empty ones and duplicate slashes ("" for no segments). */
function posixJoin() {
  const parts = [];
  for (const a of arguments) {
    if (a === undefined || a === null) continue;
    for (const seg of String(a).replace(/\\/g, '/').split('/')) if (seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** A positive safe integer (ids, run numbers, step numbers), else null. */
function safeInt(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,16}$/.test(v.trim()) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Human-readable duration. */
function fmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '\u2014';
  ms = Number(ms);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const total = Math.round(s);
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

/** Human-readable byte count. */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Escapes the characters that would break a Markdown table cell / link text.
 * Every line ending — CRLF, LF and a lone CR (CommonMark treats a bare CR as a
 * line ending too, so it would end the table row) — becomes a space.
 */
function escapeMd(s) { return String(s == null ? '' : s).replace(/[\\*_`|\[\]<>]/g, '\\$&').replace(/\r\n?|\n/g, ' '); }

module.exports = {
  getInput, getBooleanInput, getIntInput, parseList, setOutput, appendSummary,
  log, debug, warning, notice, error, group, endGroup,
  ensureDir, rmrf, exists, readJson, writeJson, copyDir, listFiles, glob, isWithin, addMask,
  sanitizeName, parseIsoMs, isoNow, sleep, mapLimit, toPosix, posixJoin, safeInt, fmtMs, fmtBytes, escapeMd,
};
