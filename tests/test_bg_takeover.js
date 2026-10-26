/* ============================================================================
 * tests/test_bg_takeover.js — 模擬大廳刷新觸發背景接管，驗證真人不會被誤踢
 * 用法：node tests/test_bg_takeover.js
 * ========================================================================== */
const GD = require('./harness')();
const { Engine, Net, U } = GD;

async function testTakeover() {
  console.log('=== 模擬 8 真人連線與 Net 大廳背景接管測試 ===');
  
  const room = Engine.newRoom('H888', 'human_1');
  for (let i = 1; i <= 8; i++) {
    Engine.addPlayer(room, { id: `human_${i}`, name: `真人${i}號`, isBot: false });
  }

  Engine.start(room);
  console.log(`[開局] 玩家總數：${room.players.length} ｜ 真人：${room.players.filter(p => !p.isBot).length}`);

  // 將房間快取寫入本地，並把時間調為過期 (模擬 30 秒前)
  room.updatedAt = Date.now() - 30000;
  room.hostBeat = Date.now() - 30000;
  GD.store.set(GD.CONFIG.STORAGE.room + 'H888', Net.packRoom ? Net.packRoom(room) : room);

  console.log('[動作] 模擬其他無關玩家開啟大廳，觸發 Net.lobby() 背景清理與接管...');
  // Net.myId 預設會是某個亂數，讓他嘗試接管 H888
  await Net.lobby();

  const bg = Net.bgRoom();
  if (!bg) {
    console.error('✗ 測試失敗：背景接管未能觸發。');
    process.exit(1);
  }

  console.log(`[接管後] 新主機：${bg.hostId} ｜ 玩家總數：${bg.players.length} ｜ 真人：${bg.players.filter(p => !p.isBot).length} ｜ 旁觀者：${(bg.spectators || []).length}`);

  if (bg.players.filter(p => !p.isBot).length !== 8) {
    console.error('✗ 測試失敗：背景接管過程中，真人被錯誤替換為電腦！');
    process.exit(1);
  }

  console.log('✓ 測試通過：背景接管僅轉移主機權，並未將真人踢為電腦！');
}

testTakeover();