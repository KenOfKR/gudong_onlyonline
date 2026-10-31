'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Tactics } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  return room;
}

try {
  const room = makeRoom('PERSONALIZED_VOTE_POLICY');
  const rd = U.curRound(room);
  const bot = room.players.find(p => p.isBot);
  assert(bot, 'test needs a bot');
  bot.role = '許願';
  bot.voteBank = 2;
  const names = rd.beasts.map(beast => beast.name);
  const anchor = names[0];
  const post = names.map(name => ({ name, pReal: name === anchor ? 0.97 : 0.35 }));
  const mind = { beast: anchor, post };
  const cautious = { skepticism: 0.95, deception: 0.05, camouflage: 0.05, assertiveness: 0.05, conformity: 0.05 };
  const assertive = { skepticism: 0.05, deception: 0.95, camouflage: 0.95, assertiveness: 0.95, conformity: 0.95 };

  bot.genes = cautious;
  const cautiousLimit = Tactics.voteSpendLimit(room, bot, mind);
  const cautiousModel = Tactics.optimizeBallot(room, bot, mind, cautiousLimit);
  bot.genes = assertive;
  const assertiveLimit = Tactics.voteSpendLimit(room, bot, mind);
  const assertiveModel = Tactics.optimizeBallot(room, bot, mind, assertiveLimit);

  assert(cautiousLimit >= 0 && cautiousLimit <= bot.voteBank, 'cautious spend cap must stay inside the vote bank');
  assert.strictEqual(assertiveLimit, 2, 'high-assertiveness profile should be allowed to use both first-round chips in this fixture');
  for (const [label, model, limit] of [['cautious', cautiousModel, cautiousLimit], ['assertive', assertiveModel, assertiveLimit]]) {
    assert(model && model.ballot && model.diagnostic, label + ' optimizer must return a ballot and diagnostics');
    const actualSpent = Object.values(model.ballot).reduce((n, value) => n + Number(value || 0), 0);
    assert(actualSpent >= 0 && actualSpent <= limit, label + ' ballot must be between zero and its cap');
    assert.strictEqual(model.diagnostic.spent, actualSpent, label + ' spent diagnostic must match ballot');
    assert.strictEqual(model.diagnostic.held, bot.voteBank - actualSpent, label + ' held diagnostic must match remaining bank');
  }
  assert.notStrictEqual(cautiousModel.diagnostic.futureChipValue, assertiveModel.diagnostic.futureChipValue,
    'different personalities should have different future chip opportunity costs');

  const allocations = Tactics.enumerateAllocations(names, anchor, 2);
  const spent = allocation => Object.values(allocation).reduce((n, value) => n + Number(value || 0), 0);
  assert(allocations.some(allocation => spent(allocation) === 0), 'the optimizer candidate set must include complete abstention');
  assert(allocations.some(allocation => spent(allocation) > 0 && !(allocation[anchor] > 0)),
    'ordinary allocation candidates must allow voting away from the public anchor');

  const round2 = Engine.drawRound(room, 2);
  room.rounds.push(round2);
  room.currentRoundIdx = 1;
  bot.voteBank = 4;
  bot.genes = cautious;
  const round2Limit = Tactics.voteSpendLimit(room, bot, {
    beast: round2.beasts[0].name,
    post: round2.beasts.map(b => ({ name: b.name, pReal: b.name === round2.beasts[0].name ? 0.97 : 0.35 }))
  });
  assert(round2Limit >= 0 && round2Limit <= 4, 'round-two spend cap must stay within the bank');

  const round3 = Engine.drawRound(room, 3);
  room.rounds.push(round3);
  room.currentRoundIdx = 2;
  bot.voteBank = 5;
  const round3Limit = Tactics.voteSpendLimit(room, bot, {
    beast: round3.beasts[0].name,
    post: round3.beasts.map(b => ({ name: b.name, pReal: 0.5 }))
  });
  assert.strictEqual(round3Limit, 5, 'last round should not reserve chips for a future round');

  console.log('投票策略測試通過：人格化上限、零票候選、非 anchor 分配、籌碼帳目及末輪投入皆正確。');
} catch (error) {
  console.error('投票策略測試失敗：', error && error.stack || error);
  process.exit(1);
}
