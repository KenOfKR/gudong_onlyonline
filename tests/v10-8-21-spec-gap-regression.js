/* ============================================================================
 * tests/v10-8-21-spec-gap-regression.js
 * 驗證 v10.8.21 規格書關鍵要求：
 *   1) 條件假設句（「如果你是老朝奉...」）不得誤判為直接指認 accuse
 *   2) 區分「我認為狗是真品 (opinion)」與「我親驗狗是真品 (direct_check)」
 *   3) 角色互換 5 大假設模型 (evaluateRoleSwapHypotheses) 完整輸出
 *   4) 終局刪除法五級矩陣 (tiers) 與正反證據 (supporting/counter) 一致性
 *   5) CommandInterceptor 標準意圖 Schema、遠端字幕防誤觸、Provider 與隱私開關
 * ========================================================================== */
'use strict';

const assert = require('assert');
const harness = require('./harness');

function initGD() {
  if (typeof harness === 'function') return harness();
  if (harness && typeof harness.boot === 'function') return harness.boot();
  if (harness && typeof harness.loadGame === 'function') return harness.loadGame();
  if (harness && typeof harness.createHarness === 'function') return harness.createHarness();
  if (harness && harness.GD) return harness.GD;

  // 若 harness 僅初始化全域 window.GD，直接載入核心模組
  if (typeof global.window === 'undefined') global.window = global;
  if (!global.window.GD) global.window.GD = {};
  require('../js/config.js');
  require('../js/utils.js');
  require('../js/roster.js');
  require('../js/core/rules.js');
  require('../js/core/claims.js');
  require('../js/core/conversation.js');
  require('../js/core/engine.js');
  require('../js/bot/genes.js');
  require('../js/bot/dialogueBank.js');
  require('../js/bot/mind.js');
  require('../js/bot/tactics.js');
  require('../js/bot/strategy.js');
  require('../js/bot/speech.js');
  require('../js/bot/review.js');
  require('../js/voice.js');
  return global.window.GD;
}

function makeTestRoom(GD) {
  const room = GD.Engine.newRoom('8821', 'p1');
  const names = ['宗彥', '張懿', '薏涵', '佩萱', '皓鈞', 'Molly', '博文', '佳穎'];
  names.forEach((name, idx) => {
    GD.Engine.addPlayer(room, {
      id: `p${idx + 1}`,
      name,
      isBot: idx > 0,
      botId: idx > 0 ? `b${idx}` : null
    });
  });
  GD.Engine.start(room);
  return room;
}

function run() {
  const GD = initGD();
  const { Claims, Mind, Strategy, Review, Voice, Engine } = GD;
  const room = makeTestRoom(GD);
  const rd = room.rounds[room.currentRoundIdx];
  const targetBeast = rd.beasts[0].name;
  const p2 = room.players[1];
  const p3 = room.players[2];

  // -------------------------------------------------------------------------
  // 1. 語意理解：條件假設句 vs 正式指認，以及「我認為」vs「我親自查驗」
  // -------------------------------------------------------------------------
  const conditionalText = `如果【${p2.name}】是老朝奉，那他應該解釋技能時點。`;
  const parsedCond = Claims.parse(conditionalText, room, rd, 'p1');
  assert.strictEqual(
    (parsedCond.accuse || []).some(a => a.playerId === p2.id && a.role === '老朝奉'),
    false,
    '條件式假設句「如果某人是老朝奉」不得被誤判成正式指認 accuse'
  );
  assert.ok(
    Array.isArray(parsedCond.conditionalClaims) &&
      parsedCond.conditionalClaims.some(c => c.playerId === p2.id && c.role === '老朝奉' && c.polarity === 'conditional'),
    '條件式假設句應記入 conditionalClaims'
  );

  const opinionText = `我認為【${targetBeast}】是真品，但我不會跟投【${targetBeast}】。`;
  const directText = `我親自查驗看到【${targetBeast}】是真品。`;
  const parsedOpinion = Claims.parse(opinionText, room, rd, 'p1');
  const parsedDirect = Claims.parse(directText, room, rd, 'p1');

  assert.strictEqual(parsedOpinion.claims.length, 1, '主觀認為仍應解析出獸首真偽立場');
  assert.strictEqual(parsedOpinion.claims[0].claimType, 'opinion', '「我認為」應標記為 opinion');
  assert.strictEqual(parsedOpinion.claims[0].selfReportedDirect, false, '「我認為」不得標記為親自查驗');
  assert.strictEqual(
    (parsedOpinion.callBeasts || []).includes(targetBeast),
    false,
    '「我不會跟投」不得誤判為號召投該獸首'
  );

  assert.strictEqual(parsedDirect.claims.length, 1, '親自查驗應解析出獸首真偽宣稱');
  assert.strictEqual(parsedDirect.claims[0].claimType, 'direct_check', '「我親自查驗」應標記為 direct_check');
  assert.strictEqual(parsedDirect.claims[0].selfReportedDirect, true, '「我親自查驗」應標記 selfReportedDirect: true');

  // -------------------------------------------------------------------------
  // 2. 角色互換 5 假設檢驗模型 (A真B假 / A假B真 / 雙假 / 戰術互換 / 未跳者為真)
  // -------------------------------------------------------------------------
  rd.speeches.push({
    playerId: p2.id,
    speakerName: p2.name,
    colorId: p2.colorId,
    text: `我是老朝奉，【${targetBeast}】是贗品，請大家投【${targetBeast}】。`,
    source: 'bot',
    createdAt: Date.now() - 2000
  });
  rd.speeches.push({
    playerId: p3.id,
    speakerName: p3.name,
    colorId: p3.colorId,
    text: `我是藥不然，【${targetBeast}】是贗品，我也主張投【${targetBeast}】。`,
    source: 'bot',
    createdAt: Date.now() - 1000
  });

  const observerBot = room.players.find(p => p.isBot && p.id !== p2.id && p.id !== p3.id && GD.isGood(p.role)) || room.players[3];
  const analysis = Mind.analyze(observerBot, room);
  assert.ok(Array.isArray(analysis.roleSwapPairs) && analysis.roleSwapPairs.length >= 1, '應偵測到老朝奉／藥不然角色互換 pair');
  const pair = analysis.roleSwapPairs[0];
  assert.ok(pair.hypotheses, 'roleSwapPair 必須包含 5 種假設評估物件 hypotheses');
  ['A_true_B_false', 'A_false_B_true', 'both_false', 'coordinated_tactical_swap', 'unclaimed_player_is_true'].forEach(key => {
    assert.strictEqual(typeof pair.hypotheses[key], 'number', `缺少角色互換假設欄位: ${key}`);
  });
  assert.strictEqual(typeof pair.dominantHypothesis, 'string', '必須標出當前主導假設 dominantHypothesis');

  // -------------------------------------------------------------------------
  // 3. 終局刪除法五級分類矩陣與 Review 覆盤一致性
  // -------------------------------------------------------------------------
  room.currentRoundIdx = 2;
  while (room.rounds.length < 3) {
    room.rounds.push(Engine.drawRound(room, room.rounds.length + 1));
  }
  room.status = 'person_voting';
  const pv = Strategy.personVote(observerBot, room);
  observerBot.final = pv;
  room.personVotes[observerBot.id] = pv.targetId;

  assert.ok(pv.deduction, 'personVote 必須產出 deduction 刪除法物件');
  assert.ok(pv.deduction.tiers, 'deduction 必須包含五級分類矩陣 tiers');
  ['confirmedExcluded', 'highlyUnlikely', 'tentativelyExcluded', 'retainedCandidates', 'insufficientInfo'].forEach(tierKey => {
    assert.ok(Array.isArray(pv.deduction.tiers[tierKey]), `deduction.tiers 缺少分級陣列: ${tierKey}`);
  });
  assert.ok(pv.deduction.ranked.length > 0, 'deduction.ranked 應有候選排序');
  assert.strictEqual(pv.targetId, pv.deduction.selectedId, '最終指認對象必須與刪除法矩陣 selectedId 一致');
  pv.deduction.ranked.forEach(entry => {
    assert.ok(Array.isArray(entry.supportingEvidence), '候選人必須包含 supportingEvidence 陣列');
    assert.ok(Array.isArray(entry.counterEvidence), '候選人必須包含 counterEvidence 陣列');
    assert.ok(
      ['確認排除', '高度不可能', '暫時排除', '保留候選', '資訊不足，無法判斷'].includes(entry.eliminationTier),
      `候選人具有未定義的排除等級: ${entry.eliminationTier}`
    );
  });

  const finalReview = Review.reviewFinal(room, observerBot);
  assert.strictEqual(finalReview.deduction.selectedId, pv.targetId, '賽後覆盤必須共用同一份終局刪除法結果');

  // -------------------------------------------------------------------------
  // 4. CommandInterceptor 標準意圖 Schema、遠端字幕防誤觸與 Provider 控制
  // -------------------------------------------------------------------------
  const me = room.players[0];
  const cmdInspect = Voice.CommandInterceptor.parse(`系統指令，鑑定${targetBeast}`, room, me, {
    requireWakeWord: true,
    sourcePlayerId: me.id
  });
  assert.strictEqual(cmdInspect.type, 'inspect', '含喚醒詞的合法查驗指令應解析為 inspect');
  assert.strictEqual(cmdInspect.intent, 'inspect', '標準 Schema 應包含 intent');
  assert.strictEqual(cmdInspect.object, targetBeast, '標準 Schema 應包含 object');
  assert.strictEqual(cmdInspect.phase, 'playing', '標準 Schema 應包含 phase');
  assert.strictEqual(cmdInspect.confirmationRequired, true, '不可逆操作應要求確認 confirmationRequired: true');

  const chatMention = Voice.CommandInterceptor.parse(`剛剛有人說要鑑定${targetBeast}`, room, me, {
    requireWakeWord: true,
    sourcePlayerId: me.id
  });
  assert.strictEqual(chatMention.type, 'invalid', '一般聊天提到「鑑定」且無喚醒詞時不得觸發動作');

  const remoteCmd = Voice.CommandInterceptor.parse(`系統指令，鑑定${targetBeast}`, room, me, {
    isRemoteTranscript: true,
    sourcePlayerId: p2.id
  });
  assert.strictEqual(remoteCmd.type, 'invalid', '遠端玩家同步過來的字幕絕對不能觸發本機操作');

  assert.strictEqual(Voice.setProvider('local-ws', { wsUrl: 'ws://evil.example.com/stt' }), false, '不得允許非本機的 WebSocket STT 連線');
  assert.strictEqual(Voice.setProvider('local-ws', { wsUrl: 'ws://127.0.0.1:8765/stt' }), true, '應允許 127.0.0.1 本機 STT 服務設定');
  Voice.setProvider('web-speech');

  assert.strictEqual(Voice.setPublicScope(false), false, '應支援關閉公開字幕同步 (不公開模式)');
  assert.strictEqual(Voice.setPublicScope(true), true, '應支援開啟公開字幕同步');

  console.log('PASS v10-8-21-spec-gap-regression');
  process.exit(0);
}

run();
module.exports = { run };