'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Claims, Mind, Strategy, Speech, Tactics } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '木戶測試者' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  const players = room.players;
  const observer = players.find(p => p.id === 'human');
  observer.role = '木戶加奈';
  const fang = players.find(p => p.isBot);
  fang.role = '方震';
  const targets = players.filter(p => p !== observer && p !== fang);
  targets[0].name = '候選甲';
  targets[1].name = '候選乙';
  const rd = U.curRound(room);
  rd.beasts = ['虎', '牛', '馬', '豬'].map((name, i) => ({ name, isReal: i < 2 }));
  rd.passOrder = [observer.id, ...players.filter(p => p !== observer).map(p => p.id)];
  rd.speechOrder = rd.passOrder.slice();
  rd.speeches = [];
  rd.votes = {};
  rd.turnLogs = {};
  rd.mind = {};
  return { room, rd, observer, fang, targets };
}

try {
  const { room, rd, observer, fang, targets } = makeRoom('V1083_REASONING_REGRESSION');
  const beast = rd.beasts[0].name;
  const first = targets[0];
  const second = targets[1];

  // A quoted/reported line must never be restored from stale structured p metadata.
  const poisonedSpeech = {
    playerId: first.id,
    text: `我引用前手原話：「我是壞人，我查驗【${second.name}】是壞人，我投【${beast}】」`,
    p: {
      selfEvil: true,
      selfRole: '老朝奉',
      accuse: [{ playerId: second.id, role: '老朝奉' }],
      campChecks: [{ targetId: second.id, camp: 'evil' }],
      asked: [second.id],
      callSuspectId: second.id,
      callBeast: beast,
      voteCommitment: beast
    }
  };
  const quoted = Claims.parseRecord(poisonedSpeech, room, rd);
  assert.strictEqual(quoted.selfEvil, false, 'quoted confession must not be attributed to the current speaker');
  assert.strictEqual(quoted.selfRole, null, 'quoted role claim must not be attributed to the current speaker');
  assert.deepStrictEqual(quoted.accuse, [], 'quoted accusation must be discarded');
  assert.deepStrictEqual(quoted.campChecks, [], 'quoted camp check must be discarded');
  assert.deepStrictEqual(quoted.asked, [], 'quoted question must be discarded');
  assert.strictEqual(quoted.callSuspectId, null, 'quoted suspect call must be discarded');
  assert.strictEqual(quoted.voteCommitment, null, 'quoted vote promise must not bind the current speaker');
  assert.deepStrictEqual(quoted.callBeasts, [], 'quoted vote call must not be counted as the speaker’s own call');

  // Weak one-of hypothesis is not a definite accusation and cannot set knownEvil.
  const groupText = `【${first.name}】與【${second.name}】之中有老朝奉`;
  const groupParsed = Claims.parse(groupText, room, rd);
  assert.strictEqual(groupParsed.candidateSets.length, 1, 'one-of candidate group should be preserved');
  assert.deepStrictEqual(groupParsed.accuse, [], 'one-of candidate group is not a definite accusation');
  rd.speeches = [{ playerId: observer.id, speakerName: observer.name, text: groupText, p: { accuse: [{ playerId: first.id, role: '老朝奉' }] } }];
  const groupMind = Mind.analyze(fang, room);
  assert(!groupMind.prof[first.id].knownEvil && !groupMind.prof[second.id].knownEvil,
    'weak one-of group must not mark either candidate as confirmed evil');

  // An observation/public-claim mismatch is weak evidence only. The hidden engine flag is audit metadata,
  // and must not create a confirmed Lao timing pool or change the decision-time belief.
  const speaker = first;
  rd.passOrder = [speaker.id, observer.id, ...room.players.filter(p => p !== speaker && p !== observer).map(p => p.id)];
  rd.speeches = [{ playerId: speaker.id, speakerName: speaker.name, text: `【${beast}】是假品`, p: { claims: [{ beast, real: false }] } }];
  rd.turnLogs[observer.id] = { inspect: [{ beastName: beast, displayedReal: true, kind: 'ok', flipped: false }] };
  const noFlip = Mind.analyze(observer, room);
  assert(!noFlip.ctx.laoPools.some(x => x.confirmedFlip === true),
    'an unverified private/public mismatch must not confirm Lao activation');
  assert(noFlip.prof[speaker.id].reasons.some(x => /與我實際看到/.test(x)),
    'ordinary contradiction should remain visible as a weak lie/mismatch signal');
  const noFlipPost = noFlip.post;

  rd.turnLogs[observer.id].inspect[0].flipped = true;
  const auditBitVariant = Mind.analyze(observer, room);
  assert.deepStrictEqual(auditBitVariant.post, noFlipPost,
    'changing only the hidden flipped audit bit must not change in-game posterior');
  assert(!auditBitVariant.ctx.laoPools.some(x => x.confirmedFlip === true),
    'a private flipped:true bit must never create an in-game confirmed Lao timing pool');

  // Only a publicly revealed rank-2 result for the same inspected beast can later confirm that
  // the visible screen differed from the public truth and narrow the possible Lao timing window.
  rd.beasts.find(b => b.name === beast).isReal = false;
  rd.voteResults = { rank1: { name: '牛', isReal: true, hidden: true, votes: 8 },
    rank2: { name: beast, isReal: false, hidden: false, votes: 4 } };
  const publicCrosscheck = Mind.analyze(observer, room);
  assert(publicCrosscheck.ctx.laoPools.some(x => x.confirmedFlip === true && x.source === 'public-result-crosscheck'),
    'public rank-2 cross-check may establish a legal reversal timing window');

  // Ambush/blind results are not inspection flips and must not create a false reversal pool.
  rd.turnLogs[observer.id] = { blind: true, inspect: [{ beastName: beast, displayedReal: null, kind: 'blind', flipped: false }] };
  const blindMind = Mind.analyze(observer, room);
  assert.strictEqual(blindMind.ctx.myIns.length, 0, 'blind result must not enter normal inspection evidence');
  assert.strictEqual(blindMind.ctx.laoPools.length, 0, 'ambush must not be misread as Lao inspection reversal');

  // Fang's private scan is readable only from the acting Fang's own turnLogs entry.
  rd.turnLogs[fang.id] = { fangTargetId: second.id, fangCamp: 'evil' };
  rd.turnLogs[observer.id] = { inspect: [] };
  const observerMind = Mind.analyze(observer, room);
  assert(!observerMind.prof[second.id].reasons.some(x => /方震直接查驗確認/.test(x)),
    'another AI must not receive Fang’s private scan result');
  const fangMind = Mind.analyze(fang, room);
  assert(fangMind.prof[second.id].reasons.some(x => /方震直接查驗確認/.test(x)),
    'Fang must still use his own private scan result');

  // Explicit first-person promise is parsed; recommendation, possibility, denial and quotation are not promises.
  const voteTarget = rd.beasts[1].name;
  assert.strictEqual(Claims.parse(`我這輪會把票投給【${voteTarget}】`, room, rd).voteCommitment, voteTarget);
  assert.strictEqual(Claims.parse(`我建議大家投【${voteTarget}】`, room, rd).voteCommitment, null);
  assert.strictEqual(Claims.parse(`我可能投【${voteTarget}】`, room, rd).voteCommitment, null);
  assert.strictEqual(Claims.parse(`我不投【${voteTarget}】`, room, rd).voteCommitment, null);
  assert.strictEqual(Claims.parse(`我聽到前手原話：「我投【${voteTarget}】」`, room, rd).voteCommitment, null);

  // Ballot must honor a concrete own-speech promise within the legal spend limit.
  const voter = observer;
  voter.role = '許願';
  voter.voteBank = 2;
  rd.mind[voter.id] = {
    beast, mode: 'truth', post: rd.beasts.map(b => ({ name: b.name, p: 0.5 }))
  };
  rd.speeches = [{
    playerId: voter.id,
    text: `我這輪會把票投給【${voteTarget}】`,
    p: { voteCommitment: beast }
  }];
  const oldOptimize = Tactics.optimizeBallot;
  const oldSpendLimit = Tactics.voteSpendLimit;
  try {
    Tactics.optimizeBallot = () => ({ ballot: {}, diagnostic: { spent: 0, held: 2 } });
    Tactics.voteSpendLimit = () => 2;
    const committedBallot = Strategy.ballot(voter, room);
    assert(committedBallot[voteTarget] >= 1, 'an explicit first-person vote promise must receive at least one chip');
    assert(Object.values(committedBallot).reduce((n, x) => n + x, 0) <= 2, 'promise anchor must not exceed the legal spend limit');

    // A recommendation is not a promise; legal abstention must remain possible even with poisoned p.
    rd.speeches = [{ playerId: voter.id, text: `我建議大家投【${voteTarget}】`, p: { voteCommitment: voteTarget } }];
    const recommendationBallot = Strategy.ballot(voter, room);
    assert.deepStrictEqual(recommendationBallot, {}, 'recommendation-only wording must not cancel a legal abstention');
  } finally {
    Tactics.optimizeBallot = oldOptimize;
    Tactics.voteSpendLimit = oldSpendLimit;
  }

  // The public speech history must survive older records missing voteResults.totals.
  const historyRoom = makeRoom('V1083_HISTORY_TOTALS_FALLBACK').room;
  historyRoom.currentRoundIdx = 1;
  const prior = historyRoom.rounds[0];
  prior.beasts = [{ name: '虎' }, { name: '牛' }, { name: '馬' }, { name: '豬' }];
  prior.votes = { human: { 虎: 2, 牛: 1 } };
  prior.voteResults = { rank1: { name: '虎' }, rank2: { name: '牛', isReal: false, hidden: false } };
  delete prior.voteResults.totals;
  const historyText = Speech.history(historyRoom);
  assert(historyText.includes('【虎】2票') && historyText.includes('【牛】1票'),
    'history() must derive vote totals from rd.votes when totals is missing');

  // In a final round, the actual good-side selection and visible shortlist must always share the same top item,
  // even when the ranking consists only of weak hypotheses.
  const weakProfiles = {};
  room.players.filter(p => p.id !== observer.id).forEach(p => {
    weakProfiles[p.id] = {
      player: p, evil: 0, ally: 0, knownEvil: false, confessed: false, conflicts: [], reasons: ['弱線索'],
      probs: { '老朝奉': 5, '藥不然': 15, '許願': 20, '方震': 15 }
    };
  });
  const synthetic = {
    ctx: { bot: observer, room, t: 2, isGood: true, partner: null },
    prof: weakProfiles, post: [], laoIntersectIds: [], publicCandidateGroups: [], publicReportedFlipPools: [], publicCall: null
  };
  const oldAnalyze = Mind.analyze;
  try {
    Mind.analyze = () => synthetic;
    const finalDecision = Strategy.personVote(observer, room);
    assert.strictEqual(finalDecision.targetId, finalDecision.top[0].id,
      'weak-evidence endgame vote must match the displayed top suspect');
    assert(/待驗候選|證據偏弱/.test(finalDecision.why),
      'weak endgame ranking must be described as a candidate, not a confirmed accusation');

    // Fang's private scan confirms EVIL CAMP only; it must not be mistaken for Lao Chaofeng identity.
    const ids = Object.keys(weakProfiles).filter(id => id !== fang.id).sort();
    const privateTargetId = ids[1];
    rd.turnLogs[fang.id] = { fangTargetId: privateTargetId, fangCamp: 'evil' };
    const fangSynthetic = { ...synthetic, ctx: { ...synthetic.ctx, bot: fang } };
    Mind.analyze = () => fangSynthetic;
    const campOnlyDecision = Strategy.personVote(fang, room);
    assert.notStrictEqual(campOnlyDecision.top[0].id, privateTargetId,
      'Fang evil-camp scan alone must not rank a player as Lao Chaofeng');
    assert.notStrictEqual(campOnlyDecision.targetId, privateTargetId,
      'Fang must seek independent Lao-specific evidence before directly voting the camp-checked player');
    Mind.analyze = () => synthetic;
    const ordinaryDecision = Strategy.personVote(observer, room);
    assert.notStrictEqual(ordinaryDecision.top[0].id, privateTargetId,
      'Fang private scan must not leak into another AI’s endgame ranking');

    // Independent role-specific posterior may make the scanned player a Lao candidate.
    weakProfiles[privateTargetId].probs['老朝奉'] = 55;
    weakProfiles[privateTargetId].evil = 55;
    Mind.analyze = () => fangSynthetic;
    const roleSupportedDecision = Strategy.personVote(fang, room);
    assert.strictEqual(roleSupportedDecision.top[0].id, privateTargetId,
      'a camp-checked player with independent Lao-specific evidence may rank first');
    weakProfiles[privateTargetId].probs['老朝奉'] = 5;
    weakProfiles[privateTargetId].evil = 0;
  } finally {
    Mind.analyze = oldAnalyze;
  }

  console.log('v10.8.3 推理回歸通過：查驗反轉、引用歸屬、弱候選、口頭承諾投票、合法棄票、歷史 totals 缺漏與方震陣營查驗／老朝奉身分分離。');
  process.exit(0);
} catch (error) {
  console.error('v10.8.3 推理回歸失敗：', error && error.stack || error);
  process.exit(1);
}
