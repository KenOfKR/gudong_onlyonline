/* ============================================================================
 * bot/driver.js — 電腦玩家自動行動驅動器（絕對時間戳記防飄移版）
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Engine, Mind, Strategy, Speech, Gemini } = GD;
  const D = GD.CONFIG.BOT_DELAY_MS;
  const AFK_LIMIT_MS = 120000;    // 真人超時 2 分鐘未動開始進入警告

  let timer = null;
  let pendingTaskKey = null;
  const inflight = new Set();
  const attempts = new Map();

  const Driver = { thinking: null };

  /** 找出當前要驅動的房間 */
  function activeRoom() {
    if (!GD.Net) return null;
    return (GD.Net.room && GD.Net.room()) || (GD.Net.bgRoom && GD.Net.bgRoom()) || null;
  }

  function isDriver(room) {
    if (!room || room.closed) return false;
    if (GD.Net.mode && GD.Net.mode() === 'solo') return true;
    if (GD.Net.bgRoom && GD.Net.bgRoom() && GD.Net.bgRoom().roomId === room.roomId) return true;

    const humans = room.players.filter(p => !p.isBot);
    const specs = room.spectators || [];
    const me = GD.Net.myId;
    const beatFresh = Date.now() - (room.hostBeat || 0) < 25000;

    if (room.hostId === me) return true;

    if (humans.length > 0) {
      const hostInRoom = room.hostId && (humans.some(h => h.id === room.hostId) || specs.some(s => s.id === room.hostId)) && beatFresh;
      if (hostInRoom) return room.hostId === me;
      if (!humans.some(h => h.id === me)) return !beatFresh;
      return [...humans].sort((a, b) => (a.id < b.id ? -1 : 1))[0].id === me;
    }

    const hostInSpecs = room.hostId && specs.some(s => s.id === room.hostId) && beatFresh;
    if (hostInSpecs) return room.hostId === me;
    if (specs.length > 0 && specs.some(s => s.id === me)) return specs[0].id === me;

    return true;
  }

  /** AFK 狀態存在共用房間文件；只有 Driver 主機負責啟動／完成狀態轉移。 */
  function findAfkTask(room) {
    if (!room || !Engine.afkContext) return null;
    const ctx = Engine.afkContext(room);
    if (!ctx) return null;
    const now = Date.now();
    const rescue = room.afkRescue;
    if (!rescue || rescue.actionKey !== ctx.actionKey || rescue.targetId !== ctx.targetId) {
      if (now - ctx.startedAt >= AFK_LIMIT_MS) {
        return { type: 'afk-start', targetId: ctx.targetId, actionKey: ctx.actionKey,
          key: [room.gameId, 'afk-start', ctx.actionKey].join('|'), delay: 100 };
      }
      return null;
    }
    if (now >= Number(rescue.deadlineAt || Infinity)) {
      return { type: 'afk', targetId: ctx.targetId, actionKey: ctx.actionKey,
        key: [room.gameId, 'afk-takeover', ctx.actionKey, rescue.deadlineAt].join('|'), delay: 100 };
    }
    return null;
  }

  /** 找出當前輪到哪個電腦玩家、要做什麼；沒有則回傳 null */
  function nextTask(room) {
    const key = (...a) => [room.gameId, room.currentRoundIdx, room.status, ...a].join('|');
    const bot = id => { const p = U.byId(room, id); return p && p.isBot ? p : null; };

    const afkTask = findAfkTask(room);
    if (afkTask) return afkTask;

    switch (room.status) {
      case 'playing': { const b = bot(room.currentTurnPlayerId); return b && { type: 'turn', bot: b, key: key(b.id, U.curRound(room).passOrder.length), delay: D.turn }; }
      case 'discussion': { const b = bot(room.currentSpeakerId); return b && { type: 'speech', bot: b, key: key(b.id), delay: D.speech }; }
      case 'voting': {
        const rd = U.curRound(room);
        if (rd.voteResults) {
          return { type: 'advance', key: key('adv'), delay: 2000 };
        }
        return room.players.some(p => p.isBot && rd.votes[p.id] === undefined) ? { type: 'vote', key: key('all'), delay: D.vote } : null;
      }
      case 'person_voting':
        return room.players.some(p => p.isBot && !room.personVotes[p.id]) ? { type: 'pvote', key: key('all'), delay: D.vote } : null;
      case 'gameover':
        return room.gameOver && !room.learning ? { type: 'learn', key: key('learn'), delay: 400 } : null;
      default: return null;
    }
  }

  /* ----------------------------------------------------------------- 各類動作 */

  function doTurn(room, botId) {
    const bot = U.byId(room, botId);
    if (!bot || room.currentTurnPlayerId !== botId) return false;
    const log = Engine.log(room, botId);
    if (log.step === 'a') Strategy.inspectPicks(bot, room).forEach(n => Engine.inspect(room, botId, n));
    const A = Mind.analyze(bot, room);
    Engine.skill(room, botId, Strategy.skill(bot, room, A));
    return Engine.pass(room, botId, Strategy.nextPlayer(bot, room, A));
  }

  async function doSpeech(botId) {
    const cur = activeRoom();
    if (!cur) return false;
    const snap = JSON.parse(JSON.stringify(cur));        // 在副本上推理，避免污染即時房間
    const bot = U.byId(snap, botId);
    if (!bot || snap.currentSpeakerId !== botId) return false;

    let plan = null, A = null, mind = null;
    let text = null, source = 'bot', gemFail = '';
    // Per-speaker metrics must start empty; never leak the previous BOT's Gemini latency.
    let geminiMetrics = { elapsedMs: 0, attempts: 0, models: [], usedModel: null };

    Driver.thinking = { botId, name: bot.name, via: Gemini.enabled() ? 'gemini' : 'local' };
    GD.bus.emit('thinking', Driver.thinking);
    try {
      const res = Strategy.plan(bot, snap);
      plan = res.plan;
      A = res.A;
      mind = snap.rounds[snap.currentRoundIdx].mind[botId];

      if (Gemini.enabled() && Speech && Speech.buildPrompt) {
        // 不指定固定輸出 token／字數上限；內容由證據複雜度決定，總等待時間仍由 Gemini timeout 控制。
        const raw = await Gemini.generate(Speech.buildPrompt(bot, snap, plan, A), { temperature: 0.48 + 0.22 * A.ctx.genes.deception * (A.ctx.isGood ? 0 : 1) });
        geminiMetrics = {
          elapsedMs: Number(Gemini.state.lastCallMs) || 0,
          attempts: Number(Gemini.state.lastAttempts) || 0,
          models: Array.isArray(Gemini.state.lastAttemptModels) ? Gemini.state.lastAttemptModels.slice() : [],
          usedModel: Gemini.state.lastModel || null
        };
        const rawCleaned = raw && Gemini.clean(raw);
        const cleaned = rawCleaned && Speech.simplifyDialogue ? Speech.simplifyDialogue(rawCleaned) : rawCleaned;
        const v = cleaned ? Speech.validate(cleaned, bot, snap, plan, A) : { ok: false, why: Gemini.state.lastError || '無回應' };
        if (v.ok) { text = cleaned; source = 'gemini'; } else gemFail = v.why;
      }
      if (!text && Speech && Speech.localSpeech) {
        text = Speech.localSpeech(bot, snap, plan, A);
      }
    } catch (err) {
      console.error('[driver doSpeech error]', bot.name, err);
      gemFail = err.message || '發言生成異常';
    } finally {
      Driver.thinking = null;
      GD.bus.emit('thinking', null);
    }

    // 緊急備援：萬一 Speech 模組未載入或報錯，直接根據查驗紀錄生成基礎發言，絕不假裝成真人過麥
    if (!text) {
      const rd = U.curRound(snap);
      const log = (rd && rd.turnLogs && rd.turnLogs[botId]) || { inspect: [] };
      const posTxt = rd ? U.nth(rd.passOrder.indexOf(botId)) : '';
      if (log.blind) {
        text = `我在${posTxt}，這輪先保留看法，聽聽大家怎麼分析。`;
      } else if (log.inspect && log.inspect.length && GD.isGood(bot.role)) {
        const seenStr = log.inspect.map(i => `【${i.beastName}】是${GD.Mind.inspectionTruth(i) ? '真品' : '贗品'}`).join('、');
        text = `我在${posTxt}查驗，看到${seenStr}，提供給大家參考。`;
      } else {
        text = `我在${posTxt}，目前資訊還不夠明朗，先聽後面掌眼人的分析。`;
      }
    }

    if (mind) {
      mind.source = source;
      mind.gemini = geminiMetrics;
      if (gemFail) mind.geminiNote = gemFail;
    }

    return GD.Net.act(room => {
      if (room.currentSpeakerId !== botId) return false;
      const rd = U.curRound(room);
      if (mind) rd.mind[botId] = mind;
      return Engine.speak(room, botId, { text, source });
    });
  }

  const doVotes = room => {
    const rd = U.curRound(room);
    if (!rd || rd.voteResults) return false;
    room.players.filter(p => p.isBot && rd.votes[p.id] === undefined)
      .forEach(b => Engine.vote(room, b.id, Strategy.ballot(b, room)));
    return true;
  };

  const doPersonVotes = room => {
    room.players.filter(p => p.isBot && !room.personVotes[p.id]).forEach(b => {
      const d = Strategy.personVote(b, room);
      b.final = { why: d.why, followId: d.followId, top: d.top };   // 覆盤與學習引擎使用
      Engine.personVote(room, b.id, d.targetId);
    });
    return true;
  };

  /* ----------------------------------------------------------------- 排程 */

  function schedule() {
    const room = activeRoom();
    if (!room || room.closed || !isDriver(room)) {
      clearTimeout(timer);
      pendingTaskKey = null;
      return;
    }
    const task = nextTask(room);
    if (!task || inflight.has(task.key)) {
      if (!task) {
        clearTimeout(timer);
        pendingTaskKey = null;
      }
      return;
    }

    if (pendingTaskKey === task.key) return;

    clearTimeout(timer);
    pendingTaskKey = task.key;
    timer = setTimeout(() => {
      pendingTaskKey = null;
      run(task);
    }, task.delay);
  }

  async function run(task) {
    const room = activeRoom();
    if (!room || inflight.has(task.key)) return;
    inflight.add(task.key);
    let ok = false;
    try {
      switch (task.type) {
        case 'afk-start': ok = await GD.Net.act(r => Engine.beginAfkRescue && Engine.beginAfkRescue(r, task.targetId, task.actionKey)); break;
        case 'afk':     ok = await GD.Net.act(r => Engine.finishAfkTakeover && Engine.finishAfkTakeover(r, task.targetId, task.actionKey)); break;
        case 'turn':   ok = await GD.Net.act(r => doTurn(r, task.bot.id)); break;
        case 'speech': ok = await doSpeech(task.bot.id); break;
        case 'vote':   ok = await GD.Net.act(doVotes); break;
        case 'advance': ok = await GD.Net.act(r => Engine.advance(r)); break;
        case 'pvote':  ok = await GD.Net.act(doPersonVotes); break;
        case 'learn':  ok = await GD.Net.act(r => GD.Learning.finalize(r)); break;
      }
    } catch (e) {
      console.error('[driver]', task.type, e);
    }
    const n = (attempts.get(task.key) || 0) + 1;
    attempts.set(task.key, n);
    if (!ok && n < 4) inflight.delete(task.key);       // 失敗且未達上限：允許重試
    else if (!ok) {                                    // 多次失敗：保底動作，標明 source: 'bot'
      inflight.delete(task.key);
      attempts.delete(task.key);
      if (task.type === 'speech') {
        await GD.Net.act(r => r.currentSpeakerId === task.bot.id && Engine.speak(r, task.bot.id, {
          text: '（這輪先保留資訊，聽後面的人分析）',
          summary: '[電腦] 暫不表態',
          source: 'bot'
        }));
      }
    }
    schedule();
  }

  Driver.schedule = schedule;
  Driver.isDriver = isDriver;
  Driver.reset = () => { clearTimeout(timer); pendingTaskKey = null; inflight.clear(); attempts.clear(); };

  GD.bus.on('room', schedule);
  setInterval(schedule, 1000);
  GD.Driver = Driver;
})(window.GD);