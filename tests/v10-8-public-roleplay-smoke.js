'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const Strategy = GD.Strategy;
const Speech = GD.Speech;
const DialogueBank = GD.DialogueBank;
const { Engine, Mind, Claims, U } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  return room;
}


try {
  assert(Strategy && typeof Strategy.chooseCounterfeitTarget === 'function', 'Strategy must expose counterfeit target selection');
  assert(Strategy && typeof Strategy.buildRoleBluffPool === 'function', 'Strategy must expose role bluff pool');
  assert(Strategy && typeof Strategy.enforcePublicTargetAnchor === 'function', 'Strategy must expose public-target vote anchor');
  assert(Speech && typeof Speech.buildPublicPerformanceContract === 'function', 'Speech must expose public performance contract');
  assert(Speech && typeof Speech.auditPublicPerformanceClaim === 'function', 'Speech must expose testable public-performance validation');

  // Even if the old plan preferred a known real artifact, confession must pivot to a confirmed fake.
  const targetWithKnownFake = Strategy.chooseCounterfeitTarget(
    [
      { beastName: '龍', displayedReal: true },
      { beastName: '虎', displayedReal: false }
    ],
    [{ name: '龍', pReal: 0.98 }, { name: '虎', pReal: 0.02 }],
    '龍'
  );
  assert.strictEqual(targetWithKnownFake, '虎', 'must never pick a known true artifact when a fake is known');

  // If no fake was inspected, choose the least likely real artifact excluding any confirmed true item.
  const targetByPosterior = Strategy.chooseCounterfeitTarget(
    [{ beastName: '龍', displayedReal: true }],
    [
      { name: '龍', pReal: 0.99 },
      { name: '虎', pReal: 0.10 },
      { name: '兔', pReal: 0.20 },
      { name: '蛇', pReal: 0.70 }
    ],
    '龍'
  );
  assert.strictEqual(targetByPosterior, '虎', 'fallback target should be the lowest-pReal non-confirmed item');
  const noCounterfeitAvailable = Strategy.chooseCounterfeitTarget(
    [{ beastName: '龍', displayedReal: true }, { beastName: '虎', displayedReal: true }],
    [{ name: '龍', pReal: 0.99 }, { name: '虎', pReal: 0.98 }],
    '龍'
  );
  assert.strictEqual(noCounterfeitAvailable, null, 'must not fall back to a confirmed real item when no counterfeit target is eligible');

  const splitAnchor = Strategy.enforcePublicTargetAnchor({ 龍: 2, 兔: 1 }, '虎', 3);
  assert.deepStrictEqual(splitAnchor, { 龍: 1, 兔: 1, 虎: 1 }, 'public claim must receive one anchor vote while preserving split allocation');
  assert.strictEqual(Object.values(splitAnchor).reduce((sum, votes) => sum + votes, 0), 3, 'vote anchoring must not create extra chips');
  const trimmedAnchor = Strategy.enforcePublicTargetAnchor({ 龍: 3, 兔: 2 }, '虎', 3);
  assert.strictEqual(Object.values(trimmedAnchor).reduce((sum, votes) => sum + votes, 0), 3, 'overflow normalization must respect available chips');
  assert.strictEqual(trimmedAnchor.虎, 1, 'overflow normalization must preserve one public-target vote');
  assert(Object.keys(trimmedAnchor).length >= 2, 'overflow normalization should preserve split allocation when possible');
  assert.deepStrictEqual(Strategy.enforcePublicTargetAnchor({}, '虎', 3), { 虎: 1 }, 'empty optimizer output must not dump all chips on target');
  const existingAnchor = Strategy.enforcePublicTargetAnchor({ 虎: 1, 龍: 2 }, '虎', 3);
  assert.deepStrictEqual(existingAnchor, { 虎: 2, 龍: 1 }, 'the public target must be at least joint-largest while preserving the split ballot');
  for (const [ballot, target, maxSpend] of [
    [{ 龍: 4, 兔: 2 }, '虎', 4],
    [{ 虎: 1, 龍: 3, 兔: 2 }, '虎', 4],
    [{ 兔: 1, 龍: 1 }, '虎', 2]
  ]) {
    const result = Strategy.enforcePublicTargetAnchor(ballot, target, maxSpend);
    assert(Object.values(result).reduce((sum, votes) => sum + votes, 0) <= maxSpend,
      'anchoring must never create chips beyond the spend limit');
    assert((result[target] || 0) >= Math.max(0, ...Object.entries(result).filter(([name]) => name !== target).map(([, votes]) => votes)),
      'public target must be at least a joint-largest vote allocation');
  }

  const goodPool = Strategy.buildRoleBluffPool({ role: '許願' }, { isGood: true });
  assert(!goodPool.some(role => GD.ROLES && GD.ROLES[role] && GD.ROLES[role].camp === 'evil'),
    'good bots must not randomly fake-claim an evil role');
  const evilPool = Strategy.buildRoleBluffPool({ role: '老朝奉' }, { isGood: false });
  assert(evilPool.includes('藥不然') || evilPool.includes('鄭國渠'),
    'evil bots may still make strategic claims as another evil role');


  const contradictoryPerformance = Speech.auditPublicPerformanceClaim(
    { confess: true, beast: '虎' },
    [{ beast: '虎', real: true }],
    ['虎']
  );
  assert.strictEqual(contradictoryPerformance.ok, false, 'confessing player must not publicly call the target genuine');

  const alignedPerformance = Speech.auditPublicPerformanceClaim(
    { evilRolePerformance: true, beast: '虎' },
    [{ beast: '虎', real: false }],
    ['虎']
  );
  assert.strictEqual(alignedPerformance.ok, true, 'counterfeit claim and call must align on the same target');

  const splitTargetPerformance = Speech.auditPublicPerformanceClaim(
    { confess: true, beast: '虎' },
    [{ beast: '虎', real: false }],
    ['龍']
  );
  assert.strictEqual(splitTargetPerformance.ok, false, 'the public call must not drift to another beast');

  const confessionContract = Speech.buildPublicPerformanceContract({ confess: true, beast: '虎' }, { role: '藥不然' });
  assert(confessionContract.includes('認壞'), 'confession contract should allow the public confession');
  assert(confessionContract.includes('【虎】是贗品'), 'confession contract must bind the speech to a counterfeit target');
  assert(confessionContract.includes('不得把私密查驗結果全部攤開'), 'confession contract must protect private inspections');
  assert(confessionContract.includes('不能直接當台詞'), 'private thoughts must not be spoken verbatim');

  const evilPerformanceContract = Speech.buildPublicPerformanceContract(
    { evilRolePerformance: true, roleBluff: { role: '藥不然' }, beast: '虎' },
    { role: '老朝奉' }
  );
  assert(evilPerformanceContract.includes('【藥不然】'), 'role-play contract must preserve the public role performance');
  assert(evilPerformanceContract.includes('【虎】是贗品'), 'role-play contract must bind the stated target');
  assert(evilPerformanceContract.includes('號召把票投向同一尊'), 'role-play contract must bind vote direction');
  assert(evilPerformanceContract.includes('不要照讀內心計畫'), 'role-play contract must distinguish inner plans from public lines');

  // The language model must receive only the filtered public-facing brief, never raw private identity/scan data.
  const promptRoom = makeRoom('PUBLIC_ONLY_PROMPT');
  const evilBot = promptRoom.players.find(player => player.isBot && !GD.isGood(player.role));
  assert(evilBot, 'test room must contain an evil bot');
  const seeded = Strategy.plan(evilBot, promptRoom);
  const promptAnalysis = seeded.A;
  promptAnalysis.ctx.partner = { id: 'private-partner-id', name: '秘密同伴_SENTINEL', role: '藥不然' };
  promptAnalysis.ctx.log.inspect = [{ resultText: '私密查驗_SENTINEL', beastName: '鼠', displayedReal: true }];
  promptAnalysis.ctx.log.fangTargetId = '私密方震目標_SENTINEL';
  promptAnalysis.ctx.log.fangCamp = 'evil';
  promptAnalysis.topSuspect = { player: { name: '私密嫌疑人_SENTINEL' }, p: 0.999 };
  promptAnalysis.post = [{ name: '私密後驗獸首_SENTINEL', pReal: 0.999 }];
  promptAnalysis.prof[evilBot.id] = { conflicts: [{ round: 1, beast: '私密衝突獸首_SENTINEL' }] };
  const currentTarget = U.curRound(promptRoom).beasts[0].name;
  const publicOnlyPlan = {
    ...seeded.plan,
    beast: currentTarget,
    claims: [{ beast: currentTarget, real: false }],
    roleBluff: null,
    fakeFangClaim: null,
    confess: false,
    evilRolePerformance: false,
    trueRoleSignal: null,
    withholdInfo: false,
    withholdClaims: [],
    tacticalLine: '私密戰術推演_SENTINEL：我需要建立可信度與轉移焦點。'
  };
  const publicOnlyPrompt = Speech.buildPrompt(evilBot, promptRoom, publicOnlyPlan, promptAnalysis);
  [evilBot.role, '秘密同伴_SENTINEL', '私密查驗_SENTINEL', '私密方震目標_SENTINEL',
    '私密嫌疑人_SENTINEL', '私密後驗獸首_SENTINEL', '私密衝突獸首_SENTINEL', '私密戰術推演_SENTINEL']
    .forEach(secret => assert(!publicOnlyPrompt.includes(secret), `prompt must not expose private value: ${secret}`));
  assert(publicOnlyPrompt.includes(`核准公開判斷：【${currentTarget}】假`), 'prompt should include the approved public claim');
  assert(publicOnlyPrompt.includes('目前沒有可回應的前手發言'), 'first speaker should not be instructed to answer a nonexistent prior speaker');

  const publicBluffRole = evilBot.role === '藥不然' ? '老朝奉' : '藥不然';
  const rolePerformancePrompt = Speech.buildPrompt(evilBot, promptRoom, {
    ...publicOnlyPlan,
    evilRolePerformance: true,
    roleBluff: { role: publicBluffRole },
    claims: [{ beast: currentTarget, real: false }]
  }, promptAnalysis);
  assert(rolePerformancePrompt.includes(`本輪對外身分說法：我是【${publicBluffRole}】`), 'prompt should include only the selected public role persona');
  assert(!rolePerformancePrompt.includes(evilBot.role), 'role-performance prompt must not expose the actual role');
  assert(Speech.auditPrivateThoughtLeakage('我需要建立可信度，再用內部策略轉移焦點。').ok === false,
    'private strategy language should be rejected as public dialogue');
  assert(Speech.auditPrivateThoughtLeakage('我懷疑他前後說法不一致，所以這輪先投【虎】。').ok === true,
    'ordinary player reasoning should remain valid public dialogue');

  // Deterministic local fallback must confess + identify the counterfeit + call the same target.
  const confessionPlan = {
    ...seeded.plan,
    mode: 'confess', confess: true, evilRolePerformance: false,
    beast: currentTarget, claims: [{ beast: currentTarget, real: false }],
    roleBluff: null, fakeFangClaim: null, explain: null,
    withholdInfo: false, withheldClaims: [], avoid: [],
    askId: null, suspectId: null, trueRoleSignal: null, xuYuanLine: null,
    tacticalLine: '私密戰術句_SENTINEL：若預估票差只有 0，則要重新衡量追加成本。'
  };
  promptAnalysis.ctx.isGood = false;
  const localConfession = Speech.localSpeech(evilBot, promptRoom, confessionPlan, promptAnalysis);
  const parsedConfession = Claims.parse(localConfession, promptRoom, U.curRound(promptRoom));
  assert(localConfession.includes('我認壞'), 'local fallback should include the public confession');
  assert(parsedConfession.claims.some(claim => claim.beast === currentTarget && claim.real === false),
    'local confession must explicitly call the shared target counterfeit');
  assert(parsedConfession.callBeasts.includes(currentTarget), 'local confession must call votes toward the same counterfeit');
  assert(!localConfession.includes('私密戰術句_SENTINEL') && !localConfession.includes('預估票差'),
    'internal tactical scoring lines must never be appended to public dialogue');
  assert(Speech.auditPublicPerformanceClaim(confessionPlan, parsedConfession.claims, parsedConfession.callBeasts).ok,
    'local fallback must pass the public-performance audit');

  const bluffIdentity = evilBot.role === '藥不然' ? '老朝奉' : '藥不然';
  const rolePerformancePlan = {
    ...confessionPlan,
    mode: 'camouflage', confess: false, evilRolePerformance: true,
    roleBluff: { role: bluffIdentity, persist: false, fakeConfess: false },
    claims: [{ beast: currentTarget, real: false }]
  };
  const localRolePerformance = Speech.localSpeech(evilBot, promptRoom, rolePerformancePlan, promptAnalysis);
  const parsedRolePerformance = Claims.parse(localRolePerformance, promptRoom, U.curRound(promptRoom));
  assert(localRolePerformance.includes(`我是${bluffIdentity}`), 'local role-play should retain its selected public identity claim');
  assert(!localRolePerformance.includes(evilBot.role), 'local role-play must not name the actual role');
  assert(parsedRolePerformance.claims.some(claim => claim.beast === currentTarget && claim.real === false),
    'local role-play must call the target counterfeit');
  assert(parsedRolePerformance.callBeasts.includes(currentTarget), 'local role-play must call votes toward the same target');
  assert(Speech.auditPublicPerformanceClaim(rolePerformancePlan, parsedRolePerformance.claims, parsedRolePerformance.callBeasts).ok,
    'local role-play must pass the public-performance audit');

  // Exercise the actual ballot finalizer: it preserves split votes, but the public target is the main direction.
  const voteRound = U.curRound(promptRoom);
  const voteMind = {
    mode: 'confess', confess: true, evilRolePerformance: false, beast: currentTarget,
    post: [{ name: currentTarget, p: 0.9 }], actualBallot: null
  };
  voteRound.mind[evilBot.id] = voteMind;
  evilBot.voteBank = 3;
  const originalOptimizeBallot = GD.Tactics.optimizeBallot;
  GD.Tactics.optimizeBallot = () => ({ ballot: { 龍: 2, 兔: 1 }, diagnostic: { test: true } });
  let actualBallot;
  try { actualBallot = Strategy.ballot(evilBot, promptRoom); }
  finally { GD.Tactics.optimizeBallot = originalOptimizeBallot; }
  assert.strictEqual(Object.values(actualBallot).reduce((sum, votes) => sum + votes, 0), 3,
    'final vote must preserve the three-chip spend limit');
  assert((actualBallot[currentTarget] || 0) >= Math.max(0, ...Object.entries(actualBallot).filter(([name]) => name !== currentTarget).map(([, votes]) => votes)),
    'final vote must make the public counterfeit target a joint-largest allocation');
  assert.deepStrictEqual(voteMind.actualBallot, actualBallot, 'saved actualBallot must match the final anchored ballot');
  evilBot.voteBank = 0;
  assert.deepStrictEqual(Strategy.ballot(evilBot, promptRoom), {}, 'zero vote bank must remain a valid abstention');

  assert.strictEqual(DialogueBank.count(), 1068, 'dialogue bank must remain at exactly 1,068 lines');
  assert.strictEqual(DialogueBank.categories().length, 49, 'dialogue bank must retain 49 categories');
  console.log('v10.8.1 公開表演與贗品目標一致性測試通過：認壞選贗品、跳壞票向契約、好人偽裝池與內心台詞分層；1,068 條台詞／49 類保持不變');
  process.exit(0);
} catch (err) {
  console.error('v10.8.1 公開表演回歸測試失敗：', err.stack || err.message || err);
  process.exit(1);
}
