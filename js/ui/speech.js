/* ============================================================================
 * ui/speech.js — 發言面板
 *   1) 打字與快捷詞區常駐展開，非自己回合也能隨時打字或點選快捷詞/座位預備草稿。
 *   2) 還沒輪到自己時，「送出發言」與「直接過」按鈕同麥克風一樣呈現淡色鎖定狀態。
 *   3) 輪到自己並按下「送出發言」時，觸發 2.5 秒延遲倒數動畫（可立即送出或取消）。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, UI, Net, Engine, Voice } = GD;

  let myTurn = false;
  let sendTimer = null;
  let activeVoiceMode = null;
  let pendingVoiceCommand = null;

  const mic = () => UI.byId('mic');

  function cancelPendingSend() {
    if (sendTimer) {
      clearTimeout(sendTimer);
      sendTimer = null;
    }
    const sendBar = UI.byId('sendBar');
    if (sendBar) {
      sendBar.classList.remove('counting');
      sendBar.hidden = true;
    }
  }

  /* ---------------- 渲染 ---------------- */
  UI.renderSpeechPanel = function (room, me, rd) {
    const sp = U.byId(room, room.currentSpeakerId);
    const nowMyTurn = !!(me && room.status === 'discussion' && sp && sp.id === me.id);
    if (!nowMyTurn && myTurn) {
      cancelPendingSend();
    }
    myTurn = nowMyTurn;

    const hint = UI.byId('turnHint');
    let t = '非發言階段，您可先在下方預打草稿，輪到您時即可送出。';
    if (room.status === 'discussion') {
      t = myTurn
        ? '📢 輪到您了！可使用語音或下方打字框，確認後按「送出發言」。'
        : `🗣️ 目前由【${sp ? sp.name : ''}】發言，您可先在下方預打草稿。`;
    } else if (room.status === 'voting' || room.status === 'person_voting') {
      t = '發言已結束，請在操作台進行投票。';
    }
    if (hint && hint.textContent !== t) hint.textContent = t;
    if (hint) hint.className = 'note' + (myTurn ? ' evil' : '');

    // 麥克風狀態
    const m = mic();
    if (m) {
      m.disabled = !myTurn || !Voice.supported;
      if (!Voice.isListening()) {
        m.textContent = !Voice.supported ? '🎙️ 此瀏覽器不支援語音（請直接打字）' : '🎙️ 點擊開啟語音輸入（轉文字）';
      }
    }

    // 送出發言與直接過按鈕：還沒輪到時鎖定並轉淡色
    const btnType = UI.byId('btnSpeakType');
    const btnPass = UI.byId('btnSpeakPass');
    [btnType, btnPass].forEach(btn => {
      if (!btn) return;
      btn.disabled = !myTurn;
      btn.style.opacity = myTurn ? '1' : '0.4';
      btn.style.cursor = myTurn ? 'pointer' : 'not-allowed';
    });

    // 房內字幕與語音控制：只有遊戲進行中、本人為真人玩家時可用。
    const activeRoom = ['playing', 'discussion', 'voting', 'person_voting'].includes(room.status);
    const canVoice = !!(me && !me.isBot && activeRoom && Voice.supported);
    const subtitleBtn = UI.byId('voiceSubtitleBtn');
    const commandBtn = UI.byId('voiceCommandBtn');
    if (subtitleBtn) { subtitleBtn.disabled = !canVoice; subtitleBtn.classList.toggle('on', activeVoiceMode === 'subtitle'); }
    if (commandBtn) { commandBtn.disabled = !canVoice; commandBtn.classList.toggle('on', activeVoiceMode === 'command'); }
    renderVoiceTranscriptLog(room, rd || U.curRound(room));

    // 常駐顯示打字與快捷詞區
    const typeBox = UI.byId('typeBox');
    if (typeBox) UI.show(typeBox, true);

    const curRd = rd || U.curRound(room);
    UI.html('quick', curRd && curRd.beasts ? [
      ...curRd.beasts.flatMap(b => [
        `<button class="btn jade" data-act="quick" data-arg="【${b.name}】真，">${b.name}真</button>`,
        `<button class="btn red" data-act="quick" data-arg="【${b.name}】假，">${b.name}假</button>`
      ]),
      '<button class="btn" data-act="quick" data-arg="我驗不到，">我驗不到</button>',
      '<button class="btn" data-act="quick" data-arg="我被偷襲，">我被偷襲</button>',
      '<button class="btn" data-act="quick" data-arg="大家一起投【">號召投…</button>',
      '<button class="btn" data-act="quick" data-arg="大家一起集火">號召集火</button>'
    ].join('') : '');
  };

  GD.bus.on('thinking', t => UI.text('thinking', t ? `🤖 ${t.name} ${t.via === 'gemini' ? '正透過 Gemini 思考…' : '思考中…'}` : ''));

  /* ---------------- 語音模式 ---------------- */
  function stopActiveVoice() {
    if (Voice.isListening()) Voice.stop();
  }

  function startVoiceMode(mode, callback) {
    if (Voice.isListening()) Voice.abort();
    activeVoiceMode = mode;
    const ok = Voice.start((text, finalText) => {
      const completedMode = activeVoiceMode;
      activeVoiceMode = null;
      refreshVoiceButtons();
      callback(text, finalText, completedMode);
    });
    if (!ok) activeVoiceMode = null;
    refreshVoiceButtons();
    return ok;
  }

  function refreshVoiceButtons() {
    const micButton = mic();
    const subtitleBtn = UI.byId('voiceSubtitleBtn');
    const commandBtn = UI.byId('voiceCommandBtn');
    if (micButton) {
      micButton.classList.toggle('live', activeVoiceMode === 'draft' && Voice.isListening());
      if (!Voice.isListening() || activeVoiceMode !== 'draft') {
        micButton.textContent = !Voice.supported ? '🎙️ 此瀏覽器不支援語音（請直接打字）' : '🎙️ 點擊開啟語音輸入（轉文字）';
      } else micButton.textContent = '⏹️ 停止收音並轉入陳詞草稿';
    }
    if (subtitleBtn) subtitleBtn.textContent = activeVoiceMode === 'subtitle' && Voice.isListening() ? '⏹️ 停止字幕收音' : '🎧 公開語音字幕';
    if (commandBtn) commandBtn.textContent = activeVoiceMode === 'command' && Voice.isListening() ? '⏹️ 停止語音操作' : '🎮 語音操作';
  }

  function toggleMic(e) {
    if (e) e.preventDefault();
    if (!myTurn) return UI.toast('還沒輪到您發言，可先在下方打字預備', 'warn');
    if (activeVoiceMode === 'draft' && Voice.isListening()) return stopActiveVoice();
    if (Voice.isListening()) return UI.toast('請先停止目前的語音模式，再切換陳詞輸入。', 'warn');
    startVoiceMode('draft', onTranscript);
  }

  function bindMic() {
    const m = mic();
    if (!m) return;
    m.addEventListener('click', toggleMic);
    m.addEventListener('contextmenu', e => e.preventDefault());
  }

  GD.bus.on('voiceend', () => {
    if (!Voice.isListening()) { activeVoiceMode = null; refreshVoiceButtons(); }
  });

  GD.bus.on('voice', v => {
    const live = UI.byId('liveText');
    if (live) {
      live.hidden = !v.listening && !v.interim;
      if (v.listening) {
        const label = activeVoiceMode === 'subtitle' ? '公開字幕辨識中' : activeVoiceMode === 'command' ? '語音指令辨識中' : '陳詞辨識中';
        live.textContent = v.interim ? `🎙️ ${label}：${v.interim}` : `🟢 ${label}，說完再按一次同一按鈕停止。`;
      }
    }
    refreshVoiceButtons();
  });
  GD.bus.on('voiceerror', msg => { UI.toast(msg, 'warn'); });

  /* ---------------- 逐字稿 → 自動校正並填入 #draft 輸入框 ---------------- */
  function onTranscript(raw) {
    const live = UI.byId('liveText');
    if (live) live.hidden = true;
    if (!raw || raw.replace(/\s/g, '').length < 1) return UI.toast('沒有聽到清楚內容，可再點一下麥克風重說或直接打字', 'warn');

    const corrected = Voice.correct ? Voice.correct(raw.trim()) : raw.trim();
    const ta = UI.byId('draft');
    if (ta) {
      const prev = ta.value.trim();
      ta.value = prev ? (prev + (/[，。！？、]$/.test(prev) ? '' : '，') + corrected) : corrected;
      ta.focus();
    }
    UI.toast('✓ 語音已轉為文字填入下方輸入框，請確認後按「送出發言」', 'ok');
  }

  /* ---------------- 預打草稿與 2.5 秒延遲送出 ---------------- */
  // 允許隨時插入快捷詞或點擊座位色名（不受 myTurn 限制）
  UI.insertDraft = txt => {
    const ta = UI.byId('draft');
    if (!ta) return;
    ta.value = Voice.correct ? Voice.correct((ta.value || '') + txt) : ((ta.value || '') + txt);
    ta.focus();
  };
  UI.on('quick', t => UI.insertDraft(t));

  async function executeSendSpeech() {
    cancelPendingSend();
    const room = Net.room(), me = UI.me(), ta = UI.byId('draft');
    if (!myTurn || !me || !room) return UI.toast('還沒輪到您發言', 'warn');
    if (Voice.isListening()) {
      if (activeVoiceMode === 'draft') { Voice.stop(); return UI.toast('先等語音辨識完成，再按一次送出。', 'warn'); }
      Voice.abort(); activeVoiceMode = null;
    }
    const raw = (ta ? ta.value.trim() : '');
    if (!raw) return UI.toast('請先輸入或語音說出您的發言內容，再按送出（若不發言請按「直接過」）', 'warn');
    const { text, summary } = Voice.prepare(raw, room);
    const ok = await Net.act(r => Engine.speak(r, me.id, { text, summary, source: 'human' }));
    if (ok) {
      if (ta) ta.value = '';
      const live = UI.byId('liveText');
      if (live) live.hidden = true;
      UI.toast('✓ 發言已送出！', 'ok');
    } else {
      UI.toast('送出失敗，請再點一次送出發言', 'warn');
    }
  }

  function startDelayedSend() {
    const room = Net.room(), me = UI.me(), ta = UI.byId('draft');
    if (!myTurn || !me || !room) return UI.toast('還沒輪到您發言，草稿已保留', 'warn');
    if (Voice.isListening()) {
      if (activeVoiceMode === 'draft') { Voice.stop(); return UI.toast('先等語音辨識完成，再按一次送出。', 'warn'); }
      Voice.abort(); activeVoiceMode = null;
    }
    const raw = (ta ? ta.value.trim() : '');
    if (!raw) return UI.toast('請先輸入或語音說出您的發言內容，再按送出（若不發言請按「直接過」）', 'warn');

    cancelPendingSend();
    const sendBar = UI.byId('sendBar');
    if (sendBar) {
      sendBar.hidden = false;
      // 觸發重繪以重新播放 2.5 秒 CSS 動畫
      void sendBar.offsetWidth;
      sendBar.classList.add('counting');
    }
    sendTimer = setTimeout(() => {
      executeSendSpeech();
    }, 2500);
  }

  UI.on('speakType', startDelayedSend);
  UI.on('sendNow', executeSendSpeech);
  UI.on('sendCancel', () => {
    cancelPendingSend();
    if (Voice.isListening()) Voice.abort();
    activeVoiceMode = null;
    const live = UI.byId('liveText');
    if (live) live.hidden = true;
    UI.toast('已取消送出，您可繼續修改草稿', 'warn');
  });

  UI.on('speakPass', () => {
    cancelPendingSend();
    const me = UI.me();
    if (!myTurn || !me) return UI.toast('還沒輪到您發言', 'warn');
    if (Voice.isListening()) Voice.abort();
    activeVoiceMode = null;
    Net.act(r => Engine.speak(r, me.id, { text: '', pass: true, source: 'human' }));
  });


  function renderVoiceTranscriptLog(room, rd) {
    const box = UI.byId('voiceTranscriptLog');
    if (!box) return;
    const rows = (rd && Array.isArray(rd.voiceTranscripts) ? rd.voiceTranscripts : []).slice(-8);
    UI.html(box, rows.map(item => {
      const player = U.byId(room, item.playerId) || { name: item.speakerName || '玩家', colorId: item.colorId };
      const tag = U.esc(player.name || '玩家');
      const color = U.colorOf(player);
      const stamp = new Date(Number(item.createdAt) || Date.now()).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
      return `<div class="voice-transcript-row"><div class="voice-transcript-meta"><span style="color:${U.esc(color.hex)}">${tag}</span><time>${U.esc(stamp)}</time></div><div>${U.esc(item.text || '')}</div></div>`;
    }).join(''));
  }

  async function onPublicSubtitle(raw, finalText) {
    const text = Voice.correct(String(finalText || '').trim());
    if (text.replace(/\s/g, '').length < 2) return UI.toast('這段語音沒有完整辨識結果，未發布字幕。', 'warn');
    const ok = await Net.publishVoiceTranscript(text);
    if (ok) {
      const room = Net.room();
      renderVoiceTranscriptLog(room, U.curRound(room));
      UI.toast('公開字幕已同步給房內玩家，AI 會在下一次決策時讀取。', 'ok');
    } else UI.toast('字幕未送出：請確認仍在遊戲房間，並稍後再試。', 'warn');
  }

  function showPendingVoiceCommand(command) {
    pendingVoiceCommand = { ...command, roomId: (Net.room() || {}).roomId, playerId: (UI.me() || {}).id };
    const panel = UI.byId('voiceCommandPanel');
    if (!panel) return;
    UI.html(panel, `<div class="voice-command-title">🎮 語音指令待確認</div><div>${U.esc(command.label || '執行遊戲操作')}</div><div class="row wrap mt"><button class="btn jade" data-act="voiceCommandConfirm">確認執行</button><button class="btn red" data-act="voiceCommandCancel">取消</button></div>`);
    UI.show(panel, true);
  }

  function clearPendingVoiceCommand() {
    pendingVoiceCommand = null;
    const panel = UI.byId('voiceCommandPanel');
    if (panel) { UI.show(panel, false); UI.html(panel, ''); }
  }

  async function executePendingVoiceCommand() {
    const command = pendingVoiceCommand;
    const room = Net.room(), me = UI.me();
    if (!command || !room || !me || command.roomId !== room.roomId || command.playerId !== me.id) {
      clearPendingVoiceCommand();
      return UI.toast('指令已失效，請重新說一次。', 'warn');
    }
    if (Voice.isListening()) Voice.abort();
    clearPendingVoiceCommand();
    let ok = false;
    try {
      if (command.type === 'sendSpeech') return executeSendSpeech();
      if (command.type === 'inspect') {
        const rd = U.curRound(room);
        if (room.status !== 'playing' || room.currentTurnPlayerId !== me.id || Engine.log(room, me.id).step !== 'a') throw new Error('現在不是你的查驗階段。');
        ok = await Net.act(r => Engine.inspect(r, me.id, command.beast));
      } else if (command.type === 'skill') {
        const log = Engine.log(room, me.id);
        if (room.status !== 'playing' || room.currentTurnPlayerId !== me.id || log.step !== 'b') throw new Error('現在不是你的技能操作階段。');
        const expectedRole = { lao: '老朝奉', zheng: '鄭國渠', yao: '藥不然', fang: '方震' }[command.kind];
        if (me.role !== expectedRole) throw new Error(`目前角色不是${expectedRole}，不能執行這項技能。`);
        const action = command.kind === 'lao' ? { kind: 'lao', active: true }
          : command.kind === 'zheng' ? { kind: 'zheng', beast: command.beast }
          : { kind: command.kind, targetId: command.targetId };
        ok = await Net.act(r => Engine.skill(r, me.id, action));
      } else if (command.type === 'pass') {
        const rd = U.curRound(room);
        if (room.status !== 'playing' || room.currentTurnPlayerId !== me.id || Engine.log(room, me.id).step !== 'c') throw new Error('現在還不能傳牌。');
        if (!Engine.remainingToAct(room).some(player => player.id === command.targetId)) throw new Error('這位玩家已經行動，不能再傳給他。');
        ok = await Net.act(r => Engine.pass(r, me.id, command.targetId));
      } else if (command.type === 'vote') {
        if (room.status !== 'voting') throw new Error('現在不是投票階段。');
        const available = Engine.availableChips(room, me.id);
        const spent = Object.values(command.ballot || {}).reduce((sum, n) => sum + Number(n || 0), 0);
        if (spent > available) throw new Error(`你目前只有 ${available} 枚可用籌碼。`);
        const rd = U.curRound(room);
        if (rd.votes && rd.votes[me.id] !== undefined) throw new Error('本輪已經投過票，不能再次提交。');
        ok = await Net.act(r => Engine.vote(r, me.id, command.ballot || {}));
      } else if (command.type === 'personVote') {
        if (room.status !== 'person_voting') throw new Error('現在不是終局鑑人階段。');
        if (command.targetId === me.id) throw new Error('不能指認自己。');
        ok = await Net.act(r => Engine.personVote(r, me.id, command.targetId));
      }
      if (!ok) throw new Error('遊戲核心拒絕了這項操作，可能是階段、技能或目標不符合規則。');
      UI.toast(`✓ 已執行：${command.label || '語音操作'}`, 'ok');
    } catch (err) {
      UI.toast(err && err.message ? err.message : '語音操作失敗。', 'warn');
    }
  }

  function onVoiceCommand(raw, finalText) {
    const phrase = String(finalText || '').trim();
    if (!phrase) return UI.toast('沒有辨識到完整指令。', 'warn');
    const command = (Voice.CommandInterceptor ? Voice.CommandInterceptor.parse : Voice.parseCommand)(phrase, Net.room(), UI.me());
    if (command.type === 'confirm') {
      if (!pendingVoiceCommand) return UI.toast('目前沒有待確認的語音指令。', 'warn');
      return executePendingVoiceCommand();
    }
    if (command.type === 'cancel') {
      clearPendingVoiceCommand();
      return UI.toast('已取消語音指令。', 'warn');
    }
    if (command.type === 'speechDraft') {
      UI.insertDraft(command.text);
      return UI.toast(command.label, 'ok');
    }
    if (command.type === 'invalid') return UI.toast(command.reason, 'warn');
    showPendingVoiceCommand(command);
  }

  function bindVoiceButton(id, mode, callback) {
    const button = UI.byId(id);
    if (!button) return;
    button.addEventListener('click', () => {
      const room = Net.room(), me = UI.me();
      if (!room || !me || me.isBot || !['playing', 'discussion', 'voting', 'person_voting'].includes(room.status)) {
        return UI.toast('請先加入正在進行的遊戲房間。', 'warn');
      }
      if (!Voice.supported) return UI.toast('此瀏覽器不支援語音辨識，請改用 Chrome／Edge 或文字輸入。', 'warn');
      if (activeVoiceMode === mode && Voice.isListening()) return stopActiveVoice();
      if (Voice.isListening()) return UI.toast('請先停止目前的語音模式，再切換字幕或指令。', 'warn');
      startVoiceMode(mode, callback);
    });
  }

  UI.on('voiceCommandConfirm', executePendingVoiceCommand);
  UI.on('voiceCommandCancel', () => { clearPendingVoiceCommand(); UI.toast('已取消語音指令。', 'warn'); });
  bindVoiceButton('voiceSubtitleBtn', 'subtitle', onPublicSubtitle);
  bindVoiceButton('voiceCommandBtn', 'command', onVoiceCommand);
  function stopVoiceCapture() {
    if (Voice.isListening()) Voice.abort();
    activeVoiceMode = null;
    clearPendingVoiceCommand();
    refreshVoiceButtons();
    const live = UI.byId('liveText');
    if (live) live.hidden = true;
  }
  GD.bus.on('room', room => {
    if (!room) return;
    renderVoiceTranscriptLog(room, U.curRound(room));
    if (room.status === 'gameover' || room.status === 'waiting') stopVoiceCapture();
  });
  GD.bus.on('left', stopVoiceCapture);
  bindMic();
})(window.GD);