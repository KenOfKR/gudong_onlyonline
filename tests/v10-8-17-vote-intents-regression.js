'use strict';
const assert = require('assert');
const GD = require('./harness')();

const room = { players: [], rounds: [] };
const round = { beasts: ['牛', '羊', '鼠', '狗'].map(name => ({ name })) };
const softExamples = ['我可能投【牛】', '我想投【牛】', '我傾向投【牛】', '我考慮投【牛】'];
for (const text of softExamples) {
  const parsed = GD.Claims.parse(text, room, round, 'speaker');
  assert.deepStrictEqual(parsed.voteCommitments, [], `${text} must not create a hard commitment`);
  assert.strictEqual(parsed.voteCommitment, null, `${text} must not populate the hard-commitment compatibility field`);
  assert.strictEqual(parsed.voteCommitmentBinding, false);
  assert(parsed.voteIntents.some(item => item.beast === '牛' && item.binding === false), `${text} should remain a soft intent`);
  assert.strictEqual(parsed.voteIntentBeast, '牛');
}

for (const text of ['我這輪會把票投給【牛】', '我決定投【牛】']) {
  const parsed = GD.Claims.parse(text, room, round, 'speaker');
  assert.deepStrictEqual(parsed.voteCommitments.map(item => item.beast), ['牛'], `${text} should be a hard commitment`);
  assert.strictEqual(parsed.voteCommitment, '牛');
  assert.strictEqual(parsed.voteCommitmentBinding, true);
  assert.deepStrictEqual(parsed.voteIntents, [], 'a hard commitment must not be copied into voteIntents');
}

const nonSelfOrNonCurrent = [
  '我不會投【牛】',
  '我無法盲目跟你去投【牛】',
  '我不會盲目跟著你投【牛】',
  '我引用前手原話：「我這輪會投【牛】」',
  '前一輪我決定投【牛】'
];
for (const text of nonSelfOrNonCurrent) {
  const parsed = GD.Claims.parse(text, room, round, 'speaker');
  assert.deepStrictEqual(parsed.voteCommitments, [], `${text} must not create a personal hard commitment`);
  assert.strictEqual(parsed.voteCommitment, null);
}

for (const text of ['我傾向不投【牛】', '我可能不投【牛】']) {
  const parsed = GD.Claims.parse(text, room, round, 'speaker');
  assert.deepStrictEqual(parsed.voteCommitments, [], `${text} must not create a hard commitment`);
  assert(!parsed.voteIntents.some(item => item.beast === '牛'), `${text} is an intention to avoid voting, not to vote for 牛`);
}

console.log('PASS v10.8.17 vote intent regression: tentative language stays soft; only explicit current first-person promises bind; negated, quoted, and historical statements do not.');
process.exit(0);
