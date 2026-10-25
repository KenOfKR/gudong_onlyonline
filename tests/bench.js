/* ============================================================================
 * tests/bench.js — 鏡像配對測試與 A/A 校準
 * 執行方式: node tests/bench.js
 * ========================================================================== */
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
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

if (isMainThread) {
  const SEEDS = 500;
  const THREADS = require('os').cpus().length || 4;
  
  console.log(`🚀 啟動基準配對量測，共 ${SEEDS} 個種子，使用 ${THREADS} 執行緒...`);
  
  let completed = 0;
  const results = [];
  let aaPassed = true;

  const chunkSize = Math.ceil(SEEDS / THREADS);
  for (let i = 0; i < THREADS; i++) {
    const start = i * chunkSize + 1;
    const end = Math.min((i + 1) * chunkSize, SEEDS);
    if (start > end) break;
    
    const worker = new Worker(__filename, { workerData: { start, end } });
    worker.on('message', msg => {
      if (msg.type === 'aa_fail') {
        console.error(`❌ A/A 測試失敗 (Seed ${msg.seed}): JSON 雜湊不一致或分數非 0`);
        aaPassed = false;
      } else if (msg.type === 'result') {
        results.push(msg.data);
        completed++;
        if (completed % 50 === 0) process.stdout.write('.');
      }
    });
    worker.on('exit', () => {
      if (results.length === SEEDS) analyzeResults(results, aaPassed);
    });
  }
} else {
  const { playOne } = require('./lib/play');
  const GD = loadGD();

  for (let s = workerData.start; s <= workerData.end; s++) {
    const seed = `bench_${s}`;
    
    // 0. A/A 測試：驗證核心狀態決定性
    const roomAA1 = playOne(GD, { seed, brains: {} });
    const roomAA2 = playOne(GD, { seed, brains: {} });
    
    const snap = r => JSON.stringify({
      roles: r.players.map(p => ({ id: p.id, role: p.role })),
      rounds: r.rounds.map(rd => ({
        beasts: rd.beasts,
        pass: rd.passOrder,
        speeches: (rd.speeches || []).map(s => ({ p: s.playerId, txt: s.text })),
        votes: rd.votes,
        results: rd.voteResults ? { totals: rd.voteResults.totals, r1: rd.voteResults.rank1, r2: rd.voteResults.rank2 } : null
      })),
      personVotes: r.personVotes,
      score: r.gameOver ? r.gameOver.totalScore : null,
      xuCaught: r.gameOver ? r.gameOver.xuCaught : null
    });

    const h1 = GD.U.hashStr(snap(roomAA1));
    const h2 = GD.U.hashStr(snap(roomAA2));
    const scoreAA1 = roomAA1.gameOver.totalScore;
    const scoreAA2 = roomAA2.gameOver.totalScore;
    
    if (h1 !== h2 || scoreAA1 !== scoreAA2) {
      parentPort.postMessage({ type: 'aa_fail', seed });
      continue;
    }

    // 1. Base vs Base (已經跑了，直接用 roomAA1)
    const baseRoom = roomAA1;
    const baseScore = baseRoom.gameOver.totalScore;

    // 2. 局 B: 好人開啟 jointRoles 聯合推斷 vs 基準壞人
    const brainsB = {};
    baseRoom.players.forEach(p => {
      brainsB[p.id] = { jointRoles: GD.isGood(p.role) };
    });
    const roomB = playOne(GD, { seed, brains: brainsB });
    
    // 3. BaseGood vs CandEvil
    const brainsC = {};
    baseRoom.players.forEach(p => {
      brainsC[p.id] = { xuFingerprint: !GD.isGood(p.role), xuCounter: !GD.isGood(p.role) };
    });
    const roomC = playOne(GD, { seed, brains: brainsC });

    parentPort.postMessage({
      type: 'result',
      data: {
        seed,
        baseScore,
        scoreB: roomB.gameOver.totalScore,
        scoreC: roomC.gameOver.totalScore,
        xuCaughtBase: baseRoom.gameOver.xuCaught ? 1 : 0,
        xuCaughtB: roomB.gameOver.xuCaught ? 1 : 0,
        xuCaughtC: roomC.gameOver.xuCaught ? 1 : 0
      }
    });
  }
}

function analyzeResults(res, aaPassed) {
  console.log('\n\n' + (aaPassed ? '✅ A/A 測試完美通過！(JSON 雜湊與分數 100% 一致)' : '❌ A/A 測試未通過，請檢查 Math.random 或時間殘留。'));
  
  const calc = (arr) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (arr.length - 1);
    const se = Math.sqrt(variance / arr.length);
    return { mean, se, ci: [mean - 1.96 * se, mean + 1.96 * se] };
  };

  const getRho = (X, Y) => {
    const mx = X.reduce((a, b) => a + b, 0) / X.length;
    const my = Y.reduce((a, b) => a + b, 0) / Y.length;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < X.length; i++) {
      cov += (X[i] - mx) * (Y[i] - my);
      vx += Math.pow(X[i] - mx, 2);
      vy += Math.pow(Y[i] - my, 2);
    }
    return cov / Math.sqrt(vx * vy);
  };

  const scoresBase = res.map(r => r.baseScore);
  const scoresB = res.map(r => r.scoreB);
  const scoresC = res.map(r => r.scoreC);
  
  const deltaGood = res.map(r => r.scoreB - r.baseScore);
  const deltaEvil = res.map(r => r.baseScore - r.scoreC); // 對壞人來說，分數越低越好

  const rhoGood = getRho(scoresBase, scoresB);
  const rhoEvil = getRho(scoresBase, scoresC);
  const statGood = calc(deltaGood);
  const statEvil = calc(deltaEvil);

  const xuCaughtBase = res.map(r => r.xuCaughtBase);
  const xuCaughtB = res.map(r => r.xuCaughtB);
  const xuCaughtC = res.map(r => r.xuCaughtC);
  const deltaXuCaughtB = res.map((r, i) => xuCaughtB[i] - xuCaughtBase[i]);
  const deltaXuCaughtC = res.map((r, i) => xuCaughtC[i] - xuCaughtBase[i]);
  const statXuCaughtB = calc(deltaXuCaughtB);
  const statXuCaughtC = calc(deltaXuCaughtC);

  console.log(`\n📊 局 B [新好人 vs 基準壞人]`);
  console.log(`分數淨提升 (Delta): ${statGood.mean.toFixed(3)} ± ${statGood.se.toFixed(3)} (95% CI: [${statGood.ci[0].toFixed(3)}, ${statGood.ci[1].toFixed(3)}])`);
  console.log(`許願被抓率變化 (Delta): ${statXuCaughtB.mean.toFixed(3)} ± ${statXuCaughtB.se.toFixed(3)}`);
  console.log(`配對相關係數 ρ: ${rhoGood.toFixed(3)}`);

  console.log(`\n📊 局 C [基準好人 vs 新壞人]`);
  console.log(`分數淨壓制 (Delta): ${statEvil.mean.toFixed(3)} ± ${statEvil.se.toFixed(3)} (95% CI: [${statEvil.ci[0].toFixed(3)}, ${statEvil.ci[1].toFixed(3)}])`);
  console.log(`許願被抓率變化 (Delta): ${statXuCaughtC.mean.toFixed(3)} ± ${statXuCaughtC.se.toFixed(3)}`);
  console.log(`配對相關係數 ρ: ${rhoEvil.toFixed(3)}`);
}