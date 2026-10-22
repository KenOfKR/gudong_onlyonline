/* ============================================================================
 * core/engine.js — 遊戲狀態機
 *
 * 所有動作都是「對 room 物件的就地修改函式」：
 *   - 成功回傳 true（或結果物件），不合法回傳 false 且不改動 room
 *   - 不碰 DOM、不碰網路；Net.act(fn) 負責把它包進交易 / 存檔 / 廣播
 *   - 真人與電腦玩家走完全相同的動作，沒有任何一邊的捷徑
 *
 * status 流程：waiting → playing → discussion → voting → (下一回合) ... → person_voting → gameover
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Rules, Claims } = GD;
  const C = GD.CONFIG;

  const Engine = {};

  /* ---------------------------------------------------------------- 建房 / 入座 */

  Engine.newRoom = function (code, hostId) {
    return {
      v: 9, roomId: code, hostId: hostId || null, hostBeat: Date.now(),
      gameId: null, status: 'waiting', closed: false,
      currentRoundIdx: 0, currentTurnPlayerId: null, currentSpeakerId: null,
      deck: [...GD.ZODIAC], players: [], rounds: [], personVotes: {},
      gameOver: null, learning: null,
      rev: 0, createdAt: Date.now(), updatedAt: Date.now()
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

  Engine.addPlayer = function (room, { id, name, isBot = false, botId = null }) {
    const old = room.players.find(p => p.id === id);
    if (old) { old.name = name; return old; }
    if (room.status !== 'waiting' && room.status !== 'gameover') return null;
    if (room.players.length >= 8) {
      const bot = room.players.find(p => p.isBot);          // 滿座時真人可擠掉一位電腦
      if (isBot || !bot) return null;
      room.players.splice(room.players.indexOf(bot), 1);
    }
    const p = {
      id, name, isBot, botId, colorId: freeColor(room), seatIndex: freeSeat(room),
      role: '', voteBank: 0, isAmbushed: false, isPermanentlyAmbushed: false, pendingAmbush: false, confusedRound: -1
    };
    room.players.push(p);
    return p;
  };

  Engine.fillBots = function (room) {
    const used = new Set(room.players.map(p => p.name));
    const pool = U.shuffle(GD.Roster.list.filter(b => !used.has(b.name)));
    while (room.players.length < 8 && pool.length) {
      const b = pool.pop();
      Engine.addPlayer(room, { id: `bot_${b.id}_${Math.random().toString(36).slice(2, 5)}`, name: b.name, isBot: true, botId: b.id });
    }
    return room.players.length === 8;
  };

  Engine.setColor = function (room, pid, colorId) {
    const me = U.byId(room, pid);
    if (!me || room.status !== 'waiting') return false;
    const other = room.players.find(p => p.colorId === colorId && p.id !== pid);
    if (other && !other.isBot) return false;
    if (other) other.colorId = me.colorId;                   // 與電腦互換顏色
    me.colorId = colorId;
    return true;
  };

  Engine.shiftSeat = function (room, pid, delta) {
    const me = U.byId(room, pid);
    if (!me || room.status !== 'waiting' || room.players.length < 2) return false;
    const n = room.players.length;
    const sorted = U.seated(room);
    sorted.forEach((p, i) => { p.seatIndex = i; });          // 先壓成連續座位
    const target = (me.seatIndex + delta + n) % n;
    const other = sorted.find(p => p.seatIndex === target);
    if (other) other.seatIndex = me.seatIndex;
    me.seatIndex = target;
    return true;
  };

  /* ---------------------------------------------------------------- 開局 / 抽獸首 */

  Engine.drawRound = function (room, roundNum) {
    if (!room.deck || room.deck.length < 4) room.deck = [...GD.ZODIAC];
    const deck = U.shuffle(room.deck);
    const names = deck.slice(0, 4);
    room.deck = deck.slice(4);
    const flags = U.shuffle([true, true, false, false]);
    const beasts = names.map((name, i) => ({ name, isReal: flags[i] }))
      .sort((a, b) => GD.ZODIAC.indexOf(a.name) - GD.ZODIAC.indexOf(b.name));
    return {
      roundNum, beasts, passOrder: [], turnLogs: {}, laoActive: false, blockedBeast: null,
      speechOrder: [], speechIndex: 0, speeches: [], votes: {}, voteResults: null, mind: {}
    };
  };

  Engine.start = function (room) {
    if (room.players.length !== 8 || (room.status !== 'waiting' && room.status !== 'gameover')) return false;
    U.seated(room).forEach((p, i) => { p.seatIndex = i; });
    const roles = U.shuffle(GD.ROLE_ORDER);
    room.players.forEach((p, i) => {
      p.role = roles[i];
      p.voteBank = C.CHIPS_PER_ROUND;
      p.isAmbushed = p.isPermanentlyAmbushed = p.pendingAmbush = false;
      p.confusedRound = (p.role === '黃煙煙' || p.role === '木戶加奈') ? Math.floor(Math.random() * 3) : -1;
      // 電腦玩家：開局時鎖定本局基因（含上一局學到的修正），終局覆盤才能顯示「進化前後」
      p.genes = p.isBot && GD.Genes ? GD.Genes.load(p.botId) : undefined;
    });
    room.gameId = U.uid('g');
    room.startedAt = Date.now();
    room.deck = [...GD.ZODIAC];
    const r1 = Engine.drawRound(room, 1);
    const starter = U.pick(room.players);
    r1.passOrder = [starter.id];
    room.rounds = [r1];
    room.currentRoundIdx = 0;
    room.currentTurnPlayerId = starter.id;
    room.currentSpeakerId = null;
    room.personVotes = {};
    room.gameOver = null;
    room.learning = null;
    room.status = 'playing';
    return true;
  };

  /* ---------------------------------------------------------------- 查驗階段 */

  /** 取得（必要時建立）玩家本回合的行動紀錄；方震不驗獸首，直接從技能步驟開始 */
  Engine.log = function (room, pid) {
    const rd = U.curRound(room);
    const p = U.byId(room, pid);
    if (!rd.turnLogs[pid]) {
      // blind：回合開始當下是否已被偷襲（之後會被重置，覆盤與推理都需要這個紀錄）
      rd.turnLogs[pid] = { inspect: [], ability: '無技能操作', skillTag: '', blind: Rules.isBlind(p),
                           step: Rules.inspectQuota(p) === 0 ? 'b' : 'a' };
    }
    return rd.turnLogs[pid];
  };

  const myTurn = (room, pid, step) =>
    room.status === 'playing' && room.currentTurnPlayerId === pid && Engine.log(room, pid).step === step;

  Engine.inspect = function (room, pid, beastName) {
    if (!myTurn(room, pid, 'a')) return false;
    const rd = U.curRound(room), p = U.byId(room, pid), log = Engine.log(room, pid);
    const beast = rd.beasts.find(b => b.name === beastName);
    if (!beast || log.inspect.some(x => x.beastName === beastName)) return false;
    if (log.inspect.length >= Rules.inspectQuota(p)) return false;
    const res = Rules.inspect(beast, p, rd, room.currentRoundIdx);
    log.inspect.push(res);
    if (log.inspect.length >= Rules.inspectQuota(p)) log.step = 'b';
    return res;
  };

  /**
   * 專屬技能。action: {kind:'fang',targetId} | {kind:'lao',active} | {kind:'yao',targetId} |
   *                  {kind:'zheng',beast} | {kind:'skip'}
   * 被偷襲者技能一律失效（視同 skip）。
   */
  Engine.skill = function (room, pid, action) {
    if (!myTurn(room, pid, 'b')) return false;
    const rd = U.curRound(room), p = U.byId(room, pid), log = Engine.log(room, pid);
    const done = () => { log.step = 'c'; return true; };
    if (!action || action.kind === 'skip') return done();
    if (Rules.isBlind(p)) { log.ability = '技能被偷襲封鎖'; return done(); }

    const target = action.targetId ? U.byId(room, action.targetId) : null;
    switch (action.kind) {
      case 'fang':
        if (p.role !== '方震' || !target || target.id === pid) return false;
        log.fangTargetId = target.id;
        log.fangCamp = GD.isGood(target.role) ? 'good' : 'evil';
        log.ability = `查驗【${target.name}】陣營為：${log.fangCamp === 'good' ? '許願陣營（好人）' : '老朝奉陣營（壞人）'}`;
        log.skillTag = `🔍驗${target.name.slice(0, 2)}`;
        break;
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

  /** 指定下一位；全員已行動時 nextId 傳 null，由尾家結束查驗並進入發言 */
  Engine.pass = function (room, pid, nextId) {
    if (!myTurn(room, pid, 'c')) return false;
    const rd = U.curRound(room), p = U.byId(room, pid), log = Engine.log(room, pid);
    const remaining = room.players.filter(x => !rd.passOrder.includes(x.id));
    if (remaining.length) {
      if (!remaining.some(x => x.id === nextId)) return false;
      rd.passOrder.push(nextId);
      log.nextPlayerId = nextId;
      room.currentTurnPlayerId = nextId;
    } else {
      startDiscussion(room, rd, pid);
    }
    p.isAmbushed = false;                                    // 失明只持續到自己行動完
    return true;
  };

  function startDiscussion(room, rd, tailId) {
    const seats = U.seated(room);
    const t = seats.findIndex(p => p.id === tailId);
    rd.speechOrder = Array.from({ length: seats.length }, (_, i) => seats[(t + 1 + i) % seats.length].id);  // 尾家左手邊開始，尾家壓軸
    rd.speechIndex = 0;
    room.currentSpeakerId = rd.speechOrder[0];
    room.currentTurnPlayerId = null;
    room.status = 'discussion';
  }

  /* ---------------------------------------------------------------- 發言 */

  /**
   * source: 'human' | 'bot' | 'gemini'；summary 由呼叫端提供（真人語音）或在此自動產生
   * 解析結果存進 speech.p，電腦玩家與覆盤共用，不必重複解析。
   */
  Engine.speak = function (room, pid, { text, source = 'human', summary = null, pass = false }) {
    if (room.status !== 'discussion' || room.currentSpeakerId !== pid) return false;
    const rd = U.curRound(room), p = U.byId(room, pid);
    const body = pass ? '（過，先聽後面的人分析）' : String(text || '').trim();
    if (!body) return false;
    const parsed = pass ? Claims.parse('', room) : Claims.parse(body, room);
    const label = source === 'human' ? '[真人]' : '[AI]';
    rd.speeches.push({
      playerId: pid, speakerName: p.name, colorId: p.colorId, text: body, source,
      summary: pass ? `${label} 選擇先過` : (summary || Claims.summarize(parsed, label, room, body)),
      p: parsed, time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    });
    rd.speechIndex++;
    if (rd.speechIndex >= rd.speechOrder.length) { room.status = 'voting'; room.currentSpeakerId = null; }
    else room.currentSpeakerId = rd.speechOrder[rd.speechIndex];
    return true;
  };

  /* ---------------------------------------------------------------- 鑑寶投票 */

  Engine.vote = function (room, pid, ballot) {
    if (room.status !== 'voting') return false;
    const rd = U.curRound(room), p = U.byId(room, pid);
    if (!p || rd.votes[pid] !== undefined || rd.voteResults) return false;
    const clean = {};
    let spend = 0;
    for (const [name, raw] of Object.entries(ballot || {})) {
      const n = parseInt(raw, 10) || 0;
      if (n <= 0) continue;
      if (!rd.beasts.some(b => b.name === name)) return false;
      clean[name] = n; spend += n;
    }
    if (spend > p.voteBank) return false;
    p.voteBank -= spend;                                     // 沒投完的籌碼自動保留到下一輪
    rd.votes[pid] = clean;
    if (room.players.every(x => rd.votes[x.id] !== undefined)) rd.voteResults = Rules.tally(room, rd);
    return true;
  };

  /** 開票完成後進入下一回合（或終局鑑人）。可由任何玩家觸發，重複呼叫無副作用 */
  Engine.advance = function (room) {
    if (room.status !== 'voting' || !U.curRound(room).voteResults) return false;
    const idx = room.currentRoundIdx, rd = U.curRound(room);
    if (idx >= 2) { room.status = 'person_voting'; return true; }
    const tail = rd.passOrder[rd.passOrder.length - 1];
    const next = Engine.drawRound(room, idx + 2);
    next.passOrder = [tail];
    room.rounds.push(next);
    room.players.forEach(p => {
      p.voteBank += C.CHIPS_PER_ROUND;
      p.isAmbushed = !!p.pendingAmbush;                      // 偷已行動者：效果延續到下一回合
      p.pendingAmbush = false;
    });
    room.currentRoundIdx = idx + 1;
    room.currentTurnPlayerId = tail;
    room.status = 'playing';
    return true;
  };

  /* ---------------------------------------------------------------- 終局鑑人 */

  Engine.personVote = function (room, pid, targetId) {
    if (room.status !== 'person_voting' || pid === targetId) return false;
    if (!U.byId(room, pid) || !U.byId(room, targetId) || room.personVotes[pid]) return false;
    room.personVotes[pid] = targetId;
    if (room.players.every(p => room.personVotes[p.id])) {
      room.gameOver = Rules.score(room);
      room.status = 'gameover';
    }
    return true;
  };

  /* ---------------------------------------------------------------- 查詢輔助 */

  Engine.remainingToAct = room => room.players.filter(p => !U.curRound(room).passOrder.includes(p.id));

  Engine.humans = room => room.players.filter(p => !p.isBot);

  GD.Engine = Engine;
})(window.GD);
