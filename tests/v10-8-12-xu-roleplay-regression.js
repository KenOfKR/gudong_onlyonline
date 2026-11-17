'use strict';
const assert = require('assert');
const GD = require('./harness')();

try {
  const bot = { id: 'evil-1', role: '老朝奉' };
  const rd = { beasts: ['鼠','牛','虎','兔'].map(name => ({ name })) };
  const A = { post: [
    { name: '鼠', pReal: 0.9 }, { name: '牛', pReal: 0.8 },
    { name: '虎', pReal: 0.4 }, { name: '兔', pReal: 0.2 }
  ] };
  const plan = { roleBluff: { role: '許願', kind: 'false_claim' },
    claims: [{ beast: '鼠', real: true }], withholdInfo: false, withheldClaims: [] };
  GD.Strategy.ensureFakeXuAbilityProfile(plan, bot, rd, A, 1);
  const profile = plan.roleBluff.abilityProfile;
  assert(profile && profile.minimumDistinctBeasts === 2, 'fake Xu must have a two-beast ability profile');
  assert.strictEqual(new Set(profile.beastNames).size, 2, 'the two ability sources must be distinct beasts');
  assert.strictEqual(plan.claims.length, 1, 'fake Xu can disclose only one of the two results');
  assert.strictEqual(plan.withholdInfo, true, 'the undisclosed second result must remain withheld');
  assert.strictEqual(plan.withheldClaims.length, 1, 'one distinct source should be stored as withheld');
  assert(profile.withheldBeastNames.includes(plan.withheldClaims[0].beast));

  const alreadyBoth = { roleBluff: { role: '許願', kind: 'false_claim' },
    claims: [{ beast: '鼠', real: true }, { beast: '牛', real: true }], withholdInfo: false, withheldClaims: [] };
  GD.Strategy.ensureFakeXuAbilityProfile(alreadyBoth, bot, rd, A, 2);
  assert.strictEqual(alreadyBoth.claims.length, 2, 'two existing distinct public sources should not be hidden automatically');
  assert.strictEqual(alreadyBoth.withholdInfo, false);
  console.log('Fake Xu roleplay regression PASS: every non-Xu fake Xu has two distinct source beasts while one result may remain withheld.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
