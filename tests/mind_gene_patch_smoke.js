/* Lightweight formula-level smoke tests for the patched mind.js.
 * In the repo: node tests/mind_gene_patch_smoke.js
 * To test a candidate file without replacing production: set MIND_MODULE_PATH.
 */
'use strict';
const assert = require('assert');
const path = require('path');

global.window = global;
const EVIL = new Set(['老朝奉', '藥不然', '鄭國渠']);
global.GD = {
  ROLE_ORDER: ['許願', '方震', '姬雲浮', '黃煙煙', '木戶加奈', '老朝奉', '藥不然', '鄭國渠'],
  isGood: role => !EVIL.has(role),
  U: {
    clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
    sum: values => values.reduce((sum, value) => sum + value, 0),
    nth: index => `第${index + 1}位`,
    tag: p => `【${p && p.name ? p.name : '玩家'}】`,
    round3: x => Math.round(x * 1000) / 1000
  }
};
const modulePath = process.env.MIND_MODULE_PATH
  ? path.resolve(process.env.MIND_MODULE_PATH)
  : path.resolve(__dirname, '../js/bot/mind.js');
const Mind = require(modulePath);

const players = [
  { id: 'p0', botId: 'b0', name: '甲', role: '老朝奉' },
  { id: 'p1', botId: 'b1', name: '乙', role: '藥不然' },
  { id: 'p2', botId: 'b2', name: '丙', role: '鄭國渠' },
  { id: 'p3', botId: 'b3', name: '丁', role: '許願' },
  { id: 'p4', botId: 'b4', name: '戊', role: '方震' },
  { id: 'p5', botId: 'b5', name: '己', role: '姬雲浮' },
  { id: 'p6', botId: 'b6', name: '庚', role: '黃煙煙' },
  { id: 'p7', botId: 'b7', name: '水豚', role: '木戶加奈' }
];
const pass = players.map(p => p.id);

function makeContext({ skepticism = 0.2, conformity = 0.5, source = 'bot', conflict = false, accusation = true } = {}) {
  const bot = players[7];
  const inspect = conflict ? [{ beastName: '鼠', beast: '鼠', displayedReal: true }] : [];
  const callerClaims = conflict ? [{ beast: '鼠', real: false }] : [];
  const speeches = [{
    playerId: 'p0', speakerName: '甲', source,
    p: {
      claims: callerClaims,
      accuse: accusation ? [{ playerId: 'p1', role: '老朝奉' }] : [],
      asked: [], accuseRoles: []
    }, text: '測試發言'
  }];
  const rd = {
    passOrder: pass.slice(),
    turnLogs: { p7: { inspect, blind: false } },
    speeches,
    beasts: ['鼠', '牛', '虎', '兔'].map(name => ({ name })),
    votes: {}
  };
  const room = { currentRoundIdx: 0, players, rounds: [rd] };
  return {
    bot, room, t: 0, rd, pass: pass.slice(), log: rd.turnLogs.p7,
    isGood: true, genes: { skepticism, conformity, deception: 0.5, camouflage: 0.5, assertiveness: 0.5 },
    myPos: 7, myIns: inspect, partner: null, names: rd.beasts.map(b => b.name)
  };
}

// 1) Source labels ('human' vs 'bot') alone must no longer change accusation weight.
const profileHuman = Mind.buildProfiles(makeContext({ source: 'human', accusation: true }));
const profileBot = Mind.buildProfiles(makeContext({ source: 'bot', accusation: true }));
assert.strictEqual(profileHuman.p1.evil, profileBot.p1.evil,
  '真人來源與 Bot 來源不應只因 source 標籤而有不同指控權重');

// 2) Higher skepticism should strengthen the explicit contradiction evidence.
const lowSkeptic = Mind.buildProfiles(makeContext({ skepticism: 0.2, conflict: true, accusation: false }));
const highSkeptic = Mind.buildProfiles(makeContext({ skepticism: 0.8, conflict: true, accusation: false }));
assert(highSkeptic.p0.evil > lowSkeptic.p0.evil,
  '高多疑度應提高具體查驗矛盾的嫌疑權重');

// 3) Posterior baseline trust must not change merely because skepticism changed.
const lowCtx = makeContext({ skepticism: 0.2, conflict: false, accusation: false });
const highCtx = makeContext({ skepticism: 0.8, conflict: false, accusation: false });
const lowPosterior = Mind.posterior(lowCtx, Mind.buildProfiles(lowCtx));
const highPosterior = Mind.posterior(highCtx, Mind.buildProfiles(highCtx));
assert.deepStrictEqual(highPosterior.post, lowPosterior.post,
  '沒有其他證據變化時，skepticism 不應只透過基礎信任值無差別改變後驗');
assert.deepStrictEqual(highPosterior.laoAt, lowPosterior.laoAt,
  '沒有其他證據變化時，skepticism 不應只透過基礎信任值無差別改變老朝奉後驗');

console.log('✓ mind.js 公式級 smoke tests 全部通過');
console.log('  1. 真人／Bot source 標籤不再造成硬編碼指控權重差異');
console.log('  2. 具體矛盾證據在高多疑度下獲得更高嫌疑權重');
console.log('  3. 沒有證據變化時，後驗基礎信任不因 skepticism 單獨改變');
