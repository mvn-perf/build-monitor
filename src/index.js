#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Action wrapper of the root "Build monitor" action (action.yml → runs.main).
 * The logic lives in main.js so tests can call run() in-process with an
 * injected fetch; this file only maps the result to the process exit code.
 */
'use strict';

const util = require('./util');

require('./main').run().then(r => {
  process.exitCode = r.exitCode;
}).catch(e => {
  util.error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
