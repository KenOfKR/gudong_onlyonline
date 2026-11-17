'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Claims, Mind, Tactics, Strategy, Speech, Learning, Engine, U, Genes } = GD;

function players() {
  return [
    { id: 'bot', name: '測試AI', colorId: 'orange', role: '藥不然', botId: 'bot', isBot: true, voteBank: 2 },
    { id: 'partner', name: 'Molly', colorId: 'blue', role: '老朝奉', botId: 'partner', isBot: true, voteBank: 2 },
    { id: 'attacker', name: '攻擊者', colorId: 'black', role: '姬雲浮', botId: 'attacker', isBot: true, voteBank: 2 },
    { id: 'xu', name: '昱全', colorId: 'purple', role: '鄭國渠', botId: 'xu', isBot: true, voteBank: 2 },
    { id: 'kido', name: '順欸', colorId: 'white', role: '木戶加奈', botId: 'kido', isBot: true, voteBank: 2 },
    { id: 'human', name: '真人', colorId: 'red', role: '方震', isBot: false, voteBank: 2 }
  ];
}

try {
  const ps = players();
  const previous = {
    roundNum: 2,
    beasts: ['牛', '羊', '猴', '馬'].map(name => ({ name })),
    passOrder: ps.map(p => p.id), speechOrder: ps.map(p => p.id),
    votes: { xu: { 羊: 2 }, kido: { 羊: 1 } }, speeches: [], turnLogs: {}, mind: {}
  };
  const current = {
    roundNum: 3,
    beasts: ['龍', '雞', '虎', '蛇'].map(name => ({ name })),
    passOrder: ps.map(p => p.id), speechOrder: ps.map(p => p.id),
    votes: {}, speeches: [], turnLogs: {}, mind: {}
  };
  const room = { players: ps, rounds: [{}, previous, current], currentRoundIdx: 2 };

  // P0: a natural "said X true but voted Y" accusation attaches only to the named player.
  const mismatch = Claims.parse('紫色【昱全】說【牛】真，但是跑去投【羊】，壞人！', room, current, 'bot');
  assert(mismatch.playerStances.some(item => item.targetId === 'xu' && item.evidence[0].type === 'claim-ballot-mismatch'),
    'natural-language claim/ballot contradiction should resolve to the named player');
  assert(!mismatch.playerStances.some(item => item.targetId === 'kido'),
    'a co-voter must not inherit another player’s accusation');

  // P0: a follow-vote is the speaker's own commitment; a quoted call remains attributed to its source.
  const followRound = { ...current, beasts: ['牛', '羊', '猴', '馬'].map(name => ({ name })) };
  const follow = Claims.parse('我會跟著她投【牛】。', room, followRound, 'bot');
  assert(follow.voteCommitments.some(item => item.beast === '牛' && item.kind === 'follow'),
    '「我跟著她投」 must be parsed as a personal follow commitment');
  const quoteRound = { ...followRound, beasts: ['豬', '兔', '狗', '牛'].map(name => ({ name })) };
  const quoteRoom = { ...room, rounds: [{}, previous, quoteRound], currentRoundIdx: 2 };
  const quoted = Claims.parse('藍色【Molly】剛才主張投【豬】，我不跟她，我投【兔】。', quoteRoom, quoteRound, 'bot');
  assert.deepStrictEqual(quoted.speakerCalls, ['兔'], 'quoted prior call must not be attributed to the current speaker');
  assert(quoted.quotedCalls.some(item => item.beast === '豬' && item.sourcePlayerIds.includes('partner')),
    'quoted call should retain its original speaker ID');

  // Perception: preserve social intent tags without promoting tone alone to a hard identity fact.
  const hostileText = '我懷疑紫色【昱全】是壞人，沒有其他證據。';
  const hostile = Claims.parse(hostileText, room, followRound, 'attacker');
  assert(hostile.intentTags.some(item => item.type === 'hostility' && item.targetIds.includes('xu') && item.supported === false),
    'unsupported hostility should be tagged with a named target and weak support');
  const bait = Claims.parse('先聽聽紫色【昱全】的理由，再決定要不要跟票。', room, followRound, 'attacker');
  assert(bait.intentTags.some(item => item.type === 'baiting'), 'tentative questioning should create baiting signal');
  assert(bait.intentTags.some(item => item.type === 'echo-momentum'), 'follow/echo language should create echo-momentum signal');

  // Mind: public-only social graph gives bounded weak suspicion, never hard-convicts the actor.
  const socialRound = {
    ...followRound,
    speeches: [{ playerId: 'attacker', speakerName: '攻擊者', text: hostileText }]
  };
  const socialRoom = { players: ps, rounds: [socialRound], currentRoundIdx: 0 };
  const profile = {
    attacker: { evil: 0, ally: 0, knownCamp: null, knownGood: false, knownEvil: false, reasons: [], said: [], logits: {}, socialSignals: [], socialPressure: 0, echoSignals: 0 },
    xu: { evil: 0, ally: 0, knownCamp: 'good', knownGood: true, knownEvil: false, reasons: [], said: [], logits: {}, socialSignals: [], socialPressure: 0, echoSignals: 0 }
  };
  const graph = Mind.collectSocialIntentGraph({ t: 0, room: socialRoom }, profile);
  assert.strictEqual(graph.provenance, 'public-speech-only-no-private-opponent-mind');
  assert(profile.attacker.evil > 0 && profile.attacker.evil <= 3.2, 'unsupported attacks add only bounded weak suspicion');
  assert.strictEqual(profile.attacker.knownEvil, false, 'tone alone must never hard-confirm evil');
  assert(graph.signals.some(item => item.type === 'hostility' && item.targetIds.includes('xu')));

  // Tactics: a known partner under public attack can trigger a decoy plan without exposing partner identity.
  const tacticPlayers = ps.map(p => ({ ...p }));
  const tacticRound = {
    roundNum: 1, beasts: ['狗', '馬', '豬', '羊'].map(name => ({ name })),
    speeches: [], votes: {}, turnLogs: {}, mind: {},
    passOrder: tacticPlayers.map(p => p.id), speechOrder: tacticPlayers.map(p => p.id)
  };
  const tacticRoom = { players: tacticPlayers, rounds: [tacticRound], currentRoundIdx: 0 };
  const tacticA = {
    ctx: { bot: tacticPlayers[0], room: tacticRoom, rd: tacticRound, t: 0, myPos: 1, partner: tacticPlayers[1] },
    post: [
      { name: '狗', pReal: 0.20 }, { name: '馬', pReal: 0.80 },
      { name: '豬', pReal: 0.25 }, { name: '羊', pReal: 0.70 }
    ],
    socialGraph: { signals: [{ type: 'hostility', speakerId: 'attacker', targetIds: ['partner'], confidence: 0.90, round: 1, evidenceCount: 0, supported: false }] },
    prof: {}
  };
  const socialTactic = Tactics.chooseSocialTactic(tacticRoom, tacticPlayers[0], tacticA, {});
  assert(socialTactic && socialTactic.mode === 'decoy' && socialTactic.focus === 'attack');
  assert.strictEqual(socialTactic.targetId, 'attacker');
  assert(!JSON.stringify(socialTactic).includes('partner'), 'public decoy directive must not reveal the hidden partner ID');

  // Expression: attack focus filters unrelated inspection reporting and requires naming the target.
  const attackBot = { ...tacticPlayers[0], role: '姬雲浮' };
  const attackPlan = {
    beast: '狗', claims: [{ beast: '狗', real: true }, { beast: '馬', real: false }],
    socialTactic: { ...socialTactic, targetId: 'attacker', targetBeast: '狗' },
    dialogueFocus: null
  };
  const attackA = { ctx: { bot: attackBot, room: tacticRoom, rd: tacticRound, t: 0, genes: { assertiveness: 0.9, camouflage: 0.2, skepticism: 0.7 } } };
  const focus = Strategy.deriveDialogueFocus(attackBot, tacticRoom, attackPlan, attackA);
  attackPlan.dialogueFocus = focus;
  assert.strictEqual(focus.type, 'suspect_pressure');
  assert.strictEqual(focus.targetId, 'attacker');
  const selected = Speech.focusDrivenSelectParts([
    '我想請黑色【攻擊者】說明一下：你剛才把疑點指向別人，提出的獨立證據是哪一筆？',
    '我的查驗結果是【狗】真品。',
    '另外【馬】是贗品，這也要一起報告。',
    '我投【狗】。'
  ], attackPlan, attackBot, tacticRoom, attackA.ctx);
  assert(selected.join('').includes('黑色【攻擊者】'));
  assert(!selected.join('').includes('【馬】是贗品'), 'attack focus should not append an unrelated second inspection');
  const invalidAttack = Speech.auditActionConsistency('我這輪投【狗】。', attackBot, tacticRoom, attackPlan, attackA);
  assert.strictEqual(invalidAttack.ok, false, 'action validator catches an attack line that omits its selected target');
  const validAttack = Speech.auditActionConsistency('黑色【攻擊者】請先交代你的獨立證據，我投【狗】。', attackBot, tacticRoom, attackPlan, attackA);
  assert.strictEqual(validAttack.ok, true);
  assert.strictEqual(Speech.normalizeRepeatedAttribution('紫色【昱全】：紫色【昱全】認為牛是真品。'),
    '紫色【昱全】：認為牛是真品。', 'repeated player attribution labels should be collapsed');

  // Forecast calibration: repeated prior prediction errors widen this Bot's uncertainty, with a strict cap.
  function historicalForecastRound(roundNum, predicted, actualTop) {
    const round = { roundNum, beasts: ['狗', '馬', '豬', '羊'].map(name => ({ name })), votes: {},
      voteResults: { rank1: { name: actualTop[0] }, rank2: { name: actualTop[1] } }, mind: {} };
    round.mind.bot = { voteForecast: { ranking: predicted.map(([name, expectedVotes]) => ({ name, expectedVotes })) } };
    round.votes.v1 = { [actualTop[0]]: 4 };
    round.votes.v2 = { [actualTop[1]]: 3 };
    return round;
  }
  const calibrationRoom = { players: tacticPlayers, currentRoundIdx: 1, rounds: [
    historicalForecastRound(1, [['狗', 7], ['馬', 0], ['豬', 0], ['羊', 0]], ['豬', '羊']),
    historicalForecastRound(2, [['馬', 6], ['狗', 1], ['豬', 0], ['羊', 0]], ['羊', '豬'])
  ] };
  const calibration = Tactics.forecastCalibration(calibrationRoom, 'bot');
  assert.strictEqual(calibration.samples, 2, 'two completed own forecasts should form a calibration sample');
  assert(calibration.varianceInflation > 1 && calibration.varianceInflation <= 1.28,
    'repeated forecast error should conservatively inflate variance, capped at 28 percent');

  // Action contracts: Fang cannot invent a beast inspection, and planned blindness disclosure must be spoken.
  const fang = { ...tacticPlayers[0], role: '方震' };
  const fangA = { ctx: { isGood: true, rd: tacticRound } };
  assert.strictEqual(Speech.auditActionConsistency('【狗】是真品，我投【狗】。', fang, tacticRoom,
    { beast: '狗', fakeFangClaim: null, revealFang: false }, fangA).ok, false);
  assert.strictEqual(Speech.auditActionConsistency('我投【狗】。', attackBot, tacticRoom,
    { beast: '狗', revealBlind: true }, attackA).ok, false);

  // Retired fixed frame: an old saved turn flag no longer forces the scripted direct pass;
  // normal Yao pass evaluation still selects a legal candidate using exposure/position values.
  const legacyPlayers = [
    { id: 'first', name: '先手', role: '姬雲浮', isBot: true, botId: 'first' },
    { id: 'second', name: '第二', role: '黃煙煙', isBot: true, botId: 'second' },
    { id: 'yao', name: '藥不然', role: '藥不然', isBot: true, botId: 'yao' },
    { id: 'partner', name: '老朝奉', role: '老朝奉', isBot: true, botId: 'partner' },
    { id: 'victim', name: '受害者', role: '姬雲浮', isBot: true, botId: 'victim' },
    { id: 'other', name: '其他', role: '木戶加奈', isBot: true, botId: 'other' }
  ];
  const legacyRound = {
    roundNum: 1, beasts: ['鼠', '兔', '狗', '豬'].map(name => ({ name })),
    passOrder: ['first', 'second', 'yao'], speechOrder: [], speeches: [], votes: {}, mind: {},
    turnLogs: { yao: { inspect: [], ambushIds: ['victim'], ambushTargetId: 'victim', ambushFrameTactic: true } }
  };
  const legacyRoom = { players: legacyPlayers, rounds: [legacyRound], currentRoundIdx: 0, roomId: 'V109_LEGACY_FRAME' };
  const yao = legacyPlayers[2];
  const legacyA = {
    ctx: Mind.context(yao, legacyRoom),
    prof: Object.fromEntries(legacyPlayers.filter(p => p.id !== 'yao').map(p => [p.id, { evil: 0, ally: 0, probs: {} }]))
  };
  const legacyPick = Strategy.nextPlayer(yao, legacyRoom, legacyA);
  assert(legacyRoom.players.some(p => p.id === legacyPick), 'ordinary ambush pass choice remains a legal player');
  assert.notStrictEqual(legacyPick, 'victim', 'legacy fixed ambushFrameTactic must not force a direct pass to its victim');

  // Learning: first-game personality changes are significantly damped compared with mature samples.
  const learningRoom = Engine.newRoom('V109_LEARNING_DAMP', 'human');
  Engine.addPlayer(learningRoom, { id: 'human', name: '真人' });
  Engine.fillBots(learningRoom);
  assert(Engine.start(learningRoom));
  learningRoom.gameOver = { xuWon: true, goodCount: 5, votesForLao: 0, laoCaught: false, fangCaught: false, xuCaught: false, fangSurvives: true };
  learningRoom.personVotes = {};
  const learningBot = learningRoom.players.find(p => p.isBot && GD.isGood(p.role));
  assert(learningBot);
  const originalRecord = Genes.record;
  try {
    Genes.record = id => ({ ...originalRecord(id), games: 0 });
    const firstGameLr = Learning.evaluate(learningRoom, learningBot).lr;
    Genes.record = id => ({ ...originalRecord(id), games: 4 });
    const matureLr = Learning.evaluate(learningRoom, learningBot).lr;
    assert(firstGameLr < matureLr && firstGameLr <= 0.50, 'low-sample learning rate must be damped');
  } finally {
    Genes.record = originalRecord;
  }

  console.log('PASS v10.9 focus-tactics architecture: social intent/provenance, named accusation, vote follow attribution, coalition decoy, single-focus expression, forecast calibration, attribution cleanup, action validation and low-sample learning.');
  process.exit(0);
} catch (error) {
  console.error('FAIL v10.9 focus-tactics architecture:', error.stack || error);
  process.exit(1);
}
