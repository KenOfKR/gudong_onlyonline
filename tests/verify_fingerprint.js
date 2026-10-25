/* ============================================================================
 * tests/verify_fingerprint.js — xuExposure 行為指紋特徵純度檢驗
 * 執行方式: node tests/verify_fingerprint.js
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

const SEEDS = 500;
let round3Evaluations = 0;
let xuTop1Count = 0;
let xuTop2Count = 0;

for (let s = 1; s <= SEEDS; s++) {
  const seed = `fp_eval_${s}`;
  // 跑基準對局，收集自然對局下的未宣告投票指紋
  const room = playOne(GD, { seed, brains: {} });
  const xu = room.players.find(p => p.role === '許願');
  if (!xu) continue;

  const truthOf = (r, beast) => {
    const vr = room.rounds[r]?.voteResults;
    if (vr?.rank1?.name === beast) return vr.rank1.isReal;
    if (vr?.rank2?.name === beast) return vr.rank2.isReal;
    // 真實地面真值
    return room.beastTruth ? room.beastTruth[r]?.[beast] : null;
  };

  // 在第 3 輪投票前評估累積的行為指紋
  const exposures = GD.Mind.xuExposure(room, 2, truthOf);
  
  // 排除壞人自己（老朝奉角度排除自己與藥不然）
  const candidates = Object.entries(exposures)
    .filter(([pid]) => {
      const role = room.players.find(p => p.id === pid)?.role;
      return role !== '老朝奉' && role !== '藥不然';
    })
    .sort((a, b) => b[1] - a[1]);

  if (candidates.length > 0) {
    round3Evaluations++;
    if (candidates[0][0] === xu.id) xuTop1Count++;
    if (candidates.slice(0, 2).some(c => c[0] === xu.id)) xuTop2Count++;
  }
}

const top1Rate = xuTop1Count / round3Evaluations;
const randomBaseline = 1 / 6; // 6 名候選好人中隨機猜

console.log('================================================================');
console.log('🎯 xuExposure 行為指紋 Top-1 命中率檢驗 (500 局)');
console.log('================================================================');
console.log(`評估樣本數 (第 3 輪):     ${round3Evaluations}`);
console.log(`隨機基準率 (Random):      ${(randomBaseline * 100).toFixed(2)}%`);
console.log(`指紋 Top-1 命中許願率:    ${(top1Rate * 100).toFixed(2)}% (${xuTop1Count} 次)`);
console.log(`指紋 Top-2 包含許願率:    ${((xuTop2Count / round3Evaluations) * 100).toFixed(2)}%`);
console.log('----------------------------------------------------------------');

const se = Math.sqrt((top1Rate * (1 - top1Rate)) / round3Evaluations);
const z = (top1Rate - randomBaseline) / Math.sqrt((randomBaseline * (1 - randomBaseline)) / round3Evaluations);
console.log(`Z-Score vs 隨機:          ${z.toFixed(2)} (需 > 1.96 達顯著)`);
console.log(`95% 信賴區間:             [${((top1Rate - 1.96 * se) * 100).toFixed(1)}%, ${((top1Rate + 1.96 * se) * 100).toFixed(1)}%]`);
console.log('================================================================');