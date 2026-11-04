'use strict';

const load = require('./tests/harness');
const GD = load();
const { Engine, U, Claims } = GD;

const room = Engine.newRoom('CLAIMS_ATTRIBUTION_PROBE', 'human');
Engine.addPlayer(room, { id: 'human', name: 'Yan' });
Engine.fillBots(room);
Engine.start(room);

const bots = room.players.filter(p => p.isBot);
bots[0].name = 'H小姐';
bots[1].name = '張懿';
bots[2].name = '佩萱';

const rd = U.curRound(room);

const samples = [
  '我第一回驗【蛇】真。',
  '本人第一回驗【蛇】真。',
  'H小姐第一回驗【蛇】真。',
  '聽說有人第一回驗【蛇】真。',
  'H小姐說【張懿】與【佩萱】之中有老朝奉。',
  '我認為【張懿】與【佩萱】之中有老朝奉。'
];

for (const text of samples) {
  const p = Claims.parse(text, room, rd);

  console.log('\n原文：' + text);
  console.log('查驗回報：', JSON.stringify(p.inspectionReports));
  console.log('候選集合：', JSON.stringify(
    (p.candidateSets || []).map(g => ({
      role: g.role,
      names: g.candidateIds.map(id => U.byId(room, id)?.name)
    }))
  ));
}