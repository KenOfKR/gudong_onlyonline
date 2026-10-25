/* ============================================================================
 * core/engine.js — 遊戲狀態機（預抽計畫版，拔除時間與亂數污染）
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Rules, Claims } = GD;
  const C = GD.CONFIG;
  const Engine = {};

  function migratePlayerIdInRoom(room, oldId, newId, newName) {
    if (!oldId || !newId || oldId === newId) return;
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
    return {
      v: 9, roomId: code, hostId: hostId || null, hostBeat: 0,
      gameId: null, status: 'waiting', closed: false,
      currentRoundIdx: 0, currentTurnPlayerId: null, currentSpeakerId: null,
      turnStartTime: 0, deck: [...GD.ZODIAC], players: [], spectators: [], rounds: [], personVotes: {},
      gameOver: null, learning: null, plan: null, rev: 0, createdAt: 0, updatedAt: 0
    };
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

  Engine.reclaimPlayer = function (room, oldId, newId, name) {
    const cleanName = String(name || '掌眼人').trim();
    const target = room.players.find(p => p.id === oldId);
    if (!target) return false;
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
      role: '', voteBank: 0, isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false, confusedRound: -1
    };
    room.players.push(p);
    return p;
  };

  Engine.fillBots = function (room) {
    const used = new Set(room.players.map(p => p.name));
    // 改用 U.shuffle 與 U.uid（受發牌流 rng 控制）
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
    // 注意：因已進入對局，此處 pick 不受發牌流嚴格限制，但基準對局無真人斷線，故不影響 A/A。
    const botDef = pool.length ? U.pick(pool) : GD.Roster.list[0];

    if (!room.spectators) room.spectators = [];
    if (!room.spectators.some(s => s.id === p.id)) room.spectators.push({ id: p.id, name: p.name });

    const oldId = p.id;
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

  /* ★ 新增：從 room.plan 中抽離真偽與首家，不依賴後續抽牌時機消耗亂數 */
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
    // 從開局已產生的 plan 提取
    const plannedRound = room.plan.rounds[roundNum - 1];
    return {
      roundNum, beasts: JSON.parse(JSON.stringify(plannedRound.beasts)), passOrder: [], turnLogs: {}, laoActive: false, blockedBeast: null,
      speechOrder: [], speechIndex: 0, speeches: [], votes: {}, voteResults: null, mind: {}
    };
  };

  /* ★ 修改：Engine.start 階段一次抽完所有全域亂數（角色、獸首、首家、困惑回合），存入 room.plan */
  Engine.start = function (room) {
    if (room.players.length !== 8 || (room.status !== 'waiting' && room.status !== 'gameover')) return false;
    U.seated(room).forEach((p, i) => { p.seatIndex = i; });
    
    // 一次性抽好三回合獸首並凍結順序
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
      p.isAmbushed = p.isPermanentlyAmbushed = p.pendingAmbush = false;
      p.confusedRound = (p.role === '黃煙煙' || p.role === '木戶加奈') ? Math.floor(U.rng() * 3) : -1;
      p.genes = p.isBot && GD.Genes ? GD.Genes.load(p.botId) : undefined;
    });

    room.gameId = U.uid('g');
    // 拔除實際時間賦值，改塞 0，避免影響 A/A 校驗
    room.startedAt = 0; 
    room.turnStartTime = 0;
    
    const r1 = Engine.drawRound(room, 1);
    r1.passOrder = [room.plan.starterId];
    room.rounds = [r1];
    room.currentRoundIdx = 0;
    room.currentTurnPlayerId = room.plan.starterId;
    room.currentSpeakerId = null;
    room.personVotes = {};
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

  Engine.log = function (room, pid) {
    const rd = U.curRound(room);
    const p = U.byId(room, pid);
    if (room.status === 'playing' && room.currentTurnPlayerId === pid) ensureInPassOrder(rd, pid);
    if (!rd.turnLogs[pid]) {
      rd.turnLogs[pid] = { inspect: [], ability: '無技能操作', skillTag: '', blind: Rules.isBlind(p), step: Rules.inspectQuota(p) === 0 ? 'b' : 'a' };
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
    if (log.inspect.length >= Rules.inspectQuota(p)) log.step = 'b';
    return res;
  };

  Engine.skill = function (room, pid, action) {
    if (!myTurn(room, pid, 'b')) return false;
    const rd = U.curRound(room), p = U.byId(room, pid), log = Engine.log(room, pid);
    ensureInPassOrder(rd, pid);
    const done = () => { log.step = 'c'; return true; };
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
      rd.passOrder.push(actualNextId);
      log.nextPlayerId = actualNextId;
      room.currentTurnPlayerId = actualNextId;
    } else {
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
    room.status = 'discussion';
  }

  Engine.speak = function (room, pid, { text, source = 'human', summary = null, pass = false }) {
    if (room.status !== 'discussion' || room.currentSpeakerId !== pid) return false;
    const rd = U.curRound(room), p = U.byId(room, pid);
    const body = pass ? '（過，先聽後面的人分析）' : String(text || '').trim();
    if (!body) return false;
    const parsed = pass ? Claims.parse('', room) : Claims.parse(body, room);
    const isHuman = p ? !p.isBot : (source === 'human');
    const label = isHuman ? '[真人]' : '[AI]';
    rd.speeches.push({
      playerId: pid, speakerName: p.name, colorId: p.colorId, text: body, source: isHuman ? 'human' : source,
      summary: pass ? `${label} 選擇先過` : (summary || Claims.summarize(parsed, label, room, body)),
      p: parsed, 
      // 拔除 Date 以免污染 JSON，填入固定的空字串
      time: ''
    });
    rd.speechIndex++;
    if (rd.speechIndex >= rd.speechOrder.length) { room.status = 'voting'; room.currentSpeakerId = null; }
    else room.currentSpeakerId = rd.speechOrder[rd.speechIndex];
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

    rd.votes[pid] = clean;
    p.voteBank = maxChips - spend;

    if (room.players.length === 8 && room.players.every(x => rd.votes[x.id] !== undefined)) {
      rd.voteResults = Rules.tally(room, rd);
    }
    return true;
  };

  Engine.advance = function (room) {
    if (room.status !== 'voting' || !U.curRound(room).voteResults) return false;
    const idx = room.currentRoundIdx, rd = U.curRound(room);
    if (idx >= 2) { room.status = 'person_voting'; return true; }
    const tail = rd.passOrder[rd.passOrder.length - 1] || room.players[0].id;
    const next = Engine.drawRound(room, idx + 2);
    next.passOrder = [tail];
    room.rounds.push(next);
    room.players.forEach(p => {
      const prevAvail = Engine.availableChips(room, p.id);
      const curBallot = rd.votes[p.id] || {};
      const curSpent = U.sum(Object.values(curBallot).map(v => parseInt(v, 10) || 0));
      p.voteBank = Math.max(0, prevAvail - curSpent) + C.CHIPS_PER_ROUND;
      p.isAmbushed = !!p.pendingAmbush;
      p.pendingAmbush = false;
    });
    room.currentRoundIdx = idx + 1;
    room.currentTurnPlayerId = tail;
    room.status = 'playing';
    return true;
  };

  Engine.personVote = function (room, pid, targetId) {
    if (room.status !== 'person_voting' || pid === targetId) return false;
    const p = U.byId(room, pid);
    if (!p || !U.byId(room, targetId) || room.personVotes[pid]) return false;
    room.personVotes[pid] = targetId;
    if (room.players.length === 8 && room.players.every(x => room.personVotes[x.id])) {
      room.gameOver = Rules.score(room);
      room.status = 'gameover';
    }
    return true;
  };

  Engine.remainingToAct = room => room.players.filter(p => !U.curRound(room).passOrder.includes(p.id));
  Engine.humans = room => room.players.filter(p => !p.isBot);

  GD.Engine = Engine;
})(window.GD || (window.GD = {}));