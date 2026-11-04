'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, Claims, Mind, Speech, Strategy } = GD;

function makeRoom() {
  const room = Engine.newRoom('HUMAN_ATTENTION_REGRESSION', 'human');
  Engine.addPlayer(room, { id: 'human', name: '歪ㄟ恩' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  const roster = [
    ['歪ㄟ恩', '方震'], ['Molly', '老朝奉'], ['阿泰', '藥不然'], ['皓鈞', '鄭國渠'],
    ['Abby', '許願'], ['源阿', '姬雲浮'], ['隻貓', '黃煙煙'], ['黃煙煙', '木戶加奈']
  ];
  room.players.forEach((p, i) => {
    [p.name, p.role] = roster[i];
    p.genes = { skepticism: 0.6, deception: 0.5, camouflage: 0.5, assertiveness: 0.5, conformity: 0.5 };
  });
  const r1 = room.rounds[0];
  r1.roundNum = 1;
  r1.beasts = ['羊', '馬', '鼠', '牛'].map(name => ({ name, isReal: name !== '羊' }));
  const molly = room.players.find(p => p.name === 'Molly');
  const hao = room.players.find(p => p.name === '皓鈞');
  r1.votes = { [molly.id]: { 羊: 1 }, [hao.id]: { 羊: 1 } };
  r1.voteResults = { rank1: { name: '馬', isReal: true }, rank2: { name: '羊', isReal: false } };

  const r2 = {
    ...r1,
    roundNum: 2,
    beasts: ['馬', '蛇', '鼠', '牛'].map((name, i) => ({ name, isReal: i !== 2 })),
    passOrder: room.players.map(p => p.id),
    speechOrder: room.players.map(p => p.id),
    speeches: [], votes: {}, voteResults: null, turnLogs: {}, mind: {}
  };
  room.rounds.push(r2);
  room.currentRoundIdx = 1;
  return { room, r1, r2, molly, hao,
    human: room.players.find(p => p.name === '歪ㄟ恩'),
    abby: room.players.find(p => p.name === 'Abby'),
    atai: room.players.find(p => p.name === '阿泰') };
}

try {
  const { room, r1, r2, molly, hao, human, abby, atai } = makeRoom();
  const byName = name => room.players.find(p => p.name === name);

  // R2: keep the horse verdict, but don't misread the prior-round sheep discussion as a current sheep verdict/call.
  const r2Text = '【馬】真，上一輪投羊的很壞，我都說【羊】假了，還硬投，黃色【皓鈞】紅色【Molly】都壞人！';
  const r2Parsed = Claims.parse(r2Text, room, r2);
  assert.deepStrictEqual(r2Parsed.claims, [{ beast: '馬', real: true }], 'only the current 馬 verdict should be parsed');
  assert.deepStrictEqual(r2Parsed.playerStances.map(x => x.targetId).sort(), [hao.id, molly.id].sort(),
    'both named suspects must survive human speech parsing');
  for (const stance of r2Parsed.playerStances) {
    assert.strictEqual(stance.camp, 'evil');
    assert(stance.evidence.some(x => x.type === 'direct-public-stance'));
    assert(stance.evidence.some(x => x.type === 'historical-vote' && x.round === 1 && x.beast === '羊' && x.votes === 1),
      'historical ballots must be attached to each accused voter');
  }
  assert.strictEqual(r2Parsed.voteAvoids.length, 0, 'historical wording must not become a current vote prohibition');

  // A BOT paraphrasing a previous speaker in second person must not inherit the quoted claims as its own.
  const attributedTwoBeasts = `綠色【源阿】：你點名白色【黃煙煙】壞人嫌疑；你主張【馬】真品、【牛】贗品；我會納入本輪判斷。我公開判斷【馬】贗品。`;
  const attributedTwoBeastsParsed = Claims.parse(attributedTwoBeasts, room, r2);
  assert.deepStrictEqual(attributedTwoBeastsParsed.claims, [{ beast: '馬', real: false }],
    'second-person attribution and comma/list continuation must not be counted as the current speaker’s own claims');

  // Mind must actually consume playerStances; unverified public accusations remain weak, not hard truth.
  r2.speeches = [{ playerId: human.id, speakerName: human.name, source: 'human', text: r2Text, p: r2Parsed }];
  const mindR2 = Mind.analyze(abby, room);
  for (const target of [hao, molly]) {
    const profile = mindR2.prof[target.id];
    assert(profile && profile.evil > 0, `${target.name} should receive a weak public suspicion signal`);
    assert(profile.reasons.some(reason => reason.includes('歪ㄟ恩') && reason.includes('公開判斷') && reason.includes('第1輪投【羊】1票')),
      `${target.name} must retain the speaker and historical vote provenance in reasoning`);
    assert.strictEqual(profile.knownEvil, false, 'a public accusation must never become confirmed guilt');
  }

  // A later BOT comment about the beast must not bury the human's unanswered player accusations.
  r2.speeches.push({ playerId: atai.id, speakerName: atai.name, source: 'bot',
    text: '黑色【歪ㄟ恩】剛才說【馬】是真品，我也認為【馬】是真品。',
    p: Claims.parse('黑色【歪ㄟ恩】剛才說【馬】是真品，我也認為【馬】是真品。', room, r2) });
  const threadR2 = Speech.latestPublicThread(room, r2, abby);
  assert.strictEqual(threadR2.speech.playerId, human.id, 'unanswered human issues must outrank a later unrelated BOT speech');
  assert.deepStrictEqual(threadR2.unanswered.stances.map(x => x.targetId).sort(), [hao.id, molly.id].sort());
  assert(threadR2.directive.includes('皓鈞') && threadR2.directive.includes('Molly') && threadR2.directive.includes('第1輪'));
  const compactR2 = Speech.compactPublicReply(threadR2, abby, {});
  assert(compactR2.includes('皓鈞') && compactR2.includes('Molly') && compactR2.includes('第1輪投【羊】1票'));
  assert(Speech.publicResponseAudit(compactR2, threadR2, abby, {}).ok,
    'compact fallback must explicitly preserve both accusations and their provenance');

  // A true Fang Zhen may quote another speaker's public role discussion without leaking its own role.
  assert.strictEqual(Speech.disclosesFangIdentity('黃色【皓鈞】：你公開提出【方震】角色版本，我會核對技能時點。'), false,
    'attributed quotation of another player mentioning Fang Zhen must not be treated as self-disclosure');
  assert.strictEqual(Speech.disclosesFangIdentity('我身為方震，這輪不能公開自己的查驗。'), true,
    'a first-person Fang Zhen identity statement must still be blocked');
  assert.strictEqual(Speech.disclosesFangIdentity('我的角色是方震。'), true,
    'an explicit statement of the speaker role must be blocked');
  assert.strictEqual(Speech.disclosesFangIdentity('我真正的身分是方震。'), true,
    'a true-role statement using a longer identity phrase must be blocked');
  assert.strictEqual(Speech.disclosesFangIdentity('我認為方震玩家需要解釋技能時點。'), false,
    'a general discussion about Fang Zhen must not be treated as a self-claim');

  // R3: parse player accusations, role attribution, role comparison, and explicit beast vote-avoid instruction.
  const r3Text = '靠北，【木戶加奈】跟【黃煙煙】不是一樣嗎?藍色很好笑，壞人應該是綠色【Abby】黃色【皓鈞】吧，老朝奉我認為是黃色【皓鈞】嗎?【鼠】假，鼠不能投！';
  const r3Parsed = Claims.parse(r3Text, room, r2);
  assert.deepStrictEqual(r3Parsed.claims, [{ beast: '鼠', real: false }]);
  assert.deepStrictEqual(r3Parsed.playerStances.map(x => x.targetId).sort(), [abby.id, hao.id].sort());
  assert(r3Parsed.roleClaims.some(x => x.playerId === hao.id && x.role === '老朝奉' && x.polarity === 'claim'));
  assert(r3Parsed.roleComparisons.some(x => x.roles.includes('木戶加奈') && x.roles.includes('黃煙煙')));
  assert.deepStrictEqual(r3Parsed.voteAvoids, ['鼠'], '「鼠不能投」 must be retained as a current vote-avoid instruction');
  assert(!r3Parsed.callBeasts.includes('鼠') && !r3Parsed.voteCommitments.some(x => x.beast === '鼠'),
    'a vote prohibition must not be inverted into a positive vote commitment');

  r2.speeches = [{ playerId: human.id, speakerName: human.name, source: 'human', text: r3Text, p: r3Parsed }];
  const threadR3 = Speech.latestPublicThread(room, r2, molly);
  assert.deepStrictEqual(threadR3.unanswered.voteAvoids, ['鼠']);
  assert(threadR3.directive.includes('不可投【鼠】') || threadR3.directive.includes('不要投【鼠】'));
  assert(threadR3.directive.includes('木戶加奈') && threadR3.directive.includes('黃煙煙'));
  assert(threadR3.directive.includes('皓鈞') && threadR3.directive.includes('Abby'));

  const planResult = Strategy.plan(molly, room);
  const prompt = Speech.buildPrompt(molly, room, planResult.plan, planResult.A);
  assert(prompt.includes('木戶加奈') && prompt.includes('黃煙煙') && prompt.includes('不同角色卡'),
    'Gemini prompt must contain the real rule-level answer to the role comparison');
  assert(prompt.includes('不可投【鼠】') || prompt.includes('不要投【鼠】'),
    'Gemini prompt must preserve the explicit vote-avoid instruction');

  const compactR3 = Speech.compactPublicReply(threadR3, molly, planResult.plan);
  assert(compactR3.length > 0, 'compact human response must retain the full set of substantive human issues');
  assert(compactR3.includes('皓鈞') && compactR3.includes('Abby'));
  assert(compactR3.includes('老朝奉'));
  assert(compactR3.includes('木戶加奈') && compactR3.includes('黃煙煙') && compactR3.includes('不同角色卡'));
  assert(compactR3.includes('許願陣營') && compactR3.includes('隨機 1 輪無法查驗'),
    'the role comparison must answer that the cards differ but share camp and skill label');
  assert(compactR3.includes('不可投【鼠】'), 'the fallback must mention the mouse vote prohibition');
  assert(Speech.publicResponseAudit(compactR3, threadR3, molly, planResult.plan).ok,
    'compact response audit must verify each major human topic');

  const local = Speech.localSpeech(molly, room, planResult.plan, planResult.A);
  assert(local.length > 0, 'final local fallback must retain substantive facts without a hard character cap');
  assert(local.includes('歪ㄟ恩') && local.includes('皓鈞') && local.includes('Abby'));
  assert(local.includes('不同角色卡') && local.includes('許願陣營') && local.includes('隨機 1 輪無法查驗'));
  assert(local.includes('不可投【鼠】'));
  assert(Speech.publicResponseAudit(local, threadR3, molly, planResult.plan).ok,
    'final local fallback, not only the intermediate parser, must pass human-topic audit');

  const vagueReply = `${threadR3.tag}我有聽到你的話，必須說明兩張角色卡不同。`;
  assert.strictEqual(Speech.publicResponseAudit(vagueReply, threadR3, molly, planResult.plan).ok, false,
    'a vague acknowledgement without target/camp/skill facts must fail the response audit');

  console.log('真人發言注意力回歸通過：R2 雙人指控＋歷史票型、Mind 弱證據整合、BOT 不得遮蔽未回應真人、R3 角色比較／陣營技能事實／票向禁投與最終備援台詞。');
  process.exit(0);
} catch (error) {
  console.error('真人發言注意力回歸失敗：', error && error.stack || error);
  process.exit(1);
}
