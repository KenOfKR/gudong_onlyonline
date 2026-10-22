/* ============================================================================
 * ui/board.js — 牌桌渲染：頂欄、橢圓桌與座位、中央四獸首、個人情報、傳遞鏈、
 *               ◀ R1 R2 R3 ▶ 切換的票型與發言紀錄
 * 渲染由 bus 'room' 事件驅動；各區塊內容未變就不重寫 DOM（UI.html 有快取）。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, UI, Net, Engine, Rules } = GD;
  const S = UI.state;

  const PHASE = {
    waiting: '等待掌眼人入座（滿 8 人發牌）',
    playing: '🔍 獸首查驗與暗技階段',
    discussion: '🗣️ 順時針陳詞（尾家左手邊先發言）',
    voting: '🗳️ 鑑寶籌碼投票（沒投完的票累積到下輪）',
    person_voting: '🎯 終局鑑人指認',
    gameover: '🏆 終局揭曉與電腦覆盤'
  };

  UI.me = () => { const r = Net.room(); return r ? (U.byId(r, Net.myId) || null) : null; };

  /* ---------------- 畫面切換 ---------------- */
  UI.showBoard = () => { UI.show('home', false); UI.show('board', true); S.lastGame = null; UI.render(); };
  UI.showHome = () => { UI.show('board', false); UI.show('home', true); UI.initHome(); };
  UI.on('home', () => { GD.Voice.abort(); Net.leave(); UI.showHome(); });
  GD.bus.on('closed', () => { UI.toast('此房間已被關閉', 'warn'); Net.leave(); UI.showHome(); });
  UI.on('tab', t => {
    S.tab = t; UI.byId('board').dataset.tab = t;
    UI.$$('.mtabs .btn').forEach(b => b.classList.toggle('red', b.dataset.arg === t));
  });
  UI.on('peek', () => { S.peek = !S.peek; UI.render(); });
  UI.on('shift', d => Net.act(r => Engine.shiftSeat(r, Net.myId, +d)));
  UI.on('fill', () => Net.act(r => { Engine.fillBots(r); return r.players.length === 8 && Engine.start(r); }));
  UI.on('color', id => Net.act(r => Engine.setColor(r, Net.myId, id)));

  /* ---------------- 回合頁籤 ---------------- */
  const clampRound = (i, room) => U.clamp(i, 0, Math.max(0, room.rounds.length - 1));
  UI.on('vround', i => { S.voteRound = +i; renderVotes(Net.room()); });
  UI.on('vroundStep', d => { S.voteRound += +d; renderVotes(Net.room()); });
  UI.on('sround', i => { S.speechRound = +i; renderSpeeches(Net.room()); });
  UI.on('sroundStep', d => { S.speechRound += +d; renderSpeeches(Net.room()); });

  /* ---------------- 座位點擊：傳遞 或 插入色名 ---------------- */
  UI.on('seat', pid => {
    const room = Net.room(), me = UI.me(); if (!room || !me) return;
    const p = U.byId(room, pid); if (!p) return;
    if (room.status === 'playing' && room.currentTurnPlayerId === me.id && Engine.log(room, me.id).step === 'c' && !U.curRound(room).passOrder.includes(pid)) {
      return Net.act(r => Engine.pass(r, me.id, pid));
    }
    if (UI.insertDraft) UI.insertDraft(U.tag(p));
  });

  /* ---------------- 主渲染 ---------------- */
  UI.render = function () {
    const room = Net.room();
    if (!room || UI.byId('board').hidden) return;
    const me = UI.me(), rd = room.rounds[room.currentRoundIdx];

    if (S.lastGame !== room.gameId) { S.lastGame = room.gameId; S.voteRound = S.speechRound = room.currentRoundIdx; S.ballot = {}; }
    if (S.lastRound !== room.currentRoundIdx) { S.lastRound = room.currentRoundIdx; S.voteRound = S.speechRound = room.currentRoundIdx; S.ballot = {}; }

    UI.text('bRoom', `房號 ${room.roomId}${Net.mode() === 'online' ? '・連線' : '・單人'}`);
    UI.text('bRound', rd ? `第 ${rd.roundNum} 回合` : '大廳準備中');
    UI.text('bPhase', PHASE[room.status] || '');
    UI.show('bFill', room.status === 'waiting');
    UI.show('seatShift', room.status === 'waiting');
    UI.show('colorBar', room.status === 'waiting');

    const chips = UI.byId('bChips');
    chips.hidden = !(me && room.status !== 'waiting' && room.status !== 'gameover');
    if (me) chips.textContent = `🎟️ 可用籌碼 ${me.voteBank}`;
    UI.text('bRole', me && me.role ? (S.peek ? `🎴 我的身分：【${me.role}】` : '🎴 身分已隱藏（點擊查看）') : '🎴 等待發牌');

    renderIntel(room, me);
    renderOval(room, me, rd);
    renderColors(room, me);
    renderChains(room, me);
    renderVotes(room);
    renderSpeeches(room);
    if (UI.renderConsole) UI.renderConsole(room, me, rd);
    if (UI.renderSpeechPanel) UI.renderSpeechPanel(room, me, rd);
    if (UI.renderGameOver) UI.renderGameOver(room, me);
  };
  GD.bus.on('room', () => UI.render());

  /* ---------------- 個人情報 ---------------- */
  function renderIntel(room, me) {
    const box = UI.byId('intel');
    if (!me || !me.role) return UI.html(box, '<div class="panel-h"><span>🕵️ 個人掌眼筆記</span></div><div class="xs mute">開局後自動記錄你的查驗結果、同伴相認與方震查驗。</div>');
    if (!S.peek) return UI.html(box, '<div class="panel-h"><span>🕵️ 個人掌眼筆記</span></div><div class="note">🔒 已遮蔽，點上方「我的身分」展開</div>');
    const m = GD.ROLES[me.role];
    let h = `<div class="panel-h"><span>🕵️ 個人掌眼筆記</span><span class="xs ${GD.isGood(me.role) ? '' : 'red'}">${m.campText}</span></div>
      <div class="row" style="align-items:flex-start"><img src="${GD.Art.url(me.role)}" alt="${me.role}" style="width:52px;height:56px;object-fit:cover;border:2px solid var(--ink);border-radius:6px">
      <div class="xs"><b class="sm">【${me.role}】${m.badge}</b><br>${m.desc}</div></div><div class="col mt scroll" style="max-height:200px;gap:5px">`;
    if (me.role === '老朝奉' || me.role === '藥不然') {
      const pr = me.role === '老朝奉' ? '藥不然' : '老朝奉', pt = room.players.find(p => p.role === pr);
      if (pt) h += `<div class="note evil">🤝 秘密同伴：${U.tag(pt)} 是【${pr}】</div>`;
    }
    if (Rules.isBlind(me)) h += `<div class="note evil">💥 你目前${me.isPermanentlyAmbushed ? '永久失明' : '遭偷襲'}，無法查驗與施放技能</div>`;
    if (me.pendingAmbush) h += '<div class="note evil">⚠️ 你已被偷襲，效果將在下回合生效</div>';
    room.rounds.forEach(rd => {
      const l = rd.turnLogs[me.id]; if (!l) return;
      if (l.inspect.length) h += `<div class="note"><b>R${rd.roundNum} 查驗</b>：${U.esc(l.inspect.map(i => i.resultText).join('、'))}</div>`;
      if (l.ability && l.ability !== '無技能操作') h += `<div class="note red"><b>R${rd.roundNum} 技能</b>：${U.esc(l.ability)}</div>`;
    });
    UI.html(box, h + '</div>');
  }

  /* ---------------- 橢圓桌 ---------------- */
  function renderOval(room, me, rd) {
    const players = U.seated(room), mySeat = me ? me.seatIndex : 0;
    let status = '等待開局', tip = '中央四獸首鑑定台';
    const find = id => U.byId(room, id);
    if (room.status === 'playing' && rd) { const a = find(room.currentTurnPlayerId); status = a ? `📢 ${a.name} 查驗中` : '查驗中'; tip = `已驗 ${rd.passOrder.length}/8`; }
    else if (room.status === 'discussion') { const s = find(room.currentSpeakerId); status = s ? `🗣️ ${s.name} 發言中` : '陳詞'; tip = `${(rd.speechIndex || 0) + 1}/8`; }
    else if (room.status === 'voting') { status = rd.voteResults ? '📊 已開票' : '🗳️ 投票中'; tip = '剩餘票可累積'; }
    else if (room.status === 'person_voting') { status = '🎯 終局鑑人'; tip = '指認老朝奉'; }
    else if (room.status === 'gameover' && room.gameOver) { status = room.gameOver.xuWon ? '🎉 許願方勝' : '😈 老朝奉勝'; tip = `${room.gameOver.totalScore} 分`; }

    /* 中央四獸首 */
    let beastsHtml = '<div style="grid-column:1/-1;text-align:center;font-size:11px;font-weight:800">開局後當場抽出四尊獸首</div>';
    if (rd) {
      const log = rd.turnLogs[me && me.id] || { inspect: [], step: 'a' };
      const mine = me && room.status === 'playing' && room.currentTurnPlayerId === me.id && log.step === 'a';
      const quota = me ? Rules.inspectQuota(me) : 0;
      beastsHtml = rd.beasts.map(b => {
        const seen = (log.inspect || []).find(i => i.beastName === b.name);
        const canPick = mine && !seen && log.inspect.length < quota;
        let cls = '', sub = '未查驗';
        if (room.status === 'gameover') { cls = b.isReal ? 'real' : 'fake'; sub = b.isReal ? '✓真品' : '✕贗品'; }
        else if (seen) { cls = seen.displayedReal === true ? 'real' : seen.displayedReal === false ? 'fake' : ''; sub = seen.displayedReal === true ? '✓真品' : seen.displayedReal === false ? '✕贗品' : '❓不明'; }
        else if (rd.voteResults && rd.voteResults.rank2.name === b.name) { cls = rd.voteResults.rank2.isReal ? 'real' : 'fake'; sub = '🥈公開' + (rd.voteResults.rank2.isReal ? '真' : '假'); }
        else if (rd.voteResults && rd.voteResults.rank1.name === b.name) sub = '🥇封存';
        else if (canPick) sub = '🔍點此查驗';
        return `<button class="beast ${cls} ${canPick ? 'pick' : ''}" ${canPick ? `data-act="inspect" data-arg="${b.name}"` : 'disabled'}><b>${b.name}</b><i>${sub}</i></button>`;
      }).join('');
    }

    /* 座位：正下方為自己，順時針排列 */
    let seats = '';
    for (let i = 0; i < 8; i++) {
      const p = players[i], rel = (i - mySeat + 8) % 8, ang = (90 + rel * 45) * Math.PI / 180;
      const left = 50 + 45 * Math.cos(ang), top = 50 + 43 * Math.sin(ang);
      if (!p) { seats += `<div class="seat empty" style="left:${left}%;top:${top}%"><div class="chip"><span>空席</span></div></div>`; continue; }
      const c = U.colorOf(p), isMe = me && p.id === me.id;
      const acting = (room.status === 'playing' && room.currentTurnPlayerId === p.id) || (room.status === 'discussion' && room.currentSpeakerId === p.id);
      const done = rd && rd.passOrder.includes(p.id) && room.status === 'playing';
      const partner = me && ((me.role === '老朝奉' && p.role === '藥不然') || (me.role === '藥不然' && p.role === '老朝奉'));
      const showRole = p.role && (room.status === 'gameover' || (isMe && S.peek) || partner);
      const tail = rd && rd.passOrder.length === 8 && rd.passOrder[7] === p.id, first = rd && rd.passOrder[0] === p.id;
      seats += `<div class="seat ${acting ? 'act' : ''}" style="left:${left}%;top:${top}%" data-act="seat" data-arg="${p.id}" title="點擊插入：${U.esc(U.tag(p))}">
        ${tail ? '<span class="mark tail">尾家</span>' : first ? '<span class="mark">⭐首家</span>' : ''}
        <div class="chip" style="background:${c.hex};color:${c.text}"><small>${c.short}${isMe ? '（我）' : ''}${p.isBot ? '' : ' 👤'}</small><span>${U.esc(p.name)}</span>${done ? '<div class="done">✓</div>' : ''}</div>
        ${showRole ? `<span class="role">${p.role}</span>` : ''}</div>`;
    }
    UI.html('oval', `<div class="felt"><div class="st"><span>${U.esc(status)}</span><span class="red">${U.esc(tip)}</span></div><div class="beasts">${beastsHtml}</div></div>${seats}`);
  }
  UI.on('inspect', name => { const me = UI.me(); if (me) Net.act(r => Engine.inspect(r, me.id, name)); });

  function renderColors(room, me) {
    if (room.status !== 'waiting' || !me) return;
    const used = {}; room.players.forEach(p => { used[p.colorId] = p; });
    UI.html('colors', GD.SEAL_COLORS.map(c => {
      const o = used[c.id], blocked = o && o.id !== me.id && !o.isBot;
      return `<button class="${me.colorId === c.id ? 'mine' : ''}" ${blocked ? 'disabled' : ''} data-act="color" data-arg="${c.id}" style="background:${c.hex};color:${c.text}">${c.short}${me.colorId === c.id ? '✓' : ''}</button>`;
    }).join(''));
  }

  /* ---------------- 傳遞鏈 ---------------- */
  function renderChains(room, me) {
    const over = room.status === 'gameover';
    UI.html('chains', [0, 1, 2].map(i => {
      const rd = room.rounds[i];
      if (!rd) return `<div class="note mute">R${i + 1}：尚未進入本回合</div>`;
      const nodes = rd.passOrder.map((pid, k) => {
        const p = U.byId(room, pid); if (!p) return '';
        const l = rd.turnLogs[pid], see = over || (me && me.id === pid);
        const cur = room.status === 'playing' && room.currentRoundIdx === i && room.currentTurnPlayerId === pid;
        return `<div class="node">${see && l && l.skillTag ? `<em>${U.esc(l.skillTag)}</em>` : ''}${UI.seal(p, `data-act="seat" data-arg="${p.id}" style="cursor:pointer${cur ? ';outline:2px solid #b91c1c' : ''}"`)}</div>${k < rd.passOrder.length - 1 ? '<span class="mute b">➔</span>' : ''}`;
      }).join('');
      return `<div class="note"><div class="xs b">R${i + 1} 傳遞序</div><div class="chain">${nodes || '<span class="mute">尚未開始</span>'}</div></div>`;
    }).join(''));
  }

  /* ---------------- 獸首票型（頁籤）---------------- */
  function renderVotes(room) {
    if (!room || !room.rounds.length) { UI.html('votePager', ''); return UI.html('voteBody', '<div class="xs mute">開局後才會抽出當回合四尊獸首</div>'); }
    S.voteRound = clampRound(S.voteRound, room);
    const rd = room.rounds[S.voteRound], vr = rd.voteResults, over = room.status === 'gameover';
    UI.html('votePager', UI.pager('vround', S.voteRound, room.rounds.length));
    UI.html('voteBody', `<div class="col" style="gap:5px">${rd.beasts.map(b => {
      const n = vr ? vr.totals[b.name] : 0, chips = vr ? vr.chips[b.name] : [];
      let badge = '';
      if (over) badge = `<b class="${b.isReal ? 'jade' : 'red'}">[${b.isReal ? '真品' : '贗品'}]</b>`;
      else if (vr && vr.rank1.name === b.name) badge = '<b class="gold">[🥇封存]</b>';
      else if (vr && vr.rank2.name === b.name) badge = `<b class="${vr.rank2.isReal ? 'jade' : 'red'}">[🥈${vr.rank2.isReal ? '真品' : '贗品'}]</b>`;
      const dots = chips.map(c => `<span class="dot" style="background:${(GD.SEAL_COLORS.find(x => x.id === c.colorId) || GD.SEAL_COLORS[0]).hex}" title="${U.esc(c.voterName)}"></span>`).join('');
      return `<div class="vote-row" data-act="chips" data-arg="${rd.roundNum}|${b.name}"><span class="row" style="gap:5px"><b class="lg">【${b.name}】</b>${badge}<span>${dots}</span></span><b class="mono sm">${vr ? n + ' 票' : '未開票'}</b></div>`;
    }).join('')}</div>`);
  }
  UI.on('chips', arg => {
    const [rn, name] = arg.split('|'), room = Net.room(), rd = room.rounds[+rn - 1];
    if (!rd || !rd.voteResults) return UI.toast(`第 ${rn} 回合尚未開票`);
    const by = {};
    rd.voteResults.chips[name].forEach(c => { by[c.voterId] = (by[c.voterId] || 0) + 1; });
    const rows = Object.entries(by).map(([id, n]) => `<div class="row between">${UI.seal(U.byId(room, id))}<b class="red mono">${n} 票</b></div>`).join('');
    UI.modal(`<div class="panel-h"><span>第 ${rn} 回合【${name}】籌碼明細</span><button class="btn red" data-act="close">✕</button></div><div class="col">${rows || '<div class="mute">沒有人投給它</div>'}</div>`);
  });

  /* ---------------- 發言紀錄（頁籤）---------------- */
  function renderSpeeches(room) {
    if (!room || !room.rounds.length) { UI.html('speechPager', ''); return UI.html('speechBody', '<div class="xs mute">開局後，全場發言與系統摘要會即時記錄在這裡。</div>'); }
    S.speechRound = clampRound(S.speechRound, room);
    const rd = room.rounds[S.speechRound];
    UI.html('speechPager', UI.pager('sround', S.speechRound, room.rounds.length));
    UI.html('speechBody', rd.speeches.length ? rd.speeches.map(sp => {
      const p = U.byId(room, sp.playerId);
      return `<div class="say ${sp.source === 'human' ? 'human' : ''} ${sp.source === 'gemini' ? 'gem' : ''}">
        <div class="row between">${p ? UI.seal(p, `data-act="seat" data-arg="${p.id}" style="cursor:pointer"`) : ''}<span class="xs mono mute">R${rd.roundNum} ${U.esc(sp.time || '')}</span></div>
        <div class="sum">📌 ${U.esc(sp.summary)}</div><div class="sm">${U.esc(sp.text)}</div></div>`;
    }).join('') : `<div class="xs mute center" style="padding:20px 0">第 ${rd.roundNum} 回合尚無發言</div>`);
  }
})(window.GD);
