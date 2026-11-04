'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Claims, Mind, Strategy, Speech } = GD;
assert.strictEqual(GD.CONFIG.VERSION, '10.8.10', 'application version must match the current release');

function makeReplayRoom() {
  const room = Engine.newRoom('V1082_ACTUAL_MATCH_REPLAY', 'human');
  Engine.addPlayer(room, { id: 'human', name: 'Yan' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');

  const roster = [
    ['彥棋', '方震'], ['小黛', '鄭國渠'], ['H小姐', '老朝奉'], ['佩萱', '黃煙煙'],
    ['張懿', '許願'], ['凡凡', '藥不然'], ['卓毅', '姬雲浮']
  ];
  const bots = room.players.filter(p => p.isBot);
  assert.strictEqual(bots.length, 7, 'actual match fixture needs seven bots');
  roster.forEach(([name, role], i) => { bots[i].name = name; bots[i].role = role; });
  const byName = name => room.players.find(p => p.name === name);
  const yan = byName('Yan');
  yan.role = '木戶加奈';

  const rd1 = U.curRound(room);
  rd1.beasts = ['龍', '蛇', '馬', '羊'].map(name => ({ name }));
  rd1.passOrder = ['張懿', 'H小姐', 'Yan', '彥棋', '小黛', '佩萱', '凡凡', '卓毅'].map(name => byName(name).id);
  rd1.speechOrder = rd1.passOrder.slice();
  rd1.turnLogs = {};
  rd1.mind = {};
  rd1.voteResults = {
    totals: { 龍: 1, 蛇: 1, 馬: 1, 羊: 0 },
    rank1: { name: '龍', votes: 1, isReal: false, hidden: true },
    rank2: { name: '蛇', votes: 1, isReal: false, hidden: false }
  };
  const hSpeech = '我在第二位掌眼後，【蛇】是真品，包漿與工藝都穩。';
  rd1.speeches = [{ playerId: byName('H小姐').id, speakerName: 'H小姐', source: 'bot', text: hSpeech, p: Claims.parse(hSpeech, room, rd1) }];

  const rd2 = Engine.drawRound(room, 2);
  room.rounds.push(rd2);
  room.currentRoundIdx = 1;
  rd2.beasts = ['鼠', '虎', '兔', '豬'].map(name => ({ name }));
  rd2.passOrder = ['卓毅', '張懿', '小黛', '彥棋', '凡凡', 'H小姐', '佩萱', 'Yan'].map(name => byName(name).id);
  rd2.speechOrder = rd2.passOrder.slice();
  rd2.turnLogs = {};
  rd2.mind = {};
  rd2.voteResults = {
    totals: { 鼠: 0, 虎: 6, 兔: 0, 豬: 4 },
    rank1: { name: '虎', votes: 6, isReal: true, hidden: true },
    rank2: { name: '豬', votes: 4, isReal: false, hidden: false }
  };
  const reportText = '【張懿】與【佩萱】之中有老朝奉，我第一回驗【蛇】真，開出來【蛇】假，信我！';
  rd2.speeches = [{ playerId: yan.id, speakerName: 'Yan', source: 'human', text: reportText, p: Claims.parse(reportText, room, rd2) }];

  const rd3 = Engine.drawRound(room, 3);
  room.rounds.push(rd3);
  room.currentRoundIdx = 2;
  rd3.beasts = ['牛', '猴', '雞', '狗'].map(name => ({ name }));
  rd3.passOrder = ['Yan', '卓毅', '張懿', '小黛', 'H小姐', '凡凡', '彥棋', '佩萱'].map(name => byName(name).id);
  rd3.speechOrder = rd3.passOrder.slice();
  rd3.turnLogs = {};
  rd3.mind = {};
  return { room, byName, rd1, rd2, rd3, reportText };
}

try {
  const { room, byName, rd1, rd2, rd3, reportText } = makeReplayRoom();
  const observer = byName('卓毅');
  const zhang = byName('張懿');
  const huang = byName('H小姐');
  const peixuan = byName('佩萱');
  const yan = byName('Yan');

  const parsed = Claims.parse(reportText, room, rd2);
  assert.strictEqual(parsed.candidateSets.length, 1, 'must preserve the speaker’s one-of two-person Lao hypothesis');
  assert.deepStrictEqual(parsed.candidateSets[0].candidateIds.slice().sort(), [zhang.id, peixuan.id].sort(), 'candidate group must preserve exactly the named players');
  assert.deepStrictEqual(parsed.inspectionReports, [{ round: 1, beast: '蛇', claimedReal: true, text: '我第一回驗【蛇】真' }], 'must parse the public first-round inspection report');
  assert.strictEqual(parsed.claims.length, 0, 'historic private inspection and the public revealed result must not be mistaken for current-round beast claims');
  const rebuilt = Claims.parseRecord({ text: reportText, p: { candidateSets: [], inspectionReports: [] } }, room, rd2);
  assert.strictEqual(rebuilt.candidateSets.length, 1, 'parseRecord must rebuild public candidate groups from source wording');
  assert.strictEqual(rebuilt.inspectionReports.length, 1, 'parseRecord must rebuild public inspection reports from source wording');
  const quoted = Claims.parse('我聽到前手原話：【張懿】與【佩萱】之中有老朝奉，我第一回驗蛇真。', room, rd2);
  assert.strictEqual(quoted.candidateSets.length, 0, 'quoted candidate sets must not be attributed to the current speaker');
  assert.strictEqual(quoted.inspectionReports.length, 0, 'quoted historic reports must not be attributed to the current speaker');
  const negated = Claims.parse('我不認為【張懿】與【佩萱】之中有老朝奉；我沒有第一回驗【蛇】真。', room, rd2);
  assert.strictEqual(negated.candidateSets.length, 0, 'negated candidate hypotheses must not become claims');
  assert.strictEqual(negated.inspectionReports.length, 0, 'negated inspection reports must not become public evidence');

  const A = Mind.analyze(observer, room);
  const group = A.publicCandidateGroups.find(x => x.speakerId === yan.id && x.speechRound === 2);
  assert(group, 'Mind must retain the exact public candidate group from round two');
  assert.deepStrictEqual(group.candidateIds.slice().sort(), [zhang.id, peixuan.id].sort(), 'Mind must preserve the two-person hypothesis without treating both as guilty');
  const flip = A.publicReportedFlipPools.find(x => x.speakerId === yan.id && x.reportRound === 1 && x.beast === '蛇');
  assert(flip, 'Mind must cross-check the public historic report against the already opened result');
  assert.deepStrictEqual(flip.candidateIds, [zhang.id, huang.id], 'the timing pool must be based only on the actual first-round pass order before Yan');
  assert(!A.prof[zhang.id].knownEvil && !A.prof[peixuan.id].knownEvil, 'a public one-of hypothesis must not mark either candidate as confirmed evil');
  // Sealed rank1 must never be used to validate another player's public inspection report.
  const sealedReportText = '我第一回驗【龍】真，開出來【龍】假。';
  const sealedReport = Claims.parse(sealedReportText, room, rd2);
  assert.strictEqual(sealedReport.inspectionReports.length, 1, 'sealed-rank1 counterexample must parse the speaker report');

  const sealedSpeech = {
    playerId: huang.id,
    speakerName: 'H小姐',
    source: 'bot',
    text: sealedReportText,
    p: sealedReport
  };

  rd2.speeches.push(sealedSpeech);
  let sealedAnalysis;
  try {
    sealedAnalysis = Mind.analyze(observer, room);
  } finally {
    rd2.speeches.pop();
  }

  assert(
    !sealedAnalysis.publicReportedFlipPools.some(x =>
      x.speakerId === huang.id && x.reportRound === 1 && x.beast === '龍'
    ),
    'sealed rank1 internal truth must not create public inspection-mismatch evidence'
  );

  // A result without an explicit hidden:false flag must not be treated as public.
  const originalRank2Hidden = rd1.voteResults.rank2.hidden;
  try {
    rd1.voteResults.rank2.hidden = undefined;
    const unknownVisibilityAnalysis = Mind.analyze(observer, room);

    assert(
      !unknownVisibilityAnalysis.publicReportedFlipPools.some(x =>
        x.speakerId === yan.id && x.reportRound === 1 && x.beast === '蛇'
      ),
      'missing visibility metadata must not create public inspection-mismatch evidence'
    );
  } finally {
    rd1.voteResults.rank2.hidden = originalRank2Hidden;
  }
  const zhangView = Mind.analyze(zhang, room);
  const selfIncludedGroup = zhangView.publicCandidateGroups.find(x => x.speakerId === yan.id && x.speechRound === 2);
  assert(selfIncludedGroup && selfIncludedGroup.candidateIds.includes(zhang.id) && selfIncludedGroup.candidateIds.includes(peixuan.id), 'a bot named inside the hypothesis must retain itself in the public candidate set');

  const planned = Strategy.plan(observer, room);
  const prompt = Speech.buildPrompt(observer, room, planned.plan, planned.A);
  assert(prompt.includes(U.tag(zhang)) && prompt.includes(U.tag(peixuan)), 'Gemini prompt must preserve both candidates from the player’s hypothesis');
  assert(prompt.includes('之中一人是老朝奉'), 'Gemini prompt must state the candidate relationship as one-of, not two accusations');
  assert(prompt.includes(U.tag(huang)) && prompt.includes('公開結果為贗品'), 'Gemini prompt must surface the H小姐 timing candidate and public result mismatch');
  assert(prompt.includes('不是真實角色或私密查驗事實'), 'cross-round reasoning must be explicitly marked as public hypotheses, not hidden facts');

  // Final-person vote and displayed shortlist must share one scoring function.
  const allOthers = room.players.filter(p => p.id !== observer.id);
  const mkProfile = (player, evil, laoProb, ally = 0) => ({
    player, evil, ally, knownEvil: false, confessed: false, conflicts: [], reasons: ['公開證據回歸測試'],
    probs: { '老朝奉': laoProb, '藥不然': 10, '許願': 10, '方震': 10 }
  });
  const prof = {};
  allOthers.forEach(p => { prof[p.id] = mkProfile(p, 8, 8, 0); });
  prof[huang.id] = mkProfile(huang, 45, 60, 0);
  prof[byName('凡凡').id] = mkProfile(byName('凡凡'), 45, 60, 0);
  const syntheticA = {
    ctx: { bot: observer, room, t: 2, isGood: true, partner: null },
    prof, post: [], laoIntersectIds: [], publicCandidateGroups: A.publicCandidateGroups,
    publicReportedFlipPools: A.publicReportedFlipPools, publicCall: null
  };
  const oldAnalyze = Mind.analyze;
  const oldProjection = GD.Tactics.scoreProjection;
  try {
    Mind.analyze = () => syntheticA;
    GD.Tactics.scoreProjection = () => null;
    const decision = Strategy.personVote(observer, room);
    assert.strictEqual(decision.targetId, huang.id, 'final accusation must choose the strongest supported Lao candidate');
    assert.strictEqual(decision.top[0].id, decision.targetId, 'displayed top suspect must match the actual final-person vote');
    assert(Number.isFinite(decision.top[0].score), 'the common final score must be included for review');

    const fang = byName('彥棋');
    rd1.turnLogs[fang.id] = { fangTargetId: huang.id, fangCamp: 'evil' };
    const fangA = { ...syntheticA, ctx: { ...syntheticA.ctx, bot: fang } };
    Mind.analyze = () => fangA;
    const fangDecision = Strategy.personVote(fang, room);
    assert.strictEqual(fangDecision.targetId, huang.id, 'Fang’s verified evil scan must remain the top final accusation');
    assert.strictEqual(fangDecision.top[0].id, fangDecision.targetId, 'Fang’s displayed ranking must use the same final score as his vote');
  } finally {
    Mind.analyze = oldAnalyze;
    GD.Tactics.scoreProjection = oldProjection;
  }

  console.log('v10.8.3 玩家推理回歸通過：以實際對局姓名與傳牌順序驗證雙人候選、歷史查驗反轉、公開提示延續及終局排名／指認一致。');
  process.exit(0);
} catch (err) {
  console.error('v10.8.3 玩家推理回歸失敗：', err.stack || err.message || err);
  process.exit(1);
}