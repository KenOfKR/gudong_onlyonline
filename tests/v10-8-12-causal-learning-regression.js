'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, U, Learning, Claims } = GD;

try {
  const room = Engine.newRoom('CAUSAL_LEARNING_V10_8_12', 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room));
  // 固定真人角色，避免隨機抽到老朝奉後，測試卻仍要求 hitLao=false。
  const human = room.players.find(p => p.id === 'human');
  assert(human);
  human.role = '姬雲浮';
  const bot = room.players.find(p => p.isBot && p.role !== '方震');
  assert(bot);
  const rd = U.curRound(room);
  const beast1 = rd.beasts[0].name;
  const beast2 = rd.beasts[1].name;
  const speechText = `我認為【${beast1}】是真品，我公開承諾投【${beast1}】。`;
  const parsed = Claims.parse(speechText, room, rd, bot.id);
  rd.speeches.push({ playerId: bot.id, speakerName: bot.name, source: 'bot', text: speechText, p: parsed });
  rd.votes[bot.id] = { [beast2]: 2 };
  rd.voteAudit = rd.voteAudit || {};
  rd.voteAudit[bot.id] = {
    publicCalls: [beast1],
    commitments: [{ beast: beast1, chips: 1 }],
    commitmentResults: [{ beast: beast1, honored: false, actualChips: 0 }],
    actualBallot: { [beast2]: 2 }, totalSpent: 2, abstained: false
  };
  rd.mind = rd.mind || {};
  rd.mind[bot.id] = {
    voteForecast: { round: 1, observedVotes: { [beast2]: 2 } },
    ballotModel: { spent: 2, target: beast2 },
    scoreProjection: { expectedSavedReal: 1.25 },
    claimEvidence: [{ playerId: 'human', beast: beast1, real: true, type: 'self-reported-direct', weight: 0.55, passIndex: 2, speechIndex: 1 }],
    suspects: [{ id: 'human', evil: 3 }]
  };
  rd.voteResults = {
    rank1: { name: beast2, votes: 8, isReal: false, hidden: true },
    rank2: { name: beast1, votes: 7, isReal: true, hidden: false }
  };
  room.personVotes = { [bot.id]: 'human' };
  const lessons = Learning.buildCausalLessons(room, bot);
  assert.strictEqual(lessons.rounds.length, room.rounds.length);
  const r1 = lessons.rounds[0];
  assert.deepStrictEqual(r1.decision.actualBallot, { [beast2]: 2 });
  assert.strictEqual(r1.decision.declaredBeasts[0], beast1);
  assert.strictEqual(r1.decision.voteCommitments[0].beast, beast1);
  assert.strictEqual(r1.commitmentAudit.commitmentResults[0].honored, false);
  assert.strictEqual(r1.forecast.ballotModel.spent, 2);
  assert.strictEqual(r1.outcome.selectedTopTwo[0].beast, beast2);
  assert(r1.evidenceBeforeDecision.some(item => item.source === 'self-reported-direct'));
  assert.strictEqual(lessons.finalDecision.targetId, 'human');
  assert.strictEqual(lessons.finalDecision.hitLao, false, 'do not label a human vote as a Lao hit');

  console.log('Causal learning regression PASS: speech/claim attribution, promise-vs-ballot gap, forecast, evidence, ranking outcome, and final target provenance.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
