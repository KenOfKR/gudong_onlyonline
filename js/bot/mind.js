/* ============================================================================
 * bot/mind.js — PersuasiveMindEngine（說服型推理大腦・高階博弈強化版）
 *
 * 公平原則：電腦玩家只使用「真人也看得到」的資訊——自己的查驗、公開發言、開票結果、
 * 第二名公開真偽——絕不偷看獸首真偽或他人身分。
 *
 * 推理流程（analyze）：
 *   1) 歷史證據：方震查驗、被偷襲來源、跨輪票型 vs 第二名公開真偽（含 2真2假互補推導）、言行不一、被點名
 *   2) 世界線貝氏推斷：枚舉「老朝奉在第 f 棒啟動擾亂(含未啟動) × 本輪 6 種真偽配置」共 56 個世界，
 *      用自己的查驗與前手宣稱（依可信度加權）更新，得到每尊獸首為真的後驗機率
 *   3) 宣稱 vs 後驗：與高信心後驗相矛盾的宣稱者加嫌疑；擾亂區間內的玩家加老朝奉權重
 *   4) 基因調整：skepticism / conformity / assertiveness 影響各項權重
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Rules } = GD;
  const EVIL = ['老朝奉', '藥不然', '鄭國渠'];
  const CONFIGS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];   // 本輪哪兩尊為真

  /** 整理本次決策需要的上下文 */
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

  /* reasons = 完整推理依據（私下，終局覆盤用）；said = 可以公開說出口的理由（發言用）。
     涉及私密資訊的依據（方震的陣營查驗、同伴身分、只有我看到的獸首）一律傳 say:null，絕不進發言。 */
  const blank = p => ({ player: p, evil: 0, ally: 0, logits: {}, reasons: [], said: [], conflicts: [],
                        confessed: false,   // 好人視角：此人公開認壞（不是老朝奉就不用抓）
                        knownEvil: false,   // 壞人視角：此人公開認壞，確定是自己人，找許願 / 方震時要排除
                        pubFake: 0 });      // 累計投在「已公開為贗品」的第二名上的票數（公開資訊，可拿來質問）

  /** 某玩家截至第 t 輪，累計投在已公開贗品（每輪第二名）上的票數：[{round, beast, n}] */
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
    if (why) {
      rec.reasons.unshift(why);
      if (say !== null) rec.said.unshift(say === undefined ? why : say);
    }
  }

  /* ------------------------------------------------------------------------
   * 階段 1：歷史證據 → 每位玩家的嫌疑 / 友善分與角色 logits
   * ---------------------------------------------------------------------- */
  function buildProfiles(ctx) {
    const { bot, room, t, genes, isGood } = ctx;
    const sk = genes.skepticism, cf = genes.conformity;
    const prof = {};
    room.players.forEach(p => { if (p.id !== bot.id) prof[p.id] = blank(p); });
    if (ctx.partner && prof[ctx.partner.id]) {
      bump(prof[ctx.partner.id], { ally: 100, roles: { [ctx.partner.role]: 12 }, why: '我的秘密同伴', say: null });
    }

    for (let r = 0; r <= t; r++) {
      const rd = room.rounds[r], pass = rd.passOrder, R = `第${r + 1}輪`;
      const me = rd.turnLogs[bot.id] || { inspect: [] };
      const myPos = pass.indexOf(bot.id);
      const ins = (me.inspect || []).filter(i => typeof i.displayedReal === 'boolean');

      /* 位置學：第六位決定誰當第七位，等於決定誰當尾家（第八位）。外界常把「六控八」看成同隊。 */
      if (pass.length === 8 && isGood && (r < t || rd.voteResults)) {
        const p6 = pass[5], p8 = pass[7];
        const link = `${R}第六位把手機控成第八位尾家（六控八）`;
        [p6, p8].forEach(pid => prof[pid] && pid !== bot.id && bump(prof[pid], { evil: 6 + 4 * sk, roles: { '老朝奉': 0.25, '藥不然': 0.25 }, why: link }));
      }

      /* 方震：親手查驗的陣營是最硬的證據 */
      if (me.fangTargetId && prof[me.fangTargetId]) {
        const evil = me.fangCamp === 'evil';
        bump(prof[me.fangTargetId], evil
          ? { evil: 95, roles: { '老朝奉': 5, '藥不然': 5, '鄭國渠': 5 }, why: `${R}我以【方震】親手查驗確認他是老朝奉陣營`, say: null }
          : { ally: 90, roles: { '老朝奉': -6, '藥不然': -6, '鄭國渠': -6 }, why: `${R}我以【方震】親手查驗確認他是好人陣營`, say: null });
      }

      /* 被偷襲：偷襲者必定是在我之前就已行動的玩家（藥不然） */
      if (me.blind && myPos > 0) {
        const earlier = pass.slice(0, myPos);
        const weightBoost = earlier.length === 1 ? 85 : (38 / earlier.length);
        earlier.forEach(pid => prof[pid] && bump(prof[pid], {
          evil: weightBoost, roles: { '藥不然': earlier.length === 1 ? 8.0 : (2.2 / earlier.length * 2) },
          why: earlier.length === 1
            ? `${R}排在第一位傳手機給我，害我在第二位直接被偷襲，鐵定是【藥不然】`
            : `${R}我遭藥不然偷襲致盲，他排在我之前的行動者之列`,
          say: null          // 被偷襲預設不公開（許願、方震尤其不能說），只留在覆盤
        }));
      }

      /* ★ [強化 1] 壞人視角抓方震與許願：
         1. 自稱「驗不到」且非我方偷襲者 -> 可能是方震或困惑平民
         2. 因為方震常偽裝報真品，壞人需同時觀察「獸首僅跟風前手已報過的獸首（不開新獸首線），卻積極點名抓人/質問票型」的行為特徵！ */
      if (!isGood) {
        const mineAmb = me.ambushIds || [];
        const claimedBeastsSoFar = new Set();
        (rd.speeches || []).forEach(sp => {
          const rec = prof[sp.playerId];
          if (!rec || !sp.p) return;
          if ((sp.p.unsure || sp.p.blind) && !mineAmb.includes(sp.playerId)) {
            bump(rec, { roles: { '方震': 1.0, '黃煙煙': 0.4, '木戶加奈': 0.4 }, why: `${R}自稱驗不到`, say: null });
          }
          const myClaims = sp.p.claims || [];
          const isEchoOnly = myClaims.length > 0 && myClaims.every(c => claimedBeastsSoFar.has(c.beast));
          const isFirstClaimer = myClaims.length > 0 && myClaims.some(c => !claimedBeastsSoFar.has(c.beast));
          const isAggressiveHunter = (sp.p.accuse && sp.p.accuse.length > 0) || !!sp.p.callSuspectId || (sp.p.asked && sp.p.asked.length > 0);

          if (isEchoOnly && isAggressiveHunter) {
            bump(rec, { roles: { '方震': 1.35 }, why: `${R}獸首僅順風附和前手，卻積極點名抓人或質問，極具【方震】偽裝特徵`, say: null });
          } else if (isFirstClaimer && myPos > 0) {
            bump(rec, { roles: { '許願': 0.45, '姬雲浮': 0.35 }, why: `${R}主動首發開出新獸首真偽線`, say: null });
          }
          myClaims.forEach(c => claimedBeastsSoFar.add(c.beast));
        });
      }

      /* 壞人視角：有人公開認壞 = 多一個確定的自己人 */
      if (!isGood) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId];
        if (!rec || !sp.p || !sp.p.selfEvil) return;
        rec.knownEvil = true;
        bump(rec, { ally: 60, why: `${R}公開認壞，確定是自己人`, say: null });
      });

      /* 好人視角：他人宣稱 vs 我親眼所見（矛盾 = 說謊，或兩人之間有人啟動了擾亂）*/
      if (isGood) {
        ins.forEach(i => (rd.speeches || []).forEach(sp => {
          if (sp.playerId === bot.id || !prof[sp.playerId]) return;
          const a = pass.indexOf(sp.playerId);
          (sp.p?.claims || []).filter(c => c.beast === i.beastName).forEach(c => {
            if (c.real === i.displayedReal) {
              bump(prof[sp.playerId], { ally: 14, roles: { '許願': 0.4 } });
              return;
            }
            const lo = Math.min(a, myPos), hi = Math.max(a, myPos);
            const between = pass.slice(lo, hi + 1).filter(x => x !== bot.id);
            bump(prof[sp.playerId], {
              evil: 25 * (0.55 + sk), roles: { '老朝奉': 1.4 * (0.6 + sk) },
              why: `${R}在${U.nth(a)}宣稱【${c.beast}】${c.real ? '真' : '假'}，與我${U.nth(myPos)}看到的${i.displayedReal ? '真品' : '贗品'}相反`
            });
            between.forEach(pid => pid !== sp.playerId && prof[pid] && bump(prof[pid], {
              evil: 11 * (0.5 + sk), roles: { '老朝奉': 1.1 / Math.sqrt(between.length) },
              why: `${R}位於【${c.beast}】真偽矛盾的傳遞區間內`
            }));
            prof[sp.playerId].conflicts.push({
              round: r + 1, beast: c.beast, speakerId: sp.playerId, speakerPos: a, claim: c.real,
              myPos, saw: i.displayedReal, between: between.map(x => x)
            });
          });
        }));
      }

      /* ★ [強化 2] 開票後：已知真偽（第二名公開 + 我自己的查驗 + 2真2假互補定律）vs 每個人的發言與選票 */
      if (rd.voteResults) {
        const known = {};
        const r2 = rd.voteResults.rank2;
        known[r2.name] = { real: r2.isReal, w: 1, pub: true };          // 第二名公開，全場都知道
        const mySightWeight = (bot.role === '姬雲浮' || !isGood || myPos === 0) ? 0.96 : 0.68;
        ins.forEach(i => {
          if (!known[i.beastName]) known[i.beastName] = { real: i.displayedReal, w: mySightWeight, pub: false };
        });
        /* 壞人視角：認壞的隊友攤開了自己真實的查驗 */
        if (!isGood) (rd.speeches || []).forEach(sp => {
          if (sp.playerId === bot.id || !sp.p || !sp.p.selfEvil) return;
          (sp.p.claims || []).forEach(c => { if (!known[c.beast]) known[c.beast] = { real: c.real, w: 0.9, pub: false }; });
        });

        /* ★ 2真2假數學互補閉包推導：每輪 4 尊獸首必為 2 真 2 假！
           若已掌握 2 尊高信心真品，剩餘 2 尊必為贗品；若已掌握 2 尊高信心贗品，剩餘 2 尊必為真品！ */
        const highConf = Object.entries(known).filter(([, v]) => v.w >= 0.85);
        const confReals = highConf.filter(([, v]) => v.real === true);
        const confFakes = highConf.filter(([, v]) => v.real === false);
        if (confReals.length >= 2) {
          rd.beasts.forEach(b => {
            if (!known[b.name]) known[b.name] = { real: false, w: 0.88, pub: false, deduced: true };
          });
        } else if (confFakes.length >= 2) {
          rd.beasts.forEach(b => {
            if (!known[b.name]) known[b.name] = { real: true, w: 0.88, pub: false, deduced: true };
          });
        }

        Object.entries(rd.votes || {}).forEach(([vid, ballot]) => {
          const rec = prof[vid]; if (!rec) return;
          Object.entries(ballot).forEach(([name, cnt]) => {
            const k = known[name]; if (!k || cnt <= 0) return;
            if (!k.real && k.pub) rec.pubFake += cnt;
            if (!k.real) {
              bump(rec, {
                evil: cnt * 18 * k.w * (0.6 + sk * 0.8),
                roles: { '老朝奉': 0.8 * cnt * k.w },
                why: `${R}把 ${cnt} 票投給${k.pub ? '已公開' : (k.deduced ? '由2真2假反推確認' : '我查驗確認')}的贗品【${name}】`,
                say: k.pub ? undefined : null
              });
            } else {
              bump(rec, { ally: cnt * 14 * k.w, roles: { '許願': 0.65 * cnt * k.w } });
            }
          });
        });

        /* 開票後回頭檢驗當輪誰把「已公開為贗品的第二名 r2」吹成真品（公開打臉鐵證） */
        if (isGood && !r2.isReal) {
          (rd.speeches || []).forEach(sp => {
            const rec = prof[sp.playerId]; if (!rec) return;
            const liedReal = (sp.p?.claims || []).some(c => c.beast === r2.name && c.real === true);
            if (liedReal) {
              const sPos = pass.indexOf(sp.playerId);
              bump(rec, {
                evil: 20 * (0.6 + sk * 0.6),
                roles: { '老朝奉': 1.1, '藥不然': 0.7, '鄭國渠': 0.7 },
                why: `${R}在${U.nth(sPos)}宣稱【${r2.name}】是真品，開票卻當場翻出【${r2.name}】是贗品`
              });
            }
          });
        }
      }

      /* 公開認壞：說話的人一定是壞人 */
      if (isGood) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId];
        if (!rec || !sp.p || !sp.p.selfEvil) return;
        rec.confessed = true;
        bump(rec, { evil: 10, roles: { '老朝奉': 0.2, '藥不然': 1.1, '鄭國渠': 1.1, '許願': -6, '方震': -6, '姬雲浮': -6, '黃煙煙': -6, '木戶加奈': -6 },
                    why: `${R}自己公開認壞` });
      });

      /* 被點名請說明票型，本人隨後發言卻沒有回應 = 閃躲 */
      if (isGood) (rd.speeches || []).forEach((sp, i) => (sp.p?.asked || []).forEach(aid => {
        const rec = prof[aid]; if (!rec) return;
        const reply = (rd.speeches || []).slice(i + 1).find(x => x.playerId === aid);
        if (reply && !/(說明|解釋|交代|被騙|看走眼|認壞|依據|因為)/.test(reply.text)) {
          bump(rec, { evil: 22, roles: { '老朝奉': 0.8 }, why: `${R}被【${sp.speakerName}】點名請說明票型，發言時卻閃躲沒有回應` });
        }
      }));

      /* 言行不一：喊投某獸首，開票卻沒投 */
      if (rd.voteResults) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId]; const cb = sp.p?.callBeast; if (!rec || !cb) return;
        const ballot = rd.votes[sp.playerId] || {};
        if (U.sum(Object.values(ballot)) > 0 && !(ballot[cb] > 0)) {
          bump(rec, { evil: 24 * (0.5 + sk), roles: { '老朝奉': 1.2 }, why: `${R}口頭號召投【${cb}】，開票卻沒投（言行不一）` });
        }
      });

      /* 他人的指認與集火號召：依「發言者本身可信度」與我的從眾度加權 */
      (rd.speeches || []).forEach(sp => {
        if (sp.playerId === bot.id || !prof[sp.playerId]) return;
        const callerEvil = prof[sp.playerId].evil;
        const human = sp.source === 'human';
        const w = (human ? 1 : 0.45) * (0.4 + cf) * Math.max(0.1, 1 - callerEvil / 90);
        (sp.p?.accuse || []).forEach(a => {
          if (prof[a.playerId] && a.playerId !== bot.id) bump(prof[a.playerId], {
            evil: (a.role === '老朝奉' ? 40 : 22) * w, roles: { [a.role]: 2.4 * w },
            why: `【${sp.speakerName}】點名他是【${a.role}】`
          });
        });
        const cs = sp.p?.callSuspectId;
        if (cs && cs !== bot.id && prof[cs]) bump(prof[cs], { evil: 50 * w, roles: { '老朝奉': 3 * w }, why: `【${sp.speakerName}】號召全場集火他` });
      });
    }

    /* 票型採人：累計 3 票以上投在「已公開為贗品」的第二名上 */
    if (isGood) Object.values(prof).forEach(rec => {
      if (rec.pubFake >= 3) bump(rec, { evil: (rec.pubFake - 2) * 12, roles: { '老朝奉': 0.5 },
        why: `累計 ${rec.pubFake} 票投在已公開的贗品上` });
    });

    /* logits → 機率（百分比），自己的角色排除 */
    Object.values(prof).forEach(rec => {
      const roles = GD.ROLE_ORDER.filter(x => x !== bot.role);
      const mx = Math.max(...roles.map(x => rec.logits[x] || 0));
      const ex = roles.map(x => Math.exp((rec.logits[x] || 0) - mx));
      const s = U.sum(ex);
      rec.probs = {};
      roles.forEach((x, i) => { rec.probs[x] = Math.round(ex[i] / s * 100); });
    });
    return prof;
  }

  /* ------------------------------------------------------------------------
   * 階段 2：本輪「世界線」貝氏後驗
   * ---------------------------------------------------------------------- */
  function posterior(ctx, prof) {
    const { rd, pass, myPos, myIns, isGood, bot, names } = ctx;
    const NONE = 8;
    const ks = [NONE, 0, 1, 2, 3, 4, 5, 6, 7].filter(k => !(isGood && k === myPos));
    let prior = k => (k === NONE ? 0.4 : 0.6 / (ks.length - 1));
    if (bot.role === '老朝奉') {                            // 我就是老朝奉：我自己知道有沒有擾亂
      const used = ctx.log.skillTag === '🎭擾亂';
      prior = k => (used ? (k === myPos ? 1 : 0) : (k === NONE ? 1 : 0));
    }
    const base = 0.93 - 0.5 * ctx.genes.skepticism;
    const trustOf = (pid, sp) => {
      const r = prof[pid]; if (!r) return base * 0.9;
      if (sp && sp.p && sp.p.selfEvil) return isGood ? 0.6 : 0.95;
      return U.clamp(base - r.evil / 130 + r.ally / 220, 0.08, 0.95);
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
          const a = pass.indexOf(sp.playerId), tr = trustOf(sp.playerId, sp);
          const flipPos = sp.p && sp.p.selfEvil ? -1 : a;
          (sp.p?.claims || []).slice(0, 3).forEach(c => {
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

  /* ------------------------------------------------------------------------
   * 階段 3：整合，產生決策需要的排名
   * ---------------------------------------------------------------------- */
  function analyze(bot, room) {
    const ctx = context(bot, room);
    const prof = buildProfiles(ctx);
    const pst = posterior(ctx, prof);

    /* 世界線反推：後驗認為「老朝奉在第 k 棒擾亂」→ 該棒玩家加老朝奉權重 */
    if (ctx.isGood && pst.confident) {
      ctx.pass.forEach((pid, k) => {
        if (prof[pid] && pst.laoAt[k] > 0.12) {
          bump(prof[pid], { evil: pst.laoAt[k] * 40, roles: { '老朝奉': pst.laoAt[k] * 2 },
            why: `第${ctx.t + 1}輪世界線推演：${Math.round(pst.laoAt[k] * 100)}% 機率他在${U.nth(k)}啟動了擾亂`,
            say: `他在${U.nth(k)}的位置，時序上最像開了擾亂的人` });
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
      humanCall: findHumanCall(ctx, prof),
      fakeVoters: list.filter(r => r.pubFake >= 2 && !r.knownEvil && !(ctx.partner && r.player.id === ctx.partner.id))
        .sort((a, b) => b.pubFake - a.pubFake),
      myFake: pubFakeVotes(ctx.room, bot.id, ctx.t),
      askedMe: findAskedMe(ctx)
    };
    return A;
  }

  function findAskedMe(ctx) {
    const hit = (ctx.rd.speeches || []).find(sp => sp.playerId !== ctx.bot.id && sp.p && (sp.p.asked || []).includes(ctx.bot.id));
    return hit ? { callerId: hit.playerId, callerName: hit.speakerName, round: ctx.t + 1 } : null;
  }

  function findHumanCall(ctx, prof) {
    let call = null;
    for (let r = 0; r <= ctx.t; r++) {
      (ctx.room.rounds[r].speeches || []).forEach(sp => {
        if (sp.source !== 'human' || sp.playerId === ctx.bot.id) return;
        const caller = prof[sp.playerId];
        if (caller && caller.evil >= 55) return;
        const id = sp.p?.callSuspectId;
        if (id && id !== ctx.bot.id) call = { callerId: sp.playerId, callerName: sp.speakerName, targetId: id, round: r + 1 };
      });
    }
    return call;
  }

  GD.Mind = { analyze, context, posterior, buildProfiles, pubFakeVotes, EVIL };
})(window.GD);