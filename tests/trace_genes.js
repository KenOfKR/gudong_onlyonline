/* ============================================================================
 * tests/trace_genes.js — 基因生命週期因果鏈稽核（v3：邏輯身分正規化與 A/A 差異診斷）
 *
 * 用法：
 *   node tests/trace_genes.js [botName=水豚] [maxTrainSeeds=80] [evalSeeds=40] [geneKey=deception]
 *
 * 1) 從出廠基因開始，搜尋一個能讓指定基因自然變動的單局訓練種子。
 * 2) 取出 Learning.finalize() 後寫回 GD.store 的基因快照。
 * 3) 在同一個評估種子上比較：全員出廠基因 vs 只有目標 Bot 使用學習後基因。
 * 4) 檢查 Engine.start 載入值、Proxy 實際讀取、環境配對與決策是否分歧。
 * 5) 正規化 fakeFangClaim.targetId 等動態參照，避免 U.uid 時間戳／隨機尾碼造成假分歧。
 * 6) 對所有有效 A/B 配對案例做 factory 與 learned A/A 重跑；失敗時列出第一個差異路徑。
 *
 * 注意：行為沒有分歧不等於基因完全無效；單局可能沒有走到會被基因改變的決策門檻。
 * 本腳本是診斷工具，不是勝率效益估計，也不會修改正式遊戲程式碼。
 * ========================================================================== */
'use strict';

const GD = require('./harness')();
const { Engine, Strategy, Speech, Mind, U } = GD;
const fs = require('fs');
const path = require('path');

const positional = process.argv.slice(2).filter(a => !a.startsWith('-'));
const TARGET_NAME = positional[0] || '水豚';
const MAX_TRAIN_SEEDS = Math.max(1, Number.parseInt(positional[1], 10) || 80);
const EVAL_SEEDS = Math.max(1, Number.parseInt(positional[2], 10) || 40);
const GENE_KEY = positional[3] || 'deception';
const REPORT_PATH = process.env.TRACE_GENES_REPORT_PATH || '';

if (!Engine || !Strategy || !Speech || !Mind || !U) {
  throw new Error('GD 模組不完整；請確認 tests/harness.js 已載入 Engine、Strategy、Speech、Mind、U。');
}
if (!GD.Roster || !Array.isArray(GD.Roster.list) || typeof GD.Roster.baseGenes !== 'function') {
  throw new Error('需要新版 GD.Roster.list 與 GD.Roster.baseGenes(botId)。');
}
if (!GD.Genes || typeof GD.Genes.load !== 'function') {
  throw new Error('GD.Genes.load 不存在，無法稽核基因讀取生命週期。');
}
if (!GD.Learning || typeof GD.Learning.finalize !== 'function') {
  throw new Error('GD.Learning.finalize 不存在，無法稽核結算寫入。');
}
if (typeof U.withPRNG !== 'function') {
  throw new Error('U.withPRNG 不存在；請先套用新版 js/utils.js 與 tests/harness.js。');
}

GD.store.set(GD.CONFIG.STORAGE.useGemini, false);
const GENES_STORAGE_KEY = GD.CONFIG.STORAGE.genes;
let failures = 0;
const errors = [];
const check = (cond, message) => {
  if (!cond) {
    failures++;
    errors.push(message);
    console.error('  ✗ ' + message);
  }
};
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(k => { out[k] = stable(value[k]); });
    return out;
  }
  return value;
};
const stableJSON = value => JSON.stringify(stable(value));
const same = (a, b) => stableJSON(a) === stableJSON(b);
const round6 = value => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value;

/** 回報正規化後資料的第一個差異位置，避免 A/A 只給出模糊的失敗訊息。 */
function firstDifference(a, b, pathName = '$') {
  if (same(a, b)) return null;
  const isObj = v => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    return { path: pathName, left: a, right: b };
  }
  if (Array.isArray(a)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) {
        return { path: `${pathName}[${i}]`, left: i < a.length ? a[i] : '<missing>', right: i < b.length ? b[i] : '<missing>' };
      }
      const diff = firstDifference(a[i], b[i], `${pathName}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(a, key) || !Object.prototype.hasOwnProperty.call(b, key)) {
      return { path: `${pathName}.${key}`, left: Object.prototype.hasOwnProperty.call(a, key) ? a[key] : '<missing>', right: Object.prototype.hasOwnProperty.call(b, key) ? b[key] : '<missing>' };
    }
    const diff = firstDifference(a[key], b[key], `${pathName}.${key}`);
    if (diff) return diff;
  }
  return null;
}

function factoryStore() {
  const result = {};
  GD.Roster.list.forEach(bot => {
    result[bot.id] = {
      genes: clone(GD.Roster.baseGenes(bot.id)),
      games: 0,
      wins: 0,
      lastDelta: {},
      history: []
    };
  });
  return result;
}
function setGeneStore(snapshot) {
  GD.store.set(GENES_STORAGE_KEY, clone(snapshot));
}
function readGeneStore() {
  return clone(GD.store.get(GENES_STORAGE_KEY, {})) || {};
}
function getStoredGenes(snapshot, botId) {
  const record = snapshot && snapshot[botId];
  return record && record.genes ? clone(record.genes) : null;
}
function readTargetStoredGenes(botId) {
  return getStoredGenes(readGeneStore(), botId);
}
function genesDiff(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const rows = [];
  [...keys].sort().forEach(key => {
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if (typeof a === 'number' && typeof b === 'number') {
      if (Math.abs(a - b) > 1e-12) rows.push({ key, before: a, after: b, delta: b - a });
    } else if (!same(a, b)) {
      rows.push({ key, before: a, after: b, delta: null });
    }
  });
  return rows;
}
function targetMatch(player, targetName, targetBotId) {
  if (!player || !player.botId) return false;
  if (targetBotId && player.botId === targetBotId) return true;
  return player.name === targetName || player.botId === targetName;
}
function playerKey(room, id) {
  if (id == null) return null;
  const p = U.byId(room, id);
  if (!p) return String(id);
  return p.botId ? `bot:${p.botId}` : `human:${p.name}`;
}
function environmentSignature(room) {
  const players = (room.players || []).map(p => ({
    key: p.botId ? `bot:${p.botId}` : `human:${p.name}`,
    role: p.role || null,
    seatIndex: p.seatIndex == null ? null : p.seatIndex,
    confusedRound: typeof p.confusedRound === 'number' ? p.confusedRound : null
  })).sort((a, b) => a.key.localeCompare(b.key));
  const rounds = (room.rounds || []).map(rd => ({
    beasts: (rd.beasts || []).map(b => [b.name, !!b.isReal]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  }));
  return {
    players,
    starter: room.plan ? playerKey(room, room.plan.starterId) : null,
    rounds
  };
}
function compactPlan(room, plan) {
  if (!plan) return null;
  const claims = Array.isArray(plan.claims) ? plan.claims.map(c => ({
    beast: c && c.beast,
    real: c && c.real,
    confidence: c && typeof c.confidence === 'number' ? c.confidence : undefined
  })) : [];
  return {
    mode: plan.mode || null,
    beast: plan.beast || null,
    avoid: plan.avoid || null,
    claims,
    suspect: playerKey(room, plan.suspectId),
    softShade: playerKey(room, plan.softShadeId),
    // targetId 來自 U.uid() 建立的動態 player.id；比較決策時必須映射成穩定 botId/玩家身分。
    fakeFangClaim: plan.fakeFangClaim ? {
      target: playerKey(room, plan.fakeFangClaim.targetId),
      isGoodCamp: typeof plan.fakeFangClaim.isGoodCamp === 'boolean' ? plan.fakeFangClaim.isGoodCamp : null
    } : null,
    padBeast: plan.padBeast || null,
    askId: playerKey(room, plan.askId),
    confess: !!plan.confess,
    explain: !!plan.explain,
    hideBlind: !!plan.hideBlind,
    followHuman: plan.followHuman ? playerKey(room, plan.followHuman.callerId || plan.followHuman.id) : null
  };
}
function compactPersonVote(room, value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  return {
    target: playerKey(room, value.targetId),
    follow: playerKey(room, value.followId),
    why: typeof value.why === 'string' ? value.why : null
  };
}
function makeTargetOnlyStore(factory, trained, botId) {
  const out = clone(factory);
  const learned = getStoredGenes(trained, botId);
  if (!learned) throw new Error(`訓練後快取找不到 ${botId} 的 genes`);
  if (!out[botId]) out[botId] = { genes: clone(learned), games: 0, wins: 0, lastDelta: {}, history: [] };
  else out[botId].genes = clone(learned);
  return out;
}

/** 執行一局。學習模式只用於自然訓練；評估模式會攔截目標 Bot 的 gene 讀取。 */
function runGame(options) {
  const {
    seed,
    targetName = TARGET_NAME,
    targetBotId = null,
    learn = false,
    traceReads = false,
    expectedGenes = null
  } = options;

  return U.withPRNG(`sim:${seed}`, () => {
    const room = Engine.newRoom('TRACE_' + seed, 'host');
    Engine.addPlayer(room, { id: 'h1', name: '真人甲' });
    Engine.fillBots(room);

    const targetBeforeStart = room.players.find(p => targetMatch(p, targetName, targetBotId));
    if (!targetBeforeStart) {
      return { seed, targetPresent: false, reason: `該種子沒有選入 ${targetName}` };
    }

    if (!Engine.start(room)) throw new Error(`Engine.start 失敗：${seed}`);
    const target = room.players.find(p => targetMatch(p, targetName, targetBotId));
    if (!target) throw new Error(`Engine.start 後找不到目標 Bot：${seed}`);

    const resolvedBotId = target.botId;
    const genesAtStart = clone(target.genes);
    const loadMatchesExpected = expectedGenes == null ? null : same(genesAtStart, expectedGenes);
    if (expectedGenes != null && !loadMatchesExpected) {
      check(false, `查核點 2：${seed} 的 Engine.start 載入基因與預期快照不一致。`);
    }

    const reads = [];
    const decisions = [];
    let activeContext = null;
    let lastInvocation = null;
    const withContext = (player, stage, fn) => {
      const previous = activeContext;
      const readStart = reads.length;
      const context = {
        stage,
        round: Number.isInteger(room.currentRoundIdx) ? room.currentRoundIdx + 1 : null,
        playerId: player ? player.id : null,
        botId: player ? player.botId || null : null,
        playerName: player ? player.name : null,
        role: player ? player.role || null : null
      };
      activeContext = context;
      try {
        const value = fn();
        if (player && player.botId === resolvedBotId) {
          lastInvocation = { ...context, readStart, readEnd: reads.length, geneReads: clone(reads.slice(readStart)) };
        }
        return value;
      } finally { activeContext = previous; }
    };
    const record = (player, stage, value) => {
      if (!player || player.botId !== resolvedBotId) return;
      const round = Number.isInteger(room.currentRoundIdx) ? room.currentRoundIdx + 1 : null;
      // These are display/decision labels; map them back to the wrapped function names.
      const invocationStage = ({
        inspectPicks: 'Strategy.inspectPicks',
        skill: 'Strategy.skill',
        nextPlayer: 'Strategy.nextPlayer',
        plan: 'Strategy.plan',
        speech: 'Speech.localSpeech',
        ballot: 'Strategy.ballot',
        personVote: 'Strategy.personVote'
      })[stage] || stage;
      const invocation = lastInvocation && lastInvocation.botId === resolvedBotId &&
        lastInvocation.stage === invocationStage && lastInvocation.round === round ? lastInvocation : null;
      decisions.push({
        round,
        stage,
        value: clone(value),
        // Keep telemetry beside the decision for causal alignment, but exclude it from behavior comparison.
        geneReads: invocation ? clone(invocation.geneReads) : []
      });
    };

    if (traceReads) {
      if (!target.genes || typeof target.genes !== 'object') {
        throw new Error(`目標 Bot 的 p.genes 不是物件：${resolvedBotId}`);
      }
      const base = target.genes;
      target.genes = new Proxy(base, {
        get(obj, prop, receiver) {
          const value = Reflect.get(obj, prop, receiver);
          if (prop === GENE_KEY && activeContext && activeContext.botId === resolvedBotId) {
            reads.push({
              stage: activeContext.stage,
              round: activeContext.round,
              botId: resolvedBotId,
              name: activeContext.playerName,
              role: activeContext.role,
              gene: String(prop),
              value: round6(value)
            });
          }
          return value;
        }
      });
    }

    let guard = 0;
    while (room.status !== 'gameover' && guard++ < 500) {
      const rd = U.curRound(room);
      if (room.status === 'playing') {
        const p = U.byId(room, room.currentTurnPlayerId);
        if (!p) throw new Error(`playing 階段找不到 currentTurnPlayerId：${seed}`);
        const log = Engine.log(room, p.id);
        if (log.step === 'a') {
          const picks = withContext(p, 'Strategy.inspectPicks', () => Strategy.inspectPicks(p, room));
          if (picks && p.botId === resolvedBotId) record(p, 'inspectPicks', picks);
          (picks || []).forEach(n => Engine.inspect(room, p.id, n));
        }
        const A = withContext(p, 'Mind.analyze', () => Mind.analyze(p, room));
        const skill = withContext(p, 'Strategy.skill', () => Strategy.skill(p, room, A));
        if (p.botId === resolvedBotId) record(p, 'skill', skill && typeof skill === 'object' ? {
          type: skill.type || skill.action || null,
          beast: skill.beast || skill.name || null,
          target: playerKey(room, skill.targetId)
        } : skill);
        const next = withContext(p, 'Strategy.nextPlayer', () => Strategy.nextPlayer(p, room, A));
        if (p.botId === resolvedBotId) record(p, 'nextPlayer', playerKey(room, next));
        Engine.skill(room, p.id, skill);
        Engine.pass(room, p.id, next);
      } else if (room.status === 'discussion') {
        const p = U.byId(room, room.currentSpeakerId);
        if (!p) throw new Error(`discussion 階段找不到 currentSpeakerId：${seed}`);
        const result = withContext(p, 'Strategy.plan', () => Strategy.plan(p, room));
        const plan = result.plan;
        const A = result.A;
        if (p.botId === resolvedBotId) record(p, 'plan', compactPlan(room, plan));
        const text = withContext(p, 'Speech.localSpeech', () => Speech.localSpeech(p, room, plan, A));
        if (p.botId === resolvedBotId) record(p, 'speech', String(text == null ? '' : text));
        const v = Speech.validate(text, p, room, plan, A);
        if (!v.ok) throw new Error(`發言未通過驗證：${v.why}`);
        Engine.speak(room, p.id, { text, source: 'bot' });
      } else if (room.status === 'voting') {
        if (!rd.voteResults) {
          room.players.forEach(p => {
            if (rd.votes[p.id] === undefined) {
              const ballot = withContext(p, 'Strategy.ballot', () => Strategy.ballot(p, room));
              if (p.botId === resolvedBotId) record(p, 'ballot', ballot || {});
              Engine.vote(room, p.id, ballot);
            }
          });
        }
        Engine.advance(room);
      } else if (room.status === 'person_voting') {
        room.players.forEach(p => {
          if (!room.personVotes[p.id]) {
            const decision = withContext(p, 'Strategy.personVote', () => Strategy.personVote(p, room));
            if (p.botId === resolvedBotId) record(p, 'personVote', compactPersonVote(room, decision));
            p.final = decision;
            Engine.personVote(room, p.id, decision.targetId);
          }
        });
      } else {
        throw new Error(`未知房間狀態 ${room.status}，seed=${seed}`);
      }
    }

    if (room.status !== 'gameover' || !room.gameOver) {
      throw new Error(`對局未結束（guard=${guard}）：${seed}`);
    }

    if (learn) {
      const finalizeResult = GD.Learning.finalize(room);
      if (!finalizeResult) throw new Error(`Learning.finalize 回傳失敗：${seed}`);
    }

    const storedGenesAfter = readTargetStoredGenes(resolvedBotId);
    return {
      seed,
      targetPresent: true,
      botId: resolvedBotId,
      targetName: target.name,
      role: target.role,
      genesAtStart,
      loadMatchesExpected,
      reads,
      decisions,
      room,
      environment: environmentSignature(room),
      storedGenesAfter,
      gameOver: clone(room.gameOver)
    };
  });
}

function decisionOnly(decision) {
  if (decision == null || typeof decision !== 'object') return decision;
  return { round: decision.round, stage: decision.stage, value: decision.value };
}
function compareDecisions(a, b) {
  const left = a || [];
  const right = b || [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    if (!same(decisionOnly(left[i]), decisionOnly(right[i]))) {
      return {
        differs: true,
        index: i,
        baseline: left[i] === undefined ? '<沒有此決策>' : left[i],
        learned: right[i] === undefined ? '<沒有此決策>' : right[i]
      };
    }
  }
  return { differs: false, index: -1, baseline: null, learned: null };
}
function readsForDecision(decision, geneKey) {
  return (decision && Array.isArray(decision.geneReads) ? decision.geneReads : []).filter(r => r.gene === geneKey);
}
function displayDecision(decision) {
  if (decision === '<沒有此決策>' || decision == null) return decision;
  return { round: decision.round, stage: decision.stage, value: decision.value };
}
function stableCaseSummary(testCase, geneKey) {
  const diff = testCase.difference;
  const bDecision = Array.isArray(testCase.baseline.decisions) ? testCase.baseline.decisions[diff.index] : null;
  const lDecision = Array.isArray(testCase.learned.decisions) ? testCase.learned.decisions[diff.index] : null;
  return {
    seed: testCase.seed,
    targetRole: testCase.baseline.role,
    environmentMatched: same(testCase.baseline.environment, testCase.learned.environment),
    factoryGenesAtStart: clone(testCase.baseline.genesAtStart),
    learnedGenesAtStart: clone(testCase.learned.genesAtStart),
    factoryGeneReadsTotal: testCase.baseline.reads.length,
    learnedGeneReadsTotal: testCase.learned.reads.length,
    divergentDecisionIndex: diff.index,
    factoryDecision: displayDecision(diff.baseline),
    learnedDecision: displayDecision(diff.learned),
    factoryReadsDuringDivergentDecision: readsForDecision(bDecision, geneKey),
    learnedReadsDuringDivergentDecision: readsForDecision(lDecision, geneKey),
    factoryReadsAll: clone(testCase.baseline.reads),
    learnedReadsAll: clone(testCase.learned.reads)
  };
}

function main() {
  console.log('=== 基因生命週期因果鏈稽核 ===');
  console.log(`目標 Bot：${TARGET_NAME}｜追蹤基因：${GENE_KEY}`);
  console.log(`訓練種子搜尋上限：${MAX_TRAIN_SEEDS}｜配對評估種子：${EVAL_SEEDS}`);

  const factory = factoryStore();
  const rosterEntry = GD.Roster.list.find(b => b.name === TARGET_NAME || b.id === TARGET_NAME);
  if (!rosterEntry) {
    console.warn(`提醒：Roster.list 未以 name/id 直接找到「${TARGET_NAME}」，後續將以對局中的玩家名稱尋找。`);
  }

  // 查核點 1：用自然結算找出一局會改變指定基因的訓練案例。
  let trainedStore = null;
  let targetBotId = rosterEntry ? rosterEntry.id : null;
  let training = null;
  let trainingBaseline = null;
  for (let i = 0; i < MAX_TRAIN_SEEDS; i++) {
    setGeneStore(factory);
    const seed = `TRACE_TRAIN_${i}`;
    const result = runGame({ seed, targetName: TARGET_NAME, targetBotId, learn: true, traceReads: false });
    if (!result.targetPresent) continue;

    targetBotId = result.botId;
    const initialGenes = clone(result.genesAtStart || GD.Roster.baseGenes(targetBotId));
    const storedNow = readGeneStore();
    const postGenes = getStoredGenes(storedNow, targetBotId);
    if (!postGenes) continue;
    const geneChanges = genesDiff(initialGenes, postGenes);
    const keyChange = geneChanges.find(row => row.key === GENE_KEY);
    if (keyChange) {
      training = { seed, result, before: initialGenes, after: postGenes, geneChanges };
      trainingBaseline = clone(factory);
      trainedStore = storedNow;
      break;
    }
  }

  if (!training) {
    console.error(`\n查核點 1 未完成：在 ${MAX_TRAIN_SEEDS} 個候選種子內，沒有觀察到 ${TARGET_NAME}.${GENE_KEY} 在單局 finalize 後改變。`);
    console.error('這不等於學習管線必然故障；可能是目標沒有入局、該局獎懲沒有更新此基因，或目前獎懲公式不調整此欄位。請提高 maxTrainSeeds 或改查其他 geneKey。');
    process.exitCode = 2;
    return;
  }

  console.log('\n--- 查核點 1：Learning.finalize 寫入 ---');
  console.log(`訓練種子：${training.seed}｜Bot ID：${targetBotId}｜角色：${training.result.role}`);
  console.log(`${GENE_KEY}: ${training.before[GENE_KEY]} → ${training.after[GENE_KEY]}（Δ ${round6(training.after[GENE_KEY] - training.before[GENE_KEY])}）`);
  console.log(`本次結算變動基因：${training.geneChanges.length ? training.geneChanges.map(x => `${x.key} ${x.before}→${x.after}`).join('；') : '無'}`);
  check(training.after[GENE_KEY] !== training.before[GENE_KEY], '查核點 1：儲存快照中的指定基因沒有改變。');

  // 只把目標 Bot 的學習後基因放進評估狀態；其他 Bot 保持出廠值，減少混雜。
  const targetOnlyLearnedStore = makeTargetOnlyStore(factory, trainedStore, targetBotId);
  const targetLearnedGenes = getStoredGenes(targetOnlyLearnedStore, targetBotId);
  const report = {
    targetName: TARGET_NAME,
    targetBotId,
    geneKey: GENE_KEY,
    training: {
      seed: training.seed,
      role: training.result.role,
      before: training.before,
      after: training.after,
      changes: training.geneChanges
    },
    evaluation: {
      seedsTried: 0,
      targetPresent: 0,
      geneReadObserved: 0,
      environmentMatched: 0,
      behaviorDiverged: 0,
      cases: [],
      divergenceCases: [],
      aaPassed: null,
      learnedAaPassed: null,
      witnessSeed: null
    },
    errors
  };

  let detailedCase = null;
  let divergenceCase = null;
  const divergenceCases = [];
  const pairedCases = [];
  for (let i = 0; i < EVAL_SEEDS; i++) {
    report.evaluation.seedsTried++;
    const seed = `TRACE_EVAL_${i}`;

    setGeneStore(factory);
    const baseline = runGame({
      seed, targetName: TARGET_NAME, targetBotId,
      learn: false, traceReads: true,
      expectedGenes: getStoredGenes(factory, targetBotId)
    });
    if (!baseline.targetPresent) {
      report.evaluation.cases.push({ seed, targetPresent: false });
      continue;
    }
    report.evaluation.targetPresent++;

    setGeneStore(targetOnlyLearnedStore);
    const learned = runGame({
      seed, targetName: TARGET_NAME, targetBotId,
      learn: false, traceReads: true,
      expectedGenes: targetLearnedGenes
    });
    if (!learned.targetPresent) {
      check(false, `${seed}：同一環境種子下，學習基因組未選入目標 Bot，配對無效。`);
      report.evaluation.cases.push({ seed, targetPresent: true, learnedTargetPresent: false });
      continue;
    }

    const envMatches = same(baseline.environment, learned.environment);
    if (envMatches) report.evaluation.environmentMatched++;
    else check(false, `${seed}：A/B 客觀環境不一致，不能用於因果比較。`);

    const baselineReadObserved = baseline.reads.length > 0;
    const learnedReadObserved = learned.reads.length > 0;
    const readObserved = baselineReadObserved || learnedReadObserved;
    if (readObserved) report.evaluation.geneReadObserved++;
    const difference = compareDecisions(baseline.decisions, learned.decisions);
    if (envMatches && difference.differs) report.evaluation.behaviorDiverged++;
    if (envMatches) pairedCases.push({ seed, baseline, learned, difference });

    const entry = {
      seed,
      targetPresent: true,
      role: baseline.role,
      learnedRole: learned.role,
      baselineGene: baseline.genesAtStart && baseline.genesAtStart[GENE_KEY],
      learnedGene: learned.genesAtStart && learned.genesAtStart[GENE_KEY],
      baselineReadCount: baseline.reads.length,
      learnedReadCount: learned.reads.length,
      baselineGeneReadObserved: baselineReadObserved,
      learnedGeneReadObserved: learnedReadObserved,
      environmentMatched: envMatches,
      behaviorDiffers: difference.differs,
      divergentDecisionReads: difference.differs ? {
        baseline: readsForDecision(baseline.decisions[difference.index], GENE_KEY),
        learned: readsForDecision(learned.decisions[difference.index], GENE_KEY)
      } : null,
      firstDifference: difference.differs ? { ...difference, baseline: displayDecision(difference.baseline), learned: displayDecision(difference.learned) } : null
    };
    report.evaluation.cases.push(entry);

    if (envMatches && readObserved && !detailedCase) detailedCase = { seed, baseline, learned, difference };
    if (envMatches && difference.differs) {
      const item = { seed, baseline, learned, difference };
      divergenceCases.push(item);
      if (!divergenceCase) divergenceCase = item;
    }
  }

  console.log('\n--- 查核點 2：次局 Engine.start 載入 ---');
  if (detailedCase) {
    const { seed, baseline, learned } = detailedCase;
    console.log(`配對種子：${seed}｜目標角色：${baseline.role}`);
    console.log(`出廠模式載入 ${GENE_KEY}：${baseline.genesAtStart && baseline.genesAtStart[GENE_KEY]}`);
    console.log(`學習模式載入 ${GENE_KEY}：${learned.genesAtStart && learned.genesAtStart[GENE_KEY]}`);
    console.log(`出廠快照完全相符：${baseline.loadMatchesExpected ? '是' : '否'}｜學習後快照完全相符：${learned.loadMatchesExpected ? '是' : '否'}`);
    console.log(`學習後快照是否等於 finalize 寫入的目標快照：${same(learned.genesAtStart, targetLearnedGenes) ? '是' : '否'}`);
    check(learned.loadMatchesExpected === true, '查核點 2：Engine.start 沒有載入預期的學習後完整基因快照。');
    check(same(learned.genesAtStart, targetLearnedGenes), '查核點 2：次局 p.genes 與 finalize 寫入的目標快照不一致。');
  } else {
    check(false, `查核點 2/3：${EVAL_SEEDS} 個評估種子中，未找到「目標在局內且指定基因被實際讀取」的案例。`);
  }

  console.log('\n--- 查核點 3：策略執行期間 Proxy 讀取 ---');
  if (detailedCase) {
    const reads = [...detailedCase.baseline.reads.map(r => ({ variant: 'factory', ...r })), ...detailedCase.learned.reads.map(r => ({ variant: 'learned', ...r }))];
    console.log(`案例 ${detailedCase.seed}｜捕捉到 ${reads.length} 次 ${GENE_KEY} 讀取`);
    reads.slice(0, 40).forEach((r, idx) => {
      console.log(`  ${idx + 1}. [${r.variant}] 第 ${r.round || '?'} 輪｜${r.stage}｜${r.name}（${r.role}）讀取 ${r.gene}=${r.value}`);
    });
    if (reads.length > 40) console.log(`  …其餘 ${reads.length - 40} 次省略`);
    check(reads.length > 0, '查核點 3：Proxy 沒有捕捉到指定基因讀取。');
  } else {
    console.log('未捕捉到有效讀取案例；請勿把「未觀察到讀取」視為策略一定沒有讀取，需先確認屬性存取路徑與測試種子。');
  }

  console.log('\n--- 查核點 4：同環境下行為是否分歧 ---');
  console.log(`評估種子：${EVAL_SEEDS}｜目標入局：${report.evaluation.targetPresent}｜環境配對一致：${report.evaluation.environmentMatched}｜有基因讀取：${report.evaluation.geneReadObserved}｜觀察到目標決策差異：${report.evaluation.behaviorDiverged}`);
  report.evaluation.divergenceCases = divergenceCases.map(item => stableCaseSummary(item, GENE_KEY));
  if (divergenceCase) {
    report.evaluation.witnessSeed = divergenceCase.seed;
    console.log(`\n同環境下觀察到 ${divergenceCases.length} 個分歧案例；以下逐一列出完整的寫入→載入→讀取→決策對照。`);
    divergenceCases.forEach((item, caseIndex) => {
      const baselineDecision = item.baseline.decisions[item.difference.index];
      const learnedDecision = item.learned.decisions[item.difference.index];
      const baselineRelevantReads = readsForDecision(baselineDecision, GENE_KEY);
      const learnedRelevantReads = readsForDecision(learnedDecision, GENE_KEY);
      const baselineRound = baselineDecision && baselineDecision.round;
      const learnedRound = learnedDecision && learnedDecision.round;
      const stage = baselineDecision && baselineDecision.stage || learnedDecision && learnedDecision.stage || 'unknown';
      console.log(`\n[分歧案例 ${caseIndex + 1}/${divergenceCases.length}] ${item.seed}｜角色 ${item.baseline.role}｜環境配對一致：是`);
      console.log(`  CP1 finalize 寫入：${training.before[GENE_KEY]} → ${training.after[GENE_KEY]}（Δ ${round6(training.after[GENE_KEY] - training.before[GENE_KEY])}）；訓練種子 ${training.seed}`);
      console.log(`  CP2 Engine.start：factory ${item.baseline.genesAtStart && item.baseline.genesAtStart[GENE_KEY]}；learned ${item.learned.genesAtStart && item.learned.genesAtStart[GENE_KEY]}`);
      console.log(`  CP2 快照吻合：factory ${item.baseline.loadMatchesExpected ? '是' : '否'}；learned ${item.learned.loadMatchesExpected ? '是' : '否'}；learned 等於 finalize 目標快照：${same(item.learned.genesAtStart, targetLearnedGenes) ? '是' : '否'}`);
      console.log(`  CP3 分歧決策的讀取上下文：stage=${stage}｜factory round=${baselineRound}｜learned round=${learnedRound}`);
      console.log(`  CP3 factory 在該決策內讀取 ${GENE_KEY}：${baselineRelevantReads.length ? baselineRelevantReads.map(r => r.value).join(', ') : '無直接讀取紀錄'}`);
      console.log(`  CP3 learned 在該決策內讀取 ${GENE_KEY}：${learnedRelevantReads.length ? learnedRelevantReads.map(r => r.value).join(', ') : '無直接讀取紀錄'}`);
      console.log(`  CP3 全局讀取次數：factory=${item.baseline.reads.length}；learned=${item.learned.reads.length}`);
      console.log(`  CP4 分歧決策索引：${item.difference.index}`);
      console.log('  factory 決策：' + JSON.stringify(displayDecision(item.difference.baseline)));
      console.log('  learned 決策：' + JSON.stringify(displayDecision(item.difference.learned)));
      if (!baselineRelevantReads.length && !learnedRelevantReads.length) {
        console.log('  因果解讀：此分歧決策函式本身沒有讀取目標基因的直接紀錄；需視為行為差異觀察，不能宣稱已直接對齊。');
      } else {
        console.log('  因果解讀：該分歧決策的同一 stage 有目標基因讀取紀錄，支持「基因讀取與決策差異在此決策步驟對齊」；仍非對全部策略路徑的普遍證明。');
      }
    });
  } else {
    console.log('在這組評估種子中未觀察到目標決策分歧。這不單獨證明基因無效；可能是條件分支未走到、隨機門檻兩側結果相同，或指定基因只影響其他決策。');
  }

  // 對所有成功配對的環境做 A/A，而不只檢查仍被判定為分歧的案例。
  // 這可確保正規化後不再顯示分歧的 TRACE_EVAL_11/14/38 仍會被重新驗證。
  const aaCases = pairedCases;
  let factoryAAPassCount = 0;
  let learnedAAPassCount = 0;
  let allFactoryAA = aaCases.length > 0;
  let allLearnedAA = aaCases.length > 0;
  const aaDiagnostics = [];
  for (const item of aaCases) {
    setGeneStore(factory);
    const baselineRepeat = runGame({
      seed: item.seed, targetName: TARGET_NAME, targetBotId,
      learn: false, traceReads: true,
      expectedGenes: getStoredGenes(factory, targetBotId)
    });
    const factoryEnvDiff = firstDifference(item.baseline.environment, baselineRepeat.environment);
    const factoryDecisionDiff = firstDifference(item.baseline.decisions.map(decisionOnly), baselineRepeat.decisions.map(decisionOnly));
    const factoryReadDiff = firstDifference(item.baseline.reads, baselineRepeat.reads);
    const factoryGenesDiff = firstDifference(item.baseline.genesAtStart, baselineRepeat.genesAtStart);
    const factoryPassed = baselineRepeat.targetPresent &&
      !factoryEnvDiff && !factoryDecisionDiff && !factoryReadDiff && !factoryGenesDiff;
    if (factoryPassed) factoryAAPassCount++;
    allFactoryAA = allFactoryAA && factoryPassed;

    setGeneStore(targetOnlyLearnedStore);
    const learnedRepeat = runGame({
      seed: item.seed, targetName: TARGET_NAME, targetBotId,
      learn: false, traceReads: true,
      expectedGenes: targetLearnedGenes
    });
    const learnedEnvDiff = firstDifference(item.learned.environment, learnedRepeat.environment);
    const learnedDecisionDiff = firstDifference(item.learned.decisions.map(decisionOnly), learnedRepeat.decisions.map(decisionOnly));
    const learnedReadDiff = firstDifference(item.learned.reads, learnedRepeat.reads);
    const learnedGenesDiff = firstDifference(item.learned.genesAtStart, learnedRepeat.genesAtStart);
    const learnedPassed = learnedRepeat.targetPresent &&
      !learnedEnvDiff && !learnedDecisionDiff && !learnedReadDiff && !learnedGenesDiff;
    if (learnedPassed) learnedAAPassCount++;
    allLearnedAA = allLearnedAA && learnedPassed;

    const diag = {
      seed: item.seed,
      factory: { passed: factoryPassed, firstDifference: factoryEnvDiff ? { category: 'environment', ...factoryEnvDiff } : factoryDecisionDiff ? { category: 'decisions', ...factoryDecisionDiff } : factoryReadDiff ? { category: 'geneReads', ...factoryReadDiff } : factoryGenesDiff ? { category: 'genesAtStart', ...factoryGenesDiff } : null },
      learned: { passed: learnedPassed, firstDifference: learnedEnvDiff ? { category: 'environment', ...learnedEnvDiff } : learnedDecisionDiff ? { category: 'decisions', ...learnedDecisionDiff } : learnedReadDiff ? { category: 'geneReads', ...learnedReadDiff } : learnedGenesDiff ? { category: 'genesAtStart', ...learnedGenesDiff } : null }
    };
    aaDiagnostics.push(diag);
    console.log(`
A/A 重現性 ${item.seed}：factory ${factoryPassed ? '通過' : '失敗'}｜learned ${learnedPassed ? '通過' : '失敗'}`);
    if (!factoryPassed) console.log('  factory 第一個差異：' + JSON.stringify(diag.factory.firstDifference));
    if (!learnedPassed) console.log('  learned 第一個差異：' + JSON.stringify(diag.learned.firstDifference));
  }
  report.evaluation.aaDiagnostics = aaDiagnostics;
  report.evaluation.aaFactoryPassed = factoryAAPassCount;
  report.evaluation.aaLearnedPassed = learnedAAPassCount;
  if (aaCases.length) {
    report.evaluation.aaPassed = allFactoryAA;
    report.evaluation.learnedAaPassed = allLearnedAA;
    check(allFactoryAA, `A/A：出廠基因重現 ${factoryAAPassCount}/${aaCases.length} 組；失敗案例附有第一個差異路徑。`);
    check(allLearnedAA, `A/A：學習後基因重現 ${learnedAAPassCount}/${aaCases.length} 組；失敗案例附有第一個差異路徑。`);
  } else {
    report.evaluation.aaPassed = false;
    report.evaluation.learnedAaPassed = false;
    check(false, 'A/A：沒有可用的環境配對案例，無法完成重現性校驗。');
  }

  report.errors = errors.slice();
  report.totalFailures = failures;
  report.summary = {
    checkpoint1GeneChanged: true,
    checkpoint2LoadMatched: !!(detailedCase && detailedCase.learned.loadMatchesExpected && same(detailedCase.learned.genesAtStart, targetLearnedGenes)),
    checkpoint3GeneReadSeen: !!(detailedCase && (detailedCase.baseline.reads.length + detailedCase.learned.reads.length) > 0),
    checkpoint4BehaviorDiverged: !!divergenceCase,
    environmentPairedForAllPresentCases: report.evaluation.environmentMatched === report.evaluation.targetPresent,
    aaPassed: report.evaluation.aaPassed,
    learnedAaPassed: report.evaluation.learnedAaPassed,
    divergenceCaseCount: divergenceCases.length,
    aaCaseCount: aaCases.length,
    aaFactoryPassed: factoryAAPassCount,
    aaLearnedPassed: learnedAAPassCount,
    failures
  };

  console.log('\n=== 稽核總結 ===');
  console.log(`查核點 1 自然結算後基因改變：${report.summary.checkpoint1GeneChanged ? '有' : '無'}`);
  console.log(`查核點 2 Engine.start 載入新基因：${report.summary.checkpoint2LoadMatched ? '有' : '尚未通過'}`);
  console.log(`查核點 3 策略期間實際讀取：${report.summary.checkpoint3GeneReadSeen ? '有' : '尚未觀察到'}`);
  console.log(`查核點 4 同環境下行為分歧：${report.summary.checkpoint4BehaviorDiverged ? '有' : '本輪未觀察到'}`);
  console.log(`A/A 出廠基因可重現：${report.summary.aaPassed === null ? '未執行' : report.summary.aaPassed ? '通過' : '失敗'}`);
  console.log(`A/A 學習後基因可重現：${report.summary.learnedAaPassed === null ? '未執行' : report.summary.learnedAaPassed ? '通過' : '失敗'}`);
  console.log(`A/A 有效配對案例：${report.summary.aaCaseCount}｜factory 通過 ${report.summary.aaFactoryPassed}｜learned 通過 ${report.summary.aaLearnedPassed}`);
  console.log(`完整分歧軌跡數：${report.summary.divergenceCaseCount}`);
  console.log(`硬性失敗項：${failures}`);
  console.log('注意：查核點 4 是行為敏感度的觀察，不是每個單一種子都必須分歧的硬性條件。');

  if (REPORT_PATH) {
    const abs = path.resolve(REPORT_PATH);
    fs.writeFileSync(abs, JSON.stringify(report, null, 2), 'utf8');
    console.log(`完整 JSON 報告：${abs}`);
  }
  if (failures > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error('\n✗ 稽核腳本執行中止：', error && error.stack || error);
  process.exitCode = 1;
}
