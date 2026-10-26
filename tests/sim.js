/* ============================================================================
 * tests/sim.js — 全電腦對局模擬（A/A 重現性校驗、環境/決策雙軌 PRNG、顯式落盤驗證）
 * 用法：
 *   node tests/sim.js 100 --aa   （僅執行 100 組種子的 A/A 嚴格重現性校驗與亂數隔離檢查）
 *   node tests/sim.js 1500       （先通過 A/A 前置校驗，再執行 1500 局 Paired A/B 測試與 flush 驗證）
 * ========================================================================== */
const GD = require('./harness')();
const { Engine, Strategy, Speech, Mind, U } = GD;

const args = process.argv.slice(2);
const isAAOnly = args.includes('--aa');
const numArg = args.find(a => !a.startsWith('-'));
const N = parseInt(numArg, 10) || 100;

GD.store.set(GD.CONFIG.STORAGE.useGemini, false);

let fails = 0;
const check = (cond, msg) => {
  if (!cond) {
    fails++;
    if (fails <= 12) console.error('  ✗', msg);
  }
};

function createStats() {
  return {
    wins: { '許願': 0, '方震': 0, '姬雲浮': 0, '黃煙煙': 0, '木戶加奈': 0, '老朝奉': 0, '藥不然': 0, '鄭國渠': 0 },
    totalGames: 0,
    goodVotes: 0,
    dupedVotes: 0,
    trustedGoodVotes: 0,
    personVotes: { total: 0, hitLao: 0 },
    badLies: 0,
    badLiesEffective: 0,
    timeMs: 0
  };
}

/** 正規化房間對局摘要（排除 Date.now() 時間戳記對 player.id 的干擾，完整比對所有對局細節） */
function getRoomDigest(room) {
  const keyOf = id => {
    const p = U.byId(room, id);
    if (!p) return String(id);
    return p.botId ? `bot:${p.botId}` : `human:${p.name}`;
  };

  const sortedEntries = entries =>
    entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  return JSON.stringify({
    players: room.players.map(p => ({
      player: keyOf(p.id),
      role: p.role,
      seatIndex: p.seatIndex
    })),

    rounds: room.rounds.map(rd => ({
      beasts: rd.beasts.map(b => [b.name, !!b.isReal]),
      passOrder: rd.passOrder.map(keyOf),
      speechOrder: (rd.speechOrder || []).map(keyOf),
      speeches: (rd.speeches || []).map(s => [
        keyOf(s.playerId),
        s.text
      ]),
      votes: sortedEntries(
        Object.entries(rd.votes || {}).map(([pid, ballot]) => [
          keyOf(pid),
          Object.entries(ballot || {}).sort((a, b) => a[0].localeCompare(b[0]))
        ])
      ),
      result: rd.voteResults ? {
        rank1: [
          rd.voteResults.rank1.name,
          rd.voteResults.rank1.votes,
          !!rd.voteResults.rank1.isReal
        ],
        rank2: [
          rd.voteResults.rank2.name,
          rd.voteResults.rank2.votes,
          !!rd.voteResults.rank2.isReal
        ]
      } : null
    })),

    personVotes: sortedEntries(
      Object.entries(room.personVotes || {}).map(([pid, targetId]) => [
        keyOf(pid),
        keyOf(targetId)
      ])
    ),

    gameOver: room.gameOver ? {
      xuWon: room.gameOver.xuWon,
      totalScore: room.gameOver.totalScore,
      savedReal: room.gameOver.savedReal,
      laoCaught: room.gameOver.laoCaught,
      fangCaught: room.gameOver.fangCaught,
      xuCaught: room.gameOver.xuCaught
    } : null
  });
}

/** 還原全體 Bot 為乾淨出廠基因狀態 */
function resetToFactoryGenes() {
  const cleanStore = {};
  (GD.Roster.BOTS || []).forEach(b => {
    cleanStore[b.id] = {
      genes: GD.Roster.baseGenes(b.id),
      games: 0,
      wins: 0,
      lastDelta: {},
      history: []
    };
  });
  GD.store.set(GD.CONFIG.STORAGE.genes, cleanStore);
}

function playOne(seedStr, disableLearning, stats) {
  return U.withPRNG(
    `sim:${seedStr}`,
    () => playOneInner(seedStr, disableLearning, stats)
  );
}

function playOneInner(seedStr, disableLearning, stats) {
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

  if (stats) {
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
        room.rounds.forEach(rd => {
          const m = rd.mind[p.id];
          if (m && (m.mode === 'lie' || m.mode === 'follow') && rd.voteResults) {
            const mySpeech = (rd.speeches || []).find(s => s.playerId === p.id);
            const didIClaimIt = mySpeech && (mySpeech.p?.claims || []).some(c => c.beast === m.beast && c.real === true);
            if (!didIClaimIt) return;

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
  }

  if (!disableLearning) {
    check(GD.Learning.finalize(room), '學習引擎寫入失敗');
  }

  return room;
}

/** 驗證 1：環境亂數流與決策亂數流是否真正隔離 */
function verifyStreamIsolation() {
  let envSeq1 = [], envSeq2 = [];
  U.withPRNG('iso_test_seed', () => {
    envSeq1.push(U.rng(), U.rng(), U.rng());
  });
  U.withPRNG('iso_test_seed', () => {
    // 故意在決策流狂抽 50 次 Math.random()
    for (let k = 0; k < 50; k++) Math.random();
    envSeq2.push(U.rng(), U.rng(), U.rng());
  });
  check(JSON.stringify(envSeq1) === JSON.stringify(envSeq2), '亂數隔離失敗：Math.random() 消耗影響了 U.rng() 環境亂數流');
}

/** 驗證 2：A/A 重現性測試（相同種子與相同初始基因快照跑兩次，完整對局摘要必須 100% 一致） */
function runAASuite(count) {
  verifyStreamIsolation();
  const t0 = Date.now();
  resetToFactoryGenes();
  const initialSnapshot = JSON.stringify(GD.store.get(GD.CONFIG.STORAGE.genes, {}));

  for (let i = 0; i < count; i++) {
    const seedStr = `AA_SEED_${i}`;

    GD.store.set(GD.CONFIG.STORAGE.genes, JSON.parse(initialSnapshot));
    const room1 = playOne(seedStr, true, null);
    const d1 = getRoomDigest(room1);

    GD.store.set(GD.CONFIG.STORAGE.genes, JSON.parse(initialSnapshot));
    const room2 = playOne(seedStr, true, null);
    const d2 = getRoomDigest(room2);

    check(d1 === d2, `[A/A 不一致] 種子 ${seedStr} 兩次執行結果不同！`);
    if (d1 !== d2) break;
  }

  console.log(`✓ A/A 重現性與亂數流隔離校驗：${count} 組種子全數一致｜耗時 ${Date.now() - t0} ms｜失敗項 ${fails}`);
}

if (isAAOnly) {
  console.log(`\n=== 執行 A/A 重現性與亂數隔離校驗 (${N} 組種子) ===`);
  runAASuite(N);
  const flushRes = GD.store.flush();
  check(flushRes.fails === 0, `快取落盤失敗: ${flushRes.error}`);
  console.log(`✓ 快取落盤校驗：路徑 ${flushRes.path}｜${flushRes.bytes} bytes｜序列化 ${flushRes.serializeMs.toFixed(2)} ms｜寫入 ${flushRes.ioMs.toFixed(2)} ms｜讀回驗證 ${flushRes.verifyMs.toFixed(2)} ms`);
  process.exit(fails ? 1 : 0);
}

// 正式 A/B 測試前，強制先跑 25 組 A/A 前置校驗確保基座無誤
console.log(`\n=== 步驟 1：前置 A/A 重現性與亂數隔離校驗 (25 組種子) ===`);
runAASuite(25);
if (fails > 0) {
  console.error('✗ 前置 A/A 校驗未通過，中止 A/B 測試！');
  process.exit(1);
}

const statsA = createStats();
const statsB = createStats();

console.log(`\n=== 步驟 2：執行 A/B 測試 (${N} 局 x 2 組, 雙軌固定種子成對比較) ===\n`);

resetToFactoryGenes();
let t0 = Date.now();
let envMismatch = 0;
const envDigestsA = [];

for (let i = 0; i < N; i++) {
  try {
    const rA = playOne(`SEED_${i}`, true, statsA);
    // 記錄 A 組客觀環境特徵（玩家身分分配與三輪四獸首真偽）
    envDigestsA.push(JSON.stringify({
      roles: rA.players.map(p => [p.botId || p.name, p.role]),
      beasts: rA.rounds.map(rd => rd.beasts.map(b => [b.name, b.isReal]))
    }));
  } catch (e) {
    fails++;
    console.error(`  ✗ A組第${i}局錯誤:`, e.stack.split('\n')[0]);
  }
}
statsA.timeMs = Date.now() - t0;

// 重置為相同初始基因，讓 B 組從頭開始學習
resetToFactoryGenes();
t0 = Date.now();
for (let i = 0; i < N; i++) {
  try {
    const rB = playOne(`SEED_${i}`, false, statsB);
    const envB = JSON.stringify({
      roles: rB.players.map(p => [p.botId || p.name, p.role]),
      beasts: rB.rounds.map(rd => rd.beasts.map(b => [b.name, b.isReal]))
    });
    if (envB !== envDigestsA[i]) envMismatch++;
  } catch (e) {
    fails++;
    console.error(`  ✗ B組第${i}局錯誤:`, e.stack.split('\n')[0]);
  }
}
statsB.timeMs = Date.now() - t0;

check(envMismatch === 0, `A/B 環境抽樣脫鉤局數: ${envMismatch}`);
console.log(`✓ A/B 客觀環境（角色配置＋三輪獸首真偽）配對檢查：${N - envMismatch}/${N} 局 100% 對齊\n`);

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
  console.log(`模擬耗時: ${s.timeMs} ms\n`);
  return { goodWin, dupedRate, hitLaoRate, s };
}

const rA = printStats('A 組：出廠基因凍結', statsA);
const rB = printStats('B 組：學習引擎開啟', statsB);

console.log(`👉 學習效益評估 (Paired Comparison)：`);
console.log(`好人勝率變化：${(rB.goodWin - rA.goodWin).toFixed(1)}%`);
console.log(`好人被騙票率變化：${(rB.dupedRate - rA.dupedRate).toFixed(1)}%`);
console.log(`好人鑑人命中變化：${(rB.hitLaoRate - rA.hitLaoRate).toFixed(1)}%`);

const store = GD.store.get(GD.CONFIG.STORAGE.genes, {});
const bots = Object.entries(store).filter(x => x[1].games > 0);
if (bots.length) {
  let diffSum = { skepticism: 0, deception: 0, camouflage: 0, assertiveness: 0, conformity: 0 };
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
  Object.keys(diffSum).forEach(k => console.log(`  ${k}: ${(diffSum[k] / bots.length).toFixed(3)}`));
  console.log(`全場最大單一基因變動：${maxDiff.botName} 的 ${maxDiff.gene} 從 ${maxDiff.old} 變為 ${maxDiff.new} (變化 ${maxDiff.val.toFixed(3)})`);
}

// 步驟 3：顯式執行快取落盤並驗證
const flushRes = GD.store.flush();
check(flushRes.fails === 0, `快取落盤失敗: ${flushRes.error}`);
console.log(`\n=== 步驟 3：快取顯式落盤與讀回驗證 ===`);
console.log(`檔案路徑：${flushRes.path}`);
console.log(`資料規模：${flushRes.keys} keys ｜ ${flushRes.bytes} bytes`);
console.log(`分段耗時：序列化 ${flushRes.serializeMs.toFixed(2)} ms ｜ 磁碟寫入(含fsync) ${flushRes.ioMs.toFixed(2)} ms ｜ 讀回驗證 ${flushRes.verifyMs.toFixed(2)} ms`);
console.log(`總失敗項：${fails}`);

process.exit(fails ? 1 : 0);