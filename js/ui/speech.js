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

  /* ---------------- 點擊開關式語音收音（Toggle Mic） ---------------- */
  function toggleMic(e) {
    if (e) e.preventDefault();
    if (!myTurn) return UI.toast('還沒輪到您發言，可先在下方打字預備', 'warn');
    if (Voice.isListening()) {
      Voice.stop();
    } else {
      Voice.start(onTranscript);
    }
  }

  function bindMic() {
    const m = mic();
    if (!m) return;
    m.addEventListener('click', toggleMic);
    m.addEventListener('contextmenu', e => e.preventDefault());
  }

  GD.bus.on('voice', v => {
    const m = mic(), live = UI.byId('liveText');
    if (!m || !live) return;
    m.classList.toggle('live', v.listening);
    if (v.listening) {
      m.textContent = '⏹️ 收音中… 點擊停止收音（轉入下方文字框）';
    } else {
      m.textContent = !Voice.supported ? '🎙️ 此瀏覽器不支援語音（請直接打字）' : '🎙️ 點擊開啟語音輸入（轉文字）';
    }
    live.hidden = !v.listening && !v.interim;
    if (v.listening) {
      live.textContent = v.interim ? `🎙️ 辨識中：${v.interim}` : '🟢 麥克風已開啟，請開始說話（說完請再點一下按鈕停止）…';
    }
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
    if (Voice.isListening()) Voice.stop();
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
    if (Voice.isListening()) Voice.stop();
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
    if (Voice.isListening()) Voice.stop();
    const live = UI.byId('liveText');
    if (live) live.hidden = true;
    UI.toast('已取消送出，您可繼續修改草稿', 'warn');
  });

  UI.on('speakPass', () => {
    cancelPendingSend();
    const me = UI.me();
    if (!myTurn || !me) return UI.toast('還沒輪到您發言', 'warn');
    if (Voice.isListening()) Voice.stop();
    Net.act(r => Engine.speak(r, me.id, { text: '', pass: true, source: 'human' }));
  });

  bindMic();
})(window.GD);