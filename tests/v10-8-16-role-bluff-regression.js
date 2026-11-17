'use strict';
const assert = require('assert');
const GD = require('./harness')();

function makeRoom() {
  const room = GD.Engine.newRoom('V10816_ROLE_BLUFF', 'host');
  room.players = [
    { id: 'actor', name: '測試玩家', role: '姬雲浮', isBot: true, botId: 'bot_actor' },
    { id: 'target', name: '目標玩家', role: '許願', isBot: true, botId: 'bot_target' },
    { id: 'partner', name: '同伴', role: '藥不然', isBot: true, botId: 'bot_partner' }
  ];
  room.rounds = [{ roundNum: 1, beasts: ['鼠', '羊', '狗', '豬'].map(name => ({ name })), speeches: [], turnLogs: {} }];
  room.currentRoundIdx = 0;
  return room;
}

const room = makeRoom();
const actor = room.players[0];
const ctx = { room, t: 0, myIns: [], log: {}, partner: room.players[2], isGood: true };

const goodPool = GD.Strategy.buildRoleBluffPool(actor, ctx, false);
assert(!goodPool.includes('老朝奉') && !goodPool.includes('鄭國渠') && !goodPool.includes('藥不然'),
  '好人未受身分施壓時，不應隨機跳壞人角色');
const counterPool = GD.Strategy.buildRoleBluffPool(actor, ctx, true);
assert(counterPool.includes('老朝奉') && counterPool.includes('鄭國渠') && counterPool.includes('藥不然'),
  '好人被公開指認時，仍可低機率使用反反心理');

const fangUnbackedEarly = GD.Strategy.roleBluffFeasibility('方震', actor, ctx, {});
assert(fangUnbackedEarly < 0.50, '沒有自己的方震陣營查驗時，只能低調鋪陳，不應高機率假跳');
ctx.t = 1;
room.rounds.push({ roundNum: 2, beasts: room.rounds[0].beasts, speeches: [], turnLogs: {} });
const fangUnbackedLater = GD.Strategy.roleBluffFeasibility('方震', actor, ctx, {});
assert(fangUnbackedLater < 0.20, '進入後續回合仍無陣營查驗，方震偽裝應被視為不相容');
room.rounds[1].turnLogs.actor = { fangTargetId: 'target', fangCamp: 'good' };
const fangBacked = GD.Strategy.roleBluffFeasibility('方震', actor, ctx, {});
assert(fangBacked >= 0.80, '有本人可核對陣營查驗時，方震能力表現才相容');

const quotedRoleRoom = makeRoom();
quotedRoleRoom.rounds[0].speeches.push({ playerId: 'target', speakerName: '目標玩家', text: '我是老朝奉。' });
quotedRoleRoom.rounds[0].speeches.push({ playerId: 'actor', speakerName: '測試玩家', text: '目標玩家剛才說「我是老朝奉」，但我不認為這就能定案。' });
const latest = GD.Strategy.latestPublicRoleClaims(quotedRoleRoom, 0, null);
assert.strictEqual(latest.get('target').role, '老朝奉', '真正的本人角色主張應保留');
assert.strictEqual(latest.get('actor'), undefined, '引用別人的角色主張不得記成自己的身分承諾');

console.log('PASS v10.8.16 role bluff regression: good-side counter-bluff gate, progressive role cover, ability-compatible Fang signal, and quoted role attribution.');
process.exit(0);
