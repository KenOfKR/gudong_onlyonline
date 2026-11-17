'use strict';
const assert = require('assert');
const GD = require('./harness')();
const players = [
  { id: 'b', name: '藍色薏涵', role: '方震', botId: 'blue', colorId: GD.SEAL_COLORS[0].id },
  { id: 'h', name: '薏涵', role: '平民', botId: 'human', colorId: GD.SEAL_COLORS[1].id }
];
const rd1 = { roundNum: 1, turnLogs: { b: { fangTargetId: 'h', fangCamp: 'good' } }, speeches: [], beasts: [], votes: {} };
const rd2 = { roundNum: 2, turnLogs: { b: { inspect: [] } }, speeches: [], beasts: [{ name: '狗' }], votes: {} };
const room = { roomId: 'VOTE_REPLY_TEST', currentRoundIdx: 1, players, rounds: [rd1, rd2] };
const bot = players[0];
const A = { ctx: { bot, room, isGood: true, t: 1, rd: rd2, myIns: [] } };
const line = GD.Speech.concreteVoteReply(bot, room, { beast: '狗', claims: [] }, A, 'h', '藍色【薏涵】', '狗', { claims: [] });
assert(line.includes('親自查過這名玩家的陣營') && line.includes('結果是好人') && line.includes('也投【狗】'),
  'a real own Fang camp scan can become a concrete strategic follow-vote line');

const noProofRoom = { ...room, rounds: [{ roundNum: 1, turnLogs: { b: { inspect: [] } }, speeches: [], votes: {} }, rd2] };
const noProof = GD.Speech.concreteVoteReply(bot, noProofRoom, { beast: '牛', claims: [] },
  { ctx: { ...A.ctx, room: noProofRoom, rd: rd2 } }, 'h', '藍色【薏涵】', '狗', { claims: [] });
assert(!noProof.includes('親自查過') && !noProof.includes('結果是好人'),
  'the line must never invent a direct person-camp check when none exists');
assert(noProof.includes('沒有第二份獨立查驗') && noProof.includes('主票放【牛】'),
  'when evidence is missing, the response says exactly what is missing and where the bot votes');

const beastOnlyRoom = { ...room, rounds: [{ roundNum: 1, turnLogs: { b: { inspect: [] } }, speeches: [], votes: {} }, rd2] };
const beastOnlyA = { ctx: { ...A.ctx, room: beastOnlyRoom, rd: rd2 } };
const supported = GD.Speech.concreteVoteReply(bot, beastOnlyRoom,
  { beast: '狗', claims: [{ beast: '狗', real: true }] }, beastOnlyA, 'h', '藍色【薏涵】', '狗',
  { claims: [{ beast: '狗', real: true }] });
assert(supported.includes('我自己這輪也查到【狗】是真品') && supported.includes('我跟這一票'),
  'an approved own inspection should be cited instead of generic meta-commentary');

const latestRd = { ...rd2, speeches: [{ playerId: 'h', speakerName: '薏涵', text: '我主張投【狗】。' }] };
const latestRoom = { ...room, currentRoundIdx: 1, rounds: [rd1, latestRd] };
const latest = GD.Speech.concreteVoteReplyForLatestSpeaker(bot, latestRoom, { beast: '狗', claims: [] },
  { ctx: { ...A.ctx, room: latestRoom, rd: latestRd } });
assert(latest && latest.speakerTag.includes('薏涵') && latest.beast === '狗' && latest.line.includes('親自查過'),
  'the latest public vote call is converted into a verified first-person tactical reply');
const source = require('fs').readFileSync(require('path').join(__dirname, '../js/bot/speech.js'), 'utf8');
assert(!source.includes('我會比對支持與反對這個目標的公開線索，再決定是否跟票'),
  'the empty abstract response must be removed from all speech paths');
assert(source.includes('遇到前手喊票，禁止使用'), 'Gemini prompt explicitly rejects empty vote-analysis filler');
const driver = require('fs').readFileSync(require('path').join(__dirname, '../js/bot/driver.js'), 'utf8');
assert(driver.includes('Speech.concreteVoteReplyForLatestSpeaker') && driver.includes('candidateText = `${candidateText.trim()}\\n${tactical.line}`'),
  'Gemini replies receive an evidence-based tactical line after generation, without placing private scan facts in the prompt');
console.log('PASS v10.8.20 tactical vote reply: meaningful evidence-based follow vote, own-inspection citation, and no invented checks');
process.exit(0);
