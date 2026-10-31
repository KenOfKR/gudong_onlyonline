/* v10.8.0 排程公平、真人接話、台詞庫擴充與短發言回歸測試 */
'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Claims, DialogueBank, Strategy, Speech, Mind } = GD;
const fs = require('fs');
const path = require('path');

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  return room;
}

function forceDiscussion(room, round, orderedPassIds, tailId) {
  round.passOrder = orderedPassIds.slice();
  round.turnLogs[tailId] = { step: 'c', inspect: [], blind: false };
  room.status = 'playing';
  room.currentTurnPlayerId = tailId;
  assert(Engine.pass(room, tailId, null), 'could not trigger discussion');
}

try {
  assert.strictEqual(GD.CONFIG.VERSION, '10.8.1');
  assert(DialogueBank.count() >= 650, `dialogue bank must have at least 650 lines (actual ${DialogueBank.count()})`);
  assert.strictEqual(DialogueBank.count(), 1068, 'dialogue bank count should be exactly 1,068');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  assert(mainSource.includes('dialogueCountBadge') && mainSource.includes('DialogueBank.count()'), 'header should display actual loaded dialogue count');
  assert(mainSource.includes('dialogueCount < 650'), 'header should warn if the dialogue bank falls below 650 lines');
  assert.strictEqual(DialogueBank.categories().length, 49, 'new categories should be registered');
  const expectedPools = {
    evidenceExpanded: 51, tempoExpanded: 80, teamResponseExpanded: 80,
    voteMathExpanded: 70, identityAuditExpanded: 50,
    publicClaimResponse: 29, publicDefenseResponse: 29, publicCallResponse: 29,
    publicRoleResponse: 29, publicStanceResponse: 29, publicAccusationResponse: 29, publicCorrectionResponse: 29
  };
  for (const [key, count] of Object.entries(expectedPools)) {
    assert.strictEqual(DialogueBank.categories().find(x => x.key === key)?.count, count, `${key} line count`);
  }

  // 規則不變：每輪討論第一位必須是尾家的左手邊（座位順序中的下一席）。
  const room = makeRoom('V107_TAIL_LEFT_SPEAKER');
  const seats = U.seated(room);
  const firstRound = U.curRound(room);
  const tail1 = seats[2].id;
  const order1 = seats.filter(p => p.id !== tail1).map(p => p.id).concat(tail1);
  forceDiscussion(room, firstRound, order1, tail1);
  const tailIndex1 = seats.findIndex(p => p.id === tail1);
  assert.strictEqual(firstRound.speechOrder[0], seats[(tailIndex1 + 1) % seats.length].id,
    'speaking must always start at the seat immediately to the tail position left');

  const secondRound = Engine.drawRound(room, 2);
  room.rounds.push(secondRound);
  room.currentRoundIdx = 1;
  const tail2 = seats[6].id;
  const order2 = seats.filter(p => p.id !== tail2).map(p => p.id).concat(tail2);
  forceDiscussion(room, secondRound, order2, tail2);
  const tailIndex2 = seats.findIndex(p => p.id === tail2);
  assert.strictEqual(secondRound.speechOrder[0], seats[(tailIndex2 + 1) % seats.length].id,
    'every round must derive the first speaker from the current round tail');

  const defenceRoom = makeRoom('V107_HUMAN_DEFENCE');
  const defenceRound = U.curRound(defenceRoom);
  const human = defenceRoom.players.find(p => p.id === 'human');
  const bot = defenceRoom.players.find(p => p.isBot && p.role !== '方震');
  assert(human && bot, 'needs a human and a bot other than Fang');
  const baseSeats = U.seated(defenceRoom).map(p => p.id);
  defenceRound.passOrder = baseSeats;
  defenceRound.speechOrder = [human.id, bot.id, ...baseSeats.filter(id => id !== human.id && id !== bot.id)];
  const defenceText = '我是好人，不要投我！';
  defenceRound.speeches.push({
    playerId: human.id, speakerName: human.name, source: 'bot', text: defenceText,
    p: Claims.parse(defenceText, defenceRoom, defenceRound)
  });
  const parsedDefence = Claims.parse(defenceText, defenceRoom, defenceRound);
  assert.strictEqual(parsedDefence.selfDefense, true, 'self-defence should be recognized by the public parser');
  const planned = Strategy.plan(bot, defenceRoom);
  const generated = Speech.localSpeech(bot, defenceRoom, planned.plan, planned.A);
  assert(generated.includes(U.tag(human)), 'local fallback must explicitly mention the human who just spoke');
  assert(/好人|不要投|別投|自我辯護|自辯|辯護|防守|求情|否認自己是壞人|不希望被投|反對被集火|不要集火|立場/.test(generated), 'local fallback must acknowledge the substance of the human defence, not dismiss it as no information; generated=' + JSON.stringify(generated));
  assert(generated.length <= 260, `local fallback should be concise (got ${generated.length} chars)`);
  const responseAudit = Speech.validate(generated, bot, defenceRoom, planned.plan, planned.A);
  assert(responseAudit.ok, `local response should pass validation: ${responseAudit.why}`);

  const stanceRoom = makeRoom('V107_HUMAN_MULTI_INTENT');
  const stanceRound = U.curRound(stanceRoom);
  const stanceHuman = stanceRoom.players.find(p => p.id === 'human');
  const targets = stanceRoom.players.filter(p => p.id !== 'human').slice(0, 2);
  const stanceBot = stanceRoom.players.find(p => p.isBot && p.role !== '方震' && !targets.some(t => t.id === p.id));
  assert(stanceHuman && targets.length === 2 && stanceBot, 'needs human, two stance targets and a responding bot');
  const beast = stanceRound.beasts[0].name;
  const stanceText = `${U.tag(targets[0])}好人，【${beast}】假，${U.tag(targets[1])}好人！`;
  const parsedStances = Claims.parse(stanceText, stanceRoom, stanceRound);
  assert(parsedStances.claims.some(c => c.beast === beast && c.real === false), 'must parse the human beast verdict');
  assert.strictEqual(parsedStances.playerStances.length, 2, 'must parse both human player-camp assertions');
  stanceRound.passOrder = U.seated(stanceRoom).map(p => p.id);
  stanceRound.speechOrder = [stanceHuman.id, stanceBot.id, ...stanceRound.passOrder.filter(id => id !== stanceHuman.id && id !== stanceBot.id)];
  stanceRound.speeches.push({
    playerId: stanceHuman.id, speakerName: stanceHuman.name, source: 'bot', text: stanceText,
    p: parsedStances
  });
  const stancePlan = Strategy.plan(stanceBot, stanceRoom);
  const stanceResponse = Speech.localSpeech(stanceBot, stanceRoom, stancePlan.plan, stancePlan.A);
  assert(stanceResponse.includes(U.tag(stanceHuman)), 'multi-intent response must identify the human speaker');
  for (const target of targets) {
    const targetTag = U.tag(target);
    assert(stanceResponse.includes(targetTag), `must acknowledge player stance for ${targetTag}`);
    assert(new RegExp(targetTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^。！？!?；;]{0,24}好人|好人[^。！？!?；;]{0,24}' + targetTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(stanceResponse),
      `must connect ${targetTag} to the good-side assertion in a sentence`);
  }
  assert(stanceResponse.length <= 260, `multi-intent fallback should stay <=260 characters (got ${stanceResponse.length})`);
  const stanceValidation = Speech.validate(stanceResponse, stanceBot, stanceRoom, stancePlan.plan, stancePlan.A);
  assert(stanceValidation.ok, `multi-intent response should pass validation: ${stanceValidation.why}`);

  // 資訊能力獨立於陣營：相同起始 evil/ally 的兩個玩家，正確資訊分數較高但陣營分數不動。
  const infoRoom = makeRoom('V108_INFO_SKILL_SEPARATE');
  const infoRd = U.curRound(infoRoom);
  const infoBeast = infoRd.beasts[0].name;
  const infoPlayers = U.seated(infoRoom);
  const correctSpeaker = infoPlayers[0], wrongSpeaker = infoPlayers[1];
  infoRd.speeches.push({ playerId: correctSpeaker.id, speakerName: correctSpeaker.name, source: 'bot',
    text: `我判斷【${infoBeast}】是真品。` });
  infoRd.speeches.push({ playerId: wrongSpeaker.id, speakerName: wrongSpeaker.name, source: 'bot',
    text: `我判斷【${infoBeast}】是贗品。` });
  const parsedCorrect = Claims.parse(infoRd.speeches[0].text, infoRoom, infoRd);
  const parsedWrong = Claims.parse(infoRd.speeches[1].text, infoRoom, infoRd);
  assert(parsedCorrect.claims.some(c => c.beast === infoBeast && c.real === true), 'test fixture must parse a positive public claim');
  assert(parsedWrong.claims.some(c => c.beast === infoBeast && c.real === false), 'test fixture must parse a negative public claim');
  infoRd.voteResults = { rank2: { name: infoBeast, isReal: true } };
  infoRoom.rounds.push(Engine.drawRound(infoRoom, 2));
  infoRoom.currentRoundIdx = 1;
  const correctProfile = { evil: 0, ally: 0 }, wrongProfile = { evil: 0, ally: 0 };
  Mind.buildInformationSkill({ room: infoRoom, t: 1 }, {
    [correctSpeaker.id]: correctProfile, [wrongSpeaker.id]: wrongProfile
  });
  assert(correctProfile.infoSkill > wrongProfile.infoSkill, 'accurate public information should raise information skill relative to a wrong prediction');
  assert.strictEqual(correctProfile.evil, 0, 'information skill must not alter evil suspicion');
  assert.strictEqual(correctProfile.ally, 0, 'information skill must not alter ally trust');
  assert.strictEqual(wrongProfile.evil, 0, 'an inaccurate claim must not directly mean evil');
  assert.strictEqual(wrongProfile.ally, 0, 'an inaccurate claim must not directly mean not-good');

  // 公開號召需同等處理 bot／human 來源；來源標記不同不應改變被記錄的目標。
  const callRoom = makeRoom('V108_PUBLIC_CALL_SOURCE_NEUTRAL');
  const callRound = U.curRound(callRoom);
  const caller = callRoom.players.find(p => p.isBot);
  const observer = callRoom.players.find(p => p.isBot && p.id !== caller.id);
  const callTarget = callRoom.players.find(p => p.id !== caller.id && p.id !== observer.id);
  assert(caller && observer && callTarget, 'public call test needs three different players');
  callRound.speeches.push({ playerId: caller.id, speakerName: caller.name, source: 'bot', text: `我懷疑${U.tag(callTarget)}，請追問他的票型。`,
    p: { callSuspectId: callTarget.id, callBeasts: [], callBeast: null } });
  const callAnalysis = Mind.analyze(observer, callRoom);
  assert(callAnalysis.publicCall && callAnalysis.publicCall.targetId === callTarget.id,
    'a bot-origin public call must be treated like any other public call');

  const oldLine = DialogueBank.pick('evidence', 12345, {});
  const freshLine = DialogueBank.pickFresh('evidence', 12345, {}, [oldLine]);
  assert.notStrictEqual(freshLine, oldLine, 'pickFresh must avoid exact/templated repetition if another line is available');
  console.log('v10.8.0 回歸測試通過：尾家左側發言、來源中立、資訊能力與陣營分離、台詞數顯示、1,068 條台詞');
  process.exit(0);
} catch (err) {
  console.error('v10.8.0 策略回歸測試失敗：', err.stack || err.message || err);
  process.exit(1);
}
