'use strict';
const assert = require('assert');
const GD = require('./harness')();

try {
  const room = GD.Engine.newRoom('TEAM-ROLE-13', 'host');
  const actor = { id: 'yao', role: '藥不然' };
  const partner = { id: 'lao', role: '老朝奉' };
  room.players = [actor, partner, { id: 'g1', role: '許願' }];
  room.currentRoundIdx = 1;
  room.rounds = [
    { roundNum: 1, beasts: ['鼠','牛'].map(name => ({ name })), speeches: [{ playerId: 'lao', speakerName: 'lao', text: '我是黃煙煙，這個角色說法我會維持到終局。', source: 'bot' }],
      turnLogs: { lao: { privateRoleGuess: 'pretend-secret' } }, mind: { lao: { secret: 'do-not-read' } } },
    { roundNum: 2, beasts: ['鼠','牛'].map(name => ({ name })), speeches: [], turnLogs: { lao: { secret: 'changed private log' } }, mind: { lao: { secret: 'changed mind' } } }
  ];
  const adjusted = GD.Strategy.teamRoleBluffAdjustment(room, actor, partner, 1);
  assert.strictEqual(adjusted.active, true, 'public false-role commitment should be detected');
  assert(adjusted.multiplier > 0 && adjusted.multiplier < 1, 'teammate role bluff should lower, not disable, additional role bluff chance');
  assert.strictEqual(adjusted.partnerClaim, '黃煙煙');
  assert.strictEqual(adjusted.partnerTrueRole, '老朝奉');
  const first = JSON.stringify(adjusted);
  room.rounds[0].turnLogs.lao.privateRoleGuess = 'another secret';
  room.rounds[0].mind.lao.secret = 'another mind';
  room.rounds[1].turnLogs.lao.secret = 'third secret';
  room.rounds[1].mind.lao.secret = 'third mind';
  assert.strictEqual(JSON.stringify(GD.Strategy.teamRoleBluffAdjustment(room, actor, partner, 1)), first,
    'role coordination must depend on public claim only, not partner private mind or turn log');

  const noClaimRoom = GD.Engine.newRoom('TEAM-ROLE-NONE', 'host');
  noClaimRoom.players = [actor, partner]; noClaimRoom.currentRoundIdx = 0;
  noClaimRoom.rounds = [{ roundNum: 1, beasts: ['鼠','牛'].map(name => ({ name })), speeches: [], turnLogs: {}, mind: {} }];
  const noClaim = GD.Strategy.teamRoleBluffAdjustment(noClaimRoom, actor, partner, 0);
  assert.strictEqual(noClaim.multiplier, 1, 'no public false-role commitment must not suppress a teammate');

  const pool = ['黃煙煙','方震','姬雲浮','平民'];
  const choice = GD.Strategy.chooseRoleBluffRole(pool, room, actor, 1, partner);
  assert(pool.includes(choice), 'role bluff selection must remain enabled and within legal pool');

  console.log('Team role bluff regression PASS: public-only coordination, nonzero remaining bluff opportunity, no suppression without a teammate claim.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
