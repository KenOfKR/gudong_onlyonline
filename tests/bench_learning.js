/* ============================================================================
 * tests/bench_learning.js — 步驟 2b：跨局滾動學習收斂對照報告（健壯取值版）
 * 執行方式: node tests/bench_learning.js
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
    'js/bot/mind.js', 'js/bot/strategy.js', 'js/bot/speech.js', 'js/bot/learning.js'
  ];
  files.forEach(f => {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInNewContext(code, sandbox);
  });
  return sandbox.GD;
}

const { playOne } = require('./lib/play');

const GD_Global = loadGD();
const GD_Counterfactual = loadGD();

const EPOCHS = 50;
console.log(`🚀 啟動跨局滾動學習評估，連續執行 ${EPOCHS} 局完全配對對局...`);

function createMockStore() {
  const map = {};
  return {
    get: (k, def) => (map[k] !== undefined ? map[k] : def),
    set: (k, v) => { map[k] = v; }
  };
}
GD_Global.store = createMockStore();
GD_Counterfactual.store = createMockStore();

// 基因防禦：修補 Genes.save 避免 meta 缺漏
[GD_Global, GD_Counterfactual].forEach(gInstance => {
  const origSave = gInstance.Genes.save;
  gInstance.Genes.save = function (botId, genes, meta = { entry: 'bench_update' }) {
    return origSave.call(this, botId, genes, meta || { entry: 'bench_update' });
  };
});

const history = {
  global: { scores: [], jitters: [], goodWins: 0 },
  cf: { scores: [], jitters: [], goodWins: 0 }
};

let lastGenesGlobal = null;
let lastGenesCF = null;

function calcJitter(prev, curr) {
  if (!prev) return 0;
  let totalDiff = 0, count = 0;
  Object.keys(curr).forEach(k => {
    if (prev[k]) {
      totalDiff += Math.abs(curr[k].assertiveness - prev[k].assertiveness);
      totalDiff += Math.abs(curr[k].skepticism - prev[k].skepticism);
      count += 2;
    }
  });
  return count > 0 ? totalDiff / count : 0;
}

// 健壯計算好人得分
function getGoodScore(room) {
  if (!room.gameOver) return 0;
  if (typeof room.gameOver.totalScore === 'number') return room.gameOver.totalScore;
  if (typeof room.gameOver.score === 'number') return room.gameOver.score;
  if (typeof room.gameOver.realCount === 'number') return room.gameOver.realCount;
  // Fallback: 直接統計 3 輪投票留存的真品數
  let reals = 0;
  (room.rounds || []).forEach(rd => {
    if (rd.voteResults?.rank1?.isReal) reals++;
    if (rd.voteResults?.rank2?.isReal) reals++;
  });
  return reals;
}

// 判斷好人是否獲勝
function isGoodWin(room) {
  if (!room.gameOver) return false;
  if (room.gameOver.winner === 'good' || room.gameOver.winner === '好人') return true;
  // 若為老朝奉被抓且真品保留 >= 6
  return (getGoodScore(room) >= 6) && !!room.gameOver.laoCaught;
}

// 傳統勝負全局學習更新函式
function applyGlobalLearning(GD, room) {
  const goodWin = isGoodWin(room);
  room.players.forEach(p => {
    if (!p.isBot || !p.botId) return;
    const isGood = GD.isGood(p.role);
    const win = (isGood && goodWin) || (!isGood && !goodWin);
    const g = GD.Genes.load(p.botId);
    
    const delta = win ? 0.04 : -0.04;
    g.assertiveness = GD.U.clamp(g.assertiveness + delta, 0.1, 0.9);
    g.skepticism = GD.U.clamp(g.skepticism + delta * 0.8, 0.1, 0.9);
    
    GD.Genes.save(p.botId, g, { entry: 'global_learn' });
  });
}

for (let e = 1; e <= EPOCHS; e++) {
  const seed = `learn_seq_${e}`;

  // 1. 執行組別 A（全局勝負學習）
  const roomA = playOne(GD_Global, { seed, brains: {} });
  applyGlobalLearning(GD_Global, roomA);

  const currGenesA = {};
  roomA.players.forEach(p => { currGenesA[p.botId] = { ...GD_Global.Genes.load(p.botId) }; });
  history.global.jitters.push(calcJitter(lastGenesGlobal, currGenesA));
  lastGenesGlobal = currGenesA;

  const scoreA = getGoodScore(roomA);
  history.global.scores.push(scoreA);
  if (isGoodWin(roomA)) history.global.goodWins++;

  // 2. 執行組別 B（2b 反事實歸因學習）
  const roomB = playOne(GD_Counterfactual, { seed, brains: { jointRoles: true } });
  GD_Counterfactual.Learning.finalize(roomB);

  const currGenesB = {};
  roomB.players.forEach(p => { currGenesB[p.botId] = { ...GD_Counterfactual.Genes.load(p.botId) }; });
  history.cf.jitters.push(calcJitter(lastGenesCF, currGenesB));
  lastGenesCF = currGenesB;

  const scoreB = getGoodScore(roomB);
  history.cf.scores.push(scoreB);
  if (isGoodWin(roomB)) history.cf.goodWins++;

  if (e % 10 === 0) {
    const avgScoreA = (history.global.scores.slice(e - 10, e).reduce((a, b) => a + b, 0) / 10).toFixed(2);
    const avgScoreB = (history.cf.scores.slice(e - 10, e).reduce((a, b) => a + b, 0) / 10).toFixed(2);
    console.log(`第 ${String(e).padStart(2, ' ')} 局進度：近 10 局平均好人分 -> 全局學習: ${avgScoreA} | 反事實學習: ${avgScoreB}`);
  }
}

// 整體統計
const avgJitterA = (history.global.jitters.slice(1).reduce((a, b) => a + b, 0) / (EPOCHS - 1)).toFixed(4);
const avgJitterB = (history.cf.jitters.slice(1).reduce((a, b) => a + b, 0) / (EPOCHS - 1)).toFixed(4);

const totalScoreA = (history.global.scores.reduce((a, b) => a + b, 0) / EPOCHS).toFixed(2);
const totalScoreB = (history.cf.scores.reduce((a, b) => a + b, 0) / EPOCHS).toFixed(2);

console.log('\n================================================================');
console.log('📊 步驟 2b：跨局滾動學習收斂對照報告（連續 50 局）');
console.log('================================================================');
console.log(`指標名稱                      全局勝負歸因 (A)        2b 反事實歸因 (B)`);
console.log('----------------------------------------------------------------');
console.log(`50 局好人平均分數              ${totalScoreA.padEnd(24)}${totalScoreB}`);
console.log(`好人勝場數                    ${(history.global.goodWins + ' / ' + EPOCHS).padEnd(24)}${history.cf.goodWins + ' / ' + EPOCHS}`);
console.log(`平均每局基因震盪量 (Jitter)    ${avgJitterA.padEnd(24)}${avgJitterB}`);
console.log('================================================================');

// 繪製 ASCII 滑動窗口分數圖
console.log('\n📈 滑動窗口平均分數曲線 (每 5 局窗口):');
console.log('局數區間        全局學習 (A)                    反事實學習 (B)');
console.log('----------------------------------------------------------------');
for (let i = 0; i <= EPOCHS - 5; i += 5) {
  const windowA = history.global.scores.slice(i, i + 5);
  const windowB = history.cf.scores.slice(i, i + 5);
  const meanA = (windowA.reduce((a, b) => a + b, 0) / 5).toFixed(2);
  const meanB = (windowB.reduce((a, b) => a + b, 0) / 5).toFixed(2);

  const barA = '█'.repeat(Math.max(0, Math.round((meanA - 3.5) * 8)));
  const barB = '█'.repeat(Math.max(0, Math.round((meanB - 3.5) * 8)));

  const label = `局 ${String(i + 1).padStart(2, '0')}-${String(i + 5).padStart(2, '0')}`.padEnd(16);
  console.log(`${label}${meanA.padEnd(6)} ${barA.padEnd(22)} | ${meanB.padEnd(6)} ${barB}`);
}
console.log('================================================================');