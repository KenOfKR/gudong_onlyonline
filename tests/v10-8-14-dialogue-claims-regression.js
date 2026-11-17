'use strict';
const assert = require('assert');
const GD = require('./harness')();

const room = {
  players: [
    { id: 'a', name: '甲', isBot: true, colorId: 'orange' },
    { id: 'b', name: '乙', isBot: true, colorId: 'blue' }
  ],
  rounds: [], currentRoundIdx: 0
};
const round = { beasts: [{ name: '虎' }, { name: '羊' }], passOrder: ['a', 'b'], speechOrder: ['a', 'b'] };

try {
  const repeated = GD.Claims.parse('【虎】是真品！【虎】是真品！【虎】是真品！【虎】是真品！', room, round, 'a');
  assert.strictEqual(repeated.voteIntents.length, 1);
  assert.strictEqual(repeated.voteIntents[0].beast, '虎');
  assert.strictEqual(repeated.voteIntents[0].binding, false, 'repeated strong verdict is only a soft vote direction');
  assert.strictEqual(repeated.voteCommitmentBinding, false, 'soft intent must never become a hard ballot promise');

  const tentative = GD.Claims.parse('我應該會投【羊】。', room, round, 'a');
  assert.strictEqual(tentative.voteCommitments.length, 0, 'tentative language should not be parsed as a hard promise');
  assert.strictEqual(tentative.voteCommitmentBinding, false);

  const explicit = GD.Claims.parse('我會投【羊】。', room, round, 'a');
  assert(explicit.voteCommitments.some(item => item.beast === '羊' && item.binding === true), 'explicit vote promise remains binding');
  assert.strictEqual(explicit.voteCommitmentBinding, true);

  const compact = GD.Speech.simplifyDialogue('包漿與工藝都穩。我會納入本輪判斷。我覺得【虎】是真品。我覺得【虎】是真品。');
  assert(!/包漿與工藝都穩|納入本輪判斷/.test(compact), 'boilerplate should be removed');
  assert.strictEqual((compact.match(/我覺得【虎】是真品/g) || []).length, 1, 'duplicate sentence should be removed');

  const independent = GD.Mind.classifyPublicClaim(
    { text: '我的畫面顯示【虎】是真品。' }, { claims: [{ beast: '虎', real: true }] }, true);
  assert.strictEqual(independent.type, 'independent-inference', 'independent source reference must not be downweighted as blind echo');
  assert.strictEqual(independent.selfReportedDirect, false, 'inference source is not a claim of direct inspection');

  console.log('PASS v10.8.14 dialogue/claims regression: repeated soft vote intent, tentative vs explicit promise, dialogue simplification, and independent source classification.');
} catch (error) {
  console.error('FAIL v10.8.14 dialogue/claims regression:', error.stack || error);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
