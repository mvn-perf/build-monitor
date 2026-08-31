#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Tiny static file server for previewing a generated site locally — browsers
 * refuse to fetch data/history.json over file: URLs, so the monitoring page
 * must be served over HTTP.
 *
 *   node scripts/serve.js [dir] [port]     (default .tmp/demo-site, port 8787; 0 = any free port)
 *   PORT=9000 node scripts/serve.js .tmp/demo-site-fetch
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '.tmp', 'demo-site'));
const port = Number(process.argv[3] || process.env.PORT || 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Not a directory: ${root}\nGenerate a demo site first: node scripts/demo.js`);
  process.exit(1);
}

/** True when `target` is `base` itself or inside it (no `..` escape). */
function isWithin(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
    res.end('method not allowed\n');
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(String(req.url || '/').split('?')[0].split('#')[0]);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request\n');
    return;
  }
  if (urlPath.includes('\0')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request\n');
    return;
  }
  let file = path.normalize(path.join(root, urlPath));
  if (!isWithin(root, file)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden\n');
    return;
  }
  let stat = null;
  try { stat = fs.statSync(file); } catch (e) { /* 404 below */ }
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    try { stat = fs.statSync(file); } catch (e) { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + urlPath + '\n');
    return;
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use — pass another one: node scripts/serve.js <dir> <port>`);
  else console.error(String(e));
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root}`);
  console.log(`  → http://127.0.0.1:${server.address().port}/`);   // port 0 → the one the OS picked
});
