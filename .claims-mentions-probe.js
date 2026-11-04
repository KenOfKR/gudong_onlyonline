'use strict';

const load = require('./tests/harness');
const GD = load();
const { Engine, U, Claims } = GD;

const room = Engine.newRoom('CLAIMS_MENTIONS_PROBE', 'human');
Engine.addPlayer(room, { id: 'human', name: 'Yan' });
Engine.fillBots(room);
Engine.start(room);

const bots = room.players.filter(p => p.isBot);
bots[0].name = 'H小姐';
bots[1].name = '張懿';
bots[2].name = '佩萱';

console.log('=== 場上全部玩家 ===');
room.players.forEach(p => {
  console.log({
    id: p.id,
    name: p.name,
    role: p.role,
    isBot: p.isBot
  });
});

const samples = [
  'H小姐說【張懿】與【佩萱】',
  '我認為【張懿】與【佩萱】'
];

for (const source of samples) {
  console.log('\n=== mentions 原始結果 ===');
  console.log('輸入：' + source);

  const found = Claims.mentions(source, room);

  found.forEach((p, i) => {
    console.log(i + 1, {
      id: p.id,
      name: p.name,
      role: p.role,
      isBot: p.isBot
    });
  });
}