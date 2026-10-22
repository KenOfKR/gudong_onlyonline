/* ============================================================================
 * bot/strategy.js — 電腦玩家的決策（技能、傳遞、發言計畫、投票、鑑人・高階博弈強化版）
 *
 * 發言與投票共用同一份「計畫」(plan)，確保言行一致；計畫與推理依據同時寫入
 * round.mind[botId]，供終局覆盤逐條引用（有理有據，而非事後編故事）。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Rules, Mind } = GD;
  const rnd = Math.random;
  const S = {};
  const ZODIAC_LIST = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];
  const zIdx = name => {
    const arr = (GD.CONFIG && GD.CONFIG.ZODIAC) || ZODIAC_LIST;
    const idx = arr.indexOf(name);
    return idx >= 0 ? idx : 99;
  };

  /* ---------------------------------------------------------------- 查驗階段 */

  /** ★ [強化 1] 查驗獸首：考量十二生肖平票優勢（排前面者平手勝出），微幅偏重生肖序靠前之獸首並保留隨機度 */
  S.inspectPicks = (bot, room) => {
    const rd = U.curRound(room);
    const quota = Rules.inspectQuota(bot);
    const weighted = [...rd.beasts].sort((a, b) => {
      return (zIdx(a.name) * 0.08 + rnd()) - (zIdx(b.name) * 0.08 + rnd());
    });
    return weighted.slice(0, quota).map(b => b.name);
  };

  S.skill = function (bot, room, A) {
    const { ctx } = A, { genes, rd } = ctx;
    const others = room.players.filter(p => p.id !== bot.id);

    switch (bot.role) {
      case '方震': {
        const done = new Set();
        room.rounds.forEach(r => { const l = r.turnLogs[bot.id]; if (l && l.fangTargetId) done.add(l.fangTargetId); });
        const cand = Object.values(A.prof).filter(r => !done.has(r.player.id))
          .sort((a, b) => (b.evil + rnd() * 25) - (a.evil + rnd() * 25));
        const t = (cand[0] && cand[0].player) || U.pick(others);
        return { kind: 'fang', targetId: t.id };
      }
      case '老朝奉': {
        const pool = Engine().remainingToAct(room).filter(p => !ctx.partner || p.id !== ctx.partner.id);
        const p = U.clamp(0.5 + 0.4 * genes.deception, 0.3, 0.92);
        return { kind: 'lao', active: pool.length >= 2 && rnd() < p };
      }
      case '藥不然': {
        const leftIds = new Set(Engine().remainingToAct(room).map(p => p.id));
        const cand = Object.values(A.prof)
          .filter(r => (!ctx.partner || r.player.id !== ctx.partner.id) && !r.knownEvil && !r.player.isPermanentlyAmbushed && !r.player.isAmbushed)
          // ★ 若我是第 1 棒首家且只會傳給下一棒，優先偷襲本輪還沒行動、但我不打算立刻傳給他的高價值目標
          .map(r => {
            const actBonus = leftIds.has(r.player.id) ? 10 : 0; // 優先砍本輪還沒行動的人，讓他當場致盲
            return {
              r,
              s: (r.probs['許願'] || 0) + (r.probs['方震'] || 0) * 1.3 + (r.probs['姬雲浮'] || 0) * 0.8 + r.ally * 0.4 + actBonus + rnd() * 12
            };
          })
          .sort((a, b) => b.s - a.s);
        return cand.length ? { kind: 'yao', targetId: cand[0].r.player.id } : { kind: 'skip' };
      }
      case '鄭國渠': {
        /* ★ [強化 2] 鄭國渠防自爆：若我是最後一棒（尾家，後面已無人要驗），不發動封鎖以免白白暴露身分 */
        const leftToAct = Engine().remainingToAct(room);
        if (leftToAct.length === 0) return { kind: 'skip' };
        const seenReal = ctx.myIns.find(i => i.displayedReal);       // 優先封鎖自己看到的真品，讓後面的好人驗不到
        return { kind: 'zheng', beast: seenReal ? seenReal.beastName : U.pick(rd.beasts).name };
      }
      default: return { kind: 'skip' };
    }
  };

  /** 指定下一位。好人把信任的人排前面、把嫌疑人留到最後（老朝奉越晚行動，能反轉的好人越少）*/
  S.nextPlayer = function (bot, room, A) {
    const left = Engine().remainingToAct(room);
    if (!left.length) return null;
    const recOf = p => A.prof[p.id];
    const choose = (p, why) => { A.ctx.log.passWhy = why; return p.id; };
    const trust = p => (recOf(p)?.ally || 0) - (recOf(p)?.evil || 0);
    const basis = p => {
      const r = recOf(p);
      return r && r.reasons[0] ? `（${r.reasons[0]}）` : '（目前沒有任何可疑紀錄）';
    };

    if (left.length === 1) return choose(left[0], '只剩他還沒行動，沒有其他選擇');

    /* ★ [強化 3] 藥不然防自爆鐵律：若我本輪剛偷襲了某位尚未行動的玩家，絕不直接把手機傳給他！
       中間一定要墊至少一位其他玩家，否則受害者一接過手機發現被偷襲（特別是在前段棒次），會瞬間鎖定上一棒的我就是藥不然！ */
    const justAmbushedIds = A.ctx.log.ambushIds || [];
    if (bot.role === '藥不然' && justAmbushedIds.length && left.length > 1) {
      const safeLeft = left.filter(p => !justAmbushedIds.includes(p.id));
      if (safeLeft.length > 0) {
        const bufferPick = [...safeLeft].sort((a, b) => trust(b) - trust(a))[0];
        return choose(bufferPick, `我剛暗中偷襲了目標，絕不能直接把手機交給受害者暴露自己在上一棒，先傳給${U.tag(bufferPick)}墊一棒製造不在場證明`);
      }
    }

    if (A.ctx.isGood) {
      const sorted = [...left].sort((a, b) => trust(b) - trust(a) + (rnd() - 0.5) * 10);
      const pick = sorted[0];
      const sus = A.topSuspect && left.find(p => p.id === A.topSuspect.player.id);
      const tail = sus && sus.id !== pick.id ? `；同時把嫌疑最高的${U.tag(sus)}留到後面，老朝奉越晚行動，能反轉的好人越少` : '';
      return choose(pick, `他是剩下的人裡我最放心的${basis(pick)}${tail}`);
    }

    const rd = A.ctx.rd, t = A.ctx.t, partner = A.ctx.partner;
    const partnerLeft = partner && left.find(p => p.id === partner.id);

    /* ---- 位置學 ---- */
    if (A.ctx.myPos === 5 && left.length === 2) {
      const other = left.find(p => !(partner && p.id === partner.id)) || left[0];
      if (t < 2 && partnerLeft) {
        if (rnd() < 0.35 + 0.55 * A.ctx.genes.deception) {
          return choose(other, `第 ${t + 1} 回合讓同伴${U.tag(partner)}當尾家，他下一輪就是首家；代價是第六位控出第八位，可能被看成同隊，我賭欺騙力夠`);
        }
        return choose(partner, `第 ${t + 1} 回合本想讓同伴當尾家，但第六位控出第八位同隊太明顯，這次放棄首家優勢保住身分`);
      }
      if (t === 2) {
        const bait = [...left].filter(p => !partner || p.id !== partner.id).sort((a, b) => trust(b) - trust(a))[0];
        const tailP = left.find(p => p.id !== (bait && bait.id));
        if (bait && tailP) {
          return choose(bait, `第 3 回合尾家沒有首家優勢，我讓看起來最像好人的${U.tag(tailP)}壓軸：外界會以為「第六位控出第八位」是同隊，好人間會互疑`);
        }
      }
      if (t < 2 && !partnerLeft) {
        const weak = [...left].sort((a, b) => trust(a) - trust(b))[0];
        const tailP = left.find(p => p.id !== weak.id);
        const strongTail = trust(tailP) <= trust(weak);
        return choose(strongTail ? weak : tailP, `第 ${t + 1} 回合的尾家下一輪當首家，我不把首家優勢送給好人裡最被信任的人${basis(weak)}`);
      }
    }
    if (t < 2 && partnerLeft && left.length > 2) {
      const rest = left.filter(p => p.id !== partner.id);
      const goodish = [...rest].sort((a, b) => trust(b) - trust(a))[0];
      return choose(goodish, `把同伴${U.tag(partner)}留到後段，爭取讓他當第 ${t + 1} 回合尾家、下一輪拿首家優勢；先送給看起來最像好人的對象${basis(goodish)}`);
    }
    if (bot.role === '藥不然' && partnerLeft && !rd.laoActive && t === 2) {
      return choose(partner, `他是我的秘密同伴，先送過去讓老朝奉掌握查驗順序，再決定要不要發動擾亂`);
    }
    if (rd.laoActive || bot.role === '老朝奉') {
      const goodish = [...left].sort((a, b) => trust(b) - trust(a));
      return choose(goodish[0], `${rd.laoActive ? '擾亂已啟動' : '我可能啟動擾亂'}，把查驗機會送給看起來最像好人的他，讓他看到被反轉的結果並拿去帶偏好人${basis(goodish[0])}`);
    }
    const pick = U.pick(left);
    return choose(pick, `沒有特別需要安排的對象，隨機挑他，避免傳遞習慣被看出規律`);
  };

  /* ---------------------------------------------------------------- 發言計畫 */

  function conflictsOf(A) {
    const t = A.ctx.t + 1;
    return Object.values(A.prof).flatMap(r => r.conflicts.filter(c => c.round === t));
  }

  function shouldHideBlind(bot, genes) {
    if (bot.role === '許願' || bot.role === '方震') return true;
    return rnd() >= U.clamp(0.1 + 0.3 * genes.assertiveness, 0.1, 0.4);
  }

  S.plan = function (bot, room) {
    const A = Mind.analyze(bot, room), { ctx } = A;
    const { genes, rd, myIns, names, t } = ctx;
    const why = [];
    // 後驗機率相同時，優先排生肖序靠前者（平票勝出優勢）
    const ranked = [...A.post].sort((a, b) => (b.pReal - a.pReal) || (zIdx(a.name) - zIdx(b.name)));
    const plan = { mode: 'truth', beast: ranked[0].name, avoid: [], claims: [], suspectId: null,
                   padBeast: null, partnerBeast: null, why };
    const log = ctx.log;
    const hideBlind = ctx.isGood && !!log.blind && shouldHideBlind(bot, genes);

    if (ctx.isGood) {
      /* 好人誠實：講自己真正看到的；許願只講 1 尊以藏住「雙查驗」身分 */
      let say = myIns.slice();
      if (bot.role === '許願' && say.length >= 2) {
        const reals = say.filter(i => i.displayedReal).sort((a, b) => zIdx(a.beastName) - zIdx(b.beastName));
        const keep = reals[0] || say[0];
        say = [keep];
        why.push('身為許願，雙查驗只報 1 尊以藏住身分');
      }
      plan.claims = say.map(i => ({ beast: i.beastName, real: i.displayedReal }));
      plan.avoid = myIns.filter(i => !i.displayedReal).map(i => i.beastName);
      const cand = ranked.filter(b => !plan.avoid.includes(b.name));
      plan.beast = (cand[0] || ranked[0]).name;

      /* ★ [強化 4] 方震驗出「好人」時的戰術合流：
         若方震在歷輪親手確認過某位玩家是好人，且該好人在本輪已發言報出某尊真品，方震直接鎖定跟隨該好人的真品線！ */
      if (bot.role === '方震') {
        const verifiedGoodIds = new Set();
        room.rounds.forEach(r => {
          const l = r.turnLogs[bot.id];
          if (l && l.fangTargetId && l.fangCamp === 'good') verifiedGoodIds.add(l.fangTargetId);
        });
        const trustedSp = (rd.speeches || []).find(sp => verifiedGoodIds.has(sp.playerId) && (sp.p?.claims || []).some(c => c.real));
        if (trustedSp) {
          const goodClaim = trustedSp.p.claims.find(c => c.real && !plan.avoid.includes(c.beast));
          if (goodClaim) {
            plan.beast = goodClaim.beast;
            why.push(`我私下用【方震】確認過${U.tag(U.byId(room, trustedSp.playerId))}是鐵好人，直接跟隨他報的【${plan.beast}】真品線衝票`);
          }
        }
      }

      /* ★ [強化 5] 平民困惑／被封鎖時的安全偽裝：
         若黃煙煙／木戶加奈等好人本輪因困惑或被封鎖導致 myIns 為空（無法辨別真偽），
         為避免全場只有平民喊「驗不到」而被藥不然誤當成方震狙擊，有 65% 機率順著後驗最像真品的獸首做安全表態（同時幫真方震打掩護）！ */
      const isConfusedOrBlockedGood = !log.blind && myIns.length === 0 && bot.role !== '方震';
      const coverBluff = isConfusedOrBlockedGood && rnd() < 0.65;

      const bluff = (bot.role === '方震' && !log.blind) || hideBlind || coverBluff;
      if (bluff) {
        plan.claims = [{ beast: plan.beast, real: true }];
        plan.bluff = true;
        plan.hideBlind = hideBlind;
        why.push(hideBlind
          ? `我這輪遭偷襲、什麼都看不到，但不輕易說出被偷襲${bot.role === '許願' || bot.role === '方震' ? `（我是${bot.role}，說出口等於告訴壞人這刀砍中了要害）` : '（說了只會讓壞人確認偷襲有效）'}；改把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出`
          : coverBluff
          ? `我這輪查驗顯示無法辨別真偽，但為了不暴露弱點並替方震分擔保護色，我順著後驗最穩的【${plan.beast}】報真品護航`
          : `我是方震，看不到獸首。為了不被藥不然靠「驗不到」認出，我把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出`);
      } else if (log.blind) {
        why.push('我這輪遭偷襲，決定公開說出來，好讓大家知道偷襲者排在我前面的行動者之中');
      }
      if (!bluff) why.push(myIns.length
        ? `我親眼看到 ${myIns.map(i => `【${i.beastName}】${i.displayedReal ? '真' : '假'}`).join('、')}，結合前手宣稱，後驗最像真品的是【${plan.beast}】(${Math.round(A.post.find(b => b.name === plan.beast).pReal * 100)}%)`
        : `這輪我${log.blind ? '遭偷襲' : '無法辨別真偽'}，只能依前手宣稱的可信度，後驗最像真品的是【${plan.beast}】`);
    } else {
      const knownReal = myIns.filter(i => i.displayedReal).map(i => i.beastName);
      const knownFake = myIns.filter(i => !i.displayedReal).map(i => i.beastName);
      const partnerMind = ctx.partner && rd.mind[ctx.partner.id];
      const pLie = U.clamp(0.25 + 0.6 * genes.deception - 0.25 * genes.camouflage + (t === 2 ? 0.2 : 0), 0.12, 0.95);

      if (partnerMind && partnerMind.mode === 'lie' && !knownReal.includes(partnerMind.beast) && rnd() < 0.75) {
        plan.mode = 'follow'; plan.beast = partnerMind.beast; plan.partnerBeast = partnerMind.beast;
        plan.claims = [{ beast: plan.beast, real: true }];
        why.push(`同伴已帶風向推【${plan.beast}】，我順著他附和以加固假線`);
      } else if (rnd() < pLie) {
        // 壞人挑假貨帶風向時，優先挑生肖序較靠前的贗品（平票時能壓過後面的真品！）
        const fakeCands = [...A.post]
          .filter(b => !knownReal.includes(b.name))
          .sort((a, b) => (a.pReal - b.pReal) || (zIdx(a.name) - zIdx(b.name)));
        const lie = knownFake[0] || (fakeCands[0] && fakeCands[0].name) || ranked[ranked.length - 1].name;
        plan.mode = 'lie'; plan.beast = lie;
        plan.claims = [{ beast: lie, real: true }];
        if (knownReal.length && rnd() < 0.2 + 0.6 * genes.deception) {
          plan.claims.push({ beast: knownReal[0], real: false });
          plan.avoid = [knownReal[0]];
        }
        why.push(`我是【${bot.role}】，這輪帶風向：${knownFake.length ? `我看到【${lie}】是假的，卻宣稱它是真品` : `把票推向後驗最不像真品的【${lie}】`}`);
      } else {
        plan.mode = 'camouflage';
        plan.beast = knownReal[0] || ranked[0].name;
        plan.padBeast = knownFake[0] || null;
        plan.claims = [{ beast: plan.beast, real: true }];
        why.push(`我是【${bot.role}】，這輪選擇講真話偽裝成好人，票型再分 1 票給假貨`);
      }
    }

    /* ---- 票型採人：用公開的票型質問 ---- */
    const alreadyAsked = (rd.speeches || []).some(sp => sp.p && (sp.p.asked || []).length);
    if (ctx.isGood && t >= 1 && !alreadyAsked && A.fakeVoters.length && rnd() < 0.3 + 0.6 * genes.assertiveness) {
      const q = A.fakeVoters[0], hist = Mind.pubFakeVotes(room, q.player.id, t), last = hist[hist.length - 1];
      plan.askId = q.player.id; plan.askVotes = q.pubFake; plan.askBeast = last.beast; plan.askRound = last.round;
      why.push(`${U.tag(q.player)}累計 ${q.pubFake} 票投在已公開的贗品上（最近一次第 ${last.round} 輪的【${last.beast}】），票型全場看得到，先請他說明。他解釋得通就放過，解釋不通或閃躲就升高嫌疑`);
    }

    /* 被點名要說明為什麼把票投在贗品上 */
    if (A.askedMe && A.myFake.length) {
      plan.explain = { callerName: A.askedMe.callerName, votes: A.myFake };
      const canConfess = !ctx.isGood && (bot.role === '藥不然' || bot.role === '鄭國渠');
      const cantExplain = A.myFake.some(f => { const m = room.rounds[f.round - 1].mind[bot.id]; return m && m.mode === 'lie'; });
      const pConfess = canConfess ? U.clamp((cantExplain ? 0.35 : 0.08) + 0.4 * (1 - genes.camouflage), 0.05, 0.8) : 0;
      if (rnd() < pConfess) {
        const truthful = myIns.map(i => ({ beast: i.beastName, real: i.displayedReal }));
        const realIns = myIns.find(i => i.displayedReal);
        plan.mode = 'confess'; plan.confess = true; plan.claims = truthful;
        plan.beast = realIns ? realIns.beastName : ranked[0].name;
        plan.avoid = myIns.filter(i => !i.displayedReal).map(i => i.beastName);
        plan.partnerBeast = null; plan.padBeast = null;
        why.unshift(`${U.tag(U.byId(room, A.askedMe.callerId))}點名要我說明投贗品的理由。${cantExplain ? '我當時是故意帶風向，講不出站得住腳的理由' : '我不想硬編理由'}，而且藏身分的收益已經不大，乾脆認壞，把我真實的查驗結果攤開給隊友用`);
      } else {
        why.unshift(`${U.tag(U.byId(room, A.askedMe.callerId))}點名要我說明投贗品的理由，我照當時的發言與依據解釋${ctx.isGood ? '：我是真的被騙了' : '，維持好人的樣子'}`);
      }
    }

    /* ---- 方震：絕不裸跳，用公開理由帶集火 ---- */
    if (bot.role === '方震' && log.fangTargetId && log.fangCamp === 'evil') {
      const tgt = U.byId(room, log.fangTargetId);
      if (rnd() < 0.3 + 0.65 * genes.assertiveness) {
        plan.suspectId = tgt.id;
        why.push(`我私下查驗出${U.tag(tgt)}是壞人，但絕不能暴露方震身分；改用公開理由帶大家集火他`);
      }
    }

    /* ---- 鑑人佈局：附議可信真人的集火 / 第三輪點名最可疑者 / 壞人嫁禍 ---- */
    if (!plan.suspectId) {
      const hc = A.humanCall;
      if (ctx.isGood && hc && (A.prof[hc.targetId]?.ally || 0) < 85 && rnd() < 0.3 + 0.65 * genes.conformity) {
        plan.suspectId = hc.targetId; plan.followHuman = hc;
        why.push(`真人【${hc.callerName}】號召集火，其發言可信度夠，我附議`);
      } else if (ctx.isGood && A.topSuspect && (t === 2 || A.topSuspect.evil >= 55) && rnd() < 0.35 + 0.6 * genes.assertiveness) {
        plan.suspectId = A.topSuspect.player.id;
        why.push(`${U.tag(A.topSuspect.player)}嫌疑最高（${A.topSuspect.reasons[0] || '票型與發言矛盾'}），先為鑑人鋪梗`);
      } else if (!ctx.isGood && t === 2 && rnd() < 0.3 + 0.5 * genes.deception) {
        const scapegoat = Object.values(A.prof).filter(r => (!ctx.partner || r.player.id !== ctx.partner.id) && !r.knownEvil)
          .sort((a, b) => (b.ally - b.evil) - (a.ally - a.evil))[0];
        if (scapegoat) { plan.suspectId = scapegoat.player.id; why.push(`嫁禍給最像好人的${U.tag(scapegoat.player)}，轉移對我方的注意`); }
      }
    }

    /* ---- 寫入覆盤用紀錄 ---- */
    const top = Object.values(A.prof).sort((a, b) => b.evil - a.evil).slice(0, 2);
    rd.mind[bot.id] = {
      pos: ctx.myPos, mode: plan.mode, beast: plan.beast, avoid: plan.avoid, claims: plan.claims,
      suspectId: plan.suspectId, padBeast: plan.padBeast, why, hideBlind: !!plan.hideBlind,
      askId: plan.askId || null, confess: !!plan.confess, explained: !!plan.explain,
      followHuman: plan.followHuman ? plan.followHuman.callerId : null,
      insText: (log.inspect || []).map(i => i.resultText),
      blind: !!log.blind,
      post: A.post.map(b => ({ name: b.name, p: U.round3(b.pReal) })),
      laoAt: A.laoAt.map(U.round3),
      conflicts: conflictsOf(A).map(c => ({ ...c })),
      suspects: top.map(r => ({ id: r.player.id, evil: Math.round(r.evil), reasons: r.reasons.slice(0, 3) })),
      ts: Date.now()
    };
    return { plan, A };
  };

  /* ---------------------------------------------------------------- 投票 */

  /** ★ [強化 6] 鑑寶配票：兼顧言行一致、生肖序平票防禦與壞人抬轎搶前二名 */
  S.ballot = function (bot, room) {
    const rd = U.curRound(room), t = room.currentRoundIdx;
    const m = rd.mind[bot.id] || (S.plan(bot, room), rd.mind[bot.id]);
    const bank = bot.voteBank;
    if (bank <= 0) return {};
    const genes = bot.genes || GD.Genes.load(bot.botId);
    const confident = m.post.some(b => Math.abs(b.p - 0.5) > 0.3);
    let spend = bank;
    if (t < 2 && !confident && bank >= 2 && rnd() < 0.4 * (1.15 - genes.assertiveness)) spend = bank - 1;
    const ballot = {};

    if (!GD.isGood(bot.role)) {
      if (m.mode === 'camouflage' && m.padBeast && spend >= 2 && m.padBeast !== m.beast) {
        // 偽裝模式下：1 票投自己口頭喊的真品避免被抓「言行不一」，其餘票灌給贗品搶前二名！
        ballot[m.beast] = 1;
        ballot[m.padBeast] = spend - 1;
        return ballot;
      }
      // 壞人若發現自己喊的假貨全場只有自己 1 人喊（孤立無援），而場上有另一尊疑似假貨已有其他人喊投，分 1 票過去合力抬轎搶第 2 名
      const callCounts = {};
      (rd.speeches || []).forEach(sp => {
        const cb = sp.p && sp.p.callBeast;
        if (cb) callCounts[cb] = (callCounts[cb] || 0) + 1;
      });
      if ((callCounts[m.beast] || 0) <= 1 && spend >= 2) {
        const rallyFake = [...m.post]
          .filter(b => b.name !== m.beast && b.p <= 0.48 && (callCounts[b.name] || 0) >= 1)
          .sort((a, b) => (callCounts[b.name] || 0) - (callCounts[a.name] || 0) || (zIdx(a.name) - zIdx(b.name)))[0];
        if (rallyFake) {
          ballot[m.beast] = 1; // 留 1 票給自己喊的獸首，防止被「言行不一」規則抓包
          ballot[rallyFake.name] = spend - 1;
          return ballot;
        }
      }
    }

    if (spend > 0) ballot[m.beast] = spend;
    return ballot;
  };

  /* ---------------------------------------------------------------- 終局鑑人 */

  S.personVote = function (bot, room) {
    const A = Mind.analyze(bot, room), { ctx } = A;
    const last = [...room.rounds].reverse().map(r => r.mind[bot.id]).find(Boolean);
    const anyPool = room.players.filter(p => p.id !== bot.id && !(ctx.partner && p.id === ctx.partner.id) && !(A.prof[p.id] && (A.prof[p.id].knownEvil || (ctx.isGood && A.prof[p.id].confessed))));
    const any = U.pick(anyPool.length ? anyPool : room.players.filter(p => p.id !== bot.id)).id;
    let id = null, why = '', followId = null;
    if (ctx.isGood) {
      if (A.humanCall && (A.prof[A.humanCall.targetId]?.ally || 0) < 85 && rnd() < 0.3 + 0.65 * ctx.genes.conformity) {
        id = A.humanCall.targetId; followId = A.humanCall.callerId; why = `響應真人【${A.humanCall.callerName}】的集火號召`;
      } else if (last && last.suspectId && last.suspectId !== bot.id && !(A.prof[last.suspectId] && A.prof[last.suspectId].confessed)) {
        id = last.suspectId; why = '貫徹自己發言時鋪的梗';
      } else if (A.topSuspect) {
        id = A.topSuspect.player.id; why = `綜合三輪證據，${U.tag(A.topSuspect.player)}老朝奉機率最高`;
      }
    } else if (bot.role === '老朝奉') { id = A.topXu && A.topXu.player.id; why = '找出最像許願的人（一路說真話、票投得準；同伴藥不然已排除）'; }
    else if (bot.role === '藥不然') { id = A.topFang && A.topFang.player.id; why = '找出最像方震的人（獸首順風附和卻積極帶隊抓人，或非我偷襲卻驗不到；同伴老朝奉已排除）'; }
    else { id = A.topAlly && A.topAlly.player.id; why = '鄭國渠的票無效，順勢投最像好人的人'; }
    id = id || any;
    const top = Object.values(A.prof).sort((a, b) => b.evil - a.evil).slice(0, 3)
      .map(r => ({ id: r.player.id, evil: Math.round(r.evil), probs: { '老朝奉': r.probs['老朝奉'], '藥不然': r.probs['藥不然'], '許願': r.probs['許願'], '方震': r.probs['方震'] }, reasons: r.reasons.slice(0, 3) }));
    return { targetId: id, why: why || '資訊不足，憑直覺指認', followId, top };
  };

  function Engine() { return GD.Engine; }
  GD.Strategy = S;
})(window.GD);