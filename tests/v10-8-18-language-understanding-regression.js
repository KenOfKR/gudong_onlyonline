'use strict';
const assert = require('assert');
const GD = require('./harness')();

const beasts = ['牛', '雞', '狗', '兔'];
const room = {
  players: [
    { id: 'prev', name: '凡凡', colorId: 'red' },
    { id: 'self', name: '洪吉', colorId: 'orange' }
  ],
  rounds: []
};
const round = {
  roundNum: 2,
  beasts: beasts.map(name => ({ name })),
  speeches: [{ playerId: 'prev', text: '【雞】是真品，大家投【雞】。' }, { playerId: 'self', text: '' }]
};
room.rounds.push(round);

const examples = [
  ['hard', '我這輪會把票投給【牛】。', '牛'],
  ['hard', '我決定投【牛】。', '牛'],
  ['hard', '我投【牛】。', '牛'],
  ['hard', '我的票投【牛】。', '牛'],
  ['hard', '我先投【牛】。', '牛'],
  ['hard', '我會落票在【牛】。', '牛'],
  ['soft', '我可能投【牛】。', '牛'],
  ['soft', '我想投【牛】。', '牛'],
  ['soft', '我傾向投【牛】。', '牛'],
  ['soft', '我考慮投【牛】。', '牛'],
  ['soft', '我或許會把票押在【牛】。', '牛'],
  ['soft', '我目前偏向投【牛】。', '牛'],
  ['soft', '我這輪的主要票向會跟隨大眾投【牛】。', '牛'],
  ['soft', '我大概會落票給【牛】。', '牛'],
  ['none', '我不會投【牛】。', '牛'],
  ['none', '我不想投【牛】。', '牛'],
  ['none', '我無法盲目跟你去投【狗】。', '狗'],
  ['none', '我不能因為你這樣說就跟票投【狗】。', '狗'],
  ['none', '我拒絕號召大家投【牛】。', '牛'],
  ['none', '我反對大家投【牛】。', '牛'],
  ['none', '我引用凡凡原話：「我這輪會投【牛】。」', '牛'],
  ['none', '上一輪我決定投【牛】。', '牛'],
  ['none', '前面凡凡說他會投【牛】。', '牛'],
  ['call', '我建議大家投【牛】。', '牛'],
  ['call', '我號召大家投【牛】。', '牛'],
  ['call', '大家一起投【牛】！', '牛']
];

const failures = [];
for (const [kind, text, beast] of examples) {
  const parsed = GD.Claims.parse(text, room, round, 'self');
  const hard = parsed.voteCommitments.some(item => item.beast === beast && item.binding !== false);
  const soft = parsed.voteIntents.some(item => item.beast === beast && item.binding === false);
  const called = (parsed.callBeasts || []).includes(beast);
  const ok = kind === 'hard' ? hard && !soft
    : kind === 'soft' ? !hard && soft
      : kind === 'call' ? !hard && called
        : !hard && !soft && !called;
  if (!ok) failures.push({ kind, text, hard, soft, called, commitments: parsed.voteCommitments, intents: parsed.voteIntents });
}

const report = GD.Claims.parse('這輪我確認到的結果是【雞】真。', room, round, 'self');
assert.deepStrictEqual(report.inspectionReports.map(item => [item.round, item.beast, item.claimedReal]), [[2, '雞', true]]);
assert.deepStrictEqual(report.claims, [], 'inspection-only wording cannot be copied into ordinary truth claims');

const separateVerdicts = GD.Claims.parse('我第二輪查驗【牛】是贗品。整體來看，我仍判斷【牛】是真品。', room, round, 'self');
assert.deepStrictEqual(separateVerdicts.inspectionReports.map(item => [item.round, item.beast, item.claimedReal]), [[2, '牛', false]]);
assert(separateVerdicts.claims.some(item => item.beast === '牛' && item.real === true));

const attributed = GD.Claims.parse('紅色【凡凡】：你主張【雞】真品；你號召投【雞】。', room, round, 'self');
assert(attributed.quotedCalls.some(item => item.beast === '雞' && item.sourcePlayerIds.includes('prev')),
  'a following second-person reference must inherit the explicitly identified source');

assert.deepStrictEqual(failures, [], `semantic corpus mismatches:\n${JSON.stringify(failures, null, 2)}`);
console.log(`PASS v10.8.18 language understanding regression: ${examples.length} vote-language cases + inspection/source attribution cases`);
process.exit(0);
