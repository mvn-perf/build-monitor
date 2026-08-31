/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Renders the monitoring page: one self-contained index.html (CSS, Chart.js,
 * model.js and app.js inlined) next to data/history.json. The dataset is
 * normally NOT inlined — the processor writes index.html once and the page
 * fetches data/history.json — but it can be (demo, offline preview).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ensureDir } = require('./util');
const { saveHistory } = require('./history');

const SITE_SRC = path.join(__dirname, '..', 'site');
/** Inline datasets above this many bytes are gzip-embedded ("gzip:" + base64). */
const DEFAULT_GZIP_THRESHOLD = 256 * 1024;
const DATA_BLOCK_ID = 'build-monitor-data';
/** The template placeholders, substituted in one single pass (see renderIndexHtml). */
const PLACEHOLDER_RE = /__TITLE__|__APP_CSS__|__DATA_JSON__|__VENDOR_JS__|__MODEL_JS__|__APP_JS__/g;

let assetCache = null;
function assets() {
  if (assetCache) return assetCache;
  assetCache = {
    template: fs.readFileSync(path.join(SITE_SRC, 'index.template.html'), 'utf8'),
    css: fs.readFileSync(path.join(SITE_SRC, 'app.css'), 'utf8'),
    model: fs.readFileSync(path.join(SITE_SRC, 'model.js'), 'utf8'),
    app: fs.readFileSync(path.join(SITE_SRC, 'app.js'), 'utf8'),
    vendor: fs.readFileSync(path.join(SITE_SRC, 'vendor', 'chart.umd.min.js'), 'utf8'),
  };
  for (const k of Object.keys(assetCache)) {
    if (/<\/script/i.test(assetCache[k]) && k !== 'template') throw new Error(`site/${k}: contains "</script", which would break the inlined page`);
  }
  return assetCache;
}

function defaultTitle(history) {
  const repo = history && history.repository ? String(history.repository) : '';
  return repo ? `Build monitor · ${repo}` : 'Build monitor';
}

/**
 * The page HTML. `dataset` null ⇒ the data block is empty and the app fetches
 * data/history.json. Pure (no timestamps, no file writes) so main.js can hash
 * the result and skip an unchanged blob.
 *
 * @param {{ title?: string, dataset?: object|null, gzipThreshold?: number|null }} p
 * @returns {string}
 */
function renderIndexHtml(p) {
  const o = p || {};
  const a = assets();
  const title = o.title ? String(o.title) : defaultTitle(o.dataset);
  let payload = '';
  if (o.dataset !== null && o.dataset !== undefined) {
    if (typeof o.dataset !== 'object') throw new Error('renderIndexHtml: dataset must be an object or null');
    payload = embedJson(o.dataset);
    const threshold = o.gzipThreshold === undefined ? DEFAULT_GZIP_THRESHOLD : o.gzipThreshold;
    if (threshold !== null && Buffer.byteLength(payload) > threshold) {
      payload = 'gzip:' + zlib.gzipSync(Buffer.from(JSON.stringify(o.dataset), 'utf8'), { level: 9 }).toString('base64');
    }
  }
  const values = {
    __TITLE__: escapeHtml(title),
    __APP_CSS__: a.css,
    __DATA_JSON__: payload,
    __VENDOR_JS__: a.vendor,
    __MODEL_JS__: a.model,
    __APP_JS__: a.app,
  };
  // ONE pass over the template: a substituted value is never scanned again, so an
  // inlined dataset (or a title) containing the literal text of a later placeholder
  // cannot swallow it. The callback also keeps "$&" inside the CSS/JS uninterpreted.
  return a.template.replace(PLACEHOLDER_RE, (m) => values[m]);
}

/**
 * Writes <siteDir>/index.html, <siteDir>/data/history.json and <siteDir>/.nojekyll.
 *
 * @param {{ history: object, siteDir: string, title?: string, siteUrl?: string, inline?: boolean, gzipThreshold?: number|null }} p
 * @returns {{ indexFile: string, bytes: number }}
 */
function generateSite(p) {
  if (!p || !p.history || typeof p.history !== 'object') throw new Error('generateSite: history is required');
  if (!p.siteDir) throw new Error('generateSite: siteDir is required');
  const siteDir = ensureDir(p.siteDir);
  const history = p.siteUrl && !p.history.siteUrl ? Object.assign({}, p.history, { siteUrl: p.siteUrl }) : p.history;
  const title = p.title || defaultTitle(history);
  const html = renderIndexHtml({ title, dataset: p.inline ? history : null, gzipThreshold: p.gzipThreshold });
  const indexFile = path.join(siteDir, 'index.html');
  fs.writeFileSync(indexFile, html);
  fs.writeFileSync(path.join(siteDir, '.nojekyll'), '');
  saveHistory(path.join(siteDir, 'data', 'history.json'), history);
  return { indexFile, bytes: Buffer.byteLength(html) };
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON that is safe inside <script type="application/json">: every "<" becomes
 * the < escape (still valid JSON), so neither "</script>" nor "<!--" can
 * occur; U+2028/U+2029 are escaped as well for JS-source-safety.
 */
function embedJson(obj) {
  return JSON.stringify(obj)
    .split('<').join('\\u003c')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { generateSite, renderIndexHtml, embedJson, escapeHtml, DATA_BLOCK_ID, DEFAULT_GZIP_THRESHOLD };
