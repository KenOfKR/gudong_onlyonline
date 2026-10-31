/* v10.6.2 歷史集火歸因與原話稽核冒煙測試：核對歷史歸因與同段真偽宣稱，不禁用角色偽裝或合法多票。 */
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Claims, Tactics, DialogueBank, Strategy, Mind, Speech } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  return room;
}

function sum(obj) { return Object.values(obj || {}).reduce((n, v) => n + (Number(v) || 0), 0); }

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A reply acknowledges the human when it attributes the claim/call to that
// player, or explicitly responds to that player's named evidence. Do not
// require one particular template phrase such as "已納入考慮".
function acknowledgesHuman(text, humanName, beastName) {
  const name = escapeRegExp(humanName);
  const beast = escapeRegExp(beastName);
  const attributed = new RegExp(
    name + '[^\\u3002\\n]{0,80}(?:\\u8a8d\\u70ba|\\u4e3b\\u5f35|\\u8868\\u793a|\\u63d0\\u5230|\\u524d\\u9762\\u8aaa|\\u525b\\u624d\\u8aaa|\\u8aaa|\\u5e0c\\u671b\\u5927\\u5bb6\\u6295|\\u5efa\\u8b70\\u6295|\\u8981\\u6c42\\u6295|\\u865f\\u53ec\\u6295)' +
    '[^\\u3002\\n]{0,100}' + beast
  );
  const explicitResponse = new RegExp(
    '(?:\\u6211\\u807d\\u5230\\u4e86|\\u6211\\u6709\\u807d\\u5230|\\u6211\\u5148\\u63a5\\u4f4f|\\u6536\\u5230|\\u6211\\u6ce8\\u610f\\u5230|\\u6211\\u6703\\u53c3\\u8003)' +
    '[^\\u3002\\n]{0,80}' + beast
  );
  return attributed.test(String(text || '')) || explicitResponse.test(String(text || ''));
}

try {
  assert.strictEqual(GD.CONFIG.VERSION, '10.8.1', 'application version must be updated consistently to v10.8.0');
  assert(DialogueBank && DialogueBank.count() >= 100, 'dialogue bank should contain at least 100 lines');
  assert.strictEqual(DialogueBank.count(), 1068, 'v10.8.0 doubles the dialogue bank to 1,068 lines');
  assert.strictEqual(DialogueBank.categories().length, 49, 'v10.8.0 adds twelve expansion and human-response categories');
  [['evidenceExpanded',51],['tempoExpanded',80],['teamResponseExpanded',80],['voteMathExpanded',70],['identityAuditExpanded',50],['publicClaimResponse',29],['publicDefenseResponse',29],['publicCallResponse',29],['publicRoleResponse',29],['publicStanceResponse',29],['publicAccusationResponse',29],['publicCorrectionResponse',29]].forEach(([key,count]) => assert.strictEqual(DialogueBank.categories().find(x => x.key === key)?.count, count, `${key} should have ${count} lines`));
  const roleSignalCategories = [
    ['trueXuSignal', '許願'], ['trueFangSignal', '方震'], ['trueJiSignal', '姬雲浮'], ['trueHuangSignal', '黃煙煙'],
    ['trueKidoSignal', '木戶加奈'], ['trueLaoSignal', '老朝奉'], ['trueYaoSignal', '藥不然'], ['trueZhengSignal', '鄭國渠']
  ];
  roleSignalCategories.forEach(([category, realRole]) => {
    assert.strictEqual(DialogueBank.categories().find(x => x.key === category)?.count, 13, `${category} should have 13 role-signal lines`);
    for (let i = 0; i < 13; i++) {
      const line = DialogueBank.pick(category, i);
      assert(!line.includes(realRole), `${category} must hint the genuine role without naming ${realRole}`);
    }
  });

  assert.strictEqual(DialogueBank.categories().find(x => x.key === 'roleContestAudit')?.count, 20, 'roleContestAudit should retain the existing 20-line category from v10.4.1');
  assert.strictEqual(DialogueBank.categories().find(x => x.key === 'xuYuanTactics')?.count, 30, 'the new Xu Yuan category must contain exactly 30 lines');
  assert.strictEqual(DialogueBank.categories().find(x => x.key === 'teamResponse')?.count, 10, 'the new team-response category must contain exactly 10 lines');
  ['evidence', 'voteMath', 'alliance', 'sourceIndependence', 'voteUncertainty', 'tempo'].forEach(key => {
    assert.strictEqual(DialogueBank.categories().find(x => x.key === key)?.count, 20, `${key} should contain ten original and ten added lines`);
  });
  for (let i = 0; i < 30; i++) {
    const line = DialogueBank.pick('xuYuanTactics', i);
    assert(!/第二尊|兩筆查驗|另一筆查驗|還有一條線索|不只一個孤立推測|另一個結果/.test(line), 'Xu Yuan lines must not leak hidden scan-count information');
    assert(!/我是許願|我就是許願/.test(line), 'Xu Yuan lines must not explicitly reveal her role');
    assert(!/前二名與真品收益|後驗機率|預估票差|追加籌碼|臨界點|可信度|轉移焦點|私密資訊|內部權重/.test(line), 'Xu Yuan public dialogue must not sound like internal strategy notes');
  }

  const evidenceCategoryKeys = [
    'identityAudit', 'sourceIndependence', 'voteUncertainty', 'scoreTradeoff',
    'microSignalAnalysis', 'claimConsistency', 'crowdPressureAudit', 'ballotCommitment', 'endgameRoleTradeoff'
  ];
  evidenceCategoryKeys.forEach(key => {
    const expected = ['sourceIndependence', 'voteUncertainty'].includes(key) ? 20 : 10;
    assert.strictEqual(DialogueBank.categories().find(x => x.key === key)?.count, expected, `${key} should preserve/extend its expected contextual line count`);
  });

  const v103Categories = ['ambushFrame', 'roleSwap', 'persistentDenial', 'passOrderTrap', 'longCon'];
  v103Categories.forEach(key => {
    assert.strictEqual(DialogueBank.categories().find(x => x.key === key)?.count, 20, `${key} should add twenty fresh tactical lines`);
  });

  // Only multiple claims to the SAME unique role are a role contest; unrelated roles are not rivals.
  const roleAuditRoom = makeRoom('ROLE_AUDIT_CATEGORY');
  const roleAuditRound = U.curRound(roleAuditRoom);
  const roleAuditBot = roleAuditRoom.players.find(p => p.isBot && p.role !== '方震');
  const roleAuditPeers = roleAuditRoom.players.filter(p => p.id !== roleAuditBot.id && p.id !== 'human');
  const roleAuditPlan = { mode: 'truth', beast: roleAuditRound.beasts[0].name, suspectId: null, followHuman: null, roleBluff: null, fakeFangClaim: null };
  roleAuditRound.speeches = [{ playerId: 'human', source: 'human', speakerName: '真人甲', text: '我是方震。', p: { selfRole: '方震', claims: [], accuse: [], asked: [] } }];
  let roleAudit = Tactics.publicNarrative(roleAuditRoom, roleAuditBot, Mind.analyze(roleAuditBot, roleAuditRoom), roleAuditPlan, 123);
  assert.strictEqual(roleAudit.category, 'identityAudit', 'one role claimant should use identity audit, not role contest');
  roleAuditRound.speeches.push({ playerId: roleAuditPeers[0].id, source: 'bot', speakerName: roleAuditPeers[0].name, text: '我是鄭國渠。', p: { selfRole: '鄭國渠', claims: [], accuse: [], asked: [] } });
  roleAudit = Tactics.publicNarrative(roleAuditRoom, roleAuditBot, Mind.analyze(roleAuditBot, roleAuditRoom), roleAuditPlan, 124);
  assert.strictEqual(roleAudit.category, 'identityAudit', 'different roles claimed by different players are not a same-role contest');
  roleAuditRound.speeches.push({ playerId: roleAuditPeers[1].id, source: 'bot', speakerName: roleAuditPeers[1].name, text: '我是方震。', p: { selfRole: '方震', claims: [], accuse: [], asked: [] } });
  roleAudit = Tactics.publicNarrative(roleAuditRoom, roleAuditBot, Mind.analyze(roleAuditBot, roleAuditRoom), roleAuditPlan, 125);
  assert.strictEqual(roleAudit.category, 'roleContestAudit', 'two distinct players claiming the same unique role should trigger role contest audit');
  assert(!roleAudit.line.includes('100%'), 'role audit dialogue should not imply certainty from a role claim');

  // A planned bluff colliding with a public unique-role claim must receive role-contest tactical context.
  const plannedConflict = Tactics.publicNarrative(roleAuditRoom, roleAuditBot, Mind.analyze(roleAuditBot, roleAuditRoom), {
    ...roleAuditPlan, roleBluff: { role: '鄭國渠', kind: 'false_claim' }
  }, 126);
  assert.strictEqual(plannedConflict.category, 'roleContestAudit', 'a planned bluff against an already claimed role should address the conflict');

  // Counterclaims are allowed: existing public claims must not mechanically lower the weight of that role.
  const pickRoom = makeRoom('ROLE_BLUR_CHOICE');
  const pickRound = U.curRound(pickRoom);
  const pickBot = pickRoom.players.find(p => p.isBot && !['鄭國渠', '許願', '方震'].includes(p.role));
  const pickPeer = pickRoom.players.find(p => p.id !== pickBot.id && p.id !== 'human');
  const rolePoolForTest = ['鄭國渠', '許願', '方震'];
  const baselinePickRoom = makeRoom('ROLE_BLUR_BASELINE');
  const baselinePickBot = baselinePickRoom.players.find(p => p.isBot);
  assert(baselinePickBot, 'baseline room should contain a bot for role-pick comparison');
  // Room seeds intentionally differ in this harness; pin the tested role so this is a paired role-choice test.
  baselinePickBot.role = pickBot.role;
  pickRound.speeches.push(
    { playerId: 'human', speakerName: '真人甲', text: '我是鄭國渠。', p: { selfRole: '鄭國渠', claims: [] } },
    { playerId: pickPeer.id, speakerName: pickPeer.name, text: '我是鄭國渠。', p: { selfRole: '鄭國渠', claims: [] } }
  );
  const savedRandomForRolePick = Math.random;
  try {
    for (const roll of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      Math.random = () => roll;
      const withConflict = Strategy.chooseRoleBluffRole(rolePoolForTest, pickRoom, pickBot, 0, null);
      Math.random = () => roll;
      const withoutConflict = Strategy.chooseRoleBluffRole(rolePoolForTest, baselinePickRoom, baselinePickBot, 0, null);
      assert.strictEqual(withConflict, withoutConflict,
        'multiple public claimants must not create an automatic penalty against a role; counterclaims stay viable');
    }
  } finally { Math.random = savedRandomForRolePick; }

  // A role contest is group-level evidence only: do not automatically add evil suspicion to every claimant.
  const contestScoringRoom = makeRoom('ROLE_CONTEST_NO_GROUP_GUILT');
  const contestObserver = contestScoringRoom.players.find(p => p.isBot && p.role !== '方震');
  const contestCtx = Mind.context(contestObserver, contestScoringRoom);
  const knownRoles = new Set([contestObserver.role, contestCtx.partner && contestCtx.partner.role].filter(Boolean));
  const disputedRole = GD.ROLE_ORDER.find(role => !knownRoles.has(role));
  assert(disputedRole, 'test needs a disputed role not known to the observer');
  const contestClaimants = contestScoringRoom.players.filter(p => p.id !== contestObserver.id && p.id !== (contestCtx.partner && contestCtx.partner.id)).slice(0, 2);
  assert.strictEqual(contestClaimants.length, 2, 'test needs two independent role claimants');
  const beforeContest = Mind.analyze(contestObserver, contestScoringRoom);
  const evilBefore = contestClaimants.map(p => beforeContest.prof[p.id].evil);
  U.curRound(contestScoringRoom).speeches.push(...contestClaimants.map(p => ({
    playerId: p.id, speakerName: p.name, source: p.isBot ? 'bot' : 'human',
    text: `我是${disputedRole}，請依公開紀錄判斷。`,
    p: { selfRole: disputedRole, claims: [], accuse: [], asked: [], campChecks: [] }
  })));
  const afterContest = Mind.analyze(contestObserver, contestScoringRoom);
  contestClaimants.forEach((p, i) => assert.strictEqual(afterContest.prof[p.id].evil, evilBefore[i],
    "role contest alone should not increase every claimant evil score equally"));

  // Two players calling themselves civilians do not create a unique-role contest.
  const civilianContestRoom = makeRoom('CIVILIAN_IS_NOT_UNIQUE_ROLE');
  const civilianObserver = civilianContestRoom.players.find(p => p.isBot && p.role !== '方震');
  const civilianClaimants = civilianContestRoom.players.filter(p => p.id !== civilianObserver.id).slice(0, 2);
  const civilianBase = Mind.analyze(civilianObserver, civilianContestRoom);
  const civilianEvilBefore = civilianClaimants.map(p => civilianBase.prof[p.id].evil);
  U.curRound(civilianContestRoom).speeches.push(...civilianClaimants.map(p => ({
    playerId: p.id, speakerName: p.name, source: p.isBot ? 'bot' : 'human',
    text: '我先以平民身分陳述，請看公開紀錄。',
    p: { selfRole: '平民', claims: [], accuse: [], asked: [], campChecks: [] }
  })));
  const civilianAfter = Mind.analyze(civilianObserver, civilianContestRoom);
  civilianClaimants.forEach((p, i) => assert.strictEqual(civilianAfter.prof[p.id].evil, civilianEvilBefore[i],
    'repeated civilian labels must not create a unique-role conflict penalty'));

  // mind.js must parse a textual self-role claim when structured speech metadata is absent.
  const textClaimRoom = makeRoom('TEXT_ONLY_ROLE_CLAIM');
  const textClaimRound = U.curRound(textClaimRoom);
  const textClaimant = textClaimRoom.players.find(p => !p.isBot && p.id === 'human');
  const textObserver = textClaimRoom.players.find(p => p.isBot && p.role !== '鄭國渠');
  textClaimRound.speeches.push({ playerId: textClaimant.id, speakerName: textClaimant.name, text: '我是鄭國渠，請用紀錄核對。', source: 'human', p: { selfRole: null, claims: [] } });
  const textClaimAnalysis = Mind.analyze(textObserver, textClaimRoom);
  assert(textClaimAnalysis.prof[textClaimant.id].reasons.some(x => x.includes('公開自稱【鄭國渠】')),
    'mind should parse visible textual role claims even if p.selfRole is null');
  const textOnlyBeastSpeech = {
    playerId: textClaimant.id, speakerName: textClaimant.name,
    text: `我認為【${textClaimRound.beasts[0].name}】是真品，大家一起投【${textClaimRound.beasts[0].name}】。`,
    p: { claims: [], callBeasts: [], selfRole: null, accuse: [], asked: [] }
  };
  const textOnlyBeastRecord = Claims.parseRecord(textOnlyBeastSpeech, textClaimRoom, textClaimRound);
  assert(textOnlyBeastRecord.claims.some(c => c.beast === textClaimRound.beasts[0].name && c.real === true),
    'public text claims must be recovered even when a structured p object exists but its arrays are empty');
  assert(textOnlyBeastRecord.callBeasts.includes(textClaimRound.beasts[0].name),
    'public text vote calls must be recovered even when structured call metadata is empty');

  // Teammate strategy must also use that recovered text claim, not only the parsed-data UI/speech layer.
  textClaimRound.speeches.push(textOnlyBeastSpeech);
  const textClaimInspector = textClaimRoom.players.find(p => p.isBot && p.id !== textClaimant.id);
  textClaimInspector.role = '許願';
  const textClaimOldRandom = Math.random;
  let textClaimPicks;
  try { Math.random = () => 0; textClaimPicks = Strategy.inspectPicks(textClaimInspector, textClaimRoom); }
  finally { Math.random = textClaimOldRandom; }
  assert(textClaimPicks.includes(textClaimRound.beasts[0].name),
    'strategy inspect targeting should account for a public text-only claim even when p.claims is empty');

  // Same-round repeated pile-on is correlated evidence: the second identical target-call must add less suspicion than the first.
  const echoRoom = makeRoom('CORRELATED_CALL_WEIGHT');
  const echoRound = U.curRound(echoRoom);
  const echoBot = echoRoom.players.find(p => p.isBot && GD.isGood(p.role) && p.role !== '方震');
  const echoTarget = echoRoom.players.find(p => p.id !== echoBot.id && p.id !== 'human');
  const echoCallers = echoRoom.players.filter(p => p.id !== echoBot.id && p.id !== echoTarget.id).slice(0, 2);
  const echoSpeech = caller => ({
    playerId: caller.id, speakerName: caller.name, source: caller.isBot ? 'bot' : 'human',
    text: `${U.tag(caller)}建議集火${U.tag(echoTarget)}，但還要有其他證據。`,
    p: { claims: [], callSuspectId: echoTarget.id, callBeast: null, callBeasts: [], accuse: [], asked: [], campChecks: [] }
  });
  const echoBaseline = Mind.analyze(echoBot, echoRoom).prof[echoTarget.id].evil;
  echoRound.speeches.push(echoSpeech(echoCallers[0]));
  const echoOne = Mind.analyze(echoBot, echoRoom).prof[echoTarget.id].evil;
  echoRound.speeches.push(echoSpeech(echoCallers[1]));
  const echoTwo = Mind.analyze(echoBot, echoRoom).prof[echoTarget.id].evil;
  const firstCallDelta = echoOne - echoBaseline;
  const secondCallDelta = echoTwo - echoOne;
  assert(firstCallDelta > 0 && secondCallDelta > 0 && secondCallDelta < firstCallDelta,
    `repeated same-round call should have diminishing weight; first=${firstCallDelta}, second=${secondCallDelta}`);

  const parseRoom = makeRoom('TACTICS_PARSE');
  const testRound = { beasts: [{ name: '蛇' }, { name: '鼠' }] };
  const historical = Claims.parse('第1輪我投了2票給【蛇】，這輪我投【鼠】。', parseRoom, testRound);
  assert(!historical.callBeasts.includes('蛇'), 'historical ballot must not be interpreted as current call');
  assert(historical.callBeasts.includes('鼠'), 'current-round vote call should still be parsed');
  assert.strictEqual(Claims.parse('我是平民，這輪我投【鼠】。', parseRoom, testRound).selfRole, '平民',
    'a plain-player claim should be tracked as a bluff label, not a new game role');

  const room = makeRoom('TACTICS_MAIN');
  const rd = U.curRound(room);
  const bot = room.players.find(p => p.isBot && GD.isGood(p.role) && p.role !== '方震');
  assert(bot, 'a non-Fang good bot should exist');
  const analysis = Mind.analyze(bot, room);
  const forecast = Tactics.forecastVotes(room, bot);
  assert.strictEqual(forecast.ranking.length, rd.beasts.length, 'forecast should include every current beast');
  assert(forecast.ranking.every(x => Number.isFinite(x.expectedVotes) && x.pTopTwo >= 0 && x.pTopTwo <= 1), 'forecast values must be finite');
  const score = Tactics.scoreProjection(room, bot, analysis.post, forecast);
  assert(Number.isFinite(score.expectedSavedReal), 'score projection should be numeric');
  assert.strictEqual(score.winScore, GD.CONFIG.WIN_SCORE, 'score projection should use the actual win threshold');

  const planned = Strategy.plan(bot, room);
  assert(planned && planned.plan && rd.mind[bot.id], 'strategy should store the tactical plan');
  assert(planned.plan.tactics && planned.plan.tacticalLine, 'strategy should consume a tactical dialogue line');
  const actualBallot = Strategy.ballot(bot, room);
  const spent = sum(actualBallot);
  assert(spent <= Engine.availableChips(room, bot.id), 'optimizer must not overspend available chips');
  assert(Object.keys(actualBallot).every(name => rd.beasts.some(b => b.name === name)), 'optimizer must vote only on current-round beasts');
  const declaredTargetVotes = Number(actualBallot[planned.plan.beast] || 0);
  assert(Number.isInteger(declaredTargetVotes) && declaredTargetVotes >= 0,
    'declared-target votes must be non-negative; zero and non-anchor ballots are legal');
  assert.strictEqual(Number(rd.mind[bot.id].ballotModel.spent), spent,
    'ballot diagnostics must match the actual ballot spend');
  assert(rd.mind[bot.id].ballotModel, 'ballot diagnostics should be retained for review');

  // Genuine role holders can occasionally soft-claim a truthful role-specific clue; they must not explicitly announce their job.
  const signalRoom = makeRoom('TRUE_ROLE_SIGNAL');
  const signalRd = U.curRound(signalRoom);
  const signalBot = signalRoom.players.find(p => p.isBot && p.role === '許願') || signalRoom.players.find(p => p.isBot);
  assert(signalBot, 'a bot must exist for true-role signal test');
  const oldSignalRole = signalBot.role;
  const otherXu = signalRoom.players.find(p => p.id !== signalBot.id && p.role === '許願');
  if (otherXu) otherXu.role = oldSignalRole;
  signalBot.role = '許願';
  const chosenBeasts = signalRd.beasts.slice(0, 2);
  signalRd.turnLogs[signalBot.id] = {
    inspect: chosenBeasts.map(b => ({ beastName: b.name, displayedReal: !!b.isReal, kind: 'ok', resultText: `【${b.name}】${b.isReal ? '真品' : '贗品'}` })),
    blind: false, skillTag: '', ability: '', step: 'c'
  };
  // Choose a deterministic test botId whose stable signal roll is below the actual threshold.
  signalBot.genes = signalBot.genes || GD.Genes.load(signalBot.botId);
  const savedGenes = signalBot.genes;
  const signalCtx = Mind.context(signalBot, signalRoom);
  const signalChanceForTest = U.clamp((0.035 + 0.06 * signalCtx.genes.assertiveness + 0.05) * 0.45, 0.01, 0.26);
  for (let i = 0; i < 1000; i++) {
    const candidateId = `TRUE_ROLE_SIGNAL_TEST_${i}`;
    const signalSeedText = `${candidateId}:${signalRoom.roomId || ''}:${signalRoom.currentRoundIdx}:${signalRd.passOrder.indexOf(signalBot.id)}:true-role:許願:quiet:unpressured:fresh`;
    if ((DialogueBank.hash(signalSeedText) % 10000) / 10000 < signalChanceForTest) {
      signalBot.botId = candidateId;
      signalBot.genes = savedGenes;
      break;
    }
  }
  const originalRandom = Math.random;
  let signalPlanResult;
  try {
    Math.random = () => 0;
    signalPlanResult = Strategy.plan(signalBot, signalRoom);
  } finally {
    Math.random = originalRandom;
  }
  assert(signalPlanResult.plan.trueRoleSignal, 'real Xu should be able to select a soft signal when holding two real inspection results');
  assert(!signalPlanResult.plan.roleBluff, 'a planned true-role signal must not be combined with a false-role jump');
  assert(!signalPlanResult.plan.trueRoleSignal.line.includes('許願'), 'the public micro-signal must not explicitly name the real role');
  const signalSpeech = Speech.localSpeech(signalBot, signalRoom, signalPlanResult.plan, signalPlanResult.A);
  assert(signalSpeech.includes(signalPlanResult.plan.trueRoleSignal.line), 'local fallback speech must include the planned true-role signal');
  if (signalPlanResult.plan.xuYuanLine) {
    assert(signalSpeech.includes(signalPlanResult.plan.xuYuanLine), 'when selected, a varied Xu Yuan tactical line must survive local fallback rendering');
    assert(!/第二尊|兩筆查驗|另一筆查驗/.test(signalPlanResult.plan.xuYuanLine), 'selected Xu line must not imply a hidden second scan');
  }
  assert(!signalSpeech.includes('我是許願'), 'the true role should hint, not explicitly announce itself');
  assert(Speech.validate(signalSpeech, signalBot, signalRoom, signalPlanResult.plan, signalPlanResult.A).ok,
    'a truthful role micro-signal should pass current speech validation');
  assert.strictEqual(DialogueBank.detectRoleSignal(signalPlanResult.plan.trueRoleSignal.line)?.role, '許願',
    'the public signal should map to a weak Xu role hint for observers');
  const observer = signalRoom.players.find(p => p.id !== signalBot.id && p.isBot && p.role !== '許願') || signalRoom.players.find(p => p.id !== signalBot.id);
  const priorRoleProb = Mind.analyze(observer, signalRoom).prof[signalBot.id].probs['許願'] || 0;
  signalRd.speeches.push({ playerId: signalBot.id, speakerName: signalBot.name, colorId: signalBot.colorId,
    text: signalPlanResult.plan.trueRoleSignal.line, source: 'bot', p: { claims: [], callBeasts: [], accuse: [], campChecks: [], selfRole: null } });
  const withRoleSignal = Mind.analyze(observer, signalRoom).prof[signalBot.id].probs['許願'] || 0;
  assert(withRoleSignal >= priorRoleProb,
    'observers should treat the truthful micro-signal as a weak role clue, not ignore it entirely');

  // A prior human claim must remain in the decision/speech loop even when another bot spoke after them.
  const teamRoom = makeRoom('TEAM_RESPONSE_TO_HUMAN');
  const teamRd = U.curRound(teamRoom);
  const teamXu = teamRoom.players.find(p => p.isBot && p.role === '許願') || teamRoom.players.find(p => p.isBot);
  assert(teamXu, 'team-response test needs a bot');
  teamXu.role = '許願';
  const teamHuman = teamRoom.players.find(p => p.id === 'human');
  const teamOther = teamRoom.players.find(p => p.isBot && p.id !== teamXu.id);
  const teamClaimBeast = teamRd.beasts[0].name;
  const teamTargetBeast = teamRd.beasts.find(b => b.name !== teamClaimBeast).name;
  teamRd.speechOrder = [teamHuman.id, teamOther.id, teamXu.id, ...teamRoom.players.filter(p => ![teamHuman.id, teamOther.id, teamXu.id].includes(p.id)).map(p => p.id)];
  teamRd.speeches.push(
    { playerId: teamHuman.id, speakerName: teamHuman.name, source: 'human', text: `【${teamClaimBeast}】真，大家一起投【${teamClaimBeast}】！`, p: { claims: [{ beast: teamClaimBeast, real: true }], callBeast: teamClaimBeast, callBeasts: [teamClaimBeast] } },
    { playerId: teamOther.id, speakerName: teamOther.name, source: 'bot', text: '我先觀察票差，稍後再決定。', p: { claims: [], callBeast: null, callBeasts: [] } }
  );
  const teamPlanned = Strategy.plan(teamXu, teamRoom);
  teamPlanned.plan.beast = teamTargetBeast;
  teamPlanned.plan.withheldClaims = [];
  teamPlanned.plan.withholdInfo = false;
  const teamSpeech = Speech.localSpeech(teamXu, teamRoom, teamPlanned.plan, teamPlanned.A);

{
  // MULTI_SPEAKER_ORDER_SIM_V1
  const scenarios = [
    { label: 'A: one interjecting bot', count: 1 },
    { label: 'B: two interjecting bots', count: 2 },
    { label: 'C: three interjecting bots', count: 3 }
  ];

  for (const scenario of scenarios) {
    const simRoom = makeRoom('MULTI_SPEAKER_ORDER_' + scenario.count);
    const simRd = U.curRound(simRoom);
    const simHuman = simRoom.players.find(p => p.id === 'human');
    const simResponder =
      simRoom.players.find(p => p.isBot && p.role === '\u8a31\u9858') ||
      simRoom.players.find(p => p.isBot);

    assert(simHuman, scenario.label + ': human fixture missing');
    assert(simResponder, scenario.label + ': responder bot missing');
    simResponder.role = '\u8a31\u9858';

    const simInterjectors = simRoom.players
      .filter(p => p.isBot && p.id !== simResponder.id)
      .slice(0, scenario.count);

    // Randomize the order of interjecting bots for every scenario.
    for (let k = simInterjectors.length - 1; k > 0; k--) {
      const swapIndex = Math.floor(Math.random() * (k + 1));
      [simInterjectors[k], simInterjectors[swapIndex]] =
        [simInterjectors[swapIndex], simInterjectors[k]];
    }

    assert(
      simInterjectors.length === scenario.count,
      scenario.label + ': not enough interjecting bots'
    );

    assert(simRd.beasts && simRd.beasts.length >= 2,
      scenario.label + ': not enough beasts');

    const simClaimBeast = simRd.beasts[0].name;
    const simTargetBeast =
      simRd.beasts.find(b => b.name !== simClaimBeast).name;

    const simRecords = [{
      playerId: simHuman.id,
      speakerName: simHuman.name,
      source: 'human',
      text: simClaimBeast +
        '\u662f\u771f\u54c1\uff0c\u6211\u63d0\u51fa\u9019\u500b\u4e3b\u5f35\u3002',
      p: {
        claims: [{ beast: simClaimBeast, real: true }],
        callBeast: simClaimBeast,
        callBeasts: [simClaimBeast]
      }
    }];

    for (let j = 0; j < simInterjectors.length; j++) {
      const speaker = simInterjectors[j];
      simRecords.push({
        playerId: speaker.id,
        speakerName: speaker.name,
        source: 'bot',
        text: j % 2 === 0
          ? '\u6211\u5148\u89c0\u5bdf\u7968\u5dee\uff0c\u7a0d\u5f8c\u518d\u6c7a\u5b9a\u3002'
          : '\u6211\u5148\u4fdd\u7559\u770b\u6cd5\uff0c\u7b49\u5176\u4ed6\u4eba\u767c\u8a00\u3002',
        p: { claims: [], callBeast: null, callBeasts: [] }
      });
    }

    simRd.speeches.splice(0, simRd.speeches.length, ...simRecords);

    const orderedIds = [
      simHuman.id,
      ...simInterjectors.map(p => p.id),
      simResponder.id
    ];
    const orderedSet = new Set(orderedIds);
    simRd.speechOrder = [
      ...orderedIds,
      ...simRoom.players
        .filter(p => !orderedSet.has(p.id))
        .map(p => p.id)
    ];

    const simPlanned = Strategy.plan(simResponder, simRoom);
    assert(simPlanned && simPlanned.plan,
      scenario.label + ': strategy plan missing');

    simPlanned.plan.beast = simTargetBeast;
    simPlanned.plan.withheldClaims = [];
    simPlanned.plan.withholdInfo = false;

    const generated = Speech.localSpeech(
      simResponder, simRoom, simPlanned.plan, simPlanned.A
    );

    assert(
      generated.includes(simClaimBeast),
      scenario.label + ': response omitted the human claim beast'
    );

    assert(
      generated.includes(simTargetBeast),
      scenario.label + ': response omitted the different chosen target'
    );

    const acknowledgmentPattern = {
      test: text => acknowledgesHuman(text, simHuman.name, simClaimBeast)
    };

    assert(
      acknowledgmentPattern.test(generated),
      scenario.label + ': response did not acknowledge prior information; generated=' + JSON.stringify(generated) + '; claim=' + simClaimBeast + '; target=' + simTargetBeast + '; order=' + simInterjectors.map(p => p.name).join(' -> ')
    );

    assert(
      !generated.includes('第一棒'),
      scenario.label + ': a bot speaking after earlier public speakers must not use the first-speaker line; generated=' + JSON.stringify(generated)
    );

    const generatedCalls = Claims.parse(generated, simRoom, U.curRound(simRoom)).callBeasts || [];
    assert(
      generatedCalls.includes(simTargetBeast),
      scenario.label + ': response did not state its own voting choice; generated=' + JSON.stringify(generated) + '; calls=' + JSON.stringify(generatedCalls) + '; target=' + simTargetBeast
    );

    console.log('[MULTI-ORDER] ' + scenario.label + ': PASS order=' + simInterjectors.map(p => p.name).join(' -> '));
  }

  console.log('[MULTI-ORDER] All 3 multiplayer order scenarios passed.');
}

  assert(teamSpeech.includes(`【${teamClaimBeast}】`), 'local speech must acknowledge the prior human claim');
  assert(teamSpeech.includes(`【${teamTargetBeast}】`), 'local speech must explain the different selected vote target');
  assert(acknowledgesHuman(teamSpeech, teamHuman.name, teamClaimBeast), 'team-response should attribute the human claim/call instead of requiring a fixed acknowledgment phrase; generated=' + JSON.stringify(teamSpeech));

  // True Fang may use a subtle person-reading hint only after an actual camp-check record exists.
  const fangSignalRoom = makeRoom('TRUE_FANG_SIGNAL');
  const fangSignalRd = U.curRound(fangSignalRoom);
  const fangSignalBot = fangSignalRoom.players.find(p => p.isBot && p.role === '方震') || fangSignalRoom.players.find(p => p.isBot);
  const priorFangHolder = fangSignalRoom.players.find(p => p.id !== fangSignalBot.id && p.role === '方震');
  const fangOldRole = fangSignalBot.role;
  if (priorFangHolder) priorFangHolder.role = fangOldRole;
  fangSignalBot.role = '方震';
  fangSignalBot.genes = fangSignalBot.genes || GD.Genes.load(fangSignalBot.botId);
  const fangPeer = fangSignalRoom.players.find(p => p.id !== fangSignalBot.id);
  fangSignalRd.turnLogs[fangSignalBot.id] = { inspect: [], fangTargetId: fangPeer.id, fangCamp: 'good', blind: false, skillTag: '', ability: '', step: 'c' };
  fangSignalRd.speeches.push({ playerId: fangPeer.id, speakerName: fangPeer.name, source: 'bot',
    text: '我是方震，但請先核對紀錄。', p: { selfRole: '方震', claims: [], callBeasts: [], accuse: [], campChecks: [] } });
  const fangCtx = Mind.context(fangSignalBot, fangSignalRoom);
  const fangChanceForTest = U.clamp(0.035 + 0.06 * fangCtx.genes.assertiveness + 0.05 + 0.28, 0.02, 0.62);
  for (let i = 0; i < 1000; i++) {
    const candidateId = `TRUE_FANG_SIGNAL_TEST_${i}`;
    const seedText = `${candidateId}:${fangSignalRoom.roomId || ''}:${fangSignalRoom.currentRoundIdx}:${fangSignalRd.passOrder.indexOf(fangSignalBot.id)}:true-role:方震:contested:unpressured:fresh`;
    if ((DialogueBank.hash(seedText) % 10000) / 10000 < fangChanceForTest) {
      fangSignalBot.botId = candidateId;
      break;
    }
  }
  const oldRandomForFang = Math.random;
  let fangPlanResult;
  try {
    Math.random = () => 0;
    fangPlanResult = Strategy.plan(fangSignalBot, fangSignalRoom);
  } finally {
    Math.random = oldRandomForFang;
  }
  assert(fangPlanResult.plan.trueRoleSignal, 'a genuine Fang with a recorded camp check should be able to soft-signal when another player claims the role');
  assert(!fangPlanResult.plan.trueRoleSignal.line.includes('方震'), 'the genuine Fang signal must not name the forbidden role');
  const fangSignalSpeech = Speech.localSpeech(fangSignalBot, fangSignalRoom, fangPlanResult.plan, fangPlanResult.A);
  assert(fangSignalSpeech.includes(fangPlanResult.plan.trueRoleSignal.line), 'true Fang fallback should include its safe micro-signal');
  assert(Speech.validate(fangSignalSpeech, fangSignalBot, fangSignalRoom, fangPlanResult.plan, fangPlanResult.A).ok,
    'true Fang micro-signal should pass the existing safety validator');
  const filledFangSignal = DialogueBank.pick('trueFangSignal', 0, { target: U.tag(fangPeer) });
  assert.strictEqual(DialogueBank.detectRoleSignal(filledFangSignal)?.role, '方震', 'person-target role signal should be recognized after variable filling');
  const review = GD.Review.build(room, bot);
  const firstRoundSteps = review.rounds[0].steps.map(step => step.k);
  assert(firstRoundSteps.includes('全局算票預測'), 'post-game review should expose the vote forecast');
  assert(firstRoundSteps.includes('保真得分估值'), 'post-game review should expose the score projection');
  assert(firstRoundSteps.includes('分票方案覆盤'), 'post-game review should expose ballot optimization diagnostics');

  // Public accusations should explicitly name a plausible role hypothesis instead of only saying "focus them".
  const roleTarget = room.players.find(p => p.id !== bot.id);
  analysis.prof[roleTarget.id].probs['老朝奉'] = 68;
  const roleHypothesisPlan = { ...planned.plan, suspectId: roleTarget.id, followHuman: null, roleBluff: null, fakeFangClaim: null, tacticalLine: '' };
  const roleHypothesisText = Speech.localSpeech(bot, room, roleHypothesisPlan, analysis);
  assert(roleHypothesisText.includes('可能是【老朝奉】') && roleHypothesisText.includes('這只是推測'), 'speech should state a relative role hypothesis in natural, explicitly tentative language');
  assert(!/角色後驗約\s*\d+%/.test(roleHypothesisText), 'speech must not present uncalibrated role-logit softmax as a posterior probability');

  // Exact false Fang bluff: permitted only when it matches the explicit target/camp plan.
  const fangBluffer = room.players.find(p => p.isBot && GD.isGood(p.role) && p.role !== '方震');
  assert(fangBluffer, 'a non-Fang good bot should exist for fake Fang validation');
  const fangA = Mind.analyze(fangBluffer, room);
  const fangTarget = room.players.find(p => p.id !== fangBluffer.id && p.role !== '方震');
  const fangBeast = rd.beasts[0].name;
  const fangPlan = { mode: 'truth', beast: fangBeast, claims: [], avoid: [], fakeFangClaim: { targetId: fangTarget.id, isGoodCamp: true } };
  const fangText = `我是方震，我查驗${U.tag(fangTarget)}是好人。我的票投【${fangBeast}】，後續請按公開票型反查。`;
  const fangResult = Speech.validate(fangText, fangBluffer, room, fangPlan, fangA);
  assert(fangResult.ok, `planned fake Fang claim should validate: ${fangResult.why}`);
  const wrongFangText = `我是方震，我查驗${U.tag(fangTarget)}是壞人。我的票投【${fangBeast}】，後續請按公開票型反查。`;
  assert(!Speech.validate(wrongFangText, fangBluffer, room, fangPlan, fangA).ok, 'fake Fang validation must reject a mismatched camp');

  // A true Fang must never repeat another player's public false-role claim in local fallback speech.
  let trueFang = room.players.find(p => p.isBot && p.role === '方震');
  const originalTestRole = trueFang ? null : (trueFang = room.players.find(p => p.isBot), trueFang.role);
  assert(trueFang, 'a bot should be available for the true-Fang safety test');
  if (originalTestRole !== null) trueFang.role = '方震';
  const trueFangPlanResult = Strategy.plan(trueFang, room);
  trueFangPlanResult.A.topSuspect = {
    player: room.players.find(p => p.id !== trueFang.id),
    evil: 90,
    said: ['橘色【某玩家】跨輪自稱【木戶加奈】與【方震】，身份版本前後改變，需對照紀錄。']
  };
  const trueFangText = Speech.localSpeech(trueFang, room, trueFangPlanResult.plan, trueFangPlanResult.A);
  assert(!trueFangText.includes('方震'), 'true Fang local speech must omit evidence lines mentioning its forbidden role name');
  assert(Speech.validate(trueFangText, trueFang, room, trueFangPlanResult.plan, trueFangPlanResult.A).ok,
    'sanitized true Fang local speech should pass the existing validator');
  if (originalTestRole !== null) trueFang.role = originalTestRole;

  // False role claim by an evil bot is valid only when it is in the explicit plan.
  const evilBot = room.players.find(p => p.isBot && !GD.isGood(p.role));
  assert(evilBot, 'role deck should contain an evil bot');
  const evilA = Mind.analyze(evilBot, room);
  const evilBeast = rd.beasts[0].name;
  const bluffRole = evilBot.role === '許願' ? '方震' : '許願';
  const evilPlan = { mode: 'camouflage', beast: evilBeast, claims: [{ beast: evilBeast, real: true }], roleBluff: { role: bluffRole } };
  const evilText = `我是${bluffRole}，這輪我公開主張【${evilBeast}】是真品。我這輪投【${evilBeast}】，後續仍可用公開線索核對。`;
  const evilResult = Speech.validate(evilText, evilBot, room, evilPlan, evilA);
  assert(evilResult.ok, `planned false role claim should validate: ${evilResult.why}`);

  // A planned high-risk false confession allows a good bot to impersonate Zheng Guoqu without changing its real role.
  const confessionBot = room.players.find(p => p.isBot && GD.isGood(p.role) && p.role !== '方震');
  const confessionA = Mind.analyze(confessionBot, room);
  const confessionBeast = rd.beasts[0].name;
  const confessionPlan = { mode: 'truth', beast: confessionBeast, claims: [], avoid: [], roleBluff: { role: '鄭國渠', fakeConfess: true } };
  const confessionText = '我是鄭國渠，我認壞。先別把這句當成定案，請用接下來的公開票型和角色對跳反查。我的票投【' + confessionBeast + '】。';
  const confessionResult = Speech.validate(confessionText, confessionBot, room, confessionPlan, confessionA);
  assert(confessionResult.ok, `explicit planned fake confession should validate: ${confessionResult.why}`);

  // Rename the same player ID: update machine-readable names while preserving raw historical speech.
  const renameRoom = makeRoom('TACTICS_RENAME');
  const human = renameRoom.players.find(p => !p.isBot);
  const renameRound = U.curRound(renameRoom);
  const rawText = '我原本的歷史發言仍保留當時的原句。';
  renameRound.speeches.push({ playerId: human.id, speakerName: human.name, text: rawText, source: 'human' });
  renameRound.voteResults = { chips: { 鼠: [{ voterId: human.id, voterName: human.name }] } };
  assert(Engine.reclaimPlayer(renameRoom, human.id, human.id, '改名測試者'), 'same-id rename should succeed');
  assert.strictEqual(renameRound.speeches[0].speakerName, '改名測試者', 'stored speaker display name should update');
  assert.strictEqual(renameRound.voteResults.chips.鼠[0].voterName, '改名測試者', 'stored vote chip name should update');
  assert.strictEqual(renameRound.speeches[0].text, rawText, 'historical utterance must remain unchanged');

  // A good third-position victim should frame the first-Yao/second-Lao idea as a rebuttable hypothesis, not a certain role verdict.
  const hypothesisRoom = makeRoom('PASS_ORDER_HYPOTHESIS');
  const hypothesisRd = U.curRound(hypothesisRoom);
  const hypothesisBot = hypothesisRoom.players.find(p => p.isBot && GD.isGood(p.role) && !['方震', '許願'].includes(p.role));
  assert(hypothesisBot, 'a non-Fang, non-Xu good bot should be available for the pass-order hypothesis test');
  const hypothesisFirst = hypothesisRoom.players.find(p => p.id !== hypothesisBot.id);
  const hypothesisSecond = hypothesisRoom.players.find(p => p.id !== hypothesisBot.id && p.id !== hypothesisFirst.id);
  hypothesisRd.passOrder = [hypothesisFirst.id, hypothesisSecond.id, hypothesisBot.id,
    ...hypothesisRoom.players.filter(p => ![hypothesisFirst.id, hypothesisSecond.id, hypothesisBot.id].includes(p.id)).map(p => p.id)];
  hypothesisRd.turnLogs[hypothesisBot.id] = { inspect: [], ability: '技能被偷襲封鎖', skillTag: '', blind: true, step: 'c' };
  hypothesisBot.isAmbushed = true;
  hypothesisRoom.currentTurnPlayerId = hypothesisBot.id;
  hypothesisRoom.status = 'playing';
  const hypothesisPlan = {
    mode: 'truth', beast: hypothesisRd.beasts[0].name, claims: [], avoid: [], suspectId: null,
    followHuman: null, hideBlind: false, roleBluff: null, fakeFangClaim: null, confess: false,
    bluff: false, tacticalLine: '', tactics: null,
    ambushFrameHypothesis: { firstId: hypothesisFirst.id, secondId: hypothesisSecond.id, victimId: hypothesisBot.id }
  };
  const hypothesisAnalysis = Mind.analyze(hypothesisBot, hypothesisRoom);
  const hypothesisSpeech = Speech.localSpeech(hypothesisBot, hypothesisRoom, hypothesisPlan, hypothesisAnalysis);
  assert(hypothesisSpeech.includes('藥不然') && hypothesisSpeech.includes('老朝奉'), 'third-position victim should mention both role hypotheses');
  assert(/假設|可反駁|不能當成已確認身分/.test(hypothesisSpeech), 'the role-order inference must be described as uncertain');
  assert(Speech.validate(hypothesisSpeech, hypothesisBot, hypothesisRoom, hypothesisPlan, hypothesisAnalysis).ok,
    'the uncertain role-order hypothesis should pass speech validation');

  // A second-position Yao may occasionally directly ambush the third unacted player, creating a deliberate blind-frame setup.
  const frameRoom = makeRoom('AMBUSH_FRAME_TEST');
  const frameRd = U.curRound(frameRoom);
  function assignRole(room, player, role) {
    const holder = room.players.find(p => p.role === role);
    if (!holder || holder.id === player.id) { player.role = role; return; }
    const prior = player.role; player.role = holder.role; holder.role = prior;
  }
  const frameYao = frameRoom.players.find(p => p.isBot);
  const frameLao = frameRoom.players.find(p => p.isBot && p.id !== frameYao.id);
  assert(frameYao && frameLao, 'ambush frame test needs two bot players');
  assignRole(frameRoom, frameYao, '藥不然');
  assignRole(frameRoom, frameLao, '老朝奉');
  frameYao.genes = { ...(frameYao.genes || GD.Genes.load(frameYao.botId)), deception: 1, camouflage: 0.5, assertiveness: 0.8, skepticism: 0.5, conformity: 0.5 };
  // Start with only Lao in the pass order. A complete game must let Lao intentionally lead into Yao's second position.
  frameRd.passOrder = [frameLao.id];
  frameRoom.currentTurnPlayerId = frameLao.id;
  frameRoom.status = 'playing';
  frameRd.turnLogs[frameLao.id] = { inspect: [], ability: '無技能操作', skillTag: '', blind: false, step: 'c' };
  frameRd.turnLogs[frameYao.id] = { inspect: [], ability: '無技能操作', skillTag: '', blind: false, step: 'b' };
  const frameChance = 0.20 + 0.38 * frameYao.genes.deception;
  let frameSeedFound = false;
  for (let i = 0; i < 20000; i++) {
    frameRoom.roomId = `AMBUSH_FRAME_TEST_${i}`;
    const seedText = `${frameYao.botId || frameYao.id}:${frameRoom.roomId}:${frameRoom.currentRoundIdx}:1:YAO_THIRD_SEAT_FRAME`;
    if ((DialogueBank.hash(seedText) % 10000) / 10000 < frameChance) { frameSeedFound = true; break; }
  }
  assert(frameSeedFound, 'test should find a deterministic seed where Yao activates the framing tactic');
  const oldRandomFrame = Math.random;
  let frameA, frameAction, framePass;
  try {
    Math.random = () => 0.5;
    const laoA = Mind.analyze(frameLao, frameRoom);
    const laoNext = Strategy.nextPlayer(frameLao, frameRoom, laoA);
    assert.strictEqual(laoNext, frameYao.id, 'real Lao should deliberately pass directly to Yao when the shared frame roll activates');
    assert(Engine.pass(frameRoom, frameLao.id, laoNext), 'Lao should legally pass to Yao as the second actor');
    assert.deepStrictEqual(frameRd.passOrder.slice(0, 2), [frameLao.id, frameYao.id], 'Lao-to-Yao setup must be present before the ambush skill');
    frameA = Mind.analyze(frameYao, frameRoom);
    frameAction = Strategy.skill(frameYao, frameRoom, frameA);
    assert.strictEqual(frameAction.kind, 'yao', 'the real Yao must select an ambush skill');
    assert.strictEqual(frameRd.turnLogs[frameYao.id].ambushFrameTactic, true, 'Yao should mark the deliberate frame tactic');
    assert(Engine.skill(frameRoom, frameYao.id, frameAction), 'the ambush skill should execute legally');
    framePass = Strategy.nextPlayer(frameYao, frameRoom, frameA);
    assert.strictEqual(framePass, frameAction.targetId, 'the deliberate frame must pass directly to the newly ambushed target');
    assert(Engine.pass(frameRoom, frameYao.id, framePass), 'Yao should pass directly to the target');
  } finally {
    Math.random = oldRandomFrame;
  }
  const frameVictim = U.byId(frameRoom, frameAction.targetId);
  assert(frameVictim && frameRd.passOrder.indexOf(frameVictim.id) === 2, 'the targeted victim should become the third pass-order actor');
  const frameVictimLog = Engine.log(frameRoom, frameVictim.id);
  assert.strictEqual(frameVictimLog.blind, true, 'the third actor should actually be blind from the ambush');
  const yaoPlanResult = Strategy.plan(frameYao, frameRoom);
  assert(yaoPlanResult.plan.roleSwapTrap && yaoPlanResult.plan.roleSwapTrap.origin === 'ambush-role-swap', 'the setup should create a role-swap context');
  assert.strictEqual(yaoPlanResult.plan.roleBluff.role, '老朝奉', 'real Yao should falsely claim Lao in the swap trap');
  assert.strictEqual(yaoPlanResult.plan.roleBluff.persist, true, 'the swap claim should be a persistent commitment');
  const yaoSpeech = Speech.localSpeech(frameYao, frameRoom, yaoPlanResult.plan, yaoPlanResult.A);
  assert(yaoSpeech.includes('我是老朝奉'), 'local fallback must state the planned exchanged identity');
  assert(Speech.validate(yaoSpeech, frameYao, frameRoom, yaoPlanResult.plan, yaoPlanResult.A).ok,
    'the role-swap framing speech must pass validation');
  const laoPlanResult = Strategy.plan(frameLao, frameRoom);
  assert.strictEqual(laoPlanResult.plan.roleBluff.role, '藥不然', 'real Lao should falsely claim Yao in the swap trap');
  assert.strictEqual(laoPlanResult.plan.roleBluff.persist, true, 'Lao should share the persistent swap commitment');
  const laoSpeech = Speech.localSpeech(frameLao, frameRoom, laoPlanResult.plan, laoPlanResult.A);
  assert(laoSpeech.includes('我是藥不然'), "local fallback must state Lao's exchanged identity");
  assert(Speech.validate(laoSpeech, frameLao, frameRoom, laoPlanResult.plan, laoPlanResult.A).ok,
    'the other half of the role-swap speech must pass validation');
  const thirdEvil = frameRoom.players.find(p => p.isBot && !GD.isGood(p.role) && p.role !== '藥不然' && p.role !== '老朝奉');
  if (thirdEvil) {
    const thirdEvilPlan = Strategy.plan(thirdEvil, frameRoom);
    assert.strictEqual(thirdEvilPlan.plan.roleSwapTrap, null, 'the third evil role must not be incorrectly assigned the Lao/Yao swap context');
  }

  // The same false-role commitment must survive into the following round without being overridden by a routine vote-count confession.
  const yaoParsed = Claims.parse(yaoSpeech, frameRoom, frameRd);
  frameRd.speeches.push({ playerId: frameYao.id, speakerName: frameYao.name, colorId: frameYao.colorId, text: yaoSpeech, source: 'bot', p: yaoParsed });
  const nextFrameRound = Engine.drawRound(frameRoom, 2);
  frameRoom.rounds.push(nextFrameRound);
  frameRoom.currentRoundIdx = 1;
  nextFrameRound.passOrder = [frameLao.id, frameYao.id, ...frameRoom.players.filter(p => p.id !== frameLao.id && p.id !== frameYao.id).map(p => p.id)];
  nextFrameRound.turnLogs[frameYao.id] = { inspect: [], ability: '無技能操作', skillTag: '', blind: false, step: 'c' };
  frameRoom.currentTurnPlayerId = frameYao.id;
  frameRoom.status = 'playing';
  const continuedYaoPlan = Strategy.plan(frameYao, frameRoom);
  assert.strictEqual(continuedYaoPlan.plan.roleBluff.role, '老朝奉', 'Yao should retain the same false role in round two');
  assert.strictEqual(continuedYaoPlan.plan.roleBluff.persist, true, 'the persistent commitment should not expire after one round');
  assert.strictEqual(continuedYaoPlan.plan.roleBluff.continued, true, 'the strategy should mark the denial as continued');
  const continuedSpeech = Speech.localSpeech(frameYao, frameRoom, continuedYaoPlan.plan, continuedYaoPlan.A);
  assert(continuedSpeech.includes('我是老朝奉'), 'continued denial should repeat the same planned public role');
  assert(Speech.validate(continuedSpeech, frameYao, frameRoom, continuedYaoPlan.plan, continuedYaoPlan.A).ok,
    'continued role denial should pass validation');
  nextFrameRound.speeches.push({ playerId: frameYao.id, speakerName: frameYao.name, colorId: frameYao.colorId,
    text: continuedSpeech, source: 'bot', p: Claims.parse(continuedSpeech, frameRoom, nextFrameRound) });
  const thirdFrameRound = Engine.drawRound(frameRoom, 3);
  frameRoom.rounds.push(thirdFrameRound);
  frameRoom.currentRoundIdx = 2;
  thirdFrameRound.passOrder = [frameLao.id, frameYao.id, ...frameRoom.players.filter(p => p.id !== frameLao.id && p.id !== frameYao.id).map(p => p.id)];
  thirdFrameRound.turnLogs[frameYao.id] = { inspect: [], ability: '無技能操作', skillTag: '', blind: false, step: 'c' };
  frameRoom.currentTurnPlayerId = frameYao.id;
  frameRoom.status = 'playing';
  const thirdRoundYaoPlan = Strategy.plan(frameYao, frameRoom);
  assert.strictEqual(thirdRoundYaoPlan.plan.roleBluff.role, '老朝奉', 'the false role should remain unchanged in round three');
  assert.strictEqual(thirdRoundYaoPlan.plan.roleBluff.persist, true, 'the identity commitment should remain active in the final round');
  assert.strictEqual(thirdRoundYaoPlan.plan.roleBluff.continued, true, 'round-three denial should be marked as continued');
  const thirdRoundYaoSpeech = Speech.localSpeech(frameYao, frameRoom, thirdRoundYaoPlan.plan, thirdRoundYaoPlan.A);
  assert(thirdRoundYaoSpeech.includes('我是老朝奉'), 'round three should preserve the previously claimed identity');
  assert(Speech.validate(thirdRoundYaoSpeech, frameYao, frameRoom, thirdRoundYaoPlan.plan, thirdRoundYaoPlan.A).ok,
    'round-three persistent denial should pass validation');

  // v10.5 strategy calibration: first-three pass-order claims are a stronger prior, not a guarantee.
  assert(Mind.passPositionPrior(0) > Mind.passPositionPrior(3), 'first pass positions should get a stronger information prior than position four');
  assert(Mind.passPositionPrior(2) > Mind.passPositionPrior(7), 'third position should generally carry more weight than eighth position');
  const lateCounterRead = Mind.voteViewAdjustment({
    myPosition: 2, voterPosition: 7, privateView: true, claimedFalse: true,
    mentionsLao: false, plausibleLaoBefore: true, chipCount: 4
  });
  assert.strictEqual(lateCounterRead.reverseRead, true, 'late false-claim + concentrated vote + plausible Lao reversal should be read as a possible counter-read');
  assert.strictEqual(lateCounterRead.multiplier, 0.28, 'plausible but unmentioned reversal should remain a possibility, not certainty');
  const explicitlyReasonedCounterRead = Mind.voteViewAdjustment({
    myPosition: 2, voterPosition: 7, privateView: true, claimedFalse: true,
    mentionsLao: true, plausibleLaoBefore: true, chipCount: 4
  });
  assert.strictEqual(explicitlyReasonedCounterRead.multiplier, 0.12, 'explicit reversal reasoning plus plausible timing should receive the strongest counter-read discount');
  const heavyVoteWithoutReversalCue = Mind.voteViewAdjustment({
    myPosition: 2, voterPosition: 7, privateView: true, claimedFalse: true,
    mentionsLao: false, plausibleLaoBefore: false, chipCount: 4
  });
  assert.strictEqual(heavyVoteWithoutReversalCue.reverseRead, false, 'multi-chip commitment alone must not be treated as proof of a Lao reversal');
  assert.strictEqual(heavyVoteWithoutReversalCue.multiplier, 0.45, 'without reversal evidence, use the ordinary late-position caution');
  const sameBandRead = Mind.voteViewAdjustment({ myPosition: 1, voterPosition: 2, privateView: true, claimedFalse: false, chipCount: 2 });
  assert.strictEqual(sameBandRead.multiplier, 1, 'adjacent positions without a reversal boundary should not be mechanically discounted');

  // A repeated, high-confidence early claim is deliberately withheld from the public script, while the internal vote decision remains intact.
  const disclosureRoom = makeRoom('REDUNDANT_INFO_WITHHOLD');
  const disclosureRd = U.curRound(disclosureRoom);
  const disclosureBot = disclosureRoom.players.find(p => p.isBot && GD.isGood(p.role) && !['方震', '許願'].includes(p.role));
  assert(disclosureBot, 'disclosure test needs a non-Fang, non-Xu good bot');
  const disclosurePeers = disclosureRoom.players.filter(p => p.id !== disclosureBot.id).slice(0, 3);
  const disclosureBeast = disclosureRd.beasts[0].name;
  disclosureRd.passOrder = [disclosurePeers[0].id, disclosurePeers[1].id, disclosurePeers[2].id,
    disclosureBot.id, ...disclosureRoom.players.filter(p => ![disclosureBot.id, ...disclosurePeers.map(x => x.id)].includes(p.id)).map(p => p.id)];
  disclosureRd.speechOrder = [disclosurePeers[0].id, disclosurePeers[1].id, disclosureBot.id, disclosurePeers[2].id,
    ...disclosureRoom.players.filter(p => ![disclosureBot.id, ...disclosurePeers.map(x => x.id)].includes(p.id)).map(p => p.id)];
  disclosureRd.speeches = disclosurePeers.slice(0, 2).map(p => ({
    playerId: p.id, speakerName: p.name, source: 'bot', text: `我先報【${disclosureBeast}】真品。`,
    p: { claims: [{ beast: disclosureBeast, real: true }], callBeast: disclosureBeast, callBeasts: [disclosureBeast], accuse: [], asked: [] }
  }));
  const disclosureCtx = Mind.context(disclosureBot, disclosureRoom);
  const disclosureA = Mind.analyze(disclosureBot, disclosureRoom);
  disclosureA.post = disclosureRd.beasts.map(b => ({ name: b.name, pReal: b.name === disclosureBeast ? 0.94 : 0.5 }));
  const disclosurePlan = { claims: [{ beast: disclosureBeast, real: true }], why: [], mode: 'truth', beast: disclosureRd.beasts[1].name };
  const disclosureResult = Strategy.reduceRedundantPublicClaims(disclosureBot, disclosureRoom, disclosureCtx, disclosureA, disclosurePlan);
  assert.strictEqual(disclosureResult.hidden.length, 1, 'high-confidence duplicate information from the first three pass positions should be withheld');
  assert.strictEqual(disclosurePlan.claims.length, 0, 'a fully redundant claim should not be emitted publicly');
  assert.strictEqual(disclosurePlan.withholdInfo, true, 'withheld information should be explicitly marked for speech prompting and validation');
  const disclosureSpeech = Speech.localSpeech(disclosureBot, disclosureRoom, disclosurePlan, disclosureA);
  assert(/不重複|不再重複|保留/.test(disclosureSpeech), 'fallback speech should explain the choice to withhold rather than claim no inspection occurred');
  const disclosureValidation = Speech.validate(disclosureSpeech, disclosureBot, disclosureRoom, disclosurePlan, disclosureA);
  assert(disclosureValidation.ok, `withholding speech must pass validation: ${disclosureValidation.why}`);
  assert(!disclosureValidation.parsed.claims.some(c => c.beast === disclosureBeast && c.real === true), 'withheld result must not leak as the speaker’s own claim');

  // Conflicting early statements keep the private result available for a direct reply; do not hide the useful contradiction.
  const conflictDisclosurePlan = { claims: [{ beast: disclosureBeast, real: true }], why: [], mode: 'truth', beast: disclosureRd.beasts[1].name };
  disclosureRd.speeches.push({ playerId: disclosurePeers[2].id, speakerName: disclosurePeers[2].name, source: 'bot',
    text: `我認為【${disclosureBeast}】贗品。`, p: { claims: [{ beast: disclosureBeast, real: false }], accuse: [], asked: [] } });
  // This opposing claim must be earlier than the current bot in speechOrder, otherwise it is not an available reply cue yet.
  disclosureRd.speechOrder = [disclosurePeers[0].id, disclosurePeers[1].id, disclosurePeers[2].id, disclosureBot.id,
    ...disclosureRoom.players.filter(p => ![disclosureBot.id, ...disclosurePeers.map(x => x.id)].includes(p.id)).map(p => p.id)];
  const conflictDisclosure = Strategy.reduceRedundantPublicClaims(disclosureBot, disclosureRoom, disclosureCtx, disclosureA, conflictDisclosurePlan);
  assert.strictEqual(conflictDisclosure.hidden.length, 0, 'an early independent contradiction should not be suppressed as redundant');
  assert.strictEqual(conflictDisclosurePlan.claims.length, 1, 'the useful contradiction must remain available for public response');

  // Old speech records may have p.claims=[], while the visible text still contains claims; the withholding logic must read the text.
  const textDisclosureRoom = makeRoom('TEXT_ONLY_REDUNDANT_DISCLOSURE');
  const textDisclosureRd = U.curRound(textDisclosureRoom);
  const textDisclosureBot = textDisclosureRoom.players.find(p => p.isBot && GD.isGood(p.role) && p.role !== '方震');
  assert(textDisclosureBot, 'text-only disclosure test needs a good bot');
  const textDisclosurePeers = textDisclosureRoom.players.filter(p => p.id !== textDisclosureBot.id).slice(0, 2);
  const textDisclosureBeast = textDisclosureRd.beasts[0].name;
  textDisclosureRd.passOrder = [textDisclosurePeers[0].id, textDisclosurePeers[1].id, textDisclosureBot.id,
    ...textDisclosureRoom.players.filter(p => ![textDisclosureBot.id, ...textDisclosurePeers.map(x => x.id)].includes(p.id)).map(p => p.id)];
  textDisclosureRd.speechOrder = [textDisclosurePeers[0].id, textDisclosurePeers[1].id, textDisclosureBot.id,
    ...textDisclosureRoom.players.filter(p => ![textDisclosureBot.id, ...textDisclosurePeers.map(x => x.id)].includes(p.id)).map(p => p.id)];
  textDisclosureRd.speeches = textDisclosurePeers.map(p => ({ playerId: p.id, speakerName: p.name, source: 'bot',
    text: `我認為【${textDisclosureBeast}】是真品，請對照票型。`, p: { claims: [], callBeasts: [], accuse: [], asked: [] } }));
  const textDisclosureCtx = Mind.context(textDisclosureBot, textDisclosureRoom);
  const textDisclosureAnalysis = Mind.analyze(textDisclosureBot, textDisclosureRoom);
  textDisclosureAnalysis.post = textDisclosureRd.beasts.map(b => ({ name: b.name, pReal: b.name === textDisclosureBeast ? 0.60 : 0.5 }));
  const textDisclosurePlan = { claims: [{ beast: textDisclosureBeast, real: true }], why: [], mode: 'truth', beast: textDisclosureRd.beasts[1].name };
  const textDisclosure = Strategy.reduceRedundantPublicClaims(textDisclosureBot, textDisclosureRoom, textDisclosureCtx, textDisclosureAnalysis, textDisclosurePlan);
  assert.strictEqual(textDisclosure.hidden.length, 1, 'two visible text claims should be enough for redundancy even when structured claim arrays are empty');

  // A true Xu Yuan may also strategically withhold a redundant beast result; this is not limited to ordinary good roles.
  const xuDisclosureRoom = makeRoom('XU_REDUNDANT_INFO_WITHHOLD');
  const xuDisclosureRd = U.curRound(xuDisclosureRoom);
  const xuDisclosureBot = xuDisclosureRoom.players.find(p => p.isBot);
  assert(xuDisclosureBot, 'disclosure test needs a bot that can be assigned Xu Yuan for the isolated strategy test');
  xuDisclosureBot.role = '許願';
  const xuDisclosurePeers = xuDisclosureRoom.players.filter(p => p.id !== xuDisclosureBot.id).slice(0, 2);
  const xuDisclosureBeast = xuDisclosureRd.beasts[0].name;
  xuDisclosureRd.passOrder = [xuDisclosurePeers[0].id, xuDisclosurePeers[1].id, xuDisclosureBot.id,
    ...xuDisclosureRoom.players.filter(p => ![xuDisclosureBot.id, ...xuDisclosurePeers.map(x => x.id)].includes(p.id)).map(p => p.id)];
  xuDisclosureRd.speechOrder = [xuDisclosurePeers[0].id, xuDisclosurePeers[1].id, xuDisclosureBot.id,
    ...xuDisclosureRoom.players.filter(p => ![xuDisclosureBot.id, ...xuDisclosurePeers.map(x => x.id)].includes(p.id)).map(p => p.id)];
  xuDisclosureRd.speeches = xuDisclosurePeers.map(p => ({ playerId: p.id, speakerName: p.name, source: 'bot',
    text: `我先報【${xuDisclosureBeast}】真品。`, p: { claims: [{ beast: xuDisclosureBeast, real: true }], accuse: [], asked: [] } }));
  const xuDisclosureCtx = Mind.context(xuDisclosureBot, xuDisclosureRoom);
  const xuDisclosureAnalysis = Mind.analyze(xuDisclosureBot, xuDisclosureRoom);
  xuDisclosureAnalysis.post = xuDisclosureRd.beasts.map(b => ({ name: b.name, pReal: b.name === xuDisclosureBeast ? 0.95 : 0.5 }));
  const xuDisclosurePlan = { claims: [{ beast: xuDisclosureBeast, real: true }], why: [], mode: 'truth', beast: xuDisclosureRd.beasts[1].name };
  const xuDisclosure = Strategy.reduceRedundantPublicClaims(xuDisclosureBot, xuDisclosureRoom, xuDisclosureCtx, xuDisclosureAnalysis, xuDisclosurePlan);
  assert.strictEqual(xuDisclosure.hidden.length, 1, 'Xu Yuan may withhold an already-repeated result instead of automatically disclosing every inspection');

  // Multi-chip habits are measured from prior public ballots and influence forecasts; 2+ chips are not treated as an impossible one-vote-only action.
  const commitmentRoom = makeRoom('MULTI_CHIP_PUBLIC_HISTORY');
  const commitmentPlayer = commitmentRoom.players.find(p => p.id !== 'human');
  assert(commitmentPlayer, 'commitment test needs a voter');
  const commitmentR1 = U.curRound(commitmentRoom);
  const commitmentBeast = commitmentR1.beasts[0].name;
  const otherBeast = commitmentR1.beasts[1].name;
  commitmentR1.speeches.push({ playerId: commitmentPlayer.id, speakerName: commitmentPlayer.name, source: 'bot',
    text: `我號召投【${otherBeast}】。`, p: { callBeast: otherBeast, callBeasts: [otherBeast], claims: [], accuse: [], asked: [] } });
  commitmentR1.votes[commitmentPlayer.id] = { [commitmentBeast]: 2 };
  const commitmentR2 = Engine.drawRound(commitmentRoom, 2);
  commitmentRoom.rounds.push(commitmentR2);
  commitmentRoom.currentRoundIdx = 1;
  commitmentR2.passOrder = commitmentRoom.players.map(p => p.id);
  commitmentR2.speechOrder = commitmentRoom.players.map(p => p.id);
  commitmentR2.speeches.push({ playerId: commitmentPlayer.id, speakerName: commitmentPlayer.name, source: 'bot',
    text: `這輪主張【${commitmentR2.beasts[0].name}】真品，請依票型判斷。`,
    p: { claims: [{ beast: commitmentR2.beasts[0].name, real: true }], callBeast: commitmentR2.beasts[0].name,
      callBeasts: [commitmentR2.beasts[0].name], accuse: [], asked: [] } });
  commitmentPlayer.voteBank = 2;
  const commitmentProfile = Tactics.historicalBallotProfile(commitmentRoom, commitmentPlayer.id);
  assert.strictEqual(commitmentProfile.roundsObserved, 1, 'one prior public ballot should be observed');
  assert.strictEqual(commitmentProfile.multiChipRounds, 1, 'two chips concentrated on one target should count as a multi-chip commitment');
  assert.strictEqual(commitmentProfile.averagePrimaryShare, 1, 'a fully concentrated ballot should be recognized as concentrated');
  const commitmentForecast = Tactics.forecastVotes(commitmentRoom, 'human');
  const projectedCommitter = commitmentForecast.projectedVoters.find(v => v.id === commitmentPlayer.id);
  assert(projectedCommitter && projectedCommitter.history.multiChipRate === 1, 'forecast should carry the historical multi-chip style into its public voter model');
  assert(projectedCommitter.spendRate > 0.84, 'a historically heavy spender with an explicit call should have a slightly increased expected spend rate');
  const commitmentHistoryText = Speech.publicVoteCommitmentHistory(commitmentRoom);
  assert(commitmentHistoryText.includes('2票') && commitmentHistoryText.includes('0/2 票') && commitmentHistoryText.includes('未達半數'), 'speech prompt should expose the historical two-chip/call mismatch as public audit evidence');
  const withHistoryCallPref = projectedCommitter.preferences.find(x => x.name === commitmentR2.beasts[0].name)?.p || 0;
  const noHistoryRoom = JSON.parse(JSON.stringify(commitmentRoom));
  delete noHistoryRoom.rounds[0].votes[commitmentPlayer.id];
  const noHistoryForecast = Tactics.forecastVotes(noHistoryRoom, 'human');
  const noHistoryCommitter = noHistoryForecast.projectedVoters.find(v => v.id === commitmentPlayer.id);
  const withoutHistoryCallPref = noHistoryCommitter.preferences.find(x => x.name === commitmentR2.beasts[0].name)?.p || 0;
  assert(withHistoryCallPref < withoutHistoryCallPref, 'a repeated history of ignoring public calls should reduce how literally the vote forecaster trusts the next call');

  // Round-one-verified good should not automatically be put in the fourth pass position by a true Fang; only concealment pressure may justify it.
  function makeFangFourthRoom(withRolePressure) {
    const r = makeRoom(withRolePressure ? 'FANG_FOURTH_CONCEAL' : 'FANG_FOURTH_NORMAL');
    const fang = r.players.find(p => p.isBot && p.role === '方震') || r.players.find(p => p.isBot);
    const oldFang = r.players.find(p => p.id !== fang.id && p.role === '方震');
    if (oldFang) oldFang.role = fang.role;
    fang.role = '方震';
    const r2 = Engine.drawRound(r, 2);
    r.rounds.push(r2); r.currentRoundIdx = 1;
    const first = r.players.find(p => p.id !== fang.id);
    const second = r.players.find(p => p.id !== fang.id && p.id !== first.id);
    const verifiedGood = r.players.find(p => p.id !== fang.id && p.id !== first.id && p.id !== second.id);
    r.rounds[0].turnLogs[fang.id] = { inspect: [], fangTargetId: verifiedGood.id, fangCamp: 'good', blind: false, skillTag: '', ability: '', step: 'c' };
    if (withRolePressure) r.rounds[0].speeches.push({ playerId: first.id, speakerName: first.name, source: 'bot', text: '我是方震。',
      p: { selfRole: '方震', claims: [], campChecks: [], accuse: [], asked: [] } });
    r2.passOrder = [first.id, second.id, fang.id];
    r2.speechOrder = r.players.map(p => p.id);
    r2.turnLogs[fang.id] = { inspect: [], fangTargetId: null, fangCamp: null, blind: false, skillTag: '', ability: '', step: 'c' };
    return { room: r, fang, verifiedGood, first, second };
  }
  const normalFangCase = makeFangFourthRoom(false);
  const normalFangAnalysis = Mind.analyze(normalFangCase.fang, normalFangCase.room);
  const normalFangPass = Strategy.nextPlayer(normalFangCase.fang, normalFangCase.room, normalFangAnalysis);
  assert.notStrictEqual(normalFangPass, normalFangCase.verifiedGood.id, 'without public role pressure, true Fang should avoid sending the first-round verified good directly to position four');
  const concealFangCase = makeFangFourthRoom(true);
  const priorRandomForConceal = Math.random;
  let concealFangPass;
  try { Math.random = () => 0; concealFangPass = Strategy.nextPlayer(concealFangCase.fang, concealFangCase.room, Mind.analyze(concealFangCase.fang, concealFangCase.room)); }
  finally { Math.random = priorRandomForConceal; }
  assert.strictEqual(concealFangPass, concealFangCase.verifiedGood.id, 'when the true Fang is under explicit role pressure, a rare deliberate concealment pass remains allowed');

  // v10.6.2: historical attributions must be grounded in the alleged speaker's public record.
  const historyAuditRoom = makeRoom('HISTORICAL_ATTRIBUTION_AUDIT');
  const historyAuditRd = U.curRound(historyAuditRoom);
  const allegedSpeaker = historyAuditRoom.players.find(p => p.id === 'human');
  const allegedTarget = historyAuditRoom.players.find(p => p.id !== 'human');
  const historyObserver = historyAuditRoom.players.find(p => p.isBot && p.id !== allegedTarget.id && p.role !== '方震');
  assert(allegedSpeaker && allegedTarget && historyObserver, 'history audit test needs source, target and bot');
  const falseAttribution = `我記得${allegedSpeaker.name}曾公開指稱${U.tag(allegedTarget)}是方震，這會影響我目前的判斷。`;
  const missingHistory = Speech.auditPublicConsistency(falseAttribution, historyAuditRoom, historyObserver, {}, { ctx: { isGood: true } });
  assert(!missingHistory.ok && /沒有公開紀錄支持/.test(missingHistory.why), 'unsupported public role accusation must be rejected');
  historyAuditRd.speeches.push({ playerId: allegedSpeaker.id, speakerName: allegedSpeaker.name, source: 'human',
    text: `我懷疑${U.tag(allegedTarget)}是方震。`, p: { selfRole: null, claims: [], callBeasts: [], accuse: [], asked: [] } });
  const supportedAttribution = Speech.auditPublicConsistency(falseAttribution, historyAuditRoom, historyObserver, {}, { ctx: { isGood: true } });
  assert(supportedAttribution.ok, 'historical attribution with a matching earlier public accusation should pass');

  // v10.6.2: asking a player to explain a past vote must not be summarized as a call to focus them.
  const askOnly = `有件事要請${U.tag(allegedSpeaker)}說明一下：你過去投給後來公開判為贗品的獸，當時依據是什麼？`;
  const askOnlyParsed = Claims.parse(askOnly, historyAuditRoom, historyAuditRd);
  assert.strictEqual(askOnlyParsed.callSuspectId, null, 'a request for explanation is not a call to focus the player');
  const unsupportedFocus = `白色${U.tag(allegedSpeaker)}曾號召大家集火${U.tag(allegedTarget)}，所以我也懷疑他。`;
  const unsupportedFocusAudit = Speech.auditPublicConsistency(unsupportedFocus, historyAuditRoom, historyObserver, {}, { ctx: { isGood: true } });
  assert(!unsupportedFocusAudit.ok && /曾號召集火/.test(unsupportedFocusAudit.why), 'unsupported historical call-to-focus attribution must be rejected');
  historyAuditRd.speeches.push({ playerId: allegedSpeaker.id, speakerName: allegedSpeaker.name, source: 'human',
    text: `鑑人時我建議大家看緊${U.tag(allegedTarget)}，一起指認他！`, p: { callSuspectId: allegedTarget.id, claims: [], callBeasts: [] } });
  const supportedFocusAudit = Speech.auditPublicConsistency(unsupportedFocus, historyAuditRoom, historyObserver, {}, { ctx: { isGood: true } });
  assert(supportedFocusAudit.ok, 'a historical focus attribution backed by an explicit original call should pass');

  // Prior-speech prompts must not re-feed the potentially stale/generated summary as evidence.
  historyAuditRd.speeches[0].summary = '[AI] 號召集火錯誤對象';
  const promptPlan = Strategy.plan(historyObserver, historyAuditRoom);
  const promptText = Speech.buildPrompt(historyObserver, historyAuditRoom, promptPlan.plan, promptPlan.A);
  assert(!promptText.includes('系統摘要：'), 'speech prompt must use original public lines, not generated summaries');
  assert(promptText.includes('原話：'), 'speech prompt should explicitly label source dialogue as original quotes');

  // A historical beast verdict must be supported by the quoted source, but a grounded counterclaim is legal.
  const historyBeast = U.curRound(historyAuditRoom).beasts[0].name;
  const counterclaimText = `我不同意${U.tag(allegedSpeaker)}先前說「【${historyBeast}】是假品」，我判斷【${historyBeast}】是真品。`;
  const unsupportedBeastAttribution = Speech.auditPublicConsistency(counterclaimText, historyAuditRoom, historyObserver, {}, { ctx: { isGood: true } });
  assert(!unsupportedBeastAttribution.ok && /沒有公開紀錄支持/.test(unsupportedBeastAttribution.why), 'historical beast attribution without an original statement must be rejected');
  historyAuditRd.speeches.push({ playerId: allegedSpeaker.id, speakerName: allegedSpeaker.name, source: 'human',
    text: `我判斷【${historyBeast}】是假品。`, p: { claims: [{ beast: historyBeast, real: false }], callBeasts: [], accuse: [] } });
  const groundedCounterclaim = Speech.auditPublicConsistency(counterclaimText, historyAuditRoom, historyObserver, {}, { ctx: { isGood: true } });
  assert(groundedCounterclaim.ok, 'a grounded quotation followed by an explicit disagreement must not be mistaken for self-contradiction');

  // v10.6.2: explicit quote endorsement cannot conflict with the speaker's own opposite verdict.
  const contradictionRoom = makeRoom('SPEECH_CONTRADICTION_AUDIT');
  const contradictionRd = U.curRound(contradictionRoom);
  const contradictedBeast = contradictionRd.beasts[0].name;
  const quoteSource = contradictionRoom.players.find(p => p.id === 'human');
  const contradictionBot = contradictionRoom.players.find(p => p.isBot && p.role !== '方震');
  contradictionRd.speeches.push({ playerId: quoteSource.id, speakerName: quoteSource.name, source: 'human',
    text: `我判斷【${contradictedBeast}】是假品。`, p: { claims: [{ beast: contradictedBeast, real: false }], callBeasts: [] } });
  const contradictorySpeech = `${U.tag(quoteSource)}剛才說「【${contradictedBeast}】是假品」，這和我掌握的查驗結果一致。我認為【${contradictedBeast}】是真品。`;
  const contradictionAudit = Speech.auditPublicConsistency(contradictorySpeech, contradictionRoom, contradictionBot, {}, { ctx: { isGood: true } });
  assert(!contradictionAudit.ok && /反向宣稱/.test(contradictionAudit.why), 'endorsed quotation followed by opposite verdict must be rejected');

  // Legal multi-chip allocation and deliberate role jumping are not prohibited by the new audit.
  const legalBluffRoom = makeRoom('AUDIT_ALLOWS_ROLE_BLUFF');
  const legalBluffRd = U.curRound(legalBluffRoom);
  const legalBluffBot = legalBluffRoom.players.find(p => p.isBot && p.role !== '方震');
  const legalBluffTarget = legalBluffRoom.players.find(p => p.id !== legalBluffBot.id && p.id !== 'human');
  legalBluffRd.speeches.push({ playerId: legalBluffTarget.id, speakerName: legalBluffTarget.name, source: 'bot',
    text: '我是藥不然。', p: { selfRole: '藥不然', claims: [], callBeasts: [] } });
  assert(Speech.auditPublicConsistency(`我懷疑${U.tag(legalBluffTarget)}的角色主張需要再核對；我號召投【${legalBluffRd.beasts[0].name}】。`, legalBluffRoom, legalBluffBot, {}, { ctx: { isGood: true } }).ok,
    'new audit must not mechanically forbid another player role claim/counterclaim or vote splitting');

  console.log(`戰術引擎冒煙測試通過：${DialogueBank.count()} 條台詞｜${DialogueBank.categories().length} 類｜歷史歸因/原話摘要/多票與角色偽裝全數通過`);
  process.exit(0);
} catch (err) {
  console.error('戰術引擎冒煙測試失敗：', err.stack || err.message || err);
  process.exit(1);
}
