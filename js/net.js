/* ============================================================================
 * net.js — 房間存取、同步與大廳清理
 *
 * 兩種模式：
 *   solo    單人 + 電腦，狀態只存 localStorage，不碰網路（雙擊 index.html 就能玩）
 *   online  多人連線，Firestore 即時同步；每個動作用「交易」套用在最新遠端狀態上，
 *           兩位真人同時投票也不會互相覆蓋。
 *
 * 唯一的寫入入口：Net.act(fn)。fn(room) 是就地修改函式，回傳 falsy 代表動作不合法（不寫入）。
 * 所有 act 會排隊依序執行；成功後遞增 rev 並廣播 bus 事件 'room'。
 *
 * 大廳清理：超過 CONFIG.ROOM_STALE_MS（30 分鐘）未更新的房間，標記 closed 並從列表隱藏。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Engine } = GD;
  const C = GD.CONFIG;

  let db = null, auth = null, unsub = null;
  let room = null, mode = 'solo';
  let chain = Promise.resolve();
  let beatTimer = null;

  const clone = o => JSON.parse(JSON.stringify(o));
  const docId = code => C.ROOM_PREFIX + code;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  /* 每個分頁一個玩家 id（sessionStorage），重新整理仍是同一個人 */
  function tabPlayerId() {
    try {
      let id = sessionStorage.getItem('gudong_v9_pid');
      if (!id) { id = U.uid('p'); sessionStorage.setItem('gudong_v9_pid', id); }
      return id;
    } catch (e) { return U.uid('p'); }
  }

  const Net = {
    myId: tabPlayerId(),
    room: () => room,
    mode: () => mode,
    me: () => (room ? U.byId(room, Net.myId) : null),
    onlineAvailable: () => !!db,
    user: null,

    /* ------------------------------------------------------------ 初始化 Firebase（可選）*/
    init() {
      try {
        if (typeof firebase === 'undefined') return;
        if (!firebase.apps.length) firebase.initializeApp(GD.FIREBASE_CONFIG);
        db = firebase.firestore();
        auth = firebase.auth();
        auth.onAuthStateChanged(u => {
          if (u && !u.isAnonymous) {
            Net.user = { uid: u.uid, name: String(u.displayName || (u.email || '').split('@')[0] || '').slice(0, 10), email: u.email || '' };
            GD.bus.emit('auth', Net.user);
          } else if (!u) auth.signInAnonymously().catch(() => {});
        });
      } catch (e) { console.warn('[net] Firebase 無法初始化，僅提供單人模式：', e); db = null; }
    },

    async googleLogin() {
      if (!auth) throw new Error('目前環境無法使用 Firebase 登入（需 http/https 網域）');
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return auth.signInWithPopup(provider);
    },
    async logout() { Net.user = null; try { if (auth) await auth.signOut(); } catch (e) { /* ignore */ } GD.bus.emit('auth', null); },

    /* ------------------------------------------------------------ 寫入 */
    persistLocal() {
      if (room) GD.store.set(C.STORAGE.room + room.roomId, room);
    },

    commit(next) {
      room = next;
      Net.persistLocal();
      GD.bus.emit('room', room);
    },

    /** 唯一寫入入口：fn(draft) 回傳 truthy 才會寫入。回傳 Promise<boolean> */
    act(fn) {
      const p = chain.then(() => run(fn));
      chain = p.catch(() => {});
      return p;
    },

    /* ------------------------------------------------------------ 進入 / 離開房間 */
    async join({ code, name, asMode, fillBots = false }) {
      Net.leave(true);
      mode = (asMode === 'online' && db) ? 'online' : 'solo';
      const key = docId(code);
      let existing = null;

      if (mode === 'online') {
        try {
          const snap = await withTimeout(db.doc(`${C.ROOM_COLLECTION}/${key}`).get(), 7000);
          existing = snap.exists ? snap.data() : null;
        } catch (e) {
          console.warn('[net] 讀取遠端房間失敗，改用單人模式', e);
          mode = 'solo';
        }
      }
      if (mode === 'solo') existing = GD.store.get(C.STORAGE.room + code, null);

      if (existing && (existing.closed || Date.now() - (existing.updatedAt || 0) > C.ROOM_STALE_MS)) existing = null;   // 過期房間視同不存在
      room = existing || Engine.newRoom(code, Net.myId);
      room.mode = mode;

      const ok = await Net.act(r => {
        const mine = r.players.find(p => p.id === Net.myId) ||
          (r.status !== 'waiting' ? r.players.find(p => !p.isBot && p.name === name) : null);   // 斷線重連：以暱稱認回座位
        if (mine) { mine.id = Net.myId; mine.name = name; }
        else if (!Engine.addPlayer(r, { id: Net.myId, name })) return false;
        if (!r.hostId || !r.players.some(p => p.id === r.hostId && !p.isBot)) r.hostId = Net.myId;
        r.hostBeat = Date.now();
        r.mode = mode;
        if (fillBots && r.status === 'waiting') { Engine.fillBots(r); }
        return true;
      });
      if (!ok) { room = null; throw new Error('房間已滿或遊戲進行中，無法加入'); }

      if (mode === 'online') subscribe(key);
      startBeat();
      GD.bus.emit('joined', room);
      return room;
    },

    leave(silent) {
      if (unsub) { unsub(); unsub = null; }
      clearInterval(beatTimer); beatTimer = null;
      if (room && mode === 'solo' && room.status === 'gameover') GD.store.remove(C.STORAGE.room + room.roomId);
      room = null;
      GD.Driver && GD.Driver.reset();
      if (!silent) GD.bus.emit('left');
    },

    /* ------------------------------------------------------------ 大廳列表 + 自動清理 */
    async lobby() {
      const now = Date.now(), out = [];
      const consider = (data, source) => {
        if (!data || !data.roomId) return;
        const stale = now - (data.updatedAt || 0) > C.ROOM_STALE_MS;
        if (stale || data.closed) return;
        out.push({
          code: data.roomId, source, status: data.status, round: (data.currentRoundIdx || 0) + 1,
          humans: (data.players || []).filter(p => !p.isBot).map(p => p.name),
          total: (data.players || []).length, updatedAt: data.updatedAt || 0, mode: data.mode || source
        });
      };
      const staleOnline = [];

      if (db) {
        try {
          const snap = await withTimeout(db.collection(C.ROOM_COLLECTION).orderBy('updatedAt', 'desc').limit(40).get(), 6000);
          snap.forEach(d => {
            if (!d.id.startsWith(C.ROOM_PREFIX)) return;
            const data = d.data();
            if (!data.closed && now - (data.updatedAt || 0) > C.ROOM_STALE_MS) staleOnline.push(d.ref);
            consider(data, 'online');
          });
        } catch (e) { console.warn('[net] 大廳讀取失敗', e && e.message); }
      }
      // 本機房間（單人局）：同樣套用 30 分鐘規則，過期的直接標記 closed
      GD.store.keys(C.STORAGE.room).forEach(k => {
        const data = GD.store.get(k, null);
        if (!data) return;
        if (!data.closed && now - (data.updatedAt || 0) > C.ROOM_STALE_MS) { data.closed = true; GD.store.set(k, data); return; }
        if (!(db && out.some(o => o.code === data.roomId && o.source === 'online'))) consider(data, 'solo');
      });
      // 把遠端過期房間標記為 closed（任何用戶開大廳都會順手清；失敗不影響使用）
      staleOnline.forEach(ref => ref.set({ closed: true }, { merge: true }).catch(() => {}));

      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }
  };

  /* ---------------------------------------------------------------- 內部 */

  async function run(fn) {
    if (!room) return false;
    if (mode === 'online' && db) {
      const ref = db.doc(`${C.ROOM_COLLECTION}/${docId(room.roomId)}`);
      try {
        const result = await withTimeout(db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const base = snap.exists ? snap.data() : room;
          const draft = clone(base);
          let ok = false;
          try { ok = fn(draft); } catch (e) { console.error('[act]', e); }
          if (!ok) return null;
          draft.rev = (base.rev || 0) + 1;
          draft.updatedAt = Date.now();
          const clean = clone(draft);                     // Firestore 不接受 undefined 欄位；JSON 往返會把它們去掉
          tx.set(ref, clean);
          return clean;
        }), 9000);
        if (!result) return false;
        Net.commit(result);
        return true;
      } catch (e) {
        console.warn('[net] 交易失敗，暫以本機狀態繼續：', e && e.message);
        GD.bus.emit('netwarn', '連線不穩，動作已在本機套用');
      }
    }
    const draft = clone(room);
    let ok = false;
    try { ok = fn(draft); } catch (e) { console.error('[act]', e); }
    if (!ok) return false;
    draft.rev = (room.rev || 0) + 1;
    draft.updatedAt = Date.now();
    Net.commit(draft);
    return true;
  }

  function subscribe(key) {
    unsub = db.doc(`${C.ROOM_COLLECTION}/${key}`).onSnapshot(snap => {
      if (!snap.exists || !room) return;
      const remote = snap.data();
      if (remote.closed) { GD.bus.emit('closed'); return; }
      if ((remote.rev || 0) > (room.rev || 0) || remote.gameId !== room.gameId) {
        if ((remote.rev || 0) >= (room.rev || 0)) Net.commit(remote);
      }
    }, err => console.warn('[net] 訂閱中斷', err && err.message));
  }

  /** 房主心跳：讓其他人知道「負責代打電腦的人」還在；同時維持 updatedAt 不被大廳清掉 */
  function startBeat() {
    clearInterval(beatTimer);
    beatTimer = setInterval(() => {
      if (!room || room.hostId !== Net.myId || room.status === 'gameover') return;   // 終局後不再續命，讓大廳能自然清理
      Net.act(r => { r.hostBeat = Date.now(); return true; });
    }, 10000);
  }

  GD.Net = Net;
})(window.GD);
