'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Rules, U } = GD;

function fixture(code) {
  const room = Engine.newRoom(code, 'host');
  Engine.fillBots(room);
  assert(Engine.start(room));
  const roles = ['藥不然', '方震', '許願', '姬雲浮', '老朝奉', '黃煙煙', '木戶加奈', '鄭國渠'];
  room.players.forEach((p, i) => { p.role = roles[i]; });
  room.players.forEach(p => {
    p.isAmbushed = false;
    p.isPermanentlyAmbushed = false;
    p.pendingAmbush = false;
    p.pendingImmediateAmbush = false;
    p.pendingPermanentAmbush = false;
    p.pendingAmbushTiming = p.pendingAmbushSourceRound = null;
    p.pendingImmediateAmbushTiming = p.pendingImmediateAmbushSourceRound = null;
  });
  return room;
}

function readyYao(room, yao) {
  const rd = room.rounds[room.currentRoundIdx];
  room.status = 'playing';
  room.currentTurnPlayerId = yao.id;
  rd.passOrder = [yao.id];
  const log = Engine.log(room, yao.id);
  log.step = 'b';
  return log;
}

function testUnactedTargetOnlyBlindedOnHandoff() {
  const room = fixture('AMBUSH_HIDDEN_IMMEDIATE');
  const yao = room.players.find(p => p.role === '藥不然');
  const victim = room.players.find(p => p.role === '姬雲浮');
  readyYao(room, yao);
  const precreatedVictimLog = Engine.log(room, victim.id);
  assert.strictEqual(precreatedVictimLog.blind, false, 'a pre-created off-turn log stays unblinded');
  assert(Engine.skill(room, yao.id, { kind: 'yao', targetId: victim.id }));
  assert.strictEqual(victim.pendingImmediateAmbush, true, '未行動目標只應進入隱藏排程');
  assert.strictEqual(victim.isAmbushed, false, '偷襲發動當下不得公開致盲');
  assert.strictEqual(victim.isPermanentlyAmbushed, false, '姬雲浮永久失明也不得提早顯示');
  assert.strictEqual(Rules.isBlind(victim), false, 'UI／規則查詢在輪到前不得讀到失明');

  assert(Engine.pass(room, yao.id, victim.id));
  assert.strictEqual(room.currentTurnPlayerId, victim.id);
  assert.strictEqual(victim.isAmbushed, true, '接到手機成為當前行動者後才啟動');
  assert.strictEqual(victim.isPermanentlyAmbushed, true, '姬雲浮輪到時才啟動永久效果');
  assert.strictEqual(precreatedVictimLog.blind, true, 'pre-created turn log must be synchronised when ambush activates');
  assert.strictEqual(precreatedVictimLog.blindTiming, 'immediate');
  assert.strictEqual(precreatedVictimLog.blindSourceRound, 1);
  const result = Engine.inspect(room, victim.id, room.rounds[0].beasts[0].name);
  assert(result && result.kind === 'blind', '真正輪到目標後查驗才顯示被偷襲');
}

function testFangLinkedXuHasIndependentTurnTiming() {
  const room = fixture('AMBUSH_FANG_XU_LINK');
  const yao = room.players.find(p => p.role === '藥不然');
  const fang = room.players.find(p => p.role === '方震');
  const xu = room.players.find(p => p.role === '許願');
  readyYao(room, yao);
  assert(Engine.skill(room, yao.id, { kind: 'yao', targetId: fang.id }));
  assert.strictEqual(fang.isAmbushed, false);
  assert.strictEqual(xu.isAmbushed, false);
  assert.strictEqual(fang.pendingImmediateAmbush, true);
  assert.strictEqual(xu.pendingImmediateAmbush, true);

  assert(Engine.pass(room, yao.id, fang.id));
  assert.strictEqual(Rules.isBlind(fang), true, '方震輪到時才啟動本人的偷襲');
  assert.strictEqual(Rules.isBlind(xu), false, '連帶許願仍須等許願自己的回合');
  room.currentTurnPlayerId = xu.id;
  Engine.log(room, xu.id);
  assert.strictEqual(Rules.isBlind(xu), true, '許願輪到時才啟動連帶致盲');
  assert.strictEqual(Engine.inspect(room, xu.id, room.rounds[0].beasts[0].name).kind, 'blind');
}

function testActedTargetDeferredAndNotRevealedAtRoundStart() {
  const room = fixture('AMBUSH_HIDDEN_DEFERRED');
  const yao = room.players.find(p => p.role === '藥不然');
  const victim = room.players.find(p => p.role === '木戶加奈');
  const rd = room.rounds[0];
  room.status = 'playing';
  // 受害者已先行動；藥不然現在才偷襲，應延至下一輪該玩家真正接牌。
  rd.passOrder = [victim.id, yao.id, ...room.players.filter(p => p.id !== victim.id && p.id !== yao.id).map(p => p.id)];
  room.currentTurnPlayerId = yao.id;
  Engine.log(room, yao.id).step = 'b';
  assert(Engine.skill(room, yao.id, { kind: 'yao', targetId: victim.id }));
  assert.strictEqual(victim.pendingAmbush, true);
  assert.strictEqual(victim.isAmbushed, false);
  assert.strictEqual(Rules.isBlind(victim), false);

  // 將本輪推進至結算；尾家故意不是受害者。
  rd.voteResults = { rank1: { name: rd.beasts[0].name }, rank2: { name: rd.beasts[1].name } };
  room.status = 'voting';
  assert(Engine.advance(room));
  assert.notStrictEqual(room.currentTurnPlayerId, victim.id);
  assert.strictEqual(victim.pendingImmediateAmbush, true);
  assert.strictEqual(victim.isAmbushed, false, '新一輪開始本身不得提前揭露延遲偷襲');
  assert.strictEqual(Rules.isBlind(victim), false);
  const deferredLog = Engine.log(room, victim.id);
  assert.strictEqual(deferredLog.blind, false, 'the next-round off-turn log must remain hidden');

  // 以當前行動者真實交牌給受害者，驗證交接後才啟動。
  const current = U.byId(room, room.currentTurnPlayerId);
  Engine.log(room, current.id).step = 'c';
  assert(Engine.pass(room, current.id, victim.id));
  assert.strictEqual(room.currentTurnPlayerId, victim.id);
  assert.strictEqual(Rules.isBlind(victim), true);
  assert.strictEqual(victim.activeAmbushTiming, 'deferred');
  assert.strictEqual(deferredLog.blind, true);
  assert.strictEqual(deferredLog.blindTiming, 'deferred');
  assert.strictEqual(deferredLog.blindSourceRound, 1);
  assert.strictEqual(Engine.inspect(room, victim.id, room.rounds[1].beasts[0].name).kind, 'blind');
}

try {
  testUnactedTargetOnlyBlindedOnHandoff();
  testFangLinkedXuHasIndependentTurnTiming();
  testActedTargetDeferredAndNotRevealedAtRoundStart();
  console.log('PASS v10.8.11 ambush privacy/timing regression (3 scenarios)');
} catch (err) {
  console.error('FAIL v10.8.11 ambush privacy/timing regression:', err && err.stack || err);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
