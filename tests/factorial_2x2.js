/* ============================================================================
 * tests/factorial_2x2.js
 * v9.0 雙基因 2×2 因子交互作用驗證（沿用 304 組固定種子清單）
 *
 * 測試矩陣：
 *   1. deception × camouflage   : (0.4, 0.4), (0.4, 0.6), (0.6, 0.4), (0.6, 0.6)
 *   2. skepticism × assertiveness: (0.4, 0.4), (0.4, 0.6), (0.6, 0.4), (0.6, 0.6)
 *
 * 用法（從專案根目錄）：
 *   node tests/factorial_2x2.js [targetBot=水豚] [low=0.4] [high=0.6]
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const GD = require('./harness')();
const { Engine, Strategy, Speech, Mind, U } = GD;

const args = process.argv.slice(2);
const TARGET_NAME = args[0] || '水豚';
const LOW = args[1] === undefined ? 0.4 : Number(args[1]);
const HIGH = args[2] === undefined ? 0.6 : Number(args[2]);
const SEEDS_PATH = process.env.OFAT_LOAD_SEEDS || path.resolve(__dirname, 'ofat_seeds_300.json');
const REPORT_PATH = process.env.FACTORIAL_REPORT_PATH || path.resolve(process.cwd(), 'factorial-2x2-04-06.json');

if (!Engine || !Strategy || !Speech || !Mind || !U) {
  throw new Error('GD 模組不完整；請確認 tests/harness.js 已載入 Engine、Strategy、Speech、Mind、U。');
}
if (!fs.existsSync(SEEDS_PATH)) {
  throw new Error(`找不到固定種子清單：${SEEDS_PATH}。請確認檔案存在，本測試禁止另造新種子代替。`);
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const round = (x, n = 4) => Number.isFinite(x) ? Number(x.toFixed(n)) : null;
const avg = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const pct = x => x == null ? 'n/a' : `${(x * 100).toFixed(2)}%`;
const pp = x => x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)} pp`;
const number = x => x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;

const playerKey = (room, id) => {
  if (id == null) return null;
  const p = U.byId(room, id);
  return p ? (p.botId ? `bot:${p.botId}` : `human:${p.name}`) : String(id);
};
const targetMatches = (p, targetName, targetBotId) => !!p && !!p.botId &&
  (p.botId === targetBotId || p.name === targetName || p.botId === targetName);

function environmentSignature(room) {
  const plannedRounds = room.plan?.rounds?.length ? room.plan.rounds : (room.rounds || []);
  return {
    players: (room.players || []).map((p, i) => ({
      key: p.botId ? `bot:${p.botId}` : `human:${p.name}`,
      role: p.role || null,
      seat: p.seatIndex == null ? i : p.seatIndex,
      confusedRound: Number.isFinite(p.confusedRound) ? p.confusedRound : null
    })).sort((a, b) => a.key.localeCompare(b.key)),
    starter: room.plan ? playerKey(room, room.plan.starterId) : null,
    truths: plannedRounds.map(rd => (rd.beasts || []).map(b => [b.name, !!b.isReal]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function detectSuspectedFangBeforeTurn(room, excludeId) {
  for (let r = 0; r <= room.currentRoundIdx; r++) {
    const rd = room.rounds[r];
    if (!rd) continue;
    for (const sp of (rd.speeches || [])) {
      if (sp.playerId === excludeId) continue;
      const txt = String(sp.text || '');
      if ((sp.p && (sp.p.campChecks?.length || sp.p.callSuspectId)) || /鐵好人|鐵壞人|陣營|一起指認|看緊/.test(txt)) {
        return sp.playerId;
      }
    }
  }
  return null;
}

function emptyMetrics() {
  return {
    planTurns: 0, evilPlanTurns: 0, liePlans: 0, lieDoubleClaims: 0, followPlans: 0, camouflagePlans: 0,
    confessOpportunities: 0, confessPlans: 0,
    publicSuspectPlans: 0, askPlans: 0,
    goodAccusations: 0, goodFalseAccusations: 0, goodCorrectAccusations: 0,
    goodR3PlanTurns: 0, goodR3PublicSuspectPlans: 0, goodR3Accusations: 0, goodR3FalseAccusations: 0,
    profileRiskGapSum: 0, profileRiskGapN: 0,
    fakeFangPlans: 0, fakeFangPlanTurns: 0,
    fakeFangCluedTurns: 0, fakeFangCluedPlans: 0,
    fakeFangBlindTurns: 0, fakeFangBlindPlans: 0,
    fakeFangR1Turns: 0, fakeFangR1Plans: 0,
    fakeFangLaterTurns: 0, fakeFangLaterPlans: 0,
    ballotTurns: 0, evilBallotTurns: 0, splitEvilBallots: 0,
    claimedRealVoteChecks: 0, claimedRealZeroVotes: 0, claimedRealMajorityVotes: 0,
    claimedRealChipsBacked: 0, claimedRealChipsTotal: 0,
    camoClaimChecks: 0, camoClaimChipsBacked: 0, camoClaimChipsTotal: 0,
    lieClaimChecks: 0, lieClaimChipsBacked: 0, lieClaimChipsTotal: 0,
    chipsAvailable: 0, chipsSpent: 0, fakeChips: 0, realChips: 0,
    evilRound3PlanTurns: 0, evilRound3SuspectPlans: 0,
    laoSkillChecks: 0, laoSkillActivations: 0
  };
}

function getProfileRiskGap(A, room, bot) {
  if (!A || !A.prof || !bot || !GD.isGood(bot.role)) return null;
  const riskGood = [], riskEvil = [];
  for (const p of room.players || []) {
    if (p.id === bot.id) continue;
    const rec = A.prof[p.id];
    if (!rec || !Number.isFinite(rec.evil)) continue;
    (GD.isGood(p.role) ? riskGood : riskEvil).push(rec.evil);
  }
  if (!riskGood.length || !riskEvil.length) return null;
  return avg(riskEvil) - avg(riskGood);
}

function runGame2x2({ seed, targetBotId, geneOverrides }) {
  if (GD.Genes && typeof GD.Genes.reset === 'function') GD.Genes.reset();

  return U.withPRNG(`OFAT:${seed}`, () => {
    const room = Engine.newRoom(`OFAT_${seed}`, 'host');
    Engine.addPlayer(room, { id: 'h1', name: '真人甲' });
    Engine.fillBots(room);
    const beforeStart = room.players.find(p => targetMatches(p, TARGET_NAME, targetBotId));
    if (!beforeStart) return { seed, targetPresent: false };
    if (!Engine.start(room)) throw new Error(`Engine.start 失敗：${seed}`);

    const target = room.players.find(p => targetMatches(p, TARGET_NAME, targetBotId));
    if (!target) throw new Error(`Engine.start 後找不到目標 Bot：${seed}`);
    const resolvedBotId = target.botId;
    const baseGenes = clone(GD.Roster.baseGenes(resolvedBotId));
    target.genes = { ...baseGenes, ...geneOverrides };
    const role = target.role;
    const metrics = emptyMetrics();
    let guard = 0;

    while (room.status !== 'gameover' && guard++ < 500) {
      const rd = U.curRound(room);
      if (room.status === 'playing') {
        const p = U.byId(room, room.currentTurnPlayerId);
        if (!p) throw new Error(`playing 階段找不到 currentTurnPlayerId；seed=${seed}`);
        const log = Engine.log(room, p.id);
        if (log.step === 'a') {
          const picks = Strategy.inspectPicks(p, room);
          (picks || []).forEach(name => Engine.inspect(room, p.id, name));
        }
        const A = Mind.analyze(p, room);
        const skill = Strategy.skill(p, room, A);
        if (p.botId === resolvedBotId && role === '老朝奉' && skill && skill.kind === 'lao') {
          metrics.laoSkillChecks++;
          if (skill.active) metrics.laoSkillActivations++;
        }
        const nextId = Strategy.nextPlayer(p, room, A);
        Engine.skill(room, p.id, skill);
        Engine.pass(room, p.id, nextId);
      } else if (room.status === 'discussion') {
        const p = U.byId(room, room.currentSpeakerId);
        if (!p) throw new Error(`discussion 階段找不到 currentSpeakerId；seed=${seed}`);
        const hasFangClueBefore = !!detectSuspectedFangBeforeTurn(room, p.id);
        const result = Strategy.plan(p, room);
        const plan = result && result.plan;
        const A = result && result.A;
        if (p.botId === resolvedBotId && plan) {
          const isEvil = !GD.isGood(role);
          metrics.planTurns++;
          if (isEvil) {
            metrics.evilPlanTurns++;
            if (plan.mode === 'lie') {
              metrics.liePlans++;
              if (Array.isArray(plan.claims) && plan.claims.length >= 2) metrics.lieDoubleClaims++;
            }
            if (plan.mode === 'follow') metrics.followPlans++;
            if (plan.mode === 'camouflage') metrics.camouflagePlans++;
            if (room.currentRoundIdx === 2) {
              metrics.evilRound3PlanTurns++;
              if (plan.suspectId) metrics.evilRound3SuspectPlans++;
            }
            if ((role === '藥不然' || role === '鄭國渠') && A && A.askedMe && A.myFake && A.myFake.length) {
              metrics.confessOpportunities++;
              if (plan.confess) metrics.confessPlans++;
            }
          } else {
            if (room.currentRoundIdx === 2) {
              metrics.goodR3PlanTurns++;
              if (plan.suspectId || plan.softShadeId) metrics.goodR3PublicSuspectPlans++;
            }
            const accusedIds = [...new Set([plan.suspectId, plan.softShadeId].filter(Boolean))];
            accusedIds.forEach(id => {
              const accused = U.byId(room, id);
              if (!accused) return;
              metrics.goodAccusations++;
              if (GD.isGood(accused.role)) metrics.goodFalseAccusations++;
              else metrics.goodCorrectAccusations++;
              if (room.currentRoundIdx === 2) {
                metrics.goodR3Accusations++;
                if (GD.isGood(accused.role)) metrics.goodR3FalseAccusations++;
              }
            });
          }
          if (plan.suspectId || plan.softShadeId) metrics.publicSuspectPlans++;
          if (plan.askId) metrics.askPlans++;

          if (['黃煙煙', '木戶加奈', '姬雲浮'].includes(role)) {
            const jumped = !!plan.fakeFangClaim;
            metrics.fakeFangPlanTurns++;
            if (jumped) metrics.fakeFangPlans++;
            if (hasFangClueBefore) {
              metrics.fakeFangCluedTurns++;
              if (jumped) metrics.fakeFangCluedPlans++;
            } else {
              metrics.fakeFangBlindTurns++;
              if (jumped) metrics.fakeFangBlindPlans++;
            }
            if (room.currentRoundIdx === 0) {
              metrics.fakeFangR1Turns++;
              if (jumped) metrics.fakeFangR1Plans++;
            } else {
              metrics.fakeFangLaterTurns++;
              if (jumped) metrics.fakeFangLaterPlans++;
            }
          }

          const gap = getProfileRiskGap(A, room, p);
          if (gap != null) {
            metrics.profileRiskGapSum += gap;
            metrics.profileRiskGapN++;
          }
        }
        const speech = Speech.localSpeech(p, room, plan, A);
        const validation = Speech.validate(speech, p, room, plan, A);
        if (!validation || !validation.ok) {
          throw new Error(`發言驗證失敗 seed=${seed}: ${validation && validation.why ? validation.why : 'unknown'}`);
        }
        Engine.speak(room, p.id, { text: speech, source: p.botId ? 'bot' : 'human' });
      } else if (room.status === 'voting') {
        if (!rd.voteResults) {
          room.players.forEach(p => {
            if (rd.votes[p.id] !== undefined) return;
            const available = Number(p.voteBank) || 0;
            const ballot = Strategy.ballot(p, room) || {};
            if (p.botId === resolvedBotId) {
              metrics.ballotTurns++;
              if (!GD.isGood(role)) metrics.evilBallotTurns++;
              const chips = Object.entries(ballot).reduce((sum, [, n]) => sum + Math.max(0, Number(n) || 0), 0);
              metrics.chipsAvailable += Math.max(0, available);
              metrics.chipsSpent += chips;
              if (!GD.isGood(role) && Object.values(ballot).filter(n => (Number(n) || 0) > 0).length > 1) {
                metrics.splitEvilBallots++;
              }

              const mySpeech = (rd.speeches || []).find(sp => sp.playerId === p.id);
              const claimedRealBeasts = [];
              if (mySpeech && mySpeech.p && mySpeech.p.claims) {
                mySpeech.p.claims.forEach(c => { if (c.real) claimedRealBeasts.push(c.beast); });
              }
              const myMind = rd.mind && rd.mind[p.id];

              if (!GD.isGood(role) && claimedRealBeasts.length > 0 && chips > 0) {
                const backedChips = claimedRealBeasts.reduce((sum, bName) => sum + Math.max(0, Number(ballot[bName]) || 0), 0);
                const isZero = backedChips === 0;
                const isMajority = backedChips * 2 >= chips && backedChips > 0;

                metrics.claimedRealVoteChecks++;
                metrics.claimedRealChipsBacked += backedChips;
                metrics.claimedRealChipsTotal += chips;
                if (isZero) metrics.claimedRealZeroVotes++;
                if (isMajority) metrics.claimedRealMajorityVotes++;

                if (myMind && myMind.mode === 'camouflage') {
                  metrics.camoClaimChecks++;
                  metrics.camoClaimChipsBacked += backedChips;
                  metrics.camoClaimChipsTotal += chips;
                } else if (myMind && (myMind.mode === 'lie' || myMind.mode === 'follow')) {
                  metrics.lieClaimChecks++;
                  metrics.lieClaimChipsBacked += backedChips;
                  metrics.lieClaimChipsTotal += chips;
                }
              }

              for (const [beastName, rawCount] of Object.entries(ballot)) {
                const count = Math.max(0, Number(rawCount) || 0);
                const beast = rd.beasts.find(b => b.name === beastName);
                if (beast && count > 0) (beast.isReal ? metrics.realChips += count : metrics.fakeChips += count);
              }
            }
            Engine.vote(room, p.id, ballot);
          });
        }
        Engine.advance(room);
      } else if (room.status === 'person_voting') {
        room.players.forEach(p => {
          if (room.personVotes[p.id]) return;
          const decision = Strategy.personVote(p, room);
          p.final = decision;
          Engine.personVote(room, p.id, decision.targetId);
        });
      } else {
        throw new Error(`未知房間狀態 ${room.status}; seed=${seed}`);
      }
    }

    if (room.status !== 'gameover') throw new Error(`對局未結束，seed=${seed}, guard=${guard}`);
    return {
      seed, targetPresent: true, botId: resolvedBotId, role,
      isGood: GD.isGood(role),
      environment: environmentSignature(room),
      metrics
    };
  });
}

function addMetrics(a, b) {
  for (const key of Object.keys(a)) {
    if (typeof a[key] === 'number') a[key] += Number(b[key] || 0);
  }
  return a;
}

function computeMetricWithDenom(m) {
  const item = (n, d) => ({ val: d > 0 ? n / d : null, num: n, den: d });
  return {
    // deception x camouflage 核心指標
    lieRate: item(m.liePlans, m.evilPlanTurns),
    camouflageRate: item(m.camouflagePlans, m.evilPlanTurns),
    doubleClaimRate: item(m.lieDoubleClaims, m.liePlans),
    splitVoteRate: item(m.splitEvilBallots, m.evilBallotTurns),
    claimChipShare: item(m.claimedRealChipsBacked, m.claimedRealChipsTotal),
    claimZeroVoteRate: item(m.claimedRealZeroVotes, m.claimedRealVoteChecks),
    claimMajorityVoteRate: item(m.claimedRealMajorityVotes, m.claimedRealVoteChecks),
    camoClaimChipShare: item(m.camoClaimChipsBacked, m.camoClaimChipsTotal),
    lieClaimChipShare: item(m.lieClaimChipsBacked, m.lieClaimChipsTotal),
    round3SuspectRate: item(m.evilRound3SuspectPlans, m.evilRound3PlanTurns),
    fakeVoteChipShare: item(m.fakeChips, m.chipsSpent),
    // skepticism x assertiveness 核心指標
    profileRiskGap: item(m.profileRiskGapSum, m.profileRiskGapN),
    publicSuspectRate: item(m.publicSuspectPlans, m.planTurns),
    falseAccusationRate: item(m.goodFalseAccusations, m.goodAccusations),
    goodR3SuspectRate: item(m.goodR3PublicSuspectPlans, m.goodR3PlanTurns),
    goodR3FalseAccusationRate: item(m.goodR3FalseAccusations, m.goodR3Accusations),
    askRate: item(m.askPlans, m.planTurns),
    voteSpendRate: item(m.chipsSpent, m.chipsAvailable),
    fakeFangRate: item(m.fakeFangPlans, m.fakeFangPlanTurns),
    fakeFangCluedRate: item(m.fakeFangCluedPlans, m.fakeFangCluedTurns),
    fakeFangBlindRate: item(m.fakeFangBlindPlans, m.fakeFangBlindTurns),
    fakeFangR1Rate: item(m.fakeFangR1Plans, m.fakeFangR1Turns)
  };
}

const FACTORIAL_BLOCKS = [
  {
    name: 'deception_x_camouflage',
    geneA: 'deception',
    geneB: 'camouflage',
    metrics: [
      ['lieRate', '壞人 lie 計畫率（主動說謊意圖）', 'rate'],
      ['camouflageRate', '壞人 camouflage 計畫率（偽裝真話）', 'rate'],
      ['doubleClaimRate', '說謊時一真一假雙宣稱率（破綻風險）', 'rate'],
      ['splitVoteRate', '壞人分票戰術比例（投多個獸首）', 'rate'],
      ['claimChipShare', '宣稱真品獲得之實際籌碼占比', 'rate'],
      ['claimZeroVoteRate', '宣稱真品卻完全 0 票支持率（嚴重言行矛盾）', 'rate'],
      ['claimMajorityVoteRate', '宣稱真品獲得多數籌碼（>=50%）支持率', 'rate'],
      ['camoClaimChipShare', '[偽裝模式] 宣稱真品獲得之籌碼占比', 'rate'],
      ['lieClaimChipShare', '[說謊模式] 宣稱真品獲得之籌碼占比', 'rate'],
      ['round3SuspectRate', '壞人第三輪提出嫌疑目標率（決戰嫁禍）', 'rate']
    ]
  },
  {
    name: 'skepticism_x_assertiveness',
    geneA: 'skepticism',
    geneB: 'assertiveness',
    metrics: [
      ['profileRiskGap', '好人視角的壞人－好人平均嫌疑分差', 'score'],
      ['publicSuspectRate', '全回合公開指認／暗踩率', 'rate'],
      ['falseAccusationRate', '全回合好人指認中的誤指率', 'rate'],
      ['goodR3SuspectRate', '第三輪（R3）好人公開指認率（定案行為）', 'rate'],
      ['goodR3FalseAccusationRate', '第三輪（R3）好人指認中的誤指率', 'rate'],
      ['fakeFangRate', '假跳方震總比率（黃／木／姬）', 'rate'],
      ['fakeFangCluedRate', '  ├ 有疑似方震線索時的保護擋刀率', 'rate'],
      ['fakeFangBlindRate', '  ├ 無疑似方震線索時的盲跳率', 'rate'],
      ['fakeFangR1Rate', '  └ 第一輪（R1）假跳方震率', 'rate'],
      ['voteSpendRate', '可用投票籌碼使用比例', 'rate'],
      ['askRate', '發言計畫提問率', 'rate']
    ]
  }
];

function fmtVal(v, kind) {
  if (v == null) return 'n/a';
  return kind === 'rate' ? pct(v) : round(v, 3).toFixed(3);
}
function fmtDiff(v, kind) {
  if (v == null) return 'n/a';
  return kind === 'rate' ? pp(v) : number(v);
}

function evaluate2x2Metric(quads, key) {
  const sums = { LL: emptyMetrics(), LH: emptyMetrics(), HL: emptyMetrics(), HH: emptyMetrics() };
  const pairedInteractions = [];

  for (const q of quads) {
    addMetrics(sums.LL, q.LL.metrics);
    addMetrics(sums.LH, q.LH.metrics);
    addMetrics(sums.HL, q.HL.metrics);
    addMetrics(sums.HH, q.HH.metrics);

    const vLL = computeMetricWithDenom(q.LL.metrics)[key].val;
    const vLH = computeMetricWithDenom(q.LH.metrics)[key].val;
    const vHL = computeMetricWithDenom(q.HL.metrics)[key].val;
    const vHH = computeMetricWithDenom(q.HH.metrics)[key].val;
    if (vLL != null && vLH != null && vHL != null && vHH != null) {
      pairedInteractions.push(vHH - vHL - vLH + vLL);
    }
  }

  const cLL = computeMetricWithDenom(sums.LL)[key];
  const cLH = computeMetricWithDenom(sums.LH)[key];
  const cHL = computeMetricWithDenom(sums.HL)[key];
  const cHH = computeMetricWithDenom(sums.HH)[key];

  const mainA = (cHL.val != null && cLL.val != null && cHH.val != null && cLH.val != null)
    ? ((cHL.val - cLL.val) + (cHH.val - cLH.val)) / 2
    : null;
  const mainB = (cLH.val != null && cLL.val != null && cHH.val != null && cHL.val != null)
    ? ((cLH.val - cLL.val) + (cHH.val - cHL.val)) / 2
    : null;
  const interaction = (cHH.val != null && cHL.val != null && cLH.val != null && cLL.val != null)
    ? (cHH.val - cHL.val - cLH.val + cLL.val)
    : null;

  return {
    LL: cLL.val, LH: cLH.val, HL: cHL.val, HH: cHH.val,
    denoms: { LL: cLL.den, LH: cLH.den, HL: cHL.den, HH: cHH.den },
    mainEffectA: mainA,
    mainEffectB: mainB,
    pooledInteraction: interaction,
    pairedInteractionN: pairedInteractions.length,
    pairedInteractionMean: avg(pairedInteractions)
  };
}

function main() {
  const targetEntry = GD.Roster.list.find(b => b.name === TARGET_NAME || b.id === TARGET_NAME);
  const targetBotId = targetEntry ? targetEntry.id : null;
  if (!targetBotId) throw new Error(`Roster.list 找不到目標「${TARGET_NAME}」`);

  const manifest = JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf8'));
  console.log('=== v9.0 雙基因 2×2 交互作用驗證（Factorial Design） ===');
  console.log(`目標 Bot：${TARGET_NAME} (${targetBotId})｜低值 L=${LOW}｜高值 H=${HIGH}`);
  console.log(`載入固定種子清單：${SEEDS_PATH}（共 ${manifest.seeds.length} 組種子）`);

  const report = {
    targetName: TARGET_NAME,
    targetBotId,
    low: LOW,
    high: HIGH,
    seedsCount: manifest.seeds.length,
    blocks: {},
    errors: []
  };

  for (const block of FACTORIAL_BLOCKS) {
    const { name, geneA, geneB, metrics } = block;
    const quads = [];
    let skippedNotPresent = 0, skippedRole = 0, skippedEnvironment = 0, skippedManifestSig = 0;

    for (const seed of manifest.seeds) {
      try {
        const LL = runGame2x2({ seed, targetBotId, geneOverrides: { [geneA]: LOW, [geneB]: LOW } });
        const LH = runGame2x2({ seed, targetBotId, geneOverrides: { [geneA]: LOW, [geneB]: HIGH } });
        const HL = runGame2x2({ seed, targetBotId, geneOverrides: { [geneA]: HIGH, [geneB]: LOW } });
        const HH = runGame2x2({ seed, targetBotId, geneOverrides: { [geneA]: HIGH, [geneB]: HIGH } });

        if (!LL.targetPresent || !LH.targetPresent || !HL.targetPresent || !HH.targetPresent) {
          skippedNotPresent++; continue;
        }
        if (LL.role !== LH.role || LL.role !== HL.role || LL.role !== HH.role) {
          skippedRole++; continue;
        }
        if (!same(LL.environment, LH.environment) || !same(LL.environment, HL.environment) || !same(LL.environment, HH.environment)) {
          skippedEnvironment++; continue;
        }
        if (manifest.seedRecords && manifest.seedRecords[seed]) {
          const expected = manifest.seedRecords[seed];
          if (LL.role !== expected.role || !same(LL.environment, expected.environment)) {
            skippedManifestSig++; continue;
          }
        }
        quads.push({ seed, role: LL.role, LL, LH, HL, HH });
      } catch (err) {
        report.errors.push({ block: name, seed, message: err && err.stack ? err.stack : String(err) });
      }
    }

    report.blocks[name] = {
      geneA, geneB,
      validQuads: quads.length,
      skippedNotPresent, skippedRole, skippedEnvironment, skippedManifestSig,
      overall: {}
    };

    console.log(`\n================================================================================`);
    console.log(`【2×2 交互實驗】A=${geneA} × B=${geneB} (LL=${LOW}/${LOW}, LH=${LOW}/${HIGH}, HL=${HIGH}/${LOW}, HH=${HIGH}/${HIGH})`);
    console.log(`有效四元組：${quads.length}/${manifest.seeds.length}｜skippedManifestSig: ${skippedManifestSig}｜errors: ${report.errors.filter(e => e.block === name).length}`);
    console.log(`--------------------------------------------------------------------------------`);

    for (const [key, label, kind] of metrics) {
      const stat = evaluate2x2Metric(quads, key);
      report.blocks[name].overall[key] = stat;
      console.log(`★ ${label}`);
      console.log(`   四格表現：LL=${fmtVal(stat.LL, kind)} ｜ LH(高${geneB})=${fmtVal(stat.LH, kind)} ｜ HL(高${geneA})=${fmtVal(stat.HL, kind)} ｜ HH(雙高)=${fmtVal(stat.HH, kind)}`);
      console.log(`   效應拆解：A主效應(${geneA})=${fmtDiff(stat.mainEffectA, kind)} ｜ B主效應(${geneB})=${fmtDiff(stat.mainEffectB, kind)} ｜ 交互作用 I=${fmtDiff(stat.pooledInteraction, kind)} (Paired I=${fmtDiff(stat.pairedInteractionMean, kind)}, n=${stat.pairedInteractionN})`);
      console.log(`   機會分母：(${stat.denoms.LL} / ${stat.denoms.LH} / ${stat.denoms.HL} / ${stat.denoms.HH})`);
    }
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n================================================================================`);
  console.log(`2×2 交互驗證總錯誤數：${report.errors.length}`);
  console.log(`✓ 完整 JSON 報告已輸出至：${REPORT_PATH}`);
  if (report.errors.length) process.exitCode = 1;
}

main();