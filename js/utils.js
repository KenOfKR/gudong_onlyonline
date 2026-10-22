/* ============================================================================
 * utils.js — 純函式工具（無 DOM 依賴，Node 也可載入測試）
 * ========================================================================== */
(function (GD) {
  'use strict';

  const U = GD.U = {};

  U.esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  U.clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  U.sum = arr => arr.reduce((a, b) => a + b, 0);
  U.pick = arr => arr[Math.floor(Math.random() * arr.length)];
  U.uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  U.round3 = x => Math.round(x * 1000) / 1000;

  /** Fisher-Yates，回傳新陣列（不改動原陣列）*/
  U.shuffle = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  U.byId = (room, id) => (room.players || []).find(p => p.id === id) || null;
  U.seated = room => [...room.players].sort((a, b) => a.seatIndex - b.seatIndex);
  U.curRound = room => room.rounds[room.currentRoundIdx];

  U.colorOf = p => GD.SEAL_COLORS.find(c => c.id === (p && p.colorId)) || GD.SEAL_COLORS[0];
  /** 例：藍色【宗彥】——全遊戲統一的玩家稱呼 */
  U.tag = p => p ? `${U.colorOf(p).name}【${p.name}】` : '';

  U.ago = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} 秒前`;
    return `${Math.floor(s / 60)} 分鐘前`;
  };

  /** 傳遞順位中文：0 → 第一位 */
  U.nth = i => ['第一位', '第二位', '第三位', '第四位', '第五位', '第六位', '第七位', '第八位'][i] || `第${i + 1}位`;

  /* ---- 輕量事件匯流排：engine → net / ui / driver 解耦 ---- */
  const handlers = {};
  GD.bus = {
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
    emit(evt, data) {
      (handlers[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[bus]', evt, e); } });
    }
  };

  /* ---- localStorage 包裝：不可用時（Node 測試／隱私模式）退回記憶體 ---- */
  const mem = new Map();
  const ls = (() => { try { return window.localStorage || null; } catch (e) { return null; } })();
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
    remove(key) { try { if (ls) ls.removeItem(key); } catch (e) { /* ignore */ } mem.delete(key); },
    keys(prefix) {
      const all = ls ? Object.keys(ls) : [...mem.keys()];
      return all.filter(k => k.startsWith(prefix));
    }
  };
})(window.GD);
