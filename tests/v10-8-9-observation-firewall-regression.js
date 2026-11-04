'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Claims, Mind, Strategy, Tactics } = GD;

function roomFixture() {
  const room = Engine.newRoom('V1089_OBSERVATION_FIREWALL', 'human');
  Engine.addPlayer(room, { id: 'human', name: '歪ㄟ恩' });
  Engine.fillBots(room);
  assert(Engine.start(room));
  const roster = [
    ['歪ㄟ恩', '藥不然'], ['修宏', '老朝奉'], ['張懿', '黃煙煙'], ['Molly', '木戶加奈'],
    ['順欸', '姬雲浮'], ['柏仰', '許願'], ['卓毅', '鄭國渠'], ['陳子揚', '方震']
  ];
  room.players.forEach((p, i) => {
    p.name = roster[i][0];
    p.role = roster[i][1];
  });
  const byName = name => room.players.find(p => p.name === name);
  const rd = room.rounds[0];
  rd.beasts = [
    { name: '羊', isReal: true }, { name: '馬', isReal: false },
    { name: '猴', isReal: true }, { name: '鼠', isReal: false }
  ];
  const pass = ['修宏', '張懿', '歪ㄟ恩', 'Molly', '順欸', '柏仰', '卓毅', '陳子揚'];
  rd.passOrder = pass.map(name => byName(name).id);
  const speech = ['Molly', '歪ㄟ恩', '張懿', '卓毅', '修宏', '柏仰', '順欸', '陳子揚'];
  rd.speechOrder = speech.map(name => byName(name).id);
  rd.laoActive = true;
  rd.turnLogs = {};
  rd.mind = {};
  const zhang = byName('張懿');
  rd.turnLogs[zhang.id] = { inspect: [{
    beastName: '羊', resultText: '【羊】【贗品】', displayedReal: false,
    kind: 'ok', flipped: true
  }] };
  const humanText = '我認為【羊】是贗品，這輪先投羊。';
  rd.speeches = [
    { playerId: byName('Molly').id, speakerName: 'Molly', source: 'bot', text: '我先聽大家的判斷。', p: {} },
    { playerId: byName('歪ㄟ恩').id, speakerName: '歪ㄟ恩', source: 'human', text: humanText, p: Claims.parse(humanText, room, rd) }
  ];
  return { room, rd, byName };
}

try {
  const { room, rd, byName } = roomFixture();
  const zhang = byName('張懿');
  const human = byName('歪ㄟ恩');

  // This is the exact bug: the screen says fake, while the hidden audit bit says the display was reversed.
  assert.strictEqual(rd.beasts.find(b => b.name === '羊').isReal, true);
  assert.strictEqual(rd.turnLogs[zhang.id].inspect[0].displayedReal, false);
  assert.strictEqual(rd.turnLogs[zhang.id].inspect[0].flipped, true);
  assert.strictEqual(Mind.inspectionTruth(rd.turnLogs[zhang.id].inspect[0]), false,
    '局中真偽必須等於張懿畫面上的贗品');
  assert.strictEqual(Mind.auditTruth(rd.turnLogs[zhang.id].inspect[0]), true,
    '事後稽核才可以透過 flipped 還原世界真相');

  const ctx = Mind.context(zhang, room);
  assert.strictEqual(ctx.myIns[0].displayedReal, false);
  assert(!Object.prototype.hasOwnProperty.call(ctx.myIns[0], 'flipped'),
    'player decision context must not contain the engine-only flag');
  assert(!Object.prototype.hasOwnProperty.call(ctx.log.inspect[0], 'flipped'),
    'sanitized context log must not leak the engine-only flag');

  const decision = Strategy.plan(zhang, room);
  const sheepClaim = (decision.plan.claims || []).find(c => c.beast === '羊');
  assert(!sheepClaim || sheepClaim.real === false,
    'Zhang may withhold a repeated public report, but must never reverse her observed fake result into true');
  assert(decision.plan.why.some(line => line.includes('我親眼看到 【羊】假')),
    'internal reasoning must preserve the displayed fake result even when the public claim is withheld');
  rd.speeches = [];
  rd.mind = {};
  const freshDecision = Strategy.plan(zhang, room);
  const freshSheepClaim = (freshDecision.plan.claims || []).find(c => c.beast === '羊');
  assert(freshSheepClaim && freshSheepClaim.real === false,
    'when no earlier public claim needs to be withheld, Zhang must report the inspected sheep as fake');

  // The player's posterior and suspect ranking must be invariant to hidden audit metadata.
  const copy = JSON.parse(JSON.stringify(room));
  copy.rounds[0].turnLogs[zhang.id].inspect[0].flipped = false;
  const a = Mind.analyze(zhang, room);
  const b = Mind.analyze(zhang, copy);
  assert.deepStrictEqual(a.post, b.post, 'belief over the 2-real/2-fake joint worlds must depend on visible evidence, not flipped');
  assert.deepStrictEqual(a.laoAt, b.laoAt, 'latent Lao-position posterior must not read hidden flipped');
  assert.deepStrictEqual(a.byEvil.map(x => [x.player.id, x.evil, x.probs['老朝奉']]),
    b.byEvil.map(x => [x.player.id, x.evil, x.probs['老朝奉']]),
    'suspicion ranking must not change when only an audit-only flag changes');

  // Fang's directly inspected camp is a hard constraint, but it must not identify the exact evil role.
  const fang = byName('陳子揚');
  const target = byName('歪ㄟ恩');
  rd.turnLogs[fang.id] = { fangTargetId: target.id, fangCamp: 'good', inspect: [] };
  let fangMind = Mind.analyze(fang, room);
  assert.strictEqual(fangMind.prof[target.id].knownCamp, 'good');
  assert.strictEqual(fangMind.prof[target.id].pEvil, 0);
  assert.strictEqual(fangMind.prof[target.id].probs['老朝奉'], 0);
  assert(!fangMind.byEvil.some(x => x.player.id === target.id), 'directly cleared player cannot remain an evil suspect');
  rd.turnLogs[fang.id].fangCamp = 'evil';
  fangMind = Mind.analyze(fang, room);
  assert.strictEqual(fangMind.prof[target.id].knownCamp, 'evil');
  assert.strictEqual(fangMind.prof[target.id].pEvil, 1);
  assert(fangMind.prof[target.id].probs['老朝奉'] < 100,
    'an evil-camp scan must not collapse P(Lao) to 100%; it may be Yao or Zheng');

  // Vote forecast carries a separate evil-team mass and correlated same-target coordination risk.
  const voterA = byName('修宏'), voterB = byName('卓毅');
  const belief = {};
  belief[voterA.id] = { pEvil: 0.95 };
  belief[voterB.id] = { pEvil: 0.90 };
  rd.turnLogs[fang.id] = { inspect: [] };
  rd.speeches = [voterA, voterB].map(p => ({
    playerId: p.id, speakerName: p.name, source: 'bot', text: '本輪集中投【鼠】。',
    p: { callBeast: '鼠', callBeasts: ['鼠'], claims: [] }
  }));
  const forecast = Tactics.forecastVotes(room, fang.id, belief);
  assert(forecast.evilExpectedVotes['鼠'] > forecast.goodExpectedVotes['鼠'],
    'high posterior enemy votes should be tracked separately from good-team expected votes');
  assert(forecast.coordinationVariance['鼠'] > 0,
    'same-target coordination among high-pEvil voters should increase correlated variance');
  assert(forecast.coalitionTarget === '鼠');

  const post = rd.beasts.map(b => ({ name: b.name, pReal: b.isReal ? 0.75 : 0.25 }));
  const projected = Tactics.scoreProjection(room, fang, post,
    { pTopTwo: { 羊: 0.5, 馬: 0.5, 猴: 0.5, 鼠: 0.5 } }, belief);
  assert(projected.expectedRoleBonuses >= 0 && projected.expectedRoleBonuses <= 4);
  assert(projected.estimatedWinProbability >= 0 && projected.estimatedWinProbability <= 1);
  assert.notStrictEqual(projected.roleBonusPotential, 4,
    'the old hard-coded four role points must be replaced by posterior-based expected role bonuses');

  // Official rules remain untouched: role, score threshold and pass-tail speaking order still govern the game.
  assert.strictEqual(GD.CONFIG.VERSION, '10.8.10', 'version bump is performed only after this source-level regression is proven');
  console.log('v10.8.9 observation firewall / Bayesian joint-world / camp certainty / coalition forecast regression passed.');
  process.exit(0);
} catch (error) {
  console.error('v10.8.9 observation firewall regression failed:', error && error.stack || error);
  process.exit(1);
}
