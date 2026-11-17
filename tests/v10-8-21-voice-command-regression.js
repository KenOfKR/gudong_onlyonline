'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Voice } = GD;

const room = Engine.newRoom('VOICE_COMMAND_REGRESSION', 'human-a');
Engine.addPlayer(room, { id: 'human-a', name: '小彥', colorId: 'black' });
Engine.addPlayer(room, { id: 'human-b', name: '薏涵' });
Engine.setColor(room, 'human-b', 'blue');
Engine.addPlayer(room, { id: 'bot-target', name: '小機器', isBot: true, botId: 'bot_003' });
const me = room.players.find(p => p.id === 'human-a');

assert.deepStrictEqual(Voice.parseCommand('確認執行', room, me).type, 'confirm');
assert.deepStrictEqual(Voice.parseCommand('取消操作', room, me).type, 'cancel');
assert.deepStrictEqual(Voice.parseCommand('鑑定狗', room, me), {
  type: 'inspect', beast: '狗', label: '查驗【狗】'
});
const declaration = Voice.parseCommand('宣告狗是真品', room, me);
assert.strictEqual(declaration.type, 'speechDraft');
assert.strictEqual(declaration.text, '【狗】真品。');
const genericSkill = Voice.parseCommand('打出功能牌', room, me);
assert.strictEqual(genericSkill.type, 'invalid', 'ambiguous generic skill command must not execute');
assert(Voice.parseCommand('聊天裡講到鑑定', room, me).type === 'invalid', 'conversation mentioning a keyword must not execute a command');
const pass = Voice.parseCommand('傳牌給藍色玩家', room, me);
assert.strictEqual(pass.type, 'pass');
assert.strictEqual(pass.targetId, 'human-b');
const botTarget = room.players.find(p => p.isBot);
assert(botTarget, 'fixture needs a bot target');
const botPass = Voice.parseCommand(`傳牌給【${botTarget.name}】`, room, me);
assert.strictEqual(botPass.type, 'pass', 'voice targeting must resolve both human and bot players');
assert.strictEqual(botPass.targetId, botTarget.id);
const vote = Voice.parseCommand('投兩票給狗', room, me);
assert.strictEqual(vote.type, 'vote');
assert.deepStrictEqual(vote.ballot, { 狗: 2 });
const lao = Voice.parseCommand('發動擾亂', room, me);
assert.strictEqual(lao.type, 'skill');
assert.strictEqual(lao.kind, 'lao');
const original = JSON.stringify(room);
[declaration, genericSkill, pass, vote, lao].forEach(command => assert(command && command.type));
assert.strictEqual(JSON.stringify(room), original, 'parsing voice commands must not mutate game state or execute actions');
console.log('PASS v10.8.21 voice command regression: zh-TW intents, target resolution, ambiguity rejection, and no side effects');
process.exit(0);
