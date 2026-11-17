'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const totalTests = 68;
const batchSize = 5;
const batchCount = Math.ceil(totalTests / batchSize);
let failed = false;
for (let batch = 0; batch < batchCount; batch++) {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'run-v10-9.1-regressions.js'), String(batch)], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 90000,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env }
  });
  process.stdout.write(run.stdout || '');
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.status !== 0) failed = true;
}
if (failed) {
  console.error('v10.9.1 regression suite: one or more batches failed. Inspect TEST-RUN_v10.9.1_batch*.log.');
  process.exitCode = 1;
} else {
  console.log(`v10.9.1 regression suite: PASS ${totalTests}/${totalTests}, FAIL 0`);
}
