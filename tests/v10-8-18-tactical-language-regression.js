'use strict';
const assert = require('assert');
const GD = require('./harness')();

assert.strictEqual(GD.DialogueBank.count(), 1118, 'the 50 new spoken lines must be added without replacing existing dialogue');
assert.strictEqual(GD.DialogueBank.categories().length, 54, 'five independently selectable strategy categories are registered');
const tactics = [
  ['sourceAudit', 'sourceAuditTactics'],
  ['echoBrake', 'echoBrakeTactics'],
  ['pairGuard', 'pairGuardTactics'],
  ['marginalStop', 'marginalStopTactics'],
  ['plannedPivot', 'plannedPivotTactics']
];
const generatedLines = [];
for (const [key, category] of tactics) {
  const triggers = {
    sourceAudit: 'unsupportedTell', echoBrake: 'echoedConsensus', pairGuard: 'pairGuardReady',
    marginalStop: 'marginalStopReady', plannedPivot: 'plannedPivotReady'
  };
  assert.strictEqual(GD.Tactics.choosePublicTactic({ [triggers[key]]: true }), key,
    `${key} must be selected when its trigger is met`);
  assert.strictEqual(GD.DialogueBank.categories().find(item => item.key === category).count, 10,
    `${category} must contribute ten new utterances`);
  const line = GD.DialogueBank.pickFresh(category, 101, { beast: '牛' });
  assert(!/\{(?:beast|speaker|target)\}/.test(line), `${category} must render its variables before use`);
  for (let seed = 0; seed < 10; seed++) generatedLines.push(GD.DialogueBank.pick(category, seed, { beast: '牛' }));
}
for (let i = 0; i < generatedLines.length; i++) {
  for (let j = i + 1; j < generatedLines.length; j++) {
    assert(GD.Speech.dialogueSimilarity(generatedLines[i], generatedLines[j]) < 0.52,
      `new tactical lines ${i + 1} and ${j + 1} must not trip same-game near-duplicate detection`);
  }
}
assert.strictEqual(GD.Tactics.choosePublicTactic({ unsupportedTell: true, echoedConsensus: true }), 'sourceAudit',
  'source correction must take priority over crowd reaction');
assert.strictEqual(GD.Tactics.choosePublicTactic({}), null, 'no tactic should be forced when no trigger is present');

const room = GD.Engine.newRoom('TACTIC_LANGUAGE_AUDIT', 'host');
GD.Engine.addPlayer(room, { id: 'human', name: '真人甲' });
GD.Engine.fillBots(room);
assert(GD.Engine.start(room));
const bot = room.players.find(player => player.isBot);
const unsupported = GD.Speech.auditPublicConsistency('剛才大家的眼神跟微表情都很心虛，證明他是壞人。', room, bot, {}, {});
assert.strictEqual(unsupported.ok, false, 'unavailable facial cues cannot be used as factual evidence');
const challenged = GD.Speech.auditPublicConsistency('你提到他的眼神，但桌上其實看不到這種資訊；有原話或票再說。', room, bot, {}, {});
assert.strictEqual(challenged.ok, true, 'players may challenge unsupported sensory claims in natural speech');

console.log('PASS v10.8.18 tactical/language regression: five triggered strategies, 50 additional lines, and unsupported sensory-evidence guard');
process.exit(0);
