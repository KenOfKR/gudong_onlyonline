/* ============================================================================
 * bot/strategy.js — 電腦玩家的決策（v9.0 Strategy Separation Patch v1）
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U, Rules, Mind } = GD;
  const rnd = () => Math.random();
  const pickDecision = arr => arr[Math.floor(rnd() * arr.length)];
  const S = {};
  const ZODIAC_LIST = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];
  const zIdx = name => {
    const arr = (GD.CONFIG && GD.CONFIG.ZODIAC) || ZODIAC_LIST;
    const idx = arr.indexOf(name);
    return idx >= 0 ? idx : 99;
  };

  /* ---------------------------------------------------------------- 查驗階段 (智慧查驗升級) */

  S.inspectPicks = (bot, room) => {
    const rd = U.curRound(room);
    const quota = Rules.inspectQuota(bot);
    
    const attention = {};
    rd.beasts.forEach(b => { attention[b.name] = 0; });
    
    (rd.speeches || []).forEach(sp => {
      if (sp.p && sp.p.claims) {
        sp.p.claims.forEach(c => {
          if (attention[c.beast] !== undefined) attention[c.beast] += 3;
        });
      }
      if (sp.p && sp.p.callBeast && attention[sp.p.callBeast] !== undefined) {
        attention[sp.p.callBeast] += 2;
      }
    });

    const weighted = [...rd.beasts].sort((a, b) => {
      const scoreA = attention[a.name] + zIdx(a.name) * 0.08 + rnd() * 2;
      const scoreB = attention[b.name] + zIdx(b.name) * 0.08 + rnd() * 2;
      return scoreB - scoreA;
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
        const t = (cand[0] && cand[0].player) || pickDecision(others);
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
          .map(r => {
            const actBonus = leftIds.has(r.player.id) ? 10 : 0;
            return {
              r,
              s: (r.probs['許願'] || 0) + (r.probs['方震'] || 0) * 1.3 + (r.probs['姬雲浮'] || 0) * 0.8 + r.ally * 0.4 + actBonus + rnd() * 12
            };
          })
          .sort((a, b) => b.s - a.s);
        return cand.length ? { kind: 'yao', targetId: cand[0].r.player.id } : { kind: 'skip' };
      }
      case '鄭國渠': {
        const leftToAct = Engine().remainingToAct(room);
        if (leftToAct.length === 0) return { kind: 'skip' };
        const seenReal = ctx.myIns.find(i => i.displayedReal);
        return { kind: 'zheng', beast: seenReal ? seenReal.beastName : pickDecision(rd.beasts).name };
      }
      default: return { kind: 'skip' };
    }
  };

  /* ---------------------------------------------------------------- 傳遞階段 */

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

    /* 藥不然防自爆鐵律：絕不直接把手機傳給本輪剛被自己偷襲的目標 */
    const justAmbushedIds = A.ctx.log.ambushIds || [];
    if (bot.role === '藥不然' && justAmbushedIds.length && left.length > 1) {
      const safeLeft = left.filter(p => !justAmbushedIds.includes(p.id));
      if (safeLeft.length > 0) {
        const bufferPick = [...safeLeft].sort((a, b) => trust(b) - trust(a))[0];
        return choose(bufferPick, `我剛暗中偷襲了目標，絕不能直接把手機交給受害者暴露自己在上一棒，先傳給${U.tag(bufferPick)}墊一棒製造不在場證明`);
      }
    }

    const rd = A.ctx.rd, t = A.ctx.t;

    if (A.ctx.isGood) {
      /* ★ 方震已知壞人：若在後段避免讓他落尾家 */
      if (bot.role === '方震') {
        const knownEvilLeft = left.find(p => {
          return room.rounds.some(r => {
            const l = r.turnLogs[bot.id];
            return l && l.fangTargetId === p.id && l.fangCamp === 'evil';
          });
        });
        if (knownEvilLeft && left.length >= 2) {
          return choose(knownEvilLeft, `我親手查驗出${U.tag(knownEvilLeft)}是壞人，為避免他被放到第八位（尾家）白拿下一回合首家優勢與尾家控制權，現在直接把手機傳給他卡死在第七位前消耗掉`);
        }
      }

      /* ★ 第六位（myPos === 5，場上剛好剩 2 人未行動）的「六控八」精準控場 */
      if (A.ctx.myPos === 5 && left.length === 2) {
        const [pA, pB] = left;
        const rA = recOf(pA), rB = recOf(pB);
        const laoSet = new Set(A.laoIntersectIds || []);

        const scoreEvilFor7th = p => {
          const r = recOf(p);
          if (!r) return 0;
          let sc = r.evil - r.ally * 0.7 + (r.probs['老朝奉'] || 0) * 0.8;
          if (laoSet.has(p.id)) sc += 25;
          return sc;
        };

        const scA = scoreEvilFor7th(pA), scB = scoreEvilFor7th(pB);
        const send7th = scA >= scB ? pA : pB;
        const keep8th = scA >= scB ? pB : pA;

        const bothSuspicious = (rA?.evil || 0) >= 12 && (rB?.evil || 0) >= 12;
        if (bothSuspicious && laoSet.has(send7th.id) && !laoSet.has(keep8th.id)) {
          return choose(send7th, `第六位控尾家（六控八）：剩下的${U.tag(pA)}與${U.tag(pB)}前輪票型都有嫌疑，但結合前輪我的查驗遭反轉推算，前置位一定有老朝奉！${U.tag(send7th)}正好位於前輪老朝奉反轉區間內（老朝奉機率 ${recOf(send7th)?.probs['老朝奉'] || 0}%），我直接把他控去第七位消耗掉，避免他搶走尾家`);
        }
        if ((recOf(send7th)?.evil || 0) > (recOf(keep8th)?.evil || 0) + 5) {
          return choose(send7th, `第六位控尾家（六控八）：為把最放心的好人人選${U.tag(keep8th)}保送進第八位尾家（掌握下輪首家先手權），我把嫌疑較高的${U.tag(send7th)}${basis(send7th)}控在第七位消耗掉`);
        }
        return choose(send7th, `第六位控尾家（六控八）：比較剩下的兩人，${U.tag(keep8th)}比${U.tag(send7th)}更穩健可信，因此我先把手機傳給${U.tag(send7th)}當第七位，把第八位尾家與下輪首家優勢留給${U.tag(keep8th)}`);
      }

      /* 第五位（myPos === 4）：若有明顯高嫌疑犯，提早拉出來消耗避免落尾家 */
      if (t < 2 && A.ctx.myPos === 4 && left.length >= 2) {
        const highSusLeft = [...left].filter(p => (recOf(p)?.evil || 0) >= 28).sort((a, b) => (recOf(b)?.evil || 0) - (recOf(a)?.evil || 0))[0];
        if (highSusLeft) {
          return choose(highSusLeft, `${U.tag(highSusLeft)}嫌疑偏高${basis(highSusLeft)}，為防止他一路滑進第八位尾家搶走下一輪首家先手權，我在第五位直接把手機交給他消耗掉`);
        }
      }

      /* 前中段（第 1～4 位）：挑最放心的好人先查驗拿乾淨資訊 */
      const sorted = [...left].sort((a, b) => trust(b) - trust(a) + (rnd() - 0.5) * 10);
      const pick = sorted[0];
      return choose(pick, `他是剩下的人裡我最放心的好人人選${basis(pick)}，先讓他查驗掌握乾淨資訊`);
    }

    const partner = A.ctx.partner;
    const partnerLeft = partner && left.find(p => p.id === partner.id);

    /* ---- 壞人位置學 ---- */
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

    const pick = pickDecision(left);
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

  function detectSuspectedFangOnBoard(room, excludeId) {
    for (let r = 0; r <= room.currentRoundIdx; r++) {
      const rd = room.rounds[r];
      if (!rd) continue;
      for (const sp of (rd.speeches || [])) {
        if (sp.playerId === excludeId) continue;
        const txt = String(sp.text || '');
        if ((sp.p && (sp.p.campChecks?.length || sp.p.callSuspectId)) || /鐵好人|鐵壞人|陣營|一起指認|看緊/.test(txt)) {
          return sp.playerId;
        }
      }
    }
    return null;
  }

  S.plan = function (bot, room) {
    const A = Mind.analyze(bot, room), { ctx } = A;
    const { genes, rd, myIns, names, t } = ctx;
    const why = [];
    const ranked = [...A.post].sort((a, b) => (b.pReal - a.pReal) || (zIdx(a.name) - zIdx(b.name)));
    const plan = { mode: 'truth', beast: ranked[0].name, avoid: [], claims: [], suspectId: null, softShadeId: null, fakeFangClaim: null, padBeast: null, partnerBeast: null, why };
    const log = ctx.log;
    const hideBlind = ctx.isGood && !!log.blind && shouldHideBlind(bot, genes);

    if (ctx.isGood) {
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

      /* ★ 定案 6：收斂無證據的開局假跳機率，移除原本 0.45 的固定隨機假跳分支 */
      const canFakeFang = (bot.role === '黃煙煙' || bot.role === '木戶加奈' || bot.role === '姬雲浮');
      const suspectedFangId = canFakeFang ? detectSuspectedFangOnBoard(room, bot.id) : null;
      const alreadyFakeJumped = (rd.speeches || []).some(sp => /我驗了|查驗.*是好人|查驗.*是壞人|看不到獸首/.test(sp.text || ''));
      const wantToProtectFang = canFakeFang && !alreadyFakeJumped && (
        (suspectedFangId && rnd() < 0.25 + 0.35 * genes.assertiveness) ||
        (!suspectedFangId && t === 0 && myIns.length === 0 && rnd() < 0.08 + 0.08 * genes.assertiveness)
      );

      if (wantToProtectFang) {
        const pickEvil = A.topSuspect && A.topSuspect.evil >= 30;
        const targetP = pickEvil ? A.topSuspect.player : (A.topAlly ? A.topAlly.player : pickDecision(room.players.filter(p => p.id !== bot.id)));
        if (targetP) {
          plan.fakeFangClaim = { targetId: targetP.id, isGoodCamp: !pickEvil };
          plan.claims = [];
          why.push(suspectedFangId ? `我知道自己不是方震，但看到場上${U.tag(U.byId(room, suspectedFangId))}疑似露出方震跡象，我決定主動穿方震衣服擋刀：刻意不報獸首查驗，改口宣稱我查驗過${U.tag(targetP)}是${pickEvil ? '壞人' : '好人'}，吸引藥不然指認我以保住真方震的 1 分！`
            : `我是【${bot.role}】（知道自己不是方震），為了保護場上的真方震不被藥不然抓出，我開局主動假跳方震擋刀：不報獸首、改報查驗${U.tag(targetP)}是${pickEvil ? '壞人' : '好人'}！`);
        }
      }

      const isConfusedOrBlockedGood = !log.blind && myIns.length === 0 && bot.role !== '方震' && !plan.fakeFangClaim;
      const coverBluff = isConfusedOrBlockedGood && rnd() < 0.65;
      const bluff = ((bot.role === '方震' && !log.blind) || hideBlind || coverBluff) && !plan.fakeFangClaim;

      if (bluff) {
        plan.claims = [{ beast: plan.beast, real: true }];
        plan.bluff = true;
        plan.hideBlind = hideBlind;
        why.push(hideBlind ? `我這輪遭偷襲、什麼都看不到，但不輕易說出被偷襲${bot.role === '許願' || bot.role === '方震' ? `（我是${bot.role}，說出口等於告訴壞人這刀砍中了要害）` : '（說了只會讓壞人確認偷襲有效）'}；改把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出`
          : coverBluff ? `我這輪查驗顯示無法辨別真偽，但為了不暴露弱點並替方震分擔保護色，我順著後驗最穩的【${plan.beast}】報真品護航`
          : `我是方震，看不到獸首。為了不被藥不然靠「驗不到」認出，我把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出`);
      } else if (log.blind && !plan.fakeFangClaim) {
        why.push('我這輪遭偷襲，決定公開說出來，好讓大家知道偷襲者排在我前面的行動者之中');
      }

      if (!bluff && !plan.fakeFangClaim) {
        why.push(myIns.length ? `我親眼看到 ${myIns.map(i => `【${i.beastName}】${i.displayedReal ? '真' : '假'}`).join('、')}，結合前手宣稱，後驗最像真品的是【${plan.beast}】(${Math.round(A.post.find(b => b.name === plan.beast).pReal * 100)}%)`
          : `這輪我${log.blind ? '遭偷襲' : '無法辨別真偽'}，只能依前手宣稱的可信度，後驗最像真品的是【${plan.beast}】`);
      }

      if (A.reEvalNote) {
        why.push(A.reEvalNote);
      }
    } else {
      /* ★ 定案 1 & 2：pLie 僅由 deception 控制；雙重宣稱以 camouflage = 0.5 為基準中心進行調節 */
      const knownReal = myIns.filter(i => i.displayedReal).map(i => i.beastName);
      const knownFake = myIns.filter(i => !i.displayedReal).map(i => i.beastName);
      const partnerMind = ctx.partner && rd.mind[ctx.partner.id];

      const pLie = U.clamp(
        0.125 + 0.6 * genes.deception + (t === 2 ? 0.2 : 0),
        0.12,
        0.95
      );

      if (partnerMind && partnerMind.mode === 'lie' && !knownReal.includes(partnerMind.beast) && rnd() < 0.75) {
        plan.mode = 'follow';
        plan.beast = partnerMind.beast;
        plan.partnerBeast = partnerMind.beast;
        plan.claims = [{ beast: plan.beast, real: true }];
        why.push(`同伴已帶風向推【${plan.beast}】，我順著他附和以加固假線`);
      } else if (rnd() < pLie) {
        const fakeCands = [...A.post].filter(b => !knownReal.includes(b.name)).sort((a, b) => (a.pReal - b.pReal) || (zIdx(a.name) - zIdx(b.name)));
        const lie = knownFake[0] || (fakeCands[0] && fakeCands[0].name) || ranked[ranked.length - 1].name;
        plan.mode = 'lie';
        plan.beast = lie;
        plan.claims = [{ beast: lie, real: true }];

        const pDoubleClaimBase = 0.2 + 0.6 * genes.deception;
        const pDoubleClaim = U.clamp(
          pDoubleClaimBase * (1.5 - genes.camouflage),
          0,
          1
        );
        if (knownReal.length && rnd() < pDoubleClaim) {
          plan.claims.push({ beast: knownReal[0], real: false });
          plan.avoid = [knownReal[0]];
        }
        why.push(`我是【${bot.role}】，這輪帶風向：${knownFake.length ? `我看到【${lie}】是假的，卻宣稱它是真品` : `把票推向後驗最不像真品的【${lie}】`}`);
      } else {
        plan.mode = 'camouflage';
        plan.beast = knownReal[0] || ranked[0].name;
        plan.padBeast = knownFake[0] || null;
        plan.claims = [{ beast: plan.beast, real: true }];
        why.push(`我是【${bot.role}】，這輪選擇講真話偽裝成好人，票型再視偽裝策略配置`);
      }
    }

    /* ---- 票型採人：用公開的票型質問 ---- */
    const alreadyAsked = (rd.speeches || []).some(sp => sp.p && (sp.p.asked || []).length);
    if (ctx.isGood && t >= 1 && !alreadyAsked && A.fakeVoters.length && rnd() < 0.3 + 0.6 * genes.assertiveness) {
      const q = A.fakeVoters[0], hist = Mind.pubFakeVotes(room, q.player.id, t), last = hist[hist.length - 1];
      plan.askId = q.player.id; plan.askVotes = q.pubFake; plan.askBeast = last.beast; plan.askRound = last.round;
      why.push(`${U.tag(q.player)}累計 ${q.pubFake} 票投在已公開的贗品上（最近一次第 ${last.round} 輪的【${last.beast}】），票型全場看得到，先請他說明。他解釋得通就放過，解釋不通或閃躲就升高嫌疑`);
    }

    /* ★ 定案 4：被點名要說明為什麼把票投在贗品上（保留抗壓，加入第三輪 cantExplain 退讓例外） */
    if (A.askedMe && A.myFake.length) {
      plan.explain = { callerName: A.askedMe.callerName, votes: A.myFake };
      const canConfess = !ctx.isGood && (bot.role === '藥不然' || bot.role === '鄭國渠');
      const cantExplain = A.myFake.some(f => { const m = room.rounds[f.round - 1].mind[bot.id]; return m && m.mode === 'lie'; });
      let pConfess = canConfess
        ? U.clamp((cantExplain ? 0.35 : 0.08) + 0.4 * (1 - genes.camouflage), 0.05, 0.8)
        : 0;
      if (canConfess && cantExplain && t === 2) {
        pConfess = Math.max(pConfess, 0.45);
      }
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

    /* 方震踩人節奏 */
    if (bot.role === '方震') {
      const evilCheckedIds = [];
      room.rounds.forEach(r => {
        const l = r.turnLogs[bot.id];
        if (l && l.fangTargetId && l.fangCamp === 'evil') evilCheckedIds.push(l.fangTargetId);
      });
      if (evilCheckedIds.length > 0) {
        const tgtId = evilCheckedIds[evilCheckedIds.length - 1];
        const tgt = U.byId(room, tgtId);
        const othersAlreadyCalled = (rd.speeches || []).some(sp => sp.playerId !== bot.id && sp.p && sp.p.callSuspectId === tgtId);
        if (t < 2 && !othersAlreadyCalled) {
          plan.softShadeId = tgt.id;
          why.push(`我私下查驗出${U.tag(tgt)}是壞人，但現在才第 ${t + 1} 輪，若直接明踩喊指認會立刻暴露方震身分被藥不然抓而失分；因此我只用輕微話術暗踩提醒大家別盲從他的風向`);
        } else if (rnd() < 0.45 + 0.5 * genes.assertiveness) {
          plan.suspectId = tgt.id;
          why.push(`已進入決戰階段（或場上已有人先踩${U.tag(tgt)}），我順著公開的票型與時序理由帶大家在鑑人時集火${U.tag(tgt)}`);
        }
      }
    }

    /* ---- 鑑人佈局（定案 5：封住第三輪無條件放行漏洞，改為動態嫌疑門檻＋領先幅度雙重判定） ---- */
    const myConflicts = conflictsOf(A);
    const adjConflict = ctx.isGood ? myConflicts.find(c => c.isAdjacent && c.speakerPos < c.myPos) : null;
    if (adjConflict && bot.role !== '方震') {
      plan.suspectId = adjConflict.speakerId;
      why.push(`${U.tag(U.byId(room, adjConflict.speakerId))}在${U.nth(adjConflict.speakerPos)}緊鄰傳給我${U.nth(adjConflict.myPos)}，中間無人卻報出相反結果，必為說謊或本人開擾亂，直接點名盯緊他`);
    }

    if (!plan.suspectId && !plan.softShadeId) {
      const hc = A.humanCall;
      const sortedSuspects = Object.values(A.prof).sort((a, b) => b.evil - a.evil);
      const topEvil = sortedSuspects[0] ? sortedSuspects[0].evil : 0;
      const secondEvil = sortedSuspects[1] ? sortedSuspects[1].evil : 0;
      const leadMargin = topEvil - secondEvil;
      const hasDirectConflict = A.topSuspect && Array.isArray(A.topSuspect.conflicts) && A.topSuspect.conflicts.length > 0;

      const suspectThreshold = 55 + 25 * genes.skepticism;
      const minLead = 8 + 15 * genes.skepticism;
      const round3Threshold = 40 + 25 * genes.skepticism;
      const round3MinLead = 6 + 12 * genes.skepticism;

      const canAccuseNow = t < 2
        ? (topEvil >= suspectThreshold && (leadMargin >= minLead || hasDirectConflict))
        : (topEvil >= round3Threshold && (leadMargin >= round3MinLead || hasDirectConflict));

      if (ctx.isGood && hc && (A.prof[hc.targetId]?.ally || 0) < 85 && rnd() < 0.3 + 0.65 * genes.conformity) {
        plan.suspectId = hc.targetId; plan.followHuman = hc;
        why.push(`真人【${hc.callerName}】號召集火，其發言可信度夠，我附議`);
      } else if (ctx.isGood && bot.role !== '方震' && A.topSuspect && canAccuseNow && rnd() < 0.35 + 0.6 * genes.assertiveness) {
        plan.suspectId = A.topSuspect.player.id;
        why.push(`${U.tag(A.topSuspect.player)}嫌疑最高且明顯領先（${A.topSuspect.reasons[0] || '票型與發言矛盾'}），先為鑑人鋪梗`);
      } else if (!ctx.isGood && t === 2 && rnd() < 0.3 + 0.5 * genes.deception) {
        const scapegoat = Object.values(A.prof).filter(r => (!ctx.partner || r.player.id !== ctx.partner.id) && !r.knownEvil).sort((a, b) => (b.ally - b.evil) - (a.ally - a.evil))[0];
        if (scapegoat) {
          plan.suspectId = scapegoat.player.id;
          why.push(`嫁禍給最像好人的${U.tag(scapegoat.player)}，轉移對我方的注意`);
        }
      }
    }

    /* ---- 寫入覆盤用紀錄 ---- */
    const top = Object.values(A.prof).sort((a, b) => b.evil - a.evil).slice(0, 2);
    rd.mind[bot.id] = {
      pos: ctx.myPos, mode: plan.mode, beast: plan.beast, avoid: plan.avoid, claims: plan.claims,
      suspectId: plan.suspectId, softShadeId: plan.softShadeId, fakeFangClaim: plan.fakeFangClaim,
      padBeast: plan.padBeast, why, hideBlind: !!plan.hideBlind,
      askId: plan.askId || null, confess: !!plan.confess, explained: !!plan.explain,
      followHuman: plan.followHuman ? plan.followHuman.callerId : null,
      insText: (log.inspect || []).map(i => i.resultText),
      blind: !!log.blind,
      post: A.post.map(b => ({ name: b.name, p: U.round3(b.pReal) })),
      laoAt: A.laoAt.map(U.round3),
      conflicts: myConflicts.map(c => ({ ...c })),
      laoPools: A.laoPools || [],
      laoIntersectIds: A.laoIntersectIds || [],
      eliminatedFromLaoIds: A.eliminatedFromLaoIds || [],
      reEvalNote: A.reEvalNote || null,
      suspects: top.map(r => ({ id: r.player.id, evil: Math.round(r.evil), reasons: r.reasons.slice(0, 3) })),
      ts: Date.now()
    };
    return { plan, A };
  };

  /* ---------------------------------------------------------------- 投票（定案 3：由 camouflage 控制分票執行與言行一致破綻） */

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
      // A. 偽裝講真話模式：如何在「維持口頭真品宣稱一致」與「偷墊假貨」之間取捨
      if (m.mode === 'camouflage' && m.padBeast && spend >= 2 && m.padBeast !== m.beast) {
        if (rnd() < 0.25 + 0.65 * genes.camouflage) {
          // 具備偽裝執行力：留 1 票護航口頭宣稱的真品（避免 0 票矛盾），其餘墊給假貨
          ballot[m.beast] = 1;
          ballot[m.padBeast] = spend - 1;
          return ballot;
        } else if (rnd() < 0.55 * (1 - genes.camouflage)) {
          // 低偽裝力露出明顯破綻：嘴上報真品 m.beast，卻把全部籌碼灌給假貨 m.padBeast（產生 0 票言行矛盾）
          ballot[m.padBeast] = spend;
          return ballot;
        }
      }

      // B. 說謊／跟風模式：當自己喊的假貨在場上孤立無援時，如何處理選票
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
          if (rnd() < 0.25 + 0.65 * genes.camouflage) {
            // 高偽裝力：留 1 票支持自己口頭喊的獸首，其餘合流別隻假貨
            ballot[m.beast] = 1;
            ballot[rallyFake.name] = spend - 1;
            return ballot;
          } else if (rnd() < 0.60 * (1 - genes.camouflage)) {
            // 低偽裝力：直接棄守自己口頭宣稱的獸首（0 票矛盾），全票轉投別隻
            ballot[rallyFake.name] = spend;
            return ballot;
          }
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
    const any = pickDecision(anyPool.length ? anyPool : room.players.filter(p => p.id !== bot.id)).id;
    let id = null, why = '', followId = null;
    if (ctx.isGood) {
      if (bot.role === '方震') {
        const evilChecked = [];
        room.rounds.forEach(r => {
          const l = r.turnLogs[bot.id];
          if (l && l.fangTargetId && l.fangCamp === 'evil' && !(A.prof[l.fangTargetId] && A.prof[l.fangTargetId].confessed)) {
            evilChecked.push(l.fangTargetId);
          }
        });
        if (evilChecked.length > 0) {
          evilChecked.sort((a, b) => ((A.prof[b]?.probs['老朝奉'] || 0) + (A.prof[b]?.evil || 0)) - ((A.prof[a]?.probs['老朝奉'] || 0) + (A.prof[a]?.evil || 0)));
          id = evilChecked[0];
          why = `我以【方震】親手查驗確認${U.tag(U.byId(room, id))}是老朝奉陣營，且其老朝奉嫌疑最高`;
        }
      }

      if (!id) {
        if (A.humanCall && (A.prof[A.humanCall.targetId]?.ally || 0) < 85 && rnd() < 0.3 + 0.65 * ctx.genes.conformity) {
          id = A.humanCall.targetId; followId = A.humanCall.callerId; why = `響應真人【${A.humanCall.callerName}】的集火號召`;
        } else if (last && last.suspectId && last.suspectId !== bot.id && !(A.prof[last.suspectId] && A.prof[last.suspectId].confessed)) {
          id = last.suspectId; why = '貫徹自己發言時鋪的梗';
        } else if (A.topSuspect) {
          id = A.topSuspect.player.id; why = `綜合三輪證據，${U.tag(A.topSuspect.player)}老朝奉機率最高`;
        }
      }
    } else if (bot.role === '老朝奉') {
      id = A.topXu && A.topXu.player.id; why = '找出最像許願的人（一路說真話、票投得準；同伴藥不然已排除）';
    } else if (bot.role === '藥不然') {
      id = A.topFang && A.topFang.player.id; why = '找出最像方震的人（報陣營查驗、順風附和卻帶隊抓人，或非我偷襲卻驗不到；同伴老朝奉已排除）';
    } else {
      id = A.topAlly && A.topAlly.player.id; why = '鄭國渠的票無效，順勢投最像好人的人';
    }

    id = id || any;
    const top = Object.values(A.prof).sort((a, b) => b.evil - a.evil).slice(0, 3).map(r => ({ id: r.player.id, evil: Math.round(r.evil), probs: { '老朝奉': r.probs['老朝奉'], '藥不然': r.probs['藥不然'], '許願': r.probs['許願'], '方震': r.probs['方震'] }, reasons: r.reasons.slice(0, 3) }));
    return { targetId: id, why: why || '資訊不足，憑直覺指認', followId, top };
  };

  function Engine() { return GD.Engine; }
  GD.Strategy = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Strategy;
})(typeof window !== 'undefined' ? window : global);