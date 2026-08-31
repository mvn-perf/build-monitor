/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Wrapper of the "summary" action (summary/action.yml → runs.main): runs
 * src/summary.js and turns its result into the process exit code.
 */
'use strict';

const util = require('../src/util');

require('../src/summary').run()
  .then(r => { process.exitCode = r.exitCode; })
  .catch(e => { util.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
