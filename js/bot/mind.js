/* ============================================================================
 * bot/mind.js — PersuasiveMindEngine（說服型推理大腦・時序交集與3壞人重盤強化版）
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U, Rules } = GD;
  const EVIL = ['老朝奉', '藥不然', '鄭國渠'];
  const CONFIGS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

  function context(bot, room) {
    const t = room.currentRoundIdx, rd = room.rounds[t];
    const pass = rd.passOrder;
    const log = rd.turnLogs[bot.id] || { inspect: [] };
    const partner = bot.role === '老朝奉' ? room.players.find(p => p.role === '藥不然')
                  : bot.role === '藥不然' ? room.players.find(p => p.role === '老朝奉') : null;
    return {
      bot, room, t, rd, pass, log,
      isGood: GD.isGood(bot.role),
      genes: bot.genes || GD.Genes.load(bot.botId),
      myPos: pass.indexOf(bot.id),
      myIns: (log.inspect || []).filter(i => typeof i.displayedReal === 'boolean'),
      partner,
      names: rd.beasts.map(b => b.name)
    };
  }

  const blank = p => ({
    player: p, evil: 0, ally: 0, logits: {}, reasons: [], said: [], conflicts: [],
    // 資訊能力與陣營推斷分開：infoSkill 只衡量過往可驗證公開主張的準確度。
    infoSkill: 50, infoSamples: 0, infoScore: 0, infoCorrect: 0, infoWrong: 0, infoHistory: [],
    commitments: [], voteDissonance: [],
    confessed: false, knownEvil: false, pubFake: 0, inLaoPoolCount: 0
  });

  // Position means passOrder (who received the phone in that slot), never speechOrder.
  // The first three slots get a stronger starting prior, but direct evidence and role suspicion can override it.
  function passPositionPrior(position) {
    if (!Number.isInteger(position) || position < 0) return 0;
    if (position <= 2) return 0.12;   // positions 1–3: comparatively cleaner information
    if (position <= 4) return -0.10;  // positions 4–5: substantially noisier than the first three
    return -0.16;                    // positions 6–8: highest noise; explicitly consider reversal timing
  }

  function speechData(sp, room, rd) {
    if (GD.Claims && typeof GD.Claims.parseRecord === 'function') {
      try { return GD.Claims.parseRecord(sp, room, rd) || {}; }
      catch (_) { return {}; }
    }
    if (sp && sp.p && typeof sp.p === 'object') return sp.p;
    if (GD.Claims && typeof GD.Claims.parse === 'function') {
      try { return GD.Claims.parse(String(sp && sp.text || ''), room, rd) || {}; }
      catch (_) { return {}; }
    }
    return {};
  }

  function speechClaims(sp, room, rd) {
    const parsed = speechData(sp, room, rd);
    return Array.isArray(parsed.claims) ? parsed.claims : [];
  }

  function sumBallot(ballot) {
    return Object.values(ballot || {}).reduce((n, v) => n + Math.max(0, Number(v) || 0), 0);
  }

  // A player's observed inspection is not automatically an objective truth for every other seat.
  // If a late player claims FALSE but still concentrates votes on that same beast, it may be a deliberate
  // counter-read of Lao Chaofeng's reversal skill rather than simple vote inconsistency.
  function voteViewAdjustment(options = {}) {
    const {
      myPosition = -1, voterPosition = -1, privateView = false,
      claimedFalse = false, mentionsLao = false, plausibleLaoBefore = false, chipCount = 0
    } = options;
    if (!privateView || myPosition < 0 || voterPosition < 0) {
      return { multiplier: 1, reverseRead: false, reason: 'not-a-private-view' };
    }
    const distance = Math.abs(myPosition - voterPosition);
    const couldBeOnDifferentSide = distance > 1;
    // A multi-chip ballot is a strong commitment, but it is not itself evidence that Lao reversed the view.
    // Treat a late FALSE claim + vote as a plausible counter-read only when the speaker names Lao/reversal
    // or public evidence makes a Lao-before-them scenario plausible; otherwise use the ordinary late-position discount.
    if (voterPosition >= 3 && couldBeOnDifferentSide && claimedFalse && chipCount > 0 &&
        (mentionsLao || plausibleLaoBefore)) {
      return {
        multiplier: (mentionsLao && plausibleLaoBefore) ? 0.12 : 0.28,
        reverseRead: true,
        reason: 'late-false-claim-vote-can-be-a-reversal-counter-read'
      };
    }
    if (couldBeOnDifferentSide) {
      return {
        multiplier: voterPosition >= 3 ? 0.45 : 0.72,
        reverseRead: false,
        reason: 'possible-different-view-across-Lao-position'
      };
    }
    return { multiplier: 1, reverseRead: false, reason: 'adjacent-or-same-view-band' };
  }

  function pubFakeVotes(room, pid, t) {
    const out = [];
    for (let r = 0; r <= t; r++) {
      const rd = room.rounds[r]; if (!rd || !rd.voteResults) continue;
      const r2 = rd.voteResults.rank2, n = ((rd.votes || {})[pid] || {})[r2.name] || 0;
      if (!r2.isReal && n > 0) out.push({ round: r + 1, beast: r2.name, n });
    }
    return out;
  }

  function bump(rec, { evil = 0, ally = 0, roles = null, why = null, say }) {
    rec.evil += evil; rec.ally += ally;
    if (roles) for (const [r, d] of Object.entries(roles)) rec.logits[r] = (rec.logits[r] || 0) + d;
    if (why) rec.reasons.unshift(why);
      // why 是內部推理；said 只存明確標記為可公開表達的 say。
      if (say !== null && say !== undefined && String(say).trim()) {
        rec.said.unshift(String(say).trim());
      }
  }

  // 僅用已公開的第二名開票結果回看此前的公開判斷；不讀私密 mind／真實角色。
  // 重複別人的相同結論只計少量權重，避免複誦被誤認成推理能力。
  // 這個指標完全不寫入 evil、ally 或 probs；資訊準確不代表好人，也不代表壞人。
  function buildInformationSkill(ctx, prof) {
    Object.values(prof || {}).forEach(rec => {
      rec.infoSkill = 50; rec.infoSamples = 0; rec.infoScore = 0;
      rec.infoCorrect = 0; rec.infoWrong = 0; rec.infoHistory = [];
    });
    const room = ctx && ctx.room;
    if (!room || !prof) return prof;
    for (let r = 0; r < (Number(ctx.t) || 0); r++) {
      const rd = (room.rounds || [])[r];
      const opened = rd && rd.voteResults && rd.voteResults.rank2;
      if (!opened || typeof opened.isReal !== 'boolean' || !opened.name) continue;
      const seenClaims = new Set();
      (rd.speeches || []).forEach(sp => {
        const rec = prof[sp && sp.playerId];
        if (!rec || !sp || !sp.playerId) return;
        const claim = speechClaims(sp, room, rd).find(c => c && c.beast === opened.name && typeof c.real === 'boolean');
        if (!claim) return;
        const key = `${opened.name}:${claim.real}`;
        const echoed = seenClaims.has(key);
        seenClaims.add(key);
        const weight = echoed ? 0.25 : 1;
        const correct = claim.real === opened.isReal;
        rec.infoSamples += weight;
        rec.infoScore += correct ? weight : -weight;
        if (correct) rec.infoCorrect += weight; else rec.infoWrong += weight;
        rec.infoHistory.push({ round: r + 1, beast: opened.name, claimedReal: claim.real,
          revealedReal: opened.isReal, correct, independent: !echoed, weight });
      });
    }
    Object.values(prof).forEach(rec => {
      // 中性先驗為 50，兩個先驗樣本避免只說對／錯一次就極端化。
      rec.infoSkill = Math.round(U.clamp(50 + 50 * rec.infoScore / (2 + rec.infoSamples), 0, 100));
    });
    return prof;
  }

  function buildProfiles(ctx) {
    const { bot, room, t, genes, isGood } = ctx;
    const sk = genes.skepticism, cf = genes.conformity;
    const prof = {};
    room.players.forEach(p => { if (p.id !== bot.id) prof[p.id] = blank(p); });
    if (ctx.partner && prof[ctx.partner.id]) {
      bump(prof[ctx.partner.id], { ally: 100, roles: { [ctx.partner.role]: 12 }, why: '我的秘密同伴', say: null });
    }

    const laoPools = [];

    for (let r = 0; r <= t; r++) {
      const rd = room.rounds[r], pass = rd.passOrder, R = `第${r + 1}輪`;
      const me = rd.turnLogs[bot.id] || { inspect: [] };
      const myPos = pass.indexOf(bot.id);
      const ins = (me.inspect || []).filter(i => typeof i.displayedReal === 'boolean');

      if (pass.length === 8 && isGood && (r < t || rd.voteResults)) {
        const p6 = pass[5], p8 = pass[7];
        const link = `${R}第六位把手機控成第八位尾家（六控八）`;
        [p6, p8].forEach(pid => prof[pid] && pid !== bot.id && bump(prof[pid], { evil: 6 + 4 * sk, roles: { '老朝奉': 0.25, '藥不然': 0.25 }, why: link }));
      }

      if (me.fangTargetId && prof[me.fangTargetId]) {
        const evil = me.fangCamp === 'evil';
        bump(prof[me.fangTargetId], evil
          ? { evil: 95, roles: { '老朝奉': 5, '藥不然': 5, '鄭國渠': 5 }, why: `${R}我以【方震】親手查驗確認他是老朝奉陣營`, say: null }
          : { ally: 90, roles: { '老朝奉': -6, '藥不然': -6, '鄭國渠': -6 }, why: `${R}我以【方震】親手查驗確認他是好人陣營`, say: null });
      }

      if (me.blind && myPos > 0) {
        const earlier = pass.slice(0, myPos);
        const weightBoost = earlier.length === 1 ? 85 : (38 / earlier.length);
        earlier.forEach(pid => prof[pid] && bump(prof[pid], {
          evil: weightBoost, roles: { '藥不然': earlier.length === 1 ? 8.0 : (2.2 / earlier.length * 2) },
          why: earlier.length === 1
            ? `${R}排在第一位傳手機給我，害我在第二位直接被偷襲，鐵定是【藥不然】`
            : `${R}我遭藥不然偷襲致盲，他排在我之前的行動者之列`,
          say: null
        }));
        // 第三位被盲時，前兩位容易被套入「第一位像藥不然、第二位像老朝奉」的角色配對。
        // 只作弱先驗，不當作公開事實；此弱偏置也讓壞人有機會利用角色互換栽贓。
        if (isGood && myPos === 2 && earlier.length === 2) {
          const first = prof[earlier[0]], second = prof[earlier[1]];
          if (first) bump(first, { evil: 3.5, roles: { '藥不然': 1.65, '老朝奉': 0.35 }, why: `${R}第三位遭偷襲時，第一位是藥不然的時序假設值得核查`, say: null });
          if (second) bump(second, { evil: 3.0, roles: { '老朝奉': 1.45, '藥不然': 0.55 }, why: `${R}第三位遭偷襲時，第二位可能被推成老朝奉，但仍需驗證`, say: null });
        }
      }

      if (!isGood) {
        const mineAmb = me.ambushIds || [];
        const claimedBeastsSoFar = new Set();
        (rd.speeches || []).forEach(sp => {
          const rec = prof[sp.playerId];
          if (!rec) return;
          const parsed = speechData(sp, room, rd);
          const rawTxt = String(sp.text || '');
          if ((parsed.campChecks && parsed.campChecks.length) || /查驗.*陣營|不談獸首.*查驗/.test(rawTxt)) {
            bump(rec, { roles: { '方震': 2.6 }, why: `${R}公開宣稱查驗玩家陣營、不報獸首，極像【方震】`, say: null });
          }
          if ((parsed.unsure || parsed.blind) && !mineAmb.includes(sp.playerId)) {
            bump(rec, { roles: { '方震': 1.0, '黃煙煙': 0.4, '木戶加奈': 0.4 }, why: `${R}自稱驗不到`, say: null });
          }
          const myClaims = Array.isArray(parsed.claims) ? parsed.claims : [];
          const isEchoOnly = myClaims.length > 0 && myClaims.every(c => claimedBeastsSoFar.has(c.beast));
          const isFirstClaimer = myClaims.length > 0 && myClaims.some(c => !claimedBeastsSoFar.has(c.beast));
          const isAggressiveHunter = (parsed.accuse && parsed.accuse.length > 0) || !!parsed.callSuspectId || (parsed.asked && parsed.asked.length > 0);

          if (isEchoOnly && isAggressiveHunter) {
            bump(rec, { roles: { '方震': 1.15 }, why: `${R}獸首僅順風附和前手，卻積極點名抓人或質問`, say: null });
          } else if (isFirstClaimer && myPos > 0) {
            bump(rec, { roles: { '許願': 0.45, '姬雲浮': 0.35 }, why: `${R}主動首發開出新獸首真偽線`, say: null });
          }
          myClaims.forEach(c => claimedBeastsSoFar.add(c.beast));
        });
      }

      if (!isGood) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId];
        if (!rec || !speechData(sp, room, rd).selfEvil) return;
        rec.knownEvil = true;
        bump(rec, { ally: 60, why: `${R}公開認壞，確定是自己人`, say: null });
      });

      /* ★ 好人查驗矛盾分析：緊鄰順位零距離直踩 ＆ 首家不反轉鐵律 */
      if (isGood) {
        ins.forEach(i => (rd.speeches || []).forEach(sp => {
          if (sp.playerId === bot.id || !prof[sp.playerId]) return;
          const a = pass.indexOf(sp.playerId);
          if (a < 0 || myPos < 0) return;
          speechClaims(sp, room, rd).filter(c => c.beast === i.beastName).forEach(c => {
            if (c.real === i.displayedReal) {
              bump(prof[sp.playerId], { ally: 14, roles: { '許願': 0.4 } });
              return;
            }
            const lo = Math.min(a, myPos), hi = Math.max(a, myPos);
            // 可能在 lo 到 hi 之間按擾亂的人：包含 lo 到 hi-1（因為 hi 查驗時還沒輪到 hi 按技能）
            const flipPool = pass.slice(lo, hi).filter(x => x !== bot.id);
            const isAdjacent = (hi - lo === 1);

            if (isAdjacent && a < myPos) {
              // 緊鄰前手（例如第 4 位直接傳給第 5 位），中間完全沒別人！
              bump(prof[sp.playerId], {
                evil: 46 * (0.65 + sk),
                roles: { '老朝奉': 2.6 * (0.65 + sk), '藥不然': 0.8, '鄭國渠': 0.8 },
                why: `${R}在${U.nth(a)}緊鄰傳給我${U.nth(myPos)}，中間無人卻與我查驗的【${c.beast}】相反，必為他說謊或本人啟動老朝奉擾亂`
              });
            } else {
              const spkWeight = a === 0 ? 18 * (0.5 + sk) : 25 * (0.55 + sk);
              bump(prof[sp.playerId], {
                evil: spkWeight, roles: { '老朝奉': 1.4 * (0.6 + sk) },
                why: `${R}在${U.nth(a)}宣稱【${c.beast}】${c.real ? '真' : '假'}，與我${U.nth(myPos)}看到的${i.displayedReal ? '真品' : '贗品'}相反`
              });
              flipPool.forEach(pid => pid !== sp.playerId && prof[pid] && bump(prof[pid], {
                evil: 12 * (0.5 + sk), roles: { '老朝奉': 1.25 / Math.sqrt(Math.max(1, flipPool.length)) },
                why: `${R}位於【${c.beast}】真偽矛盾的傳遞區間內`
              }));
            }

            if (bot.role !== '姬雲浮' && flipPool.length > 0) {
              laoPools.push({ round: r + 1, reason: `【${c.beast}】查驗矛盾區間`, ids: flipPool });
            }

            prof[sp.playerId].conflicts.push({
              round: r + 1, beast: c.beast, speakerId: sp.playerId, speakerPos: a, claim: c.real,
              myPos, saw: i.displayedReal,
              between: flipPool.map(x => x),
              isAdjacent,
              speakerIsFirst: a === 0
            });
          });
        }));
      }

      if (rd.voteResults) {
        const known = {};
        const r2 = rd.voteResults.rank2;
        const r1 = rd.voteResults.rank1;
        known[r2.name] = { real: r2.isReal, w: 1, pub: true, source: 'public-result' };

        /* ★ 若公開第二名 r2 的真偽與我當輪查驗相反 -> 證明我這輪被老朝奉反轉，鎖定前置位必有老朝奉 */
        if (isGood && bot.role !== '姬雲浮' && myPos > 0) {
          const myR2Ins = ins.find(i => i.beastName === r2.name);
          if (myR2Ins && myR2Ins.displayedReal !== r2.isReal) {
            const frontIds = pass.slice(0, myPos).filter(id => id !== bot.id);
            if (frontIds.length) {
              laoPools.push({
                round: r + 1,
                reason: `${R}我查驗【${r2.name}】遭反轉，前置行動者必有老朝奉`,
                ids: frontIds,
                confirmedFlip: true
              });
              frontIds.forEach(pid => prof[pid] && bump(prof[pid], {
                evil: 22 / Math.sqrt(frontIds.length),
                roles: { '老朝奉': 1.8 / Math.sqrt(frontIds.length) },
                why: `${R}我查驗【${r2.name}】遭反轉，他排在我前面的順位區間內，具老朝奉高度嫌疑`,
                say: null
              }));
            }
          }
        }

        const posReliability = (bot.role === '姬雲浮' || !isGood || myPos === 0)
          ? 0.96
          : Math.max(0.30, 0.90 - Math.max(0, myPos) * 0.085);

        ins.forEach(i => {
          if (!known[i.beastName]) known[i.beastName] = { real: i.displayedReal, w: posReliability, pub: false, source: 'private-inspect' };
        });
        if (!isGood) (rd.speeches || []).forEach(sp => {
          if (sp.playerId === bot.id) return;
          const publicData = speechData(sp, room, rd);
          if (!publicData.selfEvil) return;
          (Array.isArray(publicData.claims) ? publicData.claims : []).forEach(c => {
            if (c && c.beast && typeof c.real === 'boolean' && !known[c.beast]) {
              known[c.beast] = { real: c.real, w: 0.9, pub: false, source: 'ally-claim' };
            }
          });
        });

        const highConf = Object.entries(known).filter(([, v]) => v.w >= 0.85);
        const confReals = highConf.filter(([, v]) => v.real === true);
        const confFakes = highConf.filter(([, v]) => v.real === false);
        if (confReals.length >= 2) {
          rd.beasts.forEach(b => {
            if (!known[b.name]) known[b.name] = { real: false, w: 0.88, pub: false, deduced: true, source: 'private-deduction' };
          });
        } else if (confFakes.length >= 2) {
          rd.beasts.forEach(b => {
            if (!known[b.name]) known[b.name] = { real: true, w: 0.88, pub: false, deduced: true, source: 'private-deduction' };
          });
        }

        const r1SuspectWeight = (isGood && r2.isReal && r1 && r1.votes >= 8 && !known[r1.name]) ? 0.35 : 0;
        const speechById = new Map((rd.speeches || []).map(sp => [sp.playerId, sp]));

        Object.entries(rd.votes || {}).forEach(([vid, ballot]) => {
          const rec = prof[vid]; if (!rec) return;
          const spent = sumBallot(ballot);
          const voterPosition = pass.indexOf(vid);
          const speaker = speechById.get(vid) || null;
          const parsedSpeech = speechData(speaker, room, rd);
          const parsedClaims = Array.isArray(parsedSpeech.claims) ? parsedSpeech.claims : [];
          const calledBeasts = [...new Set([...(parsedSpeech.callBeasts || []), parsedSpeech.callBeast].filter(Boolean))];
          const calledBeast = calledBeasts[0] || null;
          const commitment = Object.entries(ballot || {})
            .map(([beast, raw]) => ({ beast, chips: Math.max(0, Number(raw) || 0) }))
            .filter(x => x.chips > 0)
            .sort((a, b) => b.chips - a.chips)[0];

          const calledVotes = calledBeasts.reduce((n, beast) => n + Math.max(0, Number(ballot[beast]) || 0), 0);
          // Multi-chip investment is a public commitment signal, not proof of good or evil by itself.
          // Compare the dominant off-call investment with every called target, not just the first call.
          if (commitment && commitment.chips >= 2) {
            rec.commitments.push({
              round: r + 1, beast: commitment.beast, chips: commitment.chips, total: spent,
              position: voterPosition, calledBeast: calledBeast || null, calledBeasts,
              callVotes: calledBeasts.length ? calledVotes : null,
              callShare: spent > 0 ? calledVotes / spent : 0,
              callAligned: calledBeasts.length ? (spent > 0 && calledVotes / spent >= 0.5) : null
            });
            if (calledBeasts.length && !calledBeasts.includes(commitment.beast) && commitment.chips > calledVotes) {
              const gap = commitment.chips - calledVotes;
              rec.voteDissonance.push({ round: r + 1, calledBeast, calledBeasts, investedBeast: commitment.beast,
                investedChips: commitment.chips, callVotes: calledVotes, gap, position: voterPosition });
              // A split may be strategically correct, so this is a modest audit signal rather than a guilt verdict.
              bump(rec, {
                evil: Math.min(5, 1.5 + gap * 0.7) * (0.65 + sk * 0.35),
                why: `${R}公開號召${calledBeasts.map(n => `【${n}】`).join('、')}，實際卻把 ${commitment.chips} 票集中在號召以外的【${commitment.beast}】（所有號召目標合計僅 ${calledVotes}/${spent} 票）；可能是分票或戰術轉向，需比較當輪票差和前後輪是否持續發生`,
                say: null
              });
            }
          }

          Object.entries(ballot).forEach(([name, rawCount]) => {
            const cnt = Math.max(0, Number(rawCount) || 0);
            if (cnt <= 0) return;
            const k = known[name];
            if (k) {
              const claimForBeast = parsedClaims.find(c => c && c.beast === name && typeof c.real === 'boolean');
              const claimedFalse = !!(claimForBeast && claimForBeast.real === false);
              const claimedTrue = !!(claimForBeast && claimForBeast.real === true);
              const mentionsLao = /老朝奉|擾亂|反轉|翻轉|倒著看|視野被/.test(String(speaker && speaker.text || ''));
              const plausibleLaoBefore = voterPosition > 0 && pass.slice(0, voterPosition).some(pid => {
                const prior = prof[pid];
                return !!(prior && (prior.knownEvil || prior.conflicts.length || prior.evil >= 18 ||
                  (Number(prior.logits['老朝奉']) || 0) >= 1.2));
              }) || laoPools.some(pool => (pool.ids || []).some(pid => pid === vid));
              const privateView = k.source === 'private-inspect' || k.source === 'private-deduction';
              const reading = voteViewAdjustment({
                myPosition: myPos, voterPosition, privateView, claimedFalse,
                mentionsLao, plausibleLaoBefore, chipCount: cnt
              });
              // A rank-2 result is published only after voting. Do not turn its later truth label into proof
              // that a voter knowingly backed a fake. Keep the raw count for a transparent retrospective question.
              if (k.pub) {
                if (!k.real) rec.pubFake += cnt;
                if (claimForBeast && claimForBeast.real !== k.real) {
                  bump(rec, {
                    evil: 20 * (0.6 + sk * 0.6) * (passPositionPrior(voterPosition) >= 0 ? 0.22 : 0.10),
                    why: `${R}公開宣稱【${name}】${claimForBeast.real ? '真品' : '贗品'}，開票後結果為${k.real ? '真品' : '贗品'}；投票發生在結果公開前，故只將宣稱矛盾列為弱線索`,
                    say: null
                  });
                }
                return;
              }

              const voteWeight = k.w * reading.multiplier;
              if (reading.reverseRead) {
                rec.voteDissonance.push({ round: r + 1, beast: name, chips: cnt, position: voterPosition,
                  type: 'possible-lao-reversal-counter-read', factor: reading.multiplier });
              }
              if (!k.real) {
                // The viewer's private result is not necessarily the voter's view. Strong suspicion requires
                // the voter's own public claim to say REAL while its concentrated ballot contradicts that claim.
                if (claimedTrue) {
                  bump(rec, {
                    evil: cnt * 12 * voteWeight * (0.6 + sk * 0.6),
                    roles: { '老朝奉': 0.45 * cnt * voteWeight },
                    why: reading.reverseRead
                      ? `${R}${U.nth(voterPosition)}對【${name}】公開稱真卻投入 ${cnt} 票；但其順位可能看見反轉結果，先保留為待核查的言行差異`
                      : `${R}對【${name}】公開稱真，實際卻投入 ${cnt} 票；這是宣稱與行動不一致，但仍需排除技能反轉與戰術分票`,
                    say: cnt >= 2 ? `${U.tag(rec.player)}公開稱【${name}】真，卻把 ${cnt} 票押在這條線；要他說明是否有分票或反轉依據` : null
                  });
                } else if (claimedFalse) {
                  bump(rec, { ally: cnt * 3 * voteWeight, why: reading.reverseRead
                    ? `${R}公開稱【${name}】贗品並投向它；晚順位可能是在反讀老朝奉技能，不能當成矛盾`
                    : null, say: null });
                }
              } else if (claimedFalse) {
                // Conversely, claiming REAL while voting against it (or claiming FALSE while backing it)
                // is a speech/action mismatch; multi-chip commitment increases the audit value, not guilt by itself.
                bump(rec, {
                  evil: cnt * 8 * voteWeight * (0.6 + sk * 0.5),
                  roles: { '老朝奉': 0.25 * cnt * voteWeight },
                  why: reading.reverseRead
                    ? `${R}雖公開稱【${name}】贗品卻把票投向此獸；若存在反轉區間，這可能是策略性逆讀，不直接定罪`
                    : `${R}公開稱【${name}】贗品，卻把 ${cnt} 票投向它；可能是分票、信念改變或宣稱不一致，需看其他證據`,
                  say: cnt >= 2 ? `${U.tag(rec.player)}對【${name}】的宣稱與 ${cnt} 票配置不完全一致，值得問明分票理由` : null
                });
              } else {
                // Voting in line with a private TRUE view is only a small consistency signal, never a role proof.
                bump(rec, { ally: cnt * 3 * voteWeight, roles: { '許願': 0.15 * cnt * voteWeight },
                  why: privateView && reading.multiplier < 1
                    ? `${R}${U.nth(voterPosition)}把票投向我顯示為真品的【${name}】，但其位置可能看到反轉結果，不能把我的私密查驗直接當成他必然知道的事實`
                    : null });
              }
            } else if (r1SuspectWeight > 0 && name === r1.name) {
              bump(rec, {
                evil: r1.hidden === true ? 0 : cnt * 10 * r1SuspectWeight * (0.5 + sk * 0.5),
                roles: r1.hidden === true ? {} : { '老朝奉': 0.3 * cnt, '鄭國渠': 0.3 * cnt },
                why: r1.hidden === true ? '' : `${R}第二名【${r2.name}】公開為真品，他卻把 ${cnt} 票灌在高票第一名【${r1.name}】（${r1.votes}票）上`,
                say: r1.hidden === true ? null : `${U.tag(rec.player)}在${R}把 ${cnt} 票投給高票第一名【${r1.name}】，壓過真品【${r2.name}】`
              });
            }
          });
        });

        // Compare a public claim with the revealed rank-2 result, while allowing for Lao's position-dependent reversal.
        // Earlier claims are more informative by default; claims from later seats can be an honest reversed view.
        if (isGood) {
          (rd.speeches || []).forEach(sp => {
            const rec = prof[sp.playerId]; if (!rec) return;
            const mismatchingClaim = speechClaims(sp, room, rd).find(c => c && c.beast === r2.name &&
              typeof c.real === 'boolean' && c.real !== r2.isReal);
            if (!mismatchingClaim) return;
            const sPos = pass.indexOf(sp.playerId);
            const priorLaoEvidence = sPos > 0 && pass.slice(0, sPos).some(pid => {
              const prior = prof[pid];
              return !!(prior && (prior.knownEvil || prior.conflicts.length || prior.evil >= 18 ||
                (Number(prior.logits['老朝奉']) || 0) >= 1.2));
            });
            const mismatchWeight = sPos <= 0 ? 1.0
              : sPos <= 2 ? (priorLaoEvidence ? 0.48 : 0.72)
              : sPos <= 4 ? (priorLaoEvidence ? 0.22 : 0.42)
              : (priorLaoEvidence ? 0.12 : 0.28);
            const claimedText = mismatchingClaim.real ? '真品' : '贗品';
            const openedText = r2.isReal ? '真品' : '贗品';
            bump(rec, {
              evil: 20 * (0.6 + sk * 0.6) * mismatchWeight,
              roles: { '老朝奉': 1.1 * mismatchWeight, '藥不然': 0.7 * mismatchWeight, '鄭國渠': 0.7 * mismatchWeight },
              why: mismatchWeight < 0.5
                ? `${R}${U.nth(sPos)}宣稱【${r2.name}】${claimedText}，公開結果是${openedText}；但晚順位資訊可能受前段擾亂影響，先列為待驗矛盾而非直接定罪`
                : `${R}${U.nth(sPos)}宣稱【${r2.name}】${claimedText}，公開結果是${openedText}，需再判斷是說謊或技能反轉`,
              say: mismatchWeight >= 0.5
                ? `${U.tag(rec.player)}在${R}宣稱【${r2.name}】${claimedText}，但公開結果是${openedText}`
                : null
            });
          });
        }
      }

      if (isGood) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId];
        if (!rec || !speechData(sp, room, rd).selfEvil) return;
        rec.confessed = true;
        bump(rec, {
          evil: 10, roles: { '老朝奉': 0.2, '藥不然': 1.1, '鄭國渠': 1.1, '許願': -6, '方震': -6, '姬雲浮': -6, '黃煙煙': -6, '木戶加奈': -6 },
          why: `${R}自己公開認壞`
        });
      });

      if (isGood) (rd.speeches || []).forEach((sp, i) => (sp.p?.asked || []).forEach(aid => {
        const rec = prof[aid]; if (!rec) return;
        const reply = (rd.speeches || []).slice(i + 1).find(x => x.playerId === aid);
        if (reply && !/(說明|解釋|交代|被騙|看走眼|認壞|依據|因為)/.test(reply.text)) {
          bump(rec, { evil: 22, roles: { '老朝奉': 0.8 }, why: `${R}被【${sp.speakerName}】點名請說明票型，發言時卻閃躲沒有回應` });
        }
      }));

      if (rd.voteResults) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId]; const cb = sp.p?.callBeast; if (!rec || !cb) return;
        const ballot = rd.votes[sp.playerId] || {};
        if (U.sum(Object.values(ballot)) > 0 && !(ballot[cb] > 0)) {
          bump(rec, { evil: 24 * (0.5 + sk), roles: { '老朝奉': 1.2 }, why: `${R}口頭號召投【${cb}】，開票卻沒投（言行不一）` });
        }
      });

      // 同一輪多名玩家重複指向同一目標時，後續呼應屬於相關訊號，不應按獨立證據全額累加。
      // 只降低重複呼應的權重；原始指控仍保留，具體角色/查驗矛盾仍由獨立證據另行評估。
      const seenPublicCallsByTarget = new Map();
      const seenRoleAccusations = new Set();
      (rd.speeches || []).forEach(sp => {
        if (sp.playerId === bot.id || !prof[sp.playerId]) return;

        // 不再依 sp.source === 'human' 給真人固定加權、對 Bot 打 0.45 折扣。
        // 指控權重改由「號召者在本 AI 視角下的可信度」與「被指控者的獨立證據」決定。
        // 注意：ally/evil 是目前對局累積的證據分數，不是永久人格分數。
        const caller = prof[sp.playerId];
        // A true-role micro-claim is weak public evidence, not proof: a fake claimant can imitate the same line.
        const publicRoleSignal = GD.DialogueBank && typeof GD.DialogueBank.detectRoleSignal === 'function'
          ? GD.DialogueBank.detectRoleSignal(String(sp.text || ''))
          : null;
        if (caller && publicRoleSignal) {
          bump(caller, {
            roles: { [publicRoleSignal.role]: publicRoleSignal.weight },
            why: `${R}公開發言出現疑似【${publicRoleSignal.role}】的微跳線索（弱佐證，仍可能模仿）`,
            say: null
          });
        }
        const callerCredibility = U.clamp(
          0.55 + ((caller.ally || 0) - (caller.evil || 0)) / 220,
          0.15,
          1.0
        );
        const weightForTarget = targetId => {
          const target = prof[targetId];
          if (!target) return 0;
          const hasIndependentRiskEvidence = !!(
            target.knownEvil || target.confessed || target.conflicts.length > 0 ||
            target.pubFake >= 2
          );
          const hasStrongGoodEvidence = target.ally >= 70 && target.evil < 25 && !hasIndependentRiskEvidence;
          // 有獨立風險證據：全權重；有強好人證據：大幅降權；其他情況：保留但降低未經佐證的指控。
          const evidenceWeight = hasIndependentRiskEvidence ? 1.0 : (hasStrongGoodEvidence ? 0.30 : 0.60);
          return (0.4 + cf) * callerCredibility * evidenceWeight;
        };

        (sp.p?.accuse || []).forEach(a => {
          if (prof[a.playerId] && a.playerId !== bot.id) {
            const w = weightForTarget(a.playerId);
            const roleKey = `${a.playerId}|${a.role}`;
            const repeatedRoleAccusation = seenRoleAccusations.has(roleKey);
            seenRoleAccusations.add(roleKey);
            const correlationDiscount = repeatedRoleAccusation ? 0.28 : 1.0;
            bump(prof[a.playerId], {
              evil: (a.role === '老朝奉' ? 40 : 22) * w * correlationDiscount,
              roles: { [a.role]: 2.4 * w * correlationDiscount },
              why: `${sp.speakerName}點名他是【${a.role}】${repeatedRoleAccusation ? '（同輪重複指控，降權）' : ''}`,
              say: `${U.tag(U.byId(room, sp.playerId))}曾公開指稱${U.tag(prof[a.playerId].player)}是【${a.role}】`
            });
          }
        });
        const cs = sp.p?.callSuspectId;
        if (cs && cs !== bot.id && prof[cs]) {
          const priorCalls = seenPublicCallsByTarget.get(cs) || 0;
          const correlationDiscount = priorCalls === 0 ? 1.0 : priorCalls === 1 ? 0.35 : 0.16;
          seenPublicCallsByTarget.set(cs, priorCalls + 1);
          const w = weightForTarget(cs);
          bump(prof[cs], {
            evil: 50 * w * correlationDiscount,
            roles: { '老朝奉': 3 * w * correlationDiscount },
            why: `${sp.speakerName}號召全場集火他${priorCalls ? '（同輪重複集火，降權）' : ''}`,
            say: `${U.tag(U.byId(room, sp.playerId))}曾號召大家集火${U.tag(prof[cs].player)}`
          });
        }
      });
    }

    // 公開跳職也是一項可回頭驗證的承諾。只讀每位玩家自己的公開發言，不讀其他 Bot 的私密 mind。
    const roleClaimsByRole = new Map();
    const roleClaimsByPlayer = new Map();
    const seenRoleClaim = new Set();
    for (let rr = 0; rr <= t; rr++) {
      const rd = room.rounds[rr];
      (rd && rd.speeches || []).forEach(sp => {
        let role = sp && sp.p && sp.p.selfRole;
        if (!role && sp && GD.Claims && typeof GD.Claims.parse === 'function') {
          try { role = GD.Claims.parse(String(sp.text || ''), room, rd).selfRole; } catch (_) {}
        }
        const rec = sp && prof[sp.playerId];
        if (!role || !rec || sp.playerId === bot.id) return;
        const onceKey = `${sp.playerId}|${role}`;
        if (!seenRoleClaim.has(onceKey)) {
          seenRoleClaim.add(onceKey);
          bump(rec, {
            roles: { [role]: 0.9 },
            why: `第${rr + 1}輪公開自稱【${role}】，後續需要用能力時點、票型與其他人的對跳驗證`,
            say: null
          });
        }
        // 本 AI 對自己的真實角色與已知秘密同伴角色有確定資訊；他人宣稱相同唯一角色必是偽裝，但不直接等於壞人。
        const knownUniqueRole = role === bot.role || (ctx.partner && role === ctx.partner.role);
        if (knownUniqueRole) {
          bump(rec, {
            evil: 7,
            roles: { [role]: -0.8 },
            why: `公開自稱【${role}】與本視角已知的唯一角色身分衝突；可能是擋刀或欺騙，仍須看後續行動`,
            say: null
          });
        }
        // 「平民」是非唯一的偽裝標籤；可記錄身份改口，但不能當成唯一角色對跳。
        if (role !== '平民') {
          if (!roleClaimsByRole.has(role)) roleClaimsByRole.set(role, new Map());
          const claimers = roleClaimsByRole.get(role);
          if (!claimers.has(sp.playerId)) claimers.set(sp.playerId, { id: sp.playerId, role, firstRound: rr + 1 });
        }
        if (!roleClaimsByPlayer.has(sp.playerId)) roleClaimsByPlayer.set(sp.playerId, new Set());
        roleClaimsByPlayer.get(sp.playerId).add(role);
      });
    }
    roleClaimsByRole.forEach((claimers, role) => {
      const entries = [...claimers.values()];
      if (entries.length < 2) return;
      const tags = entries.map(item => U.tag(U.byId(room, item.id))).filter(Boolean);
      entries.forEach(item => {
        const rec = prof[item.id];
        if (!rec) return;
        bump(rec, {
          // 對跳能證明「這組說法有衝突」，但不能單憑衝突就把每個宣稱者都加上壞人分。
          // 各人的 evil 分數由可驗證能力時點、行為、票型與其他獨立證據決定；角色宣稱本身只降低該角色的相對可信度。
          roles: { [role]: -0.55 },
          why: `角色爭議：${tags.join('與')}都曾公開自稱唯一角色【${role}】，至少一個版本需要反查；不以對跳人數直接判定誰是壞人`,
          say: `公開紀錄中${tags.join('與')}都自稱【${role}】，角色唯一，但人數本身不能定罪；須再比技能時點、票型與獨立證據`
        });
      });
    });
    roleClaimsByPlayer.forEach((roles, pid) => {
      if (roles.size < 2 || !prof[pid]) return;
      const names = [...roles];
      bump(prof[pid], {
        evil: 12 + (names.length - 2) * 4,
        roles: Object.fromEntries(names.map(role => [role, -0.65])),
        why: `跨輪身份說法改變：曾自稱【${names.join('】與【')}】，需要檢查是否為刻意變換偽裝`,
        say: `${U.tag(prof[pid].player)}跨輪自稱【${names.join('】與【')}】，身份版本前後改變，需對照原始發言與技能紀錄`
      });
    });

    if (isGood) Object.values(prof).forEach(rec => {
      if (rec.pubFake >= 3) bump(rec, {
        evil: (rec.pubFake - 2) * 12, roles: { '老朝奉': 0.5 },
        why: `累計 ${rec.pubFake} 票投給後來公開判為贗品的獸`
      });
    });

    /* ★ 跨輪老朝奉候選池交集消去法 + 「場上只有 3 個壞人」總量重盤機制 */
    let laoIntersectIds = [];
    let eliminatedFromLaoIds = [];
    let reEvalNote = null;

    if (isGood && laoPools.length > 0) {
      laoPools.forEach(pool => {
        pool.ids.forEach(id => { if (prof[id]) prof[id].inLaoPoolCount++; });
      });
      if (laoPools.length >= 2) {
        let inter = [...new Set(laoPools[0].ids)];
        for (let idx = 1; idx < laoPools.length; idx++) {
          const nextSet = new Set(laoPools[idx].ids);
          const nextInter = inter.filter(id => nextSet.has(id));
          if (nextInter.length > 0) inter = nextInter;
        }
        laoIntersectIds = inter;
        const unionIds = [...new Set(laoPools.flatMap(p => p.ids))];
        eliminatedFromLaoIds = unionIds.filter(id => !laoIntersectIds.includes(id));

        laoIntersectIds.forEach(id => {
          if (prof[id]) bump(prof[id], {
            evil: 18, roles: { '老朝奉': 1.6 },
            why: `跨輪時序交集鎖定：同時出現在多輪老朝奉反轉區間內，嫌疑極高`,
            say: null
          });
        });
        eliminatedFromLaoIds.forEach(id => {
          if (prof[id]) bump(prof[id], {
            evil: -8, roles: { '老朝奉': -1.4 },
            why: `跨輪區間消去法：未同時出現在前輪老朝奉反轉區間內，排除老朝奉嫌疑`,
            say: null
          });
        });
      } else {
        laoIntersectIds = [...new Set(laoPools[0].ids)];
      }
    }

    if (isGood) {
      const highSus = Object.values(prof).filter(r => r.evil >= 25).sort((a, b) => b.evil - a.evil);
      if (highSus.length > 3) {
        const core3 = highSus.slice(0, 3);
        const pardoned = highSus.slice(3);
        const pardonedNames = pardoned.map(r => U.tag(r.player)).join('、');
        const coreNames = core3.map(r => U.tag(r.player)).join('、');
        pardoned.forEach(r => {
          r.evil = Math.max(10, r.evil * 0.65);
        });
        reEvalNote = `盤點全場發現可疑者超過 3 人，但壞人只有 3 個！考量好人可能遭反轉誤報或擋刀說假話、壞人也會順風報真話，我結合跨輪時序交集重盤排除${pardonedNames}，將核心壞人鎖定在${coreNames}`;
      }
    }

    ctx.laoPools = laoPools;
    ctx.laoIntersectIds = laoIntersectIds;
    ctx.eliminatedFromLaoIds = eliminatedFromLaoIds;
    ctx.reEvalNote = reEvalNote;

    Object.values(prof).forEach(rec => {
      const roles = GD.ROLE_ORDER.filter(x => x !== bot.role);
      const mx = Math.max(...roles.map(x => rec.logits[x] || 0));
      const ex = roles.map(x => Math.exp((rec.logits[x] || 0) - mx));
      const s = U.sum(ex);
      rec.probs = {};
      roles.forEach((x, i) => { rec.probs[x] = Math.round(ex[i] / s * 100); });
    });
    buildInformationSkill(ctx, prof);
    return prof;
  }

  function posterior(ctx, prof) {
    const { rd, pass, myPos, myIns, isGood, bot, names } = ctx;
    const NONE = 8;
    const ks = [NONE, 0, 1, 2, 3, 4, 5, 6, 7].filter(k => !(isGood && k === myPos));
    let prior = k => (k === NONE ? 0.22 : 0.78 / (ks.length - 1));
    if (bot.role === '老朝奉') {
      const used = ctx.log.skillTag === '🎭擾亂';
      prior = k => (used ? (k === myPos ? 1 : 0) : (k === NONE ? 1 : 0));
    }
    // 基礎信任固定在中性偏審慎的位置；skepticism 不再無差別壓低所有人的信任。
    // 多疑度的影響集中在 buildProfiles() 內對矛盾、票型異常等具體證據的加權。
    const base = 0.8;
    const parsedSpeechById = new Map((rd.speeches || []).map(sp => [String(sp.playerId), speechData(sp, ctx.room, rd)]));
    const trustOf = (pid, parsed) => {
      const r = prof[pid];
      const spPos = pass.indexOf(pid);
      const confessed = !!(parsed && parsed.selfEvil);
      const posFactor = confessed ? 0 : passPositionPrior(spPos);
      if (!r) return U.clamp(base * 0.9 + posFactor, 0.08, 0.95);
      if (confessed) return isGood ? 0.6 : 0.95;
      const skill = Number.isFinite(Number(r.infoSkill)) ? Number(r.infoSkill) : 50;
      // 過往可驗證資訊品質只調整「此人主張內容的可信度」，不改變其陣營機率或 evil/ally 分數。
      const informationCalibration = U.clamp((skill - 50) / 400, -0.12, 0.12);
      return U.clamp(base - r.evil / 130 + r.ally / 220 + posFactor + informationCalibration, 0.08, 0.95);
    };

    const pReal = names.map(() => 0), laoAt = Array(9).fill(0);
    let total = 0;
    CONFIGS.forEach(cfg => {
      const real = new Set(cfg);
      ks.forEach(k => {
        let w = prior(k); if (w <= 0) return;
        const myFlip = isGood && bot.role !== '姬雲浮' && k < myPos;
        myIns.forEach(i => {
          const idx = names.indexOf(i.beastName);
          w *= ((real.has(idx) !== myFlip) === i.displayedReal) ? 0.97 : 0.03;
        });
        rd.speeches.forEach(sp => {
          if (sp.playerId === bot.id) return;
          const a = pass.indexOf(sp.playerId);
          const parsed = parsedSpeechById.get(String(sp.playerId)) || {};
          const tr = trustOf(sp.playerId, parsed);
          const flipPos = parsed.selfEvil ? -1 : a;
          (Array.isArray(parsed.claims) ? parsed.claims : []).slice(0, 3).forEach(c => {
            const idx = names.indexOf(c.beast); if (idx < 0) return;
            const said = (real.has(idx) !== (k < flipPos)) === c.real;
            w *= tr * (said ? 0.9 : 0.1) + (1 - tr) * 0.5;
          });
        });
        cfg.forEach(i => { pReal[i] += w; });
        laoAt[k] += w; total += w;
      });
    });
    const post = names.map((n, i) => ({ name: n, pReal: total ? pReal[i] / total : 0.5 }));
    return { post, laoAt: laoAt.map(x => (total ? x / total : 0)), confident: post.some(b => Math.abs(b.pReal - 0.5) > 0.3) };
  }

  function analyze(bot, room) {
    const ctx = context(bot, room);
    const prof = buildProfiles(ctx);
    const pst = posterior(ctx, prof);

    if (ctx.isGood && pst.confident) {
      ctx.pass.forEach((pid, k) => {
        if (prof[pid] && pst.laoAt[k] > 0.12) {
          bump(prof[pid], {
            evil: pst.laoAt[k] * 40, roles: { '老朝奉': pst.laoAt[k] * 2 },
            why: `第${ctx.t + 1}輪世界線推演：${Math.round(pst.laoAt[k] * 100)}% 機率他在${U.nth(k)}啟動了擾亂`,
            say: null
          });
        }
      });
    }

    const list = Object.values(prof);
    const pool = list.filter(r => !(ctx.partner && r.player.id === ctx.partner.id) && !r.knownEvil);
    const byEvil = [...list].filter(r => ctx.isGood ? !r.confessed : r.ally < 90)
      .sort((a, b) => (b.evil + (b.probs['老朝奉'] || 0)) - (a.evil + (a.probs['老朝奉'] || 0)));
    const A = {
      ctx, prof, post: pst.post, laoAt: pst.laoAt, confident: pst.confident,
      topSuspect: byEvil[0] || null,
      byEvil,
      topAlly: [...pool].sort((a, b) => b.ally - a.ally)[0] || null,
      topXu: [...pool].sort((a, b) => ((b.probs['許願'] || 0) + b.ally * 0.5) - ((a.probs['許願'] || 0) + a.ally * 0.5))[0] || null,
      topFang: [...pool].sort((a, b) => ((b.probs['方震'] || 0) + b.ally * 0.4) - ((a.probs['方震'] || 0) + a.ally * 0.4))[0] || null,
      publicCall: findPublicCall(ctx, prof),
      fakeVoters: list.filter(r => r.pubFake >= 2 && !r.knownEvil && !(ctx.partner && r.player.id === ctx.partner.id))
        .sort((a, b) => b.pubFake - a.pubFake),
      myFake: pubFakeVotes(ctx.room, bot.id, ctx.t),
      askedMe: findAskedMe(ctx),
      laoPools: ctx.laoPools || [],
      laoIntersectIds: ctx.laoIntersectIds || [],
      eliminatedFromLaoIds: ctx.eliminatedFromLaoIds || [],
      reEvalNote: ctx.reEvalNote || null
    };
    return A;
  }

  function findAskedMe(ctx) {
    const hit = (ctx.rd.speeches || []).find(sp => sp.playerId !== ctx.bot.id && sp.p && (sp.p.asked || []).includes(ctx.bot.id));
    return hit ? { callerId: hit.playerId, callerName: hit.speakerName, round: ctx.t + 1 } : null;
  }

  function findPublicCall(ctx, prof) {
    let call = null;
    for (let r = 0; r <= ctx.t; r++) {
      (ctx.room.rounds[r].speeches || []).forEach(sp => {
        if (sp.playerId === ctx.bot.id) return;
        const caller = prof[sp.playerId];
        if (caller && caller.evil >= 55) return;
        const id = sp.p?.callSuspectId;
        if (id && id !== ctx.bot.id) call = { callerId: sp.playerId, callerName: sp.speakerName, targetId: id, round: r + 1 };
      });
    }
    return call;
  }

  GD.Mind = { analyze, context, posterior, buildProfiles, buildInformationSkill, pubFakeVotes, passPositionPrior, voteViewAdjustment, EVIL };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Mind;
})(typeof window !== 'undefined' ? window : global);