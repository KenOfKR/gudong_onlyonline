'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine } = GD;

function makeRoom(status = 'playing', now = Date.now()) {
  const room = Engine.newRoom('AFKTEST', 'human-a');
  const specs = [
    ['human-a', '真人甲', false], ['human-b', '真人乙', false],
    ['bot-1', 'BOT1', true], ['bot-2', 'BOT2', true], ['bot-3', 'BOT3', true],
    ['bot-4', 'BOT4', true], ['bot-5', 'BOT5', true], ['bot-6', 'BOT6', true]
  ];
  specs.forEach(([id, name, isBot], index) => {
    room.players.push({ id, name, isBot, botId: isBot ? 'bot_001' : null, colorId: GD.SEAL_COLORS[index].id,
      seatIndex: index, role: isBot ? '老朝奉' : '許願', voteBank: 6,
      isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false,
      pendingImmediateAmbush: false, pendingPermanentAmbush: false, confusedRound: -1 });
  });
  room.gameId = 'afk-game';
  room.status = status;
  room.currentRoundIdx = 0;
  room.rounds = [{ roundNum: 1, beasts: ['龍', '羊', '雞', '狗'].map(name => ({ name, isReal: true })),
    passOrder: ['human-a'], turnLogs: {}, speechOrder: ['human-a', 'human-b'], speechIndex: 0,
    speeches: [], votes: {}, voteResults: null, mind: {} }];
  room.currentTurnPlayerId = status === 'playing' ? 'human-a' : null;
  room.currentSpeakerId = status === 'discussion' ? 'human-a' : null;
  room.turnStartTime = now - 121000;
  room.humanActivityAt = {};
  room.personVotes = {};
  return room;
}

try {
  const now = Date.now();
  let room = makeRoom('playing', now);
  let ctx = Engine.afkContext(room);
  assert(ctx && ctx.targetId === 'human-a', 'current human actor should be identified');
  assert.strictEqual(Engine.beginAfkRescue(room, ctx.targetId, ctx.actionKey, now), true, 'a 120s inactive human should enter shared rescue phase');
  assert.strictEqual(room.players.find(p => p.id === 'human-a').isBot, false, 'timeout warning must not immediately replace the human with a bot');
  assert.strictEqual(room.afkRescue.phase, 'waiting');
  assert.strictEqual(room.afkRescue.deadlineAt, now + 10000, 'initial helper window must be ten seconds');
  assert.strictEqual(Engine.beginAfkRescue(room, ctx.targetId, ctx.actionKey, now + 1), false, 'the same action must not create duplicate rescue windows');
  assert.strictEqual(Engine.confirmAfkRescue(room, 'human-a', 'human-a', ctx.actionKey, now + 100), false, 'the inactive target cannot confirm themselves as helper');
  assert.strictEqual(Engine.confirmAfkRescue(room, 'bot-1', 'human-a', ctx.actionKey, now + 100), false, 'a bot cannot confirm another player');
  assert.strictEqual(Engine.confirmAfkRescue(room, 'human-b', 'human-a', ctx.actionKey, now + 200), true, 'another real human can confirm the target');
  assert.strictEqual(room.afkRescue.phase, 'confirmed');
  assert.strictEqual(room.afkRescue.confirmedBy, 'human-b');
  assert.strictEqual(room.afkRescue.deadlineAt, now + 10200, 'helper confirmation grants one extra ten-second window');
  assert.strictEqual(Engine.confirmAfkRescue(room, 'human-b', 'human-a', ctx.actionKey, now + 300), false, 'multiple helpers cannot stack extensions');
  assert.strictEqual(Engine.finishAfkTakeover(room, 'human-a', ctx.actionKey, now + 10199), false, 'bot takeover must wait until the confirmed extension expires');
  assert.strictEqual(Engine.finishAfkTakeover(room, 'human-a', ctx.actionKey, now + 10201), true, 'bot takeover occurs only after the extra window expires');
  assert.strictEqual(room.players.find(p => p.seatIndex === 0).isBot, true, 'timed-out player is then replaced by a bot');
  assert.strictEqual(room.afkRescue, null, 'completed takeover clears rescue state');

  // Target returns by clicking the self-confirm button; this cancels the shared rescue and refreshes activity.
  room = makeRoom('playing', now);
  ctx = Engine.afkContext(room);
  assert(Engine.beginAfkRescue(room, ctx.targetId, ctx.actionKey, now));
  assert.strictEqual(Engine.markHumanActive(room, 'human-a', now + 1500), true, 'the target can confirm their own return');
  assert.strictEqual(room.afkRescue, null);
  assert.strictEqual(room.humanActivityAt['human-a'], now + 1500);
  assert.strictEqual(Engine.finishAfkTakeover(room, 'human-a', ctx.actionKey, now + 20000), false, 'a stale rescue callback cannot take over after the target returns');
  assert.strictEqual(room.players.find(p => p.id === 'human-a').isBot, false);

  // A changed action invalidates the old rescue token (for example, the user has already completed inspection).
  room = makeRoom('playing', now);
  ctx = Engine.afkContext(room);
  assert(Engine.beginAfkRescue(room, ctx.targetId, ctx.actionKey, now));
  room.rounds[0].turnLogs['human-a'] = { inspect: [], step: 'a', blind: false };
  assert(Engine.inspect(room, 'human-a', '龍'), 'a real game action should complete');
  assert.strictEqual(room.afkRescue, null, 'successful inspection clears rescue');
  assert.strictEqual(Engine.finishAfkTakeover(room, 'human-a', ctx.actionKey, now + 20000), false, 'old action token cannot replace an active human');

  // Voting uses per-player activity timestamps; one player's ballot must not reset another player's clock.
  room = makeRoom('voting', now);
  room.rounds[0].passOrder = room.players.map(p => p.id);
  room.rounds[0].votes = {};
  room.turnStartTime = now - 121000;
  room.rounds[0].speeches = [{ playerId: 'human-a', speakerName: '真人甲', text: '我兩票投羊！', p: GD.Claims.parse('我兩票投羊！', room, room.rounds[0], 'human-a') }];
  ctx = Engine.afkContext(room);
  assert(ctx && ctx.targetId === 'human-a');
  assert(Engine.beginAfkRescue(room, ctx.targetId, ctx.actionKey, now));
  assert.strictEqual(Engine.vote(room, 'human-b', { '龍': 1 }), true, 'another player can vote while rescue is active');
  assert.strictEqual(room.afkRescue.targetId, 'human-a', 'another player activity cannot clear the inactive target rescue');
  assert.strictEqual(Engine.vote(room, 'human-a', { '羊': 2 }), true, 'target can return by submitting their ballot');
  assert.strictEqual(room.afkRescue, null, 'target ballot clears rescue');
  const audit = room.rounds[0].voteAudit['human-a'];
  assert(audit && audit.commitments.some(item => item.beast === '羊' && item.chips === 2), 'vote audit records public personal commitments');
  assert.deepStrictEqual(audit.publicCalls, [], 'personal commitment is distinct from a group call');
  assert.strictEqual(audit.actualBallot['羊'], 2, 'actual ballot is recorded separately');
  assert.strictEqual(audit.commitmentResults[0].honored, true, 'commitment result is observational only');

  // Legal abstention remains valid and receives an audit record; no chip is forced.
  room = makeRoom('voting', now);
  room.rounds[0].votes = {};
  room.players.find(p => p.id === 'human-a').voteBank = 2;
  room.rounds[0].speeches = [{ playerId: 'human-a', speakerName: '真人甲', text: '這輪先保留籌碼。', p: GD.Claims.parse('這輪先保留籌碼。', room, room.rounds[0], 'human-a') }];
  assert.strictEqual(Engine.vote(room, 'human-a', {}), true, 'complete abstention remains a legal ballot');
  assert.strictEqual(room.rounds[0].voteAudit['human-a'].abstained, true);
  assert.strictEqual(room.rounds[0].voteAudit['human-a'].totalSpent, 0);

  // Entering a fresh simultaneous phase must reset every pending human's timer.
  room = makeRoom('discussion', now);
  room.currentRoundIdx = 0;
  room.rounds[0].speechOrder = ['human-a'];
  room.rounds[0].speechIndex = 0;
  room.currentSpeakerId = 'human-a';
  room.turnStartTime = now - 300000;
  room.humanActivityAt = { 'human-a': now - 300000, 'human-b': now - 300000 };
  assert(Engine.speak(room, 'human-a', { text: '這輪先聽大家發言。' }));
  assert.strictEqual(room.status, 'voting');
  assert(room.humanActivityAt['human-a'] >= now - 1000 && room.humanActivityAt['human-b'] >= now - 1000,
    'voting stage entry must reset all pending human timers');

  // Another human's final identification vote must not erase the AFK target's rescue.
  room = makeRoom('person_voting', now);
  room.personVotes = {};
  room.turnStartTime = now - 121000;
  ctx = Engine.afkContext(room);
  assert(ctx && ctx.targetId === 'human-a');
  assert(Engine.beginAfkRescue(room, ctx.targetId, ctx.actionKey, now));
  assert.strictEqual(Engine.personVote(room, 'human-b', 'bot-1'), true);
  assert.strictEqual(room.afkRescue.targetId, 'human-a', "another person final vote must not clear the target rescue");
  assert.strictEqual(Engine.personVote(room, 'human-a', 'bot-1'), true);
  assert.strictEqual(room.afkRescue, null, 'the target own final vote clears their rescue');

  room = makeRoom('voting', now);
  room.rounds.push({ ...room.rounds[0], roundNum: 2, votes: {}, voteResults: null, passOrder: [], turnLogs: {} });
  room.rounds.push({ ...room.rounds[0], roundNum: 3, votes: {}, voteResults: { rank1: {}, rank2: {} }, passOrder: [], turnLogs: {} });
  room.currentRoundIdx = 2;
  room.personVotes = {};
  room.turnStartTime = now - 121000;
  room.humanActivityAt = { 'human-a': now - 300000, 'human-b': now - 300000 };
  assert(Engine.advance(room), 'the final round should enter person_voting');
  assert.strictEqual(room.status, 'person_voting');
  assert(room.humanActivityAt['human-a'] >= now - 1000 && room.humanActivityAt['human-b'] >= now - 1000,
    'person_voting stage entry must reset all pending human timers');

  console.log('Human AFK rescue regression PASS: shared timeout, human-only helper, single extension, self-return, stale-token safety, per-player phase clocks, rescue preservation, and legal abstention audit.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
