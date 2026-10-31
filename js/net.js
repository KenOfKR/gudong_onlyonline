/* ============================================================================
 * js/net.js — 房間存取、同步與大廳清理（嚴格事務隔離與殭屍主機防禦版）
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

  const HOST_STALE_MS = 25000;
  function isHostStale(data, now = Date.now()) {
    if (!data) return true;
    const beat = Number(data.hostBeat || 0);
    const lastSeen = beat || Number(data.updatedAt || 0);
    return !lastSeen || now - lastSeen > HOST_STALE_MS;
  }

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
  function xorCodec(str, key) {
    if (!key || !str) return str;
    let out = '';
    for (let i = 0; i < str.length; i++) {
      out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  const PUBLIC_KEYS = [
    'roomId', 'gameId', 'status', 'mode', 'closed', 'rev',
    'updatedAt', 'hostId', 'hostBeat', 'currentRoundIdx',
    'turnStartTime', 'spectators'
  ];

  function packRoom(r) {
    if (!r) return r;
    const pub = {
      roomId: r.roomId, gameId: r.gameId, status: r.status, mode: r.mode,
      closed: !!r.closed, rev: r.rev || 0, updatedAt: r.updatedAt || Date.now(),
      hostId: r.hostId, hostBeat: r.hostBeat || Date.now(),
      currentRoundIdx: r.currentRoundIdx || 0,
      turnStartTime: r.turnStartTime || Date.now(),
      spectators: r.spectators || [],
      lobbyPlayers: (r.players || []).map(p => ({ id: p.id, name: p.name, isBot: p.isBot }))
    };

    const secret = { ...r };
    PUBLIC_KEYS.forEach(k => delete secret[k]);

    try {
      const jsonStr = JSON.stringify(secret);
      const salt = r.roomId + (r.gameId || 'v9');
      const b64 = btoa(unescape(encodeURIComponent(xorCodec(jsonStr, salt))));
      pub._sealed = b64;
    } catch (e) {
      return r;
    }
    return pub;
  }

  function unpackRoom(d) {
    if (!d) return d;
    if (!d._sealed) return clone(d);
    try {
      const salt = d.roomId + (d.gameId || 'v9');
      const jsonStr = xorCodec(decodeURIComponent(escape(atob(d._sealed))), salt);
      const secret = JSON.parse(jsonStr);
      const full = { ...secret };
      PUBLIC_KEYS.forEach(k => {
        if (d[k] !== undefined) full[k] = d[k];
      });
      if (!full.players && d.lobbyPlayers) full.players = d.lobbyPlayers;
      if (!full.turnStartTime) full.turnStartTime = d.updatedAt || Date.now();
      return full;
    } catch (e) {
      return clone(d);
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
          } else if (!u) auth.signInAnonymously().catch(error => { console.error('[net] Anonymous Firebase sign-in failed', error); });
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
            const meInSeat = r.players.find(p => p.id === Net.myId && !p.isBot);
            if (!meInSeat) return false;
            Engine.replaceWithBot(r, Net.myId);
            // 放棄主機權給場上其他真人
            const remainingHuman = r.players.find(p => !p.isBot);
            r.hostId = remainingHuman ? remainingHuman.id : Net.myId;
            r.hostBeat = Date.now();
            return true;
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

      const unpackedData = unpackRoom(data);

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

        if (isHostStale(bgRoom)) {
          Net.act(r => {
            if (!isHostStale(r)) return false;
            r.hostId = Net.myId;
            r.hostBeat = Date.now();
            // ★ 移除危險批次替換，背景接管僅負責轉移主機權以維持系統運作
            return true;
          }).then(ok => {
            if (ok && GD.Driver && GD.Driver.schedule) GD.Driver.schedule();
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

        const pList = data.lobbyPlayers || data.players || [];
        const humans = pList.filter(p => !p.isBot).map(p => p.name);

        out.push({
          code: data.roomId, source, status: data.status, round: (data.currentRoundIdx || 0) + 1,
          humans, total: pList.length, updatedAt: data.updatedAt || 0, mode: data.mode || source
        });

        if (!room && data.status !== 'waiting' && data.status !== 'gameover') {
          const sameBackgroundRoom = bgRoom && bgRoom.roomId === data.roomId;
          if (humans.length === 0 || isHostStale(data, now) || sameBackgroundRoom) {
            if (!candidateToAdopt) candidateToAdopt = { data, source };
          }
        }
      };

      const staleOnline = [];

      if (db) {
        try {
          if (!auth) {
            throw new Error('Firebase Auth is not initialized');
          }

          // Wait for the existing Firebase Auth flow to finish sign-in.
          // Do not start another anonymous sign-in here.
          if (!auth.currentUser) {
            await new Promise((resolve, reject) => {
              let unsubscribe = null;
              let settled = false;

              const finish = (error, user) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (unsubscribe) unsubscribe();

                if (error) reject(error);
                else resolve(user);
              };

              const timer = setTimeout(() => {
                finish(new Error('Timed out waiting for Firebase Auth'));
              }, 9000);

              unsubscribe = auth.onAuthStateChanged(
                user => {
                  if (user) finish(null, user);
                },
                error => finish(error)
              );

              // Defensive cleanup in case the callback fires immediately.
              if (settled && unsubscribe) unsubscribe();
            });
          }

          if (!auth.currentUser) {
            throw new Error('Firebase Auth has no current user');
          }

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
            tx.set(ref, packRoom(clean));
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
      const raw = snap.data();
      
      // ★ 防禦殭屍主機：嚴格比對版本號。舊主機發送延遲心跳時（rev 未增加），只更新 hostBeat，絕不覆蓋 hostId
      if (raw && raw.hostBeat && raw.hostBeat > (active.hostBeat || 0)) {
        active.hostBeat = raw.hostBeat;
      }

      const remote = unpackRoom(raw);
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

      if (isHost) {
        const now = Date.now();
        active.hostBeat = now;
        if (mode === 'online' && db) {
          db.doc(`${C.ROOM_COLLECTION}/${docId(active.roomId)}`).update({ hostBeat: now, updatedAt: now }).catch(() => {});
        } else {
          Net.act(r => { r.hostBeat = Date.now(); return true; });
        }
      } else {
        const hostStale = Date.now() - (active.hostBeat || 0) > HOST_STALE_MS;
        const firstHuman = (active.players || []).find(p => !p.isBot) || (active.spectators || [])[0];
        
        // ★ 強制事務隔離：非主機玩家若要接管，必須透過 Net.act 發起具備 rev 遞增的交易！
        if (hostStale && firstHuman && firstHuman.id === Net.myId) {
          Net.act(r => {
            if (!isHostStale(r)) return false; 
            r.hostId = Net.myId;
            r.hostBeat = Date.now();
            return true;
          }).then(ok => {
            if (ok && GD.Driver && GD.Driver.schedule) GD.Driver.schedule();
          });
        }
      }
    }, 12000);
  }

  GD.Net = Net;

  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Net;
})(typeof window !== 'undefined' ? window : global);