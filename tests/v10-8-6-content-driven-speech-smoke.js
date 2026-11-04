/* v10.8.6 內容導向發言、可變嫌疑名單與首頁台詞庫徽章回歸測試 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const load = require('./harness');
const GD = load();
const { Engine, U, Strategy, Speech, DialogueBank, CONFIG } = GD;

function makeRoom() {
  const room = Engine.newRoom('V1086_CONTENT_DRIVEN', 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  const roles = ['鄭國渠','黃煙煙','姬雲浮','許願','方震','藥不然','老朝奉','木戶加奈'];
  room.players.forEach((p, i) => {
    p.name = ['真人甲','Alli','陳子揚','Penny','漢傑','隻貓','柏仰','水豚'][i];
    p.role = roles[i];
    p.genes = { skepticism: 0.5, deception: 0.5, camouflage: 0.5, assertiveness: 0.5, conformity: 0.5 };
  });
  const r1 = room.rounds[0];
  r1.roundNum = 1;
  r1.beasts = ['蛇','馬','羊','狗'].map((name, i) => ({ name, isReal: i % 2 === 0 }));
  const r2 = { ...r1, roundNum: 2, beasts: ['鼠','牛','虎','兔'].map((name, i) => ({ name, isReal: i % 2 === 0 })),
    votes: {}, voteResults: { rank1: { name: '鼠', isReal: true }, rank2: { name: '牛', isReal: false } },
    speeches: [], turnLogs: {}, mind: {}, passOrder: room.players.map(p => p.id), speechOrder: room.players.map(p => p.id) };
  const r3 = { ...r2, roundNum: 3, beasts: ['龍','豬','猴','雞'].map((name, i) => ({ name, isReal: i % 2 === 0 })),
    votes: {}, voteResults: null, speeches: [], turnLogs: {}, mind: {}, passOrder: room.players.map(p => p.id), speechOrder: room.players.map(p => p.id) };
  room.rounds.push(r2, r3);
  room.currentRoundIdx = 2;
  room.currentSpeakerId = room.players[1].id;
  return room;
}

try {
  assert.strictEqual(CONFIG.VERSION, '10.8.10');
  assert.strictEqual(DialogueBank.count(), 1068, 'the dialogue bank data remains available to BOT strategy');
  const mindSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'bot', 'mind.js'), 'utf8');
  assert(!/highSus\.slice\(0\s*,\s*3\)/.test(mindSource),
    'mind must not mechanically keep only three high-suspicion players and downrank the rest');
  assert(!/pardoned\.forEach\(r\s*=>\s*\{\s*r\.evil\s*=/.test(mindSource),
    'mind must not reduce suspicion scores merely because more than three players are suspicious');

  const room = makeRoom();
  const bot = room.players.find(p => p.role === '黃煙煙');
  const others = room.players.filter(p => p.id !== bot.id);
  const genes = { skepticism: 0.5 };

  function makeAnalysis(candidateCount, laoIndex = -1) {
    const byEvil = others.map((player, index) => ({
      player,
      evil: index < candidateCount ? 82 - index : 8,
      ally: 0,
      knownEvil: false,
      confessed: false,
      conflicts: [],
      inLaoPoolCount: 0,
      probs: { '老朝奉': index === laoIndex ? 68 : 4, '藥不然': 5, '許願': 5, '方震': 5 }
    }));
    return { byEvil, laoIntersectIds: [], laoPools: [] };
  }

  // 0、1、2、3 位候選都合法；系統只提出有證據支撐的數量，不要求湊滿三人。
  for (const count of [0, 1, 2, 3]) {
    const result = Strategy.buildPublicSuspectBrief(makeAnalysis(count, count === 2 ? 1 : -1), bot, genes);
    assert.strictEqual(result.candidateCount, count, `candidate count ${count} must stay evidence-driven`);
    assert.strictEqual(result.tags.length, count);
    if (count < 3) {
      assert(/票型|傳牌|發言/.test(result.brief), `candidate count ${count} must explain what remains to be observed`);
      assert(!/三名壞人|必須三人|湊滿三人/.test(result.brief), 'no wording should force exactly three suspects');
    }
    if (count === 0) assert(/不下結論|證據/.test(result.brief), 'zero supported suspects should be stated plainly');
  }

  const oneCandidate = Strategy.buildPublicSuspectBrief(makeAnalysis(1), bot, genes);
  assert(oneCandidate.tags[0], 'one supported suspect should be named');
  assert(oneCandidate.brief.includes('不硬湊') || oneCandidate.brief.includes('證據不足'));
  assert(oneCandidate.brief.includes('老朝奉') && /尚未|暫時|不指認/.test(oneCandidate.brief),
    'without role evidence, the Lao identity must remain unresolved');

  const twoCandidatesWithLao = Strategy.buildPublicSuspectBrief(makeAnalysis(2, 1), bot, genes);
  assert.strictEqual(twoCandidatesWithLao.tags.length, 2);
  assert(twoCandidatesWithLao.laoTag, 'a Lao candidate may be named only when there is separate role evidence');
  assert(twoCandidatesWithLao.brief.includes(twoCandidatesWithLao.laoTag));

  const namedAssessment = `${oneCandidate.tags[0]}有壞人嫌疑，但其餘人還要看本輪票型與完整發言；老朝奉尚未收斂。`;
  assert(Strategy.hasPublicSuspectAssessment(room, [{ text: namedAssessment }]),
    'one named suspect plus explicit uncertainty should count as a completed, non-forced assessment');
  assert(!Strategy.hasPublicSuspectAssessment(room, [{ text: '場上應該有三名壞人，老朝奉還要看票型。' }]),
    'a vague claim without a named player must not suppress an evidence-based assessment');

  const planResult = Strategy.plan(bot, room);
  const planForPrompt = {
    ...planResult.plan,
    publicSuspectBrief: oneCandidate.brief,
    publicSuspectTags: oneCandidate.tags,
    publicLaoCandidateTag: null
  };
  const prompt = Speech.buildPrompt(bot, room, planForPrompt, planResult.A);
  assert(prompt.includes('不限定字數') && prompt.includes('不限制證據項目數'));
  assert(!/(?:45.?90|上限\s*260|最多兩項證據|一到兩個重點)/.test(prompt), 'prompt must not impose a word/character or evidence-count cap');
  assert(prompt.includes(oneCandidate.brief), 'the evidence-driven uncertainty must reach Gemini unchanged');
  const driverSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'bot', 'driver.js'), 'utf8');
  const geminiSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'bot', 'gemini.js'), 'utf8');
  assert(!/Gemini\.generate\([\s\S]{0,500}maxTokens\s*:\s*240/.test(driverSource),
    'driver must not impose the former 240-token gameplay output cap');
  assert(geminiSource.includes('if (Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0)'),
    'Gemini should only send maxOutputTokens when a caller explicitly requests it');

  // A valid, content-rich reply longer than the former 260-character cap must remain eligible.
  const longPlan = {
    ...planResult.plan,
    roleBluff: null,
    fakeFangClaim: null,
    confess: false,
    evilRolePerformance: false,
    publicSuspectBrief: null,
    publicSuspectTags: [],
    publicLaoCandidateTag: null,
    claims: [{ beast: planResult.plan.beast, real: true }]
  };
  const beast = longPlan.beast;
  const supportingDetails = Array.from({ length: 18 }, (_, i) =>
    `第${i + 1}項公開紀錄都要分開看，不能把不同玩家的觀察混成同一份查驗，也不能把未開票的預測當成最後結果。`
  ).join('');
  const longSpeech = `我目前判斷【${beast}】是真品，這是根據本輪公開資料形成的結論；主票也會投【${beast}】。${supportingDetails}`;
  assert(longSpeech.length > 260, 'test fixture must exceed the former fixed limit');
  const validation = Speech.validate(longSpeech, bot, room, longPlan, planResult.A);
  assert(validation.ok, `a semantically valid long reply must not be rejected for length: ${validation.why}`);

  // The left-top count badge is absent; the underlying dialogue bank is intentionally retained.
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  const header = (indexSource.match(/<header class="top">[\s\S]*?<\/header>/i) || [''])[0];
  assert(!/(?:台詞庫|1,068\s*條|1068\s*條)/i.test(header), 'the top-left header must not show the dialogue count');
  assert(mainSource.includes('#dialogueCountBadge') && mainSource.includes('node.remove()'), 'legacy badge is explicitly removed if present');
  assert.strictEqual(DialogueBank.count(), 1068, 'removing the display must not delete the dialogue bank');

  console.log('v10.8.6 內容導向發言測試通過：0–3 名證據式候選、未收斂時保留待觀察、長發言不因字數被拒、左上角數量徽章移除且 1,068 條策略資料保留。');
  process.exit(0);
} catch (error) {
  console.error('v10.8.6 內容導向發言測試失敗：', error && error.stack || error);
  process.exit(1);
}
