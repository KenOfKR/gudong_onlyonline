/* ============================================================================
 * js/net.js — 房間存取、同步與大廳清理（防作弊加密封裝與高併發重試優化版）
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U, Engine } = GD;
  const C = GD.CONFIG;

  let db = null, auth = null, unsub = null;
  let room = null, bgRoom = null, mode = 'solo';
  let chain = Promise.resolve();
  let beatTimer = null;

  const clone = o => JSON.parse(JSON.stringify(o));
  const docId = code => C.ROOM_PREFIX + code;
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  function persistentPlayerId() {
    try {
      let id = localStorage.getItem('gudong_v9_pid') || sessionStorage.getItem('gudong_v9_pid');
      if (!id) id = U.uid('p');
      localStorage.setItem('gudong_v9_pid', id);
      sessionStorage.setItem('gudong_v9_pid', id);
      return id;
    } catch (e) { return U.uid('p'); }
  }

  /* --- 防窺探混淆機制 (Obfuscation) --- */
  // 用簡單 XOR + Base64 讓 F12 看起來是亂碼，鹽值綁定 gameId
  function xorCodec(str, key) {
    if (!key || !str) return str;
    let out = '';
    for (let i = 0; i < str.length; i++) {
      out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  // 將房間物件打包：提取公開欄位，機密欄位塞進 _sealed 加密
  function packRoom(r) {
    if (!r) return r;
    const pub = {
      roomId: r.roomId, gameId: r.gameId, status: r.status, mode: r.mode,
      closed: !!r.closed, rev: r.rev || 0, updatedAt: r.updatedAt || Date.now(),
      hostId: r.hostId, hostBeat: r.hostBeat,
      currentRoundIdx: r.currentRoundIdx || 0,
      spectators: r.spectators || [],
      // 大廳需要的人數與名單
      lobbyPlayers: (r.players || []).map(p => ({ id: p.id, name: p.name, isBot: p.isBot }))
    };
    
    // 把不想被看光的欄位（如底牌 role, 獸首真偽 isReal, mind, turnLogs 等）全部獨立抽出來
    const secret = { ...r };
    ['roomId', 'gameId', 'status', 'mode', 'closed', 'rev', 'updatedAt', 'hostId', 'hostBeat', 'currentRoundIdx', 'spectators'].forEach(k => delete secret[k]);
    
    try {
      const jsonStr = JSON.stringify(secret);
      // 以 roomId + gameId 作為簡單的動態鹽值
      const salt = r.roomId + (r.gameId || 'v9');
      const b64 = btoa(unescape(encodeURIComponent(xorCodec(jsonStr, salt))));
      pub._sealed = b64;
    } catch (e) {
      console.warn('[net] 打包加密失敗，退回明文', e);
      return r;
    }
    return pub;
  }

  // 將打包的房間還原回完整明文
  function unpackRoom(d) {
    if (!d) return d;
    if (!d._sealed) return clone(d); // 兼容舊版明文紀錄
    try {
      const salt = d.roomId + (d.gameId || 'v9');
      const jsonStr = xorCodec(decodeURIComponent(escape(atob(d._sealed))), salt);
      const secret = JSON.parse(jsonStr);
      const full = { ...secret };
      // 覆寫回公開欄位，確保資料一致
      ['roomId', 'gameId', 'status', 'mode', 'closed', 'rev', 'updatedAt', 'hostId', 'hostBeat', 'currentRoundIdx', 'spectators'].forEach(k => {
        if (d[k] !== undefined) full[k] = d[k];
      });
      // 確保陣列還原
      if (!full.players && d.lobbyPlayers) full.players = d.lobbyPlayers;
      return full;
    } catch (e) {
      console.warn('[net] 解包失敗，可能資料已損毀', e);
      return clone(d); // 如果解不開，盡量退回它原本的樣子
    }
  }

  const Net = {
    myId: persistentPlayerId(),
    room: () => room,
    bgRoom: () => bgRoom,
    mode: () => mode,
    me: () => (room ? U.byId(room, Net.myId) : null),
    onlineAvailable: () => !!db,
    user: null,

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

    persistLocal() {
      const target = room || bgRoom;
      if (target) GD.store.set(C.STORAGE.room + target.roomId, packRoom(target));
    },

    commit(next) {
      if (!next) return;
      if (room && next.roomId === room.roomId) {
        room = next;
      } else if (bgRoom && next.roomId === bgRoom.roomId) {
        bgRoom = next;
        if (bgRoom.status === 'gameover' && bgRoom.learning) {
          if (mode === 'solo') GD.store.set(C.STORAGE.room + bgRoom.roomId, packRoom(bgRoom));
        }
      }
      Net.persistLocal();
      GD.bus.emit('room', next);
    },

    act(fn) {
      const p = chain.then(() => run(fn));
      chain = p.catch(() => {});
      return p;
    },

    async join({ code, name, asMode, fillBots = false }) {
      Net.leave(true, true);
      mode = (asMode === 'online' && db) ? 'online' : 'solo';
      const key = docId(code);
      let existing = null;
      const cleanName = String(name || '掌眼人').trim();

      if (mode === 'online') {
        try {
          const snap = await withTimeout(db.doc(`${C.ROOM_COLLECTION}/${key}`).get(), 7000);
          existing = snap.exists ? unpackRoom(snap.data()) : null;
        } catch (e) {
          console.warn('[net] 讀取遠端房間失敗，改用單人模式', e);
          mode = 'solo';
        }
      }
      if (mode === 'solo') existing = unpackRoom(GD.store.get(C.STORAGE.room + code, null));

      if (existing && (existing.closed || Date.now() - (existing.updatedAt || 0) > C.ROOM_STALE_MS)) existing = null;
      room = existing || Engine.newRoom(code, Net.myId);
      room.mode = mode;

      const ok = await Net.act(r => {
        if (!r.spectators) r.spectators = [];

        const byIdPlayer = r.players.find(p => p.id === Net.myId);
        const byNamePlayer = r.players.find(p => !p.isBot && String(p.name).trim() === cleanName);
        const mine = byIdPlayer || byNamePlayer;

        if (mine) {
          if (Engine.reclaimPlayer) {
            Engine.reclaimPlayer(r, mine.id, Net.myId, cleanName);
          } else {
            mine.id = Net.myId;
            mine.name = cleanName;
          }
        } else if (r.status === 'waiting' && r.players.length < 8) {
          r.spectators = r.spectators.filter(s => s.id !== Net.myId && s.name !== cleanName);
          if (!Engine.addPlayer(r, { id: Net.myId, name: cleanName })) return false;
        } else if (r.status === 'waiting' && r.players.length >= 8 && r.players.some(p => p.isBot)) {
          r.spectators = r.spectators.filter(s => s.id !== Net.myId && s.name !== cleanName);
          if (!Engine.addPlayer(r, { id: Net.myId, name: cleanName })) return false;
        } else {
          const spec = r.spectators.find(s => s.id === Net.myId) || r.spectators.find(s => s.name === cleanName);
          if (spec) {
            spec.id = Net.myId;
            spec.name = cleanName;
          } else {
            r.spectators.push({ id: Net.myId, name: cleanName });
            if (r.spectators.length > 20) r.spectators.shift();
          }
        }

        const hostValid = r.hostId && (
          r.players.some(p => p.id === r.hostId && !p.isBot) ||
          r.spectators.some(s => s.id === r.hostId)
        );
        if (!hostValid) {
          const nextHost = r.players.find(p => !p.isBot);
          r.hostId = nextHost ? nextHost.id : Net.myId;
        }
        r.hostBeat = Date.now();
        r.mode = mode;
        if (fillBots && r.status === 'waiting' && r.players.length < 8) { Engine.fillBots(r); }
        return true;
      });
      if (!ok) { room = null; throw new Error('房間處理失敗，無法加入'); }

      if (mode === 'online') subscribe(key);
      startBeat();
      GD.bus.emit('joined', room);
      return room;
    },

    leave(silent, hardStop = false) {
      if (!hardStop && room && room.status !== 'waiting' && room.status !== 'gameover') {
        bgRoom = room;
        room = null;
        if (Engine.replaceWithBot) {
          Net.act(r => {
            let changed = false;
            const meInSeat = r.players.find(p => p.id === Net.myId && !p.isBot);
            if (meInSeat && Engine.replaceWithBot(r, Net.myId)) changed = true;
            r.hostId = Net.myId;
            r.hostBeat = Date.now();
            return changed || true;
          }).then(() => {
            if (GD.Driver && GD.Driver.schedule) GD.Driver.schedule();
          });
        }
        if (!silent) GD.bus.emit('left');
        return;
      }

      if (unsub) { unsub(); unsub = null; }
      clearInterval(beatTimer); beatTimer = null;
      if (room && mode === 'solo' && room.status === 'gameover') GD.store.remove(C.STORAGE.room + room.roomId);
      room = null;
      bgRoom = null;
      GD.Driver && GD.Driver.reset();
      if (!silent) GD.bus.emit('left');
    },

    adoptInBackground(data, srcMode) {
      if (room || !data || !data.roomId) return;
      if (data.status === 'waiting' || (data.status === 'gameover' && data.learning)) return;
      
      const unpackedData = unpackRoom(data); // 解包還原

      if (bgRoom && bgRoom.roomId === unpackedData.roomId) {
        if ((unpackedData.rev || 0) > (bgRoom.rev || 0)) bgRoom = unpackedData;
        if (GD.Driver && GD.Driver.schedule) GD.Driver.schedule();
        return;
      }
      if (!bgRoom || bgRoom.status === 'gameover') {
        if (unsub) { unsub(); unsub = null; }
        mode = (srcMode === 'online' && db) ? 'online' : 'solo';
        bgRoom = clone(unpackedData);
        if (mode === 'online') subscribe(docId(bgRoom.roomId));
        startBeat();
        const idleMs = Date.now() - (bgRoom.updatedAt || 0);
        if (idleMs > 12000 && Engine.replaceWithBot) {
          Net.act(r => {
            let changed = false;
            (r.players || []).forEach(p => {
              if (!p.isBot && Engine.replaceWithBot(r, p.id)) changed = true;
            });
            r.hostId = Net.myId;
            r.hostBeat = Date.now();
            return changed || true;
          }).then(() => {
            if (GD.Driver && GD.Driver.schedule) GD.Driver.schedule();
          });
        } else if (GD.Driver && GD.Driver.schedule) {
          GD.Driver.schedule();
        }
      }
    },

    async lobby() {
      const now = Date.now(), out = [];
      let candidateToAdopt = null;

      const consider = (data, source) => {
        if (!data || !data.roomId) return;
        const stale = now - (data.updatedAt || 0) > C.ROOM_STALE_MS;
        if (stale || data.closed) return;
        
        // 由於我們改寫了 packRoom，現在可以直接從 lobbyPlayers 讀取人類玩家名單，不需解密
        const pList = data.lobbyPlayers || data.players || [];
        const humans = pList.filter(p => !p.isBot).map(p => p.name);
        
        out.push({
          code: data.roomId, source, status: data.status, round: (data.currentRoundIdx || 0) + 1,
          humans, total: pList.length, updatedAt: data.updatedAt || 0, mode: data.mode || source
        });

        if (!room && data.status !== 'waiting' && data.status !== 'gameover') {
          const idleMs = now - (data.updatedAt || 0);
          if (humans.length === 0 || idleMs > 10000 || (bgRoom && bgRoom.roomId === data.roomId)) {
            if (!candidateToAdopt) candidateToAdopt = { data, source };
          }
        }
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
      GD.store.keys(C.STORAGE.room).forEach(k => {
        const data = unpackRoom(GD.store.get(k, null));
        if (!data) return;
        if (!data.closed && now - (data.updatedAt || 0) > C.ROOM_STALE_MS) { data.closed = true; GD.store.set(k, packRoom(data)); return; }
        if (!(db && out.some(o => o.code === data.roomId && o.source === 'online'))) consider(data, 'solo');
      });
      staleOnline.forEach(ref => ref.set({ closed: true }, { merge: true }).catch(() => {}));

      if (!room && candidateToAdopt) {
        Net.adoptInBackground(candidateToAdopt.data, candidateToAdopt.source);
      }

      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }
  };

  async function run(fn) {
    const active = room || bgRoom;
    if (!active) return false;
    if (mode === 'online' && db) {
      const ref = db.doc(`${C.ROOM_COLLECTION}/${docId(active.roomId)}`);
      // ★ 防撞車升級：拉高重試上限至 8 次，並加入隨機退避 Jitter 錯開各玩家撞擊時間
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const result = await withTimeout(db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const base = snap.exists ? unpackRoom(snap.data()) : active;
            const draft = clone(base);
            let ok = false;
            try { ok = fn(draft); } catch (e) { console.error('[act]', e); }
            if (!ok) return { aborted: true, latest: base };
            draft.rev = (base.rev || 0) + 1;
            draft.updatedAt = Date.now();
            const clean = clone(draft);
            tx.set(ref, packRoom(clean)); // 送出前加密封裝
            return { aborted: false, clean };
          }), 10000);

          if (!result || result.aborted) {
            if (result && result.latest && (result.latest.rev || 0) > (active.rev || 0)) {
              Net.commit(result.latest);
            }
            return false;
          }
          Net.commit(result.clean);
          return true;
        } catch (e) {
          console.warn(`[net] 遠端交易重試 (${attempt + 1}/8)：`, e && e.message);
          // 隨機抖動 (Jitter) 讓同時卡住的 Client 錯開
          if (attempt < 7) await sleep(150 * (attempt + 1) + Math.random() * 200);
        }
      }
      if (room) GD.bus.emit('netwarn', '網路延遲過高，請再點擊一次確認動作');
      return false;
    }

    const draft = clone(active);
    let ok = false;
    try { ok = fn(draft); } catch (e) { console.error('[act]', e); }
    if (!ok) return false;
    draft.rev = (active.rev || 0) + 1;
    draft.updatedAt = Date.now();
    Net.commit(draft);
    return true;
  }

  function subscribe(key) {
    unsub = db.doc(`${C.ROOM_COLLECTION}/${key}`).onSnapshot(snap => {
      const active = room || bgRoom;
      if (!snap.exists || !active) return;
      const remote = unpackRoom(snap.data()); // 即時接收並解包
      if (remote.closed) {
        if (room) GD.bus.emit('closed');
        bgRoom = null;
        return;
      }
      if ((remote.rev || 0) > (active.rev || 0) || remote.gameId !== active.gameId) {
        Net.commit(remote);
      }
    }, err => console.warn('[net] 訂閱中斷', err && err.message));
  }

  function startBeat() {
    clearInterval(beatTimer);
    beatTimer = setInterval(() => {
      const active = room || bgRoom;
      if (!active || active.status === 'gameover') return;
      const isHost = active.hostId === Net.myId;
      const hostStale = Date.now() - (active.hostBeat || 0) > 25000;
      const firstHuman = (active.players || []).find(p => !p.isBot) || (active.spectators || [])[0];
      if (!isHost && !(hostStale && (!firstHuman || firstHuman.id === Net.myId))) return;

      if (mode === 'online' && db) {
        const now = Date.now();
        active.hostBeat = now;
        const patch = { hostBeat: now, updatedAt: now };
        if (!isHost) { active.hostId = Net.myId; patch.hostId = Net.myId; }
        db.doc(`${C.ROOM_COLLECTION}/${docId(active.roomId)}`).update(patch).catch(() => {});
      } else {
        Net.act(r => { r.hostBeat = Date.now(); return true; });
      }
    }, 12000);
  }

  GD.Net = Net;
  
  // 雙環境相容，確保測試不受影響
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Net;
})(typeof window !== 'undefined' ? window : global);