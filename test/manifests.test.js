/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Sanity of the three action manifests against the design (SPEC.md): every
 * documented input exists with a description and a default (or is required),
 * every documented output exists, the action runs on node24 from a file that
 * exists, and every input name is read somewhere in the sources. A manifest
 * that does not exist yet skips its tests with a clear message.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// A tiny YAML reader — enough for action manifests: nested block mappings,
// plain / quoted / folded (>) / literal (|) scalars, sequences of scalars,
// comments. Not a general YAML parser (no flow collections, anchors, tags).
// Every scalar is returned as a string.
// ---------------------------------------------------------------------------

function parseYaml(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) { rows.push({ n: i + 1, indent: -1, text: '', blank: true, raw: line }); continue; }
    const indent = /^ */.exec(line)[0].length;
    rows.push({ n: i + 1, indent, text: line.slice(indent), blank: false, raw: line });
  }
  const { value } = parseBlock(rows, 0, 0);
  return value === undefined ? {} : value;
}

function nextContent(rows, i) {
  while (i < rows.length && rows[i].blank) i++;
  return i;
}

function parseBlock(rows, start, indent) {
  let i = nextContent(rows, start);
  if (i >= rows.length || rows[i].indent < indent) return { value: undefined, next: i };
  const blockIndent = rows[i].indent;
  if (/^- /.test(rows[i].text) || rows[i].text === '-') return parseSequence(rows, i, blockIndent);
  const obj = {};
  while (i < rows.length) {
    i = nextContent(rows, i);
    if (i >= rows.length || rows[i].indent < blockIndent) break;
    const row = rows[i];
    if (row.indent > blockIndent) throw new Error(`line ${row.n}: unexpected indentation`);
    const m = /^([^:#'"][^:]*?|'[^']*'|"[^"]*")\s*:(?:\s+(.*))?$/.exec(row.text);
    if (!m) throw new Error(`line ${row.n}: expected "key: value", got "${row.text}"`);
    const key = unquote(m[1].trim());
    const rest = m[2] === undefined ? '' : m[2].trim();
    i++;
    if (rest === '' || rest.startsWith('#')) {
      const j = nextContent(rows, i);
      if (j < rows.length && rows[j].indent > blockIndent) {
        const r = parseBlock(rows, j, blockIndent + 1);
        obj[key] = r.value;
        i = r.next;
      } else {
        obj[key] = null;
      }
    } else if (/^[>|]/.test(rest)) {
      const r = blockScalar(rows, i, blockIndent, rest);
      obj[key] = r.value;
      i = r.next;
    } else {
      obj[key] = scalar(rest);
    }
  }
  return { value: obj, next: i };
}

function parseSequence(rows, start, indent) {
  const list = [];
  let i = start;
  while (i < rows.length) {
    i = nextContent(rows, i);
    if (i >= rows.length || rows[i].indent < indent) break;
    const row = rows[i];
    if (row.indent > indent || !/^-(\s|$)/.test(row.text)) throw new Error(`line ${row.n}: expected a "- item"`);
    const rest = row.text.replace(/^-\s*/, '');
    i++;
    if (/^[>|]/.test(rest)) { const r = blockScalar(rows, i, indent, rest); list.push(r.value); i = r.next; }
    else list.push(scalar(rest));
  }
  return { value: list, next: i };
}

function blockScalar(rows, start, parentIndent, header) {
  const folded = header.startsWith('>');
  const chomp = /-/.test(header) ? 'strip' : (/\+/.test(header) ? 'keep' : 'clip');
  const collected = [];
  let i = start;
  let contentIndent = null;
  while (i < rows.length) {
    const row = rows[i];
    if (row.blank) { collected.push(''); i++; continue; }
    if (row.indent <= parentIndent) break;
    if (contentIndent === null) contentIndent = row.indent;
    collected.push(row.raw.slice(Math.min(contentIndent, row.indent)));
    i++;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  let value;
  if (folded) {
    value = '';
    for (const l of collected) value += l === '' ? '\n' : (value === '' || value.endsWith('\n') ? l : ' ' + l);
  } else {
    value = collected.join('\n');
  }
  if (chomp !== 'strip') value += '\n';
  // Trailing blank rows belong to the next block, so back up over them.
  while (i > start && rows[i - 1].blank) i--;
  return { value, next: i };
}

function scalar(s) {
  const t = s.trim();
  if (/^['"]/.test(t)) return unquote(t);
  // A plain scalar ends at " #" (comment).
  const m = /^(.*?)(?:\s+#.*)?$/.exec(t);
  return m[1].trim();
}

function unquote(t) {
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\(["\\/nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c));
  }
  return t;
}

// ---------------------------------------------------------------------------
// What SPEC.md documents for each action. `defaults` lists the defaults the
// spec states explicitly (compared as trimmed strings); every other input only
// has to exist with a description and a default or `required: true`.
// ---------------------------------------------------------------------------

const TOKEN = /\$\{\{\s*github\.token\s*\}\}/;

const EXPECTED = {
  'report/action.yml': {
    title: 'report',
    inputs: ['report', 'step-name', 'job-name', 'label', 'github-token', 'inbox-prefix', 'site-url', 'compress', 'if-no-files-found', 'fail-on-error', 'commit-message'],
    defaults: {
      report: 'target/mvnlens/report.html',
      'inbox-prefix': 'build-monitor-inbox/',
      compress: 'true',
      'if-no-files-found': 'warn',
      'fail-on-error': 'false',
      'github-token': TOKEN,
    },
    outputs: ['found', 'published', 'key', 'report-path', 'monitor-url', 'report-url', 'job-id', 'step-name', 'maven-total-ms', 'commit-sha', 'reason'],
  },
  'summary/action.yml': {
    title: 'summary',
    inputs: ['github-token', 'inbox-prefix', 'site-url', 'title'],
    optionalInputs: ['fail-on-error'],
    defaults: {
      'inbox-prefix': 'build-monitor-inbox/',
      'github-token': TOKEN,
    },
    outputs: ['monitor-url', 'reports-count'],
  },
  'action.yml': {
    title: 'build-monitor',
    inputs: ['github-token', 'repository', 'branch', 'site-dir', 'site-url', 'title', 'inbox-prefix', 'workflows', 'exclude-workflows',
      'include-self', 'run-id', 'sweep-runs', 'lookback-days', 'include-fork-runs', 'concurrency', 'request-pages-build', 'dry-run',
      // Not in the SPEC input list but referenced by its algorithm ("dry-run → write to output-dir only") and by .github/workflows/ci.yml.
      'output-dir'],
    defaults: {
      branch: 'gh-pages',
      'inbox-prefix': 'build-monitor-inbox/',
      'include-self': 'false',
      'sweep-runs': '20',
      'lookback-days': '90',
      'include-fork-runs': 'false',
      concurrency: '4',
      'request-pages-build': 'true',
      'dry-run': 'false',
      'github-token': TOKEN,
    },
    outputs: ['site-url', 'runs-processed', 'runs-total', 'reports-collected', 'commit-sha', 'published', 'reports-bytes'],
  },
};

/**
 * The runner evaluates `${{ … }}` everywhere in a manifest — descriptions and
 * comments included — while it loads the action, and only the `github` and
 * `inputs` contexts exist there. An expression anywhere else ("Unrecognized
 * named-value") makes every job using the action fail before its first step;
 * that regression once broke every assertj job. scripts/check-syntax.js guards
 * it as a lint; this makes it a test.
 *
 * Returns one problem per offending line/value: the raw scan catches comments
 * and keys (which the YAML reader drops), the parsed scan catches values that
 * merely look like an input default.
 */
const EXPR = '${' + '{';

function expressionProblems(text) {
  const problems = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (!line.includes(EXPR)) return;
    if (!/^\s+default:\s/.test(line)) problems.push(`line ${i + 1}: expression outside an input default: ${line.trim()}`);
    else if (!/^\s+default:\s*\$\{\{\s*(github|inputs)\./.test(line)) problems.push(`line ${i + 1}: only the github and inputs contexts exist in a manifest: ${line.trim()}`);
  });
  let doc;
  try { doc = parseYaml(text); } catch (e) { return problems.concat(`the manifest does not parse: ${e.message}`); }
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (node.includes(EXPR) && !/^inputs\.[^.]+\.default$/.test(path)) problems.push(`${path || '(root)'}: expression outside an input default: ${node.trim()}`);
      return;
    }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(doc, '');
  return problems;
}

/** Every .js file under src/ plus the manifest's own directory (report/, summary/), read once. */
function sourcesFor(manifest) {
  const files = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(root, 'src'));
  const own = path.dirname(path.join(root, manifest));
  if (own !== root) walk(own);
  return files.map(f => ({ file: path.relative(root, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
}

// ---------------------------------------------------------------------------
// The YAML reader itself (so a failing manifest test is not a reader bug)
// ---------------------------------------------------------------------------

test('yaml reader: mappings, quoted, folded and literal scalars, comments, sequences', () => {
  const y = [
    '# leading comment',
    "name: 'Build monitor'",
    'description: >-',
    '  Publishes a page.',
    '  Two lines folded.',
    '',
    '  New paragraph.',
    'branding:',
    '  icon: activity   # trailing comment',
    '  color: "blue"',
    'inputs:',
    '  github-token:',
    '    description: \'Token with "actions: read".\'',
    '    required: false',
    '    default: ${{ github.token }}',
    '  report:',
    '    description: |',
    '      keep',
    '        indentation',
    '    default: target/mvnlens/report.html',
    '  empty:',
    '    description: nothing',
    '    default: \'\'',
    'list:',
    '  - one',
    '  - "two"',
    'runs:',
    '  using: node24',
    '  main: src/index.js',
  ].join('\n');
  const doc = parseYaml(y);
  assert.strictEqual(doc.name, 'Build monitor');
  assert.strictEqual(doc.description, 'Publishes a page. Two lines folded.\nNew paragraph.');
  assert.deepStrictEqual(doc.branding, { icon: 'activity', color: 'blue' });
  assert.strictEqual(doc.inputs['github-token'].description, 'Token with "actions: read".');
  assert.strictEqual(doc.inputs['github-token'].default, '${{ github.token }}');
  assert.strictEqual(doc.inputs['github-token'].required, 'false');
  assert.strictEqual(doc.inputs.report.description, 'keep\n  indentation\n');
  assert.strictEqual(doc.inputs.report.default, 'target/mvnlens/report.html');
  assert.strictEqual(doc.inputs.empty.default, '');
  assert.deepStrictEqual(doc.list, ['one', 'two']);
  assert.deepStrictEqual(doc.runs, { using: 'node24', main: 'src/index.js' });
});

test('yaml reader: a key without value and no children is null; CRLF is accepted', () => {
  const doc = parseYaml('a:\r\nb: 1\r\nc:\r\n  d: x\r\n');
  assert.deepStrictEqual(doc, { a: null, b: '1', c: { d: 'x' } });
});

// ---------------------------------------------------------------------------
// The manifests
// ---------------------------------------------------------------------------

for (const [manifest, spec] of Object.entries(EXPECTED)) {
  const file = path.join(root, manifest);
  const missing = !fs.existsSync(file);
  const skip = missing ? `${manifest} is not written yet (another agent owns it); nothing to check` : false;

  test(`${manifest}: parses, runs on node24 from an existing file, branded`, { skip }, () => {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    assert.ok(doc.name && String(doc.name).trim(), `${manifest}: name missing`);
    assert.ok(doc.description && String(doc.description).trim(), `${manifest}: description missing`);
    assert.ok(doc.runs && typeof doc.runs === 'object', `${manifest}: runs block missing`);
    assert.strictEqual(doc.runs.using, 'node24', `${manifest}: runs.using must be node24 (inputs arrive as INPUT_* and the code runs un-bundled)`);
    assert.ok(doc.runs.main, `${manifest}: runs.main missing`);
    assert.ok(!path.isAbsolute(doc.runs.main) && !doc.runs.main.split('/').includes('..'), `${manifest}: runs.main must be a relative path inside the action`);
    assert.ok(fs.existsSync(path.join(path.dirname(file), doc.runs.main)), `${manifest}: runs.main "${doc.runs.main}" does not exist`);
    for (const k of ['pre', 'post']) {
      if (doc.runs[k]) assert.ok(fs.existsSync(path.join(path.dirname(file), doc.runs[k])), `${manifest}: runs.${k} "${doc.runs[k]}" does not exist`);
    }
    assert.deepStrictEqual(doc.branding, { icon: 'activity', color: 'blue' }, `${manifest}: branding must be { icon: activity, color: blue }`);
  });

  test(`${manifest}: every documented input exists with a description and a default (or is required)`, { skip }, () => {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    assert.ok(doc.inputs && typeof doc.inputs === 'object', `${manifest}: inputs block missing`);
    const problems = [];
    for (const name of spec.inputs) {
      const input = doc.inputs[name];
      if (!input || typeof input !== 'object') { problems.push(`input "${name}" is missing`); continue; }
      if (!input.description || !String(input.description).trim()) problems.push(`input "${name}" has no description`);
      const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default') && input.default !== null;
      const required = String(input.required || '').toLowerCase() === 'true';
      if (!hasDefault && !required) problems.push(`input "${name}" has neither a default nor required: true`);
    }
    for (const [name, def] of Object.entries(spec.defaults)) {
      const input = doc.inputs[name];
      if (!input) continue;   // already reported
      const actual = input.default === null || input.default === undefined ? '' : String(input.default).trim();
      if (def instanceof RegExp) { if (!def.test(actual)) problems.push(`input "${name}" default "${actual}" does not match ${def}`); }
      else if (actual !== def) problems.push(`input "${name}" default is "${actual}", SPEC says "${def}"`);
    }
    for (const [name, input] of Object.entries(doc.inputs)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) problems.push(`input "${name}" is not kebab-case`);
      if (input && typeof input === 'object' && !input.description) problems.push(`input "${name}" has no description`);
    }
    assert.deepStrictEqual(problems, [], `${manifest}:\n  ${problems.join('\n  ')}`);
  });

  test(`${manifest}: every documented output exists with a description`, { skip }, () => {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    assert.ok(doc.outputs && typeof doc.outputs === 'object', `${manifest}: outputs block missing`);
    const problems = [];
    for (const name of spec.outputs) {
      const out = doc.outputs[name];
      if (!out || typeof out !== 'object') { problems.push(`output "${name}" is missing`); continue; }
      if (!out.description || !String(out.description).trim()) problems.push(`output "${name}" has no description`);
      // A JavaScript action sets outputs from code; a `value:` expression is a composite-action thing.
      if (out.value !== undefined) problems.push(`output "${name}" carries a value: expression (composite syntax; JavaScript actions set outputs at run time)`);
    }
    assert.deepStrictEqual(problems, [], `${manifest}:\n  ${problems.join('\n  ')}`);
  });

  test(`${manifest}: no ${EXPR} … }} outside an input default`, { skip }, () => {
    const problems = expressionProblems(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(problems, [], `${manifest}: the runner evaluates expressions while loading the action, so one outside an input default fails every job that uses it:\n  ${problems.join('\n  ')}`);
  });

  test(`${manifest}: every input name is read by the sources`, { skip }, () => {
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    const sources = sourcesFor(manifest);
    assert.ok(sources.length, 'no sources found under src/');
    const unread = [];
    for (const name of Object.keys(doc.inputs || {})) {
      const quoted = new RegExp(`['"\`]${name.replace(/[-]/g, '[-_]')}['"\`]`, 'i');
      if (!sources.some(s => quoted.test(s.text))) unread.push(name);
    }
    assert.deepStrictEqual(unread, [], `${manifest}: inputs declared but never read in ${sources.map(s => s.file).join(', ')}: ${unread.join(', ')}`);
  });
}

test('the expression check accepts input defaults and rejects descriptions, comments and other contexts', () => {
  const lines = [
    'name: Demo',
    'description: Does things.',
    'branding:',
    '  icon: activity',
    '  color: blue',
    'inputs:',
    '  github-token:',
    '    description: The token.',
    '    default: ${{ github.token }}',
    '  label:',
    "    description: 'A label.'",
    "    default: ''",
    'outputs:',
    '  key:',
    '    description: A key.',
    'runs:',
    '  using: node24',
    '  main: index.js',
  ];
  assert.deepStrictEqual(expressionProblems(lines.join('\n')), [], 'a manifest whose only expression is an input default is fine');

  const rejects = [
    ['description', l => l.map(x => (x === 'description: Does things.' ? 'description: Publishes ${{ github.repository }}.' : x))],
    ['input description', l => l.map(x => (x === '    description: The token.' ? '    description: Defaults to ${{ github.token }}.' : x))],
    ['output description', l => l.map(x => (x === '    description: A key.' ? '    description: Key of ${{ github.run_id }}.' : x))],
    ['folded description', l => l.map(x => (x === '    description: The token.' ? '    description: >-\n      Token, ${{ github.token }} by default.' : x))],
    ['comment', l => ['# uses ${{ github.token }}'].concat(l)],
    ['runs.main', l => l.map(x => (x === '  main: index.js' ? '  main: ${{ inputs.entry }}' : x))],
    ['another context in a default', l => l.map(x => (x === '    default: ${{ github.token }}' ? '    default: ${{ secrets.GITHUB_TOKEN }}' : x))],
  ];
  for (const [what, mutate] of rejects) {
    const problems = expressionProblems(mutate(lines).join('\n'));
    assert.ok(problems.length, `an expression in the ${what} must be rejected`);
  }
});

test('the three manifests declare distinct action names', () => {
  const present = Object.keys(EXPECTED).filter(m => fs.existsSync(path.join(root, m)));
  const names = present.map(m => String(parseYaml(fs.readFileSync(path.join(root, m), 'utf8')).name || '').trim());
  assert.strictEqual(new Set(names.filter(Boolean)).size, names.length, `duplicate action names: ${names.join(' | ')}`);
});

module.exports = { parseYaml, expressionProblems };
