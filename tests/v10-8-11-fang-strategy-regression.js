'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Claims, Mind, Strategy, Speech } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'host');
  Engine.fillBots(room);
  assert(Engine.start(room));
  const roleOrder = ['鄭國渠', '藥不然', '方震', '老朝奉', '許願', '木戶加奈', '姬雲浮', '黃煙煙'];
  room.players.forEach((p, i) => {
    p.role = roleOrder[i];
    p.name = ({ '方震': '熊寶', '許願': 'RAY', '木戶加奈': '馬陰久', '黃煙煙': '十全大補湯' })[p.role] || `玩家${i + 1}`;
  });
  return room;
}

function testVerifiedGoodProtectedForEighth() {
  const room = makeRoom('FANG_VERIFIED_GOOD_TAIL');
  const fang = room.players.find(p => p.role === '方震');
  const verifiedGood = room.players.find(p => p.role === '木戶加奈');
  const unverified = room.players.find(p => p.role === '藥不然');
  const rd = Engine.drawRound(room, 2);
  room.rounds = [room.rounds[0], rd];
  room.currentRoundIdx = 1;
  room.status = 'playing';
  room.currentTurnPlayerId = fang.id;
  const others = room.players.filter(p => ![fang.id, verifiedGood.id, unverified.id].includes(p.id)).slice(0, 5);
  rd.passOrder = [...others.map(p => p.id), fang.id]; // sixth position; two players remain
  rd.turnLogs[fang.id] = { inspect: [], step: 'c', fangTargetId: verifiedGood.id, fangCamp: 'good' };

  const A = Mind.analyze(fang, room);
  assert.strictEqual(A.ctx.myPos, 5);
  assert.strictEqual(Engine.remainingToAct(room).length, 2);
  const selected = Strategy.nextPlayer(fang, room, A);
  assert.strictEqual(selected, unverified.id,
    'the not-yet-verified player must go seventh, preserving the directly checked good player for eighth');
  assert.match(String(A.ctx.log.passWhy || ''), /直接查驗|第八位尾家/);
}

function testFinalFangRevealUsesRealAbilityHistory() {
  const room = makeRoom('FANG_FINAL_TRUE_REVEAL');
  const fang = room.players.find(p => p.role === '方震');
  const white = room.players.find(p => p.role === '許願');
  const black = room.players.find(p => p.role === '木戶加奈');
  const red = room.players.find(p => p.role === '黃煙煙');
  const r1 = room.rounds[0];
  const r2 = Engine.drawRound(room, 2);
  const r3 = Engine.drawRound(room, 3);
  room.rounds = [r1, r2, r3];
  room.currentRoundIdx = 2;
  room.status = 'playing';
  room.currentTurnPlayerId = fang.id;
  r1.turnLogs[fang.id] = { inspect: [], step: 'c', fangTargetId: white.id, fangCamp: 'good' };
  r2.turnLogs[fang.id] = { inspect: [], step: 'c', fangTargetId: black.id, fangCamp: 'good' };
  r3.turnLogs[fang.id] = { inspect: [], step: 'c', fangTargetId: red.id, fangCamp: 'good' };
  r3.passOrder = room.players.slice(0, 4).map(p => p.id);
  const accusation = `我懷疑白色【${white.name}】可能是方震，請他交代能力時點。`;
  r3.speeches = [{
    playerId: room.players.find(p => p.role === '老朝奉').id,
    speakerName: '藍色玩家', source: 'bot', text: accusation,
    p: Claims.parse(accusation, room, r3)
  }];

  const A = Mind.analyze(fang, room);
  const { plan } = Strategy.plan(fang, room);
  assert.strictEqual(plan.revealFang, true,
    'third round with three verifiable Fang camp checks and a public Fang-role dispute should trigger reveal');
  assert.strictEqual(plan.roleBluff, null, 'a decisive true Fang reveal must suppress unsupported false-role claims');
  assert.strictEqual(plan.trueRoleSignal.reveal, true);
  assert.strictEqual(plan.trueRoleSignal.verifiedCampChecks.length, 3);

  const speech = Speech.localSpeech(fang, room, plan, A);
  assert.match(speech, /我是方震/);
  for (const target of [white, black, red]) assert(speech.includes(target.name), `reveal should cite checked player ${target.name}`);
  assert.match(speech, /沒有獸首查驗能力|不是我親自驗出/);
  const validation = Speech.validate(speech, fang, room, plan, A);
  assert.strictEqual(validation.ok, true, validation.why || 'true Fang reveal must pass speech validation');
}

function testFangCannotPretendToBeXu() {
  const fang = { role: '方震' };
  const pool = Strategy.buildRoleBluffPool(fang, { isGood: true });
  assert(!pool.includes('許願'), 'Fang must not use Xu false-claim without two beast inspections');
  assert(pool.includes('黃煙煙') && pool.includes('木戶加奈'),
    'other role disguises remain available; the fix must not disable role-play wholesale');
}

function testFalseHuangRoleMustHaveUnreadableRound() {
  const room = makeRoom('FALSE_HUANG_ABILITY_PROFILE');
  const lao = room.players.find(p => p.role === '老朝奉');
  const rd = room.rounds[0];
  room.status = 'playing';
  room.currentTurnPlayerId = lao.id;
  rd.passOrder = room.players.slice(0, 5).map(p => p.id);
  const A = Mind.analyze(lao, room);
  const { plan } = Strategy.plan(lao, room);
  plan.roleBluff = { role: '黃煙煙', kind: 'false_claim', persist: true, abilityProfile: { unreadableRound: 1, kind: 'single-unreadable-round' } };
  plan.roleAbilityCover = 'unreadable';
  plan.claims = [];
  plan.withholdInfo = false;
  // Isolate this forced false-role scenario from any unrelated random true-role hint selected by Strategy.plan.
  plan.trueRoleSignal = null;
  const speech = Speech.localSpeech(lao, room, plan, A);
  assert.match(speech, /我是黃煙煙/);
  assert.match(speech, /無法辨別真偽/);
  assert.doesNotMatch(speech, /【[鼠牛虎兔龍蛇馬猴雞狗豬]+】(?:是真品|是贗品)/);
  const validation = Speech.validate(speech, lao, room, plan, A);
  assert.strictEqual(validation.ok, true, validation.why || 'false Huang role performance should pass its unreadable round');
}

try {
  testVerifiedGoodProtectedForEighth();
  testFinalFangRevealUsesRealAbilityHistory();
  testFangCannotPretendToBeXu();
  testFalseHuangRoleMustHaveUnreadableRound();
  console.log('PASS v10.8.11 Fang/role-performance regression (4 scenarios)');
} catch (err) {
  console.error('FAIL v10.8.11 Fang strategy regression:', err && err.stack || err);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
