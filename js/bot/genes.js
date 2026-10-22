/* ============================================================================
 * bot/genes.js — 電腦玩家「基因」存取（localStorage）
 *
 * 儲存格式（key = CONFIG.STORAGE.genes）：
 *   { [botId]: { genes:{...5 項}, games, wins, lastDelta:{...}, history:[{gameId,role,won,delta}] } }
 * 每個 Bot 的基因獨立演化；出廠值來自 roster.js（風格 + 個體微差）。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const KEY = GD.CONFIG.STORAGE.genes;
  const KEYS = GD.Roster.GENE_KEYS;
  const LO = 0.05, HI = 0.95;

  const clamp = x => GD.U.round3(GD.U.clamp(x, LO, HI));
  const readAll = () => GD.store.get(KEY, {});

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
      const rec = readAll()[botId];
      return rec ? sanitize(rec.genes, base) : base;
    },

    record(botId) {
      const rec = readAll()[botId];
      const base = GD.Roster.baseGenes(botId);
      return rec
        ? { genes: sanitize(rec.genes, base), games: rec.games || 0, wins: rec.wins || 0, lastDelta: rec.lastDelta || {}, history: rec.history || [] }
        : { genes: base, games: 0, wins: 0, lastDelta: {}, history: [] };
    },

    save(botId, genes, meta) {
      const all = readAll();
      const prev = Genes.record(botId);
      const history = [...prev.history, meta.entry].slice(-12);
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
})(window.GD);
