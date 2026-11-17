'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine } = GD;

try {
  const room = Engine.newRoom('SPEECH_SOURCE_PROVENANCE', 'human');
  const human = Engine.addPlayer(room, { id: 'human', name: '真人玩家' });
  Engine.fillBots(room);
  assert(Engine.start(room));
  const bot = room.players.find(p => p.isBot);
  const rd = room.rounds[0];
  room.status = 'discussion';
  rd.speechOrder = [bot.id, human.id];
  rd.speechIndex = 0;
  room.currentSpeakerId = bot.id;
  assert(Engine.speak(room, bot.id, { text: '我先提出一個可核對的判斷。', source: 'human' }));
  assert.strictEqual(rd.speeches[0].source, 'bot', 'an AI roster member must never be exported as a human source');
  assert.match(rd.speeches[0].summary, /^\[AI\]/);
  room.currentSpeakerId = human.id;
  assert(Engine.speak(room, human.id, { text: '這是真人玩家的發言。', source: 'bot' }));
  assert.strictEqual(rd.speeches[1].source, 'human', 'a real player remains human even if caller source is incorrect');
  console.log('PASS v10.8.11 speech source provenance regression');
} catch (err) {
  console.error('FAIL v10.8.11 speech source provenance regression:', err && err.stack || err);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
