'use strict';
const assert = require('assert');
const GD = require('./harness')();

const room = {
  players: [
    { id: 'red', name: 'Alli', colorId: 'red' },
    { id: 'black', name: '真人甲', colorId: 'black' }
  ],
  rounds: [{ beasts: ['鼠','牛','虎','兔'].map(name => ({ name })) }],
  currentRoundIdx: 0
};
const text = '紅色【Alli】剛才說【鼠】是真品；但我還要看其他線索能否印證。我手上的查驗顯示【牛】真。另外，目前關於【鼠】有3人提出同方向看法，但來源拆開是1人自稱親查、1人是在附和、1人沒交代來源；自稱查驗仍是公開自述。【鼠】目前有3人提出相同真偽主張，其中自稱親查1人、推論0人、附和1人、未交代來源1人、視野受限0人；這些是公開說法，不等於同數量的獨立驗證。';

try {
  const parsed = GD.Claims.parseRecord({ playerId: 'xu', text }, room, room.rounds[0]);
  assert.deepStrictEqual(parsed.claims, [{ beast: '牛', real: true }],
    'quoted opponent result and aggregate-source commentary must not be counted as the speaker own beast claim');
  console.log('Public claim context regression PASS: quoted and aggregate mentions do not become self-inspection claims.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
