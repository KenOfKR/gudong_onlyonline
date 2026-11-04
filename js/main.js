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
    // 移除舊版可能殘留的左上角台詞數量徽章；台詞庫本身仍保留供 BOT 策略使用。
    const topHeader = document.querySelector('header.top');
    if (topHeader) {
      topHeader.querySelectorAll('#dialogueCountBadge, [data-dialogue-count-badge], .dialogue-count-badge')
        .forEach(node => node.remove());
      topHeader.querySelectorAll('span, small, b, strong, em, div').forEach(node => {
        if (node.children.length === 0 && /(?:台詞庫|1,068\s*條|1068\s*條)/i.test(node.textContent || '')) node.remove();
      });
    }
    const dialogueCount = GD.DialogueBank && typeof GD.DialogueBank.count === 'function'
      ? Number(GD.DialogueBank.count()) || 0 : 0;
    if (dialogueCount < 650) console.error('台詞庫載入不足，請檢查 DialogueBank。');
    console.info('%c古董局中局 v' + GD.CONFIG.VERSION + ' 已啟動', 'color:#f59e0b;background:#1e1610;padding:2px 8px;border:2px solid #f59e0b;font-weight:bold');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.GD);
