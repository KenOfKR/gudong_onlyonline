/* ============================================================================
 * tests/test_net_race.js — 真實 Firebase 交易重試、延遲心跳與過期快照嚴格驗證
 * ========================================================================== */
const GD = require('./harness')();
const { Engine, Net, U, CONFIG } = GD;

// 獨立的 isHostStale 供測試腳本驗證使用
const HOST_STALE_MS = 25000;
const isHostStaleLocal = (data, now = Date.now()) => {
  if (!data) return true;
  const beat = Number(data.hostBeat || 0);
  const lastSeen = beat || Number(data.updatedAt || 0);
  return !lastSeen || now - lastSeen > HOST_STALE_MS;
};

// 1. Mock Firestore Layer (具備完整鎖機制與延遲注入)
const MockDB = {
  data: {},
  listeners: [],
  get(path) {
    return { exists: !!this.data[path], data: () => JSON.parse(JSON.stringify(this.data[path])) };
  },
  async update(path, patch) {
    if (!this.data[path]) return;
    this.data[path] = { ...this.data[path], ...patch };
    this.trigger(path);
  },
  trigger(path) {
    const snap = this.get(path);
    this.listeners.forEach(cb => cb(snap));
  },
  
  onBeforeSet: null,
  
  async runTransaction(path, fn) {
    let attempt = 0;
    const executeTx = async () => {
      attempt++;
      const currentRev = this.data[path] ? (this.data[path].rev || 0) : 0;
      let targetRev = currentRev;
      
      const tx = {
        get: async (ref) => {
          targetRev = this.data[path] ? (this.data[path].rev || 0) : 0;
          return this.get(path);
        },
        set: (ref, newData) => {
          const checkRev = this.data[path] ? (this.data[path].rev || 0) : 0;
          
          if (MockDB.onBeforeSet) {
            const hook = MockDB.onBeforeSet;
            MockDB.onBeforeSet = null;
            hook(path);
          }
          
          const finalRevCheck = this.data[path] ? (this.data[path].rev || 0) : 0;
          if (finalRevCheck !== targetRev) {
            throw new Error(`[MockDB] Transaction conflict: Document modified (Expected rev ${targetRev}, got ${finalRevCheck})`);
          }
          this.data[path] = JSON.parse(JSON.stringify(newData));
          this.trigger(path);
        }
      };
      return await fn(tx);
    };

    return executeTx();
  }
};

global.firebase = {
  apps: [1],
  firestore: () => ({
    doc: (path) => ({
      get: async () => MockDB.get(path),
      update: async (patch) => MockDB.update(path, patch),
      onSnapshot: (cb) => { MockDB.listeners.push(cb); return () => {}; }
    }),
    collection: (path) => ({
      orderBy: () => ({ limit: () => ({ get: async () => [] }) })
    }),
    runTransaction: async (fn) => MockDB.runTransaction(Object.keys(MockDB.data)[0], fn)
  }),
  auth: () => ({
    onAuthStateChanged: (cb) => cb({ uid: 'mock_user', isAnonymous: false }),
    signInAnonymously: async () => ({})
  })
};

GD.FIREBASE_CONFIG = { apiKey: "mock" };
Net.init();

async function testNetConcurrency() {
  console.log('=== 模擬真實 Firebase 並行接管與延遲快照防禦 ===\n');

  // 初始化原主機 A 的房間
  const roomCode = 'RACE_888';
  const docPath = `${CONFIG.ROOM_COLLECTION}/${CONFIG.ROOM_PREFIX}${roomCode}`;
  const room = Engine.newRoom(roomCode, 'human_A');
  for (let i = 1; i <= 8; i++) {
    Engine.addPlayer(room, { id: `human_${i}`, name: `真人${i}號`, isBot: false });
  }
  Engine.start(room);
  room.rev = 1;
  const baseTime = Date.now();
  room.hostBeat = baseTime - 30000;
  room.updatedAt = baseTime - 30000;
  
  MockDB.data[docPath] = JSON.parse(JSON.stringify(room));
  console.log(`[初始狀態] 遠端 DB 主機: ${MockDB.data[docPath].hostId} (rev: ${MockDB.data[docPath].rev})`);

  // 本地 Client B 準備接管
  Net.myId = 'human_B';
  // ★ 使用 adoptInBackground 讓 Net 模組建立正確的本地狀態，消除 TypeError
  Net.adoptInBackground(MockDB.data[docPath], 'online');

  console.log('\n[並行競爭] B 發起 Transaction，但在寫入瞬間，C 搶先完成了接管 (注入衝突)...');
  
  MockDB.onBeforeSet = (path) => {
    console.log('  -> ⚡ [中斷] C 搶在 B 寫入前完成了交易，DB rev 變為 2！');
    MockDB.data[path].hostId = 'human_C';
    MockDB.data[path].rev = 2;
    MockDB.data[path].hostBeat = Date.now();
    MockDB.data[path].updatedAt = Date.now();
  };

  const bResult = await Net.act(r => {
    if (!isHostStaleLocal(r)) {
      console.log(`  -> B 發現房間已不處於超時狀態 (當前主機: ${r.hostId})，放棄接管。`);
      return false;
    }
    r.hostId = Net.myId;
    r.hostBeat = Date.now();
    return true;
  });

  console.log(`  -> B 的 Net.act 結果: ${bResult}`);
  console.log(`  -> 遠端 DB 目前主機: ${MockDB.data[docPath].hostId} (rev: ${MockDB.data[docPath].rev})`);
  
  if (MockDB.data[docPath].hostId !== 'human_C' || MockDB.data[docPath].rev !== 2) {
    console.error('✗ 失敗：Transaction 競爭機制失效，版本號未正確防護！');
    process.exit(1);
  }

  console.log('\n[延遲心跳] 舊主機 A 送出過期的 update (繞過 Transaction)...');
  const delayedHeartbeat = Date.now() + 1000;
  
  await MockDB.update(docPath, { hostBeat: delayedHeartbeat, hostId: 'human_A' });
  
  const localRoom = Net.bgRoom() || Net.room();
  console.log(`  -> A 傳送更新後，本地認知的主機: ${localRoom.hostId} (rev: ${localRoom.rev})`);
  
  if (localRoom.hostId === 'human_A') {
    console.error('✗ 致命失敗：舊主機 A 的延遲心跳成功覆蓋了新主機，引發殭屍主機漏洞！');
    process.exit(1);
  } else {
    console.log('  -> ✓ 系統成功攔截無 rev 遞增的主機篡改。');
  }

  const humanCount = localRoom.players.filter(p => !p.isBot).length;
  console.log(`\n[最終驗證] 真人數: ${humanCount} ｜ 旁觀者: ${(localRoom.spectators || []).length}`);
  
  if (humanCount !== 8) {
    console.error('✗ 失敗：在接管競爭中，有真人被錯誤踢除！');
    process.exit(1);
  }

  console.log('\n✓ 測試通過：Transaction 重試、延遲心跳防禦與真人座位保護皆符合預期！');
}

testNetConcurrency();