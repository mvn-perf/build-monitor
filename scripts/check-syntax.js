#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Lint for a zero-dependency action: parses every shipped script (they run
 * un-bundled on the runner's Node 24, and Node 20 is the supported floor),
 * refuses APIs newer than Node 20, checks the licence header, and verifies
 * that the three action manifests point at existing files and run on node24.
 * Exit code 1 when anything fails; the output lists one line per check.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

/** Directories whose top-level .js files ship with the action (site/vendor is third-party, not checked). */
const SCRIPT_DIRS = ['src', 'site', 'scripts', 'report', 'summary'];
/** The three action manifests, relative to the repository root. */
const MANIFESTS = ['action.yml', 'report/action.yml', 'summary/action.yml'];
/** Files that must ship with the site. */
const REQUIRED_FILES = ['site/vendor/chart.umd.min.js', 'site/vendor/THIRD_PARTY.md', 'LICENSE', 'NOTICE', 'package.json'];

/**
 * APIs that do not exist on Node 20 (the floor): each entry names the API and
 * the Node version that introduced it. Kept conservative: `toSorted` & co. are
 * on Node 20 but the sources avoid them so the check stays simple.
 */
const NEWER_THAN_NODE_20 = [
  [/\bfs\.globSync\s*\(|\bfs\.glob\s*\(|\bfsPromises\.glob\s*\(|\bpromises\.glob\s*\(/, 'fs.glob (Node 22)'],
  [/\btoSorted\(|\btoReversed\(|\btoSpliced\(/, 'Array#toSorted/toReversed/toSpliced (avoid; keep the Node 20 surface conservative)'],
  [/\bObject\.groupBy\b|\bMap\.groupBy\b/, 'Object.groupBy / Map.groupBy (Node 21)'],
  [/\bPromise\.withResolvers\b/, 'Promise.withResolvers (Node 22)'],
  [/\bPromise\.try\b/, 'Promise.try (Node 23)'],
  [/\bArray\.fromAsync\b/, 'Array.fromAsync (Node 22)'],
  [/\bIterator\.from\b/, 'Iterator.from (Node 22)'],
  [/\.(?:symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, 'Set methods (Node 22)'],
  [/\bRegExp\.escape\b/, 'RegExp.escape (Node 24)'],
  [/\bError\.isError\b/, 'Error.isError (Node 24)'],
  [/\bimport\.meta\b/, 'import.meta (ESM only; the action is CommonJS)'],
];

const HEADER_RE = /^\/\*\r?\n \* Copyright \(c\) The mvn-perf Authors\.\r?\n \* Licensed under the Apache License, Version 2\.0\./;

let failed = 0;
function ok(msg) { console.log('ok  ' + msg); }
function err(msg) { failed++; console.error('ERR ' + msg); }

// ---------------------------------------------------------------------------
// 1. Scripts: parse, Node 20 surface, licence header
// ---------------------------------------------------------------------------

const scripts = [];
for (const dir of SCRIPT_DIRS) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) { err(`${dir}/: directory missing`); continue; }
  for (const f of fs.readdirSync(abs).filter(n => n.endsWith('.js')).sort()) scripts.push(path.posix.join(dir, f));
}

for (const f of scripts) {
  try {
    const original = fs.readFileSync(path.join(root, f), 'utf8');
    if (original.includes(String.fromCharCode(0xFFFD))) throw new Error('contains U+FFFD (mis-decoded text)');
    if (original.charCodeAt(0) === 0xFEFF) throw new Error('starts with a UTF-8 BOM');
    const src = original.replace(/^#![^\n]*\n/, '\n');
    // Browser scripts are plain scripts; everything else is a CommonJS module
    // (wrapping in a function accepts top-level `return`, like Node does).
    if (f.startsWith('site/')) new vm.Script(src, { filename: f });
    else new vm.Script(`(function(){${src}\n})`, { filename: f });
    if (f !== 'scripts/check-syntax.js') {   // the checker itself must spell the forbidden APIs out
      for (const [re, what] of NEWER_THAN_NODE_20) {
        const m = re.exec(src);
        if (m) throw new Error(`uses ${what}: "${m[0]}"`);
      }
    }
    if (!HEADER_RE.test(src.replace(/^\n/, ''))) throw new Error('missing the Apache-2.0 licence header (see CONTRACTS: "Copyright (c) The mvn-perf Authors.")');
    if (!f.startsWith('site/') && !/^'use strict';/m.test(src)) throw new Error("missing 'use strict'");
    ok(f);
  } catch (e) {
    err(`${f}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Manifests: main/pre/post files exist, runs on node24
// ---------------------------------------------------------------------------

for (const manifest of MANIFESTS) {
  const file = path.join(root, manifest);
  if (!fs.existsSync(file)) { err(`${manifest}: missing`); continue; }
  const y = fs.readFileSync(file, 'utf8');
  const problems = [];
  const runs = /^runs:\s*$([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(y);
  if (!runs) problems.push('no "runs:" block');
  else {
    const block = runs[1];
    const using = /^\s+using:\s*['"]?([\w-]+)['"]?\s*$/m.exec(block);
    if (!using) problems.push('runs.using missing');
    else if (using[1] !== 'node24') problems.push(`runs.using is "${using[1]}", expected "node24"`);
    let anyMain = false;
    for (const key of ['main', 'pre', 'post']) {
      const m = new RegExp(`^\\s+${key}:\\s*['"]?([^'"\\s#]+)['"]?\\s*$`, 'm').exec(block);
      if (!m) { if (key === 'main') problems.push('runs.main missing'); continue; }
      anyMain = anyMain || key === 'main';
      const target = m[1];
      if (/^(\/|[A-Za-z]:|\\)/.test(target) || target.split('/').includes('..')) problems.push(`runs.${key} "${target}" is not a relative path inside the action`);
      else if (!fs.existsSync(path.join(root, path.dirname(manifest), target))) problems.push(`runs.${key} "${target}" does not exist`);
    }
  }
  if (!/^branding:\s*$/m.test(y)) problems.push('no "branding:" block');
  if (problems.length) err(`${manifest}: ${problems.join('; ')}`);
  else ok(manifest);
}

// ---------------------------------------------------------------------------
// 3. Files that must ship
// ---------------------------------------------------------------------------

for (const f of REQUIRED_FILES) {
  if (fs.existsSync(path.join(root, f))) ok(f);
  else err(`${f}: missing`);
}

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) err('package.json declares dependencies; the action must stay dependency-free');
  else ok('package.json: no dependencies');
  if (!pkg.engines || !/>=\s*20/.test(String(pkg.engines.node || ''))) err('package.json: engines.node should be ">=20"');
} catch (e) {
  err('package.json: ' + e.message);
}

if (failed) console.error(`\n${failed} check(s) failed`);
process.exit(failed ? 1 : 0);
