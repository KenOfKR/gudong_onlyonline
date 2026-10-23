/* ============================================================================
 * ui/board.js — 牌桌渲染（修正第一名獸首封存顯示、原生捕獲踢人按鈕、AFK 電腦接管）
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
    gameover: '🏆 終局揭曉與對局覆盤'
  };

  /* ★ 全螢幕 AFK 警告彈窗元件（確保 document.body 就緒後掛載） */
  function ensureAFKModal() {
    let ov = document.getElementById('afkOverlay');
    if (ov) return ov;
    if (!document.body) return null;
    ov = document.createElement('div');
    ov.id = 'afkOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:none;align-items:center;justify-content:center;flex-direction:column;color:white';
    ov.innerHTML = `
      <div style="font-size:2rem;margin-bottom:15px;font-weight:bold">你還在嗎？</div>
      <div style="font-size:1.1rem;margin-bottom:25px;color:#d1d5db">由於閒置過久，即將轉交電腦接管</div>
      <div id="afkCount" style="font-size:6rem;font-weight:900;color:#ef4444;line-height:1;margin-bottom:30px">10</div>
      <button type="button" class="btn gold big" id="afkAliveBtn" style="padding:15px 40px;font-size:1.3rem;font-weight:bold;box-shadow:0 0 15px rgba(245,208,138,0.5)">我還在！（延長時間）</button>
    `;
    document.body.appendChild(ov);
    ov.querySelector('#afkAliveBtn').addEventListener('click', e => {
      e.stopPropagation();
      ov.style.display = 'none';
      localTurnFallbackTime = Date.now();
      GD.Net.act(r => { r.turnStartTime = Date.now(); return true; });
    });
    return ov;
  }

  /* ★ AFK 120秒閒置偵測 ＋ 10秒讀秒換電腦（含本地時間保底，防止舊房間無 turnStartTime 失效） */
  let afkInterval = null;
  let isProcessingAFK = false;
  let lastActionKey = '';
  let localTurnFallbackTime = Date.now();

  function getAFKTargets(room) {
    if (!room || room.status === 'waiting' || room.status === 'gameover') return [];
    let raw = [];
    if (room.status === 'playing') raw = [room.currentTurnPlayerId];
    else if (room.status === 'discussion') raw = [room.currentSpeakerId];
    else if (room.status === 'voting') {
      const rd = room.rounds[room.currentRoundIdx];
      if (rd && !rd.voteResults) {
        raw = room.players.filter(p => !p.isBot && rd.votes[p.id] === undefined).map(p => p.id);
      }
    } else if (room.status === 'person_voting') {
      raw = room.players.filter(p => !p.isBot && !room.personVotes[p.id]).map(p => p.id);
    }
    return raw.filter(id => { const p = U.byId(room, id); return p && !p.isBot; });
  }

  function checkAFK() {
    const room = Net.room();
    const ov = ensureAFKModal();
    if (!room || room.status === 'waiting' || room.status === 'gameover') {
      if (ov) ov.style.display = 'none';
      return;
    }

    const targets = getAFKTargets(room);
    const rd = room.rounds[room.currentRoundIdx];
    const curLogStep = (room.status === 'playing' && rd && rd.turnLogs[room.currentTurnPlayerId])
      ? rd.turnLogs[room.currentTurnPlayerId].step : '';
    const actionKey = `${room.gameId}|${room.currentRoundIdx}|${room.status}|${curLogStep}|${targets.join(',')}`;
    if (actionKey !== lastActionKey) {
      lastActionKey = actionKey;
      localTurnFallbackTime = Date.now();
    }

    if (!targets.length) {
      if (ov) ov.style.display = 'none';
      document.querySelectorAll('.afk-badge').forEach(el => el.remove());
      return;
    }

    const startT = room.turnStartTime || localTurnFallbackTime;
    const elapsed = Math.max(0, Date.now() - startT);
    const remaining = 130 - Math.floor(elapsed / 1000); // 120秒後開始 10~0 秒倒數

    // 1. 若輪到自己且進入最後 10 秒，跳出全螢幕「你還在嗎？」讀秒視窗
    if (targets.includes(Net.myId) && remaining <= 10 && remaining >= 0) {
      if (ov) {
        ov.style.display = 'flex';
        const cntEl = document.getElementById('afkCount');
        if (cntEl) cntEl.textContent = Math.max(0, remaining);
      }
    } else if (ov) {
      ov.style.display = 'none';
    }

    // 2. 其他玩家在座位頭上看到讀秒紅標
    targets.forEach(id => {
      const seat = document.querySelector(`.seat[data-arg="${id}"]`);
      if (seat) {
        let badge = seat.querySelector('.afk-badge');
        if (remaining <= 10 && remaining >= 0) {
          const txt = `⏳ 讀秒 ${Math.max(0, remaining)}s`;
          if (!badge) {
            seat.insertAdjacentHTML('beforeend', `<div class="afk-badge" style="position:absolute;top:-22px;left:50%;transform:translateX(-50%);background:#b91c1c;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:900;z-index:35;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.6);border:1.5px solid #fde68a">${txt}</div>`);
          } else {
            badge.textContent = txt;
          }
        } else if (badge) {
          badge.remove();
        }
      }
    });

    document.querySelectorAll('.afk-badge').forEach(el => {
      const seat = el.closest('.seat');
      const pid = seat && seat.dataset.arg;
      if (!targets.includes(pid) || remaining < 0 || remaining > 10) el.remove();
    });

    // 3. 倒數歸零（remaining < 0）：立刻將發呆玩家請到觀戰席，並由隨機電腦接管！
    if (remaining < 0 && targets.length > 0 && !isProcessingAFK) {
      isProcessingAFK = true;
      if (ov) ov.style.display = 'none';
      Net.act(r => {
        const nowTargets = getAFKTargets(r);
        let changed = false;
        nowTargets.forEach(id => {
          if (Engine.replaceWithBot(r, id)) changed = true;
        });
        if (changed) r.turnStartTime = Date.now();
        return changed;
      }).then(ok => {
        if (ok && GD.Driver) {
          GD.Driver.reset();
          GD.Driver.schedule();
        }
      }).finally(() => {
        setTimeout(() => { isProcessingAFK = false; }, 1500);
      });
    }
  }

  /* ★ 計算筆畫與傳遞時序代表字 */
  function strokeOf(ch) {
    if (!ch) return 0;
    const mini = {'彥':9,'凡':3,'大':3,'鈞':12,'哥':10,'皓':12,'柚':9,'子':3,'修':10,'宏':7,'特':10,'朗':10,'普':12,'孫':10,'終':11,'山':3,'習':11,'近':7,'平':5,'馬':10,'陰':10,'久':3,'金':8,'正':5,'恩':10,'甄':14,'雪':11,'浮':10,'藥':18,'不':4,'然':12,'許':11,'願':19,'姬':10,'雲':12,'黃':12,'煙':13,'木':4,'戶':4,'加':5,'奈':8};
    if (mini[ch]) return mini[ch];
    if (/[\u4e00-\u9fa5]/.test(ch)) return 10 + (ch.charCodeAt(0) % 15);
    return 1;
  }

  function rankedCharsOf(p) {
    if (!p || !p.name) return ['？'];
    const s = String(p.name).trim();
    const zh = [...s.matchAll(/[\u4e00-\u9fa5]/g)].map((m, idx) => ({ ch: m[0], strokes: strokeOf(m[0]), idx }));
    if (zh.length > 0) {
      zh.sort((a, b) => (b.strokes - a.strokes) || (a.idx - b.idx));
      const unique = [];
      zh.forEach(x => { if (!unique.includes(x.ch)) unique.push(x.ch); });
      return unique;
    }
    const alnum = [...s.replace(/\s+/g, '')].map(c => c.toUpperCase());
    return alnum.length ? alnum : ['？'];
  }

  function buildPlayerCharMap(room) {
    const map = {}, rankedByPid = {}, topCharCounts = {};
    if (!room || !room.players) return map;
    const players = U.seated(room);

    players.forEach(p => {
      const r = rankedCharsOf(p);
      rankedByPid[p.id] = r;
      topCharCounts[r[0]] = (topCharCounts[r[0]] || 0) + 1;
    });

    const usedChars = new Set();
    players.forEach(p => {
      const r = rankedByPid[p.id];
      if (topCharCounts[r[0]] === 1) { map[p.id] = r[0]; usedChars.add(r[0]); }
    });

    players.forEach(p => {
      if (map[p.id]) return;
      const r = rankedByPid[p.id];
      if (r.length >= 2 && !usedChars.has(r[1])) { map[p.id] = r[1]; usedChars.add(r[1]); }
      else { const pick = r.find(c => !usedChars.has(c)) || r[1] || r[0]; map[p.id] = pick; usedChars.add(pick); }
    });
    return map;
  }

  function formatSkillTag(l, room) {
    if (!l) return '';
    if (l.fangTargetId) {
      const t = U.byId(room, l.fangTargetId);
      const tName = t ? t.name.slice(0, 3) : '';
      const thumb = l.fangCamp === 'good' ? '👍' : '👎';
      return `🔍${tName}${thumb}`;
    }
    return String(l.skillTag || '').replace(/^🔍驗/, '🔍');
  }

  UI.me = () => { const r = Net.room(); return r ? (U.byId(r, Net.myId) || null) : null; };

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
  UI.on('fill', () => Net.act(r => {
    if (r.players.length < 8) Engine.fillBots(r);
    return r.players.length === 8 && Engine.start(r);
  }));
  UI.on('color', id => Net.act(r => Engine.setColor(r, Net.myId, id)));

  const clampRound = (i, room) => U.clamp(i, 0, Math.max(0, room.rounds.length - 1));
  UI.on('vround', i => { S.voteRound = +i; renderVotes(Net.room()); });
  UI.on('vroundStep', d => { S.voteRound += +d; renderVotes(Net.room()); });
  UI.on('sround', i => { S.speechRound = +i; renderSpeeches(Net.room()); });
  UI.on('sroundStep', d => { S.speechRound += +d; renderSpeeches(Net.room()); });

  UI.on('seat', pid => {
    const room = Net.room(), me = UI.me(); if (!room || !me) return;
    const p = U.byId(room, pid); if (!p) return;
    if (room.status === 'playing' && room.currentTurnPlayerId === me.id && Engine.log(room, me.id).step === 'c' && !U.curRound(room).passOrder.includes(pid)) {
      return Net.act(r => Engine.pass(r, me.id, pid));
    }
    if (UI.insertDraft) UI.insertDraft(U.tag(p));
  });

  function handleKickAction(targetId) {
    const room = Net.room();
    if (!room) return;
    const target = U.byId(room, targetId);
    if (!target) return;
    const msg = (room.status === 'waiting' || room.status === 'gameover')
      ? `確定要將【${target.name}】踢出座位嗎？`
      : `確定要將【${target.name}】移至觀戰席，並交由隨機電腦接管嗎？`;
    if (confirm(msg)) {
      Net.act(r => Engine.kickPlayer(r, Net.myId, targetId)).then(ok => {
        if (ok && GD.Driver) {
          GD.Driver.reset();
          GD.Driver.schedule();
        }
      });
    }
  }

  UI.on('kick', (targetId, el, e) => {
    if (e) e.stopPropagation();
    handleKickAction(targetId);
  });

  // ★ 原生 Capture 攔截器：確保點擊座位右上角「✕」踢人按鈕時，100% 不會誤觸下層的 seat 點擊事件！
  document.addEventListener('click', e => {
    const kBtn = e.target && e.target.closest && e.target.closest('.gd-kick-btn');
    if (!kBtn) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const targetId = kBtn.getAttribute('data-kick-id');
    if (targetId) handleKickAction(targetId);
  }, true);

  UI.render = function () {
    const room = Net.room();
    if (!room || UI.byId('board').hidden) return;
    const me = UI.me(), rd = room.rounds[room.currentRoundIdx];

    if (S.lastGame !== room.gameId) { S.lastGame = room.gameId; S.voteRound = S.speechRound = room.currentRoundIdx; S.ballot = {}; }
    if (S.lastRound !== room.currentRoundIdx) { S.lastRound = room.currentRoundIdx; S.voteRound = S.speechRound = room.currentRoundIdx; S.ballot = {}; }

    // ★ 在「房號 9233・連線」旁邊顯示灰色觀戰者標籤
    const specs = room.spectators || [];
    const specHtml = specs.length
      ? `<span class="xs" style="margin-left:8px;color:#e5e7eb;font-weight:700;background:#6b7280;padding:2px 8px;border-radius:999px;display:inline-flex;align-items:center;gap:4px">👀 觀戰者：${specs.map(s => U.esc(s.name)).join('、')}</span>`
      : '';
    UI.html('bRoom', `房號 ${room.roomId}${Net.mode() === 'online' ? '・連線' : '・單人'}${specHtml}`);

    UI.text('bRound', rd ? `第 ${rd.roundNum} 回合` : '大廳準備中');
    UI.text('bPhase', PHASE[room.status] || '');
    UI.show('bFill', room.status === 'waiting' && !!me);
    if (room.status === 'waiting') {
      UI.text('bFill', room.players.length >= 8 ? '🎮 立即開始遊戲' : '🤖 補電腦開局');
    }
    UI.show('seatShift', room.status === 'waiting' && !!me);
    UI.show('colorBar', room.status === 'waiting' && !!me);

    const chips = UI.byId('bChips');
    chips.hidden = !(me && room.status !== 'waiting' && room.status !== 'gameover');
    if (me) chips.textContent = `🎟️ 可用籌碼 ${me.voteBank}`;
    UI.text('bRole', me && me.role ? (S.peek ? `🎴 我的身分：【${me.role}】` : '🎴 身分已隱藏（點擊查看）') : (me ? '🎴 等待發牌' : '👀 觀戰模式（無底牌）'));

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

  function renderIntel(room, me) {
    const box = UI.byId('intel');
    if (!me || !me.role) return UI.html(box, '<div class="panel-h"><span>🕵️ 個人掌眼筆記</span></div><div class="xs mute">觀戰模式或開局前不顯示個人底牌與暗技紀錄。</div>');
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

  function renderOval(room, me, rd) {
    const players = U.seated(room), mySeat = me ? me.seatIndex : 0;
    let status = '等待開局', tip = '中央四獸首鑑定台';
    const find = id => U.byId(room, id);
    if (room.status === 'playing' && rd) { const a = find(room.currentTurnPlayerId); status = a ? `📢 ${a.name} 查驗中` : '查驗中'; tip = `已驗 ${rd.passOrder.length}/8`; }
    else if (room.status === 'discussion') { const s = find(room.currentSpeakerId); status = s ? `🗣️ ${s.name} 發言中` : '陳詞'; tip = `${(rd.speechIndex || 0) + 1}/8`; }
    else if (room.status === 'voting') { status = rd.voteResults ? '📊 已開票' : '🗳️ 投票中'; tip = '剩餘票可累積'; }
    else if (room.status === 'person_voting') { status = '🎯 終局鑑人'; tip = '指認老朝奉'; }
    else if (room.status === 'gameover' && room.gameOver) { status = '🏆 終局揭曉'; tip = `總分 ${room.gameOver.totalScore} 分`; }

    let centerContentHtml = '';
    if (room.status === 'person_voting') {
      centerContentHtml = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px 8px;text-align:center">
        <div style="font-size:1.35rem;font-weight:900;color:var(--red);letter-spacing:2px">🎯 終局鑑人指認階段</div>
        <div class="xs b mute" style="margin-top:4px">三回合獸首鑑定已結束，請於下方操作台投出鑑人票</div>
      </div>`;
    } else if (room.status === 'gameover' && room.gameOver) {
      const xuWon = room.gameOver.xuWon;
      const winColor = xuWon ? '#15803d' : '#b91c1c';
      const winGlow = xuWon ? '0 0 18px rgba(34,197,94,0.65)' : '0 0 18px rgba(239,68,68,0.65)';
      centerContentHtml = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px 6px;text-align:center">
        <div style="font-size:26px;font-weight:900;color:${winColor};text-shadow:${winGlow};letter-spacing:2px;line-height:1.25">
          ${xuWon ? '🎉 許願陣營獲勝！' : '😈 老朝奉陣營獲勝！'}
        </div>
        <div class="mono b" style="font-size:16px;margin-top:4px;color:var(--ink)">總分 ${room.gameOver.totalScore} 分</div>
      </div>`;
    } else if (rd) {
      const log = (me && rd.turnLogs[me.id]) || { inspect: [], step: 'a' };
      const mine = me && room.status === 'playing' && room.currentTurnPlayerId === me.id && log.step === 'a';
      const quota = me ? Rules.inspectQuota(me) : 0;

      // ★ 關鍵修正（問題 3）：
      // 當該回合已開票 (rd.voteResults 存在) 時，中央牌桌必須嚴格依照「開票公開狀態」渲染：
      //   - 第一名 (rank1)：在桌上強制顯示「🥇封存」（絕不套用 real/fake 顏色，避免誤以為第一名被公開！）
      //   - 第二名 (rank2)：在桌上公開顯示「🥈公開真 / 假」與對應綠/紅底色。
      // 未開票前，才顯示玩家自己私下查驗的結果。
      const beastsHtml = rd.beasts.map(b => {
        const seen = me ? (log.inspect || []).find(i => i.beastName === b.name) : null;
        const canPick = mine && !seen && log.inspect.length < quota;
        let cls = '', sub = '未查驗';

        if (rd.voteResults) {
          if (rd.voteResults.rank1.name === b.name) {
            cls = ''; // 嚴格封存，不亮綠/紅底色
            sub = '🥇封存';
          } else if (rd.voteResults.rank2.name === b.name) {
            cls = rd.voteResults.rank2.isReal ? 'real' : 'fake';
            sub = '🥈公開' + (rd.voteResults.rank2.isReal ? '真' : '假');
          } else {
            cls = '';
            sub = '未入選';
          }
        } else if (seen) {
          cls = seen.displayedReal === true ? 'real' : seen.displayedReal === false ? 'fake' : '';
          sub = seen.displayedReal === true ? '✓真品' : seen.displayedReal === false ? '✕贗品' : '❓不明';
        } else if (canPick) {
          sub = '🔍點此查驗';
        }
        return `<button class="beast ${cls} ${canPick ? 'pick' : ''}" data-act="inspect" data-arg="${b.name}" title="點擊查驗或於發言框輸入「${b.name}】」" style="cursor:pointer"><b>${b.name}</b><i>${sub}</i></button>`;
      }).join('');
      centerContentHtml = `<div class="beasts">${beastsHtml}</div>`;
    } else {
      centerContentHtml = `<div class="beasts"><div style="grid-column:1/-1;text-align:center;font-size:11px;font-weight:800">開局後當場抽出四尊獸首</div></div>`;
    }

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

      const isWinner = room.status === 'gameover' && room.gameOver && p.role && (GD.isGood(p.role) === !!room.gameOver.xuWon);
      let winnerSeatHalo = '', winnerChipGlow = '', winnerRoleStyle = '';
      if (isWinner) {
        if (room.gameOver.xuWon) {
          winnerSeatHalo = 'background:radial-gradient(circle, rgba(34,197,94,0.55) 0%, rgba(16,185,129,0.28) 55%, transparent 76%);padding:6px;border-radius:16px;';
          winnerChipGlow = 'box-shadow:0 0 14px 4px rgba(34,197,94,0.9), 0 0 26px 8px rgba(16,185,129,0.55);outline:2.5px solid #4ade80;';
          winnerRoleStyle = 'background:#14532d;color:#fef3c7;border:1px solid #4ade80;box-shadow:0 0 8px rgba(34,197,94,0.8);';
        } else {
          winnerSeatHalo = 'background:radial-gradient(circle, rgba(239,68,68,0.58) 0%, rgba(185,28,28,0.3) 55%, transparent 76%);padding:6px;border-radius:16px;';
          winnerChipGlow = 'box-shadow:0 0 14px 4px rgba(239,68,68,0.92), 0 0 26px 8px rgba(185,28,28,0.6);outline:2.5px solid #f87171;';
          winnerRoleStyle = 'background:#7f1d1d;color:#fef3c7;border:1px solid #f87171;box-shadow:0 0 8px rgba(239,68,68,0.8);';
        }
      }

      // ★ 踢除按鈕：等待中可踢任何座位（清分身/電腦）；遊戲進行中房主也可點 ✕ 將斷線真人轉為電腦代打
      const canShowKick = (room.status === 'waiting') ||
                          (room.status !== 'gameover' && !p.isBot && me && (room.hostId === me.id || !isMe));
      const kickBtn = canShowKick
        ? `<button type="button" class="btn red gd-kick-btn" data-kick-id="${p.id}" title="${room.status === 'waiting' ? '踢除此座位玩家' : '將離線玩家轉交電腦接管'}" style="position:absolute;top:-10px;right:-10px;width:22px;height:22px;padding:0;line-height:20px;text-align:center;border-radius:50%;z-index:30;font-size:11px;font-weight:900;box-shadow:0 2px 5px rgba(0,0,0,0.45);cursor:pointer">✕</button>`
        : '';

      seats += `<div class="seat ${acting ? 'act' : ''}" style="left:${left}%;top:${top}%;${winnerSeatHalo}" data-act="seat" data-arg="${p.id}" title="點擊插入：${U.esc(U.tag(p))}">
        ${kickBtn}
        ${tail ? '<span class="mark tail">尾家</span>' : first ? '<span class="mark">⭐首家</span>' : ''}
        <div class="chip" style="background:${c.hex};color:${c.text};${winnerChipGlow}"><small>${c.short}${isMe ? '（我）' : ''}${p.isBot ? '' : ' 👤'}</small><span>${U.esc(p.name)}</span>${done ? '<div class="done">✓</div>' : ''}</div>
        ${showRole ? `<span class="role" style="${winnerRoleStyle}">${p.role}</span>` : ''}</div>`;
    }
    UI.html('oval', `<div class="felt"><div class="st"><span>${U.esc(status)}</span><span class="red">${U.esc(tip)}</span></div>${centerContentHtml}</div>${seats}`);
  }

  UI.on('inspect', name => {
    const room = Net.room(), me = UI.me();
    if (!room || !me) return;
    const rd = U.curRound(room);
    const log = (rd && rd.turnLogs && rd.turnLogs[me.id]) || { inspect: [], step: 'a' };
    const quota = Rules.inspectQuota(me);
    const canInspectNow = room.status === 'playing' && room.currentTurnPlayerId === me.id && log.step === 'a' &&
      !(log.inspect || []).some(i => i.beastName === name) && (log.inspect || []).length < quota;

    if (canInspectNow) return Net.act(r => Engine.inspect(r, me.id, name));
    if (UI.insertDraft) UI.insertDraft(`${name}】`);
  });

  function renderColors(room, me) {
    if (room.status !== 'waiting' || !me) return;
    const used = {}; room.players.forEach(p => { used[p.colorId] = p; });
    UI.html('colors', GD.SEAL_COLORS.map(c => {
      const o = used[c.id], blocked = o && o.id !== me.id && !o.isBot;
      return `<button class="${me.colorId === c.id ? 'mine' : ''}" ${blocked ? 'disabled' : ''} data-act="color" data-arg="${c.id}" style="background:${c.hex};color:${c.text}">${c.short}${me.colorId === c.id ? '✓' : ''}</button>`;
    }).join(''));
  }

  function renderChains(room, me) {
    const over = room.status === 'gameover';
    const charMap = buildPlayerCharMap(room);
    const colsHtml = [0, 1, 2].map(i => {
      const rd = room.rounds[i];
      if (!rd || !rd.passOrder.length) {
        return `<div class="note" style="display:flex;flex-direction:column;align-items:center;padding:6px 4px;min-width:0">
          <div class="xs b" style="margin-bottom:4px">R${i + 1}</div>
          <div class="xs mute">未開始</div>
        </div>`;
      }
      const nodes = rd.passOrder.map((pid, k) => {
        const p = U.byId(room, pid); if (!p) return '';
        const c = U.colorOf(p);
        const ch = charMap[p.id] || rankedCharsOf(p)[0];
        const l = rd.turnLogs[pid], see = over || (me && me.id === pid);
        const cur = room.status === 'playing' && room.currentRoundIdx === i && room.currentTurnPlayerId === pid;
        const ringStyle = cur
          ? 'outline:2.5px solid #dc2626;box-shadow:0 0 8px rgba(220,38,38,0.85);transform:scale(1.08);'
          : 'border:1.5px solid rgba(30,22,16,0.65);';

        const sTag = formatSkillTag(l, room);
        const isFangSkill = !!(l && (l.fangTargetId || String(sTag).startsWith('🔍')));
        const badgeBg = isFangSkill ? '#14532d' : '#7f1d1d';
        const skillBadge = (see && sTag)
          ? `<span style="font-size:16px;font-weight:900;background:${badgeBg};color:#fef3c7;padding:2px 6px;border-radius:5px;white-space:nowrap;line-height:1.25;box-shadow:0 1px 3px rgba(0,0,0,0.35)">${U.esc(sTag)}</span>`
          : '';

        let affectedIcons = '';
        if (over && l) {
          const insList = l.inspect || [];
          const wasBlinded = !!(l.blind || insList.some(x => x.kind === 'blind'));
          const wasBlocked = insList.some(x => x.kind === 'blocked');
          const laoIdx = rd.passOrder.findIndex(id => rd.turnLogs[id] && rd.turnLogs[id].skillTag === '🎭擾亂');
          const wasFlipped = insList.some(x => x.flipped === true || (
            x.kind === 'ok' && rd.laoActive && laoIdx >= 0 && k > laoIdx && GD.isGood(p.role) && p.role !== '姬雲浮'
          ));
          const icons = [];
          if (wasBlinded) icons.push('<span title="實際受到偷襲技能影響" style="background:transparent;font-size:17px;line-height:1">🙈</span>');
          if (wasBlocked) icons.push('<span title="實際受到封印技能影響" style="background:transparent;font-size:17px;line-height:1">⛓️</span>');
          if (wasFlipped) icons.push('<span title="實際受到擾亂技能影響" style="background:transparent;font-size:17px;line-height:1">🎭</span>');
          if (icons.length) {
            affectedIcons = `<span style="display:inline-flex;align-items:center;gap:2px;background:transparent">${icons.join('')}</span>`;
          }
        }

        const arrowDown = k < rd.passOrder.length - 1 ? `<div class="mute" style="font-size:10px;line-height:1;margin:1px 0">↓</div>` : '';
        return `<div style="display:flex;flex-direction:column;align-items:center">
          <div style="display:flex;align-items:center;justify-content:center;gap:3px;flex-wrap:wrap">
            <span data-act="seat" data-arg="${p.id}" title="${U.esc(c.name + '・' + p.name)}（第 ${k + 1} 棒）"
              style="width:28px;height:28px;border-radius:50%;background:${c.hex};color:${c.text};display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;cursor:pointer;flex-shrink:0;${ringStyle}">${U.esc(ch)}</span>
            ${affectedIcons}
            ${skillBadge}
          </div>
          ${arrowDown}
        </div>`;
      }).join('');
      return `<div class="note" style="display:flex;flex-direction:column;align-items:center;padding:6px 4px;min-width:0">
        <div class="xs b" style="margin-bottom:4px;border-bottom:1px dashed rgba(0,0,0,0.2);width:100%;text-align:center;padding-bottom:2px">R${i + 1}</div>
        <div style="display:flex;flex-direction:column;align-items:center;width:100%">${nodes}</div>
      </div>`;
    }).join('');

    UI.html('chains', `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;align-items:start">${colsHtml}</div>`);
  }

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

  function renderSpeeches(room) {
    if (!room || !room.rounds.length) { UI.html('speechPager', ''); return UI.html('speechBody', '<div class="xs mute">開局後，全場發言與系統摘要會即時記錄在這裡。</div>'); }
    S.speechRound = clampRound(S.speechRound, room);
    const rd = room.rounds[S.speechRound];
    UI.html('speechPager', UI.pager('sround', S.speechRound, room.rounds.length));
    UI.html('speechBody', rd.speeches.length ? rd.speeches.map(sp => {
      const p = U.byId(room, sp.playerId);
      const isHuman = p ? !p.isBot : (sp.source === 'human');
      const fixedSummary = (p && p.isBot && sp.summary) ? sp.summary.replace('[真人]', '[電腦]') : sp.summary;
      return `<div class="say ${isHuman ? 'human' : ''} ${sp.source === 'gemini' ? 'gem' : ''}">
        <div class="row between">${p ? UI.seal(p, `data-act="seat" data-arg="${p.id}" style="cursor:pointer"`) : ''}<span class="xs mono mute">R${rd.roundNum} ${U.esc(sp.time || '')}</span></div>
        <div class="sum">📌 ${U.esc(fixedSummary)}</div><div class="sm">${U.esc(sp.text)}</div></div>`;
    }).join('') : `<div class="xs mute center" style="padding:20px 0">第 ${rd.roundNum} 回合尚無發言</div>`);
  }

  /* ★ 啟動 AFK 防發呆倒數與換人系統 */
  clearInterval(afkInterval);
  afkInterval = setInterval(checkAFK, 1000);

})(window.GD);