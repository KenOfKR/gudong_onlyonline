'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TESTS = [
  'abstain-policy-smoke.js',
  'claims-natural-language-regression.js',
  'conversation-continuity-smoke.js',
  'gemini-fallback-smoke.js',
  'human-afk-rescue-regression.js',
  'human-attention-regression.js',
  'human-claim-role-flip-regression.js',
  'mind_gene_patch_smoke.js',
  'player-reasoning-regression-smoke.js',
  'public-speech-attribution-smoke.js',
  'room-0947-natural-language-regression.js',
  'tactics-smoke-random-diagnostic.js',
  'tactics-smoke.js',
  'test_bg_takeover.js',
  'test_net_failover.js',
  'test_net_race.js',
  'ui-smoke.js',
  'v10-8-10-timeline-consensus-regression.js',
  'v10-8-11-ambush-privacy-regression.js',
  'v10-8-11-fang-strategy-regression.js',
  'v10-8-11-source-provenance-regression.js',
  'v10-8-12-causal-learning-regression.js',
  'v10-8-12-forecast-tie-regression.js',
  'v10-8-12-position-validation-regression.js',
  'v10-8-12-public-evidence-regression.js',
  'v10-8-12-role-capability-regression.js',
  'v10-8-12-xu-roleplay-regression.js',
  'v10-8-13-claim-context-regression.js',
  'v10-8-13-team-role-bluff-regression.js',
  'v10-8-13-yao-ambush-pass-regression.js',
  'v10-8-3-reasoning-smoke.js',
  'v10-8-5-speed-speech-smoke.js',
  'v10-8-6-content-driven-speech-smoke.js',
  'v10-8-8-voting-coalition-regression.js',
  'v10-8-9-observation-firewall-regression.js',
  'v10-8-public-roleplay-smoke.js',
  'v10-8-strategic-info-smoke.js',
  'vote-policy-smoke.js',
  'v10-8-14-dialogue-claims-regression.js',
  'v10-8-14-role-inference-regression.js',
  'v10-8-14-role-persistence-regression.js',
  'v10-8-14-score-desperation-regression.js',
  'v10-8-16-public-attribution-regression.js',
  'v10-8-16-dialogue-coherence-regression.js',
  'v10-8-16-role-bluff-regression.js',
  'v10-8-16-role-posterior-regression.js',
  'v10-8-16-evil-coalition-regression.js',
  'v10-8-17-inspection-report-regression.js',
  'v10-8-17-vote-intents-regression.js',
  'v10-8-18-semantic-negation-regression.js',
  'v10-8-18-language-understanding-regression.js',
  'v10-8-18-role-discussion-regression.js',
  'v10-8-18-dialogue-diversity-regression.js',
  'v10-8-18-tactical-language-regression.js'
];

const retryOnce = new Set();
const log = [];
const results = [];
for (const file of TESTS) {
  const fullPath = path.join(__dirname, file);
  if (!fs.existsSync(fullPath)) {
    results.push({ file, status: 'FAIL', attempts: 0, reason: 'test file missing' });
    log.push(`===== ${file} =====\nMISSING TEST FILE\n`);
    continue;
  }
  const maxAttempts = retryOnce.has(file) ? 2 : 1;
  let output = '';
  let status = 1;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const run = spawnSync(process.execPath, [fullPath], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env }
    });
    output = `${run.stdout || ''}${run.stderr || ''}`;
    status = run.status === null ? (run.error ? 1 : 1) : run.status;
    if (status === 0) break;
    if (attempt < maxAttempts) log.push(`ATTEMPT_FAIL ${file} attempt=${attempt} status=${status}\n${output}\n`);
  }
  if (status === 0) {
    const label = attempts > 1 ? 'RETRY_PASS' : 'PASS';
    results.push({ file, status: 'PASS', attempts });
    log.push(`===== ${file} =====\n${output}\n${label} ${file} attempt=${attempts}\n`);
    process.stdout.write(`${label} ${file}\n`);
  } else {
    results.push({ file, status: 'FAIL', attempts, reason: output.slice(-2500) });
    log.push(`===== ${file} =====\n${output}\nFAIL ${file} attempts=${attempts}\n`);
    process.stdout.write(`FAIL ${file} attempts=${attempts}\n`);
  }
}

const pass = results.filter(x => x.status === 'PASS').length;
const fail = results.length - pass;
const summary = `SUMMARY pass=${pass} fail=${fail} total=${results.length} retried_pass=${results.filter(x => x.status === 'PASS' && x.attempts > 1).length}`;
log.push(summary + '\n');
const outputPath = path.join(ROOT, 'TEST-RUN_v10.8.18.log');
fs.writeFileSync(outputPath, log.join('\n'), 'utf8');
console.log(summary);
console.log(`Log: ${path.relative(ROOT, outputPath)}`);
if (fail) {
  results.filter(x => x.status === 'FAIL').forEach(x => console.error(`- ${x.file}: ${x.reason || 'failed'}`));
  process.exitCode = 1;
}
