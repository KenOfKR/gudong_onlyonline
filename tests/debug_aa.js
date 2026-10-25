/* ============================================================================
 * tests/debug_aa.js — 單步時序分岔偵錯器
 * 執行: node tests/debug_aa.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGD() {
  const sandbox = { window: {}, console: console, Math: Math, JSON: JSON };
  sandbox.window.GD = sandbox.GD = {};
  const files = [
    'js/config.js', 'js/utils.js', 'js/roster.js', 'js/core/rules.js', 
    'js/core/claims.js', 'js/core/engine.js', 'js/bot/genes.js', 
    'js/bot/mind.js', 'js/bot/strategy.js', 'js/bot/speech.js'
  ];
  files.forEach(f => {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInNewContext(code, sandbox);
  });
  return sandbox.GD;
}

const { playOne } = require('./lib/play');
const GD = loadGD();

const seed = 'bench_1';
console.log(`🔍 正在診斷 Seed: ${seed} ...`);

const r1 = playOne(GD, { seed, brains: {} });
const r2 = playOne(GD, { seed, brains: {} });

// 比對三輪的每一輪 turnLogs, speeches, votes
let diverged = false;
for (let r = 0; r < 3; r++) {
  const rd1 = r1.rounds[r];
  const rd2 = r2.rounds[r];
  if (!rd1 || !rd2) break;

  // 1. 比對傳遞順序
  if (JSON.stringify(rd1.passOrder) !== JSON.stringify(rd2.passOrder)) {
    console.log(`❌ 第 ${r + 1} 輪傳遞順序 (passOrder) 出現分岔！`);
    console.log('第一次:', rd1.passOrder);
    console.log('第二次:', rd2.passOrder);
    diverged = true;
    break;
  }

  // 2. 比對發言
  const sp1 = (rd1.speeches || []).map(s => ({ p: s.playerId, t: s.text }));
  const sp2 = (rd2.speeches || []).map(s => ({ p: s.playerId, t: s.text }));
  if (JSON.stringify(sp1) !== JSON.stringify(sp2)) {
    console.log(`❌ 第 ${r + 1} 輪發言出現分岔！`);
    console.log('第一次發言:', sp1);
    console.log('第二次發言:', sp2);
    diverged = true;
    break;
  }

  // 3. 比對投票票型
  if (JSON.stringify(rd1.votes) !== JSON.stringify(rd2.votes)) {
    console.log(`❌ 第 ${r + 1} 輪投票出現分岔！`);
    console.log('第一次投票:', rd1.votes);
    console.log('第二次投票:', rd2.votes);
    diverged = true;
    break;
  }
}

if (!diverged) {
  // 比對終局鑑人
  if (JSON.stringify(r1.personVotes) !== JSON.stringify(r2.personVotes)) {
    console.log('❌ 終局鑑人 (personVotes) 出現分岔！');
    console.log('第一次:', r1.personVotes);
    console.log('第二次:', r2.personVotes);
  } else {
    console.log('✅ 前三輪及鑑人完全一致，可能是 final/why 台詞字串微差！');
  }
}