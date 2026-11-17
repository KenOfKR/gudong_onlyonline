'use strict';
const assert = require('assert');
const GD = require('./harness')();

function makeRoom(speechesByRound) {
  const room = GD.Engine.newRoom('V10814_ROLE_PERSIST', 'host');
  const bot = { id: 'evil-a', name: '測試壞人', role: '老朝奉', isBot: true, botId: 'bot_001' };
  room.players = [bot, { id: 'g1', name: '好人甲', role: '許願', isBot: true, botId: 'bot_002' }];
  room.rounds = speechesByRound.map((speeches, index) => ({
    roundNum: index + 1, beasts: [{ name: '虎' }, { name: '羊' }], speeches, turnLogs: {}, mind: {}
  }));
  room.currentRoundIdx = Math.max(0, room.rounds.length - 1);
  return { room, bot };
}

try {
  const { room, bot } = makeRoom([
    [{ playerId: 'evil-a', speakerName: '測試壞人', text: '我是黃煙煙，這個身分我會維持到終局。' }],
    []
  ]);
  const current = GD.Strategy.committedFalseRoleBluff(room, bot, 1);
  assert(current, 'a false role publicly claimed in the immediately preceding round must persist');
  assert.strictEqual(current.role, '黃煙煙');
  assert.strictEqual(current.kind, 'false_claim');
  assert.strictEqual(current.persist, true);
  assert.strictEqual(current.continued, true, 'the previous-round role commitment is already continuing in the current round');
  assert.strictEqual(current.commitment, 'public-role-persistence');
  assert.strictEqual(GD.Strategy.committedFalseRoleBluff(room, bot, 0), null,
    'a claim in the currently planned round must not be treated as a prior-round commitment');

  const switched = makeRoom([
    [{ playerId: bot.id, speakerName: bot.name, text: '我是黃煙煙。' }],
    [{ playerId: bot.id, speakerName: bot.name, text: '我改口，之前自稱黃煙煙，現在我是姬雲浮。' }]
  ]);
  const switchResult = GD.Strategy.committedFalseRoleBluff(switched.room, switched.bot, 2);
  assert(switchResult, 'an explicit role switch should remain representable');
  assert.strictEqual(switchResult.role, '姬雲浮', 'only an explicit explained switch may replace the original public role claim');

  const unexplained = makeRoom([
    [{ playerId: bot.id, speakerName: bot.name, text: '我是黃煙煙。' }],
    [{ playerId: bot.id, speakerName: bot.name, text: '我是姬雲浮。' }]
  ]);
  const unchanged = GD.Strategy.committedFalseRoleBluff(unexplained.room, unexplained.bot, 2);
  assert.strictEqual(unchanged.role, '黃煙煙', 'an unexplained new role claim must not silently overwrite the first public commitment');

  console.log('PASS v10.8.14 role persistence regression: preceding-round continuation, same-round boundary, explicit switch, and unexplained-switch protection.');
} catch (error) {
  console.error('FAIL v10.8.14 role persistence regression:', error.stack || error);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
