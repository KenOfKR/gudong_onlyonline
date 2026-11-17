'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Mind, Strategy, Speech, Claims, U } = GD;

const room = Engine.newRoom('ROLE_SWAP_AUDIT_REGRESSION', 'human');
Engine.addPlayer(room, { id: 'human', name: '真人玩家', colorId: 'black' });
Engine.fillBots(room);
assert(Engine.start(room), 'fixture game must start');
const rd = U.curRound(room);
const observer = room.players.find(p => p.isBot && GD.isGood(p.role));
const first = room.players.find(p => p.id === 'human');
const second = room.players.find(p => p.id !== first.id && p.id !== observer.id);
assert(first && second && observer, 'fixture needs two role claimants and a good Bot observer');
observer.genes = { ...(observer.genes || {}), assertiveness: 1 };
room.status = 'discussion';
room.currentSpeakerId = observer.id;
rd.speechOrder = [first.id, second.id, observer.id, ...room.players.filter(p => ![first.id, second.id, observer.id].includes(p.id)).map(p => p.id)];
rd.speeches.push(
  { playerId: first.id, speakerName: first.name, text: '我是老朝奉。', source: 'human', createdAt: 1000 },
  { playerId: second.id, speakerName: second.name, text: '我是藥不然。', source: 'bot', createdAt: 2000 }
);
const audit = Mind.collectPublicRoleClaimAudit(room, 0);
assert.strictEqual(audit.rows.length, 2, 'only explicit first-person unique role claims are recorded');
assert.strictEqual(audit.roleSwapPairs.length, 1, 'complementary Lao/Yao declarations are linked as a possible swap frame');
const pair = audit.roleSwapPairs[0];
assert.strictEqual(pair.pattern, 'complementary-evil-role-claims');
assert([pair.first.role, pair.second.role].includes('老朝奉'));
assert([pair.first.role, pair.second.role].includes('藥不然'));
assert(pair.note.includes('單靠自稱不能判定'), 'the pair audit must preserve uncertainty rather than declare guilt');
const analysis = Mind.analyze(observer, room);
assert(analysis.roleSwapPairs.length === 1, 'the public role-swap audit is available to each Bot analysis');
assert(analysis.roleClaimAudit.some(row => row.playerId === first.id));
assert(analysis.roleClaimAudit.some(row => row.playerId === second.id));
const originalRandom = Math.random;
Math.random = () => 0;
let challenge;
try { challenge = Strategy.selectInteractionChallenge(observer, room, analysis); }
finally { Math.random = originalRandom; }
assert(challenge && challenge.kind === 'role_swap', 'reciprocal role claims create a concrete challenge instead of being silently accepted');
const plan = { mode: 'truth', beast: rd.beasts[0].name, avoid: [], claims: [], why: [], tacticalLine: '',
  askId: challenge.targetId, askKind: challenge.kind, askEvidence: challenge.evidence };
const line = Speech.localSpeech(observer, room, plan, analysis);
assert(line.includes(U.tag(U.byId(room, challenge.targetId))) && /技能|時序|說明|解釋/.test(line), 'local Bot dialogue must question the claimant using public skill/timing evidence');
const parsedLine = Claims.parseRecord({ playerId: observer.id, speakerName: observer.name, text: line }, room, rd);
assert(parsedLine.asked.includes(challenge.targetId), 'the generated role-swap line must be parsed as a real question to that claimant');
console.log('PASS v10.8.21 role-swap audit regression: paired claims trigger a grounded question and are never treated as verified identity');
process.exit(0);
