'use strict';
/*
 * Paired baseline-vs-experiment strategy test.
 * Requires apply_evil_macro_strategy_v1.js to have created tests/fixtures baseline copies.
 * Usage from project root: node tests/sim-evil-strategy-ab.js 500
 */
const fs = require('node:fs');
const path = require('node:path');
const GD = require('./harness')();
const { Engine, Mind, U } = GD;
const ROOT = path.join(__dirname, '..');
const baselineStrategyPath = path.join(__dirname, 'fixtures', 'strategy.pre-evil-macro-v1.js');
const baselineSpeechPath = path.join(__dirname, 'fixtures', 'speech.pre-evil-macro-v1.js');

if (!fs.existsSync(baselineStrategyPath) || !fs.existsSync(baselineSpeechPath)) {
  console.error('找不到基準 fixture。請先從專案根目錄執行 node apply_evil_macro_strategy_v1.js。');
  process.exit(1);
}

const treatment = { strategy: GD.Strategy, speech: GD.Speech };
function loadFresh(p) {
  const resolved = require.resolve(p);
  delete require.cache[resolved];
  return require(resolved);
}
const baseline = {
  strategy: loadFresh(baselineStrategyPath),
  speech: loadFresh(baselineSpeechPath)
};
GD.Strategy = treatment.strategy;
GD.Speech = treatment.speech;

const N = Math.max(1, parseInt(process.argv[2], 10) || 300);
let errors = 0;
let envMismatch = 0;
const paired = { baseGoodWin: 0, treatmentGoodWin: 0, evilTurnedLossToWin: 0, evilTurnedWinToLoss: 0, sameOutcome: 0 };

function resetFactoryGenes() {
  const fresh = {};
  (GD.Roster.list || []).forEach(b => {
    fresh[b.id] = { genes: GD.Roster.baseGenes(b.id), games: 0, wins: 0, lastDelta: {}, history: [] };
  });
  GD.store.set(GD.CONFIG.STORAGE.genes, fresh);
}

function createStats() {
  return {
    games: 0, goodWins: 0, badWins: 0, errors: 0,
    guessHitGames: 0, guessHitBadWins: 0,
    guessMissGames: 0, guessMissBadWins: 0,
    noGuessGames: 0, noGuessBadWins: 0,
    roleWins: {}, goodVotes: 0, dupedVotes: 0, trustedGoodVotes: 0,
    badLies: 0, badLiesEffective: 0,
    goodFinalVotes: 0, goodHitLao: 0,
    laoFinalVotes: 0, laoHitXu: 0,
    yaoFinalVotes: 0, yaoHitFang: 0, yaoHitJi: 0,
    laoActive: 0, yaoAmbushes: 0, yaoAmbushFang: 0,
    zhengGuesses: 0, zhengGuessHit: 0, thirdAllyGuesses: 0, thirdAllyGuessHit: 0,
    sharedFakeClaimRounds: 0, focusedFakePushRounds: 0,
    expectedGoodScoreTotal: 0,
    posture: { conceal: 0, mixed: 0, desperate: 0, neutral: 0 },
    style: { conceal: 0, aggressive: 0 }
  };
}

function environmentDigest(room) {
  return JSON.stringify({
    roles: room.players.map(p => [p.botId || p.name, p.role]),
    beasts: room.rounds.map(rd => rd.beasts.map(b => [b.name, !!b.isReal]))
  });
}

function addRoundDiagnostics(room, stats) {
  const evilIds = new Set(room.players.filter(p => !GD.isGood(p.role)).map(p => p.id));
  room.rounds.forEach(rd => {
    for (const p of room.players.filter(p => !GD.isGood(p.role))) {
      const log = rd.turnLogs && rd.turnLogs[p.id];
      if (p.role === '老朝奉' && log && log.skillTag === '🎭擾亂') stats.laoActive++;
      if (p.role === '藥不然' && log && log.ambushTargetId) {
        stats.yaoAmbushes++;
        const target = U.byId(room, log.ambushTargetId);
        if (target && target.role === '方震') stats.yaoAmbushFang++;
      }
      const m = rd.mind && rd.mind[p.id];
      if (m && m.evilPosture && Object.prototype.hasOwnProperty.call(stats.posture, m.evilPosture)) stats.posture[m.evilPosture]++;
      if (m && m.evilStyle && Object.prototype.hasOwnProperty.call(stats.style, m.evilStyle)) stats.style[m.evilStyle]++;
      if (m && m.inferredBuddyId && p.role === '鄭國渠') {
  // 只統計鄭國渠推測另外兩名壞人。
  stats.thirdAllyGuesses++;
  const guessed = U.byId(room, m.inferredBuddyId);
  const expectedAlly = guessed &&
    ['老朝奉', '藥不然'].includes(guessed.role);
  if (expectedAlly) stats.thirdAllyGuessHit++;
  stats.zhengGuesses++;
  if (expectedAlly) stats.zhengGuessHit++;
}
    }

    const badClaims = {};
    (rd.speeches || []).forEach(sp => {
      const speaker = U.byId(room, sp.playerId);
      if (!speaker || GD.isGood(speaker.role)) return;
      (sp.p && sp.p.claims || []).forEach(c => {
        const beast = rd.beasts.find(b => b.name === c.beast);
        if (c.real === true && beast && !beast.isReal) badClaims[c.beast] = (badClaims[c.beast] || 0) + 1;
      });
    });
    if (Object.values(badClaims).some(n => n >= 2)) stats.sharedFakeClaimRounds++;

    if (rd.voteResults) {
      const evilSpend = {}, goodSpend = {};
      for (const [pid, ballot] of Object.entries(rd.votes || {})) {
        const voter = U.byId(room, pid);
        if (!voter) continue;
        for (const [beast, n] of Object.entries(ballot || {})) {
          const bag = GD.isGood(voter.role) ? goodSpend : evilSpend;
          bag[beast] = (bag[beast] || 0) + (Number(n) || 0);
        }
      }
      const focused = Object.keys(evilSpend).some(name => {
        const beast = rd.beasts.find(b => b.name === name);
        const vr = rd.voteResults;
        const inTop = vr.rank1.name === name || vr.rank2.name === name;
        return beast && !beast.isReal && evilSpend[name] >= 2 && (goodSpend[name] || 0) >= 2 && inTop;
      });
      if (focused) stats.focusedFakePushRounds++;
    }
  });
}

function diagnoseZhengGuess(room) {
  let hasGuess = false;
  let hasHit = false;

  const zheng = (room.players || []).find(p => p.role === '鄭國渠');
  if (!zheng) return { hasGuess, hasHit };

  for (const rd of room.rounds || []) {
    const m = rd.mind && rd.mind[zheng.id];
    if (!m || !m.inferredBuddyId) continue;

    hasGuess = true;
    const guessed = U.byId(room, m.inferredBuddyId);

    if (guessed && ['老朝奉', '藥不然'].includes(guessed.role)) {
      hasHit = true;
    }
  }

  return { hasGuess, hasHit };
}

function collect(room, stats) {
  if (!room.gameOver) {
    stats.errors++;
    return;
  }
  stats.games++;
  const goodWon = !!room.gameOver.xuWon;

  // 每局只分類一次；曾猜中至少一次就歸入「曾命中」。
  const guessDiag = diagnoseZhengGuess(room);

  if (!guessDiag.hasGuess) {
    stats.noGuessGames++;
    if (!goodWon) stats.noGuessBadWins++;
  } else if (guessDiag.hasHit) {
    stats.guessHitGames++;
    if (!goodWon) stats.guessHitBadWins++;
  } else {
    stats.guessMissGames++;
    if (!goodWon) stats.guessMissBadWins++;
  }
  if (goodWon) stats.goodWins++; else stats.badWins++;
  const realSaved = room.rounds.reduce((sum, rd) => {
    const vr = rd.voteResults;
    return sum + (vr ? (vr.rank1.isReal ? 1 : 0) + (vr.rank2.isReal ? 1 : 0) : 0);
  }, 0);
  stats.expectedGoodScoreTotal += realSaved;

  room.players.forEach(p => {
    const roleWon = GD.isGood(p.role) ? goodWon : !goodWon;
    stats.roleWins[p.role] = (stats.roleWins[p.role] || 0) + (roleWon ? 1 : 0);
    const target = U.byId(room, room.personVotes[p.id]);
    if (GD.isGood(p.role)) {
      const f = GD.Learning.ballotFacts(room, p);
      stats.goodVotes += f.real + f.fake;
      stats.dupedVotes += f.duped.reduce((sum, item) => sum + item.n, 0);
      stats.trustedGoodVotes += f.trustedGood.reduce((sum, item) => sum + item.n, 0);
      stats.goodFinalVotes++;
      if (target && target.role === '老朝奉') stats.goodHitLao++;
    } else if (p.role === '老朝奉') {
      stats.laoFinalVotes++;
      if (target && target.role === '許願') stats.laoHitXu++;
    } else if (p.role === '藥不然') {
      stats.yaoFinalVotes++;
      if (target && target.role === '方震') stats.yaoHitFang++;
      if (target && target.role === '姬雲浮') stats.yaoHitJi++;
    }

    if (!GD.isGood(p.role)) {
      room.rounds.forEach(rd => {
        const m = rd.mind && rd.mind[p.id];
        if (!m || !['lie', 'follow'].includes(m.mode) || !rd.voteResults) return;
        const sp = (rd.speeches || []).find(s => s.playerId === p.id);
        if (!(sp && (sp.p && sp.p.claims || []).some(c => c.beast === m.beast && c.real === true))) return;
        stats.badLies++;
        const beast = rd.beasts.find(b => b.name === m.beast);
        if (!beast || beast.isReal) return;
        let goodVotes = 0;
        room.players.filter(gp => GD.isGood(gp.role)).forEach(gp => {
          goodVotes += ((rd.votes && rd.votes[gp.id]) || {})[m.beast] || 0;
        });
        const vr = rd.voteResults;
        if ((vr.rank1.name === m.beast || vr.rank2.name === m.beast) && goodVotes >= 2) stats.badLiesEffective++;
      });
    }
  });
  addRoundDiagnostics(room, stats);
}

function playOne(seed, policy, stats) {
  GD.Strategy = policy.strategy;
  GD.Speech = policy.speech;
  resetFactoryGenes();
  return U.withPRNG(`evil-macro-paired:${seed}`, () => {
    const room = Engine.newRoom(`EVIL_AB_${seed}`, 'host');
    Engine.addPlayer(room, { id: 'h1', name: '真人甲' });
    Engine.fillBots(room);
    if (!Engine.start(room)) throw new Error('Engine.start 失敗');
    let guard = 0;
    while (room.status !== 'gameover' && guard++ < 400) {
      const rd = U.curRound(room);
      if (room.status === 'playing') {
        const p = U.byId(room, room.currentTurnPlayerId);
        const log = Engine.log(room, p.id);
        if (log.step === 'a') policy.strategy.inspectPicks(p, room).forEach(n => Engine.inspect(room, p.id, n));
        const A = Mind.analyze(p, room);
        Engine.skill(room, p.id, policy.strategy.skill(p, room, A));
        Engine.pass(room, p.id, policy.strategy.nextPlayer(p, room, A));
      } else if (room.status === 'discussion') {
        const p = U.byId(room, room.currentSpeakerId);
        const { plan, A } = policy.strategy.plan(p, room);
        const text = policy.speech.localSpeech(p, room, plan, A);
        const validation = policy.speech.validate(text, p, room, plan, A);
        if (!validation.ok) {
          stats.errors++;
          if (stats.errors <= 8) console.error(`發言驗證失敗 seed=${seed}: ${validation.why}`);
        }
        Engine.speak(room, p.id, { text, source: 'bot' });
      } else if (room.status === 'voting') {
        if (!rd.voteResults) {
          room.players.forEach(p => {
            if (rd.votes[p.id] === undefined) Engine.vote(room, p.id, policy.strategy.ballot(p, room));
          });
        }
        Engine.advance(room);
      } else if (room.status === 'person_voting') {
        room.players.forEach(p => {
          if (!room.personVotes[p.id]) {
            const decision = policy.strategy.personVote(p, room);
            p.final = decision;
            Engine.personVote(room, p.id, decision.targetId);
          }
        });
      }
    }
    if (room.status !== 'gameover') stats.errors++;
    collect(room, stats);
    return room;
  });
}

function pct(n, d) { return d ? `${(n / d * 100).toFixed(1)}% (${n}/${d})` : 'n/a'; }
function printStats(label, stats) {
  console.log(`【${label}】局數 ${stats.games}｜好人勝率 ${pct(stats.goodWins, stats.games)}｜壞人勝率 ${pct(stats.badWins, stats.games)}`);
  console.log(`角色所屬陣營勝率：老朝奉 ${pct(stats.roleWins['老朝奉'] || 0, stats.games)}｜藥不然 ${pct(stats.roleWins['藥不然'] || 0, stats.games)}｜鄭國渠 ${pct(stats.roleWins['鄭國渠'] || 0, stats.games)}`);
  console.log(`鑑人：老朝奉命中許願 ${pct(stats.laoHitXu, stats.laoFinalVotes)}｜藥不然命中方震 ${pct(stats.yaoHitFang, stats.yaoFinalVotes)}｜藥不然誤投姬雲浮 ${pct(stats.yaoHitJi, stats.yaoFinalVotes)}｜好人命中老朝奉 ${pct(stats.goodHitLao, stats.goodFinalVotes)}`);
  console.log(`能力：老朝奉擾亂 ${stats.laoActive} 次｜藥不然偷襲 ${stats.yaoAmbushes} 次、其中目標方震 ${stats.yaoAmbushFang} 次`);
  console.log(`協同：兩名以上壞人共同推同一贗品 ${stats.sharedFakeClaimRounds}/${stats.games * 3} 輪｜壞人集中假貨並獲好人至少 2 票 ${stats.focusedFakePushRounds}/${stats.games * 3} 輪`);
  console.log(`謊言高轉換 ${pct(stats.badLiesEffective, stats.badLies)}｜好人被騙票 ${pct(stats.dupedVotes, stats.goodVotes)}`);
  console.log(`第三名壞人推測命中 ${pct(stats.thirdAllyGuessHit, stats.thirdAllyGuesses)}｜其中鄭國渠推測老朝奉／藥不然命中 ${pct(stats.zhengGuessHit, stats.zhengGuesses)}`);
  console.log(`平均每局實際保住真品分數（測試診斷用） ${(stats.expectedGoodScoreTotal / Math.max(1, stats.games)).toFixed(2)}｜發言/對局錯誤 ${stats.errors}`);
  console.log(`藏身/強攻選擇：${JSON.stringify(stats.style)}｜情勢：${JSON.stringify(stats.posture)}`);
  const classifiedGames =
    stats.guessHitGames + stats.guessMissGames + stats.noGuessGames;

  console.log(
    '鄭國渠推測診斷：曾命中 ' +
    pct(stats.guessHitBadWins, stats.guessHitGames) +
    ' 壞人勝率；有推測但未命中 ' +
    pct(stats.guessMissBadWins, stats.guessMissGames) +
    ' 壞人勝率；沒有推測 ' +
    pct(stats.noGuessBadWins, stats.noGuessGames) + ' 壞人勝率'
  );

  console.log('推測分類局數：' + classifiedGames + '/' + stats.games);

  if (classifiedGames !== stats.games) {
    console.error('診斷錯誤：推測分類局數與總局數不一致。');
  }
}

const statsBase = createStats();
const statsNew = createStats();
const baseOutcomes = [];
const newOutcomes = [];
const baseEnvironments = [];
console.log(`=== 壞人宏觀策略配對 A/B：${N} 組固定種子，兩組皆使用出廠基因、不啟動學習 ===`);
for (let i = 0; i < N; i++) {
  try {
    const roomA = playOne(`SEED_${i}`, baseline, statsBase);
    baseEnvironments.push(environmentDigest(roomA));
    baseOutcomes.push(!!(roomA.gameOver && roomA.gameOver.xuWon));
  } catch (e) {
    statsBase.errors++;
    baseEnvironments.push(null);
    baseOutcomes.push(null);
    if (statsBase.errors <= 8) console.error(`基準組 seed=${i}: ${e.stack || e}`);
  }
}
for (let i = 0; i < N; i++) {
  try {
    const roomB = playOne(`SEED_${i}`, treatment, statsNew);
    const environment = environmentDigest(roomB);
    if (environment !== baseEnvironments[i]) envMismatch++;
    newOutcomes.push(!!(roomB.gameOver && roomB.gameOver.xuWon));
  } catch (e) {
    statsNew.errors++;
    newOutcomes.push(null);
    if (statsNew.errors <= 8) console.error(`實驗組 seed=${i}: ${e.stack || e}`);
  }
}
for (let i = 0; i < N; i++) {
  if (baseOutcomes[i] == null || newOutcomes[i] == null) continue;
  if (baseOutcomes[i] === newOutcomes[i]) paired.sameOutcome++;
  else if (baseOutcomes[i] && !newOutcomes[i]) paired.evilTurnedLossToWin++;
  else paired.evilTurnedWinToLoss++;
}
paired.baseGoodWin = baseOutcomes.filter(x => x === true).length;
paired.treatmentGoodWin = newOutcomes.filter(x => x === true).length;
printStats('基準策略', statsBase);
printStats('壞人宏觀策略 v1', statsNew);
console.log(`配對環境一致：${N - envMismatch}/${N}；環境不一致 ${envMismatch}`);
console.log(`配對結果：相同 ${paired.sameOutcome}｜新策略讓壞人由敗轉勝 ${paired.evilTurnedLossToWin}｜新策略讓壞人由勝轉敗 ${paired.evilTurnedWinToLoss}`);
console.log(`好人勝率變化：${((statsNew.goodWins / Math.max(1, statsNew.games) - statsBase.goodWins / Math.max(1, statsBase.games)) * 100).toFixed(1)} 個百分點`);
console.log(`總錯誤項：${statsBase.errors + statsNew.errors + envMismatch}`);
process.exitCode = (statsBase.errors + statsNew.errors + envMismatch) ? 1 : 0;
