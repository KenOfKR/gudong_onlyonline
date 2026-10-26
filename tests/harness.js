/* 測試載入器：在 Node 中依 index.html 的順序載入所有無 DOM 依賴的模組 */
const fs = require('fs');
const path = require('path');

global.window = global;
const ROOT = path.join(__dirname, '..');
const ORDER = ['config', 'utils', 'roster', 'core/rules', 'core/claims', 'core/engine',
  'bot/genes', 'bot/mind', 'bot/strategy', 'bot/speech', 'bot/gemini', 'bot/driver',
  'bot/learning', 'bot/review', 'net', 'voice'];

module.exports = function load() {
  ORDER.forEach(m => { 
    delete require.cache[require.resolve(path.join(ROOT, 'js', m + '.js'))]; 
    require(path.join(ROOT, 'js', m + '.js')); 
  });
  
  const GD = window.GD;

  // 【效能優化】純記憶體快取攔截器 (零 JSON 轉換與 I/O 開銷)
  if (GD && GD.store) {
    const memCache = {};

    GD.store.set = function(k, v) {
      // 測試環境不需深拷貝防污染，直接儲存參照達到極致效能
      memCache[k] = v;
    };

    GD.store.get = function(k, fallback) {
      return memCache.hasOwnProperty(k) ? memCache[k] : fallback;
    };

    GD.store.remove = function(k) {
      delete memCache[k];
    };

    GD.store.keys = function(prefix) {
      return Object.keys(memCache).filter(k => k.startsWith(prefix));
    };
  }
  
  return GD;
};