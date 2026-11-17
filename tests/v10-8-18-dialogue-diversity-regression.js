'use strict';
const assert = require('assert');
const GD = require('./harness')();

const repeatedA = '你主張【牛】贗品；我會自己核對，不會只因這句話就跟票。我這輪建議投【牛】；若分到別處，再看票差和哪兩尊更需要進前二。';
const repeatedB = '你主張【雞】贗品；我會自己核對，不會只因這句話就跟票。我這輪建議投【雞】；若分到別處，再看票差和哪兩尊更需要進前二。';
const distinct = '這票我先給【牛】。前面的人沒提到傳牌順序，開票後再看是不是有人刻意帶方向。';

assert(GD.Speech.dialogueSimilarity(repeatedA, repeatedB) >= 0.52,
  'tag/name-swapped repeated dialogue must be detected as similar');
assert(GD.Speech.dialogueSimilarity(repeatedA, distinct) < 0.52,
  'different conversational form and reasoning should remain available');

const room = {
  currentRoundIdx: 1,
  players: [
    { id: 'ai-a', isBot: true },
    { id: 'ai-b', isBot: true },
    { id: 'human', isBot: false }
  ],
  rounds: [
    { speeches: [{ playerId: 'ai-a', text: repeatedA }] },
    { speeches: [{ playerId: 'human', text: repeatedB }] }
  ]
};
const match = GD.Speech.similarBotSpeech(repeatedB, { id: 'ai-b' }, room);
assert(match && match.speech.playerId === 'ai-a', 'same-game bot speech history must be checked across rounds');
assert.strictEqual(GD.Speech.similarBotSpeech(distinct, { id: 'ai-b' }, room), null,
  'a matching human utterance must not count as a computer-player duplicate');
const crowdedRoom = {
  ...room,
  rounds: [{ speeches: [{ playerId: 'ai-a', text: '你指出【牛】真品；我先不急著跟票，還要看其他人的說法。' }] }],
  currentRoundIdx: 0
};
const uniqueLine = GD.Speech.chooseDistinctLine([
  '你指出【雞】真品；我先不急著跟票，還要看其他人的說法。',
  '這張票我會投【雞】，因為目前的票差還可能改變前二。'
], 0, { id: 'ai-b' }, crowdedRoom);
assert.strictEqual(uniqueLine, '這張票我會投【雞】，因為目前的票差還可能改變前二。',
  'sentence selection must avoid reusing a familiar clause even when punctuation joins it to a second clause');

console.log('v10.8.18 dialogue diversity regression: PASS');
process.exit(0);
