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
    confessed: false, knownEvil: false, pubFake: 0, inLaoPoolCount: 0
  });

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
      }

      if (!isGood) {
        const mineAmb = me.ambushIds || [];
        const claimedBeastsSoFar = new Set();
        (rd.speeches || []).forEach(sp => {
          const rec = prof[sp.playerId];
          if (!rec || !sp.p) return;
          const rawTxt = String(sp.text || '');
          if ((sp.p.campChecks && sp.p.campChecks.length) || /查驗.*陣營|不談獸首.*查驗/.test(rawTxt)) {
            bump(rec, { roles: { '方震': 2.6 }, why: `${R}公開宣稱查驗玩家陣營、不報獸首，極像【方震】`, say: null });
          }
          if ((sp.p.unsure || sp.p.blind) && !mineAmb.includes(sp.playerId)) {
            bump(rec, { roles: { '方震': 1.0, '黃煙煙': 0.4, '木戶加奈': 0.4 }, why: `${R}自稱驗不到`, say: null });
          }
          const myClaims = sp.p.claims || [];
          const isEchoOnly = myClaims.length > 0 && myClaims.every(c => claimedBeastsSoFar.has(c.beast));
          const isFirstClaimer = myClaims.length > 0 && myClaims.some(c => !claimedBeastsSoFar.has(c.beast));
          const isAggressiveHunter = (sp.p.accuse && sp.p.accuse.length > 0) || !!sp.p.callSuspectId || (sp.p.asked && sp.p.asked.length > 0);

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
        if (!rec || !sp.p || !sp.p.selfEvil) return;
        rec.knownEvil = true;
        bump(rec, { ally: 60, why: `${R}公開認壞，確定是自己人`, say: null });
      });

      /* ★ 好人查驗矛盾分析：緊鄰順位零距離直踩 ＆ 首家不反轉鐵律 */
      if (isGood) {
        ins.forEach(i => (rd.speeches || []).forEach(sp => {
          if (sp.playerId === bot.id || !prof[sp.playerId]) return;
          const a = pass.indexOf(sp.playerId);
          if (a < 0 || myPos < 0) return;
          (sp.p?.claims || []).filter(c => c.beast === i.beastName).forEach(c => {
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
        known[r2.name] = { real: r2.isReal, w: 1, pub: true };

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
          if (!known[i.beastName]) known[i.beastName] = { real: i.displayedReal, w: posReliability, pub: false };
        });
        if (!isGood) (rd.speeches || []).forEach(sp => {
          if (sp.playerId === bot.id || !sp.p || !sp.p.selfEvil) return;
          (sp.p.claims || []).forEach(c => { if (!known[c.beast]) known[c.beast] = { real: c.real, w: 0.9, pub: false }; });
        });

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

        const r1SuspectWeight = (isGood && r2.isReal && r1 && r1.votes >= 8 && !known[r1.name]) ? 0.35 : 0;

        Object.entries(rd.votes || {}).forEach(([vid, ballot]) => {
          const rec = prof[vid]; if (!rec) return;
          Object.entries(ballot).forEach(([name, cnt]) => {
            if (cnt <= 0) return;
            const k = known[name];
            if (k) {
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
            } else if (r1SuspectWeight > 0 && name === r1.name) {
              bump(rec, {
                evil: cnt * 10 * r1SuspectWeight * (0.5 + sk * 0.5),
                roles: { '老朝奉': 0.3 * cnt, '鄭國渠': 0.3 * cnt },
                why: `${R}第二名【${r2.name}】公開為真品，他卻把 ${cnt} 票灌在高票第一名【${r1.name}】（${r1.votes}票）上`,
                say: `${R}把 ${cnt} 票灌在高票封存的【${r1.name}】上壓過真品【${r2.name}】`
              });
            }
          });
        });

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

      if (isGood) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId];
        if (!rec || !sp.p || !sp.p.selfEvil) return;
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

    if (isGood) Object.values(prof).forEach(rec => {
      if (rec.pubFake >= 3) bump(rec, {
        evil: (rec.pubFake - 2) * 12, roles: { '老朝奉': 0.5 },
        why: `累計 ${rec.pubFake} 票投在已公開的贗品上`
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
            say: `跨輪時序交集都在老朝奉反轉區間內`
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
    const base = 0.93 - 0.5 * ctx.genes.skepticism;
    const trustOf = (pid, sp) => {
      const r = prof[pid];
      const spPos = Math.max(0, pass.indexOf(pid));
      const posFactor = (sp && sp.p && sp.p.selfEvil) ? 0 : (0.08 - spPos * 0.04);
      if (!r) return U.clamp(base * 0.9 + posFactor, 0.08, 0.95);
      if (sp && sp.p && sp.p.selfEvil) return isGood ? 0.6 : 0.95;
      return U.clamp(base - r.evil / 130 + r.ally / 220 + posFactor, 0.08, 0.95);
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
            say: `他在${U.nth(k)}的位置，時序上最像開了擾亂的人`
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
      humanCall: findHumanCall(ctx, prof),
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
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Mind;
})(typeof window !== 'undefined' ? window : global);