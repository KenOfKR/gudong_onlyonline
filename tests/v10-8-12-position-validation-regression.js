'use strict';
const assert = require('assert');
const GD = require('./harness')();

try {
  const room = { players: [
    { id: 'b0', name: 'BOT', isBot: true, colorId: 'green' },
    { id: 'h1', name: 'Human', isBot: false, colorId: 'white' },
    { id: 'b2', name: 'BOT2', isBot: true, colorId: 'blue' }
  ], rounds: [], currentRoundIdx: 0 };
  const round = { beasts: ['龍','羊','雞','狗'].map(name => ({name,isReal:true})),
    passOrder: ['b0','h1','b2'], speechOrder: ['h1','b2','b0'], speeches: [] };
  room.rounds = [round];
  const bot = room.players[0];
  let audit = GD.Speech.auditPublicConsistency('我在第三位掌眼後，【龍】是真品。', room, bot, {}, {});
  assert.strictEqual(audit.ok, false);
  assert(/掌眼/.test(audit.why) && /第1位/.test(audit.why), 'wrong pass position should be rejected against passOrder');

  audit = GD.Speech.auditPublicConsistency('我在第一位掌眼後，【龍】是真品。', room, bot, {}, {});
  assert.strictEqual(audit.ok, true, 'correct pass position should remain valid');

  audit = GD.Speech.auditPublicConsistency('我是第二位公開發言的玩家。', room, bot, {}, {});
  assert.strictEqual(audit.ok, false);
  assert(/公開發言/.test(audit.why) && /第2位/.test(audit.why), 'speech position must use speechOrder, not passOrder');

  audit = GD.Speech.auditPublicConsistency('我是第三位掌眼的玩家。', room, bot, {}, {});
  assert.strictEqual(audit.ok, false, 'pass-order and speech-order claims must not be interchangeable');
  console.log('Position validation regression PASS: passOrder and speechOrder are independently validated and incorrect AI claims are rejected.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
