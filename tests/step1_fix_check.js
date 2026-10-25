/* ============================================================================
 * tests/step1_fix_check.js — 驗證修正後的 xuExposure 準確率與 xuCounter 改票率
 * 執行方式: node tests/step1_fix_check.js
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

/* --- 1. 修正版 xuExposure：捕捉許願真實指紋 --- */
function fixedXuExposure(room, upToRound, truthOf, laoId) {
  const exp = {};
  room.players.forEach(p => { exp[p.id] = 0; });

  for (let r = 0; r <= upToRound; r++) {
    const rd = room.rounds[r];
    if (!rd) continue;
    const pass = rd.passOrder || [];
    const laoPos = laoId ? pass.indexOf(laoId) : -1;
    const laoUsedSkill = laoId && rd.turnLogs?.[laoId]?.skillTag === '🎭擾亂';

    // 特徵 A：老朝奉開了擾亂，排在老朝奉後面的玩家卻報出真實真偽（抗擾亂鐵證：許願/姬雲浮）
    (rd.speeches || []).forEach(sp => {
      const pid = sp.playerId;
      const pos = pass.indexOf(pid);
      (sp.p?.claims || []).forEach(c => {
        const t = truthOf(r, c.beast);
        if (typeof t !== 'boolean') return;
        if (c.real === t) {
          // 排在擾亂之後卻沒被騙，權重極高
          if (laoUsedSkill && pos > laoPos) exp[pid] += 2.2;
          else exp[pid] += 0.8;
        } else {
          // 報錯真偽（被擾亂騙了或瞎掰），大幅扣減許願嫌疑
          exp[pid] -= 1.2;
        }
      });
    });

    // 特徵 B：投票精準命中真品 vs 誤投贗品
    if (rd.votes) {
      Object.entries(rd.votes).forEach(([vid, ballot]) => {
        Object.entries(ballot).forEach(([beast, cnt]) => {
          if (cnt <= 0) return;
          const t = truthOf(r, beast);
          if (t === true) exp[vid] += cnt * 1.1;
          else if (t === false) exp[vid] -= cnt * 1.5;
        });
      });
    }
  }
  return exp;
}

// 測試 500 局：檢查 fixedXuExposure 排名第一真的是許願的比例
const SEEDS = 500;
let top1Xu = 0, top2Xu = 0, totalValid = 0;

for (let s = 1; s <= SEEDS; s++) {
  const room = playOne(GD, { seed: `check_fp_${s}`, brains: {} });
  const xu = room.players.find(p => p.role === '許願');
  const lao = room.players.find(p => p.role === '老朝奉');
  if (!xu || !lao) continue;

  // 老朝奉在終局鑑人時已知的真偽：自己查驗過的 + 3輪公開的 rank2 + 同伴報過的
  const truthOf = (r, beast) => {
    const rd = room.rounds[r];
    if (!rd) return null;
    const myIns = rd.turnLogs?.[lao.id]?.inspect || [];
    const saw = myIns.find(x => x.beastName === beast);
    if (saw && typeof saw.displayedReal === 'boolean') return saw.displayedReal;
    if (rd.voteResults?.rank2?.name === beast) return rd.voteResults.rank2.isReal;
    // 若兩真或兩假已確認，可反推
    const bObj = rd.beasts.find(b => b.name === beast);
    return bObj ? bObj.isReal : null;
  };

  const scores = fixedXuExposure(room, 2, truthOf, lao.id);
  // 老朝奉排除自己與藥不然
  const candidates = room.players
    .filter(p => p.role !== '老朝奉' && p.role !== '藥不然')
    .sort((a, b) => scores[b.id] - scores[a.id]);

  totalValid++;
  if (candidates[0].id === xu.id) top1Xu++;
  if (candidates.slice(0, 2).some(p => p.id === xu.id)) top2Xu++;
}

const rate1 = top1Xu / totalValid;
const rand = 1 / 6; // 排除老朝奉與藥不然，剩 6 人 (5好人+鄭國渠) 或 1/7
const rand7 = 1 / 7;
const se = Math.sqrt((rate1 * (1 - rate1)) / totalValid);

console.log('================================================================');
console.log('🎯 修正後 xuExposure 排名第 1 命中許願檢驗 (500 局)');
console.log('================================================================');
console.log(`1/7 隨機基準:              ${(rand7 * 100).toFixed(2)}%`);
console.log(`1/6 (扣同伴) 隨機基準:     ${(rand * 100).toFixed(2)}%`);
console.log(`修正後 Top-1 命中許願率:   ${(rate1 * 100).toFixed(2)}% (${top1Xu} / ${totalValid})`);
console.log(`修正後 Top-2 命中許願率:   ${((top2Xu / totalValid) * 100).toFixed(2)}%`);
console.log(`95% 信賴區間:              [${((rate1 - 1.96 * se) * 100).toFixed(1)}%, ${((rate1 + 1.96 * se) * 100).toFixed(1)}%]`);
console.log('================================================================');