'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const GD = require('./harness')();
const { Claims, Mind, Speech } = GD;
const root = path.join(__dirname, '..');

function makePlayers() {
  return [
    { id: 'bot', name: 'Bot', colorId: 'orange', role: '老朝奉', botId: 'bot', isBot: true, voteBank: 2 },
    { id: 'yao', name: '小明', colorId: 'blue', role: '藥不然', botId: 'yao', isBot: true, voteBank: 2 },
    { id: 'zheng', name: '小華', colorId: 'red', role: '鄭國渠', botId: 'zheng', isBot: true, voteBank: 2 },
    { id: 'fang', name: '阿方', colorId: 'purple', role: '方震', botId: 'fang', isBot: true, voteBank: 2 },
    { id: 'good', name: '好人', colorId: 'white', role: '姬雲浮', botId: 'good', isBot: true, voteBank: 2 },
    { id: 'xu', name: '許願', colorId: 'green', role: '許願', botId: 'xu', isBot: true, voteBank: 2 }
  ];
}
const players = makePlayers();
const rd = {
  roundNum: 1,
  beasts: ['鼠', '牛', '虎', '兔', '猴', '羊'].map(name => ({ name })),
  passOrder: players.map(player => player.id), speechOrder: players.map(player => player.id),
  votes: {}, speeches: [], turnLogs: {}, mind: {}
};
const room = { players, rounds: [rd], currentRoundIdx: 0, personVotes: {} };

// 1. 藥不然攻擊與鄭國渠封印：肯定、假設、否認都保留來源，但不升格成已驗證技能事實。
const yaoHypothesis = Claims.parse('藍色【小明】可能遭藥不然攻擊，這輪【鼠】要再核對。', room, rd, 'bot');
assert(yaoHypothesis.abilityReports.some(item => item.role === '藥不然' && item.kind === 'ambush' &&
  item.stance === 'hypothesis' && item.targetIds.includes('yao') && item.verification === 'unverified'));
const zhengAssertion = Claims.parse('我判斷【牛】本輪確實受到鄭國渠封印影響。', room, rd, 'bot');
assert(zhengAssertion.abilityReports.some(item => item.role === '鄭國渠' && item.kind === 'seal' && item.stance === 'assertion'));
const yaoDenial = Claims.parse('這輪沒有藥不然攻擊。', room, rd, 'bot');
assert(yaoDenial.abilityReports.some(item => item.role === '藥不然' && item.stance === 'denial'));
const ownYaoClaim = Claims.parse('我剛才確實使用藥不然偷襲技能。', room, rd, 'bot');
assert(ownYaoClaim.abilityReports.some(item => item.role === '藥不然' && item.selfAttribution === true));

// 2. 探路票與主票分離；票勢預測只使用主票，兩段承諾仍分開稽核。
const probeAndMain = Claims.parse('我先投【猴】一票作探路，真正決定我投【羊】。', room, rd, 'bot');
assert.deepStrictEqual(probeAndMain.voteProbeTargets, ['猴']);
assert(probeAndMain.voteCommitments.some(item => item.beast === '猴' && item.kind === 'probe'));
assert(probeAndMain.voteCommitments.some(item => item.beast === '羊' && item.kind === 'primary'));
assert.strictEqual(probeAndMain.voteCommitment, '羊');
assert.strictEqual(probeAndMain.voteCommitmentBinding, true);
assert.deepStrictEqual(probeAndMain.speakerCalls, ['羊'], 'the probe target must not masquerade as the main public call');

// 3. 引述他人喊票不會灌進自己的 forecast；否定跟票不會錯標 echo。
const quote = Claims.parse('藍色【小明】剛才主張投【鼠】，我自己暫時改投【虎】。', room, rd, 'bot');
assert.deepStrictEqual(quote.speakerCalls, ['虎']);
assert(quote.quotedCalls.some(item => item.beast === '鼠' && item.sourcePlayerIds.includes('yao')));
const notEcho = Claims.parse('我不跟票，也不是順著大家投。', room, rd, 'bot');
assert(!notEcho.intentTags.some(item => item.type === 'echo-momentum'));

// 4. 社會圖把能力報告當公開未驗證資料，不讀其他人的私人 mind。
const socialRoom = { players, rounds: [{ ...rd, speeches: [
  { playerId: 'bot', speakerName: 'Bot', text: '藍色【小明】可能遭藥不然攻擊，這輪【鼠】要再核對。' }
] }], currentRoundIdx: 0 };
const profile = Object.fromEntries(players.map(player => [player.id, {
  player, evil: 0, ally: 0, knownCamp: null, knownGood: false, knownEvil: false,
  reasons: [], said: [], logits: {}, socialSignals: [], socialPressure: 0, echoSignals: 0
}]));
const graph = Mind.collectSocialIntentGraph({ t: 0, room: socialRoom }, profile);
assert.strictEqual(graph.provenance, 'public-speech-only-no-private-opponent-mind');
assert(graph.abilityReports.some(item => item.role === '藥不然' && item.speakerId === 'bot' && item.verification === 'unverified'));

// 5. 發言稽核確保選定的技能偽裝真的出現在公開台詞中。
const attackPlan = { beast: '鼠', skillCoverStory: { role: '藥不然', beast: '鼠' }, socialTactic: null };
const bot = { ...players[0], role: '老朝奉' };
const actionContext = { ctx: { bot, room, rd, t: 0, genes: { deception: 0.7, camouflage: 0.7 } } };
const missingCover = Speech.auditActionConsistency('我先聽大家怎麼說。', bot, room, attackPlan, actionContext);
assert.strictEqual(missingCover.ok, false, 'missing a selected skill report must fail the action audit');
const includedCover = Speech.auditActionConsistency('我判斷【鼠】本輪確實受到藥不然攻擊影響。', bot, room, attackPlan, actionContext);
assert.strictEqual(includedCover.ok, true);

// 6. The marker palette remains unchanged; simultaneous placement capacity is 24 across rounds and players.
const board = fs.readFileSync(path.join(root, 'js/ui/board.js'), 'utf8');
const start = board.indexOf('  const CHAIN_PERSONAL_MARKERS =');
const end = board.indexOf('  function bindChainMarkerEvents', start);
assert(start >= 0 && end > start, 'marker capacity source block must be discoverable');
const markerApiCode = `${board.slice(start, end)}\nthis.markerAPI = { countChainMarks, saveChainMark, max: MAX_CHAIN_PERSONAL_MARKS };`;
const memory = new Map();
const markerContext = {
  GD: { store: {
    get(key, fallback) { return memory.has(key) ? JSON.parse(JSON.stringify(memory.get(key))) : fallback; },
    set(key, value) { memory.set(key, JSON.parse(JSON.stringify(value))); return true; }
  } }
};
vm.createContext(markerContext);
vm.runInContext(markerApiCode, markerContext);
const markerAPI = markerContext.markerAPI;
assert.strictEqual(markerAPI.max, 24);
const paletteExpected = ['⭕', '❌', '❓', '老', '藥', '鄭', '許', '方', '姬', '木', '黃', '壞', '好'];
for (let i = 0; i < 24; i++) {
  const marker = paletteExpected[i % paletteExpected.length];
  const result = markerAPI.saveChainMark('game', i % 3, `player-${i}`, marker, false);
  assert.strictEqual(result.ok, true, `placement ${i + 1} should be accepted`);
}
assert.strictEqual(markerAPI.countChainMarks(memory.get('game')), 24);
const blocked = markerAPI.saveChainMark('game', 0, 'player-extra', '⭕', false);
assert.strictEqual(blocked.ok, false);
assert.strictEqual(blocked.reason, 'limit');
const freed = markerAPI.saveChainMark('game', 0, 'player-0', '⭕', true);
assert.strictEqual(freed.ok, true);
assert.strictEqual(markerAPI.countChainMarks(memory.get('game')), 23);
assert.strictEqual(markerAPI.saveChainMark('game', 0, 'player-extra', '⭕', false).ok, true,
  'deleting one personal mark must free a slot for the next drag');

// 7. localStorage write failure must not cause reads to resurrect stale marker state.
const utilsSource = fs.readFileSync(path.join(root, 'js/utils.js'), 'utf8');
const stale = JSON.stringify({ old: true });
const fakeStorage = {
  stale,
  getItem(key) { return key === 'marker-fallback-test' ? this.stale : null; },
  setItem() { throw new Error('quota/security failure'); },
  removeItem() { this.stale = null; }
};
const storeContext = { window: { localStorage: fakeStorage }, module: { exports: {} } };
vm.createContext(storeContext);
vm.runInContext(utilsSource, storeContext);
const storeGD = storeContext.module.exports;
assert.strictEqual(storeGD.store.set('marker-fallback-test', { fresh: true }), false);
assert.deepStrictEqual(JSON.parse(JSON.stringify(storeGD.store.get('marker-fallback-test', {}))), { fresh: true },
  'after a failed write, the in-memory latest data must take precedence over stale localStorage');

// 8. Final strategy safety and endgame coordination are explicit in code.
const driver = fs.readFileSync(path.join(root, 'js/bot/driver.js'), 'utf8');
const strategy = fs.readFileSync(path.join(root, 'js/bot/strategy.js'), 'utf8');
assert(driver.includes('最終硬閘') && driver.includes('forced-neutral-fallback'), 'an invalid public tactic must be downgraded before Engine.speak');
assert(strategy.includes('priorGoodTargetSupport') && strategy.includes('ctx.t === 2'), 'endgame public votes should guide good-side target convergence');
assert(strategy.includes('teamAssignment') && strategy.includes('coalition-break'), 'evil tactics should retain role assignment and coalition-breaking metadata');
console.log('PASS v10.9.1 full strategy regression: ability camouflage, public provenance, probe/main commitments, negation, 24 marks, storage fallback, strict speech gate, and endgame vote convergence');
process.exit(0);
