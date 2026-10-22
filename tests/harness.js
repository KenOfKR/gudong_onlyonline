/* 測試載入器：在 Node 中依 index.html 的順序載入所有無 DOM 依賴的模組 */
const fs = require('fs');
const path = require('path');

global.window = global;
const ROOT = path.join(__dirname, '..');
const ORDER = ['config', 'utils', 'roster', 'core/rules', 'core/claims', 'core/engine',
  'bot/genes', 'bot/mind', 'bot/strategy', 'bot/speech', 'bot/gemini', 'bot/driver',
  'bot/learning', 'bot/review', 'net', 'voice'];

module.exports = function load() {
  ORDER.forEach(m => { delete require.cache[require.resolve(path.join(ROOT, 'js', m + '.js'))]; require(path.join(ROOT, 'js', m + '.js')); });
  return window.GD;
};
