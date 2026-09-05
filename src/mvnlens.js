/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/** Modules kept in a summary (history size). */
const MAX_MODULES = 200;

/**
 * Where a published report finds the shared shell. history.reportDirFor fixes the
 * published shape at reports/<runId>/<key>/report.html — always exactly three
 * levels below the site root, whatever `site-dir` is — so the reference is a
 * constant, not something the report step computes.
 */
const ASSET_REF_PREFIX = '../../../assets/';
/** Below this the split costs more than it saves: three more requests to spare a few KB. */
const MIN_SHELL_BYTES = 64 * 1024;

/**
 * Reads the model an mvn-lens report embeds.
 *
 * report.html carries the whole TimelineModel inline in
 *   <script id="mvnlens-data" type="application/json">…</script>
 * (older builds used id="mvnflight-data"). The payload is either plain JSON or
 * "gzip:" + base64(gzip(json)). The renderer neutralises any inner "</script"
 * as "<\/script", so the first literal "</script>" closes the block.
 *
 * @returns {object|null} the parsed model, or null when the file is not an mvn-lens report
 */
function extractModelFromHtml(html) {
  const m = /<script\s+id="(?:mvnlens|mvnflight)-data"\s+type="application\/json"\s*>/i.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  let raw = html.slice(start, end).trim();
  if (!raw) return null;
  if (raw.startsWith('gzip:')) {
    const bytes = Buffer.from(raw.slice(5), 'base64');
    raw = zlib.gunzipSync(bytes).toString('utf8');
  }
  return JSON.parse(raw);
}

/**
 * Condenses a TimelineModel into the headline numbers the dashboard trends and
 * lists. Every field is optional on the model, so everything here is defensive.
 */
function summarizeModel(model, opts) {
  const withModules = !!(opts && opts.modules);
  const s = (model && model.session) || {};
  const env = (model && model.environment) || null;
  const jit = Array.isArray(model && model.jit) ? model.jit : [];
  const modules = Array.isArray(model && model.modules) ? model.modules : [];
  const issues = Array.isArray(model && model.issues) ? model.issues : [];
  const transfer = (model && model.repoTransferSummary) || null;
  const tests = (model && model.tests && typeof model.tests === 'object') ? model.tests : {};

  const wallMs = num(s.wallMs);
  const totalMs = num(s.totalMs) || wallMs;
  const c2Ms = sumBy(jit.filter(e => e && num(e.level) >= 4), 'durationMs');
  const jitMs = sumBy(jit, 'durationMs');
  let testCount = 0;
  let testMs = 0;
  for (const list of Object.values(tests)) {
    if (!Array.isArray(list)) continue;
    testCount += list.length;
    testMs += sumBy(list, 'durationMs');
  }
  const severities = {};
  for (const i of issues) {
    const sev = String((i && (i.severity || i.level)) || 'unknown').toLowerCase();
    severities[sev] = (severities[sev] || 0) + 1;
  }

  return {
    schemaVersion: 1,
    groupId: str(s.groupId),
    artifactId: str(s.artifactId),
    version: str(s.version),
    goals: Array.isArray(s.goals) ? s.goals.map(String) : [],
    threads: num(s.threads),
    builderId: str(s.builderId),
    mavenVersion: str(s.mavenVersion || s.maven),
    jdkVersion: str(s.jdkVersion || s.jdk),
    status: str(s.status),
    startedAt: num(s.startedAt) || null,
    endedAt: num(s.endedAt) || null,
    totalMs, wallMs,
    cpuMs: num(s.cpuMs),
    gcMs: num(s.gcMs),
    gcCount: num(s.gcCount),
    jitMs, c2Ms,
    downloadMs: transfer ? num(transfer.millisDownloadedThisBuild) : 0,
    downloadBytes: transfer ? num(transfer.bytesDownloadedThisBuild) : 0,
    downloadCount: transfer ? num(transfer.artifactDownloadsCount) + num(transfer.metadataDownloadsCount) : 0,
    moduleCount: modules.length,
    modules: withModules ? modules.slice(0, MAX_MODULES).map(m => ({
      artifactId: str(m.artifactId), name: str(m.name), wallMs: num(m.wallMs),
      startMs: num(m.startMs) || null, endMs: num(m.endMs) || null, forkCount: num(m.forkCount),
    })) : undefined,
    slowestMojo: model && model.slowestMojo ? pick(model.slowestMojo, ['plugin', 'goal', 'phase', 'executionId', 'moduleKey', 'durationMs']) : null,
    slowestTest: model && model.slowestTest ? pick(model.slowestTest, ['className', 'methodName', 'displayName', 'framework', 'moduleKey', 'durationMs']) : null,
    testCount, testMs,
    issueCount: issues.length,
    issueSeverities: severities,
    environment: env ? {
      availableProcessors: num(env.availableProcessors),
      cpuCores: num(env.cpuCores), cpuThreads: num(env.cpuThreads), memoryBytes: num(env.memoryBytes),
      osName: str(env.osName), jvmName: str(env.jvmName), jvmVendor: str(env.jvmVendor),
      mvnd: !!env.mvnd, githubActions: !!env.githubActions, c2DisabledBy: str(env.c2DisabledBy),
    } : null,
  };
}

/**
 * Reads the model of an mvn-lens report from disk. Prefers the HTML (the file
 * that gets published) and falls back to a sibling model.json.
 * @returns {{model: object|null, source: string|null, error: string|null}}
 */
function readReportModel(htmlFile) {
  try {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const model = extractModelFromHtml(html);
    if (model) return { model, source: 'html', error: null };
  } catch (e) {
    const sidecar = path.join(path.dirname(htmlFile), 'model.json');
    if (fs.existsSync(sidecar)) {
      try {
        return { model: JSON.parse(fs.readFileSync(sidecar, 'utf8')), source: 'model.json', error: null };
      } catch (e2) {
        return { model: null, source: null, error: `report unreadable (${e.message}); model.json unreadable (${e2.message})` };
      }
    }
    return { model: null, source: null, error: e.message };
  }
  const sidecar = path.join(path.dirname(htmlFile), 'model.json');
  if (fs.existsSync(sidecar)) {
    try { return { model: JSON.parse(fs.readFileSync(sidecar, 'utf8')), source: 'model.json', error: null }; } catch (e) { /* fall through */ }
  }
  return { model: null, source: null, error: 'no embedded mvn-lens model found' };
}

/**
 * Reads an mvn-lens report from disk and returns its summary (readReportModel
 * + summarizeModel).
 * @returns {{summary: object|null, source: string|null, error: string|null}}
 */
function readReportSummary(htmlFile, opts) {
  const { model, source, error } = readReportModel(htmlFile);
  return { summary: model ? summarizeModel(model, opts) : null, source, error };
}

/**
 * Re-encodes the embedded model of a report as "gzip:" + base64(gzip(json)) —
 * the encoding the mvn-lens renderer inflates with its inlined pako — so a
 * 20 MB report becomes a few MB. Lossless; a report that is already compressed,
 * has no data block, or whose renderer does not embed pako is returned as is.
 *
 * @param {string} html
 * @returns {{html: string, compressed: boolean, reason: string|null, before: number, after: number}}
 */
function compressReportHtml(html) {
  const before = Buffer.byteLength(html, 'utf8');
  const m = /<script\s+id="(?:mvnlens|mvnflight)-data"\s+type="application\/json"\s*>/i.exec(html);
  if (!m) return { html, compressed: false, reason: 'no embedded model', before, after: before };
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return { html, compressed: false, reason: 'unterminated data block', before, after: before };
  const raw = html.slice(start, end).trim();
  if (!raw) return { html, compressed: false, reason: 'empty data block', before, after: before };
  if (raw.startsWith('gzip:')) return { html, compressed: false, reason: 'already compressed', before, after: before };
  // The renderer must be able to inflate: a decoder that understands the prefix
  // after the block (dashboard.js: raw.indexOf("gzip:")) and the pako library
  // before it (its banner "/*! pako" or "pako inflate").
  const head = html.slice(0, start);
  const tail = html.slice(end);
  if (!/gzip:/.test(tail) || !/window\.pako|pako\.ungzip/.test(tail)) {
    return { html, compressed: false, reason: 'renderer has no gzip decoder', before, after: before };
  }
  if (!/\/\*! pako|pako inflate|pako\.min/.test(head)) {
    return { html, compressed: false, reason: 'pako library not found before the data block', before, after: before };
  }
  // A "</script" inside the JSON is written as "<\/script" by the renderer - valid
  // JSON already (escaped slash), so the block is gzipped verbatim once it parses.
  try { JSON.parse(raw); } catch (e) { return { html, compressed: false, reason: `data block is not valid JSON (${e.message})`, before, after: before }; }
  const gz = zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 9 });
  if (zlib.gunzipSync(gz).toString('utf8') !== raw) return { html, compressed: false, reason: 'gzip round-trip mismatch', before, after: before };
  const payload = 'gzip:' + gz.toString('base64');
  const out = head + payload + tail;
  return { html: out, compressed: true, reason: null, before, after: Buffer.byteLength(out, 'utf8') };
}

/**
 * Splits the mvn-lens dashboard SHELL out of a report so the site stores it once.
 *
 * A report.html is a self-contained dashboard built from six blocks: three
 * contiguous <style> blocks, the vendor <script> (d3, Chart.js, vis-timeline,
 * pako, moment), the JSON data block and the app bootstrap <script>. Only the
 * data block differs between two reports — measured over 39 real reports the
 * 1.4 MB around it is byte-identical, and the site stored that shell once per
 * report (53 % of a 99.6 MB site). Each shell block is replaced by a reference
 * to a content-hashed asset AT THE BLOCK'S OWN OFFSET: the document order is
 * unchanged, so the bootstrap still runs AFTER the data block it reads with
 * document.getElementById("mvnlens-data"). Hoisting it above that block (by
 * merging the two <script> blocks into one asset, say) makes getElementById
 * return null and every report render empty.
 *
 * Nothing here is undone on the site: a shell that cannot be recognised is left
 * inline. A report that is 1.4 MB too big still renders; one that lost a block
 * does not.
 *
 * @param {string} html the report, compressed first (see compressReportHtml:
 *   the shell is the same bytes whatever the data block holds)
 * @returns {{html: string, split: boolean, reason: string|null, assets: Array<{name: string, content: Buffer, bytes: number}>, before: number, after: number}}
 */
function splitReportHtml(html) {
  const before = Buffer.byteLength(html, 'utf8');
  const decline = (reason) => ({ html, split: false, reason, assets: [], before, after: before });
  const m = /<script\s+id="(?:mvnlens|mvnflight)-data"\s+type="application\/json"\s*>/i.exec(html);
  if (!m) return decline('no embedded model');
  if (html.indexOf('</script>', m.index + m[0].length) < 0) return decline('unterminated data block');

  // The blocks, in document order. The scan jumps over each body instead of
  // searching the whole text: the app bootstrap carries a literal
  // '<script id="mvnlens-data" type="application/json">' of its own (the real
  // javadoc report does), and only a scan that skips bodies ignores that decoy.
  //
  // It jumps over HTML comments for the same reason, and the stakes are higher
  // there: a start tag merely QUOTED in a comment ('<!-- the <script> below is
  // generated -->' — the real report carries a NOTICE comment right where the
  // scan passes) is not a block, and reading it as one sends the scan looking
  // for the next '</script>', which carries the comment's '-->' into the asset.
  // The published report would then be a single unterminated comment
  // swallowing the data block and the bootstrap reference: a blank page,
  // logged as a successful split. A comment that never ends is a shape this
  // function cannot make sense of, so it declines like any other.
  const blocks = [];
  let dataSeen = false;
  const open = /<!--|<(script|style)\b([^>]*)>/gi;
  for (let at = 0; ;) {
    open.lastIndex = at;
    const t = open.exec(html);
    if (!t) break;
    if (!t[1]) {
      const stop = html.indexOf('-->', t.index + 4);
      if (stop < 0) return decline('unterminated HTML comment');
      at = stop + 3;
      continue;
    }
    const tag = t[1].toLowerCase();
    const close = `</${tag}>`;
    const bodyStart = t.index + t[0].length;
    const bodyEnd = html.indexOf(close, bodyStart);
    if (bodyEnd < 0) return decline(`unterminated <${tag}> block`);
    at = bodyEnd + close.length;
    if (t.index === m.index) { dataSeen = true; continue; }   // the anchor: never moved, never externalised
    if (t[2].trim()) return decline(`unexpected attributes on <${tag}>`);
    const body = html.slice(bodyStart, bodyEnd);
    // Cutting at the first '</tag>' leaves no complete one behind, but a stray
    // '</script' or '</style' would have to be re-escaped for the browser to
    // read the block back the same way. Leave such a report alone.
    if (body.includes(`</${tag}`)) return decline(`a <${tag}> block contains "</${tag}"`);
    blocks.push({ tag, start: t.index, end: at, body });
  }
  // The data block is the anchor of the whole rewrite: if the scan never met it
  // at top level it is nested in some other block, and that block's body would
  // be moved to an external file — data and all.
  if (!dataSeen) return decline('the data block is not a top-level block');

  const styles = blocks.filter(b => b.tag === 'style');
  const scripts = blocks.filter(b => b.tag === 'script');
  if (!scripts.length) return decline('no <script> block besides the data block');
  for (let i = 1; i < styles.length; i++) {
    if (html.slice(styles[i - 1].end, styles[i].start).trim()) return decline('the <style> blocks are not contiguous');
  }

  const reps = [];
  if (styles.length) {
    // The contiguous <style> run becomes one stylesheet, replaced as a whole:
    // the whitespace between the blocks travels into the asset, so nothing but
    // the three pairs of tags is lost.
    let css = styles[0].body;
    for (let i = 1; i < styles.length; i++) css += html.slice(styles[i - 1].end, styles[i].start) + styles[i].body;
    const a = shellAsset(css, 'css');
    reps.push({ start: styles[0].start, end: styles[styles.length - 1].end, text: assetReference(a), asset: a });
  }
  for (const b of scripts) {
    const a = shellAsset(b.body, 'js');
    reps.push({ start: b.start, end: b.end, text: assetReference(a), asset: a });
  }
  reps.sort((x, y) => x.start - y.start);

  const assets = [];
  const seen = new Set();
  for (const rep of reps) if (!seen.has(rep.asset.name)) { seen.add(rep.asset.name); assets.push(rep.asset); }
  const shell = assets.reduce((n, a) => n + a.bytes, 0);
  if (shell < MIN_SHELL_BYTES) return decline(`the shell is ${shell} bytes, under the ${MIN_SHELL_BYTES}-byte split threshold`);

  let out = '';
  let cursor = 0;
  let dataAt = m.index;
  for (const rep of reps) {
    out += html.slice(cursor, rep.start) + rep.text;
    cursor = rep.end;
    if (rep.end <= m.index) dataAt += rep.text.length - (rep.end - rep.start);
  }
  out += html.slice(cursor);

  // The two invariants the renderer depends on, checked rather than trusted —
  // both hold by construction, and both break every report silently when they
  // do not: the data block is where it was (relative to what precedes it), and
  // every block that followed it still loads after it.
  if (!out.startsWith(html.slice(m.index, m.index + m[0].length), dataAt)) return decline('the data block moved');
  for (const rep of reps) {
    if (rep.start > m.index && out.indexOf(rep.text, dataAt) < 0) return decline('a block that followed the data block would load before it');
  }
  return { html: out, split: true, reason: null, assets, before, after: Buffer.byteLength(out, 'utf8') };
}

/**
 * A shell block as a content-addressed asset: the same bytes always get the
 * same name (sha256, 48 bits of it), so two reports sharing a shell publish one
 * file and republishing it is a no-op. The name is the whole contract with the
 * processor, which whitelists it with an anchored regex before it lands on the
 * Pages origin as executable JavaScript.
 */
function shellAsset(body, ext) {
  const content = Buffer.from(body, 'utf8');
  return { name: `lens-${crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)}.${ext}`, content, bytes: content.length };
}

/** The markup replacing a block: classic (parser-blocking, in-order) tags, so the load order is the block order. */
function assetReference(a) {
  return a.name.endsWith('.css')
    ? `<link rel="stylesheet" href="${ASSET_REF_PREFIX}${a.name}">`
    : `<script src="${ASSET_REF_PREFIX}${a.name}"></script>`;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v) { return v === undefined || v === null ? null : String(v); }
function sumBy(list, key) { let t = 0; for (const e of list) t += num(e && e[key]); return t; }
function pick(obj, keys) { const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; }

module.exports = { extractModelFromHtml, summarizeModel, readReportModel, readReportSummary, compressReportHtml, splitReportHtml, MAX_MODULES };
