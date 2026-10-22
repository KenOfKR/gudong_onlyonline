/* ============================================================================
 * ui/speech.js — 發言面板（按住說話 + 打字備援）
 *
 * 流程：按住 🎙️ → 即時顯示逐字稿 → 放開 → 校正 + 摘要 → 緩衝條（可取消）→ Engine.speak 發布。
 * 發布到房間的資料同時含「原文」與「重點摘要」，電腦玩家與其他真人讀到的是同一份。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, UI, Net, Engine, Voice } = GD;
  const C = GD.CONFIG;

  let pending = null;             // {text, summary, timer} 等待自動送出的發言
  let myTurn = false;

  const mic = () => UI.byId('mic');

  /* ---------------- 渲染 ---------------- */
  UI.renderSpeechPanel = function (room, me, rd) {
    const sp = U.byId(room, room.currentSpeakerId);
    myTurn = !!(me && room.status === 'discussion' && sp && sp.id === me.id);
    const hint = UI.byId('turnHint');
    let t = '發言階段才能使用麥克風。';
    if (room.status === 'discussion') t = myTurn ? '📢 輪到您了！按住下方按鈕說話，放開即自動發布重點摘要。' : `🗣️ 目前由【${sp ? sp.name : ''}】發言，請先聆聽。`;
    else if (room.status === 'voting' || room.status === 'person_voting') t = '發言已結束，請在左側操作台投票。';
    if (hint.textContent !== t) hint.textContent = t;
    hint.className = 'note' + (myTurn ? ' evil' : '');

    const m = mic();
    m.disabled = !myTurn || !Voice.supported || !!pending;
    if (!Voice.isListening()) m.textContent = !Voice.supported ? '🎙️ 此瀏覽器不支援語音（請用打字）' : '🎙️ 按住說話';
    UI.show('typeBox', true);
    if (myTurn && !Voice.supported) UI.byId('typeBox').open = true;
    UI.html('quick', rd ? [
      ...rd.beasts.flatMap(b => [`<button class="btn jade" data-act="quick" data-arg="【${b.name}】真，">${b.name}真</button>`, `<button class="btn red" data-act="quick" data-arg="【${b.name}】假，">${b.name}假</button>`]),
      '<button class="btn" data-act="quick" data-arg="我驗不到，">我驗不到</button>',
      '<button class="btn" data-act="quick" data-arg="我被偷襲，">我被偷襲</button>',
      '<button class="btn" data-act="quick" data-arg="大家一起投【">號召投…</button>',
      '<button class="btn" data-act="quick" data-arg="大家一起集火">號召集火</button>'
    ].join('') : '');
  };

  GD.bus.on('thinking', t => UI.text('thinking', t ? `🤖 ${t.name} ${t.via === 'gemini' ? '正透過 Gemini 思考…' : '思考中…'}` : ''));

  /* ---------------- 按住說話 ---------------- */
  function down(e) {
    if (e) e.preventDefault();
    if (!myTurn || pending || Voice.isListening()) return;
    Voice.start(onTranscript);
  }
  function up() { if (Voice.isListening()) Voice.stop(); }

  function bindMic() {
    const m = mic();
    m.addEventListener('pointerdown', down);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => m.addEventListener(ev, up));
    m.addEventListener('contextmenu', e => e.preventDefault());
    m.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });   // 無障礙：鍵盤也能按住說話
    m.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') up(); });
  }

  GD.bus.on('voice', v => {
    const m = mic(), live = UI.byId('liveText');
    m.classList.toggle('live', v.listening);
    if (v.listening) m.textContent = '🟢 收音中…放開即送出';
    live.hidden = !v.listening && !v.interim;
    if (v.listening) live.textContent = v.interim || '請開始說話…';
  });
  GD.bus.on('voiceerror', msg => { UI.toast(msg, 'warn'); UI.byId('typeBox').open = true; });

  /* ---------------- 逐字稿 → 摘要 → 緩衝 → 發布 ---------------- */
  function onTranscript(raw) {
    const room = Net.room();
    UI.byId('liveText').hidden = true;
    if (!raw || raw.replace(/\s/g, '').length < 2) return UI.toast('沒有聽到內容，請再按住說一次', 'warn');
    if (!room || !myTurn) return;
    const { text, summary } = Voice.prepare(raw, room);
    stage(text, summary);
  }

  function stage(text, summary) {
    cancel();
    UI.byId('sendBar').hidden = false;
    UI.byId('sendBar').querySelector('i').style.setProperty('--ms', C.SPEECH_SEND_DELAY_MS + 'ms');
    UI.byId('liveText').hidden = false;
    UI.byId('liveText').innerHTML = `<div class="xs" style="color:#fde68a">📌 ${U.esc(summary)}</div><div>${U.esc(text)}</div>`;
    UI.byId('sendBar').querySelector('i').style.animation = 'none';
    void UI.byId('sendBar').offsetWidth;
    UI.byId('sendBar').querySelector('i').style.animation = '';
    pending = { text, summary, timer: setTimeout(publish, C.SPEECH_SEND_DELAY_MS) };
    mic().disabled = true;
  }
  function cancel() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    UI.byId('sendBar').hidden = true;
  }
  async function publish() {
    if (!pending) return;
    const { text, summary } = pending;
    cancel();
    const me = UI.me();
    const ok = me && await Net.act(r => Engine.speak(r, me.id, { text, summary, source: 'human' }));
    UI.byId('liveText').hidden = true;
    if (ok) UI.toast('已發布重點摘要', 'ok');
    else UI.toast('目前不是您的發言時間', 'warn');
  }
  UI.on('sendNow', publish);
  UI.on('sendCancel', () => { cancel(); UI.byId('liveText').hidden = true; UI.toast('已取消，可重新說話或改用打字'); UI.render(); });

  /* ---------------- 打字備援 ---------------- */
  UI.insertDraft = txt => {
    const ta = UI.byId('draft'); if (!ta || !myTurn) return;
    ta.value = Voice.correct((ta.value || '') + txt);
    UI.byId('typeBox').open = true;
    ta.focus();
  };
  UI.on('quick', t => UI.insertDraft(t));
  UI.on('speakType', () => {
    const room = Net.room(), ta = UI.byId('draft');
    if (!myTurn) return UI.toast('還沒輪到您發言', 'warn');
    const raw = ta.value.trim() || '這輪我依自己的查驗結果落票，大家看票型。';
    const { text, summary } = Voice.prepare(raw, room);
    ta.value = '';
    stage(text, summary);
  });
  UI.on('speakPass', () => {
    const me = UI.me();
    if (!myTurn) return UI.toast('還沒輪到您發言', 'warn');
    Net.act(r => Engine.speak(r, me.id, { text: '', pass: true, source: 'human' }));
  });

  bindMic();
})(window.GD);
