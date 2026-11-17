'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Rules, Tactics } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'observer');
  Engine.addPlayer(room, { id: 'observer', name: '觀察員' });
  Engine.fillBots(room);
  assert(Engine.start(room));
  return room;
}

try {
  const names = ['蛇', '馬', '猴', '豬'];
  const mean = { 蛇: 7, 馬: 8, 猴: 7, 豬: 6 };
  const zero = { 蛇: 0, 馬: 0, 猴: 0, 豬: 0 };
  const pTop = Tactics.probabilitiesTopTwo(names, mean, zero);
  assert.strictEqual(pTop.馬, 1, 'the top vote total must be rank 1');
  assert.strictEqual(pTop.蛇, 1, '生肖-order tie-break must place Snake above Monkey');
  assert.strictEqual(pTop.猴, 0, 'Monkey must lose the deterministic 7-vote tie to Snake');
  assert.strictEqual(pTop.豬, 0);

  const room = makeRoom('V10_8_12_TIE');
  const rd = U.curRound(room);
  rd.beasts = names.map((name, index) => ({ name, isReal: index !== 0 && index !== 3 }));
  const players = room.players;
  const ballots = [
    [players[0].id, { 馬: 1, 蛇: 1 }],
    [players[1].id, { 豬: 3, 蛇: 2 }],
    [players[2].id, { 豬: 2, 蛇: 2 }],
    [players[3].id, { 蛇: 2, 馬: 1, 豬: 1 }],
    [players[4].id, { 猴: 5 }],
    [players[5].id, { 馬: 2 }],
    [players[6].id, { 猴: 2 }],
    [players[7].id, { 馬: 4 }]
  ];
  rd.votes = Object.fromEntries(ballots);
  const result = Rules.tally(room, rd);
  assert.deepStrictEqual([result.rank1.name, result.rank1.votes], ['馬', 8]);
  assert.deepStrictEqual([result.rank2.name, result.rank2.votes], ['蛇', 7]);
  assert.strictEqual(result.rank2.isReal, false, 'the 0947 replay case should preserve its exact tie-break outcome');

  // Forecast must absorb ballots already submitted and update when a new ballot arrives.
  rd.votes = { [players[0].id]: { 蛇: 3 } };
  const observer = players.find(p => p.isBot);
  assert(observer);
  const first = Tactics.forecastVotes(room, observer.id);
  assert.strictEqual(first.observedVotes.蛇, 3);
  assert.strictEqual(first.observedTotalVotes, 3);
  rd.votes[players[1].id] = { 猴: 2 };
  const second = Tactics.forecastVotes(room, observer.id);
  assert.strictEqual(second.observedVotes.蛇, 3);
  assert.strictEqual(second.observedVotes.猴, 2);
  assert.strictEqual(second.observedTotalVotes, 5);
  assert(second.expectedVotes.蛇 >= 3 && second.expectedVotes.猴 >= 2,
    'current observed ballots must remain in expected totals after forecast refresh');

  // Public statement and private ballot intentionally remain independent.
  rd.speeches = [{ playerId: players[0].id, speakerName: players[0].name,
    text: '大家可以考慮投【蛇】。', p: { callBeast: '蛇', callBeasts: ['蛇'], claims: [] } }];
  rd.votes = { [players[0].id]: { 猴: 2 } };
  const split = Tactics.forecastVotes(room, observer.id);
  assert.strictEqual(split.observedVotes.猴, 2);
  assert.strictEqual(split.callSupport.蛇, 1);
  assert.strictEqual(split.observedVotes.蛇, 0);

  console.log('Forecast/tie regression PASS: exact zodiac tie-break, 0947 8/7/7 case, observed ballot refresh, and speech/ballot independence.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
