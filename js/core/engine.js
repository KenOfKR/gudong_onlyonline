/* ============================================================================
 * core/engine.js — 遊戲狀態機（修復計時基準，恢復真實時間戳）
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Rules, Claims } = GD;
  const C = GD.CONFIG;
  const Engine = {};

  function migratePlayerIdInRoom(room, oldId, newId, newName) {
    if (!oldId || !newId || oldId === newId) return;
    if (room.afkRescue && room.afkRescue.targetId === oldId) room.afkRescue = null;
    if (room.humanActivityAt && room.humanActivityAt[oldId] !== undefined) {
      room.humanActivityAt[newId] = room.humanActivityAt[oldId];
      delete room.humanActivityAt[oldId];
    }
    if (room.hostId === oldId) room.hostId = newId;
    if (room.currentTurnPlayerId === oldId) room.currentTurnPlayerId = newId;
    if (room.currentSpeakerId === oldId) room.currentSpeakerId = newId;
    (room.rounds || []).forEach(rd => {
      const poIdx = (rd.passOrder || []).indexOf(oldId);
      if (poIdx >= 0) rd.passOrder[poIdx] = newId;
      if (rd.turnLogs && rd.turnLogs[oldId]) {
        rd.turnLogs[newId] = rd.turnLogs[oldId];
        delete rd.turnLogs[oldId];
      }
      Object.values(rd.turnLogs || {}).forEach(l => {
        if (l.fangTargetId === oldId) l.fangTargetId = newId;
        if (l.ambushTargetId === oldId) l.ambushTargetId = newId;
        if (Array.isArray(l.ambushIds)) {
          const ai = l.ambushIds.indexOf(oldId);
          if (ai >= 0) l.ambushIds[ai] = newId;
        }
        if (l.nextPlayerId === oldId) l.nextPlayerId = newId;
      });
      const sIdx = (rd.speechOrder || []).indexOf(oldId);
      if (sIdx >= 0) rd.speechOrder[sIdx] = newId;
      (rd.speeches || []).forEach(sp => {
        if (sp.playerId === oldId) {
          sp.playerId = newId;
          if (newName) sp.speakerName = newName;
        }
        if (sp.p) {
          if (sp.p.callSuspectId === oldId) sp.p.callSuspectId = newId;
          const aIdx = (sp.p.asked || []).indexOf(oldId);
          if (aIdx >= 0) sp.p.asked[aIdx] = newId;
          (sp.p.accuse || []).forEach(acc => { if (acc.playerId === oldId) acc.playerId = newId; });
          (sp.p.campChecks || []).forEach(cc => { if (cc.targetId === oldId) cc.targetId = newId; });
        }
      });
      if (rd.votes && rd.votes[oldId] !== undefined) {
        rd.votes[newId] = rd.votes[oldId];
        delete rd.votes[oldId];
      }
      if (rd.voteResults && rd.voteResults.chips) {
        Object.values(rd.voteResults.chips).forEach(arr => {
          (arr || []).forEach(c => {
            if (c.voterId === oldId) {
              c.voterId = newId;
              if (newName) c.voterName = newName;
            }
          });
        });
      }
      if (rd.mind && rd.mind[oldId]) {
        rd.mind[newId] = rd.mind[oldId];
        delete rd.mind[oldId];
      }
    });
    if (room.personVotes) {
      if (room.personVotes[oldId]) {
        room.personVotes[newId] = room.personVotes[oldId];
        delete room.personVotes[oldId];
      }
      Object.entries(room.personVotes).forEach(([k, v]) => {
        if (v === oldId) room.personVotes[k] = newId;
      });
    }
  }

  Engine.newRoom = function (code, hostId) {
    const now = Date.now();
    return {
      v: 9, roomId: code, hostId: hostId || null, hostBeat: now,
      gameId: null, status: 'waiting', closed: false,
      currentRoundIdx: 0, currentTurnPlayerId: null, currentSpeakerId: null,
      turnStartTime: now, humanActivityAt: {}, afkRescue: null, deck: [...GD.ZODIAC], players: [], spectators: [], rounds: [], personVotes: {},
      gameOver: null, learning: null, plan: null, rev: 0, createdAt: now, updatedAt: now
    };
  };

  const AFK_LIMIT_MS = 120000;
  const AFK_RESCUE_MS = 10000;

  Engine.afkContext = function (room) {
    if (!room || ['waiting', 'gameover'].includes(room.status)) return null;
    let target = null, phaseKey = room.status, rd = U.curRound(room);
    if (room.status === 'playing') target = U.byId(room, room.currentTurnPlayerId);
    else if (room.status === 'discussion') target = U.byId(room, room.currentSpeakerId);
    else if (room.status === 'voting') {
      if (!rd || rd.voteResults) return null;
      target = (room.players || []).find(p => !p.isBot && (!rd.votes || rd.votes[p.id] === undefined)) || null;
    } else if (room.status === 'person_voting') {
      target = (room.players || []).find(p => !p.isBot && !(room.personVotes || {})[p.id]) || null;
    }
    if (!target || target.isBot) return null;
    const log = room.status === 'playing' && rd && rd.turnLogs && rd.turnLogs[target.id];
    const step = log && log.step || '';
    const startAt = (room.status === 'voting' || room.status === 'person_voting')
      ? Number((room.humanActivityAt || {})[target.id] || room.turnStartTime || room.updatedAt || Date.now())
      : Number(room.turnStartTime || room.updatedAt || Date.now());
    const actionKey = [room.gameId || room.roomId, room.currentRoundIdx, phaseKey, target.id, step,
      rd && rd.speechIndex || 0, startAt].join('|');
    return { targetId: target.id, actionKey, startedAt: startAt, phase: phaseKey };
  };

  Engine.beginAfkRescue = function (room, targetId, actionKey, now = Date.now()) {
    const ctx = Engine.afkContext(room);
    const target = U.byId(room, targetId);
    if (!ctx || !target || target.isBot || ctx.targetId !== targetId || ctx.actionKey !== actionKey) return false;
    if (now - ctx.startedAt < AFK_LIMIT_MS) return false;
    const current = room.afkRescue;
    if (current && current.actionKey === actionKey) return false;
    room.afkRescue = { targetId, actionKey, phase: 'waiting', startedAt: now,
      deadlineAt: now + AFK_RESCUE_MS, confirmedBy: null, confirmedAt: null };
    return true;
  };

  Engine.confirmAfkRescue = function (room, helperId, targetId, actionKey, now = Date.now()) {
    const rescue = room && room.afkRescue;
    const helper = U.byId(room, helperId), target = U.byId(room, targetId), ctx = Engine.afkContext(room);
    if (!rescue || rescue.phase !== 'waiting' || rescue.targetId !== targetId || rescue.actionKey !== actionKey ||
        !ctx || ctx.targetId !== targetId || ctx.actionKey !== actionKey || !target || target.isBot ||
        !helper || helper.isBot || helper.id === targetId || now > rescue.deadlineAt) return false;
    rescue.phase = 'confirmed';
    rescue.confirmedBy = helperId;
    rescue.confirmedAt = now;
    rescue.deadlineAt = now + AFK_RESCUE_MS;
    return true;
  };

  Engine.markHumanActive = function (room, pid, now = Date.now()) {
    const player = U.byId(room, pid), ctx = Engine.afkContext(room);
    if (!player || player.isBot || !ctx || ctx.targetId !== pid) return false;
    room.afkRescue = null;
    if (!room.humanActivityAt) room.humanActivityAt = {};
    room.humanActivityAt[pid] = now;
    if (room.status !== 'voting' && room.status !== 'person_voting') room.turnStartTime = now;
    return true;
  };

  Engine.finishAfkTakeover = function (room, targetId, actionKey, now = Date.now()) {
    const rescue = room && room.afkRescue, ctx = Engine.afkContext(room);
    if (!rescue || !ctx || rescue.targetId !== targetId || rescue.actionKey !== actionKey ||
        ctx.targetId !== targetId || ctx.actionKey !== actionKey || now < Number(rescue.deadlineAt || Infinity)) return false;
    const changed = Engine.replaceWithBot(room, targetId);
    if (changed) room.turnStartTime = now;
    return changed;
  };

  const freeColor = room => {
    const used = new Set(room.players.map(p => p.colorId));
    return (GD.SEAL_COLORS.find(c => !used.has(c.id)) || GD.SEAL_COLORS[0]).id;
  };
  const freeSeat = room => {
    const used = new Set(room.players.map(p => p.seatIndex));
    for (let i = 0; i < 8; i++) if (!used.has(i)) return i;
    return room.players.length;
  };

  function migratePlayerNameInRoom(room, id, newName) {
    if (!room || !id || !newName) return;
    (room.rounds || []).forEach(rd => {
      (rd.speeches || []).forEach(sp => {
        if (sp && sp.playerId === id) sp.speakerName = newName;
      });
      const chips = rd.voteResults && rd.voteResults.chips;
      if (chips) Object.values(chips).forEach(arr => (arr || []).forEach(chip => {
        if (chip && chip.voterId === id) chip.voterName = newName;
      }));
    });
  }

  Engine.reclaimPlayer = function (room, oldId, newId, name) {
    const cleanName = String(name || '掌眼人').trim();
    const target = room.players.find(p => p.id === oldId);
    if (!target) return false;
    const oldName = String(target.name || '');
    if (room.status === 'waiting') {
      for (let i = room.players.length - 1; i >= 0; i--) {
        const p = room.players[i];
        if (p !== target && !p.isBot && String(p.name).trim() === cleanName) {
          room.players.splice(i, 1);
        }
      }
    }
    target.name = cleanName;
    if (oldId !== newId) {
      target.id = newId;
      migratePlayerIdInRoom(room, oldId, newId, cleanName);
    } else if (oldName !== cleanName) {
      // 名稱變更但 ID 不變時，同步可解析的顯示欄位；歷史 sp.text 保留原句，不擅自改寫。
      migratePlayerNameInRoom(room, oldId, cleanName);
    }
    if (room.spectators) {
      room.spectators = room.spectators.filter(s => s.id !== newId && s.id !== oldId && s.name !== cleanName);
    }
    return true;
  };

  Engine.addPlayer = function (room, { id, name, isBot = false, botId = null }) {
    const cleanName = String(name || '掌眼人').trim();
    const old = room.players.find(p => p.id === id) ||
                (!isBot ? room.players.find(p => !p.isBot && String(p.name).trim() === cleanName) : null);
    if (old) {
      Engine.reclaimPlayer(room, old.id, id, cleanName);
      return old;
    }
    if (room.status !== 'waiting' && room.status !== 'gameover') return null;
    if (room.players.length >= 8) {
      const bot = room.players.find(p => p.isBot);
      if (isBot || !bot) return null;
      room.players.splice(room.players.indexOf(bot), 1);
    }
    const p = {
      id, name: cleanName, isBot, botId, colorId: freeColor(room), seatIndex: freeSeat(room),
      role: '', voteBank: 0, isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false, pendingAmbushTiming: null, pendingAmbushSourceRound: null, pendingImmediateAmbush: false, pendingImmediateAmbushTiming: null, pendingImmediateAmbushSourceRound: null, pendingPermanentAmbush: false, activeAmbushTiming: null, activeAmbushSourceRound: null, confusedRound: -1
    };
    room.players.push(p);
    return p;
  };

  Engine.fillBots = function (room) {
    const used = new Set(room.players.map(p => p.name));
    const pool = U.shuffle(GD.Roster.list.filter(b => !used.has(b.name)));
    while (room.players.length < 8 && pool.length) {
      const b = pool.pop();
      Engine.addPlayer(room, { id: U.uid('bot_' + b.id), name: b.name, isBot: true, botId: b.id });
    }
    return room.players.length === 8;
  };

  Engine.setColor = function (room, pid, colorId) {
    const me = U.byId(room, pid);
    if (!me || room.status !== 'waiting') return false;
    const other = room.players.find(p => p.colorId === colorId && p.id !== pid);
    if (other && !other.isBot) return false;
    if (other) other.colorId = me.colorId;
    me.colorId = colorId;
    return true;
  };

  Engine.shiftSeat = function (room, pid, delta) {
    const me = U.byId(room, pid);
    if (!me || room.status !== 'waiting' || room.players.length < 2) return false;
    const n = room.players.length;
    const sorted = U.seated(room);
    sorted.forEach((p, i) => { p.seatIndex = i; });
    const target = (me.seatIndex + delta + n) % n;
    const other = sorted.find(p => p.seatIndex === target);
    if (other) other.seatIndex = me.seatIndex;
    me.seatIndex = target;
    return true;
  };

  Engine.kickPlayer = function (room, pid, targetId) {
    const target = U.byId(room, targetId);
    if (!target) return false;
    if (room.status === 'waiting' || room.status === 'gameover') {
      const idx = room.players.findIndex(p => p.id === targetId);
      if (idx < 0) return false;
      room.players.splice(idx, 1);
      U.seated(room).forEach((p, i) => { p.seatIndex = i; });
      if (room.hostId === targetId) {
        const nextHost = room.players.find(p => !p.isBot) || room.players[0];
        room.hostId = nextHost ? nextHost.id : null;
      }
      return true;
    }
    if (!target.isBot) {
      return Engine.replaceWithBot(room, targetId);
    }
    return false;
  };

  Engine.replaceWithBot = function (room, pid) {
    const p = U.byId(room, pid);
    if (!p || p.isBot) return false;
    const used = new Set(room.players.map(x => x.name));
    const pool = GD.Roster.list.filter(b => !used.has(b.name));
    const botDef = pool.length ? U.pick(pool) : GD.Roster.list[0];

    if (!room.spectators) room.spectators = [];
    if (!room.spectators.some(s => s.id === p.id)) room.spectators.push({ id: p.id, name: p.name });

    const oldId = p.id;
    if (room.afkRescue && room.afkRescue.targetId === oldId) room.afkRescue = null;
    if (room.humanActivityAt) delete room.humanActivityAt[oldId];
    const newId = U.uid('bot_' + botDef.id);

    p.id = newId; p.name = botDef.name; p.isBot = true; p.botId = botDef.id;
    if (GD.Genes) p.genes = GD.Genes.load(p.botId);

    if (room.hostId === oldId) {
      const nextHuman = room.players.find(x => !x.isBot && x.id !== newId) || (room.spectators && room.spectators[0]);
      if (nextHuman) room.hostId = nextHuman.id;
    }
    migratePlayerIdInRoom(room, oldId, newId, p.name);
    return true;
  };

  Engine.drawRound = function (room, roundNum) {
    if (!room.plan || !room.plan.rounds || !room.plan.rounds[roundNum - 1]) {
        if (!room.deck || room.deck.length < 4) room.deck = [...GD.ZODIAC];
        const deck = U.shuffle(room.deck);
        const names = deck.slice(0, 4);
        room.deck = deck.slice(4);
        const flags = U.shuffle([true, true, false, false]);
        const beasts = names.map((name, i) => ({ name, isReal: flags[i] })).sort((a, b) => GD.ZODIAC.indexOf(a.name) - GD.ZODIAC.indexOf(b.name));
        return { roundNum, beasts, passOrder: [], turnLogs: {}, laoActive: false, blockedBeast: null, speechOrder: [], speechIndex: 0, speeches: [], votes: {}, voteResults: null, mind: {} };
    }
    const plannedRound = room.plan.rounds[roundNum - 1];
    return {
      roundNum, beasts: JSON.parse(JSON.stringify(plannedRound.beasts)), passOrder: [], turnLogs: {}, laoActive: false, blockedBeast: null,
      speechOrder: [], speechIndex: 0, speeches: [], votes: {}, voteResults: null, mind: {}
    };
  };

  Engine.start = function (room) {
    if (room.players.length !== 8 || (room.status !== 'waiting' && room.status !== 'gameover')) return false;
    U.seated(room).forEach((p, i) => { p.seatIndex = i; });
    
    const deck = U.shuffle([...GD.ZODIAC]);
    const roundPlans = [];
    let currentDeck = deck;
    for (let i = 0; i < 3; i++) {
        const names = currentDeck.slice(0, 4);
        currentDeck = currentDeck.slice(4);
        const flags = U.shuffle([true, true, false, false]);
        const beasts = names.map((name, j) => ({ name, isReal: flags[j] })).sort((a, b) => GD.ZODIAC.indexOf(a.name) - GD.ZODIAC.indexOf(b.name));
        roundPlans.push({ beasts });
    }
    
    const roles = U.shuffle(GD.ROLE_ORDER);
    const starter = U.pick(room.players);
    room.plan = { rounds: roundPlans, starterId: starter.id };
    
    room.players.forEach((p, i) => {
      p.role = roles[i];
      p.voteBank = C.CHIPS_PER_ROUND;
      p.isAmbushed = p.isPermanentlyAmbushed = p.pendingAmbush = p.pendingImmediateAmbush = p.pendingPermanentAmbush = false;
      p.pendingAmbushTiming = p.pendingAmbushSourceRound = p.pendingImmediateAmbushTiming = p.pendingImmediateAmbushSourceRound = p.activeAmbushTiming = p.activeAmbushSourceRound = null;
      p.confusedRound = (p.role === '黃煙煙' || p.role === '木戶加奈') ? Math.floor(U.rng() * 3) : -1;
      p.genes = p.isBot && GD.Genes ? GD.Genes.load(p.botId) : undefined;
    });

    room.gameId = U.uid('g');
    const now = Date.now();
    room.startedAt = now;
    room.turnStartTime = now;
    
    const r1 = Engine.drawRound(room, 1);
    r1.passOrder = [room.plan.starterId];
    room.rounds = [r1];
    room.currentRoundIdx = 0;
    room.currentTurnPlayerId = room.plan.starterId;
    room.currentSpeakerId = null;
    room.personVotes = {};
    room.humanActivityAt = {}; room.afkRescue = null;
    room.gameOver = null;
    room.learning = null;
    room.status = 'playing';
    return true;
  };

  function ensureInPassOrder(rd, pid) {
    if (!Array.isArray(rd.passOrder)) rd.passOrder = [];
    if (pid && !rd.passOrder.includes(pid)) rd.passOrder.push(pid);
  }

  Engine.fangCheckedIds = function (room, pid) {
    const done = new Set();
    (room.rounds || []).forEach(r => {
      const l = r && r.turnLogs && r.turnLogs[pid];
      if (l && l.fangTargetId) done.add(l.fangTargetId);
    });
    return done;
  };

  function activateAmbushForTurn(room, player) {
    if (!player || (!player.pendingImmediateAmbush && !player.pendingAmbush && !player.pendingPermanentAmbush)) return false;
    const wasDeferred = !!player.pendingAmbush || player.pendingImmediateAmbushTiming === 'deferred';
    player.isAmbushed = true;
    if (player.pendingPermanentAmbush) player.isPermanentlyAmbushed = true;
    player.activeAmbushTiming = wasDeferred ? 'deferred' : (player.pendingImmediateAmbushTiming || 'immediate');
    player.activeAmbushSourceRound = player.pendingAmbushSourceRound || player.pendingImmediateAmbushSourceRound || null;
    player.pendingAmbush = false;
    player.pendingAmbushTiming = null;
    player.pendingAmbushSourceRound = null;
    player.pendingImmediateAmbush = false;
    player.pendingImmediateAmbushTiming = null;
    player.pendingImmediateAmbushSourceRound = null;
    player.pendingPermanentAmbush = false;
    // 若該玩家的 turn log 已被 UI／重連流程預先建立，必須同步更新，否則策略讀到舊的 blind=false/null。
    const rd = U.curRound(room);
    const existingLog = rd && rd.turnLogs && rd.turnLogs[player.id];
    if (existingLog) {
      existingLog.blind = true;
      existingLog.blindTiming = player.activeAmbushTiming;
      existingLog.blindSourceRound = player.activeAmbushSourceRound;
    }
    return true;
  }

  Engine.log = function (room, pid) {
    const rd = U.curRound(room);
    const p = U.byId(room, pid);
    // 防舊存檔／重連：只在目標真的成為當前行動者時啟動排程，絕不在偷襲者選定目標時曝光。
    if (room.status === 'playing' && room.currentTurnPlayerId === pid) {
      activateAmbushForTurn(room, p);
      ensureInPassOrder(rd, pid);
    }
    if (!rd.turnLogs[pid]) {
      rd.turnLogs[pid] = {
        inspect: [], ability: '無技能操作', skillTag: '', blind: Rules.isBlind(p),
        blindTiming: p && p.activeAmbushTiming || null,
        blindSourceRound: p && p.activeAmbushSourceRound || null,
        step: Rules.inspectQuota(p) === 0 ? 'b' : 'a'
      };
    }
    return rd.turnLogs[pid];
  };

  const myTurn = (room, pid, step) =>
    room.status === 'playing' && room.currentTurnPlayerId === pid && Engine.log(room, pid).step === step;

  Engine.inspect = function (room, pid, beastName) {
    if (!myTurn(room, pid, 'a')) return false;
    const rd = U.curRound(room), p = U.byId(room, pid), log = Engine.log(room, pid);
    ensureInPassOrder(rd, pid);
    const beast = rd.beasts.find(b => b.name === beastName);
    if (!beast || log.inspect.some(x => x.beastName === beastName)) return false;
    if (log.inspect.length >= Rules.inspectQuota(p)) return false;
    const res = Rules.inspect(beast, p, rd, room.currentRoundIdx);
    log.inspect.push(res);
    room.afkRescue = null;
    room.turnStartTime = Date.now();
    if (log.inspect.length >= Rules.inspectQuota(p)) log.step = 'b';
    return res;
  };

  Engine.skill = function (room, pid, action) {
    if (!myTurn(room, pid, 'b')) return false;
    const rd = U.curRound(room), p = U.byId(room, pid), log = Engine.log(room, pid);
    ensureInPassOrder(rd, pid);
    const done = () => { log.step = 'c'; room.afkRescue = null; room.turnStartTime = Date.now(); return true; };
    if (!action || action.kind === 'skip') return done();
    if (Rules.isBlind(p)) { log.ability = '技能被偷襲封鎖'; return done(); }

    const target = action.targetId ? U.byId(room, action.targetId) : null;
    switch (action.kind) {
      case 'fang': {
        if (p.role !== '方震' || !target || target.id === pid) return false;
        const alreadyChecked = Engine.fangCheckedIds(room, pid);
        if (alreadyChecked.has(target.id)) return false;
        log.fangTargetId = target.id;
        log.fangCamp = GD.isGood(target.role) ? 'good' : 'evil';
        const thumb = log.fangCamp === 'good' ? '👍' : '👎';
        log.ability = `查驗【${target.name}】陣營為：${log.fangCamp === 'good' ? '許願陣營（好人）' : '老朝奉陣營（壞人）'}`;
        log.skillTag = `🔍${target.name.slice(0, 2)}${thumb}`;
        break;
      }
      case 'lao':
        if (p.role !== '老朝奉') return false;
        if (action.active) { rd.laoActive = true; log.ability = '發動【擾亂】（其後好人查驗真偽反轉）'; log.skillTag = '🎭擾亂'; }
        break;
      case 'yao':
        if (p.role !== '藥不然' || !target || target.id === pid) return false;
        log.ambushIds = Rules.applyAmbush(room, target);
        log.ambushTargetId = target.id;
        log.ability = `暗中偷襲【${target.name}】`;
        log.skillTag = `🗡️襲${target.name.slice(0, 2)}`;
        break;
      case 'zheng':
        if (p.role !== '鄭國渠' || !rd.beasts.some(b => b.name === action.beast)) return false;
        rd.blockedBeast = action.beast;
        log.ability = `封鎖【${action.beast}】首`;
        log.skillTag = `⛓️封${action.beast}`;
        break;
      default: return false;
    }
    return done();
  };

  Engine.pass = function (room, pid, nextId) {
    if (!myTurn(room, pid, 'c')) return false;
    const rd = U.curRound(room), p = U.byId(room, pid), log = Engine.log(room, pid);
    ensureInPassOrder(rd, pid);
    room.players.forEach(pl => {
      if (rd.turnLogs[pl.id] && rd.turnLogs[pl.id].step === 'c' && !rd.passOrder.includes(pl.id)) {
        rd.passOrder.splice(Math.max(0, rd.passOrder.length - 1), 0, pl.id);
      }
    });
    const remaining = room.players.filter(x => !rd.passOrder.includes(x.id));
    if (remaining.length > 0) {
      const actualNextId = (remaining.length === 1 && !nextId) ? remaining[0].id : nextId;
      if (!remaining.some(x => x.id === actualNextId)) return false;
      room.afkRescue = null;
      rd.passOrder.push(actualNextId);
      log.nextPlayerId = actualNextId;
      room.currentTurnPlayerId = actualNextId;
      // 受襲者只有在真正接到手機、成為 currentTurnPlayerId 後，才看到致盲狀態。
      activateAmbushForTurn(room, U.byId(room, actualNextId));
      room.turnStartTime = Date.now();
    } else {
      room.afkRescue = null;
      startDiscussion(room, rd, pid);
    }
    p.isAmbushed = false;
    return true;
  };

  function startDiscussion(room, rd, tailId) {
    const seats = U.seated(room);
    const actualTailId = (rd.passOrder && rd.passOrder.length) ? rd.passOrder[rd.passOrder.length - 1] : tailId;
    const t = Math.max(0, seats.findIndex(p => p.id === actualTailId));
    rd.speechOrder = Array.from({ length: seats.length }, (_, i) => seats[(t + 1 + i) % seats.length].id);
    rd.speechIndex = 0;
    room.currentSpeakerId = rd.speechOrder[0];
    room.currentTurnPlayerId = null;
    room.turnStartTime = Date.now();
    room.afkRescue = null;
    room.status = 'discussion';
  }

  Engine.speak = function (room, pid, { text, source = 'human', summary = null, pass = false }) {
    if (room.status !== 'discussion' || room.currentSpeakerId !== pid) return false;
    const rd = U.curRound(room), p = U.byId(room, pid);
    const body = pass ? '（過，先聽後面的人分析）' : String(text || '').trim();
    if (!body) return false;
    const parsed = pass ? Claims.parse('', room, rd, pid) : Claims.parse(body, room, rd, pid);
    const isHuman = p ? !p.isBot : (source === 'human');
    const normalizedSource = isHuman ? 'human' : (source === 'human' ? 'bot' : source);
    const label = isHuman ? '[真人]' : '[AI]';
    rd.speeches.push({
      playerId: pid, speakerName: p.name, colorId: p.colorId, text: body, source: normalizedSource,
      summary: pass ? `${label} 選擇先過` : (summary || Claims.summarize(parsed, label, room, body)),
      p: parsed, 
      time: ''
    });
    room.afkRescue = null;
    room.turnStartTime = Date.now();
    rd.speechIndex++;
    if (p && !p.isBot) {
      if (!room.humanActivityAt) room.humanActivityAt = {};
      room.humanActivityAt[pid] = Date.now();
    }
    if (rd.speechIndex >= rd.speechOrder.length) {
      room.status = 'voting'; room.currentSpeakerId = null;
      const phaseStartedAt = Date.now();
      if (!room.humanActivityAt) room.humanActivityAt = {};
      (room.players || []).forEach(player => {
        if (player && !player.isBot && rd.votes[player.id] === undefined) room.humanActivityAt[player.id] = phaseStartedAt;
      });
      room.turnStartTime = phaseStartedAt;
    } else {
      room.currentSpeakerId = rd.speechOrder[rd.speechIndex];
      room.turnStartTime = Date.now();
    }
    return true;
  };

  Engine.availableChips = function (room, pid) {
    const rIdx = room.currentRoundIdx || 0;
    const totalGranted = (rIdx + 1) * (C.CHIPS_PER_ROUND || 2);
    let spentBefore = 0;
    for (let i = 0; i < rIdx; i++) {
      const prevVotes = (room.rounds[i] && room.rounds[i].votes && room.rounds[i].votes[pid]) || {};
      spentBefore += U.sum(Object.values(prevVotes).map(v => parseInt(v, 10) || 0));
    }
    return Math.max(0, totalGranted - spentBefore);
  };

  Engine.vote = function (room, pid, ballot) {
    if (room.status !== 'voting') return false;
    const rd = U.curRound(room), p = U.byId(room, pid);
    if (!p || rd.voteResults) return false;

    const existing = rd.votes[pid];
    const existingSum = existing ? U.sum(Object.values(existing).map(v => parseInt(v, 10) || 0)) : 0;
    const incomingSum = U.sum(Object.values(ballot || {}).map(v => parseInt(v, 10) || 0));
    if (existing !== undefined && existingSum > 0 && incomingSum === 0) return false;
    if (existing !== undefined && existingSum > 0 && incomingSum > 0) return false;

    const clean = {};
    let spend = 0;
    for (const [name, raw] of Object.entries(ballot || {})) {
      const n = parseInt(raw, 10) || 0;
      if (n <= 0) continue;
      if (!rd.beasts.some(b => b.name === name)) return false;
      clean[name] = n;
      spend += n;
    }

    const maxChips = Engine.availableChips(room, pid);
    if (spend > maxChips) return false;

    // Keep public statement, personal commitment, actual ballot and abstention as separate facts.
    // This is an audit trail only: it never forces the ballot to match the speech.
    const speech = [...(rd.speeches || [])].reverse().find(item => item && String(item.playerId) === String(pid));
    let parsedSpeech = {};
    try { parsedSpeech = speech ? Claims.parseRecord(speech, room, rd) : {}; } catch (_) {}
    const commitments = Array.isArray(parsedSpeech.voteCommitments) ? parsedSpeech.voteCommitments : [];
    const publicCalls = [...new Set([...(parsedSpeech.callBeasts || []), parsedSpeech.callBeast].filter(Boolean))];
    const promised = commitments.filter(item => item && item.binding !== false).map(item => ({ beast: item.beast, chips: Number(item.chips) || null, text: item.text || '', binding: true, kind: item.kind || 'explicit' }));
    const softIntents = Array.isArray(parsedSpeech.voteIntents) ? parsedSpeech.voteIntents.map(item => ({ beast: item.beast, binding: false, kind: item.kind || 'soft-intent', intensity: Number(item.intensity) || 0 })) : [];
    const fulfilled = promised.map(item => ({
      ...item,
      actualChips: Number(clean[item.beast]) || 0,
      honored: (Number(clean[item.beast]) || 0) > 0,
      fulfilledChips: item.chips == null ? ((Number(clean[item.beast]) || 0) > 0 ? null : 0)
        : Math.min(item.chips, Number(clean[item.beast]) || 0)
    }));
    if (!rd.voteAudit) rd.voteAudit = {};
    rd.voteAudit[pid] = {
      publicCalls, commitments: promised, softIntents, commitmentResults: fulfilled,
      actualBallot: { ...clean }, totalSpent: spend, abstained: spend === 0,
      abstentionReason: spend === 0 ? (parsedSpeech.abstentionReason || null) : null,
      recordedAt: Date.now()
    };
    rd.votes[pid] = clean;
    p.voteBank = maxChips - spend;
    if (!room.humanActivityAt) room.humanActivityAt = {};
    if (!p.isBot) room.humanActivityAt[pid] = Date.now();
    if (room.afkRescue && room.afkRescue.targetId === pid) room.afkRescue = null;

    if (room.players.length === 8 && room.players.every(x => rd.votes[x.id] !== undefined)) {
      rd.voteResults = Rules.tally(room, rd);
      room.turnStartTime = Date.now();
    }
    return true;
  };

  Engine.advance = function (room) {
    if (room.status !== 'voting' || !U.curRound(room).voteResults) return false;
    const idx = room.currentRoundIdx, rd = U.curRound(room);
    room.afkRescue = null;
    if (idx >= 2) {
      room.status = 'person_voting';
      const phaseStartedAt = Date.now();
      if (!room.humanActivityAt) room.humanActivityAt = {};
      (room.players || []).forEach(player => {
        if (player && !player.isBot && !(room.personVotes || {})[player.id]) room.humanActivityAt[player.id] = phaseStartedAt;
      });
      room.turnStartTime = phaseStartedAt;
      return true;
    }
    const tail = rd.passOrder[rd.passOrder.length - 1] || room.players[0].id;
    const next = Engine.drawRound(room, idx + 2);
    next.passOrder = [tail];
    room.rounds.push(next);
    room.players.forEach(p => {
      const prevAvail = Engine.availableChips(room, p.id);
      const curBallot = rd.votes[p.id] || {};
      const curSpent = U.sum(Object.values(curBallot).map(v => parseInt(v, 10) || 0));
      p.voteBank = Math.max(0, prevAvail - curSpent) + C.CHIPS_PER_ROUND;
      // 已行動者的延遲偷襲只移入下一輪待啟動佇列；不在整輪開始時提早通知受害者。
      p.isAmbushed = false;
      if (p.pendingAmbush) {
        p.pendingImmediateAmbush = true;
        p.pendingImmediateAmbushTiming = p.pendingAmbushTiming || 'deferred';
        p.pendingImmediateAmbushSourceRound = p.pendingAmbushSourceRound || idx + 1;
      }
      p.pendingAmbush = false;
      p.pendingAmbushTiming = null;
      p.pendingAmbushSourceRound = null;
    });
    room.currentRoundIdx = idx + 1;
    room.humanActivityAt = room.humanActivityAt || {};
    room.afkRescue = null;
    room.currentTurnPlayerId = tail;
    activateAmbushForTurn(room, U.byId(room, tail));
    room.turnStartTime = Date.now();
    room.status = 'playing';
    return true;
  };

  Engine.personVote = function (room, pid, targetId) {
    if (room.status !== 'person_voting' || pid === targetId) return false;
    const p = U.byId(room, pid);
    if (!p || !U.byId(room, targetId) || room.personVotes[pid]) return false;
    room.personVotes[pid] = targetId;
    if (!room.humanActivityAt) room.humanActivityAt = {};
    if (!p.isBot) room.humanActivityAt[pid] = Date.now();
    if (room.afkRescue && room.afkRescue.targetId === pid) room.afkRescue = null;
    if (room.players.length === 8 && room.players.every(x => room.personVotes[x.id])) {
      room.gameOver = Rules.score(room);
      room.status = 'gameover';
      room.turnStartTime = Date.now();
    }
    return true;
  };

  Engine.remainingToAct = room => room.players.filter(p => !U.curRound(room).passOrder.includes(p.id));
  Engine.humans = room => room.players.filter(p => !p.isBot);

  GD.Engine = Engine;
})(window.GD || (window.GD = {}));