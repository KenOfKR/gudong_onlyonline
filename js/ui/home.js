/* ============================================================================
 * ui/home.js — 首頁：角色圖鑑、暱稱/房號、開局入口、進行中房間列表、登入、設定
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, UI, Net } = GD;
  const C = GD.CONFIG;
  let gi = 0;

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

  /* ---------------- 開局 ---------------- */
  async function enter(asMode, fillBots) {
    const n = name();
    GD.store.set(C.STORAGE.name, n);
    try {
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
  };
  UI.renderHints = renderHints;
})(window.GD);
