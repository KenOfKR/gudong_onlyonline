/* ============================================================================
 * core/rules.js — 遊戲規則（純函式、無 DOM、無網路）
 * 查驗判定、偷襲連動、終局計分都集中在這裡；真人與電腦玩家共用同一套。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const U = GD.U;

  const BLIND_TEXT = '💥 你被偷襲，眼前一片黑！';
  const UNSURE_TEXT = '無法辨別真偽！';   // 被鄭國渠封鎖 / 黃煙煙、木戶加奈困惑回合：字句完全相同

  const Rules = {
    BLIND_TEXT, UNSURE_TEXT,

    isBlind: p => !!(p.isAmbushed || p.isPermanentlyAmbushed),

    /** 本回合需查驗的獸首數：方震不看獸首；許願未被偷襲驗 2 尊；其餘 1 尊 */
    inspectQuota(p) {
      if (p.role === '方震') return 0;
      return (p.role === '許願' && !Rules.isBlind(p)) ? 2 : 1;
    },

    hasActed: (round, p) => round.passOrder.includes(p.id),

    /**
     * 單尊獸首查驗結果。displayedReal：true/false 為看到的真偽，null 代表看不到。
     * 優先序：偷襲 > 封鎖 > 困惑回合 > 老朝奉擾亂反轉（姬雲浮免疫）
     */
    inspect(beast, player, round, roundIdx) {
      const base = { beastName: beast.name };
      if (Rules.isBlind(player)) {
        return { ...base, resultText: `【${beast.name}】 ${BLIND_TEXT}`, displayedReal: null, kind: 'blind' };
      }
      if (round.blockedBeast === beast.name) {
        return { ...base, resultText: `【${beast.name}】 ${UNSURE_TEXT}`, displayedReal: null, kind: 'blocked' };
      }
      if ((player.role === '黃煙煙' || player.role === '木戶加奈') && player.confusedRound === roundIdx) {
        return { ...base, resultText: `【${beast.name}】 ${UNSURE_TEXT}`, displayedReal: null, kind: 'confused' };
      }
      let seen = beast.isReal;
      let flipped = false;
      if (round.laoActive && GD.isGood(player.role) && player.role !== '姬雲浮') { seen = !seen; flipped = true; }
      return { ...base, resultText: `【${beast.name}】 ${seen ? '【真品】' : '【贗品】'}`, displayedReal: seen, kind: 'ok', flipped };
    },

    /**
     * 藥不然偷襲：已行動者效果延至下回合（pendingAmbush），未行動者當回合立刻失明；
     * 姬雲浮永久失明；方震被偷襲時許願連帶被偷襲。回傳受影響玩家 id 陣列。
     */
    applyAmbush(room, target) {
      const round = U.curRound(room);
      const hit = p => {
        if (p.role === '姬雲浮') p.isPermanentlyAmbushed = true;
        if (Rules.hasActed(round, p)) p.pendingAmbush = true; else p.isAmbushed = true;
      };
      const hits = [target.id];
      hit(target);
      if (target.role === '方震') {
        const xu = room.players.find(p => p.role === '許願');
        if (xu) { hit(xu); hits.push(xu.id); }
      }
      return hits;
    },

    /** 開票：回傳 {rank1(封存), rank2(公開), totals, chips}。同票依生肖順序決勝 */
    tally(room, round) {
      const totals = {}, chips = {};
      round.beasts.forEach(b => { totals[b.name] = 0; chips[b.name] = []; });
      Object.entries(round.votes || {}).forEach(([vid, ballot]) => {
        const voter = U.byId(room, vid);
        Object.entries(ballot || {}).forEach(([name, cnt]) => {
          const n = parseInt(cnt, 10) || 0;
          if (!(name in totals)) return;
          totals[name] += n;
          for (let k = 0; k < n; k++) chips[name].push({ voterId: vid, voterName: voter ? voter.name : '?', colorId: voter ? voter.colorId : 'black' });
        });
      });
      const sorted = [...round.beasts].sort((a, b) =>
        (totals[b.name] - totals[a.name]) || (GD.ZODIAC.indexOf(a.name) - GD.ZODIAC.indexOf(b.name)));
      const pack = b => ({ name: b.name, votes: totals[b.name], isReal: b.isReal });
      return { rank1: { ...pack(sorted[0]), hidden: true }, rank2: { ...pack(sorted[1]), hidden: false }, totals, chips };
    },

    /** 終局計分：保留真品每尊 +1；好人過半抓到老朝奉 +1；藥不然沒抓到方震 +1；老朝奉沒抓到許願 +2 */
    score(room) {
      let savedReal = 0;
      room.rounds.forEach(rd => {
        const vr = rd.voteResults;
        if (vr) { if (vr.rank1.isReal) savedReal++; if (vr.rank2.isReal) savedReal++; }
      });
      const by = r => room.players.find(p => p.role === r);
      const good = room.players.filter(p => GD.isGood(p.role));
      const lao = by('老朝奉'), yao = by('藥不然'), xu = by('許願'), fang = by('方震');
      const pv = room.personVotes || {};
      const votesForLao = good.filter(p => pv[p.id] === lao.id).length;   // 鄭國渠不屬好人，其票本就無效
      const laoCaught = votesForLao > good.length / 2;
      const fangCaught = pv[yao.id] === fang.id;
      const xuCaught = pv[lao.id] === xu.id;
      const totalScore = savedReal + (laoCaught ? 1 : 0) + (fangCaught ? 0 : 1) + (xuCaught ? 0 : 2);
      const xuWon = totalScore >= GD.CONFIG.WIN_SCORE;
      return { totalScore, savedReal, laoCaught, votesForLao, goodCount: good.length, fangCaught, xuCaught, xuWon,
               winningCamp: xuWon ? '許願陣營' : '老朝奉陣營' };
    }
  };

  GD.Rules = Rules;
})(window.GD);
