/* v10.8.0 對話延續性／角色歷史歸因回歸測試 */
'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Claims } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  return room;
}

try {
  assert.strictEqual(GD.CONFIG.VERSION, '10.8.1');
  const room = makeRoom('CONTINUITY_ROLE_HISTORY');
  const rd = U.curRound(room);
  const target = room.players.find(p => p.id !== 'human');
  assert(target, 'test requires a role-claim target');
  const targetTag = U.tag(target);

  const historicalRoleReport = `${targetTag}跨輪自稱藥不然與方震，身份版本前後改變。`;
  const historicalParsed = Claims.parse(historicalRoleReport, room, rd);
  assert.deepStrictEqual(historicalParsed.accuse, [], 'a report of a cross-round self-claim is not a fresh role accusation');
  assert.strictEqual(historicalParsed.selfRole, null, 'a reported self-claim must not become the current speaker role');

  const quotedSelfRole = `${targetTag}先前自稱我是方震。`;
  const quotedSelfRoleParsed = Claims.parse(quotedSelfRole, room, rd);
  assert.strictEqual(quotedSelfRoleParsed.selfRole, null, 'quoted/historical "我是方震" must not be parsed as the current speaker role');

  const directAccusation = `我懷疑${targetTag}是方震。`;
  const directParsed = Claims.parse(directAccusation, room, rd);
  assert(directParsed.accuse.some(a => a.playerId === target.id && a.role === '方震'), 'an explicit current role accusation must still be parsed');

  const negatedAccusation = `我不認為${targetTag}是方震，也沒有指認他。`;
  const negatedParsed = Claims.parse(negatedAccusation, room, rd);
  assert(!negatedParsed.accuse.some(a => a.playerId === target.id && a.role === '方震'), 'a negated role attribution must not be stored as an accusation');

  const staleRecord = {
    playerId: 'human', speakerName: '真人甲', source: 'human', text: historicalRoleReport,
    p: { claims: [], accuse: [{ playerId: target.id, role: '方震' }], selfRole: '方震' }
  };
  const recovered = Claims.parseRecord(staleRecord, room, rd);
  assert.deepStrictEqual(recovered.accuse, [], 'stale structured accuse metadata must not override original public wording');
  assert.strictEqual(recovered.selfRole, null, 'stale structured selfRole metadata must not override original public wording');

  // This patch changes speech interpretation only; it does not add a forced-vote rule.
  assert.strictEqual(typeof Engine.vote, 'function', 'vote API remains available');
  console.log('v10.8.0 延續性測試通過：歷史角色轉述、明確指控、否定句與過期 metadata');
  process.exit(0);
} catch (err) {
  console.error('v10.8.0 延續性測試失敗：', err.stack || err.message || err);
  process.exit(1);
}
