'use strict';
const assert = require('assert');
const GD = require('./harness')();

function fixture(speechesByRound) {
  const room = GD.Engine.newRoom('V10816_ROLE_POSTERIOR', 'p0');
  const roles = ['姬雲浮', '木戶加奈', '黃煙煙', '許願', '方震', '鄭國渠', '老朝奉', '藥不然'];
  room.players = roles.map((role, i) => ({
    id: `p${i}`, name: `玩家${i}`, isBot: true, botId: `bot_${i}`,
    role, colorId: GD.SEAL_COLORS[i].id, seatIndex: i, voteBank: 2,
    isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false,
    pendingImmediateAmbush: false, pendingPermanentAmbush: false, confusedRound: -1
  }));
  room.status = 'discussion'; room.gameId = 'v10816-role-posterior'; room.currentRoundIdx = speechesByRound.length - 1;
  room.rounds = speechesByRound.map((speeches, index) => ({
    roundNum: index + 1,
    beasts: [{ name: '鼠', isReal: false }, { name: '羊', isReal: true }, { name: '狗', isReal: false }, { name: '豬', isReal: true }],
    passOrder: room.players.map(p => p.id), speechOrder: room.players.map(p => p.id).reverse(),
    turnLogs: Object.fromEntries(room.players.map(p => [p.id, { inspect: [] }])),
    speeches, votes: {}, voteResults: null, mind: {}
  }));
  return { room, bot: room.players[0], target: room.players[1] };
}

try {
  const baseline = fixture([[]]);
  const claimed = fixture([[{ playerId: 'p1', speakerName: '玩家1', text: '我是老朝奉。' }]]);
  const before = GD.Mind.analyze(baseline.bot, baseline.room).prof.p1;
  const after = GD.Mind.analyze(claimed.bot, claimed.room).prof.p1;
  const laoDelta = after.pLao - before.pLao;
  const evilDelta = after.pEvil - before.pEvil;
  assert(laoDelta > 0 && laoDelta < 0.10, `單次自稱應是弱角色線索，實際 pLao delta=${laoDelta}`);
  assert(evilDelta >= 0 && evilDelta < 0.05, `自稱老朝奉不能直接等同壞人，實際 pEvil delta=${evilDelta}`);

  const knownRole = fixture([[{ playerId: 'p1', speakerName: '玩家1', text: '我是姬雲浮。' }]]);
  const knownBefore = GD.Mind.analyze(knownRole.bot, fixture([[]]).room).prof.p1;
  const knownAfter = GD.Mind.analyze(knownRole.bot, knownRole.room).prof.p1;
  assert(knownAfter.pEvil - knownBefore.pEvil < 0.15,
    '宣稱觀察者已知被占用的角色，也不能直接定罪；保留好人假跳／擋刀可能');

  console.log('PASS v10.8.16 role posterior regression: self-claims are weak evidence, separate from camp certainty, and known-role counter-bluff is not a hard guilty verdict.');
  process.exit(0);
} catch (error) {
  console.error('FAIL v10.8.16 role posterior regression:', error.stack || error);
  process.exit(1);
}
