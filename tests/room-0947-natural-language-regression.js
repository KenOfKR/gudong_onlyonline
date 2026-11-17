'use strict';
const assert = require('assert');
const GD = require('./harness')();

try {
  // Room 0947 actual roster: four BOTs, despite the speaker's phrase referring to a group of three computers.
  const players = [
    { id: 'han', name: '漢傑', isBot: true, colorId: 'orange' },
    { id: 'ray', name: 'RAY', isBot: false, colorId: 'white' },
    { id: 'cheng', name: '丞峻', isBot: true, colorId: 'green' },
    { id: 'zhu', name: '筑', isBot: true, colorId: 'blue' },
    { id: 'yian', name: '歪欸恩', isBot: false, colorId: 'yellow' },
    { id: 'mayin', name: '馬陰久', isBot: false, colorId: 'black' },
    { id: 'fang', name: '熊寶', isBot: true, colorId: 'purple' },
    { id: 'red', name: '十全大補湯', isBot: false, colorId: 'red' }
  ];
  const room = { players, rounds: [], currentRoundIdx: 0 };
  const rd = { beasts: ['龍','羊','雞','狗'].map(name => ({ name, isReal: true })),
    passOrder: ['han','ray','cheng','zhu','yian','mayin','fang','red'],
    speechOrder: ['cheng','zhu','ray','han','mayin','yian','red','fang'] };
  room.rounds = [rd];

  let p = GD.Claims.parse('橘老朝奉！', room, rd, 'ray');
  assert(p.roleClaims.some(x => x.playerId === 'han' && x.role === '老朝奉'), '0947 orange role call should map to HanJie');

  p = GD.Claims.parse('藍色很壞！', room, rd, 'ray');
  assert(p.playerStances.some(x => x.targetId === 'zhu' && x.camp === 'evil'), '0947 color-only accusation should map to Zhu');

  p = GD.Claims.parse('龍羊雙真，有開過！', room, rd, 'red');
  assert.deepStrictEqual(p.claims.filter(x => x.real).map(x => x.beast).sort(), ['羊','龍']);
  assert(p.skillClaims.some(x => x.kind === 'used' && x.confidence === 'low'));

  p = GD.Claims.parse('三電腦出 1–2 壞！', room, rd, 'ray');
  assert.strictEqual(p.countConstraints[0].populationSize, 3);
  assert.strictEqual(p.countConstraints[0].min, 1);
  assert.strictEqual(p.countConstraints[0].max, 2);
  assert.strictEqual(p.countConstraints[0].populationResolved, false,
    'with four actual bots, the phrase must remain unresolved instead of inventing which three are meant');
  assert.strictEqual(p.candidateSets.length, 0, 'count prediction must not become position 1 or 2 or named accusations');
  assert.strictEqual(p.positionClaims.length, 0, 'the numeric range is not a player position statement');

  p = GD.Claims.parse('我驗不到，【龍】真，【龍】假！', room, rd, 'mayin');
  assert.strictEqual(p.selfContradictions.length, 1);
  assert(p.selfContradictions[0].verdicts.includes(true) && p.selfContradictions[0].verdicts.includes(false));

  p = GD.Claims.parse('我兩票投羊！', room, rd, 'ray');
  assert(p.voteCommitments.some(x => x.beast === '羊' && x.chips === 2));

  p = GD.Claims.parse('藍色【筑】橘色【漢傑】之中有老朝奉！', room, rd, 'yian');
  assert(p.candidateSets.some(x => x.role === '老朝奉' && x.relation === 'one_of' &&
    x.candidateIds.includes('zhu') && x.candidateIds.includes('han')),
    'the successful two-person Lao candidate-set parsing in 0947 must stay intact');

  console.log('Room 0947 language regression PASS: role/color shorthand, paired beast claims, unresolved 3-computer count group, self-contradiction, vote promise, and two-person candidate set.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
