/* ============================================================================
 * tests/calibrate.js — 步驟 2c：特徵條件機率與似然比校準工具
 * 執行方式: node tests/calibrate.js
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

const TOTAL_SEEDS = 600; // 模擬 600 局，共 4800 人次
console.log(`🚀 啟動似然表模擬校準，跑 ${TOTAL_SEEDS} 局凍結對局...`);

// 統計容器：計數器以角色群組 (good vs lao vs other_evil) 為主
const counts = {
  roles: { good: 0, lao: 0, other_evil: 0 },
  features: {
    // 1. 六控八：位於第 6 位或第 8 位
    sixControlsEight: { good: 0, lao: 0, other_evil: 0 },
    // 2. 言行不一：發言號召 A 獸首，開票卻 0 票投給 A
    speechVoteMismatch: { good: 0, lao: 0, other_evil: 0 },
    // 3. 投公開贗品：把票投給已翻出為贗品的獸首
    votePublicFake: { good: 0, lao: 0, other_evil: 0 },
    // 4. 首發開線：在後手無人提過時率先提出新獸首真偽
    firstClaimer: { good: 0, lao: 0, other_evil: 0 },
    // 5. 順風附和且積極點名質問 (疑似方震/好人激進)
    echoAggressive: { good: 0, lao: 0, other_evil: 0 },
    // 6. 避而不答：被點名質問票型但發言閃躲
    dodgeExplanation: { good: 0, lao: 0, other_evil: 0 }
  }
};

for (let s = 1; s <= TOTAL_SEEDS; s++) {
  const seed = `calib_${s}`;
  const room = playOne(GD, { seed, brains: {}, genes: {} });

  // 遍歷所有玩家，統計當局各特徵表現
  room.players.forEach(p => {
    const group = p.role === '老朝奉' ? 'lao'
                : GD.isGood(p.role) ? 'good' : 'other_evil';
    counts.roles[group]++;

    for (let r = 0; r < 3; r++) {
      const rd = room.rounds[r];
      if (!rd || !rd.voteResults) continue;

      const myPos = (rd.passOrder || []).indexOf(p.id);
      const sp = (rd.speeches || []).find(x => x.playerId === p.id);
      const ballot = (rd.votes || {})[p.id] || {};

      // 檢查特徵 1：六控八
      if (myPos === 5 || myPos === 7) {
        counts.features.sixControlsEight[group]++;
      }

      // 檢查特徵 2：言行不一
      const cb = sp?.p?.callBeast;
      const totalSpend = GD.U.sum(Object.values(ballot));
      if (cb && totalSpend > 0 && !(ballot[cb] > 0)) {
        counts.features.speechVoteMismatch[group]++;
      }

      // 檢查特徵 3：投給已公開贗品
      const r2 = rd.voteResults.rank2;
      if (!r2.isReal && (ballot[r2.name] || 0) > 0) {
        counts.features.votePublicFake[group]++;
      }

      // 檢查特徵 4：首發開線
      const claimsBefore = new Set();
      const spIdx = (rd.speeches || []).indexOf(sp);
      if (spIdx >= 0) {
        (rd.speeches || []).slice(0, spIdx).forEach(prev => {
          (prev.p?.claims || []).forEach(c => claimsBefore.add(c.beast));
        });
        const myClaims = sp?.p?.claims || [];
        if (myClaims.some(c => !claimsBefore.has(c.beast))) {
          counts.features.firstClaimer[group]++;
        }
      }

      // 檢查特徵 5：順風附和且積極點名質問
      if (spIdx >= 0) {
        const myClaims = sp?.p?.claims || [];
        const isEcho = myClaims.length > 0 && myClaims.every(c => claimsBefore.has(c.beast));
        const isHunter = (sp?.p?.accuse && sp.p.accuse.length > 0) || !!sp?.p?.callSuspectId;
        if (isEcho && isHunter) {
          counts.features.echoAggressive[group]++;
        }
      }

      // 檢查特徵 6：避而不答
      const asked = (rd.speeches || []).some((prev, i) => i < spIdx && (prev.p?.asked || []).includes(p.id));
      if (asked && sp && !/(說明|解釋|交代|被騙|看走眼|認壞|依據|因為)/.test(sp.text)) {
        counts.features.dodgeExplanation[group]++;
      }
    }
  });

  if (s % 100 === 0) process.stdout.write(`已完成 ${s}/${TOTAL_SEEDS} 局...\n`);
}

// 輸出校準報告與建議 LLR 表
console.log('\n================================================================');
console.log('📊 步驟 2c：特徵發生率與對數似然比 (LLR) 校準結果');
console.log('================================================================');

const nGood = counts.roles.good;
const nLao = counts.roles.lao;

console.log(`樣本總數：好人次數 = ${nGood}, 老朝奉次數 = ${nLao}`);
console.log('----------------------------------------------------------------');
console.log(
  '特徵名稱'.padEnd(20) + 
  'P(F|好人)'.padEnd(14) + 
  'P(F|老朝奉)'.padEnd(14) + 
  '校準 LLR'.padEnd(12) + 
  '鑑別力判定'
);
console.log('----------------------------------------------------------------');

const calibratedLLR = {};

Object.entries(counts.features).forEach(([feat, c]) => {
  // Laplace 平滑避免除以 0
  const pGood = (c.good + 1) / (nGood + 2);
  const pLao = (c.lao + 1) / (nLao + 2);
  const llr = Math.log(pLao / pGood);

  calibratedLLR[feat] = Number(llr.toFixed(2));

  let verdict = '⚪ 弱特徵 (可考慮精簡)';
  if (Math.abs(llr) >= 0.8) verdict = '🟢 強鑑別特徵';
  else if (Math.abs(llr) >= 0.35) verdict = '🟡 中等鑑別特徵';

  console.log(
    feat.padEnd(20) + 
    (pGood.toFixed(3)).padEnd(14) + 
    (pLao.toFixed(3)).padEnd(14) + 
    (llr >= 0 ? '+' : '') + llr.toFixed(3).padEnd(11) + 
    verdict
  );
});

console.log('================================================================');
console.log('\n💡 建議替換至 js/bot/mind.js 的 calibrated LLR 常數表：');
console.log(JSON.stringify(calibratedLLR, null, 2));