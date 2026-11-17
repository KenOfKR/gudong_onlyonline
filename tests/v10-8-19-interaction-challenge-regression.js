'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const originalRandom = Math.random;
Math.random = () => 0;

try {
  const players = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`, name: `玩家${i}`, isBot: true, botId: `bot${i}`, role: i === 3 ? '許願' : '平民',
    seatIndex: i, colorId: GD.SEAL_COLORS[i].id
  }));
  const bot = players[3];
  const previousRound = { roundNum: 1, speeches: [], speechOrder: [], passOrder: [], votes: {}, voteResults: null };
  const currentRound = {
    roundNum: 2, speeches: [], speechOrder: players.map(p => p.id), passOrder: players.map(p => p.id),
    beasts: [{ name: '虎' }, { name: '牛' }, { name: '馬' }, { name: '羊' }], votes: {}, voteResults: null
  };
  const room = { roomId: 'challenge-test', currentRoundIdx: 1, players, rounds: [previousRound, currentRound] };
  const profiles = Object.fromEntries(players.map(p => [p.id, {
    player: p, evil: 15, ally: 0, knownGood: false, knownEvil: false, knownCamp: null,
    confessed: false, conflicts: [], voteDissonance: [], commitments: [], probs: {}
  }]));
  const A = {
    ctx: { bot, room, t: 1, rd: currentRound, pass: currentRound.passOrder, isGood: true,
      genes: { assertiveness: 1 }, partner: null },
    prof: profiles, fakeVoters: [], inferredPartners: []
  };

  // Direct inspection/public-claim conflict is supported for ordinary good roles.
  bot.role = '平民';
  profiles.p1.conflicts.push({ speakerId: 'p1', beast: '虎', claim: true, saw: false, round: 1, speakerPos: 2 });
  let challenge = GD.Strategy.selectInteractionChallenge(bot, room, A);
  assert(challenge, 'a direct inspection conflict should produce a question');
  assert.strictEqual(challenge.targetId, 'p1');
  assert.strictEqual(challenge.kind, 'inspection_conflict');

  // Xu must not turn her private double-inspection trail into a public question.
  bot.role = '許願';
  assert.strictEqual(GD.Strategy.selectInteractionChallenge(bot, room, A), null,
    'Xu private inspection conflicts must not leak through public questioning');
  bot.role = '平民';

  // A prior question to p1 must not block the whole round; another evidence source/target remains eligible.
  currentRound.speeches.push({ playerId: 'p0', text: '請紅色【玩家1】說明一下。', p: { asked: ['p1'] } });
  profiles.p2.voteDissonance.push({ round: 1, calledBeasts: ['牛'], investedBeast: '虎', investedChips: 3, callVotes: 0 });
  challenge = GD.Strategy.selectInteractionChallenge(bot, room, A);
  assert(challenge, 'a different target should still be questioned in the same round');
  assert.strictEqual(challenge.targetId, 'p2');
  assert.strictEqual(challenge.kind, 'vote_dissonance');

  // Three distinct people already questioned in this round reaches the explicit cap.
  currentRound.speeches = [
    { playerId: 'p0', text: '請紅色【玩家1】說明。', p: { asked: ['p1'] } },
    { playerId: 'p1', text: '請橘色【玩家2】說明。', p: { asked: ['p2'] } },
    { playerId: 'p2', text: '請黃色【玩家4】說明。', p: { asked: ['p4'] } }
  ];
  assert.strictEqual(GD.Strategy.selectInteractionChallenge(bot, room, A), null,
    'no more than three distinct players should be questioned in one round');

  console.log('v10.8.19 multi-source interaction challenge regression: PASS');
  process.exit(0);
} finally {
  Math.random = originalRandom;
}
