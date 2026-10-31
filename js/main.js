/* ============================================================================
 * main.js — 啟動：初始化 Firebase（可選）、探測自訂角色圖、顯示首頁
 * ========================================================================== */
(function (GD) {
  'use strict';
  const boot = () => {
    GD.Net.init();
    GD.Art.probe();
    GD.UI.initHome();
    GD.UI.showHome();
    // 直接顯示載入中的實際台詞數；低於 650 時明確標示警告，不以固定數字冒充。
    const dialogueCount = GD.DialogueBank && typeof GD.DialogueBank.count === 'function'
      ? Number(GD.DialogueBank.count()) || 0 : 0;
    let countBadge = document.getElementById('dialogueCountBadge');
    if (!countBadge) {
      countBadge = document.createElement('span');
      countBadge.id = 'dialogueCountBadge';
      countBadge.className = 'pill';
      countBadge.style.marginLeft = '6px';
      const heading = document.querySelector('header.top h1');
      if (heading) heading.appendChild(countBadge);
    }
    if (countBadge) {
      countBadge.textContent = '台詞庫 ' + dialogueCount.toLocaleString('zh-TW') + ' 條';
      countBadge.title = '目前實際載入 ' + dialogueCount + ' 條台詞；最低要求 650 條';
      countBadge.setAttribute('aria-label', '目前實際載入 ' + dialogueCount + ' 條台詞');
      countBadge.dataset.count = String(dialogueCount);
      countBadge.style.borderColor = dialogueCount < 650 ? '#dc2626' : '';
      countBadge.style.color = dialogueCount < 650 ? '#dc2626' : '';
    }
    if (dialogueCount < 650) console.error('台詞庫不足：目前 ' + dialogueCount + ' 條，最低要求 650 條。');
    else console.info('台詞庫已載入 ' + dialogueCount + ' 條。');
    console.info('%c古董局中局 v' + GD.CONFIG.VERSION + ' 已啟動', 'color:#f59e0b;background:#1e1610;padding:2px 8px;border:2px solid #f59e0b;font-weight:bold');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.GD);
