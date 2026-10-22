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
    console.info('%c古董局中局 v' + GD.CONFIG.VERSION + ' 已啟動', 'color:#f59e0b;background:#1e1610;padding:2px 8px;border:2px solid #f59e0b;font-weight:bold');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.GD);
