'use strict';
const assert = require('assert');
const GD = require('./harness')();

const room = { players: [], rounds: [] };
const round = { beasts: ['牛', '羊', '鼠', '狗'].map(name => ({ name })) };
for (const text of [
  '我無法盲目跟你去投【狗】。',
  '我不會盲目跟著你投【狗】。',
  '我不能因為你這樣說就跟票投【狗】。'
]) {
  const parsed = GD.Claims.parse(text, room, round, 'speaker');
  assert.deepStrictEqual(parsed.voteCommitments, [], `${text} must not become a hard commitment`);
  assert.strictEqual(parsed.voteCommitment, null);
  assert(!parsed.callBeasts.includes('狗'), `${text} must not become a positive public call`);
}
for (const text of ['我這輪會把票投給【牛】。', '我決定投【牛】。']) {
  const parsed = GD.Claims.parse(text, room, round, 'speaker');
  assert.deepStrictEqual(parsed.voteCommitments.map(item => item.beast), ['牛']);
}

const sourceRoom = {
  players: [
    { id: 'xu', name: '凡凡', colorId: 'red' },
    { id: 'fang', name: '洪吉', colorId: 'orange' }
  ],
  rounds: []
};
const sourceRound = {
  roundNum: 1,
  beasts: ['雞', '牛', '龍', '兔'].map(name => ({ name })),
  speeches: [{ playerId: 'xu', text: '【雞】真，投【雞】。' }, { playerId: 'fang', text: '' }]
};
sourceRoom.rounds.push(sourceRound);

const rawInspection = GD.Claims.parse('這輪我確認到的結果是【雞】真。', sourceRoom, sourceRound, 'fang');
assert.deepStrictEqual(rawInspection.inspectionReports.map(report => [report.round, report.beast, report.claimedReal]), [[1, '雞', true]],
  'first-person current-round inspection language must become a public self-report');
assert.deepStrictEqual(rawInspection.claims, [], 'inspection-only wording must not be duplicated as a general truth verdict');

const splitInspection = GD.Claims.parse('我第二輪查驗【牛】是贗品。整體來看，我仍判斷【牛】是真品。',
  sourceRoom, { ...sourceRound, roundNum: 2, beasts: sourceRound.beasts }, 'fang');
assert.deepStrictEqual(splitInspection.inspectionReports.map(report => [report.round, report.beast, report.claimedReal]), [[2, '牛', false]]);
assert(splitInspection.claims.some(item => item.beast === '牛' && item.real),
  'an explicitly separate whole-picture verdict must remain independent of the inspection report');

const voteDirection = GD.Claims.parse('我這輪的主要票向會跟隨大眾投【雞】。', sourceRoom, sourceRound, 'fang');
assert.deepStrictEqual(voteDirection.voteCommitments, [], 'a stated primary direction following the majority is not a personal hard promise');
assert(voteDirection.voteIntents.some(item => item.beast === '雞' && item.binding === false),
  'a primary vote direction must remain a soft intent');

const secondPersonQuote = GD.Claims.parse('紅色【凡凡】：你主張【雞】真品；你號召投【雞】。', sourceRoom, sourceRound, 'fang');
assert(secondPersonQuote.quotedCalls.some(item => item.beast === '雞' && item.sourcePlayerIds.includes('xu')),
  'the second-person quoted call must inherit its explicitly identified speaker');

console.log('PASS v10.8.18 semantic negation regression');
process.exit(0);
