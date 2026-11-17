'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Engine, Mind } = GD;

function fixture() {
  const room = Engine.newRoom('V10814_ROLE_INFERENCE', 'p0');
  const roles = ['鄭國渠', '老朝奉', '藥不然', '方震', '許願', '姬雲浮', '黃煙煙', '木戶加奈'];
  const players = roles.map((role, i) => ({
    id: `p${i}`, name: `玩家${i}`, isBot: true, botId: `bot_${String(i).padStart(3, '0')}`,
    role, colorId: GD.SEAL_COLORS[i].id, seatIndex: i, voteBank: 2,
    isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false,
    pendingImmediateAmbush: false, pendingPermanentAmbush: false, confusedRound: -1
  }));
  room.players = players;
  room.status = 'discussion'; room.gameId = 'v10814-role-inference'; room.currentRoundIdx = 0;
  const ids = players.map(p => p.id);
  room.rounds = [{
    roundNum: 1,
    beasts: [{ name: '鼠', isReal: false }, { name: '牛', isReal: true }, { name: '虎', isReal: true }, { name: '兔', isReal: false }],
    passOrder: ids.slice(), speechOrder: ids.slice().reverse(),
    turnLogs: Object.fromEntries(ids.map(id => [id, { inspect: [] }])),
    speeches: [
      { playerId: 'p0', speakerName: '玩家0', text: '【鼠】是真品。' },
      { playerId: 'p1', speakerName: '玩家1', text: '【鼠】是真品。' },
      { playerId: 'p2', speakerName: '玩家2', text: '【鼠】是真品。' },
      { playerId: 'p3', speakerName: '玩家3', text: '這輪先觀察。' },
      { playerId: 'p4', speakerName: '玩家4', text: '【鼠】是真品。' }
    ],
    votes: {
      p0: { 鼠: 1 }, p1: { 鼠: 1 }, p2: { 鼠: 1 }, p3: {}, p4: { 鼠: 1 }, p5: {}, p6: {}, p7: {}
    },
    voteResults: {
      rank1: { name: '牛', isReal: true, hidden: true },
      rank2: { name: '鼠', isReal: false, hidden: false }
    },
    mind: {
      p1: { privateSecret: 'must-not-be-read' }, p2: { privateSecret: 'must-not-be-read' }
    }
  }];
  return { room, bot: players[0] };
}

try {
  const { room, bot } = fixture();
  const A = Mind.analyze(bot, room);
  const suspected = A.prof.p1;
  assert(suspected);
  assert(suspected.partnerEvidence.some(item => item.kind === 'shared-false-real-claim'));
  assert(suspected.partnerEvidence.some(item => item.kind === 'shared-fake-ballot'));
  assert.strictEqual(suspected.isPartner, true, 'the combined shared-claim/shared-fake-ballot handshake should mark a sufficiently supported partner');
  assert(A.inferredPartners.some(item => item.playerId === 'p1'), 'Zheng partner inference should surface as a separate result');

  // Lao's perspective can infer Zheng among other players; Zheng's own perspective
  // correctly excludes the unique role already occupied by self.
  const laoMind = Mind.analyze(room.players[1], room);
  const roleCandidate = laoMind.prof.p4;
  const cleanCandidate = laoMind.prof.p3;
  assert(Number.isFinite(roleCandidate.pZheng) && Number.isFinite(roleCandidate.pEvil) && Number.isFinite(roleCandidate.pLao),
    'P(Zheng), P(Evil), and P(Lao) must be independently retained');
  assert(roleCandidate.pZheng > cleanCandidate.pZheng, 'public mismatch should increase Zheng posterior independently');

  const before = { pZheng: roleCandidate.pZheng, pEvil: roleCandidate.pEvil, pLao: roleCandidate.pLao };
  room.rounds[0].mind.p4 = { privateSecret: 'changed-private-secret' };
  const after = Mind.analyze(room.players[1], room).prof.p4;
  assert.deepStrictEqual({ pZheng: after.pZheng, pEvil: after.pEvil, pLao: after.pLao }, before,
    'role inference must not read another player private mind');

  console.log('PASS v10.8.14 role inference regression: separate pZheng/pEvil/pLao, public handshake, partner mark, and private-mind firewall.');
} catch (error) {
  console.error('FAIL v10.8.14 role inference regression:', error.stack || error);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
