/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { extractModelFromHtml, summarizeModel, readReportSummary, compressReportHtml, splitReportHtml, MAX_MODULES } = require('../src/mvnlens');
const { fixtureModel, fakeReportHtml, fakeShellReportHtml, tmpDir, FIXTURES } = require('./helpers');

const REAL_REPORT = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'claude', 'C--code', '438db93c-675e-47a9-9f45-4779fd647497', 'scratchpad', 'art', 'javadoc', 'report.html');

test('extractModelFromHtml reads the plain JSON data block', () => {
  const model = fixtureModel();
  const back = extractModelFromHtml(fakeReportHtml(model));
  assert.equal(back.session.artifactId, model.session.artifactId);
  assert.equal(back.modules.length, model.modules.length);
  assert.deepEqual(back, model, 'lossless');
});

test('extractModelFromHtml reads the gzip:base64 encoding and the legacy mvnflight id', () => {
  const model = fixtureModel();
  assert.equal(extractModelFromHtml(fakeReportHtml(model, { gzip: true })).session.totalMs, model.session.totalMs);
  assert.equal(extractModelFromHtml(fakeReportHtml(model, { id: 'mvnflight-data' })).session.totalMs, model.session.totalMs);
  assert.equal(extractModelFromHtml(fakeReportHtml(model, { id: 'mvnflight-data', gzip: true })).session.totalMs, model.session.totalMs);
  assert.equal(extractModelFromHtml(fakeReportHtml(model, { pako: true, gzip: true })).session.totalMs, model.session.totalMs);
});

test('extractModelFromHtml survives an escaped </script> inside a string and returns null for non-reports', () => {
  const model = fixtureModel();
  model.session.artifactId = 'evil</script><script>alert(1)</script>';
  const html = fakeReportHtml(model);
  assert.ok(html.includes('<\\/script'));
  assert.equal(extractModelFromHtml(html).session.artifactId, model.session.artifactId);
  assert.equal(extractModelFromHtml('<html><body>hello</body></html>'), null);
  assert.equal(extractModelFromHtml(''), null);
  assert.equal(extractModelFromHtml('<script id="mvnlens-data" type="application/json"></script>'), null, 'empty block');
  assert.equal(extractModelFromHtml('<script id="mvnlens-data" type="application/json">{"a":1}'), null, 'unterminated block');
  assert.equal(extractModelFromHtml('<script id="other-data" type="application/json">{"a":1}</script>'), null);
  assert.throws(() => extractModelFromHtml('<script id="mvnlens-data" type="application/json">{oops</script>'), SyntaxError);
  assert.throws(() => extractModelFromHtml('<script id="mvnlens-data" type="application/json">gzip:AAAA</script>'), 'corrupt gzip throws (callers catch)');
});

test('summarizeModel computes the headline metrics and omits modules unless asked', () => {
  const model = fixtureModel();
  const s = summarizeModel(model);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.artifactId, 'it04-multi-module');
  assert.equal(s.groupId, model.session.groupId);
  assert.deepEqual(s.goals, ['clean', 'verify']);
  assert.equal(s.totalMs, model.session.totalMs);
  assert.equal(s.wallMs, model.session.wallMs);
  assert.equal(s.cpuMs, model.session.cpuMs);
  assert.equal(s.gcCount, model.session.gcCount);
  assert.equal(s.status, 'OK');
  assert.equal(s.threads, model.session.threads);
  assert.equal(s.builderId, model.session.builderId);
  assert.equal(s.moduleCount, model.modules.length);
  assert.equal(s.modules, undefined, 'modules are omitted by default (history size)');
  assert.ok(!('modules' in JSON.parse(JSON.stringify(s))), 'and do not survive JSON serialisation');
  const c2 = model.jit.filter(e => e.level >= 4).reduce((a, e) => a + e.durationMs, 0);
  assert.equal(s.c2Ms, c2);
  assert.ok(s.jitMs >= s.c2Ms);
  assert.equal(s.mavenVersion, model.session.mavenVersion);
  assert.equal(s.jdkVersion, model.session.jdkVersion);
  assert.equal(s.environment.availableProcessors, model.environment.availableProcessors);
  assert.equal(s.environment.osName, model.environment.osName);
  assert.equal(s.environment.mvnd, false);
  assert.equal(s.environment.githubActions, false);
  assert.equal(typeof s.testCount, 'number');
  assert.equal(typeof s.testMs, 'number');
  assert.equal(typeof s.issueCount, 'number');
  assert.equal(typeof s.issueSeverities, 'object');
  assert.ok(s.startedAt > 0 && s.endedAt > s.startedAt);
  assert.equal(typeof s.downloadMs, 'number');
  assert.equal(typeof s.downloadBytes, 'number');
  assert.equal(typeof s.downloadCount, 'number');

  const withModules = summarizeModel(model, { modules: true });
  assert.equal(withModules.modules.length, model.modules.length);
  assert.equal(withModules.modules[0].artifactId, model.modules[0].artifactId);
  assert.equal(withModules.modules[0].wallMs, model.modules[0].wallMs);
  assert.deepEqual(Object.keys(withModules.modules[0]).sort(), ['artifactId', 'endMs', 'forkCount', 'name', 'startMs', 'wallMs']);

  const many = Object.assign({}, model, { modules: Array.from({ length: MAX_MODULES + 50 }, (_, i) => ({ artifactId: 'm' + i, wallMs: i })) });
  const capped = summarizeModel(many, { modules: true });
  assert.equal(capped.moduleCount, MAX_MODULES + 50, 'moduleCount is the real count');
  assert.equal(capped.modules.length, MAX_MODULES, 'modules list is capped');
});

test('summarizeModel tolerates missing sections and falls back to wallMs', () => {
  const s = summarizeModel({ session: { wallMs: 1234, goals: null, maven: '3.9.9', jdk: '21' } });
  assert.equal(s.totalMs, 1234);
  assert.equal(s.moduleCount, 0);
  assert.equal(s.c2Ms, 0);
  assert.deepEqual(s.goals, []);
  assert.equal(s.environment, null);
  assert.equal(s.mavenVersion, '3.9.9', 'legacy field names');
  assert.equal(s.jdkVersion, '21');
  assert.equal(s.slowestMojo, null);
  assert.equal(s.slowestTest, null);
  assert.equal(s.startedAt, null);
  const empty = summarizeModel(null);
  assert.equal(empty.totalMs, 0);
  assert.equal(empty.status, null);
  assert.equal(summarizeModel(undefined).moduleCount, 0);
  assert.equal(summarizeModel({ jit: 'nope', modules: {}, issues: null, tests: 'x' }).jitMs, 0);
  const counted = summarizeModel({ issues: [{ severity: 'WARN' }, { level: 'error' }, {}, null], tests: { surefire: [{ durationMs: 5 }, { durationMs: 7 }], junk: 'x' } });
  assert.equal(counted.issueCount, 4);
  assert.deepEqual(counted.issueSeverities, { warn: 1, error: 1, unknown: 2 });
  assert.equal(counted.testCount, 2);
  assert.equal(counted.testMs, 12);
});

test('readReportSummary prefers the HTML and falls back to model.json', () => {
  const dir = tmpDir('mvnlens');
  const model = fixtureModel();
  const html = path.join(dir, 'report.html');
  fs.writeFileSync(html, fakeReportHtml(model));
  const r1 = readReportSummary(html);
  assert.equal(r1.source, 'html');
  assert.equal(r1.error, null);
  assert.equal(r1.summary.totalMs, model.session.totalMs);
  assert.equal(r1.summary.modules, undefined);
  assert.equal(readReportSummary(html, { modules: true }).summary.modules.length, model.modules.length);

  fs.writeFileSync(html, '<html>degraded report without data</html>');
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model));
  const r2 = readReportSummary(html);
  assert.equal(r2.source, 'model.json');
  assert.equal(r2.summary.totalMs, model.session.totalMs);

  fs.writeFileSync(html, '<script id="mvnlens-data" type="application/json">{broken</script>');
  const r2b = readReportSummary(html);
  assert.equal(r2b.source, 'model.json', 'an unparsable block falls back to model.json too');

  fs.writeFileSync(path.join(dir, 'model.json'), '{broken too');
  const r2c = readReportSummary(html);
  assert.equal(r2c.summary, null);
  assert.match(r2c.error, /report unreadable .* model\.json unreadable/);

  fs.unlinkSync(path.join(dir, 'model.json'));
  fs.writeFileSync(html, '<html>degraded report without data</html>');
  const r3 = readReportSummary(html);
  assert.equal(r3.summary, null);
  assert.equal(r3.source, null);
  assert.match(r3.error, /no embedded mvn-lens model/);

  const r4 = readReportSummary(path.join(dir, 'missing.html'));
  assert.equal(r4.summary, null);
  assert.match(r4.error, /ENOENT/);

  const r5 = readReportSummary(path.join(FIXTURES, 'sample-report', 'report.html'));
  assert.equal(r5.source, 'html');
  assert.equal(r5.summary.artifactId, 'it04-multi-module');
});

test('compressReportHtml re-encodes the plain data block when the renderer can inflate it', () => {
  const model = fixtureModel();
  const html = fakeReportHtml(model, { pako: true });
  const r = compressReportHtml(html);
  assert.equal(r.compressed, true, r.reason);
  assert.equal(r.reason, null);
  assert.equal(r.before, Buffer.byteLength(html, 'utf8'));
  assert.equal(r.after, Buffer.byteLength(r.html, 'utf8'));
  assert.ok(r.after < r.before, `smaller: ${r.after} < ${r.before}`);
  assert.ok(/<script id="mvnlens-data" type="application\/json">gzip:[A-Za-z0-9+/=]+<\/script>/.test(r.html));
  assert.deepEqual(extractModelFromHtml(r.html), model, 'round-trip: the model is unchanged');
  const head = r.html.slice(0, r.html.indexOf('<script id="mvnlens-data"'));
  const tail = r.html.slice(r.html.indexOf('</script>', r.html.indexOf('<script id="mvnlens-data"')));
  assert.equal(head, html.slice(0, html.indexOf('<script id="mvnlens-data"')), 'markup before the block is untouched');
  assert.equal(tail, html.slice(html.indexOf('</script>', html.indexOf('<script id="mvnlens-data"'))), 'markup after the block is untouched');
  // The gzip payload inflates to exactly the JSON text the renderer embedded (with its </script escaping).
  const payload = /application\/json">gzip:([A-Za-z0-9+/=]+)<\/script>/.exec(r.html)[1];
  const embeddedJson = JSON.stringify(model).replace(/<\/script/gi, '<\\/script');
  assert.equal(zlib.gunzipSync(Buffer.from(payload, 'base64')).toString('utf8'), embeddedJson);

  const again = compressReportHtml(r.html);
  assert.equal(again.compressed, false);
  assert.equal(again.reason, 'already compressed');
  assert.equal(again.html, r.html);
  assert.equal(again.after, again.before);
});

test('compressReportHtml leaves reports alone when a precondition fails', () => {
  const model = fixtureModel();
  const cases = [
    ['already gzip', fakeReportHtml(model, { pako: true, gzip: true }), /already compressed/],
    ['no data block', '<html><script>/*! pako 2.1.0 */</script><script>raw.indexOf("gzip:"); window.pako.ungzip(x)</script></html>', /no embedded model/],
    ['no decoder after the block', fakeReportHtml(model), /no gzip decoder/],
    ['no pako before the block', fakeReportHtml(model).replace('<script>console.log("dashboard")</script>', '<script>if (raw.indexOf("gzip:") === 0) window.pako.ungzip(x)</script>'), /pako library not found/],
    ['pako only after the block', fakeReportHtml(model).replace('<script>console.log("dashboard")</script>', '<script>/*! pako 2.1.0 */ if (raw.indexOf("gzip:") === 0) window.pako.ungzip(x)</script>'), /pako library not found/],
    ['invalid JSON', replaceBlock(fakeReportHtml(model, { pako: true }), '{"session"::'), /not valid JSON/],
    ['empty block', replaceBlock(fakeReportHtml(model, { pako: true }), '   '), /empty data block/],
    ['unterminated block', truncateAtBlock(fakeReportHtml(model, { pako: true })) + '{"x":1}', /unterminated/],
    ['sample fixture without pako', fs.readFileSync(path.join(FIXTURES, 'sample-report', 'report.html'), 'utf8'), /no gzip decoder/],
  ];
  for (const [name, html, reason] of cases) {
    const r = compressReportHtml(html);
    assert.equal(r.compressed, false, name);
    assert.match(r.reason, reason, name);
    assert.equal(r.html, html, `${name}: html unchanged`);
    assert.equal(r.before, r.after, name);
    assert.equal(r.before, Buffer.byteLength(html, 'utf8'), name);
  }
});

test('compressReportHtml is not fooled by an upper-case </SCRIPT> inside the data or a data-looking tag after the block', () => {
  // The renderer escapes any inner "</script" case-insensitively, so the block survives with "<\/SCRIPT>".
  const model = fixtureModel();
  model.session.artifactId = 'x</SCRIPT>y';
  const base = fakeReportHtml(model, { pako: true });
  assert.ok(base.includes('<\\/SCRIPT>'), 'the escaped upper-case tag is embedded');
  const r1 = compressReportHtml(base);
  assert.equal(r1.compressed, true, r1.reason);
  assert.equal(extractModelFromHtml(r1.html).session.artifactId, 'x</SCRIPT>y', 'round-trip preserves the string');

  // Even a RAW "</SCRIPT>" inside the JSON must not truncate the block: only the
  // lower-case "</script>" the renderer writes closes it.
  const raw = replaceBlock(fakeReportHtml(fixtureModel(), { pako: true }), JSON.stringify({ a: 'x</SCRIPT>y', b: 1 }));
  const r2 = compressReportHtml(raw);
  assert.equal(r2.compressed, true, r2.reason);
  assert.deepEqual(extractModelFromHtml(r2.html), { a: 'x</SCRIPT>y', b: 1 });

  // A second '<script id="mvnlens-data">' inside a comment after the real block must not be taken for the block
  // (the real javadoc report carries exactly that in its bootstrap comment).
  const decoy = base.replace('</body>', '<script>/* reads <script id="mvnlens-data" type="application/json"> */</script>\n<!-- <script id="mvnlens-data" type="application/json">{"decoy":true}</script> -->\n</body>');
  const r3 = compressReportHtml(decoy);
  assert.equal(r3.compressed, true, r3.reason);
  assert.deepEqual(extractModelFromHtml(r3.html), model, 'the first (real) block was compressed');
  assert.ok(r3.html.includes('{"decoy":true}'), 'the decoy is untouched');
  assert.equal(r3.html.split('<script id="mvnlens-data"').length, 4, 'nothing added or removed');
});

/** Replaces the content of the mvnlens-data block (index-based: the JSON itself may contain '<'). */
function replaceBlock(html, content) {
  const open = /<script id="(?:mvnlens|mvnflight)-data" type="application\/json">/.exec(html);
  assert.ok(open, 'block found');
  const start = open.index + open[0].length;
  const end = html.indexOf('</script>', start);
  assert.ok(end > 0, 'block terminated');
  return html.slice(0, start) + content + html.slice(end);
}

/** Cuts the report right after the opening of the data block (an unterminated block). */
function truncateAtBlock(html) {
  const open = /<script id="(?:mvnlens|mvnflight)-data" type="application\/json">/.exec(html);
  assert.ok(open, 'block found');
  return html.slice(0, open.index + open[0].length);
}

test('compressReportHtml shrinks a real mvn-lens report and stays lossless', { skip: !fs.existsSync(REAL_REPORT) && 'real report not available' }, () => {
  const html = fs.readFileSync(REAL_REPORT, 'utf8');
  const r = compressReportHtml(html);
  assert.equal(r.compressed, true, r.reason);
  assert.ok(r.after < r.before / 1.5, `compressed ${r.before} -> ${r.after}`);
  const before = extractModelFromHtml(html);
  const after = extractModelFromHtml(r.html);
  assert.deepEqual(after, before, 'the embedded model is identical');
  assert.equal(compressReportHtml(r.html).reason, 'already compressed');
});

// ---------------------------------------------------------------------------
// splitReportHtml — the shared dashboard shell
// ---------------------------------------------------------------------------

test('splitReportHtml externalises the shell blocks at their own offsets, keeping the bootstrap after the data block', () => {
  const model = fixtureModel();
  const html = fakeShellReportHtml(model);
  const r = splitReportHtml(html);
  assert.equal(r.split, true, r.reason);
  assert.equal(r.reason, null);
  assert.equal(r.before, Buffer.byteLength(html, 'utf8'));
  assert.equal(r.after, Buffer.byteLength(r.html, 'utf8'));
  const shell = r.assets.reduce((n, a) => n + a.bytes, 0);
  assert.ok(shell > 64 * 1024, `the shell is worth splitting: ${shell} bytes`);
  assert.ok(r.before - r.after > shell - 500, `the whole shell left the document: ${r.before} -> ${r.after}`);

  // Three assets, never two: concatenating the vendor and app scripts into one
  // file is exactly the mistake the offsets below rule out.
  assert.equal(r.assets.length, 3);
  assert.deepEqual(r.assets.map(a => a.name.slice(-3)), ['css', '.js', '.js'], 'the stylesheet, then the two scripts in document order');
  for (const a of r.assets) {
    assert.match(a.name, /^lens-[0-9a-f]{12}\.(?:js|css)$/, 'the name the processor whitelists');
    assert.equal(a.bytes, a.content.length);
  }
  const [css, vendor, app] = r.assets;
  assert.ok(r.html.includes(`<link rel="stylesheet" href="../../../assets/${css.name}">`), 'the three contiguous <style> blocks became one stylesheet');
  assert.ok(r.html.includes(`<script src="../../../assets/${vendor.name}"></script>`), 'classic script tags: the load order is the block order');

  // THE invariant. The bootstrap reads the model with
  // document.getElementById("mvnlens-data"), so hoisting it above the data
  // block makes that return null and every report on the site renders empty.
  const at = (needle) => { const i = r.html.indexOf(needle); assert.ok(i >= 0, `${needle} is in the output`); return i; };
  const data = at('<script id="mvnlens-data" type="application/json">');
  assert.ok(at(css.name) < data, 'the stylesheet still loads before the data block');
  assert.ok(at(vendor.name) < data, 'the vendor bundle still loads before the data block');
  assert.ok(at(app.name) > data, 'the app bootstrap still loads AFTER the data block');

  // Nothing of the shell is lost: the bytes moved, they did not disappear.
  assert.ok(String(css.content).includes('.mvnlens-timeline{position:relative}'), 'the first stylesheet');
  assert.ok(String(css.content).includes('.mvnlens-table td{padding:2px}'), 'the third stylesheet');
  assert.ok(String(vendor.content).includes('/*! pako'), 'the vendor bundle');
  assert.ok(String(app.content).includes('getElementById("mvnlens-data")'), 'the bootstrap');
  assert.deepEqual(extractModelFromHtml(r.html), model, 'the data block is untouched');
  assert.ok(!/<script>/.test(r.html), 'no inline script survived the split');
  assert.ok(!r.html.includes('<style'), 'no inline stylesheet survived the split');
  assert.equal(r.html.split('<script').length - 1, 3, 'the two references and the data block');
});

test('splitReportHtml gives two reports sharing a shell the very same asset names', () => {
  const other = fixtureModel();
  other.session.totalMs = 424242;
  const a = splitReportHtml(fakeShellReportHtml(fixtureModel()));
  const b = splitReportHtml(fakeShellReportHtml(other, { gzip: true }));
  assert.equal(a.split, true, a.reason);
  assert.equal(b.split, true, b.reason);
  assert.notEqual(a.html, b.html, 'the two reports differ (in the data block, which is all that ever differs)');
  assert.deepEqual(b.assets.map(x => x.name), a.assets.map(x => x.name), 'content-hashed: the shared shell is one set of files');
  for (let i = 0; i < a.assets.length; i++) assert.ok(b.assets[i].content.equals(a.assets[i].content), a.assets[i].name);

  // A shell that really differs gets other names — the hash is of the content, not of the position.
  const changed = splitReportHtml(fakeShellReportHtml(fixtureModel(), { app: '\nwindow.EXTRA=1;' }));
  assert.equal(changed.split, true, changed.reason);
  assert.deepEqual(changed.assets.slice(0, 2).map(x => x.name), a.assets.slice(0, 2).map(x => x.name), 'the untouched blocks keep their names');
  assert.notEqual(changed.assets[2].name, a.assets[2].name, 'the changed bootstrap gets a new one');
});

test('splitReportHtml leaves reports alone when the shell is not the shape it expects', () => {
  const model = fixtureModel();
  const shell = fakeShellReportHtml(model);
  const cases = [
    ['no data block', shell.replace(' id="mvnlens-data" type="application/json"', ''), /no embedded model/],
    ['unterminated data block', truncateAtBlock(shell) + '{"x":1}', /unterminated data block/],
    ['a stray element between the stylesheets', shell.replace('</style>\n<style>', '</style>\n<p>hi</p>\n<style>'), /<style> blocks are not contiguous/],
    ['a shell block carrying "</script"', fakeShellReportHtml(model, { app: '\n/* </script */' }), /contains "<\/script"/],
    ['an attribute on a shell block', shell.replace('<script>/*! pako', '<script defer>/*! pako'), /unexpected attributes on <script>/],
    ['no shell script at all', '<html><style>.a{color:red}</style><script id="mvnlens-data" type="application/json">{"a":1}</script></html>', /no <script> block besides the data block/],
    ['the data block nested in another block', '<html><body><script>var tpl = \'<script id="mvnlens-data" type="application/json">{"a":1}</script>\';</script></body></html>', /not a top-level block/],
    ['a shell too small to be worth three requests', fakeReportHtml(model, { pako: true }), /under the 65536-byte split threshold/],
    ['a comment that never ends', shell.replace('<div id="app"></div>', '<!-- the <script> below is generated'), /unterminated HTML comment/],
  ];
  for (const [name, html, reason] of cases) {
    const r = splitReportHtml(html);
    assert.equal(r.split, false, name);
    assert.match(r.reason, reason, name);
    assert.equal(r.html, html, `${name}: html unchanged`);
    assert.deepEqual(r.assets, [], `${name}: no asset`);
    assert.equal(r.before, r.after, name);
    assert.equal(r.before, Buffer.byteLength(html, 'utf8'), name);
  }
});

test('splitReportHtml is not fooled by a data-looking tag inside the bootstrap', () => {
  // The real javadoc report carries a literal '<script id="mvnlens-data" …>' in
  // its bootstrap. It must travel into the asset verbatim, and what is
  // externalised must be the bootstrap block, not the decoy's.
  const model = fixtureModel();
  const decoy = '\n/* reads <script id="mvnlens-data" type="application/json"> */';
  const r = splitReportHtml(fakeShellReportHtml(model, { app: decoy }));
  assert.equal(r.split, true, r.reason);
  assert.equal(r.html.split('<script id="mvnlens-data"').length, 2, 'exactly one data tag is left inline: the real one');
  assert.ok(String(r.assets[2].content).includes(decoy), 'the decoy travelled into the bootstrap asset');
  assert.deepEqual(extractModelFromHtml(r.html), model);
});

test('splitReportHtml is not fooled by a start tag quoted in an HTML comment', () => {
  // report.html is third-party output, and mvn-lens does put a comment (its
  // bundled-third-party NOTICE) right where the block scan passes. A
  // comment-blind scan reads a QUOTED start tag as a real block, runs on to the
  // next '</script>' and carries the comment's '-->' into the asset file: the
  // published report is then a single unterminated comment swallowing the data
  // block and the bootstrap reference — a blank page, reported as a successful
  // split. The comment must be left where it is, whole.
  const model = fixtureModel();
  const shell = fakeShellReportHtml(model);
  const cases = [
    ['a bare <script> quoted before the stylesheets', shell.replace('<style>', '<!-- the <script> below is generated -->\n<style>')],
    ['a NOTICE between the stylesheets and the vendor bundle', shell.replace('<div id="app"></div>', '<!--\n  NOTICE: the block below was <script> in mvn-lens 1.x\n-->\n<div id="app"></div>')],
    ['a bare <style> quoted in a comment', shell.replace('<div id="app"></div>', '<!-- theming moved out of <style> in 2.x -->\n<div id="app"></div>')],
  ];
  for (const [name, html] of cases) {
    const r = splitReportHtml(html);
    assert.equal(r.split, true, `${name}: ${r.reason}`);
    assert.equal(r.assets.length, 3, name);
    assert.equal(r.html.split('<!--').length - 1, 1, `${name}: the comment still opens once`);
    assert.equal(r.html.split('-->').length - 1, 1, `${name}: and still closes — an unterminated one hides the rest of the document`);
    assert.deepEqual(extractModelFromHtml(r.html), model, `${name}: the data block is still in the document`);
    const data = r.html.indexOf('<script id="mvnlens-data"');
    assert.ok(r.html.indexOf(r.assets[2].name) > data, `${name}: the bootstrap still loads after the data block`);
    for (const a of r.assets) {
      assert.ok(!String(a.content).includes('-->'), `${name}: no comment terminator travelled into ${a.name}`);
      if (a.name.endsWith('.js')) assert.doesNotThrow(() => new Function(String(a.content)), `${name}: ${a.name} is JavaScript`);   // eslint-disable-line no-new-func
    }
  }
});

test('splitReportHtml splits a report from an older mvn-lens, whose data block is id="mvnflight-data"', () => {
  const model = fixtureModel();
  const r = splitReportHtml(fakeShellReportHtml(model, { id: 'mvnflight-data' }));
  assert.equal(r.split, true, r.reason);
  assert.equal(r.assets.length, 3);
  assert.deepEqual(r.assets.map(a => a.name), splitReportHtml(fakeShellReportHtml(model)).assets.map(a => a.name),
    'the shell is the same bytes whatever the data block is called');
  const data = r.html.indexOf('<script id="mvnflight-data" type="application/json">');
  assert.ok(data > 0, 'the legacy data block is left inline');
  assert.ok(r.html.indexOf(r.assets[2].name) > data, 'the bootstrap still loads after the data block');
  assert.deepEqual(extractModelFromHtml(r.html), model);
});

test('splitReportHtml runs AFTER compressReportHtml, and would break it the other way round', () => {
  const model = fixtureModel();
  const html = fakeShellReportHtml(model);
  const c = compressReportHtml(html);
  assert.equal(c.compressed, true, c.reason);
  const r = splitReportHtml(c.html);
  assert.equal(r.split, true, r.reason);
  assert.equal(r.assets.length, 3);
  assert.deepEqual(extractModelFromHtml(r.html), model, 'a gzip+base64 data block splits like a plain one');

  // The published order is compress-then-split for a reason: the split moves
  // pako and the "gzip:" decoder out of the document, and the compressor then
  // refuses to re-encode a block the renderer could no longer inflate.
  const first = splitReportHtml(html);
  assert.equal(first.split, true, first.reason);
  assert.deepEqual(first.assets.map(a => a.name), r.assets.map(a => a.name), 'the shell is the same bytes whatever the data block holds');
  const late = compressReportHtml(first.html);
  assert.equal(late.compressed, false);
  assert.match(late.reason, /no gzip decoder/);
});

test('splitReportHtml declines the sample fixture, which has no shell to share', () => {
  const sample = fs.readFileSync(path.join(FIXTURES, 'sample-report', 'report.html'), 'utf8');
  const r = splitReportHtml(sample);
  assert.equal(r.split, false);
  assert.equal(r.html, sample, 'html unchanged');
  assert.deepEqual(r.assets, []);
});

test('splitReportHtml lifts the shell out of a real mvn-lens report', { skip: !fs.existsSync(REAL_REPORT) && 'real report not available' }, () => {
  const html = compressReportHtml(fs.readFileSync(REAL_REPORT, 'utf8')).html;
  const r = splitReportHtml(html);
  assert.equal(r.split, true, r.reason);
  assert.equal(r.assets.length, 3, 'one stylesheet and two scripts');
  assert.ok(r.assets.reduce((n, a) => n + a.bytes, 0) > 1024 * 1024, 'the shell is the megabyte the site was storing per report');
  assert.ok(r.after < r.before - 1024 * 1024, `${r.before} -> ${r.after}`);
  const data = r.html.indexOf('<script id="mvnlens-data"');
  assert.ok(r.html.indexOf(r.assets[2].name) > data, 'the bootstrap still loads after the data block');
  assert.deepEqual(extractModelFromHtml(r.html), extractModelFromHtml(html), 'the embedded model is identical');
});
