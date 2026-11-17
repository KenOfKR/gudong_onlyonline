'use strict';
const assert = require('assert');
const GD = require('./harness')();

function fixture() {
  const room = GD.Engine.newRoom('V10817_INSPECTION', 'p0');
  const roles = ['方震', '許願', '姬雲浮', '黃煙煙', '木戶加奈', '老朝奉', '藥不然', '鄭國渠'];
  room.players = roles.map((role, i) => ({
    id: `p${i}`, name: `玩家${i}`, isBot: true, botId: `bot_${i}`, role,
    colorId: GD.SEAL_COLORS[i].id, seatIndex: i, voteBank: 2,
    isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false,
    pendingImmediateAmbush: false, pendingPermanentAmbush: false, confusedRound: -1
  }));
  const passOrder = room.players.map(player => player.id);
  const makeRound = roundNum => ({
    roundNum,
    beasts: ['牛', '羊', '鼠', '狗'].map(name => ({ name, isReal: true })),
    passOrder, speechOrder: passOrder.slice(),
    turnLogs: Object.fromEntries(passOrder.map(id => [id, { inspect: [] }])),
    speeches: [], votes: {}, voteResults: null, mind: {}
  });
  room.status = 'discussion'; room.currentRoundIdx = 1; room.rounds = [makeRound(1), makeRound(2)];
  room.rounds[1].speeches = [
    { playerId: 'p1', speakerName: '玩家1', text: '我第二輪查驗【牛】是贗品。整體來看，我仍判斷【牛】是真品。' },
    { playerId: 'p2', speakerName: '玩家2', text: '我第一輪查驗【羊】是真品。' }
  ];
  return { room, bot: room.players[0] };
}

try {
  const { room, bot } = fixture();
  const parsed = GD.Claims.parseRecord(room.rounds[1].speeches[0], room, room.rounds[1]);
  assert.deepStrictEqual(parsed.inspectionReports.map(item => [item.round, item.beast, item.claimedReal]), [[2, '牛', false]],
    'the stated inspection result must be parsed independently from the overall verdict');
  assert(parsed.claims.some(item => item.beast === '牛' && item.real === true),
    'the speaker’s separate overall truth judgment must remain present');

  const A = GD.Mind.analyze(bot, room);
  const inspection = A.claimEvidence.current.find(item => item.kind === 'inspection-report' && item.playerId === 'p1');
  const overall = A.claimEvidence.current.find(item => item.kind === 'claim' && item.playerId === 'p1' && item.beast === '牛');
  assert(inspection, 'collectPublicClaimEvidence must include the public inspection report');
  assert.strictEqual(inspection.round, 2, 'report.round must preserve the original inspection round');
  assert.strictEqual(inspection.speechRound, 2, 'the round in which the report was spoken must also be retained');
  assert.strictEqual(inspection.verified, false, 'speaker-reported inspection is not objective truth');
  assert.strictEqual(inspection.provenance, 'speaker-self-report');
  assert(overall && overall.real === true, 'inspection result and overall truth judgment must remain separate evidence entries');

  const historical = A.claimEvidence.all.find(item => item.kind === 'inspection-report' && item.playerId === 'p2');
  assert(historical, 'historical inspection reports must be retained in evidence history');
  assert.strictEqual(historical.round, 1, 'historical report keeps its original inspection round');
  assert.strictEqual(historical.speechRound, 2, 'historical report also records the speech round');

  const withReport = GD.Mind.posterior(A.ctx, A.prof).post.find(item => item.name === '牛').pReal;
  const withoutCurrentReports = {
    ...A.ctx,
    claimEvidence: { ...A.ctx.claimEvidence, current: A.ctx.claimEvidence.current.filter(item => item.kind !== 'inspection-report') }
  };
  const withoutReport = GD.Mind.posterior(withoutCurrentReports, A.prof).post.find(item => item.name === '牛').pReal;
  assert(withReport < withoutReport, 'current-round public inspection report must influence posterior in the reported direction');
  assert(withReport > 0 && withReport < 1, 'a self-reported inspection must not force objective truth');

  const duplicateSpeech = { ...A.ctx.rd.speeches[0] };
  const duplicatedContext = { ...A.ctx, rd: { ...A.ctx.rd, speeches: [...A.ctx.rd.speeches, duplicateSpeech] } };
  const withDuplicateSource = GD.Mind.posterior(duplicatedContext, A.prof).post.find(item => item.name === '牛').pReal;
  assert(Math.abs(withDuplicateSource - withReport) < 1e-12, 'repeating one speaker’s same source report must not count the evidence twice');

  const overlapFixture = fixture();
  overlapFixture.room.rounds[1].speeches.push({
    playerId: 'p3', speakerName: '玩家3', text: '這輪我查驗【牛】是真品。'
  });
  const overlapAnalysis = GD.Mind.analyze(overlapFixture.bot, overlapFixture.room);
  const overlapReport = overlapAnalysis.claimEvidence.current.find(item => item.kind === 'inspection-report' && item.playerId === 'p3');
  const overlapClaim = overlapAnalysis.claimEvidence.current.find(item => item.kind === 'claim' && item.playerId === 'p3' && item.beast === '牛');
  assert(overlapReport && overlapClaim, 'a direct report may retain both speech facets as separately typed evidence');
  const overlapPost = GD.Mind.posterior(overlapAnalysis.ctx, overlapAnalysis.prof).post.find(item => item.name === '牛').pReal;
  const reportRemovedContext = { ...overlapAnalysis.ctx, claimEvidence: {
    ...overlapAnalysis.ctx.claimEvidence,
    current: overlapAnalysis.ctx.claimEvidence.current.filter(item => !(item.kind === 'inspection-report' && item.playerId === 'p3'))
  } };
  const overlapPostWithoutReport = GD.Mind.posterior(reportRemovedContext, overlapAnalysis.prof).post.find(item => item.name === '牛').pReal;
  assert(overlapPost > overlapPostWithoutReport, 'a same-verdict claim facet must not replace or double the inspection report contribution');

  console.log('PASS v10.8.17 inspection report regression: separate report and verdict, preserve both rounds, use current reports probabilistically, and deduplicate repeated sources.');
  process.exit(0);
} catch (error) {
  console.error('FAIL v10.8.17 inspection report regression:', error.stack || error);
  process.exit(1);
}
