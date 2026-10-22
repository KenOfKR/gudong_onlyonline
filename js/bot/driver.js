/* ============================================================================
 * bot/driver.js — 電腦玩家自動行動驅動器
 *
 * 多人連線時只讓一個瀏覽器代打（房主；房主 25 秒沒心跳，改由 id 最小的真人接手），
 * 避免多個視窗同時替同一個電腦發言。所有動作都經 Net.act 套用到最新房間狀態，
 * 即使兩邊偶爾重複觸發，Engine 的狀態檢查也會擋掉第二次。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Engine, Mind, Strategy, Speech, Gemini } = GD;
  const D = GD.CONFIG.BOT_DELAY_MS;

  let timer = null;
  const inflight = new Set();     // 正在處理的任務鍵，避免重複排程
  const attempts = new Map();     // 任務鍵 → 失敗次數，超過上限改用保底動作

  const Driver = { thinking: null };

  function isDriver(room) {
    const humans = room.players.filter(p => !p.isBot);
    if (!humans.length) return false;
    const me = GD.Net.myId;
    if (!humans.some(h => h.id === me)) return false;
    const hostAlive = room.hostId && humans.some(h => h.id === room.hostId) && Date.now() - (room.hostBeat || 0) < 25000;
    if (hostAlive) return room.hostId === me;
    return [...humans].sort((a, b) => (a.id < b.id ? -1 : 1))[0].id === me;
  }

  /** 找出當前輪到哪個電腦玩家、要做什麼；沒有則回傳 null */
  function nextTask(room) {
    const key = (...a) => [room.gameId, room.currentRoundIdx, room.status, ...a].join('|');
    const bot = id => { const p = U.byId(room, id); return p && p.isBot ? p : null; };
    switch (room.status) {
      case 'playing': { const b = bot(room.currentTurnPlayerId); return b && { type: 'turn', bot: b, key: key(b.id, U.curRound(room).passOrder.length), delay: D.turn }; }
      case 'discussion': { const b = bot(room.currentSpeakerId); return b && { type: 'speech', bot: b, key: key(b.id), delay: D.speech }; }
      case 'voting': {
        const rd = U.curRound(room);
        if (rd.voteResults) return null;
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
    const snap = JSON.parse(JSON.stringify(GD.Net.room()));        // 在副本上推理，避免污染即時房間
    const bot = U.byId(snap, botId);
    if (!bot || snap.currentSpeakerId !== botId) return false;
    const { plan, A } = Strategy.plan(bot, snap);
    const mind = snap.rounds[snap.currentRoundIdx].mind[botId];
    let text = null, source = 'bot', gemFail = '';

    Driver.thinking = { botId, name: bot.name, via: Gemini.enabled() ? 'gemini' : 'local' };
    GD.bus.emit('thinking', Driver.thinking);
    try {
      if (Gemini.enabled()) {
        const raw = await Gemini.generate(Speech.buildPrompt(bot, snap, plan, A), { temperature: 0.55 + 0.35 * A.ctx.genes.deception * (A.ctx.isGood ? 0 : 1), maxTokens: 460 });
        const cleaned = raw && Gemini.clean(raw);
        const v = cleaned ? Speech.validate(cleaned, bot, snap, plan, A) : { ok: false, why: Gemini.state.lastError || '無回應' };
        if (v.ok) { text = cleaned; source = 'gemini'; } else gemFail = v.why;
      }
      if (!text) text = Speech.localSpeech(bot, snap, plan, A);
    } finally {
      Driver.thinking = null;
      GD.bus.emit('thinking', null);
    }
    mind.source = source;
    if (gemFail) mind.geminiNote = gemFail;

    return GD.Net.act(room => {
      if (room.currentSpeakerId !== botId) return false;
      const rd = U.curRound(room);
      rd.mind[botId] = mind;                                         // 推理依據與實際發言一併入庫，供覆盤
      return Engine.speak(room, botId, { text, source });
    });
  }

  const doVotes = room => {
    const rd = U.curRound(room);
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
    clearTimeout(timer);
    const room = GD.Net.room && GD.Net.room();
    if (!room || room.closed || !isDriver(room)) return;
    const task = nextTask(room);
    if (!task || inflight.has(task.key)) return;
    timer = setTimeout(() => run(task), task.delay);
  }

  async function run(task) {
    const room = GD.Net.room();
    if (!room || inflight.has(task.key)) return;
    inflight.add(task.key);
    let ok = false;
    try {
      switch (task.type) {
        case 'turn':   ok = await GD.Net.act(r => doTurn(r, task.bot.id)); break;
        case 'speech': ok = await doSpeech(task.bot.id); break;
        case 'vote':   ok = await GD.Net.act(doVotes); break;
        case 'pvote':  ok = await GD.Net.act(doPersonVotes); break;
        case 'learn':  ok = await GD.Net.act(r => GD.Learning.finalize(r)); break;
      }
    } catch (e) {
      console.error('[driver]', task.type, e);
    }
    const n = (attempts.get(task.key) || 0) + 1;
    attempts.set(task.key, n);
    if (!ok && n < 4) inflight.delete(task.key);       // 失敗且未達上限：允許重試
    else if (!ok && task.type === 'speech') {          // 多次失敗：保底動作，避免整局卡住
      await GD.Net.act(r => r.currentSpeakerId === task.bot.id && Engine.speak(r, task.bot.id, { text: '', pass: true }));
    }
    schedule();
  }

  Driver.schedule = schedule;
  Driver.isDriver = isDriver;
  Driver.reset = () => { clearTimeout(timer); inflight.clear(); attempts.clear(); };

  GD.bus.on('room', schedule);
  GD.Driver = Driver;
})(window.GD);
