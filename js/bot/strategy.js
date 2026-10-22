/* ============================================================================
 * bot/strategy.js — 電腦玩家的決策（技能、傳遞、發言計畫、投票、鑑人・大師實戰版）
 *
 * 核心戰術升級：
 *   1) 防壞人卡尾家：第 1、2 輪若方震親手驗出壞人（或好人面對高嫌犯），在第 4~6 棒直接把手機塞給他，
 *      絕不讓壞人落到第 8 位（尾家＝下輪首家）！
 *   2) 方震暗踩不送分：方震在 R1/R2 驗到壞人時不直接喊「鑑人指認他」(suspectId)，改用 softShadeId 暗中帶風向提防。
 *   3) 好人穿方震衣服擋刀 (fakeFangClaim)：平民（黃煙煙/木戶加奈）在開局或見有人疑似跳方震時，
 *      主動不報獸首、改報「查驗某人為好人/壞人」替真方震擋刀！
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
        return { kind: 'zheng', beast: seenReal ? seenReal.beastName : U.pick(rd.beasts).name };
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
      return r && r.reasons[0] ? `（${r.reasons[0]}）` : '（目前沒有任何可疑紀錄）'; };  if (left.length === 1) return choose(left[0], '只剩他還沒行動，沒有其他選擇');  /* 藥不然防自爆鐵律：絕不直接把手機傳給本輪剛被自己偷襲的目標 */ const justAmbushedIds = A.ctx.log.ambushIds || []; if (bot.role === '藥不然' && justAmbushedIds.length && left.length > 1) { const safeLeft = left.filter(p => !justAmbushedIds.includes(p.id)); if (safeLeft.length > 0) { const bufferPick = [...safeLeft].sort((a, b) => trust(b) - trust(a))[0]; return choose(bufferPick, `我剛暗中偷襲了目標，絕不能直接把手機交給受害者暴露自己在上一棒，先傳給${U.tag(bufferPick)}墊一棒製造不在場證明`);
      }
    }

    const rd = A.ctx.rd, t = A.ctx.t;

    if (A.ctx.isGood) {
      /* ★ [關鍵修正 1] 好人防壞人搶第 8 家（尾家＝下輪首家）！
         在第 1、2 回合 (t < 2)，尾家擁有下一回合第 1 家起手的巨大優勢；且即便是第 3 回合，把壞人留到尾家也容易讓壞人控盤。
         若我是方震且親手查出某個未行動者是壞人（或我在第 4~6 棒且場上有高嫌疑犯尚未行動），
         為避免該壞人被拖到第 8 家當尾家，必須直接把手機傳給他，把尾家留給好人！ */
      if (bot.role === '方震') {
        const knownEvilLeft = left.find(p => {
          return room.rounds.some(r => {
            const l = r.turnLogs[bot.id];
            return l && l.fangTargetId === p.id && l.fangCamp === 'evil';
          });
        });
        // 只要剩餘未行動人數 >= 2（傳給他之後，他只能當第 2~7 家，絕不會成為第 8 家尾家），直接把手機塞給這個壞人！
        if (knownEvilLeft && left.length >= 2) {
          return choose(knownEvilLeft, `我親手查驗出${U.tag(knownEvilLeft)}是壞人，為避免他被放到第八位（尾家）白拿下一回合首家優勢與尾家控制權，現在直接把手機傳給他卡死位置`); } }  /* 一般好人在第 1、2 輪的第 5、6 位（myPos === 4 或 5，剩 3 或 2 人）： 如果剩餘名單裡有高度可疑的嫌犯（evil >= 35），直接傳給嫌犯逼他現在行動，把最後第 8 位尾家（下輪首家）留給好人！ */ if (t < 2 && (A.ctx.myPos === 4 \vert{}\vert{} A.ctx.myPos === 5) && left.length >= 2) { const highSusLeft = [...left].filter(p => (recOf(p)?.evil \vert{}\vert{} 0) >= 35).sort((a, b) => (recOf(b)?.evil \vert{}\vert{} 0) - (recOf(a)?.evil \vert{}\vert{} 0))[0]; if (highSusLeft) { return choose(highSusLeft, `${U.tag(highSusLeft)}嫌疑偏高${basis(highSusLeft)}，為防止他落到第八位尾家搶走下一輪首家先手權，我在中段直接把手機交給他消耗掉`); } }  /* 前段（第 1~3 位）：優先把手機傳給最放心的好人同伴，讓好人先看乾淨的獸首 */ const sorted = [...left].sort((a, b) => trust(b) - trust(a) + (rnd() - 0.5) * 10); const pick = sorted[0]; return choose(pick, `他是剩下的人裡我最放心的好人人選${basis(pick)}，先讓他查驗掌握乾淨資訊`);
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
        return choose(partner, `第 ${t + 1} 回合本想讓同伴當尾家，但第六位控出第八位同隊太明顯，這次放棄首家優勢保住身分`); } if (t === 2) { const bait = [...left].filter(p => !partner \vert{}\vert{} p.id !== partner.id).sort((a, b) => trust(b) - trust(a))[0]; const tailP = left.find(p => p.id !== (bait && bait.id)); if (bait && tailP) { return choose(bait, `第 3 回合尾家沒有首家優勢，我讓看起來最像好人的${U.tag(tailP)}壓軸：外界會以為「第六位控出第八位」是同隊，好人間會互疑`);
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
      return choose(goodish, `把同伴${U.tag(partner)}留到後段，爭取讓他當第 ${t + 1} 回合尾家、下一輪拿首家優勢；先送給看起來最像好人的對象${basis(goodish)}`); } if (bot.role === '藥不然' && partnerLeft && !rd.laoActive && t === 2) { return choose(partner, `他是我的秘密同伴，先送過去讓老朝奉掌握查驗順序，再決定要不要發動擾亂`); } if (rd.laoActive \vert{}\vert{} bot.role === '老朝奉') { const goodish = [...left].sort((a, b) => trust(b) - trust(a)); return choose(goodish[0], `${rd.laoActive ? '擾亂已啟動' : '我可能啟動擾亂'}，把查驗機會送給看起來最像好人的他，讓他看到被反轉的結果並拿去帶偏好人${basis(goodish[0])}`); } const pick = U.pick(left); return choose(pick, `沒有特別需要安排的對象，隨機挑他，避免傳遞習慣被看出規律`); };  /* ---------------------------------------------------------------- 發言計畫 */  function conflictsOf(A) { const t = A.ctx.t + 1; return Object.values(A.prof).flatMap(r => r.conflicts.filter(c => c.round === t)); }  function shouldHideBlind(bot, genes) { if (bot.role === '許願' \vert{}\vert{} bot.role === '方震') return true; return rnd() >= U.clamp(0.1 + 0.3 * genes.assertiveness, 0.1, 0.4); }  /** 偵測本輪或前輪是否已經有其他好人疑似跳出方震特徵（積極點名集火、質問或報陣營） */ function detectSuspectedFangOnBoard(room, excludeId) { for (let r = 0; r <= room.currentRoundIdx; r++) { const rd = room.rounds[r]; if (!rd) continue; for (const sp of (rd.speeches \vert{}\vert{} [])) { if (sp.playerId === excludeId) continue; const txt = String(sp.text \vert{}\vert{} ''); if ((sp.p && (sp.p.campChecks?.length \vert{}\vert{} sp.p.callSuspectId)) \vert{}\vert{} /鐵好人\vert{}鐵壞人\vert{}陣營\vert{}一起指認\vert{}看緊/.test(txt)) { return sp.playerId; } } } return null; }  S.plan = function (bot, room) { const A = Mind.analyze(bot, room), { ctx } = A; const { genes, rd, myIns, names, t } = ctx; const why = []; const ranked = [...A.post].sort((a, b) => (b.pReal - a.pReal) \vert{}\vert{} (zIdx(a.name) - zIdx(b.name))); const plan = { mode: 'truth', beast: ranked[0].name, avoid: [], claims: [], suspectId: null, softShadeId: null, fakeFangClaim: null, padBeast: null, partnerBeast: null, why }; const log = ctx.log; const hideBlind = ctx.isGood && !!log.blind && shouldHideBlind(bot, genes);  if (ctx.isGood) { let say = myIns.slice(); if (bot.role === '許願' && say.length >= 2) { const reals = say.filter(i => i.displayedReal).sort((a, b) => zIdx(a.beastName) - zIdx(b.beastName)); const keep = reals[0] \vert{}\vert{} say[0]; say = [keep]; why.push('身為許願，雙查驗只報 1 尊以藏住身分'); } plan.claims = say.map(i => ({ beast: i.beastName, real: i.displayedReal })); plan.avoid = myIns.filter(i => !i.displayedReal).map(i => i.beastName); const cand = ranked.filter(b => !plan.avoid.includes(b.name)); plan.beast = (cand[0] \vert{}\vert{} ranked[0]).name;  /* 方震驗出「好人」時的戰術合流 */ if (bot.role === '方震') { const verifiedGoodIds = new Set(); room.rounds.forEach(r => { const l = r.turnLogs[bot.id]; if (l && l.fangTargetId && l.fangCamp === 'good') verifiedGoodIds.add(l.fangTargetId); }); const trustedSp = (rd.speeches \vert{}\vert{} []).find(sp => verifiedGoodIds.has(sp.playerId) && (sp.p?.claims \vert{}\vert{} []).some(c => c.real)); if (trustedSp) { const goodClaim = trustedSp.p.claims.find(c => c.real && !plan.avoid.includes(c.beast)); if (goodClaim) { plan.beast = goodClaim.beast; why.push(`我私下用【方震】確認過${U.tag(U.byId(room, trustedSp.playerId))}是鐵好人，直接跟隨他報的【${plan.beast}】真品線衝票`); } } }  /* ★ [關鍵修正 3] 好人（黃煙煙／木戶加奈／姬雲浮）主動穿方震衣服擋刀 (Bodyguard Fake-Fang Claim)！ 條件：我知道自己不是方震（也不是許願），如果： (A) 場上已經有人疑似跳方震（或暴露方震跡象），我去幫他分擔藥不然的狙擊目光； (B) 或者第 1 輪開局我排在中後段（或剛好遇到困惑驗不到獸首），我有想保方震的心， 直接「不報獸首真偽，改口報我驗了某人是好人／壞人」假跳方震擋刀！ */ const canFakeFang = (bot.role === '黃煙煙' \vert{}\vert{} bot.role === '木戶加奈' \vert{}\vert{} bot.role === '姬雲浮'); const suspectedFangId = canFakeFang ? detectSuspectedFangOnBoard(room, bot.id) : null; const alreadyFakeJumped = (rd.speeches \vert{}\vert{} []).some(sp => /我驗了\vert{}查驗.*是好人\vert{}查驗.*是壞人\vert{}看不到獸首/.test(sp.text \vert{}\vert{} '')); const wantToProtectFang = canFakeFang && !alreadyFakeJumped && ( (suspectedFangId && rnd() < 0.28 + 0.35 * genes.assertiveness) \vert{}\vert{} (t === 0 && myIns.length === 0 && rnd() < 0.45) \vert{}\vert{} (t === 0 && bot.role !== '姬雲浮' && rnd() < 0.16 * genes.assertiveness) );  if (wantToProtectFang) { // 挑一個最可信的好人報「我驗他是好人」，或挑嫌疑最高的人報「我驗他是壞人」 const pickEvil = A.topSuspect && A.topSuspect.evil >= 30; const targetP = pickEvil ? A.topSuspect.player : (A.topAlly ? A.topAlly.player : U.pick(room.players.filter(p => p.id !== bot.id))); if (targetP) { plan.fakeFangClaim = { targetId: targetP.id, isGoodCamp: !pickEvil }; plan.claims = []; // 刻意不報自己的獸首查驗，只喊跟投後驗最穩的獸首，演得跟真方震一模一樣！ why.push(suspectedFangId ? `我知道自己不是方震，但看到場上${U.tag(U.byId(room, suspectedFangId))}疑似露出方震跡象，我決定主動穿方震衣服擋刀：刻意不報獸首查驗，改口宣稱我查驗過${U.tag(targetP)}是${pickEvil ? '壞人' : '好人'}，吸引藥不然指認我以保住真方震的 1 分！`
            : `我是【${bot.role}】（知道自己不是方震），為了保護場上的真方震不被藥不然抓出，我開局主動假跳方震擋刀：不報獸首、改報查驗${U.tag(targetP)}是${pickEvil ? '壞人' : '好人'}！`); } }  const isConfusedOrBlockedGood = !log.blind && myIns.length === 0 && bot.role !== '方震' && !plan.fakeFangClaim; const coverBluff = isConfusedOrBlockedGood && rnd() < 0.65; const bluff = ((bot.role === '方震' && !log.blind) \vert{}\vert{} hideBlind \vert{}\vert{} coverBluff) && !plan.fakeFangClaim;  if (bluff) { plan.claims = [{ beast: plan.beast, real: true }]; plan.bluff = true; plan.hideBlind = hideBlind; why.push(hideBlind ? `我這輪遭偷襲、什麼都看不到，但不輕易說出被偷襲${bot.role === '許願' || bot.role === '方震' ? `（我是${bot.role}，說出口等於告訴壞人這刀砍中了要害）` : '（說了只會讓壞人確認偷襲有效）'}；改把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出` : coverBluff ? `我這輪查驗顯示無法辨別真偽，但為了不暴露弱點並替方震分擔保護色，我順著後驗最穩的【${plan.beast}】報真品護航`
          : `我是方震，看不到獸首。為了不被藥不然靠「驗不到」認出，我把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出`); } else if (log.blind && !plan.fakeFangClaim) { why.push('我這輪遭偷襲，決定公開說出來，好讓大家知道偷襲者排在我前面的行動者之中'); } if (!bluff && !plan.fakeFangClaim) why.push(myIns.length ? `我親眼看到 ${myIns.map(i => `【${i.beastName}】${i.displayedReal ? '真' : '假'}`).join('、')}，結合前手宣稱，後驗最像真品的是【${plan.beast}】(${Math.round(A.post.find(b => b.name === plan.beast).pReal * 100)}%)`
        : `這輪我${log.blind ? '遭偷襲' : '無法辨別真偽'}，只能依前手宣稱的可信度，後驗最像真品的是【${plan.beast}】`);
    } else {
      const knownReal = myIns.filter(i => i.displayedReal).map(i => i.beastName);
      const knownFake = myIns.filter(i => !i.displayedReal).map(i => i.beastName);
      const partnerMind = ctx.partner && rd.mind[ctx.partner.id];
      const pLie = U.clamp(0.25 + 0.6 * genes.deception - 0.25 * genes.camouflage + (t === 2 ? 0.2 : 0), 0.12, 0.95);

      if (partnerMind && partnerMind.mode === 'lie' && !knownReal.includes(partnerMind.beast) && rnd() < 0.75) {
        plan.mode = 'follow'; plan.beast = partnerMind.beast; plan.partnerBeast = partnerMind.beast;
        plan.claims = [{ beast: plan.beast, real: true }];
        why.push(`同伴已帶風向推【${plan.beast}】，我順著他附和以加固假線`); } else if (rnd() < pLie) { const fakeCands = [...A.post] .filter(b => !knownReal.includes(b.name)) .sort((a, b) => (a.pReal - b.pReal) \vert{}\vert{} (zIdx(a.name) - zIdx(b.name))); const lie = knownFake[0] \vert{}\vert{} (fakeCands[0] && fakeCands[0].name) \vert{}\vert{} ranked[ranked.length - 1].name; plan.mode = 'lie'; plan.beast = lie; plan.claims = [{ beast: lie, real: true }]; if (knownReal.length && rnd() < 0.2 + 0.6 * genes.deception) { plan.claims.push({ beast: knownReal[0], real: false }); plan.avoid = [knownReal[0]]; } why.push(`我是【${bot.role}】，這輪帶風向：${knownFake.length ? `我看到【${lie}】是假的，卻宣稱它是真品` : `把票推向後驗最不像真品的【${lie}】`}`); } else { plan.mode = 'camouflage'; plan.beast = knownReal[0] \vert{}\vert{} ranked[0].name; plan.padBeast = knownFake[0] \vert{}\vert{} null; plan.claims = [{ beast: plan.beast, real: true }]; why.push(`我是【${bot.role}】，這輪選擇講真話偽裝成好人，票型再分 1 票給假貨`);
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

    /* ★ [關鍵修正 2] 方震踩人節奏：第 1、2 輪絕不明踩「鑑人一起指認他」，改用暗踩 (softShadeId)！
       因為第 1 輪根本還沒開票，方震如果直接喊「鑑人時看緊某某、一起指認他」，藥不然一眼就看出你是方震（直接失分）！
       所以：
       - 在第 1、2 輪 (t < 2)：只設定 `plan.softShadeId = tgt.id`（在話語中輕描淡寫質疑他的傳遞順位或獸首風向，絕不喊指認）。
       - 到了第 3 輪 (t === 2)，或已經有其他好人公開號召集火他時，才正式設定 `plan.suspectId` 號召全場指認！ */
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

    /* ---- 鑑人佈局：附議可信真人的集火 / 第三輪點名最可疑者 / 壞人嫁禍 ---- */
    if (!plan.suspectId && !plan.softShadeId) {
      const hc = A.humanCall;
      if (ctx.isGood && hc && (A.prof[hc.targetId]?.ally || 0) < 85 && rnd() < 0.3 + 0.65 * genes.conformity) {
        plan.suspectId = hc.targetId; plan.followHuman = hc;
        why.push(`真人【${hc.callerName}】號召集火，其發言可信度夠，我附議`); } else if (ctx.isGood && bot.role !== '方震' && A.topSuspect && (t === 2 \vert{}\vert{} A.topSuspect.evil >= 65) && rnd() < 0.35 + 0.6 * genes.assertiveness) { plan.suspectId = A.topSuspect.player.id; why.push(`${U.tag(A.topSuspect.player)}嫌疑最高（${A.topSuspect.reasons[0] \vert{}\vert{} '票型與發言矛盾'}），先為鑑人鋪梗`); } else if (!ctx.isGood && t === 2 && rnd() < 0.3 + 0.5 * genes.deception) { const scapegoat = Object.values(A.prof).filter(r => (!ctx.partner \vert{}\vert{} r.player.id !== ctx.partner.id) && !r.knownEvil) .sort((a, b) => (b.ally - b.evil) - (a.ally - a.evil))[0]; if (scapegoat) { plan.suspectId = scapegoat.player.id; why.push(`嫁禍給最像好人的${U.tag(scapegoat.player)}，轉移對我方的注意`); }
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
      conflicts: conflictsOf(A).map(c => ({ ...c })),
      suspects: top.map(r => ({ id: r.player.id, evil: Math.round(r.evil), reasons: r.reasons.slice(0, 3) })),
      ts: Date.now()
    };
    return { plan, A };
  };

  /* ---------------------------------------------------------------- 投票 */

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
        ballot[m.beast] = 1;
        ballot[m.padBeast] = spend - 1;
        return ballot;
      }
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
          ballot[m.beast] = 1;
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
      // 若我是方震，終局鑑人時優先從我親手驗過的壞人名單裡挑選最像老朝奉的人！
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
          why = `我以【方震】親手查驗確認${U.tag(U.byId(room, id))}是老朝奉陣營，且其老朝奉嫌疑最高`; } } if (!id) { if (A.humanCall && (A.prof[A.humanCall.targetId]?.ally \vert{}\vert{} 0) < 85 && rnd() < 0.3 + 0.65 * ctx.genes.conformity) { id = A.humanCall.targetId; followId = A.humanCall.callerId; why = `響應真人【${A.humanCall.callerName}】的集火號召`;
        } else if (last && last.suspectId && last.suspectId !== bot.id && !(A.prof[last.suspectId] && A.prof[last.suspectId].confessed)) {
          id = last.suspectId; why = '貫徹自己發言時鋪的梗';
        } else if (A.topSuspect) {
          id = A.topSuspect.player.id; why = `綜合三輪證據，${U.tag(A.topSuspect.player)}老朝奉機率最高`; } } } else if (bot.role === '老朝奉') { id = A.topXu && A.topXu.player.id; why = '找出最像許願的人（一路說真話、票投得準；同伴藥不然已排除）'; } else if (bot.role === '藥不然') { id = A.topFang && A.topFang.player.id; why = '找出最像方震的人（報陣營查驗、順風附和卻帶隊抓人，或非我偷襲卻驗不到；同伴老朝奉已排除）'; } else { id = A.topAlly && A.topAlly.player.id; why = '鄭國渠的票無效，順勢投最像好人的人'; } id = id \vert{}\vert{} any; const top = Object.values(A.prof).sort((a, b) => b.evil - a.evil).slice(0, 3) .map(r => ({ id: r.player.id, evil: Math.round(r.evil), probs: { '老朝奉': r.probs['老朝奉'], '藥不然': r.probs['藥不然'], '許願': r.probs['許願'], '方震': r.probs['方震'] }, reasons: r.reasons.slice(0, 3) })); return { targetId: id, why: why \vert{}\vert{} '資訊不足，憑直覺指認', followId, top }; };  function Engine() { return GD.Engine; } GD.Strategy = S; })(window.GD); ```  ---  #### 2️⃣ `bot/speech.js`（完整覆蓋版）  ```javascript /* ============================================================================ * bot/speech.js — 發言生成（支援方震暗踩 softShadeId 與好人假跳方震擋刀 fakeFangClaim） * ========================================================================== */ (function (GD) { 'use strict'; const { U, Claims } = GD; const B = n => `【${n}】`;
  const real = v => (v ? '真' : '假');

  /* ------------------------------------------------------------------ 資料整理 */

  function history(room) {
    const t = room.currentRoundIdx;
    const lines = [];
    for (let r = 0; r < t; r++) {
      const rd = room.rounds[r], vr = rd.voteResults;
      if (!vr) continue;
      const votes = rd.beasts.map(b => `${B(b.name)}${vr.totals[b.name]}票`).join('、');
      lines.push(`第${r + 1}輪：${votes}；公開第二名 ${B(vr.rank2.name)} 為${vr.rank2.isReal ? '真品' : '贗品'}；封存第一名 ${B(vr.rank1.name)}（真偽未公開）`); } return lines.length ? lines.join('\n') : '（第一輪，尚無歷史開票）'; }  function priorSpeeches(room) { const rd = U.curRound(room); if (!rd.speeches.length) return '（你是本輪第一位發言者）'; return rd.speeches.map(sp => { const who = U.byId(room, sp.playerId); const pos = rd.passOrder.indexOf(sp.playerId); return `- ${U.tag(who)}（傳遞${U.nth(pos)}，${sp.source === 'human' ? '真人' : '電腦'}）：「${sp.text}」\n  系統摘要：${sp.summary}`;
    }).join('\n');
  }

  function humanCalls(room) {
    const out = [];
    room.rounds.slice(0, room.currentRoundIdx + 1).forEach((rd, r) => {
      rd.speeches.filter(s => s.source === 'human').forEach(s => out.push(`第${r + 1}輪 ${s.summary}`));
    });
    return out.length ? out.join('\n') : '（真人尚未號召）';
  }

  /* ------------------------------------------------------------------ Prompt */

  function buildPrompt(bot, room, plan, A) {
    const { ctx } = A, meta = GD.Roster.byId(bot.botId) || { title: '理性推演', phrases: [] };
    const g = ctx.genes, rd = ctx.rd;
    const evil = !ctx.isGood;
    const partner = ctx.partner ? `你的秘密同伴是 ${U.tag(ctx.partner)}（${ctx.partner.role}）。` : (bot.role === '鄭國渠' ? '你不知道同伴是誰。' : '');
    const conflicts = Object.values(A.prof).flatMap(r => r.conflicts).filter(c => c.round === ctx.t + 1);
    const conflictTxt = conflicts.length
      ? conflicts.map(c => `${U.tag(U.byId(room, c.speakerId))}在${U.nth(c.speakerPos)}宣稱${B(c.beast)}${real(c.claim)}，但你在${U.nth(c.myPos)}親眼看到${real(c.saw)}（矛盾！不是他說謊，就是區間內有人啟動擾亂）`).join('\n')
      : '（目前沒有與你查驗直接矛盾的前手宣稱）';
    const top = A.topSuspect;

    const q = plan.askId ? U.byId(room, plan.askId) : null;
    const shadeTarget = plan.softShadeId ? U.byId(room, plan.softShadeId) : null;
    const fakeFangTgt = plan.fakeFangClaim ? U.byId(room, plan.fakeFangClaim.targetId) : null;

    const extra = [
      q ? `額外任務：用一句話點名${U.tag(q)}，說他累計 ${plan.askVotes} 票投在已公開的贗品上（最近是第 ${plan.askRound} 輪的${B(plan.askBeast)}），請他說明依據。只引用公開票型，不得提到你的私密查驗。` : '',
      shadeTarget ? `額外任務（暗踩不露餡）：你私下知道${U.tag(shadeTarget)}是壞人，但為了不暴露你是方震，請只用委婉的一句話說「我對${U.tag(shadeTarget)}這輪的傳遞與風向持保留態度，大家別盲從他」，嚴禁直接喊出「鑑人投他／指認他」或說你查驗過他！` : '',
      fakeFangTgt ? `額外任務（穿方震衣服擋刀）：為了幫真方震擋刀，這輪你『完全不要報自己看了什麼獸首真偽』，而是直接宣稱「我這輪查驗了${U.tag(fakeFangTgt)}的陣營，確認他是${plan.fakeFangClaim.isGoodCamp ? '好人' : '壞人'}」，並號召獸首跟投${B(plan.beast)}！` : '', plan.confess ? `額外任務：你被點名要說明投贗品的理由，這次選擇認壞。必須明確說出「我認壞」，承認那些票是故意灌的，並把你真實看到的查驗結果（${plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、') || '無'}）攤開給隊友。嚴禁說出任何具體角色名稱（老朝奉、藥不然、鄭國渠）或同伴是誰。`
        : plan.explain ? `額外任務：${plan.explain.callerName}點名要你說明為什麼把票投在贗品上，請簡短解釋當時的依據，${ctx.isGood ? '並承認被帶了風向' : '維持好人的樣子，不得承認自己是壞人'}。` : ''
    ].filter(Boolean);

    const task = evil
      ? [`1. 先回應前手發言，必要時點出與「你公開的立場」矛盾的人以轉移焦點。`,
         plan.mode === 'lie'
           ? `2. 你要帶風向：宣稱 ${B(plan.beast)} 是真品（你其實看到/判斷它不是），語氣要像認真盤邏輯的好人。` : plan.mode === 'follow' ? `2. 附和同伴，順著 ${B(plan.beast)} 的風向推。`
           : `2. 你這輪講真話偽裝：宣稱 ${B(plan.beast)} 是真品。`, `3. 結尾明確號召落票 ${B(plan.beast)}${plan.suspectId ? `，並暗示鑑人時可疑對象是 ${U.tag(U.byId(room, plan.suspectId))}` : ''}。`] : [`1. 點出前手與你「查驗結果」的矛盾（見上方【查驗矛盾】；若沒有矛盾，就說明你的查驗與前手吻合並提升可信度）。`, `2. 依你的陣營偽裝/表態：${plan.fakeFangClaim ? `你正在假裝自己是方震幫真方震擋刀，不要報獸首查驗，改報你查驗${U.tag(fakeFangTgt)}是${plan.fakeFangClaim.isGoodCamp ? '好人' : '壞人'}。`
           : bot.role === '許願' ? '你是許願，只能報出 1 尊獸首，不得暴露你驗了 2 尊。'
           : plan.hideBlind ? `你這輪其實被偷襲、什麼都看不到，但絕對不能說出「被偷襲」「眼前一片黑」或「驗不到」（會暴露你的身分價值）。請像親眼查驗過一樣，宣稱 ${B(plan.beast)} 是真品。`
           : plan.bluff ? `你其實看不到獸首，但絕對不能說「我驗不到」（會被藥不然認出）。請像親眼查驗過一樣，宣稱 ${B(plan.beast)} 是真品。`
           : '誠實陳述你看到的，不要暴露自己的技能細節。'}`,
         `3. 明確號召落票 ${B(plan.beast)}${plan.suspectId ? `，並號召鑑人時集火 ${U.tag(U.byId(room, plan.suspectId))}` : ''}${bot.role === '方震' ? '。注意：你是方震，絕對不可說出「我查驗過某人陣營」或任何與方震能力有關的字句，理由只能用公開的票型、時序與宣稱矛盾' : ''}。`];

    return [
      `你正在玩《古董局中局》8 人桌遊，請以第一人稱產生第 ${ctx.t + 1} 回合的發言（70~110 字，繁體中文，直接輸出台詞，不要加引號、角色名前綴或說明）。`,
      ``,
      `[我是誰與身分]`,
      `你是 ${U.tag(bot)}，人設：${meta.title}，口頭禪風格參考：「${meta.phrases[(ctx.t + Math.max(0, ctx.myPos)) % meta.phrases.length] || ''}」。`,
      `真實角色：【${bot.role}】（${ctx.isGood ? '許願陣營・好人' : '老朝奉陣營・壞人'}）。${partner}`,
      `個性（0~1）：多疑 ${g.skepticism}、欺騙 ${g.deception}、偽裝 ${g.camouflage}、號召 ${g.assertiveness}、從眾 ${g.conformity}。`,
      `本輪場上四尊獸首（只准提到這四尊）：${rd.beasts.map(b => B(b.name)).join('')}`,
      `你在本輪傳遞順位：${U.nth(ctx.myPos)}（共八位）。`,
      ``,
      `[我的私密查驗]`,
      ctx.log.blind ? `你這輪遭到藥不然偷襲，什麼都看不到。` : (ctx.log.inspect.length ? ctx.log.inspect.map(i => i.resultText).join('；') : '你這輪沒有獸首查驗結果。'),
      ctx.log.fangTargetId ? `方震查驗：${U.tag(U.byId(room, ctx.log.fangTargetId))}為${ctx.log.fangCamp === 'evil' ? '壞人' : '好人'}。` : '',
      `【查驗矛盾】\n${conflictTxt}`,
      `你的推理結論（後驗為真機率）：${A.post.map(b => `${B(b.name)}${Math.round(b.pReal * 100)}%`).join(' ')}${top ? `；目前最可疑者：${U.tag(top.player)}` : ''}`,
      ``,
      `[前手發言與真人號召紀錄]`,
      priorSpeeches(room),
      `【真人號召彙整】\n${humanCalls(room)}`,
      ``,
      `[歷史開票真偽]`,
      history(room),
      ``,
      `[發言要求]`,
      ...task,
      ...extra,
      `硬性規則：提到獸首與玩家一律加【】（例：${B(plan.beast)}、${U.tag(bot)}）；真偽宣稱與落票只限本輪四尊；不得直接說出你的角色名稱。`
    ].filter(Boolean).join('\n');
  }

  /* ------------------------------------------------------------------ 本地備援發言 */

  function localSpeech(bot, room, plan, A) {
    const { ctx } = A, meta = GD.Roster.byId(bot.botId) || { phrases: ['我把證據盤清楚'] };
    const opener = meta.phrases[(ctx.t + Math.max(0, ctx.myPos)) % meta.phrases.length] + '！';
    const parts = plan.confess ? [] : [opener];
    const pos = U.nth(ctx.myPos);

    /* ① 查驗矛盾 */
    const conflicts = Object.values(A.prof).flatMap(r => r.conflicts).filter(c => c.round === ctx.t + 1);
    if (ctx.isGood && conflicts.length && !plan.fakeFangClaim) {
      const c = conflicts[0], sp = U.byId(room, c.speakerId);
      const mid = c.between.map(id => U.tag(U.byId(room, id))).filter(Boolean);
      parts.push(`先對時序：${U.tag(sp)}在${U.nth(c.speakerPos)}說${B(c.beast)}是${real(c.claim)}品，但我${pos}親眼看到的是${real(c.saw)}品，兩邊對不上。要嘛他在騙票，要嘛${U.nth(Math.min(c.speakerPos, c.myPos))}到${U.nth(Math.max(c.speakerPos, c.myPos))}之間${mid.length > 1 ? `（${mid.slice(0, 3).join('、')}）` : ''}有人開了擾亂。`);
    } else if (ctx.isGood && ctx.t > 0 && A.topSuspect && A.topSuspect.evil >= 20 && !plan.softShadeId && !plan.fakeFangClaim) {
      parts.push(`回頭看前輪鐵證：${U.tag(A.topSuspect.player)}${A.topSuspect.said[0] ? `——${A.topSuspect.said[0]}` : '——票型與發言對不上'}，這輪他推的線請大家特別小心。`);
    } else if (!ctx.isGood && A.topSuspect && ctx.t > 0 && rndPick(0.5)) {
      parts.push(`我也盤了前輪：${U.tag(A.topSuspect.player)}${A.topSuspect.said[0] ? `——${A.topSuspect.said[0]}` : '——票型有點怪'}，大家別被他帶節奏。`);
    }

    /* ①-b 票型質問（好人）*/
    if (plan.askId) {
      const q = U.byId(room, plan.askId);
      parts.push(`有件事要請${U.tag(q)}說明一下：你累計 ${plan.askVotes} 票投在已公開的贗品上，最近一次是第 ${plan.askRound} 輪的${B(plan.askBeast)}，票型大家都看得到，你當時的依據是什麼？`);
    }

    /* ①-c 被質問時的回應 */
    if (plan.explain && !plan.confess) {
      const f = plan.explain.votes[plan.explain.votes.length - 1];
      parts.push(ctx.isGood
        ? `${plan.explain.callerName}問我為什麼投贗品，我直說：第 ${f.round} 輪我投了 ${f.n} 票給${B(f.beast)}，是依前手宣稱與自己的查驗判斷，結果被帶了風向，我看走眼，這輪我會更謹慎。`
        : `${plan.explain.callerName}問我第 ${f.round} 輪那 ${f.n} 票，我當時是照前手的說法與自己的判斷跟著投，結果看走眼，事後看才知道被帶了風向，這點我認。`);
    }

    /* ② 偽裝 / 帶風向 / 查驗陳述 / 好人穿方震衣服擋刀 */
    const mine = ctx.myIns;
    if (plan.confess) {
      const seen = plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、');
      const f = plan.explain && plan.explain.votes[plan.explain.votes.length - 1];
      parts.push(`被點名了我就直說，我認壞，不再裝了。${f ? `第 ${f.round} 輪那 ${f.n} 票是我故意灌的。` : ''}` +
        `${seen ? `我這輪親眼看到的是${seen}，這是我真實的查驗結果，壞人這邊的朋友可以直接拿去用。` : '我這輪沒有可靠的查驗結果。'}` +
        `其他人不管信不信，總之幫我盯緊誰在亂報、誰在找人，把方震和許願揪出來。`);
    } else if (ctx.isGood && plan.fakeFangClaim) {
      /* ★ 好人主動穿方震衣服擋刀：不報獸首，改報查驗某人陣營是好人/壞人 */
      const fgTgt = U.byId(room, plan.fakeFangClaim.targetId);
      parts.push(`我在${pos}不談獸首，直接跟大家交底：我剛才查驗了${U.tag(fgTgt)}的陣營，確認他是${plan.fakeFangClaim.isGoodCamp ? '鐵好人，他的發言大家可以放心信' : '老朝奉陣營的壞人，大家千萬別信他帶的風向'}！`);
    } else if (ctx.isGood) {
      if (plan.claims.length) {
        const sayTxt = plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、');
        parts.push(plan.bluff
          ? `我從${pos}順著這輪的傳遞脈絡掌眼看下來，${sayTxt}這條線非常乾淨。`
          : `我在${pos}親手掌眼，${sayTxt}${bot.role === '姬雲浮' ? '，我的眼力不受任何擾亂影響' : ''}。`);
      } else {
        parts.push(`我${pos}${ctx.log.blind ? '被偷襲眼前一片黑，上一棒傳給我的人嫌疑不小' : '這輪無法辨別真偽'}，先順著前手可信線索推演。`);
      }
    } else if (plan.mode === 'lie' || plan.mode === 'follow') {
      const prior = rd => rd.speeches.find(s => (s.p.claims || []).some(c => c.real && c.beast !== plan.beast));
      const pr = prior(ctx.rd);
      if (pr && plan.avoid.length === 0 && rndPick(0.6)) {
        const c = pr.p.claims.find(x => x.real && x.beast !== plan.beast);
        parts.push(`${U.tag(U.byId(room, pr.playerId))}說${B(c.beast)}是真品，但傳到我${pos}看到的對不上，前面八成有人反轉過，保險起見別碰${B(c.beast)}。`);
      } else {
        parts.push(`我在${pos}${mine.length ? '掌眼後' : '綜合判斷'}，${B(plan.beast)}是真品，包漿與工藝都穩。`);
      }
      plan.avoid.forEach(a => parts.push(`倒是${B(a)}有疑點，我建議避開。`));
    } else {
      parts.push(`我在${pos}看下來${B(plan.beast)}是真品，${mine.length ? '這跟我的查驗吻合' : '這是目前最穩的線'}。`);
    }

    /* ③ 明確號召與暗踩 (softShadeId) */
    parts.push(`所以這輪我的籌碼全壓${B(plan.beast)}，請大家跟我集中投${B(plan.beast)}！`);
    if (plan.softShadeId) {
      const sh = U.byId(room, plan.softShadeId);
      parts.push(`另外，我對${U.tag(sh)}這輪的傳遞節奏與發言風向持保留態度，建議大家先別盲從他。`);
    } else if (plan.followHuman) {
      parts.push(`鑑人環節我附議【${plan.followHuman.callerName}】，一起集火${U.tag(U.byId(room, plan.followHuman.targetId))}！`);
    } else if (plan.suspectId) {
      parts.push(`鑑人時我建議大家看緊${U.tag(U.byId(room, plan.suspectId))}，一起指認他！`);
    }
    return parts.join('');
  }
  function rndPick(p) { return Math.random() < p; }

  /* ------------------------------------------------------------------ 驗證 Gemini 輸出 */

  function validate(text, bot, room, plan, A) {
    if (!text || typeof text !== 'string') return { ok: false, why: '空回應' };
    const s = text.trim();
    if (s.length < 25 || s.length > 420) return { ok: false, why: `長度 ${s.length} 不合理` };
    const seen = new Set(room.rounds.slice(0, room.currentRoundIdx + 1).flatMap(r => r.beasts.map(b => b.name)));
    const mentioned = [...s.matchAll(/【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】/g)].map(m => m[1]);
    if (mentioned.some(n => !seen.has(n))) return { ok: false, why: '提到從未出現過的獸首' };
    const parsed = Claims.parse(s, room);
    const claims = parsed.claims;
    if (bot.role === '許願' && new Set(claims.map(c => c.beast)).size >= 2) return { ok: false, why: '許願報了 2 尊' };
    if (A.ctx.isGood && !plan.fakeFangClaim) {
      for (const i of A.ctx.myIns) {
        const c = claims.find(x => x.beast === i.beastName);
        if (c && c.real !== i.displayedReal) return { ok: false, why: `與自己對【${i.beastName}】的查驗矛盾` };
      }
    }
    if (!parsed.callBeasts.includes(plan.beast)) return { ok: false, why: `沒有號召投【${plan.beast}】` };
    if (plan.bluff && (parsed.unsure || /驗不到|看不懂|看不到|無法辨別/.test(s))) return { ok: false, why: '方震不可說自己驗不到' };
    if (plan.hideBlind && (parsed.blind || /被偷襲|遭偷襲|眼前一片黑|一片黑|偷襲/.test(s))) return { ok: false, why: '被偷襲者不輕易說出被偷襲' };
    if (new RegExp(`我是(?:【)?${bot.role}`).test(s)) return { ok: false, why: '自曝角色' };

    // ★ 若不是在執行「假跳方震擋刀 (plan.fakeFangClaim)」，真方震絕對不可洩漏陣營查驗，且在 softShadeId 階段不可直接喊指認
    if (!plan.fakeFangClaim) {
      if (/(我|本人)[^，。！？]{0,4}(查驗|驗)[^，。！？]{0,6}(陣營|是好人|是壞人|為好人|為壞人|老朝奉陣營)/.test(s) || parsed.campChecks.length) {
        return { ok: false, why: '洩漏陣營查驗（方震身分）' };
      }
    }
    if (bot.role === '方震' && plan.softShadeId && !plan.suspectId && (parsed.callSuspectId || /一起指認|鑑人.*投|看緊.*一起/.test(s))) {
      return { ok: false, why: '方震在前兩輪只應暗踩，不可直接明喊鑑人指認' };
    }
    if (/方震/.test(s) && bot.role === '方震') return { ok: false, why: '方震提到自己的角色名' };
    if (plan.confess) {
      if (!parsed.selfEvil) return { ok: false, why: '認壞計畫但發言沒有明確認壞' };
      if (/(我|本人|咱)[^，。！？]{0,4}(是|為|當|扮|就是)[^，。！？]{0,3}(老朝奉|藥不然|鄭國渠)|(老朝奉|藥不然|鄭國渠)[^，。！？]{0,4}(是我|就是我|是本人)|(同伴|隊友|搭檔)[^，。！？]{0,4}(是|就是)[^，。！？]{0,3}(老朝奉|藥不然|鄭國渠|【)/.test(s)) {
        return { ok: false, why: '認壞時不得報出自己的具體角色或同伴身分' };
      }
    } else if (!A.ctx.isGood && (parsed.selfEvil || /我是(?:【)?(老朝奉|藥不然|鄭國渠)|我們是壞人|我是壞人/.test(s))) return { ok: false, why: '壞人自曝' };
    if (A.ctx.isGood && parsed.selfEvil) return { ok: false, why: '好人不可說自己是壞人' };
    if (plan.askId && !parsed.asked.includes(plan.askId)) return { ok: false, why: '計畫要質問票型，發言卻沒有點名請對方說明' };
    return { ok: true, parsed };
  }

  GD.Speech = { buildPrompt, localSpeech, validate, history };
})(window.GD);
