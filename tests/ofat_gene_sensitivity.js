/* ============================================================================
 * tests/ofat_gene_sensitivity.js
 * v9.0 基因 OFAT 敏感度測試（v2.1：修正環境簽章、真實言行一致性校準）
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const GD = require('./harness')();
const { Engine, Strategy, Speech, Mind, U } = GD;

const args = process.argv.slice(2);
const TARGET_NAME = args[0] || '水豚';
const TARGET_VALID_PAIRS = Math.max(1, Number.parseInt(args[1], 10) || 300);
const LOW = args[2] === undefined ? 0.4 : Number(args[2]);
const HIGH = args[3] === undefined ? 0.6 : Number(args[3]);
const ROLE_QUOTA = args[4] === undefined ? Math.max(10, Math.floor(TARGET_VALID_PAIRS / 10)) : Math.max(0, Number.parseInt(args[4], 10));
const MAX_ATTEMPTS = Number.parseInt(process.env.OFAT_MAX_ATTEMPTS, 10) || Math.max(5000, TARGET_VALID_PAIRS * 25);
const MIN_OPPORTUNITY_N = 10;

const REPORT_PATH = process.env.OFAT_REPORT_PATH || '';
const SAVE_SEEDS_PATH = process.env.OFAT_SAVE_SEEDS || '';
const LOAD_SEEDS_PATH = process.env.OFAT_LOAD_SEEDS || '';
const GENE_KEYS = ['skepticism', 'deception', 'camouflage', 'assertiveness', 'conformity'];

if (!Engine || !Strategy || !Speech || !Mind || !U) {
  throw new Error('GD 模組不完整；請確認 tests/harness.js 已載入 Engine、Strategy、Speech、Mind、U。');
}
if (!GD.Roster || !Array.isArray(GD.Roster.list) || typeof GD.Roster.baseGenes !== 'function') {
  throw new Error('缺少 GD.Roster.list / GD.Roster.baseGenes；請確認使用模組化 v9.0 專案。');
}
if (typeof U.withPRNG !== 'function') throw new Error('U.withPRNG 不存在；請先套用已支援種子亂數的 utils.js。');
if (!Number.isFinite(LOW) || !Number.isFinite(HIGH) || LOW < 0.05 || HIGH > 0.95 || LOW >= HIGH) {
  throw new Error('low/high 必須符合 0.05 <= low < high <= 0.95。');
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

// 修正：從預先抽好的 room.plan.rounds 讀取，確保 probeSeed(1輪) 與 runGame(3輪) 的簽章完全一致
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
    confessOpportunities: 0, confessPlans: 0, publicSuspectPlans: 0, askPlans: 0,
    goodAccusations: 0, goodFalseAccusations: 0, goodCorrectAccusations: 0, profileRiskGapSum: 0, profileRiskGapN: 0,
    targetPlanSpeechChars: 0, targetPlanSpeechN: 0,
    fakeFangPlans: 0, fakeFangPlanTurns: 0, fakeFangCluedTurns: 0, fakeFangCluedPlans: 0, fakeFangBlindTurns: 0, fakeFangBlindPlans: 0, fakeFangR1Turns: 0, fakeFangR1Plans: 0, fakeFangLaterTurns: 0, fakeFangLaterPlans: 0,
    ballotTurns: 0, evilBallotTurns: 0, splitEvilBallots: 0,
    claimedRealVoteChecks: 0, claimedRealZeroVotes: 0, claimedRealMajorityVotes: 0, claimedRealChipsBacked: 0, claimedRealChipsTotal: 0,
    camoClaimChecks: 0, camoClaimChipsBacked: 0, camoClaimChipsTotal: 0, camoClaimMajorityVotes: 0, camoClaimZeroVotes: 0,
    lieClaimChecks: 0, lieClaimChipsBacked: 0, lieClaimChipsTotal: 0, lieClaimMajorityVotes: 0, lieClaimZeroVotes: 0,
    chipsAvailable: 0, chipsSpent: 0, fakeChips: 0, realChips: 0, humanCallOpportunities: 0, humanCallFollowed: 0,
    transferTurns: 0, goodTransferTurns: 0, goodPassToEvil: 0, evilPassTurns: 0, passToKnownPartner: 0,
    evilRound3PlanTurns: 0, evilRound3SuspectPlans: 0, laoSkillChecks: 0, laoSkillActivations: 0
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

function probeSeed(seed, targetBotId) {
  if (GD.Genes && typeof GD.Genes.reset === 'function') GD.Genes.reset();
  return U.withPRNG(`OFAT:${seed}`, () => {
    const room = Engine.newRoom(`OFAT_${seed}`, 'host');
    Engine.addPlayer(room, { id: 'h1', name: '真人甲' });
    Engine.fillBots(room);
    const beforeStart = room.players.find(p => targetMatches(p, TARGET_NAME, targetBotId));
    if (!beforeStart) return { seed, targetPresent: false };
    if (!Engine.start(room)) throw new Error(`Engine.start 失敗：${seed}`);
    const target = room.players.find(p => targetMatches(p, TARGET_NAME, targetBotId));
    if (!target) return { seed, targetPresent: false };
    return {
      seed,
      targetPresent: true,
      role: target.role,
      environment: environmentSignature(room)
    };
  });
}

function runGame({ seed, targetBotId, geneKey, geneValue }) {
  if (GD.Genes && typeof GD.Genes.reset === 'function') GD.Genes.reset();

  return U.withPRNG(`OFAT:${seed}`, () => {
    const room = Engine.newRoom(`OFAT_${seed}`, 'host');
    Engine.addPlayer(room, { id: 'h1', name: '真人甲' });
    Engine.fillBots(room);
    const beforeStart = room.players.find(p => targetMatches(p, TARGET_NAME, targetBotId));
    if (!beforeStart) return { seed, targetPresent: false, reason: '目標 Bot 未進入本局' };
    if (!Engine.start(room)) throw new Error(`Engine.start 失敗：${seed}`);

    const target = room.players.find(p => targetMatches(p, TARGET_NAME, targetBotId));
    if (!target) throw new Error(`Engine.start 後找不到目標 Bot：${seed}`);
    const resolvedBotId = target.botId;
    const baseGenes = clone(GD.Roster.baseGenes(resolvedBotId));
    target.genes = { ...baseGenes, [geneKey]: geneValue };
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
        if (p.botId === resolvedBotId && nextId) {
          metrics.transferTurns++;
          const next = U.byId(room, nextId);
          if (GD.isGood(role)) {
            metrics.goodTransferTurns++;
            if (next && !GD.isGood(next.role)) metrics.goodPassToEvil++;
          } else {
            metrics.evilPassTurns++;
            const partnerRole = role === '老朝奉' ? '藥不然' : role === '藥不然' ? '老朝奉' : null;
            if (partnerRole && next && next.role === partnerRole) metrics.passToKnownPartner++;
          }
        }
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
          }
          if (plan.suspectId || plan.softShadeId) metrics.publicSuspectPlans++;
          if (GD.isGood(role)) {
            const accusedIds = [...new Set([plan.suspectId, plan.softShadeId].filter(Boolean))];
            accusedIds.forEach(id => {
              const accused = U.byId(room, id);
              if (!accused) return;
              metrics.goodAccusations++;
              if (GD.isGood(accused.role)) metrics.goodFalseAccusations++;
              else metrics.goodCorrectAccusations++;
            });
          }
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

          if (A && A.humanCall) {
            metrics.humanCallOpportunities++;
            if (plan.followHuman) metrics.humanCallFollowed++;
          }
          const gap = getProfileRiskGap(A, room, p);
          if (gap != null) {
            metrics.profileRiskGapSum += gap;
            metrics.profileRiskGapN++;
          }
        }
        const speech = Speech.localSpeech(p, room, plan, A);
        if (p.botId === resolvedBotId && typeof speech === 'string') {
          metrics.targetPlanSpeechChars += speech.length;
          metrics.targetPlanSpeechN++;
        }
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

              // 修正：從實際發言 (rd.speeches) 抓取言行一致性
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
                  if (isZero) metrics.camoClaimZeroVotes++;
                  if (isMajority) metrics.camoClaimMajorityVotes++;
                } else if (myMind && (myMind.mode === 'lie' || myMind.mode === 'follow')) {
                  metrics.lieClaimChecks++;
                  metrics.lieClaimChipsBacked += backedChips;
                  metrics.lieClaimChipsTotal += chips;
                  if (isZero) metrics.lieClaimZeroVotes++;
                  if (isMajority) metrics.lieClaimMajorityVotes++;
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
      geneKey, geneValue,
      environment: environmentSignature(room),
      metrics,
      gameOver: clone(room.gameOver)
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
    profileRiskGap: item(m.profileRiskGapSum, m.profileRiskGapN),
    publicSuspectRate: item(m.publicSuspectPlans, m.planTurns),
    askRate: item(m.askPlans, m.planTurns),
    falseAccusationRate: item(m.goodFalseAccusations, m.goodAccusations),
    lieRate: item(m.liePlans, m.evilPlanTurns),
    doubleClaimRate: item(m.lieDoubleClaims, m.liePlans),
    camouflageRate: item(m.camouflagePlans, m.evilPlanTurns),
    confessRate: item(m.confessPlans, m.confessOpportunities),
    splitVoteRate: item(m.splitEvilBallots, m.evilBallotTurns),
    claimChipShare: item(m.claimedRealChipsBacked, m.claimedRealChipsTotal),
    claimZeroVoteRate: item(m.claimedRealZeroVotes, m.claimedRealVoteChecks),
    claimMajorityVoteRate: item(m.claimedRealMajorityVotes, m.claimedRealVoteChecks),
    camoClaimChipShare: item(m.camoClaimChipsBacked, m.camoClaimChipsTotal),
    camoZeroVoteRate: item(m.camoClaimZeroVotes, m.camoClaimChecks),
    lieClaimChipShare: item(m.lieClaimChipsBacked, m.lieClaimChipsTotal),
    lieZeroVoteRate: item(m.lieClaimZeroVotes, m.lieClaimChecks),
    voteSpendRate: item(m.chipsSpent, m.chipsAvailable),
    fakeVoteChipShare: item(m.fakeChips, m.chipsSpent),
    humanCallFollowRate: item(m.humanCallFollowed, m.humanCallOpportunities),
    passToEvilRate: item(m.goodPassToEvil, m.goodTransferTurns),
    passToPartnerRate: item(m.passToKnownPartner, m.evilPassTurns),
    round3SuspectRate: item(m.evilRound3SuspectPlans, m.evilRound3PlanTurns),
    laoSkillActivationRate: item(m.laoSkillActivations, m.laoSkillChecks),
    fakeFangRate: item(m.fakeFangPlans, m.fakeFangPlanTurns),
    fakeFangCluedRate: item(m.fakeFangCluedPlans, m.fakeFangCluedTurns),
    fakeFangBlindRate: item(m.fakeFangBlindPlans, m.fakeFangBlindTurns),
    fakeFangR1Rate: item(m.fakeFangR1Plans, m.fakeFangR1Turns),
    fakeFangLaterRate: item(m.fakeFangLaterPlans, m.fakeFangLaterTurns),
    meanSpeechChars: item(m.targetPlanSpeechChars, m.targetPlanSpeechN)
  };
}

const METRICS_BY_GENE = {
  deception: [
    ['lieRate', '壞人發言計畫 lie 比率（主動說謊意圖）', 'rate'],
    ['doubleClaimRate', '說謊時追加反踩真品率（一真一假雙宣稱）', 'rate'],
    ['round3SuspectRate', '壞人第三輪提出嫌疑目標率（決戰嫁禍）', 'rate'],
    ['laoSkillActivationRate', '老朝奉擾亂啟動率（技能檢查為分母）', 'rate'],
    ['passToPartnerRate', '壞人傳給已知同伴的比例（老朝奉／藥不然）', 'rate']
  ],
  camouflage: [
    ['camouflageRate', '壞人 camouflage 發言計畫率', 'rate'],
    ['lieRate', '壞人 lie 發言計畫率（檢查是否已與 camouflage 解耦）', 'rate'],
    ['doubleClaimRate', '說謊時一真一假雙宣稱率（高偽裝應降低破綻）', 'rate'],
    ['splitVoteRate', '壞人分票戰術比例（投多個獸首）', 'rate'],
    ['claimChipShare', '宣稱真品獲得之實際籌碼占比（全壞人回合）', 'rate'],
    ['claimZeroVoteRate', '宣稱真品卻完全 0 票支持率（嚴重言行矛盾）', 'rate'],
    ['claimMajorityVoteRate', '宣稱真品獲得多數籌碼（>=50%）支持率', 'rate'],
    ['camoClaimChipShare', '[偽裝模式] 宣稱真品獲得之籌碼占比', 'rate'],
    ['lieClaimChipShare', '[說謊模式] 宣稱真品獲得之籌碼占比', 'rate'],
    ['confessRate', '被質問且有投贗品紀錄時的坦承率', 'rate'],
    ['fakeVoteChipShare', '投在贗品獸首之籌碼比例', 'rate']
  ],
  assertiveness: [
    ['publicSuspectRate', '公開指認／暗踩率', 'rate'],
    ['askRate', '發言計畫提問率', 'rate'],
    ['voteSpendRate', '可用投票籌碼使用比例', 'rate'],
    ['fakeFangRate', '假跳方震總比率（黃煙煙／木戶加奈／姬雲浮）', 'rate'],
    ['fakeFangCluedRate', '  ├ 有疑似方震線索時的保護擋刀率', 'rate'],
    ['fakeFangBlindRate', '  ├ 無疑似方震線索時的盲跳率', 'rate'],
    ['fakeFangR1Rate', '  ├ 第一輪（R1）假跳方震率', 'rate'],
    ['fakeFangLaterRate', '  └ 二三輪（R2+）假跳方震率', 'rate']
  ],
  skepticism: [
    ['profileRiskGap', '好人視角的壞人－好人平均嫌疑分差', 'score'],
    ['publicSuspectRate', '公開指認／暗踩率', 'rate'],
    ['falseAccusationRate', '好人指認中的誤指率', 'rate'],
    ['askRate', '發言計畫提問率', 'rate']
  ],
  conformity: [
    ['humanCallFollowRate', '觀察到真人號召時的發言附議率', 'rate'],
    ['publicSuspectRate', '公開指認／暗踩率（次要指標）', 'rate']
  ]
};

function fmtMetric(value, kind) {
  if (value == null) return 'n/a';
  return kind === 'rate' ? pct(value) : round(value, 3).toFixed(3);
}
function fmtDelta(value, kind) {
  if (value == null) return 'n/a';
  return kind === 'rate' ? pp(value) : number(value);
}

function evaluateMetricOnPairs(pairs, key) {
  const sumLow = emptyMetrics();
  const sumHigh = emptyMetrics();
  const gameDeltas = [];

  for (const p of pairs) {
    addMetrics(sumLow, p.low.metrics);
    addMetrics(sumHigh, p.high.metrics);
    const mLow = computeMetricWithDenom(p.low.metrics)[key];
    const mHigh = computeMetricWithDenom(p.high.metrics)[key];
    if (mLow.val != null && mHigh.val != null) {
      gameDeltas.push(mHigh.val - mLow.val);
    }
  }

  const pooledLow = computeMetricWithDenom(sumLow)[key];
  const pooledHigh = computeMetricWithDenom(sumHigh)[key];
  const pooledDelta = (pooledLow.val != null && pooledHigh.val != null) ? (pooledHigh.val - pooledLow.val) : null;

  return {
    pooledLow: pooledLow.val,
    pooledHigh: pooledHigh.val,
    lowDenom: pooledLow.den,
    highDenom: pooledHigh.den,
    pooledDelta,
    pairedGameN: gameDeltas.length,
    pairedGameMeanDelta: avg(gameDeltas)
  };
}

function buildOrLoadSeedManifest(targetBotId) {
  if (LOAD_SEEDS_PATH) {
    const fullPath = path.resolve(LOAD_SEEDS_PATH);
    const loaded = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    loaded.seedRecords = loaded.seedRecords || {};
    let verified = 0, sigMismatch = 0;
    for (const seed of loaded.seeds) {
      const probe = probeSeed(seed, targetBotId);
      if (loaded.seedRecords[seed]) {
        if (loaded.seedRecords[seed].role !== probe.role || !same(loaded.seedRecords[seed].environment, probe.environment)) {
          sigMismatch++;
        } else {
          verified++;
        }
      } else {
        loaded.seedRecords[seed] = { role: probe.role, environment: probe.environment };
        verified++;
      }
    }
    if (sigMismatch > 0) {
      throw new Error(`載入的種子清單中有 ${sigMismatch} 組種子與當前環境簽章不一致！`);
    }
    console.log(`✓ 已從 ${fullPath} 載入並驗證 ${loaded.seeds.length} 組固定種子清單（環境簽章 100% 吻合）`);
    return loaded;
  }

  const selectedSeeds = [];
  const seedRecords = {};
  const roleCounts = {};
  GD.ROLE_ORDER.forEach(r => { roleCounts[r] = 0; });

  let attempted = 0, skippedNotPresent = 0;

  while (attempted < MAX_ATTEMPTS) {
    const totalMet = selectedSeeds.length >= TARGET_VALID_PAIRS;
    const allRolesMet = GD.ROLE_ORDER.every(r => roleCounts[r] >= ROLE_QUOTA);
    if (totalMet && allRolesMet) break;

    const seed = `OFAT_${attempted}`;
    attempted++;

    const probe = probeSeed(seed, targetBotId);
    if (!probe.targetPresent) {
      skippedNotPresent++;
      continue;
    }

    if (totalMet && roleCounts[probe.role] >= ROLE_QUOTA) {
      continue;
    }

    selectedSeeds.push(seed);
    seedRecords[seed] = { role: probe.role, environment: probe.environment };
    roleCounts[probe.role] = (roleCounts[probe.role] || 0) + 1;
  }

  const manifest = {
    targetName: TARGET_NAME, targetBotId, targetValidPairs: TARGET_VALID_PAIRS, roleQuota: ROLE_QUOTA,
    attemptedSeeds: attempted, skippedNotPresent, roleCounts, seeds: selectedSeeds, seedRecords
  };

  if (SAVE_SEEDS_PATH) {
    const outPath = path.resolve(SAVE_SEEDS_PATH);
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`✓ 已將篩選出的 ${selectedSeeds.length} 組有效種子清單（含角色與開局環境簽章）儲存至：${outPath}`);
  }

  return manifest;
}

function main() {
  const targetEntry = GD.Roster.list.find(b => b.name === TARGET_NAME || b.id === TARGET_NAME);
  const targetBotId = targetEntry ? targetEntry.id : null;
  if (!targetBotId) throw new Error(`Roster.list 找不到目標「${TARGET_NAME}」`);

  console.log('=== v9.0 五基因 OFAT 敏感度分析（v2.1：言行三維度與假跳分層版） ===');
  console.log(`目標 Bot：${TARGET_NAME} (${targetBotId})｜基因區間：${LOW} vs ${HIGH}`);
  
  const manifest = buildOrLoadSeedManifest(targetBotId);
  console.log(`\n=== 種子篩選統計 ===`);
  console.log(`已嘗試候選種子：${manifest.attemptedSeeds}｜目標未入局：${manifest.skippedNotPresent}｜收錄有效種子：${manifest.seeds.length}`);
  
  const report = {
    targetName: TARGET_NAME, targetBotId, low: LOW, high: HIGH,
    manifestSummary: { attemptedSeeds: manifest.attemptedSeeds, validSeedsCount: manifest.seeds.length, roleQuota: ROLE_QUOTA, roleCounts: manifest.roleCounts },
    genes: {}, errors: []
  };

  for (const gene of GENE_KEYS) {
    const pairs = [];
    const rolePairs = new Map();
    let skippedNotPresent = 0, skippedRole = 0, skippedEnvironment = 0, skippedManifestSig = 0;

    for (const seed of manifest.seeds) {
      let low, high;
      try {
        low = runGame({ seed, targetBotId, geneKey: gene, geneValue: LOW });
        high = runGame({ seed, targetBotId, geneKey: gene, geneValue: HIGH });
      } catch (error) {
        report.errors.push({ gene, seed, message: error && error.stack ? error.stack : String(error) });
        console.error(`✗ ${gene} ${seed}: ${error.message || error}`);
        continue;
      }
      if (!low.targetPresent || !high.targetPresent) { skippedNotPresent++; continue; }
      if (low.role !== high.role) { skippedRole++; continue; }
      if (!same(low.environment, high.environment)) { skippedEnvironment++; continue; }
      if (manifest.seedRecords && manifest.seedRecords[seed]) {
        const expected = manifest.seedRecords[seed];
        if (low.role !== expected.role || !same(low.environment, expected.environment)) {
          skippedManifestSig++;
          continue;
        }
      }

      const pair = { seed, role: low.role, low, high };
      pairs.push(pair);
      if (!rolePairs.has(pair.role)) rolePairs.set(pair.role, []);
      rolePairs.get(pair.role).push(pair);
    }

    report.genes[gene] = { validPairs: pairs.length, skippedNotPresent, skippedRole, skippedEnvironment, skippedManifestSig, roles: {}, overall: {} };
    console.log(`\n============================================================`);
    console.log(`基因測試：${gene} (${LOW} → ${HIGH})`);
    
    const definitions = METRICS_BY_GENE[gene];
    const roleNames = [...rolePairs.keys()].sort((a, b) => GD.ROLE_ORDER.indexOf(a) - GD.ROLE_ORDER.indexOf(b));

    for (const role of roleNames) {
      const rolePairList = rolePairs.get(role);
      const isRoleUnderQuota = rolePairList.length < ROLE_QUOTA;
      const roleReport = { pairs: rolePairList.length, underQuota: isRoleUnderQuota, metrics: {} };

      console.log(`\n  【角色：${role}】配對局數 ${rolePairList.length}${isRoleUnderQuota ? ` ⚠️[角色樣本不足 < ${ROLE_QUOTA}]` : ''}`);
      for (const [key, label, kind] of definitions) {
        const stat = evaluateMetricOnPairs(rolePairList, key);
        if (stat.lowDenom === 0 && stat.highDenom === 0) continue;
        roleReport.metrics[key] = stat;
        console.log(`    - ${label}：${fmtMetric(stat.pooledLow, kind)} → ${fmtMetric(stat.pooledHigh, kind)}｜Pooled Δ ${fmtDelta(stat.pooledDelta, kind)}｜Paired Δ ${fmtDelta(stat.pairedGameMeanDelta, kind)} (n=${stat.pairedGameN})｜機會分母 (${stat.lowDenom}/${stat.highDenom})`);
      }
      report.genes[gene].roles[role] = roleReport;
    }

    console.log(`\n  【跨角色總計 (${gene})】總配對局數 ${pairs.length}`);
    for (const [key, label, kind] of definitions) {
      const stat = evaluateMetricOnPairs(pairs, key);
      report.genes[gene].overall[key] = stat;
      console.log(`    ★ ${label}：${fmtMetric(stat.pooledLow, kind)} → ${fmtMetric(stat.pooledHigh, kind)}｜Pooled Δ ${fmtDelta(stat.pooledDelta, kind)}｜Paired Δ ${fmtDelta(stat.pairedGameMeanDelta, kind)} (n=${stat.pairedGameN})｜總機會分母 (${stat.lowDenom}/${stat.highDenom})`);
    }
  }
  
  if (REPORT_PATH) {
    fs.writeFileSync(path.resolve(REPORT_PATH), JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n✓ JSON 報告已輸出至：${REPORT_PATH}`);
  }
  if (report.errors.length) process.exitCode = 1;
}

main();