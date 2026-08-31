#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Entry point of the `report` action (report/action.yml → runs.main). The
 * logic lives in src/report.js so tests can run it in-process.
 */
'use strict';

const util = require('../src/util');

require('../src/report').run().then(r => {
  process.exitCode = r.exitCode;
}).catch(e => {
  util.error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
