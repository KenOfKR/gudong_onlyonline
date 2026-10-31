'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Tactics, Strategy } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  return room;
}

try {
  assert(Strategy && typeof Strategy.ballot === 'function', 'Strategy.ballot() must be available');
  const room = makeRoom('ABSTAIN_POLICY_REGRESSION');
  const rd = U.curRound(room);
  const bot = room.players.find(p => p.isBot);
  assert(bot, 'test needs a bot');
  bot.role = '許願';
  bot.voteBank = 2;

  const names = rd.beasts.map(b => b.name);
  const allocations = Tactics.enumerateAllocations(names, names[0], bot.voteBank);
  const spent = x => Object.values(x).reduce((n, value) => n + Number(value || 0), 0);
  assert(allocations.some(x => spent(x) === 0), 'zero-spend allocation must be available');
  assert(allocations.some(x => spent(x) > 0 && !(x[names[0]] > 0)),
    'normal ballots must be allowed to diverge from the declared anchor');

  const originalOptimize = Tactics.optimizeBallot;
  const originalLimit = Tactics.voteSpendLimit;
  try {
    Tactics.voteSpendLimit = () => 2;
    Tactics.optimizeBallot = () => ({ ballot: {}, diagnostic: { spent: 0, held: 2 } });
    const goodBallot = Strategy.ballot(bot, room);
    assert.deepStrictEqual(goodBallot, {}, 'good-side Strategy.ballot() must accept an intentional abstention');

    // Also ensure evil public-performance anchoring does not turn an intentional empty ballot into a vote.
    bot.role = '老朝奉';
    bot.voteBank = 2;
    const mind = rd.mind[bot.id];
    assert(mind, 'Strategy.plan() should have initialized a mind record');
    mind.mode = 'confess';
    mind.confess = true;
    mind.evilRolePerformance = true;
    mind.beast = names[0];
    mind.post = names.map((name, index) => ({ name, p: index === 0 ? 0.7 : 0.3 }));
    rd.speeches = [];
    const evilBallot = Strategy.ballot(bot, room);
    assert.deepStrictEqual(evilBallot, {}, 'evil public-performance finalizer must preserve a deliberate abstention');
  } finally {
    Tactics.optimizeBallot = originalOptimize;
    Tactics.voteSpendLimit = originalLimit;
  }

  console.log('棄票策略測試通過：零票候選、非 anchor 票型、好人棄票與壞人公開表演棄票皆正確。');
} catch (error) {
  console.error('棄票策略測試失敗：', error && error.stack || error);
  process.exitCode = 1;
}
