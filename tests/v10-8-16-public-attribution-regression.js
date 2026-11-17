'use strict';
const assert = require('assert');
const GD = require('./harness')();

const room = {
  players: [
    { id: 'human', name: '歪ㄟ恩', colorId: 'black' },
    { id: 'red', name: '偉翔', colorId: 'red' },
    { id: 'orange', name: '源阿', colorId: 'orange' },
    { id: 'yellow', name: '柚子', colorId: 'yellow' },
    { id: 'green', name: '卓毅', colorId: 'green' },
    { id: 'blue', name: '愛飛翔', colorId: 'blue' },
    { id: 'purple', name: '奕瑜', colorId: 'purple' },
    { id: 'white', name: 'Alli', colorId: 'white' }
  ],
  rounds: [], currentRoundIdx: 0
};
const round = { beasts: ['鼠', '羊', '狗', '豬'].map(name => ({ name })), passOrder: [], speechOrder: [] };

const greenSpeech = '黃色【柚子】剛才的原話是「【鼠】是贗品，我主張這輪把票投向【鼠】」，並提出了前手提出的角色版本，要求依原話與技能時點核對。但如果結果像被人翻過一面，先對照每人的位置和能做的操作。黃色【柚子】叫大家跟投【鼠】，但我目前無法直接照辦。橘色【源阿】手上的查驗顯示【羊】真，這與我目前核准的公開立場一致。本輪我的主要票向是【羊】，具體理由很簡單：場上目前對【羊】有具體的真品指向，且在各方說法交錯時，依據位置與操作對照下來，【羊】的真品判斷比【鼠】的贗品指控更能站得住腳。因此我的票會投給【羊】，請大家一起把票投向【羊】。';
const green = GD.Claims.parse(greenSpeech, room, round, 'green');
assert.deepStrictEqual(green.claims, [{ beast: '羊', real: true }], '綠色只應保留自己的羊真判斷；鼠假是被引用的柚子說法');
assert.deepStrictEqual(green.callBeasts, ['羊'], '綠色只號召投羊，不得繼承柚子的鼠號召');
assert.strictEqual(green.callBeast, '羊', '主要號召目標應是本人最後明確號召的羊');
assert.deepStrictEqual(green.voteCommitments.map(x => x.beast), ['羊'], '引用中的投鼠不能成為綠色的硬承諾');
assert(green.quotedClaims.some(x => x.beast === '鼠' && x.real === false && x.sourcePlayerIds.includes('yellow')),
  '被引用的鼠假主張仍應保留為柚子的主張');
assert(green.quotedCalls.some(x => x.beast === '鼠' && x.sourcePlayerIds.includes('yellow')),
  '被引用的鼠號召應保留來源，但不能污染本人 callBeasts');
assert.deepStrictEqual(green.speakerCalls, ['羊'], '新 canonical speakerCalls 必須與本人號召一致');

const purpleSpeech = '藍色【愛飛翔】：你主張【狗】是真品，還自稱【平民】，號召大家投【狗】。但我得說，黃色【柚子】和綠色【卓毅】前面才剛斬釘截鐵說【狗】是贗品並號召集火，你直接跟他們唱反調，這票向分得有點硬。如果要核對你這個平民身分，我們得回頭看你前兩輪的投票軌跡跟這輪的發言時序，不能你說你是平民我們就得照單全收。';
const purple = GD.Claims.parse(purpleSpeech, room, round, 'purple');
assert.deepStrictEqual(purple.claims, [], '紫色回應藍色與其他人的狗真假說法，不得算成紫色自己的查驗宣稱');
assert.deepStrictEqual(purple.callBeasts, [], '紫色沒有號召投狗，不得沿用藍色的號召');
assert.strictEqual(purple.selfRole, null, '被回應者的平民自稱不得變成紫色自稱');
assert(purple.quotedClaims.some(x => x.beast === '狗' && x.real === true && x.sourcePlayerIds.includes('blue')),
  '藍色狗真主張要保留來源');
assert(purple.quotedClaims.some(x => x.beast === '狗' && x.real === false && x.sourcePlayerIds.includes('yellow') && x.sourcePlayerIds.includes('green')),
  '柚子與卓毅的狗假主張要保留為被轉述來源');



const callOnly = GD.Claims.parse('我主張這輪把票投向【羊】，也請大家一起投這尊。', room, round, 'green');
assert.deepStrictEqual(callOnly.callBeasts, ['羊'], '「我主張投羊」應是自己的公開號召');
assert.deepStrictEqual(callOnly.voteCommitments, [], '公開號召本身不是本人的硬性投票承諾');
const hardPromise = GD.Claims.parse('我會把票投給【羊】。', room, round, 'green');
assert.deepStrictEqual(hardPromise.voteCommitments.map(x => x.beast), ['羊'], '明確「我會投」仍是硬性承諾');

const pairedQuote = GD.Claims.parse('柚子剛才說「鼠羊雙真」，但我認為羊真。', room, round, 'green');
assert.deepStrictEqual(pairedQuote.claims, [{ beast: '羊', real: true }], '引用中的雙真不得灌入本人 claims');
assert(pairedQuote.quotedClaims.some(x => x.beast === '鼠' && x.real === true && x.sourcePlayerIds.includes('yellow')),
  '引用雙真中的鼠真應保留為柚子的資訊');
assert(pairedQuote.quotedClaims.some(x => x.beast === '羊' && x.real === true && x.sourcePlayerIds.includes('yellow')),
  '引用雙真中的羊真應保留為柚子的資訊');

const contrast = GD.Claims.parse('柚子叫大家投【鼠】，但我不跟；我主張投【羊】，這輪我投【羊】。', room, round, 'green');
assert.deepStrictEqual(contrast.callBeasts, ['羊'], '第三人稱號召鼠與本人拒絕跟票不得混淆');
assert(contrast.voteCommitments.every(x => x.beast === '羊'), '本人承諾只能記羊');

console.log('PASS v10.8.16 public attribution regression: quoted claims/calls, speaker calls, vote commitments, contrastive response and comparative-verdict references are separated.');
process.exit(0);
