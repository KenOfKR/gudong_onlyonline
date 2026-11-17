'use strict';
const assert = require('assert');
const GD = require('./harness')();

const players = Array.from({ length: 8 }, (_, i) => ({
  id: `p${i}`, name: ['自己','同伴','姬候選','佩萱','雙查候選','壞陣營','普通甲','普通乙'][i],
  role: ['老朝奉','藥不然','姬雲浮','木戶加奈','許願','方震','黃煙煙','鄭國渠'][i],
  isBot: true, botId: `b${i}`, colorId: GD.SEAL_COLORS[i].id, seatIndex: i
}));
const bot = players[0];
const rd = {
  roundNum: 1, passOrder: ['p0','p3','p4'], speechOrder: ['p0','p3','p4'],
  turnLogs: {
    p0: { inspect: [{ beastName: '牛', displayedReal: true, kind: 'normal', resultText: '【牛】真品' }], ability: '方震陣營查驗' },
    p3: { inspect: [{ beastName: '狗', displayedReal: null, kind: 'confused', resultText: '【狗】無法查驗' }], skillTag: '', ability: '角色技能：本輪無法查驗' }
  },
  speeches: [
    { playerId: 'p3', text: '', p: { unsure: true, uncertaintyReasons: [{ reason: 'unspecified', provenance: 'self_report' }] } },
    { playerId: 'p4', text: '', p: { inspectionReports: [
      { round: 1, beast: '牛', claimedReal: true }, { round: 1, beast: '羊', claimedReal: false }
    ] } }
  ], votes: { p0: { 牛: 1 }, p3: { 狗: 2 } }, voteResults: null
};
const prof = {};
players.slice(1).forEach((player, i) => {
  const probs = { '老朝奉': 0, '藥不然': 0, '許願': 0, '方震': 0, '姬雲浮': 0 };
  prof[player.id] = { player, probs, evil: 20, ally: 0, reasons: [], conflicts: [], knownCamp: null,
    knownGood: false, knownEvil: false, confessed: false, isPartner: false, laoTimingSupport: 0,
    flipWindowSupport: 0, rec: null };
});
prof.p2.probs['姬雲浮'] = 90; prof.p2.probs['許願'] = 65;
prof.p3.probs['許願'] = 70;
prof.p4.probs['許願'] = 48;
prof.p5.knownCamp = 'evil'; prof.p5.knownEvil = true;
const room = { roomId: 'FINAL_DEDUCTION_TEST', players, rounds: [rd], personVotes: { p0: 'p3', b: 'p3' } };
const A = { ctx: { bot, room, partner: players[1], isGood: false }, prof,
  laoIntersectIds: [], publicReportedFlipPools: [], publicCandidateGroups: [] };
const assess = GD.Strategy.assessFinalRoleCandidates(bot, room, A, '許願');

assert(assess.hardExcluded.some(item => item.id === 'p1'), 'the actual known teammate is a hard exclusion');
assert(assess.hardExcluded.some(item => item.id === 'p5'), 'verified evil camp cannot remain a good-role candidate');
assert(!assess.hardExcluded.some(item => item.id === 'p2'), '90% Ji posterior must not hard-delete a candidate');
assert(assess.ranked.some(item => item.id === 'p2'), 'a high competing-role probability remains in the ranked candidates');
const limited = assess.ranked.find(item => item.id === 'p3');
const double = assess.ranked.find(item => item.id === 'p4');
assert(limited && limited.metrics.limitedInspectionRounds === 1 && limited.roleAdjust < 0,
  'one round of reported inspection uncertainty is a soft negative clue for Xu');
assert(limited.evidence.some(item => item.source === 'public-limited-inspection'),
  'the reason for lowering a one-round unable-to-inspect report is explicit');
assert(double && double.metrics.dualInspectionRounds === 1 && double.roleAdjust > 0,
  'two distinct reported inspections in a round provide positive, fallible ability evidence');
assert.strictEqual(assess.selectedId, assess.ranked[0].id, 'decision selects the first entry of the shared ranking');
assert.deepStrictEqual(assess.top.map(item => item.id), assess.ranked.slice(0, 3).map(item => item.id),
  'the top three are exactly the first three entries of the same sorted score table');

const reviewBot = { ...bot, final: { why: '依當時證據排序', deduction: {
  targetRole: '許願', selectedId: 'p3', hardExcluded: assess.hardExcluded,
  ranked: assess.ranked.map(item => ({ id: item.id, tag: item.tag, score: item.score,
    roleProbability: item.roleProbability, evidence: item.evidence }))
} } };
const review = GD.Review.reviewFinal(room, reviewBot);
assert(review.text.includes('事後核對') && review.text.includes('抓錯了'), 'post-game review explicitly identifies a wrong final role call');
assert(review.deductionRows.some(row => row.k.includes('硬證據先排除')), 'review shows hard exclusions separately');
assert(review.deductionRows.some(row => row.k.includes('佩萱') && row.v.includes('驗不到')),
  'review explains the Peixuan-like single-round inability report as a soft clue, not an invented proof');
assert(review.deductionRows.some(row => row.k.includes('賽後全員查驗')), 'full private logs are explicitly labelled post-game audit only');
assert(review.deductionRows.some(row => row.k.includes('事後校正') && row.v.includes('木戶加奈的一次無法查驗技能') && row.v.includes('不是藥不然偷襲')),
  'a real confused-round log explains the candidate’s one-round inability as Wood/Yellow skill, not Drug ambush');
assert(review.deductionRows.some(row => row.k.includes('佩萱') && row.v.includes('傳遞順位第2位') && row.v.includes('實際投票')),
  'the post-game audit retains each player’s position and exact chip allocation');
assert(review.deductionRows.some(row => row.k.includes('自己') && row.v.includes('【牛】看見真品') && row.v.includes('實際投票 【牛】1票')),
  'the reviewing AI itself is included in the all-player inspection and ballot audit');
const narrative = GD.Strategy.finalDeductionNarrative(assess, 'p3');
assert(narrative.includes('我先把') || narrative.includes('我沒有足以一刀刪人的硬證據'), 'the final decision is narrated as elimination before selection');
assert(narrative.includes('佩萱') || narrative.includes('木戶'), 'the final decision narrative names its selected candidate and evidence');

console.log('PASS v10.8.20 final role elimination: hard/soft separation, no Ji threshold deletion, Xu ability evidence, shared rank/top3, and post-game audit narrative');
process.exit(0);
