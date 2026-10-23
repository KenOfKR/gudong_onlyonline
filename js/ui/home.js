/* ============================================================================
 * ui/home.js — 首頁：角色圖鑑、暱稱/房號、開局入口、進行中房間列表、登入、設定
 *              ＋ 開場置中無邊框有聲影片 (goodong.mp4)
 *              ＋ 大廳專屬可拖曳漂浮半透明《破局》MP3 音樂播放器
 *              ＋ 規則書下方可摺疊《破局》歌詞面板
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, UI, Net } = GD;
  const C = GD.CONFIG;
  let gi = 0;

  /* ==========================================================================
   * 🎬 開場無邊框影片 (goodong.mp4) ＆ 🎵 大廳專屬可拖曳漂浮《破局》播放器
   * ======================================================================== */
  const VIDEO_SOURCES = ['goodong.mp4', 'assets/goodong.mp4', 'goodong.webm'];
  const AUDIO_SOURCES = ['破局.mp3', 'assets/破局.mp3'];

  // ★ 請將完整歌詞其餘段落貼入下方字串中
  const LYRICS_TEXT = [
    '(Verse 1)',
    '青銅上的綠鏽 藏著哪朝的烽火',
    '溫潤的白瓷釉 掩飾過誰的落魄',
    '指尖輕拂過歲月 掌眼斷千秋的脈絡',
    '傳世的珍寶 幾件是真 幾件是傳說',
    '',
    '(Pre-Chorus)',
    '一分真 九分假 迷霧重重',
    '五脈的規矩 鎖不住貪婪的暗湧',
    '誰在幕後操盤 擺弄這歷史的時鐘',
    '我是局外人 卻早已深陷迷宮',
    '',
    '(Chorus)',
    '古董局中局 假作真時真亦空',
    '看破了金石字畫 看不破人心的黑洞',
    '破局而出 哪怕被當作異類嘲弄',
    '誓要拂去塵埃 還原那份清白的初衷',
    '',
    '(Verse 2)',
    '殘缺的古卷篇 拼湊出誰的因果',
    '神秘的佛頭笑 牽動了半生禪惑',
    '做舊的手法再精妙 總有破綻在角落',
    '尋真之路 哪怕前方是萬丈的業火',
    '',
    '(Bridge)',
    '真與假 善與惡 都在一念之間',
    '鑒的是古董 考驗的卻是尊嚴',
    '縱然天下人都被虛妄遮住了眼',
    '我也要燃起孤燈 照亮這長夜的底線',
    '',
    '(Chorus)',
    '古董局中局 假作真時真亦空',
    '看破了金石字畫 看不破人心的黑洞',
    '破局而出 哪怕被當作異類嘲弄',
    '誓要拂去塵埃 還原那份清白的初衷',
    '',
    '',
    '(Outro)',
    '局中局 夢中夢',
    '一眼看盡千年 誰才是真正的過客',
        
  ].join('\n');

  let bgmAudio = null;
  let floatPlayer = null;
  let introOverlay = null;
  let introVideo = null;
  let bgmLoop = true;
  let userPausedBgm = false;

  const fmtTime = sec => {
    if (!sec || !isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  function isInLobby() {
    const homeEl = UI.byId('home');
    return !!(homeEl && !homeEl.hidden);
  }

  /** 在大廳「📜 規則書」按鈕所在列的正下方插入可摺疊的《破局》歌詞區塊 */
  function injectLyricsBox() {
    if (document.getElementById('gdLyricsDetails')) return;
    const rulesBtn = document.querySelector('#home button[data-act="rules"]');
    if (!rulesBtn) return;
    const rulesRow = rulesBtn.parentElement;
    if (!rulesRow || !rulesRow.parentElement) return;

    const details = document.createElement('details');
    details.id = 'gdLyricsDetails';
    details.style.cssText = 'border-top:2px dashed var(--edge);padding-top:8px;margin-top:4px';
    details.innerHTML = `
      <summary class="sm b" style="cursor:pointer;color:var(--red);user-select:none;outline:none">
        🎵 《破局》
      </summary>
      <div style="font-size:14px; margin-top:8px; padding:10px 12px; background:var(--paper-hi); border:1px solid var(--edge); border-radius:8px; white-space:pre-line; line-height:1.75; color:var(--ink); max-height:240px; overflow-y:auto">${U.esc(LYRICS_TEXT)}</div>
    `;
    rulesRow.insertAdjacentElement('afterend', details);
  }

  /** 使漂浮視窗支援滑鼠與觸控拖曳，且不超出畫面邊界 */
  function makeDraggable(panelEl, handleEl) {
    let dragging = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;

    const clampPos = (left, top) => {
      const rect = panelEl.getBoundingClientRect();
      const maxL = Math.max(8, window.innerWidth - rect.width - 8);
      const maxT = Math.max(8, window.innerHeight - rect.height - 8);
      return {
        left: Math.min(Math.max(8, left), maxL),
        top: Math.min(Math.max(8, top), maxT)
      };
    };

    handleEl.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      dragging = true;
      const rect = panelEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      panelEl.style.left = `${origLeft}px`;
      panelEl.style.top = `${origTop}px`;
      handleEl.style.cursor = 'grabbing';
      if (handleEl.setPointerCapture) {
        try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}
      }
      e.preventDefault();
    });

    window.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const pos = clampPos(origLeft + dx, origTop + dy);
      panelEl.style.left = `${pos.left}px`;
      panelEl.style.top = `${pos.top}px`;
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      handleEl.style.cursor = 'grab';
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
      if (!panelEl.style.left || panelEl.style.left === 'auto') return;
      const pos = clampPos(parseFloat(panelEl.style.left) || 16, parseFloat(panelEl.style.top) || 16);
      panelEl.style.left = `${pos.left}px`;
      panelEl.style.top = `${pos.top}px`;
    });
  }

  /** 初始化大廳漂浮音樂播放器與開場無邊框影片 DOM */
  function initMediaSystem() {
    injectLyricsBox();
    if (document.getElementById('gdFloatPlayer')) return;

    // 1. 建立 Audio 物件
    bgmAudio = new Audio();
    bgmAudio.preload = 'auto';
    bgmAudio.loop = bgmLoop;
    bgmAudio.volume = parseFloat(localStorage.getItem('gd_bgm_vol') ?? '0.55');
    let audioSrcIdx = 0;
    bgmAudio.src = AUDIO_SOURCES[0];
    bgmAudio.addEventListener('error', () => {
      audioSrcIdx++;
      if (audioSrcIdx < AUDIO_SOURCES.length) bgmAudio.src = AUDIO_SOURCES[audioSrcIdx];
    });

    // 2. 建立可拖曳的漂浮半透明音樂播放器（掛在 document.body，絕不影響原網頁排版）
    floatPlayer = document.createElement('div');
    floatPlayer.id = 'gdFloatPlayer';
    floatPlayer.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'width:270px',
      'z-index:9000',
      'background:rgba(28, 20, 14, 0.82)',
      'backdrop-filter:blur(8px)',
      '-webkit-backdrop-filter:blur(8px)',
      'color:#f5d08a',
      'border:1.5px solid rgba(245, 208, 138, 0.45)',
      'border-radius:12px',
      'padding:9px 11px',
      'box-shadow:0 8px 28px rgba(0,0,0,0.55)',
      'user-select:none',
      'font-size:12px',
      'display:flex',
      'flex-direction:column',
      'gap:7px'
    ].join(';');

    floatPlayer.innerHTML = `
      <div id="gdFloatHeader" title="按住此處可任意拖曳移動視窗"
        style="display:flex;align-items:center;justify-content:space-between;cursor:grab;border-bottom:1px dashed rgba(245,208,138,0.28);padding-bottom:5px">
        <span style="font-weight:900;font-size:12.5px;color:#fde68a;letter-spacing:0.5px">⠿ 🎵 大廳配樂《破局》</span>
        <button type="button" id="bgmMinBtn" title="收合/展開面板"
          style="background:transparent;color:#fde68a;border:1px solid rgba(245,208,138,0.4);border-radius:4px;padding:0 5px;font-size:11px;cursor:pointer;line-height:1.4">−</button>
      </div>
      <div id="gdFloatBody" style="display:flex;flex-direction:column;gap:7px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <button type="button" id="bgmPlayBtn" class="btn gold" style="flex:1;padding:4px 8px;font-size:12px;font-weight:900">▶️ 播放</button>
          <button type="button" id="bgmLoopBtn" class="btn" style="padding:4px 8px;font-size:11.5px;background:rgba(20,83,45,0.9);color:#fef3c7;border-color:#4ade80" title="切換重複播放">🔁 循環：開</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span id="bgmCurTime" class="mono" style="font-size:11px;color:#fef3c7;min-width:34px;text-align:right">00:00</span>
          <input type="range" id="bgmSeek" min="0" max="100" value="0" step="0.1" style="flex:1;cursor:pointer;accent-color:#f59e0b;height:5px">
          <span id="bgmDurTime" class="mono" style="font-size:11px;color:#d6be96;min-width:34px">00:00</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div style="display:flex;align-items:center;gap:4px;flex:1" title="調整音樂音量">
            <span id="bgmVolIcon" style="font-size:13px">🔊</span>
            <input type="range" id="bgmVol" min="0" max="1" step="0.02" value="${bgmAudio.volume}" style="flex:1;cursor:pointer;accent-color:#f59e0b;height:5px">
          </div>
          <button type="button" id="replayIntroBtn" class="btn red" style="padding:3px 8px;font-size:11.5px;font-weight:900;white-space:nowrap">🎬 重播片頭</button>
        </div>
      </div>
    `;
    document.body.appendChild(floatPlayer);

    const headerEl = document.getElementById('gdFloatHeader');
    const bodyEl = document.getElementById('gdFloatBody');
    const minBtn = document.getElementById('bgmMinBtn');
    const playBtn = document.getElementById('bgmPlayBtn');
    const loopBtn = document.getElementById('bgmLoopBtn');
    const seekBar = document.getElementById('bgmSeek');
    const curTimeEl = document.getElementById('bgmCurTime');
    const durTimeEl = document.getElementById('bgmDurTime');
    const volBar = document.getElementById('bgmVol');
    const volIcon = document.getElementById('bgmVolIcon');
    const replayBtn = document.getElementById('replayIntroBtn');

    makeDraggable(floatPlayer, headerEl);

    minBtn.addEventListener('click', () => {
      const collapsed = bodyEl.style.display === 'none';
      bodyEl.style.display = collapsed ? 'flex' : 'none';
      minBtn.textContent = collapsed ? '−' : '+';
      floatPlayer.style.width = collapsed ? '270px' : '185px';
    });

    const syncPlayBtn = () => {
      if (!playBtn) return;
      playBtn.textContent = bgmAudio.paused ? '▶️ 播放' : '⏸️ 暫停';
    };

    playBtn.addEventListener('click', () => {
      if (bgmAudio.paused) {
        userPausedBgm = false;
        bgmAudio.play().then(syncPlayBtn).catch(() => UI.toast('請確認根目錄已放入「破局.mp3」', 'warn'));
      } else {
        userPausedBgm = true;
        bgmAudio.pause();
        syncPlayBtn();
      }
    });

    loopBtn.addEventListener('click', () => {
      bgmLoop = !bgmLoop;
      bgmAudio.loop = bgmLoop;
      loopBtn.textContent = bgmLoop ? '🔁 循環：開' : '➡️ 循環：關';
      loopBtn.style.background = bgmLoop ? 'rgba(20,83,45,0.9)' : 'rgba(75,85,99,0.85)';
      loopBtn.style.borderColor = bgmLoop ? '#4ade80' : '#9ca3af';
    });

    bgmAudio.addEventListener('loadedmetadata', () => {
      seekBar.max = bgmAudio.duration || 100;
      durTimeEl.textContent = fmtTime(bgmAudio.duration);
    });

    bgmAudio.addEventListener('timeupdate', () => {
      if (!seekBar.dataset.dragging) {
        seekBar.max = bgmAudio.duration || 100;
        seekBar.value = bgmAudio.currentTime || 0;
      }
      curTimeEl.textContent = fmtTime(bgmAudio.currentTime);
      if (bgmAudio.duration) durTimeEl.textContent = fmtTime(bgmAudio.duration);
    });

    bgmAudio.addEventListener('play', syncPlayBtn);
    bgmAudio.addEventListener('pause', syncPlayBtn);
    bgmAudio.addEventListener('ended', syncPlayBtn);

    seekBar.addEventListener('pointerdown', () => { seekBar.dataset.dragging = '1'; });
    seekBar.addEventListener('pointerup', () => { delete seekBar.dataset.dragging; });
    seekBar.addEventListener('input', () => {
      curTimeEl.textContent = fmtTime(parseFloat(seekBar.value));
    });
    seekBar.addEventListener('change', () => {
      delete seekBar.dataset.dragging;
      if (bgmAudio.duration) bgmAudio.currentTime = parseFloat(seekBar.value);
    });

    volBar.addEventListener('input', () => {
      const v = parseFloat(volBar.value);
      bgmAudio.volume = v;
      bgmAudio.muted = (v === 0);
      localStorage.setItem('gd_bgm_vol', String(v));
      volIcon.textContent = v === 0 ? '🔇' : v < 0.4 ? '🔉' : '🔊';
    });

    replayBtn.addEventListener('click', () => openIntroVideo(true));

    // 3. 建立置中「無邊框」開場影片彈窗 (goodong.mp4)，預設直接開啟聲音，無額外開啟聲音標示
    introOverlay = document.createElement('div');
    introOverlay.id = 'gdIntroVideoOverlay';
    introOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10000;display:none;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(3px)';
    introOverlay.innerHTML = `
      <div style="position:relative;width:min(92vw,960px);background:transparent;border:none;outline:none;display:flex;flex-direction:column;align-items:center">
        <button type="button" id="closeIntroVideoBtn" title="關閉影片"
          style="position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.65);color:#fff;border:none;font-size:18px;font-weight:900;cursor:pointer;z-index:20;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.5)">✕</button>
        <video id="gdIntroVideo" playsinline preload="auto"
          style="width:100%;max-height:84vh;display:block;background:transparent;border:none;outline:none;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.85)"></video>
      </div>
    `;
    document.body.appendChild(introOverlay);

    introVideo = document.getElementById('gdIntroVideo');
    const closeBtn = document.getElementById('closeIntroVideoBtn');

    let vidSrcIdx = 0;
    introVideo.src = VIDEO_SOURCES[0];
    introVideo.addEventListener('error', () => {
      vidSrcIdx++;
      if (vidSrcIdx < VIDEO_SOURCES.length) {
        introVideo.src = VIDEO_SOURCES[vidSrcIdx];
      } else if (introOverlay && introOverlay.style.display === 'flex') {
        closeIntroVideo();
      }
    });

    closeBtn.addEventListener('click', closeIntroVideo);
    introOverlay.addEventListener('click', e => {
      if (e.target === introOverlay) closeIntroVideo();
    });
    introVideo.addEventListener('ended', closeIntroVideo);

    // 使用者於畫面首次點擊時，若影片正在等待有聲播放或《破局》待命中，立即觸發有聲播放
    const unlockAudioOnInteract = e => {
      if (!isInLobby()) return;
      if (introOverlay && introOverlay.style.display === 'flex') {
        if (e && e.target && e.target.id === 'closeIntroVideoBtn') return;
        if (introVideo && introVideo.paused) {
          introVideo.muted = false;
          introVideo.play().catch(() => {});
        }
        return;
      }
      if (bgmAudio && bgmAudio.paused && !userPausedBgm) {
        bgmAudio.play().catch(() => {});
      }
    };
    document.addEventListener('pointerdown', unlockAudioOnInteract);
  }

  /** 開啟並自動以有聲模式播放置中無邊框 goodong 影片 */
  function openIntroVideo(isManualReplay = false) {
    initMediaSystem();
    if (!introOverlay || !introVideo) return;

    if (bgmAudio && !bgmAudio.paused) bgmAudio.pause();

    introOverlay.style.display = 'flex';
    introVideo.currentTime = 0;
    introVideo.muted = false;
    introVideo.volume = 0.85;

    const playPromise = introVideo.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        if (isManualReplay) {
          UI.toast('找不到 goodong.mp4 影片檔，請確認已放在根目錄', 'warn');
          closeIntroVideo();
        }
      });
    }
  }

  /** 關閉片頭影片（按叉叉或播完時觸發），並自動開始播放《破局》MP3 */
  function closeIntroVideo() {
    if (introVideo) {
      introVideo.pause();
      introVideo.currentTime = 0;
    }
    if (introOverlay) {
      introOverlay.style.display = 'none';
    }
    sessionStorage.setItem('gd_intro_played', '1');
    if (isInLobby() && !userPausedBgm) {
      tryPlayLobbyBgm();
    }
  }

  /** 在大廳顯示漂浮播放器並嘗試播放《破局》 */
  function tryPlayLobbyBgm() {
    initMediaSystem();
    if (floatPlayer) floatPlayer.style.display = 'flex';
    if (!bgmAudio || !isInLobby() || userPausedBgm) return;
    if (introOverlay && introOverlay.style.display === 'flex') return;
    bgmAudio.play().catch(() => {});
  }

  /** 進入房間時強制停止所有大廳音樂與影片，並隱藏漂浮播放器 */
  function stopAllLobbyMedia() {
    if (introVideo) introVideo.pause();
    if (introOverlay) introOverlay.style.display = 'none';
    if (bgmAudio) {
      bgmAudio.pause();
      bgmAudio.currentTime = 0;
    }
    if (floatPlayer) {
      floatPlayer.style.display = 'none';
    }
  }

  GD.bus.on('joined', stopAllLobbyMedia);
  GD.bus.on('left', () => {
    if (isInLobby()) {
      if (floatPlayer) floatPlayer.style.display = 'flex';
      if (!userPausedBgm) tryPlayLobbyBgm();
    }
  });
  GD.bus.on('room', r => {
    if (r && !isInLobby()) stopAllLobbyMedia();
  });

  /* ---------------- 角色圖鑑 ---------------- */
  function renderGallery() {
    const role = GD.ROLE_ORDER[gi], m = GD.ROLES[role];
    UI.byId('gPortrait').style.backgroundImage = `url("${GD.Art.url(role)}")`;
    const st = UI.byId('gCamp');
    st.textContent = m.campText; st.className = 'stamp ' + (m.camp === 'good' ? 'blue' : '');
    UI.text('gCount', `角色圖鑑 ${gi + 1} / 8`);
    UI.text('gTitle', `【${role}】${m.badge}`);
    UI.text('gWeapon', m.weapon);
    UI.text('gDesc', m.desc);
    UI.html('gDots', GD.ROLE_ORDER.map((r, i) => `<button class="btn ${i === gi ? 'red' : ''}" style="padding:2px 7px" data-act="galJump" data-arg="${i}">${r}</button>`).join(''));
  }
  UI.on('gal', d => { gi = (gi + (+d) + 8) % 8; renderGallery(); });
  UI.on('galJump', i => { gi = +i; renderGallery(); });
  GD.bus.on('art', renderGallery);

  /* ---------------- 輸入與狀態提示 ---------------- */
  const name = () => (UI.byId('inName').value.trim() || '掌眼人').slice(0, 10);
  const code = () => (UI.byId('inRoom').value.replace(/\D/g, '').padStart(4, '0').slice(-4));
  UI.on('roll', () => { UI.byId('inRoom').value = String(1000 + Math.floor(Math.random() * 9000)); });

  function renderHints() {
    const gem = GD.Gemini.enabled();
    const b = UI.byId('brainBadge');
    b.textContent = gem ? 'Gemini 雲端大腦' : '本地推理大腦';
    b.className = 'stamp ' + (gem ? 'blue' : '');
    UI.text('modeHint', Net.onlineAvailable()
      ? '單人局不連網路（只有電腦發言會呼叫 Gemini 代理）。多人連線使用 Firestore 即時同步。'
      : '目前無法連線 Firebase：僅提供單人局（電腦玩家仍可透過代理使用 Gemini）。');
    UI.byId('btnOnline').disabled = false;
    UI.text('authHint', Net.user ? `已登入：${Net.user.name}` : '');
    UI.text('btnAuth', Net.user ? `${Net.user.name} ✓` : 'Google 登入');
  }
  GD.bus.on('auth', u => { if (u && !UI.byId('inName').value.trim()) UI.byId('inName').value = u.name; renderHints(); });

  /* ---------------- 開局（進入房間時自動停止大廳音樂並隱藏漂浮視窗） ---------------- */
  async function enter(asMode, fillBots) {
    const n = name();
    GD.store.set(C.STORAGE.name, n);
    try {
      stopAllLobbyMedia();
      await Net.join({ code: code(), name: n, asMode, fillBots });
      if (asMode === 'online' && Net.mode() === 'solo') UI.toast('無法連線至雲端，已改用單人本機模式', 'warn');
      GD.UI.showBoard();
      if (fillBots) GD.Engine && Net.act(r => { if (r.players.length === 8 && r.status === 'waiting') return GD.Engine.start(r); return false; });
    } catch (e) { UI.toast(e.message, 'warn'); }
  }
  UI.on('solo', () => enter('solo', true));
  UI.on('online', () => enter('online', false));
  UI.on('join', (c, el) => { UI.byId('inRoom').value = c; enter(el.dataset.mode === 'solo' ? 'solo' : 'online', false); });

  /* ---------------- 進行中房間列表（30 分鐘自動清理）---------------- */
  const PH = { waiting: '等待入座', playing: '查驗中', discussion: '發言中', voting: '投票中', person_voting: '鑑人中', gameover: '已結束' };
  async function renderLobby() {
    UI.html('lobbyList', '<div class="xs mute">載入中…</div>');
    const list = await Net.lobby();
    UI.html('lobbyList', list.length ? list.map(r => `
      <div class="lobby-item">
        <div><span class="code">${r.code}</span> <span class="tag" style="background:#fdf8ee">${r.source === 'online' ? '🌐 連線' : '💻 本機'}</span>
          <div class="xs mute">${PH[r.status] || r.status}・第 ${r.round} 回合・${r.total}/8 人・${U.esc(r.humans.join('、') || '全電腦')}・${U.ago(Date.now() - r.updatedAt)}</div></div>
        <button class="btn ${r.status === 'waiting' ? 'jade' : ''}" data-act="join" data-arg="${r.code}" data-mode="${r.source}">${r.status === 'waiting' ? '加入' : '回到牌桌'}</button>
      </div>`).join('') : '<div class="xs mute">目前沒有進行中的房間。</div>');
  }
  UI.on('lobby', renderLobby);
  setInterval(() => { if (!UI.byId('home').hidden) renderLobby(); }, C.LOBBY_REFRESH_MS);

  /* ---------------- 登入 / 設定 ---------------- */
  UI.on('auth', () => {
    if (Net.user) {
      UI.modal(`<div class="panel-h"><span class="lg">Google 帳號</span><button class="btn red" data-act="close">✕</button></div>
        <div class="col center"><div class="b lg">${U.esc(Net.user.name)}</div><div class="mono xs mute">${U.esc(Net.user.email)}</div>
        <button class="btn red block" data-act="logout">登出</button></div>`);
    } else {
      UI.modal(`<div class="panel-h"><span class="lg">Google 登入</span><button class="btn red" data-act="close">✕</button></div>
        <div class="col"><p class="sm mute" style="margin:0">登入是選用功能，只用來帶入暱稱。需要部署在 https 網域，直接開啟本機檔案時瀏覽器會擋下彈窗。</p>
        <button class="btn gold big block" data-act="googleLogin">🌐 使用 Google 登入</button></div>`);
    }
  });
  UI.on('googleLogin', async () => {
    try { await Net.googleLogin(); UI.closeModal(); UI.toast('登入成功', 'ok'); }
    catch (e) { UI.toast('此環境無法使用 Google 登入（需 https 網域）', 'warn'); }
  });
  UI.on('logout', async () => { await Net.logout(); UI.closeModal(); });

  UI.on('settings', () => {
    const recs = GD.store.get(C.STORAGE.genes, {});
    const rows = Object.entries(recs).filter(([, r]) => r.games > 0).sort((a, b) => b[1].games - a[1].games).slice(0, 12).map(([id, r]) => {
      const bot = GD.Roster.byId(id), base = GD.Roster.baseGenes(id);
      return `<div class="note"><b>${U.esc(bot ? bot.name : id)}</b> <span class="xs mute">${r.games} 局・勝 ${r.wins}</span>
        <div class="xs mono">${GD.Genes.KEYS.map(k => { const d = U.round3(r.genes[k] - base[k]); return `${GD.Roster.GENE_LABELS[k]} ${r.genes[k].toFixed(2)}<span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">(${d >= 0 ? '+' : ''}${d.toFixed(2)})</span>`; }).join('｜')}</div></div>`;
    }).join('');
    const gs = GD.Gemini.state;
    UI.modal(`<div class="panel-h"><span class="lg">⚙️ 設定</span><button class="btn red" data-act="close">✕</button></div>
      <div class="col sm">
        <label class="row b"><input type="checkbox" id="cfgGem" ${GD.Gemini.enabled() ? 'checked' : ''}> 電腦發言使用 Gemini 雲端大腦（失敗時自動改用本地推理）</label>
        <div class="note">代理：<span class="mono xs">${U.esc(C.PROXY_URL)}</span><br>本次呼叫 ${gs.calls} 次、成功 ${gs.ok} 次${gs.lastError ? `；最近一次失敗原因：${U.esc(gs.lastError)}` : ''}</div>
        <div class="b red">🧬 電腦進化紀錄（前 12 位）</div>${rows || '<div class="xs mute">還沒有對局紀錄。打完一局後，電腦會依表現微調基因並寫入瀏覽器。</div>'}
        <button class="btn block" data-act="resetGenes">重置所有電腦基因為出廠值</button>
      </div>`);
    UI.byId('cfgGem').addEventListener('change', e => { GD.Gemini.setEnabled(e.target.checked); renderHints(); });
  });
  UI.on('resetGenes', () => { if (confirm('確定要把所有電腦玩家的基因重置為出廠值嗎？')) { GD.Genes.reset(); UI.closeModal(); UI.toast('已重置', 'ok'); } });

  UI.on('tts', () => {
    const on = GD.store.get(C.STORAGE.tts, true) === false;
    GD.store.set(C.STORAGE.tts, on);
    UI.text('btnTts', on ? '🔊' : '🔇');
    UI.toast(on ? '語音播報已開啟' : '語音播報已關閉');
  });

  UI.initHome = () => {
    UI.byId('inName').value = GD.store.get(C.STORAGE.name, '');
    UI.text('btnTts', GD.store.get(C.STORAGE.tts, true) === false ? '🔇' : '🔊');
    renderGallery(); renderHints(); renderLobby();

    initMediaSystem();
    if (floatPlayer) floatPlayer.style.display = 'flex';
    openIntroVideo(false);
  };
  UI.renderHints = renderHints;
})(window.GD);