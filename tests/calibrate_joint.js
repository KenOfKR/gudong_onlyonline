/* ============================================================================
 * tests/calibrate_joint.js — 步驟 2c：六控八兩人聯合約束真實似然統計
 * 執行方式: node tests/calibrate_joint.js
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

const SEEDS = 600;
let totalRounds = 0;
let bothEvilCount = 0;
const EVIL = ['老朝奉', '藥不然', '鄭國渠'];

for (let s = 1; s <= SEEDS; s++) {
  const seed = `calib_pair_${s}`;
  const room = playOne(GD, { seed, brains: {} });

  for (let r = 0; r < 3; r++) {
    const rd = room.rounds[r];
    if (!rd || (rd.passOrder || []).length !== 8) continue;
    
    totalRounds++;
    const p6 = room.players.find(p => p.id === rd.passOrder[5]);
    const p8 = room.players.find(p => p.id === rd.passOrder[7]);

    const p6IsEvil = EVIL.includes(p6.role);
    const p8IsEvil = EVIL.includes(p8.role);

    if (p6IsEvil && p8IsEvil) bothEvilCount++;
  }
}

// 理論隨機基準：8 人中挑 2 人，剛好 3 壞人中取 2 人的機率 = C(3,2) / C(8,2) = 3 / 28 ≈ 10.71%
const empiricalRate = bothEvilCount / totalRounds;
const randomRate = 3 / 28;
const jointLLR = Math.log((bothEvilCount + 1) / (totalRounds - bothEvilCount + 1)) - Math.log(randomRate / (1 - randomRate));

console.log('================================================================');
console.log('📊 六控八 (兩人同為壞人) 聯合真實統計結果 (600 局)');
console.log('================================================================');
console.log(`總輪次數:                  ${totalRounds}`);
console.log(`理論隨機雙壞人率:          ${(randomRate * 100).toFixed(2)}%`);
console.log(`真實出現雙壞人率:          ${(empiricalRate * 100).toFixed(2)}% (${bothEvilCount} 次)`);
console.log(`真實聯合對數似然比 (LLR):  ${jointLLR >= 0 ? '+' : ''}${jointLLR.toFixed(3)}`);
console.log('================================================================');