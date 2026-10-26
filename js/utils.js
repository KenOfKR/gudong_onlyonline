/* ============================================================================
 * utils.js — 純函式工具（雙環境相容，支援環境與決策雙軌亂數流隔離）
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const U = GD.U = {};

  /* --- 隔離亂數流與隨機退回機制 --- */
  let activeStream = null;

  U.useStream = function (streamFn) { activeStream = streamFn || null; };
  U.rng = function () { return activeStream ? activeStream() : Math.random(); };

  U.mulberry32 = function (a) {
    return function () {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  U.seedHash = function (str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  U.rngStream = function (subSeedStr) {
    return U.mulberry32(U.seedHash(String(subSeedStr)));
  };

  /**
   * 同步測試專用：
   * - U.rng() 使用環境亂數流（角色分配、獸首真偽、座位洗牌）
   * - Math.random() 使用 Bot 決策亂數流（策略與發言抽樣）
   * - callback 結束後於 finally 區塊嚴格還原原有亂數狀態
   */
  U.withPRNG = function (seedStr, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('withPRNG 需要函式 callback');
    }

    const originalRandom = Math.random;
    const previousStream = activeStream;
    const seed = String(seedStr);

    activeStream = U.rngStream(`${seed}::environment`);
    Math.random = U.rngStream(`${seed}::decision`);

    try {
      return fn();
    } finally {
      Math.random = originalRandom;
      activeStream = previousStream;
    }
  };

  /* --- 原版工具函式（將 Math.random 換成 U.rng()） --- */
  U.esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  U.clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  U.sum = arr => arr.reduce((a, b) => a + b, 0);
  U.pick = arr => arr[Math.floor(U.rng() * arr.length)];
  U.uid = prefix => `${prefix}_${Date.now().toString(36)}_${U.rng().toString(36).slice(2, 6)}`;
  U.round3 = x => Math.round(x * 1000) / 1000;

  /** Fisher-Yates，回傳新陣列（不改動原陣列）*/
  U.shuffle = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(U.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  U.byId = (room, id) => (room.players || []).find(p => p.id === id) || null;
  U.seated = room => [...room.players].sort((a, b) => a.seatIndex - b.seatIndex);
  U.curRound = room => room.rounds[room.currentRoundIdx];

  U.colorOf = p => GD.SEAL_COLORS.find(c => c.id === (p && p.colorId)) || GD.SEAL_COLORS[0];
  U.tag = p => p ? `${U.colorOf(p).name}【${p.name}】` : '';

  U.ago = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} 秒前`;
    return `${Math.floor(s / 60)} 分鐘前`;
  };

  U.nth = i => ['第一位', '第二位', '第三位', '第四位', '第五位', '第六位', '第七位', '第八位'][i] || `第${i + 1}位`;

  U.hashStr = function (str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    return (h >>> 0).toString(16);
  };

  /* ---- 輕量事件匯流排 ---- */
  const handlers = {};
  GD.bus = {
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
    emit(evt, data) {
      (handlers[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[bus]', evt, e); } });
    }
  };

  /* ---- localStorage 包裝：防呆處理 Node.js 環境 ---- */
  const mem = new Map();
  const ls = (() => { 
    try { return typeof window !== 'undefined' ? window.localStorage : null; } 
    catch (e) { return null; } 
  })();
  
  GD.store = {
    get(key, fallback) {
      try {
        const raw = ls ? ls.getItem(key) : mem.get(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, val) {
      const raw = JSON.stringify(val);
      try { if (ls) ls.setItem(key, raw); else mem.set(key, raw); } catch (e) { mem.set(key, raw); }
    },
    remove(key) { 
      try { if (ls) ls.removeItem(key); } catch (e) { /* ignore */ } 
      mem.delete(key); 
    },
    keys(prefix) {
      const all = ls ? Object.keys(ls) : [...mem.keys()];
      return all.filter(k => k.startsWith(prefix));
    }
  };

  // Node.js 匯出支援
  if (typeof module !== 'undefined' && module.exports) module.exports = GD;
})(typeof window !== 'undefined' ? window : global);