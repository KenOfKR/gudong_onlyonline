/* ============================================================================
 * ui/ui.js — UI 基礎層
 *   - 事件委派：HTML 只寫 data-act="動作名" data-arg="參數"，各模組以 UI.on('動作', fn) 註冊
 *   - $ / html / show：最小 DOM 工具（避免重複渲染時閃爍：內容相同就不寫入）
 *   - toast / modal / 共用標籤產生器
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U } = GD;

  const UI = {
    state: {                       // 純 UI 狀態（不進房間資料）
      peek: true,                  // 是否顯示自己的身分
      voteRound: 0, speechRound: 0,
      tab: 'table',
      ballot: {},                  // 自己正在分配的籌碼
      draft: ''
    }
  };

  const cache = new WeakMap();
  UI.$ = (sel, root) => (root || document).querySelector(sel);
  UI.$$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  UI.byId = id => document.getElementById(id);

  /** 內容相同就不重寫 DOM，避免輸入框 / 動畫被打斷 */
  UI.html = (el, markup) => {
    if (typeof el === 'string') el = UI.byId(el);
    if (!el || cache.get(el) === markup) return el;
    cache.set(el, markup);
    el.innerHTML = markup;
    return el;
  };
  UI.text = (id, t) => { const el = UI.byId(id); if (el && el.textContent !== t) el.textContent = t; };
  UI.show = (id, on) => { const el = typeof id === 'string' ? UI.byId(id) : id; if (el) el.hidden = !on; };

  /* ---------------- 事件委派 ---------------- */
  const acts = UI._acts = {};       // 公開給測試用
  UI.on = (name, fn) => { acts[name] = fn; };
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = acts[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    try { fn(el.dataset.arg, el, e); } catch (err) { console.error('[ui act]', el.dataset.act, err); UI.toast('操作失敗：' + err.message, 'warn'); }
  });

  /* ---------------- 提示 / 彈窗 ---------------- */
  UI.toast = (msg, kind = '') => {
    const box = UI.byId('toasts'); if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind; el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
  };
  GD.bus.on('netwarn', m => UI.toast(m, 'warn'));

  UI.modal = (markup) => {
    const m = UI.byId('modal');
    m.innerHTML = `<div class="panel">${markup}</div>`;
    m.hidden = false;
  };
  UI.closeModal = () => { UI.byId('modal').hidden = true; };
  UI.on('close', UI.closeModal);
  UI.byId('modal').addEventListener('click', e => { if (e.target.id === 'modal') UI.closeModal(); });

  /* ---------------- 共用標籤 ---------------- */
  UI.seal = (p, extra = '') => {
    const c = U.colorOf(p);
    return `<span class="tag" style="background:${c.hex};color:${c.text}" ${extra}>${c.name}・${U.esc(p.name)}</span>`;
  };
  UI.roleTag = role => `<span class="tag ${GD.isGood(role) ? 'good' : 'evil'}">${U.esc(role)}</span>`;
  UI.pager = (act, current, total) => {
    const btns = [];
    for (let i = 0; i < total; i++) btns.push(`<button class="btn ${i === current ? 'on' : ''}" data-act="${act}" data-arg="${i}">R${i + 1}</button>`);
    return `<span class="pager"><button class="btn" data-act="${act}Step" data-arg="-1" ${current <= 0 ? 'disabled' : ''}>◀</button>${btns.join('')}<button class="btn" data-act="${act}Step" data-arg="1" ${current >= total - 1 ? 'disabled' : ''}>▶</button></span>`;
  };

  /* ---------------- 規則書 ---------------- */
  UI.on('rules', () => UI.modal(`
    <div class="panel-h"><span class="lg">📜 古董局中局規則書</span><button class="btn red" data-act="close">✕</button></div>
    <div class="col sm">
      <div class="note"><b class="red">陣營</b>：許願陣營 5 人（許願、方震、姬雲浮、黃煙煙、木戶加奈）對 老朝奉陣營 3 人（老朝奉、藥不然、鄭國渠）。老朝奉與藥不然互認，鄭國渠不知同伴。</div>
      <div class="note"><b class="red">回合</b>：共 3 回合。每回合當場抽 4 尊獸首（2 真 2 假）；8 人依傳遞順序查驗並施放技能，再指定下一位。查驗完畢由<b>尾家左手邊</b>開始順時針發言，尾家壓軸。</div>
      <div class="note"><b class="red">投票</b>：發言後暗投。每回合每人新增 2 票，沒投完的自動保留。得票最高的 2 尊獸首保留：第一名封存，第二名公開真偽。</div>
      <div class="note"><b class="red">技能</b>：許願驗 2 尊；方震驗 1 人陣營；姬雲浮免疫擾亂；黃煙煙、木戶加奈各有 1 個隨機回合無法查驗；老朝奉可擾亂（反轉其後好人的查驗）；藥不然可偷襲致盲（已行動者效果延到下回合；姬雲浮永久失明；偷襲方震會連帶偷襲許願）；鄭國渠可封鎖 1 尊獸首，且鑑人票無效。</div>
      <div class="note"><b class="red">計分（滿 6 分許願陣營勝）</b>：每保留 1 尊真品 +1；好人過半抓到老朝奉 +1；藥不然沒抓到方震 +1；老朝奉沒抓到許願 +2。</div>
      <div class="note"><b class="red">語音</b>：輪到你發言時按住「🎙️ 按住說話」，放開後系統會校正同音字、產生重點摘要並自動發布，所有玩家（含電腦）都讀得到。</div>
    </div>`));

/* ---------------- 角色圖鑑自動輪播 ---------------- */
  const portraitArea = document.getElementById('gPortrait');
  let autoPlayInterval;

  function startAutoPlay() {
    autoPlayInterval = setInterval(() => {
      // 【關鍵修改】：每次時間到，都即時去畫面上尋找最新的按鈕，避免被重繪干擾
      const nextGalBtn = document.querySelector('button[data-act="gal"][data-arg="1"]');
      if (nextGalBtn && !document.hidden) {
        nextGalBtn.click();
      }
    }, 3500); 
  }

  function stopAutoPlay() {
    clearInterval(autoPlayInterval);
  }

  if (portraitArea) {
    // 稍微延遲半秒啟動，確保 home.js 已經把初始畫面渲染完畢
    setTimeout(startAutoPlay, 500);
    
    portraitArea.addEventListener('mouseenter', stopAutoPlay);
    portraitArea.addEventListener('mouseleave', startAutoPlay);
    portraitArea.addEventListener('touchstart', stopAutoPlay, { passive: true });
    portraitArea.addEventListener('touchend', startAutoPlay, { passive: true });
  }
  
  GD.UI = UI;
})(window.GD);
  
  GD.UI = UI;
})(window.GD);
