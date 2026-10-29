/* 測試載入器：在 Node 中依 index.html 的順序載入所有無 DOM 依賴的模組 */
const fs = require('fs');
const os = require('os');
const path = require('path');

global.window = global;
const ROOT = path.join(__dirname, '..');
const ORDER = ['config', 'utils', 'roster', 'core/rules', 'core/claims', 'core/engine',
  'bot/genes', 'bot/mind', 'bot/dialogueBank', 'bot/tactics', 'bot/strategy', 'bot/speech', 'bot/gemini', 'bot/driver',
  'bot/learning', 'bot/review', 'net', 'voice'];

module.exports = function load() {
  ORDER.forEach(m => { 
    delete require.cache[require.resolve(path.join(ROOT, 'js', m + '.js'))]; 
    require(path.join(ROOT, 'js', m + '.js')); 
  });
  
  const GD = window.GD;

  // 【效能優化與持久化驗證】測試期純記憶體快取 + 顯式磁碟寫入與讀回校驗
  if (GD && GD.store) {
    const memCache = {};

    GD.store.set = function(k, v) {
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

    GD.store.flush = function (options = {}) {
      const outputPath =
        options.path ||
        process.env.GD_STORE_FLUSH_PATH ||
        path.join(os.tmpdir(), `gudong-sim-store-${process.pid}.json`);

      let serialized = '';
      let serializeMs = 0;
      let ioMs = 0;
      let verifyMs = 0;
      let fails = 0;
      const errors = [];

      // 1. 序列化
      const s0 = process.hrtime.bigint();
      try {
        serialized = JSON.stringify(memCache);
        if (typeof serialized !== 'string') {
          throw new Error('快取無法序列化');
        }
      } catch (e) {
        fails++;
        errors.push(`serialize: ${e.message}`);
      }
      serializeMs = Number(process.hrtime.bigint() - s0) / 1e6;

      // 2. 實際寫入磁碟並要求檔案系統同步 (fsyncSync)
      if (!fails) {
        const w0 = process.hrtime.bigint();
        let fd;
        try {
          fd = fs.openSync(outputPath, 'w');
          fs.writeFileSync(fd, serialized, 'utf8');
          fs.fsyncSync(fd);
        } catch (e) {
          fails++;
          errors.push(`write: ${e.message}`);
        } finally {
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch (e) {
              fails++;
              errors.push(`close: ${e.message}`);
            }
          }
        }
        ioMs = Number(process.hrtime.bigint() - w0) / 1e6;
      }

      // 3. 從磁碟讀回並比對
      if (!fails) {
        const v0 = process.hrtime.bigint();
        try {
          const diskText = fs.readFileSync(outputPath, 'utf8');
          JSON.parse(diskText);
          if (diskText !== serialized) {
            throw new Error('讀回內容與寫入內容不一致');
          }
        } catch (e) {
          fails++;
          errors.push(`verify: ${e.message}`);
        }
        verifyMs = Number(process.hrtime.bigint() - v0) / 1e6;
      }

      return {
        path: outputPath,
        keys: Object.keys(memCache).length,
        bytes: Buffer.byteLength(serialized || '', 'utf8'),
        serializeMs,
        ioMs,
        verifyMs,
        fails,
        error: errors.length ? errors.join(' | ') : null
      };
    };
  }
  
  return GD;
};