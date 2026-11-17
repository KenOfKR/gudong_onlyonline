'use strict';
const assert = require('assert');
const GD = require('./harness')();

const room = {
  players: [
    { id: 'yellow', name: '柚子', colorId: 'yellow', role: '鄭國渠' },
    { id: 'green', name: '卓毅', colorId: 'green', role: '老朝奉' }
  ],
  rounds: [{
    roundNum: 1,
    beasts: [{ name: '羊' }, { name: '鼠' }],
    passOrder: ['yellow', 'green'], speechOrder: ['yellow', 'green'],
    speeches: [{ playerId: 'yellow', speakerName: '柚子', text: '我認為【羊】是假品。' }],
    turnLogs: {}
  }],
  currentRoundIdx: 0
};

try {
  const quotedAndOwn = '柚子剛才說「【羊】是贗品」，但我認為【羊】是真品；這輪我主張投【鼠】。';
  const parsed = GD.Claims.parse(quotedAndOwn, room, room.rounds[0], 'green');
  assert.deepStrictEqual(parsed.claims, [{ beast: '羊', real: true }], '引用的羊假不能變成卓毅自己的判斷');
  assert.deepStrictEqual(parsed.callBeasts, ['鼠'], '真偽立場和投票號召應分開');
  assert.deepStrictEqual(parsed.truthStances, [{ beast: '羊', real: true }], 'truthStances 只保存本人立場');
  assert(parsed.quotedClaims.some(x => x.beast === '羊' && x.real === false && x.sourcePlayerIds.includes('yellow')),
    '引用的羊假要保留柚子來源');
  assert(GD.Speech.auditPublicConsistency(quotedAndOwn, room, room.players[1], {}, { ctx: { isGood: true } }).ok,
    '有歷史紀錄支持的他人相反主張，不應被當成本人自相矛盾');

  const contradiction = '我認為【羊】是真品，但【羊】是贗品。';
  assert.strictEqual(GD.Speech.auditPublicConsistency(contradiction, room, room.players[1], {}, { ctx: { isGood: true } }).ok, false,
    '本人同段發言對同一尊作出相反真假判斷應被攔截');

  const internalReport = '目前關於羊的後驗機率是 0.7，來源拆解不應視為獨立驗證。';
  assert.strictEqual(GD.Speech.auditPrivateThoughtLeakage(internalReport).ok, false,
    '後驗、來源拆解及獨立驗證等內部詞彙不得出現在公開台詞');
  assert(GD.Speech.auditPrivateThoughtLeakage('我偏向羊真，但這輪先投鼠。').ok,
    '自然的真假判斷與不同票向可以並存');

  console.log('PASS v10.8.16 dialogue coherence regression: quoted contradiction, own truth stance, separate call, live contradiction guard and internal-language ban.');
  process.exit(0);
} catch (error) {
  console.error('FAIL v10.8.16 dialogue coherence regression:', error.stack || error);
  process.exit(1);
}
