'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Conversation, U } = GD;

const room = Engine.newRoom('VOICE_CAPTION_REGRESSION', 'human-a');
Engine.addPlayer(room, { id: 'human-a', name: '小彥', colorId: 'black' });
Engine.fillBots(room);
assert(Engine.start(room), 'fixture game must start');
const player = room.players.find(p => p.id === 'human-a');
room.status = 'discussion';
const rd = U.curRound(room);
const previousTurnStart = room.turnStartTime = 123456;
assert.strictEqual(Engine.recordVoiceTranscript(room, player.id, '我驗到狗是真品', 'vt-001'), true);
assert.strictEqual(rd.voiceTranscripts.length, 1);
assert.strictEqual(rd.speeches.length, 0, 'captions must remain outside formal speeches');
assert.strictEqual(rd.speechIndex, 0, 'captions must not advance formal speech index');
assert.strictEqual(room.turnStartTime, previousTurnStart, 'captions must not reset the active turn deadline');
assert.strictEqual(Engine.recordVoiceTranscript(room, player.id, '第二段字幕', 'vt-001'), false, 'duplicate message IDs are rejected');
assert.strictEqual(Engine.recordVoiceTranscript(room, player.id, '短', 'vt-002'), false, 'too-short captions are rejected');
const bot = room.players.find(p => p.isBot);
assert.strictEqual(Engine.recordVoiceTranscript(room, bot.id, '機器人冒充字幕', 'vt-003'), false, 'bots cannot impersonate authenticated human voice captions');

const originalSpeeches = rd.speeches;
const restore = Conversation.injectTemporary(room);
assert.strictEqual(rd.speeches.length, 1, 'public caption is projected into AI dialogue context');
assert.strictEqual(rd.speeches[0].voiceTranscript, true);
assert.strictEqual(rd.speeches[0].voiceTranscriptId, 'vt-001');
assert.strictEqual(rd.speeches[0].playerId, player.id);
assert(rd.speeches[0].p, 'projected caption has parsed semantics for AI');
restore();
assert.strictEqual(rd.speeches, originalSpeeches, 'AI context projection restores the exact original speech array');
assert.strictEqual(rd.speeches.length, 0, 'synthetic caption never persists as a formal speech');

// Captions remain available while the game and final Bot decisions are active, then clear at gameover.
room.status = 'person_voting';
room.personVotes = {};
for (const voter of room.players) {
  const target = room.players.find(candidate => candidate.id !== voter.id);
  assert(target, 'each voter needs a legal non-self target');
  assert.strictEqual(Engine.personVote(room, voter.id, target.id), true);
}
assert.strictEqual(room.status, 'gameover');
assert(room.rounds.every(round => !round.voiceTranscripts || round.voiceTranscripts.length === 0), 'public transcript cache clears after the game ends');
console.log('PASS v10.8.21 voice caption regression: Firestore-room data, limits, privacy boundary, temporary AI projection, restore, and gameover cleanup');
process.exit(0);
