'use strict';
const assert = require('assert');
const GD = require('./harness')();

const players = [
  { id: 'h-ray', name: 'RAY', isBot: false, colorId: 'white' },
  { id: 'b-hanjie', name: '漢傑', isBot: true, colorId: 'orange' },
  { id: 'b-chengjun', name: '丞峻', isBot: true, colorId: 'green' },
  { id: 'b-zhu', name: '筑', isBot: true, colorId: 'blue' },
  { id: 'h-mayin', name: '馬陰久', isBot: false, colorId: 'black' },
  { id: 'h-yian', name: '歪欸恩', isBot: false, colorId: 'yellow' },
  { id: 'h-red', name: '十全大補湯', isBot: false, colorId: 'red' },
  { id: 'h-purple', name: '熊寶', isBot: false, colorId: 'purple' }
];
const room = { players, rounds: [], currentRoundIdx: 0 };
const round = {
  beasts: ['龍', '羊', '雞', '狗'].map(name => ({ name, isReal: true })),
  passOrder: ['b-hanjie', 'h-ray', 'b-chengjun', 'b-zhu', 'h-mayin', 'h-yian', 'h-red', 'h-purple'],
  speechOrder: ['b-chengjun', 'b-zhu', 'h-ray', 'b-hanjie', 'h-mayin', 'h-yian', 'h-red', 'h-purple']
};

try {
  let parsed = GD.Claims.parse('橘老朝奉！', room, round, 'h-ray');
  assert(parsed.roleClaims.some(x => x.playerId === 'b-hanjie' && x.role === '老朝奉' && x.polarity === 'claim'), 'color-first abbreviated role accusation should resolve to orange player');
  assert(parsed.accuse.some(x => x.playerId === 'b-hanjie'), 'abbreviated role accusation should be represented in accusation index');

  parsed = GD.Claims.parse('綠色【丞峻】老朝奉！', room, round, 'h-ray');
  assert(parsed.roleClaims.some(x => x.playerId === 'b-chengjun' && x.role === '老朝奉'), 'named color + role without verb should resolve');

  parsed = GD.Claims.parse('藍色很壞！', room, round, 'h-ray');
  assert(parsed.playerStances.some(x => x.targetId === 'b-zhu' && x.camp === 'evil'), 'color-only short stance should map to player colorId');

  parsed = GD.Claims.parse('龍羊雙真，有開過！', room, round, 'h-red');
  assert.deepStrictEqual(parsed.claims.filter(x => x.real).map(x => x.beast).sort(), ['羊', '龍'], 'paired beast language should yield two distinct true claims');
  assert(parsed.skillClaims.some(x => x.kind === 'used' && x.confidence === 'low'), 'skill usage assertion should be preserved as low-confidence self-report');

  parsed = GD.Claims.parse('三個電腦玩家會出1~2個壞人！', room, round, 'h-ray');
  assert(parsed.countConstraints.some(x => x.min === 1 && x.max === 2 && x.populationSize === 3), 'natural sentence with 會出 and range tilde should be read as group quantity, not seat position');

  parsed = GD.Claims.parse('三電腦出 1–2 壞！', room, round, 'h-ray');
  const count = parsed.countConstraints[0];
  assert(count && count.kind === 'count_constraint', 'three-computer count hypothesis should be parsed');
  assert.strictEqual(count.populationSize, 3);
  assert.deepStrictEqual(count.populationIds.sort(), ['b-chengjun', 'b-hanjie', 'b-zhu'].sort());
  assert.strictEqual(count.min, 1);
  assert.strictEqual(count.max, 2);
  assert.strictEqual(count.populationResolved, true);
  assert.strictEqual(parsed.candidateSets.length, 0, 'group-level count constraint must not fabricate named seat accusations');
  assert(!parsed.countConstraints.some(x => x.position || x.seatRange), '1–2 is quantity, not seat positions');

  parsed = GD.Claims.parse('我驗不到，【龍】真，【龍】假！', room, round, 'h-mayin');
  assert(parsed.unsure, 'unreadable claim should preserve uncertainty');
  assert.strictEqual(parsed.selfContradictions.length, 1, 'same-speech opposite claims should be tagged as one self-contradiction event');
  assert.strictEqual(parsed.selfContradictions[0].beast, '龍');
  assert.deepStrictEqual(parsed.selfContradictions[0].verdicts.sort(), [false, true]);

  parsed = GD.Claims.parse('我被偷襲，驗不到！', room, round, 'h-mayin');
  assert(parsed.blind, 'ambush language should retain the blind flag');
  assert(parsed.uncertaintyReasons.some(x => x.reason === 'ambush' && x.provenance === 'self_report' && x.verification === 'not_independently_verified'), 'ambush reason must remain a self-report, not an independently verified fact');
  assert(!parsed.uncertaintyReasons.some(x => x.reason === 'unspecified'), 'a specific ambush explanation should not also be stored as unspecified');

  parsed = GD.Claims.parse('【龍】被封鎖，我驗不到！', room, round, 'h-mayin');
  assert(parsed.uncertaintyReasons.some(x => x.reason === 'blocked'), 'blocked beast should be distinguished from ambush');

  parsed = GD.Claims.parse('黃煙煙本輪無法辨別真偽！', room, round, 'h-red');
  assert(parsed.uncertaintyReasons.some(x => x.reason === 'role_confusion'), 'Huang/Kido-style limited-vision round should have its own reason category');

  parsed = GD.Claims.parse('我被老朝奉擾亂，驗不到！', room, round, 'h-mayin');
  assert(parsed.uncertaintyReasons.some(x => x.reason === 'lao_disruption'), 'Lao disruption should be distinct from other unreadable causes');

  parsed = GD.Claims.parse('我驗不到！', room, round, 'h-mayin');
  assert(parsed.uncertaintyReasons.some(x => x.reason === 'unspecified'), 'unexplained unreadable result should remain unspecified');

  parsed = GD.Claims.parse('我兩票投羊！', room, round, 'h-ray');
  assert(parsed.voteCommitments.some(x => x.beast === '羊' && x.chips === 2), 'personal numeric-chip vote promise should be parsed');

  parsed = GD.Claims.parse('我在第三位掌眼，現在第二位公開發言。', room, round, 'h-ray');
  assert(parsed.positionClaims.some(x => x.kind === 'pass' && x.claimed === 3 && x.actual === 2 && x.verified === false), 'claimed inspection position must be checked against passOrder');
  assert(parsed.positionClaims.some(x => x.kind === 'speech' && x.claimed === 2 && x.actual === 3 && x.verified === false), 'claimed speaking position must be checked against speechOrder');

  console.log('Claims natural-language regression PASS: abbreviated roles, color-only stances, paired beasts, skill self-report, count constraints, contradictions, vote promises, and separate pass/speech positions.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
