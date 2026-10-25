/* ============================================================================
 * bot/genes.js — 電腦玩家「基因」存取（localStorage）（雙環境相容與絕對防呆）
 *
 * 儲存格式（key = CONFIG.STORAGE.genes）：
 *   { [botId]: { genes:{...5 項}, games, wins, lastDelta:{...}, history:[{gameId,role,won,delta}] } }
 * ========================================================================== */
(function (root) {
  'use strict';
  // 雙環境相容：Node.js (global) 或 瀏覽器 (window)
  const GD = root.GD || (root.GD = {});
  
  const KEY = GD.CONFIG.STORAGE.genes;
  const KEYS = GD.Roster.GENE_KEYS;
  const LO = 0.05, HI = 0.95;

  const clamp = x => GD.U.round3(GD.U.clamp(x, LO, HI));
  
  // 絕對防呆：加上 || {} 確保就算存檔壞了被讀成 null，也一定會回傳空物件
  const readAll = () => GD.store.get(KEY, {}) || {};

  function sanitize(g, fallback) {
    const out = {};
    KEYS.forEach(k => { out[k] = clamp(typeof g?.[k] === 'number' ? g[k] : fallback[k]); });
    return out;
  }

  const Genes = {
    KEYS, LO, HI,

    /** 取得 Bot 目前基因（扁平物件副本）。沒有紀錄就用出廠值 */
    load(botId) {
      const base = GD.Roster.baseGenes(botId);
      const all = readAll();
      const rec = all[botId];
      return rec ? sanitize(rec.genes, base) : base;
    },

    record(botId) {
      const all = readAll();
      const rec = all[botId];
      const base = GD.Roster.baseGenes(botId);
      return rec
        ? { genes: sanitize(rec.genes, base), games: rec.games || 0, wins: rec.wins || 0, lastDelta: rec.lastDelta || {}, history: rec.history || [] }
        : { genes: base, games: 0, wins: 0, lastDelta: {}, history: [] };
    },

    save(botId, genes, meta) {
      // 防呆 1：確保 meta 物件存在
      meta = meta || {};
      const all = readAll();
      const prev = Genes.record(botId);
      
      // 防呆 2：如果沒傳 entry，給予預設紀錄物件避免崩潰
      const entry = meta.entry || { gameId: 'unknown', won: !!meta.won, delta: meta.delta || {} };
      const history = [...prev.history, entry].slice(-12);
      
      all[botId] = {
        genes: sanitize(genes, GD.Roster.baseGenes(botId)),
        games: prev.games + 1,
        wins: prev.wins + (meta.won ? 1 : 0),
        lastDelta: meta.delta || {},
        history
      };
      GD.store.set(KEY, all);
    },

    /** 紀錄是否已學過某局，避免重複套用（以 gameId + botId 為鍵）*/
    hasLearned(gameId, botId) {
      return Genes.record(botId).history.some(h => h.gameId === gameId);
    },

    reset() { GD.store.remove(KEY); },
    clamp
  };

  GD.Genes = Genes;
  
  // Node.js 匯出支援
  if (typeof module !== 'undefined' && module.exports) module.exports = Genes;
})(typeof window !== 'undefined' ? window : global);