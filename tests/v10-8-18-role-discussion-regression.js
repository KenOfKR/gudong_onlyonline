'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Strategy, Mind, Speech, U, Claims } = GD;

const room = Engine.newRoom('ROLE_DISCUSSION_LANGUAGE', 'host');
Engine.addPlayer(room, { id: 'human', name: '真人甲' });
Engine.fillBots(room);
assert(Engine.start(room), 'fixture game must start');
const round = U.curRound(room);
const observer = room.players.find(player => player.isBot && player.role !== '方震');
const target = room.players.find(player => player.id !== observer.id && player.id !== 'human');
const sourceA = room.players.find(player => player.id !== observer.id && player.id !== target.id && player.id !== 'human');
const sourceB = room.players.find(player => player.id !== observer.id && player.id !== target.id && player.id !== sourceA.id && player.id !== 'human');
assert(observer && target && sourceA && sourceB, 'fixture needs an observer, a role candidate and two independent speakers');

round.speeches.push(
  { playerId: sourceA.id, speakerName: sourceA.name, text: `${U.tag(target)}可能是藥不然吧？` },
  { playerId: sourceB.id, speakerName: sourceB.name, text: `${U.tag(target)}像方震，得看技能時點。` },
  { playerId: observer.id, speakerName: observer.name, text: '' }
);
const parsedRoleClaims = Claims.parseRecord(round.speeches[0], room, round);
assert(parsedRoleClaims.roleClaims.some(claim => claim.playerId === target.id && claim.role === '藥不然' && claim.polarity === 'claim'),
  'natural-language role speculation should be attributed to the named player and role');
const deniedRole = Claims.parseRecord({ playerId: sourceB.id, speakerName: sourceB.name, text: `我不覺得${U.tag(target)}像藥不然。` }, room, round);
assert(deniedRole.roleClaims.some(claim => claim.playerId === target.id && claim.role === '藥不然' && claim.polarity === 'deny'),
  'negative role descriptions such as "不像藥不然" must remain an exclusion, not a positive accusation');
const hypotheses = Strategy.collectPublicRoleHypotheses(room, observer.id, room.currentRoundIdx);
assert(hypotheses.some(item => item.candidateId === target.id && item.role === '藥不然' && item.sources.includes(sourceA.id)),
  'role discussion selection should consume public role accusations, not only explicit self-claims');
assert(hypotheses.some(item => item.candidateId === target.id && item.role === '方震' && item.sources.includes(sourceB.id)),
  'independent public role hypotheses should retain their own source speaker');

const analysis = Mind.analyze(observer, room);
const planResult = Strategy.plan(observer, room);
const roleEventPlan = {
  ...planResult.plan,
  roleDiscussionEvent: {
    gameEvent: true, phase: 'response', act: 'probe',
    candidateId: target.id, candidateRole: '藥不然', sourceSpeakerId: sourceA.id,
    sourceRound: round.roundNum || 1, sourceText: round.speeches[0].text
  }
};
const speech = Speech.localSpeech(observer, room, roleEventPlan, planResult.A || analysis);
assert(speech.includes(U.tag(target)) && speech.includes('藥不然'), 'local computer speech must name the public role hypothesis target and candidate role');
assert(speech.includes(U.tag(sourceA)), 'local computer speech must preserve who introduced the role hypothesis');
assert(/[？?]/.test(speech), 'a role-probe response must ask a concrete question');
const validation = Speech.validate(speech, observer, room, roleEventPlan, planResult.A || analysis);
assert(validation.ok, `local role discussion should pass the speech contract: ${validation.why}`);

console.log('PASS v10.8.18 role discussion regression: parsed public role hypotheses, source attribution, local response and question contract');
process.exit(0);
