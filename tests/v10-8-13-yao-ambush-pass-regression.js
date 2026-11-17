'use strict';
const assert = require('assert');
const GD = require('./harness')();

function makeRoom() {
  const room = GD.Engine.newRoom('YAO-PASS-13', 'host');
  const roles = ['鄭國渠','許願','方震','黃煙煙','姬雲浮','木戶加奈','老朝奉','藥不然'];
  const ids = ['human','xu','fang','huang','ji','victim','lao','yao'];
  room.players = ids.map((id, i) => ({ id, name: id, role: roles[i], isBot: id !== 'human', botId: id,
    colorId: GD.SEAL_COLORS[i].id, seatIndex: i, voteBank: 2 }));
  room.gameId = 'yao-pass-game'; room.status = 'discussion'; room.currentRoundIdx = 1;
  const speeches = [
    { playerId: 'yao', speakerName: 'yao', source: 'bot', text: '我目前主張【馬】是真品，請把這個公開立場和後續票型一起核對。' },
    { playerId: 'lao', speakerName: 'lao', source: 'bot', text: '我認為【馬】是真品，並建議大家投【馬】。' },
    { playerId: 'victim', speakerName: 'victim', source: 'bot', text: '我會核對白色【yao】的說法，但目前不直接指認。' }
  ];
  const rd = { roundNum: 2, beasts: ['牛','猴','狗','兔'].map(name => ({ name })), passOrder: ['xu','yao'],
    speechOrder: ['yao','lao','victim'], speeches, turnLogs: {}, votes: {}, voteResults: null, mind: {}, laoActive: true };
  room.rounds = [{ roundNum: 1, beasts: ['馬','羊'].map(name => ({ name })), passOrder: ['xu','yao','lao'],
    speeches: [
      { playerId: 'yao', speakerName: 'yao', source: 'bot', text: '我認為【馬】是真品，建議這輪投【馬】。' },
      { playerId: 'lao', speakerName: 'lao', source: 'bot', text: '我認為【馬】是真品，大家可以投【馬】。' }
    ], turnLogs: {}, mind: {}, voteResults: { chips: { '馬': [], '羊': [] } } }, rd];
  const bot = room.players.find(p => p.id === 'yao');
  const partner = room.players.find(p => p.id === 'lao');
  const left = room.players.filter(p => !rd.passOrder.includes(p.id));
  const prof = {};
  room.players.forEach(p => { prof[p.id] = { evil: p.id === 'lao' || p.id === 'yao' ? 100 : 15,
    ally: p.id === 'lao' ? 100 : 0, probs: { '姬雲浮': p.id === 'ji' ? 100 : 5 } }; });
  const A = { ctx: { rd, t: 1, log: { ambushIds: ['victim'], ambushTargetId: 'victim' }, partner }, prof };
  return { room, bot, partner, left, A, rd };
}

try {
  const x = makeRoom();
  const audit = GD.Strategy.evaluateYaoAmbushPass(x.bot, x.room, x.A, x.left);
  assert(audit && audit.candidates.length === x.left.length, 'planner must score every legal remaining recipient, including the victim');
  const victim = audit.candidates.find(row => row.candidateId === 'victim');
  const lao = audit.candidates.find(row => row.candidateId === 'lao');
  assert(victim && Number.isFinite(victim.exposure.estimate), 'direct victim route must have a bounded exposure estimate');
  assert(lao && lao.isPartner && lao.laoSkillValue > 0, 'passing to Lao must account for early disruption value');
  assert(lao.adjacencyCamouflage >= 0 && lao.adjacencyLinkRisk > 0, 'partner adjacency must model both camouflage and public-link risk');
  assert.strictEqual(audit.repeatPassPairCount, 1, 'a repeated Yao-to-Lao handoff must be recognized from the public pass order');
  assert(audit.publicVoteBehavior.callMismatchCount >= 1, 'public call-versus-ballot mismatch must enter the exposure audit without being treated as illegal');
  assert(audit.limitations.some(s => s.includes('不是經實戰校準')), 'exposure estimates must clearly state they are not calibrated probabilities');

  // A target's private mind/turn log is never part of the acting Yao's counterfactual.
  const before = JSON.stringify(audit);
  x.rd.mind.victim = { secret: 'pretend-target-knows-Yao' };
  x.rd.turnLogs.victim = { secret: 'pretend-private-inspection' };
  const after = JSON.stringify(GD.Strategy.evaluateYaoAmbushPass(x.bot, x.room, x.A, x.left));
  assert.strictEqual(after, before, 'changing victim private mind/log must not change Yao pass planning');

  // When victim is the only legal recipient, the evaluator keeps direct pass legal.
  const directOnly = GD.Strategy.evaluateYaoAmbushPass(x.bot, x.room, x.A, [x.room.players.find(p => p.id === 'victim')]);
  assert.strictEqual(directOnly.chosenId, 'victim', 'direct pass must not be hard-coded as forbidden');

  // The same visible inputs must produce the same result; private profile mutations are not read.
  const repeat = GD.Strategy.evaluateYaoAmbushPass(x.bot, x.room, x.A, x.left);
  assert.strictEqual(JSON.stringify(repeat), JSON.stringify(GD.Strategy.evaluateYaoAmbushPass(x.bot, x.room, x.A, x.left)), 'pass decision must be deterministic');

  console.log('Yao ambush pass regression PASS: candidate comparison, Lao skill/adjacency tradeoff, direct-pass legality, estimate caveat, public/private information boundary and deterministic output.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
