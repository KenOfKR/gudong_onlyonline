/* ============================================================================
 * bot/learning.js — BotLearningEngine（嚴格時序校驗與因果歸因重構版）
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U, Genes } = GD;
  const STEP_CAP = 0.08;
  const REVERT = 0.06;

  const realOf = (rd, name) => (rd.beasts.find(b => b.name === name) || {}).isReal;

  /**
   * 嚴格時序校驗的選票因果分析：
   * - 必須確認號召者／說謊者的發言時間早於 Bot 本身，才能構成影響因果。
   */
  function ballotFacts(room, bot) {
    const facts = { real: 0, fake: 0, duped: [], trustedGood: [], fakeRounds: [] };
    room.rounds.forEach((rd, r) => {
      const ballot = rd.votes[bot.id] || {};
      const myLog = (rd.turnLogs && rd.turnLogs[bot.id]) || { inspect: [] };
      const myIns = myLog.inspect || [];
      const speeches = rd.speeches || [];
      const botSpeechIdx = speeches.findIndex(s => s.playerId === bot.id);

      Object.entries(ballot).forEach(([name, n]) => {
        if (!n || n <= 0) return;
        const isReal = realOf(rd, name);
        const sawRealMyself = myIns.some(i => i.beastName === name && i.displayedReal === true);

        if (isReal) {
          facts.real += n;
          // 因果確認：我未親眼驗出真品，但在我發言／投票前，有前手好人「親眼驗過且公開宣稱」
          if (!sawRealMyself) {
            const reliableCaller = speeches.find((sp, idx) => {
              if (sp.playerId === bot.id) return false;
              // 時序校驗：對方發言必須早於自己（若自己沒發言則整輪皆可）
              if (botSpeechIdx >= 0 && idx >= botSpeechIdx) return false;
              const p = U.byId(room, sp.playerId);
              if (!p || !GD.isGood(p.role)) return false;
              const claimedReal = (sp.p?.claims || []).some(c => c.beast === name && c.real === true);
              if (!claimedReal) return false;
              const callerLog = (rd.turnLogs && rd.turnLogs[p.id]) || { inspect: [] };
              return (callerLog.inspect || []).some(i => i.beastName === name && i.displayedReal === true);
            });
            if (reliableCaller) {
              facts.trustedGood.push({ round: r + 1, beast: name, n, callerId: reliableCaller.playerId });
            }
          }
        } else {
          facts.fake += n;
          facts.fakeRounds.push({ round: r + 1, beast: name, n });
          // 因果確認：在我發言／投票前，有壞人公開謊稱這尊贗品為真
          const liar = speeches.find((sp, idx) => {
            if (sp.playerId === bot.id) return false;
            if (botSpeechIdx >= 0 && idx >= botSpeechIdx) return false;
            const p = U.byId(room, sp.playerId);
            return p && !GD.isGood(p.role) && (sp.p?.claims || []).some(c => c.beast === name && c.real === true);
          });
          if (liar && !sawRealMyself) {
            facts.duped.push({ round: r + 1, beast: name, n, liarId: liar.playerId });
          }
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
      /* 1. 好人陣營因果獎懲 */
      if (f.duped.length > 0) {
        const liar = U.byId(room, f.duped[0].liarId);
        add('skepticism', 0.03,
          `第 ${f.duped[0].round} 輪受前手壞人 ${U.tag(liar)} 宣稱誤導，將 ${f.duped[0].n} 票投給贗品【${f.duped[0].beast}】`);
        add('conformity', -0.025, '採信無依據的壞人風向受騙，微調降低盲從傾向');
      }

      if (f.trustedGood.length > 0) {
        const tGood = f.trustedGood[0];
        const caller = U.byId(room, tGood.callerId);
        add('conformity', 0.03,
          `第 ${tGood.round} 輪精準採信有據好人 ${U.tag(caller)} 資訊，成功集中 ${tGood.n} 票投中真品【${tGood.beast}】`);
        add('skepticism', -0.02, '與可靠好人情報協同成功，適度降低過度猜忌');
      } else if (f.real >= 4 && f.fake === 0) {
        add('skepticism', -0.015, `三輪 ${f.real} 票全中真品且零失誤，判斷穩定，放鬆過度多疑`);
      }

      /* 2. 後段順位反轉風險意識 */
      room.rounds.forEach((rd, rIdx) => {
        const myPos = rd.passOrder.indexOf(bot.id);
        const myLog = rd.turnLogs[bot.id] || { inspect: [] };
        const myBallot = rd.votes[bot.id] || {};
        (myLog.inspect || []).forEach(ins => {
          const actualReal = realOf(rd, ins.beastName);
          const votedCnt = myBallot[ins.beastName] || 0;
          if (myPos >= 4 && ins.displayedReal === true && actualReal === false && votedCnt >= 2) {
            add('assertiveness', -0.035,
              `第 ${rIdx + 1} 輪後段順位（${U.nth(myPos)}）查驗遭反轉卻重壓 ${votedCnt} 票，調降後段盲目自信`);
            add('conformity', 0.02,
              `第 ${rIdx + 1} 輪後段視野受污染，提高對前段乾淨資訊的採信權重`);
          }
        });
      });

      /* 3. 終局鑑人因果驗證 */
      const hitLao = target && lao && target.id === lao.id;
      const followed = bot.final && bot.final.followId;
      if (hitLao) {
        add('assertiveness', 0.03, `終局鑑人精準命中老朝奉（${U.tag(target)}），決策有效`);
        if (followed) {
          add('conformity', 0.025, '附議有邏輯依據的集火號召並成功抓出老朝奉');
          add('skepticism', -0.015, '成功識別可信帶隊者');
        }
      } else if (target) {
        if (followed) {
          const caller = U.byId(room, followed);
          if (caller && !GD.isGood(caller.role) && GD.isGood(target.role)) {
            add('conformity', -0.035, `遭壞人 ${U.tag(caller)} 誤導而附議集火好人 ${U.tag(target)}`);
            add('skepticism', 0.025, `未識破壞人 ${U.tag(caller)} 假號召`);
          }
        } else if (GD.isGood(target.role)) {
          add('assertiveness', -0.025, `終局缺乏鐵證下誤指好人隊友 ${U.tag(target)}，收斂鋒芒`);
        }
      }

      if (bot.role === '許願' && g.xuCaught) {
        add('assertiveness', -0.035, '許願遭老朝奉識破指認，發言鋒芒太露，應更低調');
      }
      if (bot.role === '方震') {
        const pushed = minds.some(m => m.suspectId);
        if (g.fangCaught && pushed) add('assertiveness', -0.035, '帶集火動作過於明顯遭藥不然抓出方震身分');
        else if (pushed && g.laoCaught && !g.fangCaught) add('assertiveness', 0.03, '以公開理由帶隊抓出老朝奉且完美隱藏方震身分');
      }
    } else {
      /* ---------------- 壞人陣營：嚴格謊言轉換率與偽裝歸因 ---------------- */
      const lies = minds.filter(m => m.mode === 'lie' || m.mode === 'follow');
      const camos = minds.filter(m => m.mode === 'camouflage');

      // 檢查每一個謊言是否「確實由自己發言推動」並「成功誤導好人」
      lies.forEach(m => {
        const rdIdx = room.rounds.findIndex(r => r.mind[bot.id] === m);
        const rd = room.rounds[rdIdx];
        if (!rd || !rd.voteResults) return;
        const vr = rd.voteResults;
        const isFakeBeast = realOf(rd, m.beast) === false;
        if (!isFakeBeast) return;

        // 時序與發言校驗：確認該 Bot 在該輪發言中確實宣稱該贗品為真
        const mySpeech = (rd.speeches || []).find(s => s.playerId === bot.id);
        const didIBlobClaimIt = mySpeech && (mySpeech.p?.claims || []).some(c => c.beast === m.beast && c.real === true);
        if (!didIBlobClaimIt) return; // 若自己根本沒公開推這隻，不算我的謊言成果

        let goodVotesOnMyLie = 0;
        room.players.filter(p => GD.isGood(p.role)).forEach(gp => {
          goodVotesOnMyLie += ((rd.votes && rd.votes[gp.id]) || {})[m.beast] || 0;
        });

        const inTop = (vr.rank1.name === m.beast || vr.rank2.name === m.beast);
        if (inTop && goodVotesOnMyLie >= 2) {
          add('deception', 0.03, `成功推動贗品【${m.beast}】吸引 ${goodVotesOnMyLie} 張好人選票並擠進前二`);
        } else if (goodVotesOnMyLie === 0) {
          // 嚴格失敗懲罰：自己公開推假貨卻完全沒好人買單
          add('deception', -0.025, `強推贗品【${m.beast}】但好人 0 票買單，帶風向失敗`);
        }
      });

      const goodVotesAgainstMe = room.players.filter(p => GD.isGood(p.role) && room.personVotes[p.id] === bot.id).length;

      if (bot.role === '老朝奉') {
        if (g.laoCaught) {
          add('camouflage', -0.03, `遭 ${g.votesForLao}/${g.goodCount} 位好人集火抓出，偽裝破綻過大`);
          if (lies.length >= 2) add('deception', -0.02, '頻繁逆風說謊導致時序破綻過大');
        } else if (camos.length >= 1 && g.votesForLao <= 1) {
          add('camouflage', 0.03, `透過真話偽裝與潛伏，終局僅得 ${g.votesForLao} 票成功隱身`);
        }
      } else {
        if (goodVotesAgainstMe >= 2 && !minds.some(m => m.confess)) {
          add('camouflage', -0.025, `未認壞卻吸引 ${goodVotesAgainstMe} 張好人鑑人票，潛伏失敗`);
        } else if (goodVotesAgainstMe === 0 && camos.length >= 1 && won) {
          add('camouflage', 0.025, `確實執行潛伏策略成功避開好人嫌疑`);
        }
      }

      if (bot.role === '藥不然' && g.fangCaught) {
        add('assertiveness', 0.02, '成功識破並指認方震');
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
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Learning;
})(typeof window !== 'undefined' ? window : global);