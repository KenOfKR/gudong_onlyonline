/* ============================================================================
 * tests/multi_epoch.js — 多批次、獨立種子區間的配對學習效益驗證
 * 用法：node tests/multi_epoch.js [epochs=10] [gamesPerEpoch=1500] [--skip-aa]
 *
 * 每個 epoch 重新將 A/B 基因重置為出廠值；A 凍結基因，B 在該 epoch 內滾動學習。
 * 每個 epoch 使用互不重複的種子命名空間，同一 epoch 的 A/B 使用配對種子。
 * 統計推論的單位是 epoch，不把同一條滾動學習軌跡中的各局錯當成獨立樣本。
 * ========================================================================== */
'use strict';
const GD = require('./harness')();
const { Engine, Strategy, Speech, Mind, U } = GD;
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('-'));
const EPOCHS = Number.parseInt(positional[0], 10) || 10;
const GAMES_PER_EPOCH = Number.parseInt(positional[1], 10) || 1500;
const SKIP_AA = args.includes('--skip-aa');
if (!Number.isInteger(EPOCHS) || EPOCHS < 2) throw new Error('epochs 必須至少為 2');
if (!Number.isInteger(GAMES_PER_EPOCH) || GAMES_PER_EPOCH < 1) throw new Error('gamesPerEpoch 必須至少為 1');
GD.store.set(GD.CONFIG.STORAGE.useGemini, false);
let fails = 0;
let trustedGoodMetricMissing = false;
const check = (cond, msg) => {
  if (!cond) {
    fails++;
    if (fails <= 20) console.error('  ✗', msg);
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
    events: { xuCaught: 0, fangCaught: 0, laoCaught: 0 },
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
      seatIndex: p.seatIndex,
      confusedRound: typeof p.confusedRound === 'number' ? p.confusedRound : null
    })),
    starter: room.plan ? keyOf(room.plan.starterId) : null,

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
  (GD.Roster.list || []).forEach(b => {
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

  if (room.status !== 'gameover' || !room.gameOver) {
    check(false, `對局未能結束：${seedStr}`);
    return room;
  }

  if (stats) {
    stats.totalGames++;
    const g = room.gameOver;
    stats.events.xuCaught += g.xuCaught ? 1 : 0;
    stats.events.fangCaught += g.fangCaught ? 1 : 0;
    stats.events.laoCaught += g.laoCaught ? 1 : 0;
    room.players.forEach(p => {
      const isGood = GD.isGood(p.role);
      if ((isGood && g.xuWon) || (!isGood && !g.xuWon)) {
        stats.wins[p.role]++;
      }

      if (isGood) {
        const f = GD.Learning.ballotFacts(room, p);
        stats.goodVotes += (f.real + f.fake);
        stats.dupedVotes += f.duped.reduce((sum, item) => sum + item.n, 0);
        if (Array.isArray(f.trustedGood)) {
          stats.trustedGoodVotes += f.trustedGood.reduce((sum, item) => sum + item.n, 0);
        } else {
          trustedGoodMetricMissing = true;
        }

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
  const failuresAtStart = fails;
  verifyStreamIsolation();
  const t0 = Date.now();
  resetToFactoryGenes();
  const initialSnapshot = JSON.stringify(GD.store.get(GD.CONFIG.STORAGE.genes, {}));
  let passed = 0;

  for (let i = 0; i < count; i++) {
    const seedStr = `AA_SEED_${i}`;

    GD.store.set(GD.CONFIG.STORAGE.genes, JSON.parse(initialSnapshot));
    const room1 = playOne(seedStr, true, null);
    const d1 = getRoomDigest(room1);

    GD.store.set(GD.CONFIG.STORAGE.genes, JSON.parse(initialSnapshot));
    const room2 = playOne(seedStr, true, null);
    const d2 = getRoomDigest(room2);

    if (d1 !== d2) {
      check(false, `[A/A 不一致] 種子 ${seedStr} 兩次執行結果不同！`);
      break;
    }
    passed++;
  }

  const ok = passed === count && fails === failuresAtStart;
  console.log(`${ok ? '✓' : '✗'} A/A 重現性與亂數流隔離校驗：${passed}/${count} 組一致｜耗時 ${Date.now() - t0} ms｜累計失敗項 ${fails}`);
  return ok;
}


/** 以角色欄位而不是玩家數量作為各角勝率的分母。 */
const GOOD_ROLES = ['許願', '方震', '姬雲浮', '黃煙煙', '木戶加奈'];
const EVIL_ROLES = ['老朝奉', '藥不然', '鄭國渠'];
const ALL_ROLES = [...GOOD_ROLES, ...EVIL_ROLES];
const rate = (num, den) => den ? num / den : 0;
function metrics(s) {
  const goodWins = GOOD_ROLES.reduce((sum, role) => sum + (s.wins[role] || 0), 0);
  const evilWins = EVIL_ROLES.reduce((sum, role) => sum + (s.wins[role] || 0), 0);
  const out = {
    goodWin: rate(goodWins, GOOD_ROLES.length * s.totalGames),
    evilWin: rate(evilWins, EVIL_ROLES.length * s.totalGames),
    dupedRate: rate(s.dupedVotes, s.goodVotes),
    trustedGoodRate: rate(s.trustedGoodVotes, s.goodVotes),
    hitLaoRate: rate(s.personVotes.hitLao, s.personVotes.total),
    xuCaughtRate: rate(s.events.xuCaught, s.totalGames),
    fangCaughtRate: rate(s.events.fangCaught, s.totalGames),
    laoCaughtRate: rate(s.events.laoCaught, s.totalGames),
    lieEffectRate: rate(s.badLiesEffective, s.badLies)
  };
  ALL_ROLES.forEach(role => { out[`role:${role}`] = rate(s.wins[role] || 0, s.totalGames); });
  return out;
}

function environmentDigest(room) {
  const keyOf = id => {
    const p = U.byId(room, id);
    if (!p) return String(id);
    return p.botId ? `bot:${p.botId}` : `human:${p.name}`;
  };
  return JSON.stringify({
    players: room.players.map(p => [keyOf(p.id), p.role, p.seatIndex, p.confusedRound]),
    starter: room.plan ? keyOf(room.plan.starterId) : null,
    beasts: room.rounds.map(rd => rd.beasts.map(b => [b.name, !!b.isReal]))
  });
}

// 95% 雙尾 Student-t 臨界值；小樣本不使用固定 1.96。
const T95 = [
  0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
  2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
  2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045,
  2.042
];
function tCritical95(df) {
  if (df < T95.length) return T95[df];
  // Cornish–Fisher 展開，適用於 df > 30，避免直接使用 1.96 低估 t 臨界值。
  const z = 1.959963984540054;
  return z + (z ** 3 + z) / (4 * df)
    + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2)
    + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}
function summarizeDelta(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const ss = values.reduce((a, x) => a + (x - mean) ** 2, 0);
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : NaN;
  const se = sd / Math.sqrt(n);
  const df = n - 1;
  const t = tCritical95(df);
  return { n, mean, sd, se, t, lo: mean - t * se, hi: mean + t * se };
}
const pct = x => `${(x * 100).toFixed(2)}%`;
const pp = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(3)} pp`;

function summarizeGenes() {
  const store = GD.store.get(GD.CONFIG.STORAGE.genes, {}) || {};
  const bots = Object.entries(store).filter(([, data]) => (data.games || 0) > 0);
  const keys = GD.Genes.KEYS;
  const means = Object.fromEntries(keys.map(k => [k, 0]));
  let max = { botName: '', gene: '', val: 0, old: 0, now: 0 };
  if (!bots.length) return { means, max, botCount: 0 };
  bots.forEach(([id, data]) => {
    const base = GD.Roster.baseGenes(id);
    keys.forEach(k => {
      const d = Math.abs((data.genes || base)[k] - base[k]);
      means[k] += d;
      if (d > max.val) {
        const def = GD.Roster.byId(id);
        max = { botName: def ? def.name : id, gene: k, val: d, old: base[k], now: (data.genes || base)[k] };
      }
    });
  });
  keys.forEach(k => { means[k] /= bots.length; });
  return { means, max, botCount: bots.length };
}

function reportFlush() {
  if (typeof GD.store.flush !== 'function') {
    check(false, 'GD.store.flush 不存在；請先更新 tests/harness.js');
    return null;
  }
  const f = GD.store.flush();
  console.log(`快取落盤：${f.path}｜${f.keys} keys｜${f.bytes} bytes｜序列化 ${f.serializeMs.toFixed(2)} ms｜寫入+fsync ${f.ioMs.toFixed(2)} ms｜讀回驗證 ${f.verifyMs.toFixed(2)} ms｜失敗 ${f.fails}`);
  if (f.fails || f.error) check(false, `快取落盤失敗：${f.error || f.fails}`);
  return f;
}

if (!SKIP_AA) {
  console.log(`=== 前置 A/A 校驗（25 組種子）===`);
  const aaPassed = runAASuite(25);
  if (!aaPassed || fails) {
    console.error('A/A 校驗失敗，停止多輪 A/B 測試。');
    reportFlush();
    console.error('請先修復 A/A 校驗失敗，再重新執行。');
    process.exit(1);
  } else {
    console.log('前置 A/A 通過。');
  }
} else {
  console.log('⚠️ 已跳過前置 A/A 校驗（--skip-aa）');
}

console.log(`\n=== 多輪配對 A/B：${EPOCHS} epochs × ${GAMES_PER_EPOCH} 局／組 ===`);
console.log('每個 epoch 都重新從出廠基因開始；A 凍結，B 在該批內持續學習。');
console.log('每個 epoch 的 A/B 使用同一組種子；不同 epoch 使用不重複的種子命名空間。\n');

const epochRows = [];
// U.seedHash 是 32-bit；先為 environment/decision stream 檢查並消除本次批次內的初始狀態碰撞。
function buildSeedGrid() {
  const envHashes = new Set();
  const decisionHashes = new Set();
  const grid = Array.from({ length: EPOCHS }, () => new Array(GAMES_PER_EPOCH));
  let collisionSalts = 0;
  for (let e = 0; e < EPOCHS; e++) {
    for (let i = 0; i < GAMES_PER_EPOCH; i++) {
      let salt = 0;
      let candidate, envHash, decisionHash;
      do {
        candidate = `ME_E${String(e + 1).padStart(3, '0')}_G${String(i).padStart(6, '0')}_S${salt}`;
        const streamSeed = `sim:${candidate}`;
        envHash = U.seedHash(`${streamSeed}::environment`);
        decisionHash = U.seedHash(`${streamSeed}::decision`);
        if (envHashes.has(envHash) || decisionHashes.has(decisionHash)) {
          salt++;
          collisionSalts++;
        } else break;
      } while (true);
      envHashes.add(envHash);
      decisionHashes.add(decisionHash);
      grid[e][i] = candidate;
    }
  }
  console.log(`亂數初始狀態校驗：${EPOCHS * GAMES_PER_EPOCH} 組唯一種子｜碰撞避讓 ${collisionSalts} 次`);
  return grid;
}
const seedGrid = buildSeedGrid();
const metricNames = [
  ['goodWin', '好人勝率'],
  ['dupedRate', '被騙票率'],
  ['trustedGoodRate', '成功跟隨好人率'],
  ['hitLaoRate', '好人鑑人指認老朝奉率'],
  ['laoCaughtRate', '老朝奉實際被抓率'],
  ['xuCaughtRate', '許願被抓率'],
  ['fangCaughtRate', '方震被抓率'],
  ['lieEffectRate', '壞人謊言高轉換率'],
  ...ALL_ROLES.map(role => [`role:${role}`, `${role}勝率`])
];

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  const statsA = createStats();
  const statsB = createStats();
  const envA = new Array(GAMES_PER_EPOCH);
  const envMismatchIndices = [];
  const seedFor = i => seedGrid[epoch - 1][i];

  resetToFactoryGenes();
  let t0 = Date.now();
  for (let i = 0; i < GAMES_PER_EPOCH; i++) {
    try {
      const room = playOne(seedFor(i), true, statsA);
      envA[i] = environmentDigest(room);
    } catch (e) {
      fails++;
      if (fails <= 20) console.error(`  ✗ E${epoch} A 組第 ${i + 1} 局：${e.stack?.split('\n')[0] || e}`);
      envA[i] = null;
    }
  }
  const timeA = Date.now() - t0;

  resetToFactoryGenes();
  t0 = Date.now();
  for (let i = 0; i < GAMES_PER_EPOCH; i++) {
    try {
      const room = playOne(seedFor(i), false, statsB);
      const envB = environmentDigest(room);
      if (envA[i] !== envB) envMismatchIndices.push(i);
    } catch (e) {
      fails++;
      if (fails <= 20) console.error(`  ✗ E${epoch} B 組第 ${i + 1} 局：${e.stack?.split('\n')[0] || e}`);
      envMismatchIndices.push(i);
    }
  }
  const timeB = Date.now() - t0;
  if (envMismatchIndices.length) {
    fails++;
    console.error(`  ✗ E${epoch} 環境配對失敗：${envMismatchIndices.length}/${GAMES_PER_EPOCH} 局；首幾局索引=${envMismatchIndices.slice(0, 8).join(',')}`);
  }

  const a = metrics(statsA), b = metrics(statsB);
  const delta = Object.fromEntries(metricNames.map(([key]) => [key, b[key] - a[key]]));
  const genes = summarizeGenes();
  epochRows.push({ epoch, seeds: GAMES_PER_EPOCH, timeA, timeB, envMismatch: envMismatchIndices.length, a, b, delta, genes });

  console.log(`E${String(epoch).padStart(2, '0')}｜配對環境 ${GAMES_PER_EPOCH - envMismatchIndices.length}/${GAMES_PER_EPOCH}｜A ${timeA} ms｜B ${timeB} ms｜好人勝率 A ${pct(a.goodWin)} / B ${pct(b.goodWin)} / Δ ${pp(delta.goodWin)}｜被騙票率 Δ ${pp(delta.dupedRate)}｜抓老朝奉 Δ ${pp(delta.hitLaoRate)}｜B 基因樣本 ${genes.botCount}`);
  if (genes.botCount) {
    console.log('   基因平均絕對變動：' + Object.entries(genes.means).map(([k,v]) => `${k} ${(v).toFixed(3)}`).join('｜'));
    console.log(`   最大變動：${genes.max.botName} ${genes.max.gene} ${genes.max.old} → ${genes.max.now}（${genes.max.val.toFixed(3)}）`);
  }
}

console.log('\n=== 跨 Epoch 配對差異與 95% Student-t 信賴區間 ===');
console.log(`統計單位：${EPOCHS} 個獨立重置的 epoch；每批 ${GAMES_PER_EPOCH} 局／組。`);
console.log('主要終點預先指定為「好人勝率 Δ = B − A」；其他指標與角色差異視為次要／探索性分析。\n');
const summaries = {};
for (const [key, label] of metricNames) {
  const s = summarizeDelta(epochRows.map(row => row.delta[key]));
  summaries[key] = s;
  console.log(`${label.padEnd(18, ' ')}平均 Δ ${pp(s.mean).padEnd(13, ' ')}｜95% CI [${pp(s.lo)}, ${pp(s.hi)}]｜epoch SD ${(s.sd * 100).toFixed(3)} pp`);
}

if (trustedGoodMetricMissing) {
  check(false, 'GD.Learning.ballotFacts 未提供 trustedGood，成功跟隨好人率無法可靠計算；請同步更新 learning.js，禁止以 0% 代替缺失資料。');
}
const primary = summaries.goodWin;
if (fails > 0 || epochRows.some(row => row.envMismatch > 0)) {
  console.log('判讀：本次有模擬失敗或環境配對不一致，統計推論無效；先修復問題後重跑。');
} else if (primary.lo > 0) {
  console.log('\n判讀：主要終點的 95% CI 下限大於 0；在此測試設計假設下，結果支持學習流程提升好人勝率。仍需外部種子／不同版本重現。');
} else if (primary.hi < 0) {
  console.log('\n判讀：主要終點的 95% CI 上限小於 0；結果支持學習流程降低好人勝率。');
} else {
  console.log('\n判讀：主要終點的 95% CI 包含 0；目前證據不足以判定學習流程改善或傷害好人勝率。');
}
console.log('注意：不要只挑選有利的次要指標宣告成功；若要把多個次要指標作為正式結論，應預先指定假設並進行多重比較校正。');

const flushRes = reportFlush();
console.log(`\n總失敗項：${fails}`);
// 保留每個 epoch 的完整摘要，方便後續重算、畫圖或檢查異常批次。
const summaryPath = process.env.GD_EPOCH_REPORT_PATH;
if (summaryPath) {
  const fs = require('fs');
  try {
    fs.writeFileSync(summaryPath, JSON.stringify({
      epochs: EPOCHS,
      gamesPerEpoch: GAMES_PER_EPOCH,
      primaryEndpoint: 'goodWin',
      rows: epochRows,
      summaries,
      failures: fails,
      flush: flushRes
    }, null, 2), 'utf8');
    console.log(`JSON 報表：${summaryPath}`);
  } catch (e) {
    fails++;
    console.error(`JSON 報表寫入失敗：${e.message}`);
  }
}
process.exitCode = fails ? 1 : 0;
