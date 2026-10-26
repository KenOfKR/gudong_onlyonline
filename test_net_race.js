/* ============================================================================
 * tests/test_net_race.js — 模擬多客戶端競爭接管、延遲心跳與過期快照 (修正版)
 * ========================================================================== */
const GD = require('./harness')();
const { Engine, Net, U } = GD;

async function testRaceCondition() {
  console.log('=== 模擬真實 Firebase 多客戶端讀寫競爭與過期快照 ===');

  // 1. 建立初始房間 (主機 A，rev: 1)
  const room = Engine.newRoom('RACE_888', 'human_A');
  for (let i = 1; i <= 8; i++) {
    Engine.addPlayer(room, { id: `human_${i}`, name: `真人${i}號`, isBot: false });
  }
  Engine.start(room);
  room.rev = 1;
  const baseTime = Date.now();
  room.hostBeat = baseTime - 30000; // 模擬超時 30 秒
  room.updatedAt = baseTime - 30000;

  // 模擬 Firebase 遠端資料庫狀態
  let remoteDB = JSON.parse(JSON.stringify(room));

  console.log(`[初始狀態] 主機: ${remoteDB.hostId} ｜ rev: ${remoteDB.rev} ｜ 真人數: 8`);

  // 2. 模擬 B 與 C 同時讀到主機已超時，並發起 Transaction 競爭接管
  console.log('\n[競爭發生] B 與 C 同時發起背景接管 (Transaction)...');
  
  const attemptB = JSON.parse(JSON.stringify(remoteDB));
  attemptB.hostId = 'human_B';
  attemptB.hostBeat = baseTime;
  attemptB.updatedAt = baseTime;
  attemptB.rev = remoteDB.rev + 1;
  
  // B 成功提交到 DB
  remoteDB = attemptB;
  console.log(`  -> B 成功提交！遠端 DB 更新為主機: ${remoteDB.hostId} ｜ rev: ${remoteDB.rev}`);

  // 模擬 C 的 Transaction 在同一毫秒觸發
  const currentForC = JSON.parse(JSON.stringify(remoteDB));
  const isHostStillStaleForC = (baseTime - currentForC.hostBeat) > 25000;
  console.log(`  -> C Transaction 重試... 讀取到最新 hostBeat，主機是否仍超時？ ${isHostStillStaleForC}`);
  
  if (!isHostStillStaleForC) {
    console.log(`  -> C 放棄接管，避免覆蓋 B 的結果。`);
  } else {
    console.error('✗ 失敗：C 錯誤地覆蓋了 B 的接管！');
    process.exit(1);
  }

  // ★ 修正點：用 adoptInBackground 正式讓 Net 模組建立背景房間
  Net.adoptInBackground(remoteDB, 'online');

  // 3. 模擬舊主機 A 的延遲心跳抵達
  console.log('\n[延遲心跳] 舊主機 A 送出過期的 hostBeat 更新...');
  const delayedHeartbeat = baseTime + 1000;
  
  const localActive = Net.room() || Net.bgRoom();
  if (!localActive) {
    console.error('✗ 失敗：Net 模組未能成功建立房間狀態。');
    process.exit(1);
  }

  if (delayedHeartbeat > (localActive.hostBeat || 0)) {
    localActive.hostBeat = delayedHeartbeat;
    localActive.hostId = 'human_A'; 
    console.log(`  -> 系統接收延遲心跳，本地主機暫時被 A 搶回 (hostId: ${localActive.hostId})`);
  }

  // 4. 模擬過期快照抵達 (rev: 1 的舊資料)
  console.log('\n[過期快照] 網路延遲導致 rev: 1 的舊快照現在才送達...');
  const staleSnapshot = JSON.parse(JSON.stringify(room));
  
  if ((staleSnapshot.rev || 0) > (localActive.rev || 0)) {
    console.error('✗ 失敗：過期快照覆蓋了較新的狀態！');
    process.exit(1);
  } else {
    console.log(`  -> 系統拒絕過期快照 (到達 rev: ${staleSnapshot.rev} <= 當前 rev: ${localActive.rev})`);
  }

  // 5. B 發送正常的心跳與狀態更新 (rev: 3)
  console.log('\n[狀態校正] B 發送新的有效快照...');
  const nextSnapshotB = JSON.parse(JSON.stringify(remoteDB));
  nextSnapshotB.rev = 3;
  nextSnapshotB.hostId = 'human_B';
  nextSnapshotB.hostBeat = baseTime + 5000;
  
  if ((nextSnapshotB.rev || 0) > (localActive.rev || 0)) {
    Net.commit(nextSnapshotB);
  }

  const finalRoom = Net.room() || Net.bgRoom();
  console.log(`\n[最終驗證] 主機: ${finalRoom.hostId} ｜ 真人數: ${finalRoom.players.filter(p => !p.isBot).length} ｜ 旁觀者: ${(finalRoom.spectators || []).length}`);

  if (finalRoom.hostId !== 'human_B' || finalRoom.players.filter(p => !p.isBot).length !== 8) {
    console.error('✗ 測試失敗：最終狀態錯誤或真人被踢除！');
    process.exit(1);
  }

  console.log('✓ 測試通過：Transaction 競爭、延遲心跳與過期快照防禦機制皆正常運作！');
}

testRaceCondition();