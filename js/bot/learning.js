/* ============================================================================
 * bot/learning.js — BotLearningEngine（自我學習與基因修正・含後段反轉誤判自信調降）
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Genes } = GD;
  const STEP_CAP = 0.10;
  const REVERT = 0.06;

  const realOf = (rd, name) => (rd.beasts.find(b => b.name === name) || {}).isReal;

  function ballotFacts(room, bot) {
    const facts = { real: 0, fake: 0, duped: [], fakeRounds: [] };
    room.rounds.forEach((rd, r) => {
      const ballot = rd.votes[bot.id] || {};
      Object.entries(ballot).forEach(([name, n]) => {
        if (realOf(rd, name)) facts.real += n; else {
          facts.fake += n;
          facts.fakeRounds.push({ round: r + 1, beast: name, n });
          const liar = rd.speeches.find(sp => {
            const p = U.byId(room, sp.playerId);
            return p && !GD.isGood(p.role) && sp.playerId !== bot.id && (sp.p?.claims || []).some(c => c.beast === name && c.real);
          });
          if (liar) facts.duped.push({ round: r + 1, beast: name, n, liarId: liar.playerId });
        }
      });
    });
    return facts;
  }

  function evaluate(room, bot) {
    const g = room.gameOver, good = GD.isGood(bot.role);
    const won = good ? g.xuWon : !g.xuWon;
    const notes = [];
    const add = (gene, d, why) => notes.push({ gene, d, why });
    const f = ballotFacts(room, bot);
    const pv = room.personVotes[bot.id];
    const target = U.byId(room, pv);
    const lao = room.players.find(p => p.role === '老朝奉');
    const minds = room.rounds.map(rd => rd.mind[bot.id]).filter(Boolean);

    if (good) {
      /* --- 鑑寶票：被騙票 / 全中 --- */
      if (f.duped.length) {
        const liar = U.byId(room, f.duped[0].liarId);
        add('skepticism', 0.04 + 0.02 * Math.min(2, f.duped.length - 1),
          `第 ${f.duped[0].round} 輪聽信 ${U.tag(liar)}（真身【${liar && liar.role}】）的宣稱，把 ${f.duped[0].n} 票投給贗品【${f.duped[0].beast}】`);
        add('conformity', -0.03, '被壞人帶風向騙票，降低盲從前手宣稱的傾向');
      } else if (f.fake >= 2) {
        add('skepticism', 0.03, `三輪有 ${f.fake} 票落在贗品上，查證不足`);
      } else if (f.real >= 4 && f.fake === 0) {
        add('skepticism', -0.015, `三輪 ${f.real} 票全中真品，判斷穩定，略微放鬆多疑`);
      }

      /* --- 後段順位遭老朝奉反轉卻過度自信重壓贗品：調降自信值 (assertiveness) --- */
      room.rounds.forEach((rd, rIdx) => {
        const myPos = rd.passOrder.indexOf(bot.id);
        const myLog = rd.turnLogs[bot.id] || { inspect: [] };
        const myBallot = rd.votes[bot.id] || {};
        (myLog.inspect || []).forEach(ins => {
          const actualReal = realOf(rd, ins.beastName);
          const votedCnt = myBallot[ins.beastName] || 0;
          if (myPos >= 4 && ins.displayedReal === true && actualReal === false && votedCnt >= 2) {
            add('assertiveness', -0.045,
              `第 ${rIdx + 1} 輪我排在後段（${U.nth(myPos)}）查驗【${ins.beastName}】顯示真品，卻忽略後段極易遭老朝奉反轉而重壓 ${votedCnt} 票贗品，應調降盲目自信並學會保留籌碼`);
            add('conformity', 0.025,
              `第 ${rIdx + 1} 輪後段個人視野遭反轉污染，應多參考前段好人的乾淨資訊`);
          }
        });
      });

      /* --- 終局鑑人 --- */
      const hitLao = target && target.id === lao.id;
      const followed = bot.final && bot.final.followId;
      if (hitLao) {
        add('assertiveness', 0.03, `終局鑑人命中老朝奉（${U.tag(target)}），號召與判斷有效`);
        if (followed) add('conformity', 0.02, '附議的集火對象確實是老朝奉，這次從眾是對的');
      } else if (target) {
        if (followed) {
          const caller = U.byId(room, followed);
          add('conformity', -0.05, `附議 ${U.tag(caller)} 集火了 ${U.tag(target)}（真身【${target.role}】）卻抓錯，從眾成本高`);
          add('skepticism', 0.03, `未充分查證${caller && !caller.isBot ? '真人' : ''}號召的可信度`);
        } else if (GD.isGood(target.role)) {
          add('skepticism', 0.02, `鑑人誤指好人 ${U.tag(target)}，嫌疑排名需要更保守`);
          add('assertiveness', -0.03, `終局過度自信指認好人隊友 ${U.tag(target)}，下次未握有鐵證前應收斂號召鋒芒`);
        }
      }

      /* --- 身分暴露 --- */
      if (bot.role === '許願' && g.xuCaught) add('assertiveness', -0.04, '許願被老朝奉指認，發言曝光度偏高，收斂鋒芒');
      if (bot.role === '方震') {
        const pushed = minds.some(m => m.suspectId);
        if (g.fangCaught && pushed) add('assertiveness', -0.04, '帶集火的動作太明顯，被藥不然認出是方震，下次更低調');
        else if (pushed && g.laoCaught) add('assertiveness', 0.03, '用公開理由帶集火，成功抓到老朝奉且沒暴露自己');
      }
      if (!won) add('skepticism', 0.02, '本局許願陣營落敗，整體再提高警覺');
    } else {
      /* --- 壞人：帶風向成效 --- */
      const lies = minds.filter(m => m.mode === 'lie' || m.mode === 'follow');
      lies.forEach(m => {
        const rd = room.rounds.find(r => r.mind[bot.id] === m);
        const vr = rd.voteResults;
        const inTop = vr && (vr.rank1.name === m.beast || vr.rank2.name === m.beast);
        const fake = realOf(rd, m.beast) === false;
        if (inTop && fake) add('deception', 0.03, `第 ${rd.roundNum} 輪帶風向推【${m.beast}】成功擠進前二，且為贗品`);
        else if (!inTop) add('deception', -0.02, `第 ${rd.roundNum} 輪推【${m.beast}】沒人買單，帶風向手法太硬`);
      });
      const honest = minds.filter(m => m.mode === 'camouflage').length;

      /* --- 壞人：是否被識破 --- */
      const goodVotes = room.players.filter(p => GD.isGood(p.role) && room.personVotes[p.id] === bot.id).length;
      if (bot.role === '老朝奉') {
        if (g.laoCaught) add('camouflage', 0.06, `鑑人環節 ${g.votesForLao}/${g.goodCount} 位好人指認我，偽裝失敗`);
        else add('deception', 0.025, `鑑人環節只有 ${g.votesForLao}/${g.goodCount} 位好人指認我，成功藏身`);
        if (g.xuCaught) add('deception', 0.02, '成功指認許願，判讀好人發言有效');
      } else if (goodVotes >= 2) {
        add('camouflage', 0.05, `${goodVotes} 位好人把鑑人票投給我，嫌疑偏高`);
      } else if (goodVotes === 0) {
        add('deception', 0.02, '全場好人都沒懷疑我，偽裝成功');
      }
      if (bot.role === '藥不然') {
        if (g.fangCaught) add('assertiveness', 0.02, '成功指認方震，偵測亮牌者有效');
      }

      /* --- 壞人：策略失衡 --- */
      if (!won) {
        if (lies.length <= 1 && honest >= 2) add('deception', 0.05, `三輪有 ${honest} 輪只講真話，沒能干擾好人票型就輸了，需要更積極帶風向`);
        else if (f.real > f.fake + 1) add('deception', 0.03, `我投出 ${f.real} 張真品票、僅 ${f.fake} 張贗品票，幫好人加了太多分`);
        else add('camouflage', 0.02, '帶風向過於集中，被好人對上時序，需要穿插真話');
      } else {
        add('deception', 0.02, '本局造假集團勝利，強化目前打法');
      }
    }

    const rec = Genes.record(bot.botId);
    const lr = Math.max(0.5, 1 - rec.games * 0.03);
    const delta = {};
    Genes.KEYS.forEach(k => { delta[k] = 0; });
    const kept = notes.filter(n => n.d !== 0 && n.why);
    kept.forEach(n => { delta[n.gene] += n.d * lr; });
    Genes.KEYS.forEach(k => { delta[k] = U.round3(U.clamp(delta[k], -STEP_CAP, STEP_CAP)); });

    const before = bot.genes || Genes.load(bot.botId);
    const factory = GD.Roster.baseGenes(bot.botId);
    Genes.KEYS.forEach(k => { delta[k] += (factory[k] - before[k]) * REVERT; });
    Genes.KEYS.forEach(k => { delta[k] = U.round3(U.clamp(delta[k], -STEP_CAP, STEP_CAP)); });
    const after = {};
    Genes.KEYS.forEach(k => { after[k] = Genes.clamp(before[k] + delta[k]); });
    Genes.KEYS.forEach(k => { delta[k] = U.round3(after[k] - before[k]); });

    return { botId: bot.botId, name: bot.name, role: bot.role, won, before, after, delta, notes: kept, lr: U.round3(lr), games: rec.games + 1 };
  }

  function finalize(room) {
    if (room.learning || !room.gameOver) return false;
    const out = {};
    room.players.filter(p => p.isBot).forEach(bot => {
      if (Genes.hasLearned(room.gameId, bot.botId)) {
        const h = Genes.record(bot.botId).history.find(x => x.gameId === room.gameId);
        out[bot.id] = h.result;
        return;
      }
      const res = evaluate(room, bot);
      Genes.save(bot.botId, res.after, {
        won: res.won, delta: res.delta,
        entry: { gameId: room.gameId, role: bot.role, won: res.won, delta: res.delta, result: res }
      });
      out[bot.id] = res;
    });
    room.learning = out;
    return true;
  }

  GD.Learning = { evaluate, finalize, ballotFacts, STEP_CAP };
})(window.GD);