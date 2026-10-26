/* ============================================================================
 * tests/test_net_failover.js — 模擬主機斷線與長時間心跳停滯的 Host 移交測試
 * ========================================================================== */
const GD = require('./harness')();
const { Engine, Net, U } = GD;

// 攔截並控制時間，讓我們不需在終端機枯等 60 秒
const originalNow = Date.now;
let timeOffset = 0;
Date.now = () => originalNow() + timeOffset;

async function testHostFailover() {
  console.log('=== 模擬主機異常斷線與長時間背景接管測試 ===');
  
  // 1. 開局狀態
  const room = Engine.newRoom('FAILOVER_888', 'human_1');
  for (let i = 1; i <= 8; i++) {
    Engine.addPlayer(room, { id: `human_${i}`, name: `真人${i}號`, isBot: false });
  }
  Engine.start(room);
  console.log(`[0 秒] 開局完成。主機: ${room.hostId} ｜ 真人數: ${room.players.filter(p => !p.isBot).length}`);

  // 將房間寫入本機快取，這代表 Firebase 上的最後已知狀態
  GD.store.set(GD.CONFIG.STORAGE.room + room.roomId, Net.packRoom ? Net.packRoom(room) : room);

  // 2. 模擬主機 (human_1) 突然拔線，時間經過 30 秒
  console.log('\n[30 秒] 主機異常斷線，完全沒有發送 hostBeat...');
  timeOffset += 30000; 

  // 3. 其他玩家 (假設為亂數產生的 Net.myId) 打開大廳，觸發背景接管
  console.log('[30 秒] 其他玩家刷新大廳，觸發 Net.lobby()...');
  await Net.lobby();

  let bg = Net.bgRoom();
  if (!bg) {
    console.error('✗ 失敗：主機已超時 25 秒，但 Net.lobby() 未能觸發背景接管。');
    process.exit(1);
  }
  
  console.log(`[接管成功] 新主機: ${bg.hostId} ｜ 玩家總數: ${bg.players.length} ｜ 真人數: ${bg.players.filter(p => !p.isBot).length} ｜ 旁觀者: ${(bg.spectators || []).length}`);
  if (bg.players.filter(p => !p.isBot).length !== 8) {
    console.error('✗ 失敗：主機移交過程中，有真人被錯誤踢除為電腦！');
    process.exit(1);
  }

  // 4. 模擬新主機接管後，再過 30 秒的多次心跳與大廳刷新 (總計 60 秒)
  console.log('\n[60 秒] 新主機接管後繼續運行 30 秒，期間多次觸發大廳刷新...');
  timeOffset += 30000;
  
  // 模擬新主機有正常發送心跳
  bg.hostBeat = Date.now();
  GD.store.set(GD.CONFIG.STORAGE.room + bg.roomId, Net.packRoom ? Net.packRoom(bg) : bg);

  await Net.lobby();
  bg = Net.bgRoom();

  console.log(`[60 秒狀態] 當前主機: ${bg.hostId} ｜ 真人數: ${bg.players.filter(p => !p.isBot).length} ｜ 旁觀者: ${(bg.spectators || []).length}`);
  if (bg.players.filter(p => !p.isBot).length !== 8) {
    console.error('✗ 失敗：後續的心跳判定與大廳刷新引發了連鎖踢人！');
    process.exit(1);
  }

  console.log('\n✓ 測試通過：主機斷線移交與長時間心跳判定皆穩定，無真人被誤踢！');
  
  // 復原時間
  Date.now = originalNow;
}

testHostFailover();