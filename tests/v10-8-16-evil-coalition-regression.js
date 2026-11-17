'use strict';
const assert = require('assert');
const GD = require('./harness')();

// A public-only forecast: dog is the bot's original bluff target, while pig is a better counterfeit candidate to push into Top 2.
const players = [
  { id: 'evil', name: '壞人A', role: '老朝奉', isBot: true, voteBank: 2 },
  ...Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, role: '姬雲浮', isBot: true, voteBank: 2 }))
];
const beasts = ['狗', '馬', '豬', '羊'].map(name => ({ name, isReal: name === '馬' || name === '羊' }));
const speeches = [
  { playerId: 'evil', speakerName: '壞人A', text: '我主張把票投向【狗】，大家先看這尊。' },
  { playerId: 'p0', speakerName: '玩家0', text: '我主張投【豬】。' },
  { playerId: 'p1', speakerName: '玩家1', text: '我主張投【豬】。' },
  { playerId: 'p2', speakerName: '玩家2', text: '我主張投【豬】。' },
  { playerId: 'p3', speakerName: '玩家3', text: '我主張投【豬】。' },
  { playerId: 'p4', speakerName: '玩家4', text: '我主張投【馬】。' },
  { playerId: 'p5', speakerName: '玩家5', text: '我主張投【馬】。' },
  { playerId: 'p6', speakerName: '玩家6', text: '我主張投【羊】。' }
];
const room = {
  players,
  currentRoundIdx: 0,
  rounds: [{ beasts, speeches, votes: {}, turnLogs: {}, mind: {}, passOrder: players.map(p => p.id), speechOrder: players.map(p => p.id) }]
};
const mind = {
  beast: '狗',
  post: [
    { name: '狗', pReal: 0.20 },
    { name: '馬', pReal: 0.78 },
    { name: '豬', pReal: 0.18 },
    { name: '羊', pReal: 0.70 }
  ],
  beliefProfile: {}
};
const redirect = GD.Tactics.chooseEvilCoalitionTarget(room, 'evil', mind);
assert(redirect && redirect.shouldRedirect, '落後的贗品目標應觸發公開票勢導向的替代方案');
assert.strictEqual(redirect.current, '狗');
assert.strictEqual(redirect.target, '豬', '應選擇更可能進前二且低真偽後驗的替代贗品');
assert(redirect.targetPTopTwo > redirect.currentPTopTwo, '替代目標必須有更高前二機率');

// Learning must preserve the whole causal chain using public speeches, ballots and the bot's own forecast only.
const resultRoom = {
  players,
  currentRoundIdx: 0,
  votes: {},
  personVotes: { evil: 'p6' },
  rounds: [{
    beasts,
    speeches: [
      { playerId: 'evil', speakerName: '壞人A', text: '我主張把票投向【狗】。' },
      { playerId: 'p0', speakerName: '玩家0', text: '我主張投【狗】。' },
      { playerId: 'p1', speakerName: '玩家1', text: '我主張投【狗】。' },
      { playerId: 'p2', speakerName: '玩家2', text: '我主張投【豬】。' }
    ],
    votes: {
      evil: { 狗: 4 }, p0: { 狗: 3 }, p1: { 狗: 2 }, p2: { 馬: 2 },
      p3: { 馬: 2 }, p4: { 豬: 4 }, p5: { 豬: 4 }, p6: { 豬: 3 }
    },
    voteResults: {
      rank1: { name: '馬', votes: 4, isReal: true },
      rank2: { name: '豬', votes: 11, isReal: false }
    },
    mind: { evil: { voteForecast: { ranking: [
      { name: '狗', expectedVotes: 8.2, pTopTwo: 0.24 },
      { name: '馬', expectedVotes: 6.4, pTopTwo: 0.67 },
      { name: '豬', expectedVotes: 5.8, pTopTwo: 0.61 },
      { name: '羊', expectedVotes: 2.2, pTopTwo: 0.08 }
    ] } } },
    turnLogs: {}
  }]
};
const lesson = GD.Learning.buildCausalLessons(resultRoom, players[0]).rounds[0];
assert.strictEqual(lesson.strategyOutcome.declaredTarget, '狗');
assert.strictEqual(lesson.strategyOutcome.declaredTargetReachedTopTwo, false);
assert.strictEqual(lesson.strategyOutcome.outcomeCode, 'declared-target-missed-top-two');
assert.strictEqual(lesson.strategyOutcome.observedVotes, 9);
assert.strictEqual(lesson.strategyOutcome.publicCallSupportBeforeDecision, 0, '後手號召不能倒灌成決策當下已知資訊');
assert.strictEqual(lesson.strategyOutcome.publicCallSupportFinal, 3, 'Learning 可以另外保存該輪最後形成的公開支持量');
assert.strictEqual(lesson.strategyOutcome.predictedPTopTwo, 0.24);
assert.deepStrictEqual(lesson.decision.speakerCalls, ['狗']);
console.log('PASS v10.8.16 evil coalition regression: public forecast redirects weak fake targets; causal learning records call, forecast, ballot and Top-2 miss without reading other bots private mind.');
process.exit(0);
