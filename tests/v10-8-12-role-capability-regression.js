'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Rules, Strategy } = GD;

try {
  const expected = {
    '許願': [2, 2, 0, false, false],
    '方震': [0, 0, 1, false, false],
    '姬雲浮': [1, 1, 0, false, true],
    '黃煙煙': [1, 1, 0, true, false],
    '木戶加奈': [1, 1, 0, true, false],
    '老朝奉': [1, 1, 0, false, false],
    '藥不然': [1, 1, 0, false, false],
    '鄭國渠': [1, 1, 0, false, false]
  };
  Object.entries(expected).forEach(([role, values]) => {
    const cap = Rules.roleCapability(role);
    assert(cap, `${role} must have a role capability profile`);
    assert.deepStrictEqual([
      cap.beastChecksPerRound, cap.distinctBeastsRequired, cap.campChecksPerRound,
      cap.unreadableRoundRequired, cap.disruptionImmune
    ], values, `${role} capability profile mismatch`);
  });
  assert.strictEqual(Rules.inspectQuota({ role: '許願', isAmbushed: false }), 2);
  assert.strictEqual(Rules.inspectQuota({ role: '許願', isAmbushed: true }), 1);
  assert.strictEqual(Rules.inspectQuota({ role: '方震' }), 0);
  assert.strictEqual(Rules.inspectQuota({ role: '黃煙煙' }), 1);

  const fangPool = Strategy.buildRoleBluffPool({ role: '方震' }, { isGood: true });
  assert(!fangPool.includes('許願'), 'real Fang must not claim the two-inspection role');
  const otherPool = Strategy.buildRoleBluffPool({ role: '姬雲浮' }, { isGood: true });
  assert(otherPool.includes('許願'), 'other good roles keep their role-disguise choice; no blanket ban');

  console.log('Role capability regression PASS: all eight role profiles, inspect quotas, Fang/Xu incompatibility, and remaining disguise pool.');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
