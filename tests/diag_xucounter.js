/* ============================================================================
 * tests/diag_xucounter.js — 許願反偵測決策觸發率診斷
 * 執行方式: node tests/diag_xucounter.js
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

const SEEDS = 100;
let totalXuVotes = 0;
let counterTriggeredCount = 0;
let zeroExposureCount = 0;
let flagReadFailureCount = 0;

for (let s = 1; s <= SEEDS; s++) {
  const seed = `diag_xu_${s}`;
  
  // 注入監聽器：只針對開啟 xuCounter 的好人局
  const brains = {};
  // 先跑一次開局抓出許願 ID
  const testRoom = playOne(GD, { seed, brains: {} });
  const xuPlayer = testRoom.players.find(p => p.role === '許願');
  if (!xuPlayer) continue;

  brains[xuPlayer.id] = { xuCounter: true };

  // 攔截 strategy.js 投票決策
  const origBallot = GD.Strategy.ballot;
  GD.Strategy.ballot = function(bot, room) {
    if (bot.id === xuPlayer.id) {
      totalXuVotes++;
      
      // 1. 檢查旗標讀取
      const hasFlag = bot.brain?.xuCounter ?? (GD.FLAGS && GD.FLAGS.xuCounter);
      if (!hasFlag) flagReadFailureCount++;

      // 2. 檢查曝光度計算是否永遠為 0
      const truthOf = (r, b) => {
        const vr = room.rounds[r]?.voteResults;
        return vr && vr.rank2 && vr.rank2.name === b ? vr.rank2.isReal : null;
      };
      const exp = GD.Mind.xuExposure ? GD.Mind.xuExposure(room, room.currentRoundIdx, truthOf) : {};
      const myExp = exp[bot.id] || 0;
      if (myExp === 0) zeroExposureCount++;
    }
    return origBallot.apply(this, arguments);
  };

  playOne(GD, { seed, brains });
  GD.Strategy.ballot = origBallot; // 還原
}

console.log('================================================================');
console.log('🔍 xuCounter 決策觸發率診斷結果 (100 局)');
console.log('================================================================');
console.log(`許願投票總次數:             ${totalXuVotes}`);
console.log(`旗標讀取失敗次數 (未啟用):   ${flagReadFailureCount}`);
console.log(`曝光度為 0 的次數:          ${zeroExposureCount} / ${totalXuVotes} (${((zeroExposureCount/totalXuVotes)*100).toFixed(1)}%)`);
console.log('================================================================');