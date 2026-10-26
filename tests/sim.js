/* 全電腦對局模擬 A/B 測試（固定種子成對比較與精細量化指標版） */

// 1. 在載入任何模組前，攔截並覆寫原生 Math.random 以支援固定種子 (Seeded PRNG)
// 這樣 strategy.js 內部的 const rnd = Math.random 也會指向我們的 PRNG
let prng = Math.random;
Math.random = function() { return prng(); };
Math.setSeed = function(seedStr) {
  let h = 0xdeadbeef;
  for(let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 2654435761);
  let a = h ^ (h >>> 16);
  prng = function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};

const GD = require('./harness')();
const { Engine, Strategy, Speech, Mind, U } = GD;
const N = parseInt(process.argv[2], 10) || 100;
GD.store.set(GD.CONFIG.STORAGE.useGemini, false);

let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; if (fails <= 12) console.error('  ✗', msg); } };

// 用來捕捉統計資料
function createStats() {
  return {
    wins: { '許願':0, '方震':0, '姬雲浮':0, '黃煙煙':0, '木戶加奈':0, '老朝奉':0, '藥不然':0, '鄭國渠':0 },
    totalGames: 0,
    goodVotes: 0,
    dupedVotes: 0,      // 好人聽信壞人宣稱投給贗品的票
    trustedGoodVotes: 0, // 好人採信好人宣稱投給真品的票
    personVotes: { total: 0, hitLao: 0 },
    badLies: 0,         // 壞人嘗試說謊次數
    badLiesEffective: 0,// 壞人說謊成功騙到>=2張好人票並進前二的次數
    timeMs: 0
  };
}

function playOne(seedStr, disableLearning, stats) {
  // 設定隨機種子，確保 A 組與 B 組面臨完全相同的身分、獸首與行動順序
  Math.setSeed(seedStr);
  
  if (disableLearning) {
    const rawStore = GD.store.get(GD.CONFIG.STORAGE.genes, {});
    Object.keys(rawStore).forEach(botId => {
      rawStore[botId].genes = GD.Roster.baseGenes(botId);
    });
    GD.store.set(GD.CONFIG.STORAGE.genes, rawStore);
  }

  const room = Engine.newRoom('T' + seedStr, 'host');
  Engine.addPlayer(room, { id: 'h1', name: '真人甲' });
  Engine.fillBots(room);
  check(Engine.start(room), 'start 失敗');

  let guard = 0;
  while (room.status !== 'gameover' && guard++ < 400) {
    const rd = U.curRound(room);
    if (room.status === 'playing') {
      const p = U.byId(room, room.currentTurnPlayerId);
      const log = Engine.log(room, p.id);
      if (log.step === 'a') Strategy.inspectPicks(p, room).forEach(n => Engine.inspect(room, p.id, n));
      const A = Mind.analyze(p, room);
      Engine.skill(room, p.id, Strategy.skill(p, room, A));
      Engine.pass(room, p.id, Strategy.nextPlayer(p, room, A));
    } else if (room.status === 'discussion') {
      const p = U.byId(room, room.currentSpeakerId);
      const { plan, A } = Strategy.plan(p, room);
      const text = Speech.localSpeech(p, room, plan, A);
      const v = Speech.validate(text, p, room, plan, A);
      check(v.ok, `發言未通過驗證：${v.why}`);
      Engine.speak(room, p.id, { text, source: 'bot' });
    } else if (room.status === 'voting') {
      if (!rd.voteResults) {
        room.players.forEach(p => { 
          if (rd.votes[p.id] === undefined) Engine.vote(room, p.id, Strategy.ballot(p, room)); 
        });
      }
      Engine.advance(room);
    } else if (room.status === 'person_voting') {
      room.players.forEach(p => { 
        if (!room.personVotes[p.id]) { 
          const d = Strategy.personVote(p, room); 
          p.final = d; 
          Engine.personVote(room, p.id, d.targetId); 
        } 
      });
    }
  }

  // 結算精細統計
  stats.totalGames++;
  const g = room.gameOver;
  room.players.forEach(p => {
    const isGood = GD.isGood(p.role);
    if ((isGood && g.xuWon) || (!isGood && !g.xuWon)) {
      stats.wins[p.role]++;
    }
    
    if (isGood) {
      const f = GD.Learning.ballotFacts(room, p);
      stats.goodVotes += (f.real + f.fake);
      stats.dupedVotes += f.duped.reduce((sum, item) => sum + item.n, 0);
      stats.trustedGoodVotes += f.trustedGood.reduce((sum, item) => sum + item.n, 0);
      
      stats.personVotes.total++;
      const pv = room.personVotes[p.id];
      const target = U.byId(room, pv);
      if (target && target.role === '老朝奉') stats.personVotes.hitLao++;
    } else {
      // 壞人謊言轉換率統計
      room.rounds.forEach(rd => {
        const m = rd.mind[p.id];
        if (m && (m.mode === 'lie' || m.mode === 'follow') && rd.voteResults) {
          // 確認自己真的有在發言中推該假貨
          const mySpeech = (rd.speeches || []).find(s => s.playerId === p.id);
          const didIBlobClaimIt = mySpeech && (mySpeech.p?.claims || []).some(c => c.beast === m.beast && c.real === true);
          if (!didIBlobClaimIt) return;

          stats.badLies++;
          const isFake = !rd.beasts.find(b => b.name === m.beast)?.isReal;
          if (isFake) {
            let goodVotes = 0;
            room.players.filter(gp => GD.isGood(gp.role)).forEach(gp => {
              goodVotes += ((rd.votes && rd.votes[gp.id]) || {})[m.beast] || 0;
            });
            const vr = rd.voteResults;
            const inTop = (vr.rank1.name === m.beast || vr.rank2.name === m.beast);
            if (inTop && goodVotes >= 2) stats.badLiesEffective++;
          }
        }
      });
    }
  });

  if (!disableLearning) check(GD.Learning.finalize(room), '學習引擎寫入失敗');
}

const statsA = createStats();
const statsB = createStats();

console.log(`\n=== 準備進行 A/B 測試 (${N} 局 x 2 組, 固定隨機種子成對比較) ===\n`);

let t0 = Date.now();
for (let i = 0; i < N; i++) {
  try { playOne(`SEED_${i}`, true, statsA); }
  catch (e) { fails++; console.error(`  ✗ A組第${i}局錯誤:`, e.stack.split('\n')[0]); }
}
statsA.timeMs = Date.now() - t0;

// 清除 store，讓 B 組從最原始乾淨的出廠狀態開始學習適應
GD.store.remove(GD.CONFIG.STORAGE.genes);

t0 = Date.now();
for (let i = 0; i < N; i++) {
  try { playOne(`SEED_${i}`, false, statsB); }
  catch (e) { fails++; console.error(`  ✗ B組第${i}局錯誤:`, e.stack.split('\n')[0]); }
}
statsB.timeMs = Date.now() - t0;

function printStats(name, s) {
  const goodWin = ((s.wins['許願'] + s.wins['方震'] + s.wins['姬雲浮'] + s.wins['黃煙煙'] + s.wins['木戶加奈']) / (5 * s.totalGames) * 100).toFixed(1);
  const badWin = ((s.wins['老朝奉'] + s.wins['藥不然'] + s.wins['鄭國渠']) / (3 * s.totalGames) * 100).toFixed(1);
  const dupedRate = s.goodVotes ? (s.dupedVotes / s.goodVotes * 100).toFixed(1) : 0;
  const trustedRate = s.goodVotes ? (s.trustedGoodVotes / s.goodVotes * 100).toFixed(1) : 0;
  const hitLaoRate = s.personVotes.total ? (s.personVotes.hitLao / s.personVotes.total * 100).toFixed(1) : 0;
  const lieEffectRate = s.badLies ? (s.badLiesEffective / s.badLies * 100).toFixed(1) : 0;

  console.log(`【${name}】`);
  console.log(`勝率 ─ 好人: ${goodWin}% ｜ 壞人: ${badWin}%`);
  console.log(`各角勝率 ─ 許願:${(s.wins['許願']/s.totalGames*100).toFixed(1)}% 方震:${(s.wins['方震']/s.totalGames*100).toFixed(1)}% 老朝奉:${(s.wins['老朝奉']/s.totalGames*100).toFixed(1)}% 藥不然:${(s.wins['藥不然']/s.totalGames*100).toFixed(1)}%`);
  console.log(`好人投票 ─ 被騙票率: ${dupedRate}% (${s.dupedVotes}/${s.goodVotes}) ｜ 成功跟隨好人率: ${trustedRate}% (${s.trustedGoodVotes}/${s.goodVotes})`);
  console.log(`鑑人命中 ─ 好人抓出老朝奉率: ${hitLaoRate}% (${s.personVotes.hitLao}/${s.personVotes.total})`);
  console.log(`壞人謊言 ─ 謊言高轉換率: ${lieEffectRate}% (${s.badLiesEffective}/${s.badLies})`);
  console.log(`耗時: ${s.timeMs} ms\n`);
  return { goodWin, dupedRate, hitLaoRate, s };
}

const rA = printStats('A 組：出廠基因凍結', statsA);
const rB = printStats('B 組：學習引擎開啟', statsB);

console.log(`👉 學習效益評估 (Paired Comparison)：`);
console.log(`好人勝率變化：${(rB.goodWin - rA.goodWin).toFixed(1)}%`);
console.log(`好人被騙票率變化：${(rB.dupedRate - rA.dupedRate).toFixed(1)}%`);
console.log(`好人鑑人命中變化：${(rB.hitLaoRate - rA.hitLaoRate).toFixed(1)}%`);
console.log(`總失敗項：${fails}`);

// 全體基因波動與極端值檢查
const store = GD.store.get(GD.CONFIG.STORAGE.genes, {});
const bots = Object.entries(store).filter(x => x[1].games > 0);
if (bots.length) {
  let diffSum = { skepticism:0, deception:0, camouflage:0, assertiveness:0, conformity:0 };
  let maxDiff = { botName: '', gene: '', val: 0 };
  
  bots.forEach(([id, data]) => {
    const base = GD.Roster.baseGenes(id);
    Object.keys(diffSum).forEach(k => { 
      const absDiff = Math.abs(data.genes[k] - base[k]);
      diffSum[k] += absDiff;
      if (absDiff > maxDiff.val) {
        maxDiff = { botName: GD.Roster.byId(id).name, gene: k, val: absDiff, old: base[k], new: data.genes[k] };
      }
    });
  });
  console.log('\n全體基因平均絕對變動幅度 (Variance)：');
  Object.keys(diffSum).forEach(k => console.log(`  ${k}: ${(diffSum[k]/bots.length).toFixed(3)}`));
  console.log(`全場最大單一基因變動：${maxDiff.botName} 的 ${maxDiff.gene} 從 ${maxDiff.old} 變為 ${maxDiff.new} (變化 ${maxDiff.val.toFixed(3)})`);
}

process.exit(fails ? 1 : 0);