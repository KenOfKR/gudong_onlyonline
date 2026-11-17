'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Mind } = GD;

try {
  const room = Engine.newRoom('EVIDENCE', 'h0');
  const roles = ['方震', '許願', '姬雲浮', '黃煙煙', '木戶加奈', '老朝奉', '藥不然', '鄭國渠'];
  const colors = GD.SEAL_COLORS;
  for (let i = 0; i < 8; i++) {
    room.players.push({ id: `p${i}`, name: `玩家${i}`, isBot: i < 3, botId: i < 3 ? `bot_${String(i).padStart(3, '0')}` : null,
      role: roles[i], colorId: colors[i].id, seatIndex: i, voteBank: 2,
      isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false, pendingImmediateAmbush: false,
      pendingPermanentAmbush: false, confusedRound: -1 });
  }
  const bot = room.players[0];
  room.gameId = 'evidence-game'; room.status = 'discussion'; room.currentRoundIdx = 0;
  const passOrder = room.players.map(p => p.id);
  const rd = { roundNum: 1, beasts: ['龍', '羊', '雞', '狗'].map(name => ({ name, isReal: true })),
    passOrder, speechOrder: passOrder.slice(), speechIndex: 8, turnLogs: {}, speeches: [], votes: {}, voteResults: null, mind: {}, laoActive: false, blockedBeast: null };
  room.rounds = [rd];
  rd.speeches = [
    { playerId: 'p1', speakerName: '玩家1', text: '我親眼看到【龍】是真品。', source: 'human' },
    { playerId: 'p2', speakerName: '玩家2', text: '我自己查驗【龍】是真品。', source: 'human' },
    { playerId: 'p3', speakerName: '玩家3', text: '我驗不到，【龍】真，【龍】假！', source: 'human' },
    { playerId: 'p4', speakerName: '玩家4', text: '三電腦出 1–2 壞。', source: 'human' },
    { playerId: 'p4', speakerName: '玩家4', text: '三電腦出 1–2 壞。', source: 'human' },
    { playerId: 'p5', speakerName: '玩家5', text: '三電腦出 1–2 壞。', source: 'human' }
  ];
  const A = Mind.analyze(bot, room);
  const contradictory = A.claimEvidence.current.filter(item => item.type === 'self-contradictory');
  assert(contradictory.length >= 2, 'both sides of the self-contradictory same-speech event should remain visible but very low weight');
  assert(contradictory.every(item => item.weight <= 0.05), 'self-contradictory claims must not count as independent direct evidence');
  const direct = A.claimEvidence.current.filter(item => item.beast === '龍' && item.real === true && item.type === 'self-reported-direct');
  assert.strictEqual(direct.length, 2, 'two independently sourced direct reports must remain separately classified');
  assert(direct.every(item => item.weight >= 0.6), 'a contradiction by another speaker must not globally downweight independent direct checks');
  assert(A.consensusAlerts.some(group => group.beast === '龍' && group.real === true && group.speakerCount >= 2), 'consensus decomposition should trigger when two speakers align');
  const countConstraint = A.publicCountConstraints.find(item => item.min === 1 && item.max === 2 && item.populationSize === 3 && item.populationResolved);
  assert(countConstraint, 'count constraints should flow into Mind as a group-level weak hypothesis');
  assert.strictEqual(countConstraint.speakerCount, 2, 'repeating the same hypothesis by one speaker must not count as a new independent source');
  assert(Math.abs(countConstraint.evidenceWeight - 0.14) < 1e-9, 'second independent speaker should add only a small weight, not a hard named accusation');
  assert(countConstraint.populationIds.length === 3 && !countConstraint.playerId, 'group hypothesis must not identify an individual target');
  assert(A.uncertaintyReports.some(item => item.playerId === 'p3' && item.reason === 'unspecified' && item.provenance === 'self_report' && item.verification === 'not_independently_verified'), 'Mind must preserve unreadable cause as an unverified self-report');

  // Verified camp is orthogonal to Lao role posterior; do not collapse P(Evil) into P(Lao).
  const fangProfile = A.prof.p1;
  assert(fangProfile && Number.isFinite(fangProfile.pEvil) && Number.isFinite(fangProfile.pLao));
  assert(fangProfile.pLao <= fangProfile.pEvil + 1e-9, 'P(Lao) must remain a subset posterior, never replace P(Evil)');

  console.log('Public evidence regression PASS: early 2-speaker source audit, independent checks retained, same-speech contradiction downweighted, count hypothesis carried into Mind, and P(Evil)/P(Lao) kept distinct.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
