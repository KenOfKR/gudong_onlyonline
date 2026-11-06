/* ============================================================================
 * bot/mind.js — PersuasiveMindEngine（說服型推理大腦・時序交集與3壞人重盤強化版）
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U, Rules } = GD;
  const EVIL = ['老朝奉', '藥不然', '鄭國渠'];
  const CONFIGS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

  // 決策期只允許讀取玩家當時真正看見的畫面。flipped 是引擎事後稽核標記。
  function observedTruth(ins) {
    if (!ins || typeof ins.displayedReal !== 'boolean') return null;
    return ins.displayedReal;
  }

  // 僅供結算後覆盤／診斷使用，不得餵給局中策略、發言或投票模型。
  function auditTruth(ins) {
    if (!ins || typeof ins.displayedReal !== 'boolean') return null;
    return ins.flipped === true ? !ins.displayedReal : ins.displayedReal;
  }

  // 相容舊呼叫點，但語意是「玩家所見」，不是客觀真相。
  const inspectionTruth = observedTruth;

  function sanitizeInspection(ins) {
    if (!ins || typeof ins.displayedReal !== 'boolean') return null;
    return { beastName: ins.beastName, displayedReal: ins.displayedReal, resultText: ins.resultText || '', kind: ins.kind || 'ok' };
  }

  function context(bot, room) {
    const t = room.currentRoundIdx, rd = room.rounds[t];
    const pass = rd.passOrder;
    const rawLog = rd.turnLogs[bot.id] || { inspect: [] };
    const log = { ...rawLog, inspect: (rawLog.inspect || []).map(sanitizeInspection).filter(Boolean) };
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
    commitments: [], voteDissonance: [], claimEvidence: [], uncertaintyReports: [], laoTimingSupport: 0, laoTimingRounds: 0,
    confessed: false, knownEvil: false, knownGood: false, knownCamp: null, campEvidence: [], pEvil: null, pGood: null, pLao: null, pZheng: null, isPartner: false, partnerEvidence: [], flipWindowSupport: 0, flipWindowReports: [], pubFake: 0, inLaoPoolCount: 0
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

  // Public speaking order and pass/skill order are separate timelines.
  // The former is used only to order dialogue; the latter is the only source for skill timing.
  function orderedSpeechRows(rd) {
    const speeches = Array.isArray(rd && rd.speeches) ? rd.speeches : [];
    const speechOrder = Array.isArray(rd && rd.speechOrder) ? rd.speechOrder : [];
    const speechIndex = new Map(speechOrder.map((id, index) => [String(id), index]));
    const passOrder = Array.isArray(rd && rd.passOrder) ? rd.passOrder : [];
    return speeches.map((sp, index) => ({
      sp,
      speechIndex: speechIndex.has(String(sp && sp.playerId)) ? speechIndex.get(String(sp.playerId)) : index,
      passIndex: passOrder.findIndex(id => String(id) === String(sp && sp.playerId))
    })).sort((a, b) => a.speechIndex - b.speechIndex || a.passIndex - b.passIndex);
  }

  // This is a source label for a PUBLIC CLAIM, not proof of an actual private inspection.
  // A player's "I checked it" remains a self-report until independently cross-checked.
  function classifyPublicClaim(sp, parsed, repeatedSameVerdict) {
    const text = String(sp && sp.text || '');
    if (parsed && (parsed.blind || parsed.unsure)) return { type: 'limited-view', weight: 0.18, selfReportedDirect: false };
    if (/(?:我|本人|自己).{0,12}(?:查驗|查過|查了|檢查|驗過|親眼|看到|看見)|(?:我的|本人)查驗(?:結果)?|我看到|我親眼看到/.test(text)) {
      return { type: 'self-reported-direct', weight: 0.66, selfReportedDirect: true };
    }
    if (/(?:我的畫面|我在第[一二三四五六七八12345678]位|票型顯示|傳牌時序|我自己的紀錄|我親自看到|我這邊的紀錄)/.test(text)) {
      return { type: 'independent-inference', weight: 0.38, selfReportedDirect: false };
    }
    if (/(?:推測|推論|後驗|機率|估計|猜測|我認為|我判斷|看起來|依前手|按前手|綜合.*判斷|我傾向)/.test(text)) {
      return { type: 'inference', weight: 0.30, selfReportedDirect: false };
    }
    if (/(?:同意|附和|跟著|前面.{0,8}說|剛才.{0,8}說|我也認為|我也覺得|大家都說|順著大家)/.test(text) || repeatedSameVerdict) {
      return { type: 'echo', weight: 0.14, selfReportedDirect: false };
    }
    return { type: 'unattributed-assertion', weight: 0.24, selfReportedDirect: false };
  }

  function collectPublicClaimEvidence(ctx, prof) {
    const all = [], current = [], currentGroups = new Map();
    for (let r = 0; r <= ctx.t; r++) {
      const rd = ctx.room.rounds[r];
      if (!rd) continue;
      const seen = new Map();
      orderedSpeechRows(rd).forEach(({ sp, speechIndex, passIndex }) => {
        if (!sp || !sp.playerId) return;
        const parsed = speechData(sp, ctx.room, rd);
        (Array.isArray(parsed.claims) ? parsed.claims : []).slice(0, 4).forEach(claim => {
          if (!claim || !claim.beast || typeof claim.real !== 'boolean') return;
          const key = `${claim.beast}|${claim.real}`;
          const repeatedSameVerdict = (seen.get(key) || 0) > 0;
          const selfContradictory = (parsed.selfContradictions || []).some(item => item && item.beast === claim.beast);
          const source = selfContradictory
            ? { type: 'self-contradictory', weight: 0.04, selfReportedDirect: false }
            : classifyPublicClaim(sp, parsed, repeatedSameVerdict);
          const entry = {
            round: r + 1, playerId: sp.playerId, beast: claim.beast, real: claim.real,
            speechIndex, passIndex, type: source.type, weight: source.weight,
            selfReportedDirect: source.selfReportedDirect,
            // Keep the text for post-game diagnostics only; callers must not treat it as verified fact.
            text: String(sp.text || '')
          };
          all.push(entry);
          if (r === ctx.t) {
            current.push(entry);
            const groupKey = key;
            if (!currentGroups.has(groupKey)) currentGroups.set(groupKey, {
              beast: claim.beast, real: claim.real, speakers: new Set(),
              selfReportedDirect: 0, inference: 0, echo: 0, unattributed: 0, limitedView: 0, selfContradictory: 0,
              entries: []
            });
            const group = currentGroups.get(groupKey);
            group.speakers.add(String(sp.playerId));
            if (source.type === 'self-reported-direct') group.selfReportedDirect++;
            else if (source.type === 'inference' || source.type === 'independent-inference') group.inference++;
            else if (source.type === 'echo') group.echo++;
            else if (source.type === 'limited-view') group.limitedView++;
            else if (source.type === 'self-contradictory') group.selfContradictory++;
            else group.unattributed++;
            group.entries.push(entry);
          }
          if (prof && prof[sp.playerId]) prof[sp.playerId].claimEvidence.push(entry);
          seen.set(key, (seen.get(key) || 0) + 1);
        });
      });
    }
    const groups = [...currentGroups.values()].map(group => ({
      ...group, speakerCount: group.speakers.size, speakers: [...group.speakers]
    })).sort((a, b) => b.speakerCount - a.speakerCount);
    // A chorus is a reason to decompose sources, not an automatic reason to reject the verdict.
    const alerts = groups.filter(group => group.speakerCount >= 2); // 兩名先行玩家形成同向時就先拆來源；不自動降權獨立查驗。
    return { all, current, groups, alerts };
  }

  function collectPublicCountConstraints(ctx) {
    const groups = new Map();
    for (let r = 0; r <= ctx.t; r++) {
      const rd = ctx.room.rounds[r];
      if (!rd) continue;
      (rd.speeches || []).forEach(sp => {
        const parsed = speechData(sp, ctx.room, rd);
        (parsed.countConstraints || []).forEach(item => {
          const population = (item.populationIds || []).map(String).sort();
          const key = [r + 1, item.scope, item.populationSize, item.min, item.max, population.join(',')].join('|');
          let group = groups.get(key);
          if (!group) {
            group = { ...item, round: r + 1, speakerIds: [], speakerCount: 0,
              // 這是對整個電腦玩家子群的數量約束，不對任何單一座位直接定罪。
              attribution: 'speaker-hypothesis', evidenceWeight: 0.12 };
            groups.set(key, group);
          }
          if (sp.playerId && !group.speakerIds.includes(sp.playerId)) group.speakerIds.push(sp.playerId);
        });
      });
    }
    const out = [...groups.values()];
    out.forEach(group => {
      group.speakerCount = group.speakerIds.length;
      // Repeaters add only a small amount of corroboration; the constraint stays group-level and weak.
      group.evidenceWeight = Math.min(0.18, 0.12 + Math.max(0, group.speakerCount - 1) * 0.02);
    });
    return out;
  }

  function buildLaoTimeline(ctx, pst, prof) {
    const rounds = [], byPlayer = new Map();
    for (let r = 0; r <= ctx.t; r++) {
      const rd = ctx.room.rounds[r];
      if (!rd || !Array.isArray(rd.passOrder)) continue;
      const ownMind = rd.mind && rd.mind[ctx.bot.id];
      const isCurrent = r === ctx.t;
      const arr = isCurrent ? pst.laoAt : (ownMind && Array.isArray(ownMind.laoAt) ? ownMind.laoAt : null);
      if (!Array.isArray(arr) || arr.length < 9) continue;
      const noSkillProbability = U.clamp(Number(arr[8]) || 0, 0, 1);
      const speechOrder = Array.isArray(rd.speechOrder) ? rd.speechOrder : [];
      const candidates = rd.passOrder.map((pid, passIndex) => {
        const probability = U.clamp(Number(arr[passIndex]) || 0, 0, 1);
        const speechIndex = speechOrder.findIndex(id => String(id) === String(pid));
        if (!byPlayer.has(String(pid))) byPlayer.set(String(pid), []);
        byPlayer.get(String(pid)).push({ round: r + 1, passIndex, speechIndex, probability });
        if (prof && prof[pid]) {
          prof[pid].laoTimingSupport = Math.max(Number(prof[pid].laoTimingSupport) || 0, probability);
          prof[pid].laoTimingRounds = (Number(prof[pid].laoTimingRounds) || 0) + (probability >= 0.10 ? 1 : 0);
        }
        return { playerId: pid, passIndex, speechIndex, probability };
      });
      rounds.push({ round: r + 1, noSkillProbability, activationProbability: 1 - noSkillProbability, candidates });
    }
    const current = rounds.find(item => item.round === ctx.t + 1) || null;
    const candidates = current ? current.candidates.slice().sort((a, b) => b.probability - a.probability) : [];
    return {
      rounds, current,
      noSkillProbability: current ? current.noSkillProbability : null,
      activationProbability: current ? current.activationProbability : null,
      candidates,
      // Cross-round max support is a prioritization heuristic, not a calibrated joint posterior.
      byPlayer: Object.fromEntries([...byPlayer.entries()].map(([id, signals]) => [id, {
        maxPositionSupport: Math.max(0, ...signals.map(signal => signal.probability)),
        rounds: signals
      }]))
    };
  }

  function blindCandidateWindows(room, botId, me, currentPass, currentPos) {
    const timing = me && me.blindTiming;
    const sourceRoundNo = Number(me && me.blindSourceRound) || 0;
    if (timing === 'immediate') {
      return [{ ids: currentPass.slice(0, Math.max(0, currentPos)).filter(id => id !== botId), timing: 'immediate', weight: 1 }];
    }
    if (timing === 'deferred' && sourceRoundNo > 0) {
      const source = room.rounds[sourceRoundNo - 1];
      const pass = source && source.passOrder || [];
      const targetPos = pass.indexOf(botId);
      const ids = targetPos >= 0 ? pass.slice(targetPos + 1).filter(id => id !== botId) : [];
      if (ids.length) return [{ ids: [...new Set(ids)], timing: 'deferred', sourceRound: sourceRoundNo, weight: 1 }];
    }
    // Old saves have no timing metadata: preserve both plausible windows with weak evidence.
    const windows = [];
    const immediate = currentPass.slice(0, Math.max(0, currentPos)).filter(id => id !== botId);
    if (immediate.length) windows.push({ ids: [...new Set(immediate)], timing: 'legacy-immediate', weight: 0.38 });
    const previous = room.rounds[Math.max(0, (room.currentRoundIdx || 0) - 1)];
    const priorPass = previous && previous.passOrder || [];
    const priorPos = priorPass.indexOf(botId);
    const deferred = priorPos >= 0 ? priorPass.slice(priorPos + 1).filter(id => id !== botId) : [];
    if (deferred.length) windows.push({ ids: [...new Set(deferred)], timing: 'legacy-deferred', weight: 0.38 });
    return windows;
  }

  function playerById(room, id) {
    if (!room || !id) return null;
    const players = Array.isArray(room.players) ? room.players : [];
    return players.find(player => player && player.id === id) ||
      (U && typeof U.byId === 'function' ? U.byId(room, id) : null);
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
      prof[ctx.partner.id].knownCamp = 'evil';
      prof[ctx.partner.id].knownEvil = true;
      prof[ctx.partner.id].pEvil = 1;
      prof[ctx.partner.id].pGood = 0;
      bump(prof[ctx.partner.id], { ally: 100, roles: { [ctx.partner.role]: 12 }, why: '我的秘密同伴（已知同屬壞人陣營）', say: null });
    }

    const laoPools = [];
    const publicCandidateGroups = [];
    const publicReportedFlipPools = [];
    const seenCandidateGroups = new Set();
    const seenPublicFlipReports = new Set();

    for (let r = 0; r <= t; r++) {
      const rd = room.rounds[r], pass = rd.passOrder, R = `第${r + 1}輪`;
      const me = rd.turnLogs[bot.id] || { inspect: [] };
      const myPos = pass.indexOf(bot.id);
      const ins = (me.inspect || []).map(sanitizeInspection).filter(Boolean);


      if (pass.length === 8 && isGood && (r < t || rd.voteResults)) {
        const p6 = pass[5], p8 = pass[7];
        const link = `${R}第六位把手機控成第八位尾家（六控八）`;
        [p6, p8].forEach(pid => prof[pid] && pid !== bot.id && bump(prof[pid], { evil: 6 + 4 * sk, roles: { '老朝奉': 0.25, '藥不然': 0.25 }, why: link }));
      }

      if (me.fangTargetId && prof[me.fangTargetId] && (me.fangCamp === 'evil' || me.fangCamp === 'good')) {
        const target = prof[me.fangTargetId];
        const camp = me.fangCamp;
        target.knownCamp = camp;
        target.knownGood = camp === 'good';
        target.knownEvil = camp === 'evil';
        target.campEvidence.push({ round: r + 1, source: 'fang-direct-camp-check', camp });
        bump(target, camp === 'evil'
          ? { evil: 95, roles: { '老朝奉': 2.0, '藥不然': 2.0, '鄭國渠': 2.0 }, why: `${R}方震直接查驗確認${U.tag(target.player)}屬於壞人陣營；只能確定陣營，仍須區分三種壞人角色`, say: null }
          : { ally: 95, roles: { '老朝奉': -20, '藥不然': -20, '鄭國渠': -20 }, why: `${R}方震直接查驗確認${U.tag(target.player)}屬於好人陣營；此人不得再列入壞人或老朝奉候選`, say: null });
      }

      if (me.blind && myPos >= 0) {
        const windows = blindCandidateWindows(room, bot.id, me, pass, myPos);
        windows.forEach(window => {
          const candidates = window.ids || [];
          if (!candidates.length) return;
          const factor = Number(window.weight) || 1;
          candidates.forEach(pid => prof[pid] && bump(prof[pid], {
            evil: factor * (candidates.length === 1 ? 85 : 38 / candidates.length),
            roles: { '藥不然': factor * (candidates.length === 1 ? 8.0 : 4.4 / candidates.length) },
            why: window.timing === 'deferred'
              ? `${R}這次失明是前一輪延遲生效；${U.nth((room.rounds[window.sourceRound - 1].passOrder || []).indexOf(bot.id) + 1)}之後行動者位於可能的偷襲窗口`
              : window.timing === 'immediate'
                ? `${R}這次即時偷襲只能由本輪我行動前的玩家造成`
                : `${R}舊存檔缺少偷襲時序，保留較低權重的即時／延遲雙窗口假設`,
            say: null
          }));
        });
        const earlier = windows.length ? windows[0].ids : [];
        // 第三位被盲時，前兩位容易被套入「第一位像藥不然、第二位像老朝奉」的角色配對。
        // 只作弱先驗，不當作公開事實；此弱偏置也讓壞人有機會利用角色互換栽贓。
        if (isGood && me.blindTiming !== 'deferred' && myPos === 2 && earlier.length === 2) {
          const first = prof[earlier[0]], second = prof[earlier[1]];
          if (first) bump(first, { evil: 3.5, roles: { '藥不然': 1.65, '老朝奉': 0.35 }, why: `${R}第三位遭偷襲時，第一位是藥不然的時序假設值得核查`, say: null });
          if (second) bump(second, { evil: 3.0, roles: { '老朝奉': 1.45, '藥不然': 0.55 }, why: `${R}第三位遭偷襲時，第二位可能被推成老朝奉，但仍需驗證`, say: null });
        }
      }

      if (!isGood) {
        const claimedBeastsSoFar = new Set();
        (rd.speeches || []).forEach(sp => {
          const rec = prof[sp.playerId];
          if (!rec) return;
          const parsed = speechData(sp, room, rd);
          const rawTxt = String(sp.text || '');
          if ((parsed.campChecks && parsed.campChecks.length) || /查驗.*陣營|不談獸首.*查驗/.test(rawTxt)) {
            bump(rec, { roles: { '方震': 2.6 }, why: `${R}公開宣稱查驗玩家陣營、不報獸首，極像【方震】`, say: null });
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
            if (c.real === inspectionTruth(i)) {
              // 與我的可見畫面一致，只能算輕度資訊一致性；壞人也可能順著我的畫面說話。
              // 不可把「同意我」當成好人證明，也不可把複誦當成獨立查驗。
              bump(prof[sp.playerId], { ally: 4, roles: { '許願': 0.12 },
                why: `${R}公開主張與我的可見畫面一致；只記錄弱一致性，不代表陣營已確認`, say: null });
              return;
            }
            const lo = Math.min(a, myPos), hi = Math.max(a, myPos);
            // 可能在 lo 到 hi 之間按擾亂的人：包含 lo 到 hi-1（因為 hi 查驗時還沒輪到 hi 按技能）
            const flipPool = pass.slice(lo, hi).filter(x => x !== bot.id);
            const isAdjacent = (hi - lo === 1);
            // 私有畫面與他人主張不同，可能是誤判、說謊或不同反轉時點；不能讀取引擎旗標。
            const spkWeight = isAdjacent && a < myPos ? 18 * (0.5 + sk) : 10 * (0.5 + sk);
            bump(prof[sp.playerId], {
              evil: spkWeight, roles: { '藥不然': 0.18, '鄭國渠': 0.18 },
              why: `${R}在${U.nth(a)}宣稱【${c.beast}】${c.real ? '真' : '假'}，與我實際看到的${inspectionTruth(i) ? '真品' : '贗品'}不同；可能是誤判、說謊或老朝奉技能時點差，暫不定案`
            });
            if (a >= 0 && a < myPos && bot.role !== '姬雲浮') {
              const possibleWindow = pass.slice(a, myPos).filter(pid => pid !== bot.id && prof[pid]);
              if (possibleWindow.length) laoPools.push({ round: r + 1, reason: `【${c.beast}】公開主張與我的可見查驗不同；只形成弱反轉時點假設`,
                ids: possibleWindow, confirmedFlip: false, source: 'public-private-mismatch', weight: 0.30 });
            }

            prof[sp.playerId].conflicts.push({
              round: r + 1, beast: c.beast, speakerId: sp.playerId, speakerPos: a, claim: c.real,
              myPos, saw: inspectionTruth(i), displayedSaw: i.displayedReal,
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

        /* 公開第二名真偽可合法回看。只有查過同一尊且畫面與公開真相相反，
           才能推論自己的視野曾被反轉；這不讀取 flipped 位元，也不能直接認出施術者。 */
        if (isGood && bot.role !== '姬雲浮' && myPos > 0) {
          const myR2Ins = ins.find(i => i.beastName === r2.name);
          if (myR2Ins && myR2Ins.displayedReal !== r2.isReal) {
            const frontIds = pass.slice(0, myPos).filter(id => id !== bot.id && prof[id]);
            if (frontIds.length) {
              laoPools.push({ round: r + 1, reason: `${R}我對公開第二名【${r2.name}】的畫面與開票真相相反，確認曾有反轉；施術者僅能在前置順位中推估`,
                ids: frontIds, confirmedFlip: true, source: 'public-result-crosscheck', beasts: [r2.name] });
              frontIds.forEach(pid => prof[pid] && bump(prof[pid], {
                evil: 9 / Math.sqrt(frontIds.length), roles: { '老朝奉': 0.85 / Math.sqrt(frontIds.length) },
                why: `${R}我查驗【${r2.name}】的畫面與公開第二名真偽不同；此人處於可能施術的前置順位，仍需其他證據`, say: null
              }));
            }
          }
        }

        const posReliability = (bot.role === '姬雲浮' || !isGood || myPos === 0)
          ? 0.96
          : Math.max(0.30, 0.90 - Math.max(0, myPos) * 0.085);

        ins.forEach(i => {
          if (!known[i.beastName]) known[i.beastName] = { real: inspectionTruth(i), displayedReal: i.displayedReal, w: posReliability, pub: false, source: 'player-observed-inspect' };
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
              const privateView = k.source === 'player-observed-inspect' || k.source === 'private-deduction';
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

      if (isGood) (rd.speeches || []).forEach((sp, i) => (speechData(sp, room, rd).asked || []).forEach(aid => {
        const rec = prof[aid]; if (!rec) return;
        const reply = (rd.speeches || []).slice(i + 1).find(x => x.playerId === aid);
        if (reply && !/(說明|解釋|交代|被騙|看走眼|認壞|依據|因為)/.test(reply.text)) {
          bump(rec, { evil: 22, roles: { '老朝奉': 0.8 }, why: `${R}被【${sp.speakerName}】點名請說明票型，發言時卻閃躲沒有回應` });
        }
      }));

      if (rd.voteResults) (rd.speeches || []).forEach(sp => {
        const rec = prof[sp.playerId]; const cb = speechData(sp, room, rd).callBeast; if (!rec || !cb) return;
        const ballot = rd.votes[sp.playerId] || {};
        if (U.sum(Object.values(ballot)) > 0 && !(ballot[cb] > 0)) {
          bump(rec, { evil: 24 * (0.5 + sk), roles: { '老朝奉': 1.2 }, why: `${R}口頭號召投【${cb}】，開票卻沒投（言行不一）` });
        }
      });

      // 同一輪多名玩家重複指向同一目標時，後續呼應屬於相關訊號，不應按獨立證據全額累加。
      // 只降低重複呼應的權重；原始指控仍保留，具體角色/查驗矛盾仍由獨立證據另行評估。
      const seenPublicCallsByTarget = new Map();
      const seenRoleAccusations = new Set();
      const seenPublicStances = new Map();
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

        const publicData = speechData(sp, room, rd);
        ((publicData.roleClaims || []).length ? publicData.roleClaims : (publicData.accuse || [])).forEach(a => {
          if (!prof[a.playerId] || a.playerId === bot.id || !a.role) return;
          const w = weightForTarget(a.playerId);
          const roleKey = `${a.playerId}|${a.role}|${a.polarity || 'claim'}`;
          const repeatedRoleAccusation = seenRoleAccusations.has(roleKey);
          seenRoleAccusations.add(roleKey);
          const correlationDiscount = repeatedRoleAccusation ? 0.28 : 1.0;
          const polarity = a.polarity || 'claim';
          if (polarity === 'deny') {
            bump(prof[a.playerId], { roles: { [a.role]: -1.8 * w * correlationDiscount },
              why: `${sp.speakerName}公開排除${U.tag(prof[a.playerId].player)}是【${a.role}】；這不等於證明他是好人`, say: null });
          } else if (polarity === 'fake') {
            bump(prof[a.playerId], { evil: 10 * w * correlationDiscount, roles: { [a.role]: -1.0 * w * correlationDiscount },
              why: `${sp.speakerName}指稱${U.tag(prof[a.playerId].player)}是假冒【${a.role}】；記為角色爭議，不當成其真實角色`,
              say: `${U.tag(playerById(room, sp.playerId))}曾指稱${U.tag(prof[a.playerId].player)}是假冒【${a.role}】` });
          } else {
            bump(prof[a.playerId], {
              evil: (a.role === '老朝奉' ? 40 : 22) * w * correlationDiscount,
              roles: { [a.role]: 2.4 * w * correlationDiscount },
              why: `${sp.speakerName}點名${U.tag(prof[a.playerId].player)}是【${a.role}】${repeatedRoleAccusation ? '（同輪重複指控，降權）' : ''}`,
              say: `${U.tag(playerById(room, sp.playerId))}曾公開指稱${U.tag(prof[a.playerId].player)}是【${a.role}】`
            });
          }
        });

        // 玩家直接說「X 是壞人／好人」也必須進入推理資料，而不是只供發言模組改寫。
        // 這是未經驗證的公開判斷，採弱權重並按重複指控降權；不會直接設為 knownEvil。
        (publicData.playerStances || []).forEach(stance => {
          const targetId = stance && stance.targetId;
          const targetRec = targetId && prof[targetId];
          if (!targetRec || targetId === bot.id || !['evil', 'good'].includes(stance.camp)) return;
          const evidence = Array.isArray(stance.evidence) ? stance.evidence : (stance.evidence ? [stance.evidence] : []);
          const directEvidence = evidence.filter(item => item && item.type === 'direct-public-stance');
          if (!directEvidence.length) return; // 歷史投票已由 pubFake／實際票型模組計分，避免重複加權。
          const stanceKey = `${targetId}|${stance.camp}`;
          const repeated = seenPublicStances.has(stanceKey);
          seenPublicStances.set(stanceKey, (seenPublicStances.get(stanceKey) || 0) + 1);
          const correlationDiscount = repeated ? 0.30 : 1.0;
          const w = weightForTarget(targetId);
          const speaker = playerById(room, sp.playerId);
          const speakerTag = speaker ? U.tag(speaker) : (sp.speakerName || '前手玩家');
          const directText = directEvidence.map(item => item.text).filter(Boolean).join('；');
          const historical = evidence.filter(item => item && item.type === 'historical-vote');
          const historicalText = historical.map(item => `第${item.round}輪投【${item.beast}】${item.votes}票`).join('、');
          const detail = historicalText ? `，並指出其歷史票型（${historicalText}）` : '';
          if (stance.camp === 'evil') {
            bump(targetRec, {
              evil: 12 * w * correlationDiscount,
              roles: { '老朝奉': 0.28 * w * correlationDiscount },
              why: `${speakerTag}公開判斷${U.tag(targetRec.player)}是壞人${detail}；這是尚未證實的玩家立場，需與獨立行動證據交叉核對${repeated ? '（重複指控降權）' : ''}`,
              say: `${speakerTag}公開指認${U.tag(targetRec.player)}為壞人${detail}`
            });
          } else {
            bump(targetRec, {
              ally: 8 * w * correlationDiscount,
              why: `${speakerTag}公開判斷${U.tag(targetRec.player)}是好人；這是未驗證立場，不等於查驗確認${repeated ? '（重複背書降權）' : ''}`,
              say: null
            });
          }
        });

        const cs = publicData.callSuspectId;
        if (cs && cs !== bot.id && prof[cs]) {
          const priorCalls = seenPublicCallsByTarget.get(cs) || 0;
          const correlationDiscount = priorCalls === 0 ? 1.0 : priorCalls === 1 ? 0.35 : 0.16;
          seenPublicCallsByTarget.set(cs, priorCalls + 1);
          const w = weightForTarget(cs);
          bump(prof[cs], {
            evil: 50 * w * correlationDiscount,
            roles: { '老朝奉': 3 * w * correlationDiscount },
            why: `${sp.speakerName}號召全場集火他${priorCalls ? '（同輪重複集火，降權）' : ''}`,
            say: `${U.tag(playerById(room, sp.playerId))}曾號召大家集火${U.tag(prof[cs].player)}`
          });
        }
      });
    }

    // 壞人視角另行估計鄭國渠：公開矛盾、已開出的 rank2 與實際票型是角色證據，
    // 但 P(Zheng) 獨立保存，不把它直接等同 P(Evil) 或 P(Lao)。
    if (!isGood) {
      for (let r = 0; r <= t; r++) {
        const rd = room.rounds[r];
        if (!rd) continue;
        const opened = rd.voteResults && rd.voteResults.rank2;
        (rd.speeches || []).forEach(sp => {
          const rec = prof[sp && sp.playerId];
          if (!rec || sp.playerId === bot.id) return;
          const parsed = speechData(sp, room, rd);
          let roleWeight = 0;
          if ((parsed.selfContradictions || []).length) roleWeight += 1.15;
          if (opened && opened.name && typeof opened.isReal === 'boolean') {
            const claim = (parsed.claims || []).find(item => item && item.beast === opened.name && typeof item.real === 'boolean');
            if (claim && claim.real !== opened.isReal) roleWeight += 1.45;
            const ballot = rd.votes && rd.votes[sp.playerId] || {};
            if (Number(ballot[opened.name]) > 0 && claim && claim.real === true && !opened.isReal) roleWeight += 0.75;
          }
          const ballot = rd.votes && rd.votes[sp.playerId] || {};
          const hardPromises = (parsed.voteCommitments || []).filter(item => item && item.binding !== false);
          if (hardPromises.length && hardPromises.every(item => !(Number(ballot[item.beast]) > 0))) roleWeight += 0.65;
          if (roleWeight > 0) bump(rec, {
            roles: { '鄭國渠': roleWeight },
            why: `第${r + 1}輪公開矛盾／票型與開出結果形成鄭國渠角色線索；這只調整角色後驗，不直接確定陣營`,
            say: null
          });
        });
      }
    }

    // 鄭國渠在前兩輪可用「共同公開錯誤主張＋共同投向已公開贗品」辨識另外兩名壞人。
    // 只讀本視角與對方的公開發言、公開票單、rank2，不讀任何他人的 mind／私密角色。
    const inferredPartners = [];
    const partnerRows = new Map();
    if (bot.role === '鄭國渠') {
      for (let r = 0; r <= Math.min(t, 1); r++) {
        const rd = room.rounds[r];
        const opened = rd && rd.voteResults && rd.voteResults.rank2;
        if (!rd || !opened || opened.isReal !== false || !opened.name) continue;
        const ownSpeech = (rd.speeches || []).find(sp => String(sp && sp.playerId) === String(bot.id));
        const own = speechData(ownSpeech, room, rd);
        const ownFalseReal = (own.claims || []).some(item => item && item.beast === opened.name && item.real === true);
        const ownBallot = rd.votes && rd.votes[bot.id] || {};
        const ownFakeVote = Number(ownBallot[opened.name]) || 0;
        (rd.speeches || []).forEach(sp => {
          if (!sp || sp.playerId === bot.id || !prof[sp.playerId]) return;
          const parsed = speechData(sp, room, rd);
          const theirFalseReal = (parsed.claims || []).some(item => item && item.beast === opened.name && item.real === true);
          const theirBallot = rd.votes && rd.votes[sp.playerId] || {};
          const theirFakeVote = Number(theirBallot[opened.name]) || 0;
          let row = partnerRows.get(sp.playerId);
          if (!row) { row = { player: prof[sp.playerId].player, evidence: [], rounds: [] }; partnerRows.set(sp.playerId, row); }
          if (ownFalseReal && theirFalseReal) row.evidence.push({ kind: 'shared-false-real-claim', round: r + 1, beast: opened.name });
          if (ownFakeVote > 0 && theirFakeVote > 0) row.evidence.push({ kind: 'shared-fake-ballot', round: r + 1, beast: opened.name, chips: theirFakeVote });
          const myPos = (rd.passOrder || []).indexOf(bot.id);
          const theirPos = (rd.passOrder || []).indexOf(sp.playerId);
          if (theirPos >= 0 && myPos >= 0 && theirPos < myPos && theirFalseReal) {
            row.evidence.push({ kind: 'front-player-false-real-claim', round: r + 1, beast: opened.name });
          }
          row.rounds.push(r + 1);
        });
      }
      // 對鄭國渠而言，雙方都公開喊真、最後又共同投向已公開的贗品，
      // 是刻意的盲認訊號；提高「壞人陣營」後驗，但不把 P(Evil) 合併成 P(鄭國渠)。
      partnerRows.forEach((row, id) => {
        const rec = prof[id];
        const kinds = new Set((row.evidence || []).map(item => item.kind));
        if (!rec || !kinds.has('shared-false-real-claim') || !kinds.has('shared-fake-ballot')) return;
        bump(rec, { evil: 8, roles: { '老朝奉': 1.25, '藥不然': 1.25, '鄭國渠': 1.25 },
          why: '與鄭國渠共同公開喊真、又共同投向已公開贗品；作為早期隊友盲認的公開行為線索，仍需後續交叉驗證', say: null });
      });
    }

    // 公開跳職也是一項可回頭驗證的承諾。只讀每位玩家自己的公開發言，不讀其他 Bot 的私密 mind。
    const roleClaimsByRole = new Map();
    const roleClaimsByPlayer = new Map();
    const seenRoleClaim = new Set();
    for (let rr = 0; rr <= t; rr++) {
      const rd = room.rounds[rr];
      (rd && rd.speeches || []).forEach(sp => {
        let role = speechData(sp, room, rd).selfRole;
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
      const tags = entries.map(item => U.tag(playerById(room, item.id))).filter(Boolean);
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

    // 僅使用公開發言和已公開的 rank1/rank2；不讀其他玩家的私密 turnLogs 或 mind。
    for (let speechRoundIndex = 0; speechRoundIndex <= t; speechRoundIndex++) {
      const speechRound = room.rounds[speechRoundIndex];
      if (!speechRound) continue;
      (speechRound.speeches || []).forEach(sp => {
        if (!sp || !sp.playerId || sp.playerId === bot.id) return;
        const pub = speechData(sp, room, speechRound);
        (pub.candidateSets || []).forEach(group => {
          const candidateIds = [...new Set((group.candidateIds || []).filter(id => playerById(room, id)))];
          if (candidateIds.length < 2) return;
          const key = sp.playerId + "|" + (speechRoundIndex + 1) + "|" + group.role + "|" + candidateIds.slice().sort().join("|");
          if (seenCandidateGroups.has(key)) return;
          seenCandidateGroups.add(key);
          publicCandidateGroups.push({ speakerId: sp.playerId, speakerName: sp.speakerName, speechRound: speechRoundIndex + 1,
            role: group.role || "壞人", relation: "one_of", candidateIds, text: group.text || "" });
          candidateIds.forEach(id => {
            if (prof[id]) bump(prof[id], { roles: { "老朝奉": 0.28 },
              why: "公開玩家提出單選候選集合；只作弱參考，不代表每名候選都可疑或已被驗明", say: null });
          });
        });
        (pub.inspectionReports || []).forEach(report => {
          const sourceRound = room.rounds[(Number(report.round) || 0) - 1];
          if (!sourceRound || !sourceRound.voteResults || !Array.isArray(sourceRound.passOrder)) return;
          // 只有明確標記 hidden:false 的公開第二名可用；第一名及標記不明的資料一律排除。
          const revealed = sourceRound.voteResults.rank2;
          if (!revealed ||
              revealed.hidden !== false ||
              revealed.name !== report.beast ||
              typeof revealed.isReal !== "boolean" ||
              revealed.isReal === report.claimedReal) return;
          const speakerPos = sourceRound.passOrder.indexOf(sp.playerId);
          if (speakerPos <= 0) return;
          const candidateIds = sourceRound.passOrder.slice(0, speakerPos).filter(id => id !== bot.id && prof[id]);
          if (!candidateIds.length) return;
          const key = sp.playerId + "|" + report.round + "|" + report.beast + "|" + report.claimedReal + "|" + revealed.isReal;
          if (seenPublicFlipReports.has(key)) return;
          seenPublicFlipReports.add(key);
          const speakerSpeechIndex = (sourceRound.speechOrder || []).indexOf(sp.playerId);
          const flipWindow = { order: 'passOrder', startPassIndex: 0, endPassIndex: speakerPos - 1,
            speakerPassIndex: speakerPos, speakerSpeechIndex, speechOrderIsNotSkillOrder: true };
          publicReportedFlipPools.push({ speakerId: sp.playerId, speakerName: sp.speakerName, reportRound: report.round,
            speechRound: speechRoundIndex + 1, beast: report.beast, claimedReal: report.claimedReal,
            revealedReal: revealed.isReal, candidateIds, source: "public-reported-inspection-mismatch", window: flipWindow });
          candidateIds.forEach(id => {
            const weight = 4.5 / Math.sqrt(candidateIds.length);
            if (prof[id]) {
              prof[id].flipWindowSupport += weight / 10;
              prof[id].flipWindowReports.push({ speakerId: sp.playerId, reportRound: report.round, beast: report.beast,
                passIndex: (sourceRound.passOrder || []).indexOf(id), ...flipWindow });
              bump(prof[id], { evil: weight, roles: { "老朝奉": 0.42 / Math.sqrt(candidateIds.length) },
                why: "公開玩家回報的歷史查驗與已公開結果相反；此人位於可能的前置反轉區間，仍需獨立證據", say: null });
            }
          });
        });
      });
    }

    /* 跨輪老朝奉候選池交集消去法。
     * 不因遊戲陣營人數固定，就把嫌疑分數硬裁成三人；每名玩家保留自己的證據權重。
     */
    let laoIntersectIds = [];
    let eliminatedFromLaoIds = [];
    let reEvalNote = null;

    if (isGood && laoPools.length > 0) {
      // 只有可見查驗與已公開 rank2 真偽交叉驗證的事件，才可做跨輪硬時序交集。
      // 發言與私有畫面不一致僅是弱假設，不得拿來交集排除玩家。
      const intersectionPools = laoPools.filter(pool => pool.source === 'public-result-crosscheck' && pool.confirmedFlip === true);
      intersectionPools.forEach(pool => {
        pool.ids.forEach(id => { if (prof[id]) prof[id].inLaoPoolCount++; });
      });
      if (intersectionPools.length >= 2) {
        let inter = [...new Set(intersectionPools[0].ids)];
        let incompatibleWindows = false;
        for (let idx = 1; idx < intersectionPools.length; idx++) {
          const nextSet = new Set(intersectionPools[idx].ids);
          const nextInter = inter.filter(id => nextSet.has(id));
          if (!nextInter.length) { incompatibleWindows = true; break; }
          inter = nextInter;
        }
        if (incompatibleWindows) {
          // 不同輪候選時窗若無交集，代表假設／事件前提至少有一項不成立；不得沿用舊交集硬排除。
          laoIntersectIds = [];
          eliminatedFromLaoIds = [];
          reEvalNote = '跨輪老朝奉候選時窗沒有共同玩家；保留各輪候選池與軟權重，不以空交集排除任何人。';
        } else {
          laoIntersectIds = inter;
          const unionIds = [...new Set(intersectionPools.flatMap(p => p.ids))];
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
        }
      } else if (intersectionPools.length === 1) {
        laoIntersectIds = [...new Set(intersectionPools[0].ids)];
      }
    }

    // 不做「前三名保留、其餘降權」的人數裁切。
    // 嫌疑排序只反映證據強弱；若證據不足，交由策略／發言層明確保留未知。

    ctx.publicCandidateGroups = publicCandidateGroups;
    ctx.publicReportedFlipPools = publicReportedFlipPools;
    ctx.laoPools = laoPools;
    ctx.laoIntersectIds = laoIntersectIds;
    ctx.eliminatedFromLaoIds = eliminatedFromLaoIds;
    ctx.reEvalNote = reEvalNote;

    Object.values(prof).forEach(rec => {
      const roles = GD.ROLE_ORDER.filter(x => x !== bot.role);
      const allowed = roles.filter(role => !rec.knownCamp || (rec.knownCamp === 'good' ? GD.isGood(role) : !GD.isGood(role)));
      const mx = Math.max(0, ...allowed.map(x => rec.logits[x] || 0));
      const ex = allowed.map(x => Math.exp((rec.logits[x] || 0) - mx));
      const total = U.sum(ex) || 1;
      rec.probs = Object.fromEntries(roles.map(role => [role, 0]));
      allowed.forEach((role, i) => { rec.probs[role] = Math.round(ex[i] / total * 10000) / 100; });
      rec.pEvil = Number((EVIL.reduce((n, role) => n + (rec.probs[role] || 0), 0) / 100).toFixed(4));
      rec.pGood = Number((1 - rec.pEvil).toFixed(4));
      rec.pLao = Number(((rec.probs['老朝奉'] || 0) / 100).toFixed(4));
      rec.pZheng = Number(((rec.probs['鄭國渠'] || 0) / 100).toFixed(4));
      if (rec.knownCamp === 'good') { rec.pEvil = 0; rec.pGood = 1; rec.knownGood = true; }
      if (rec.knownCamp === 'evil') { rec.pEvil = 1; rec.pGood = 0; rec.knownEvil = true; }
    });

    // 後驗機率完成後才判定隊友，避免使用尚未計算的 pEvil=0。
    if (bot.role === '鄭國渠') {
      const candidates = [...partnerRows.entries()].map(([id, row]) => {
        const rec = prof[id];
        if (!rec) return null;
        const kinds = [...new Set(row.evidence.map(item => item.kind))];
        rec.partnerEvidence = row.evidence;
        const pEvil = Number(rec.pEvil) || 0;
        const hasFalseClaimAndFalseBallotHandshake = kinds.includes('shared-false-real-claim') && kinds.includes('shared-fake-ballot');
        const isPartner = (pEvil >= 0.58 && kinds.length >= 2) || (pEvil >= 0.76 && kinds.length >= 1) ||
          (pEvil >= 0.45 && hasFalseClaimAndFalseBallotHandshake);
        if (isPartner) rec.isPartner = true;
        return { id, rec, kinds, evidence: row.evidence, isPartner, pEvil };
      }).filter(item => item && item.isPartner)
        .sort((a, b) => (b.kinds.length - a.kinds.length) || (b.pEvil - a.pEvil));
      const keep = new Set(candidates.slice(0, 2).map(item => item.id));
      Object.entries(prof).forEach(([id, rec]) => { if (!keep.has(id)) rec.isPartner = false; });
      inferredPartners.splice(0, inferredPartners.length, ...candidates.filter(item => keep.has(item.id)).map(item => ({
        playerId: item.id, player: item.rec.player, evidence: item.evidence, kinds: item.kinds, pEvil: item.pEvil
      })));
    }
    ctx.inferredPartners = inferredPartners.slice();
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
    const claimEvidenceByKey = new Map(((ctx.claimEvidence && ctx.claimEvidence.current) || []).map(entry =>
      [`${String(entry.playerId)}|${entry.beast}|${entry.real}`, entry]));
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
          if (idx < 0 || typeof i.displayedReal !== 'boolean') return;
          const predictedDisplay = real.has(idx) !== myFlip;
          w *= (predictedDisplay === i.displayedReal) ? 0.97 : 0.03;
        });
        // rank2 真偽在開票後屬公開資訊；rank1 仍封存，不納入此限制。
        const publicRank2 = rd.voteResults && rd.voteResults.rank2;
        if (publicRank2 && typeof publicRank2.isReal === 'boolean') {
          const idx = names.indexOf(publicRank2.name);
          if (idx >= 0) w *= (real.has(idx) === publicRank2.isReal) ? 0.999 : 0.001;
        }
        rd.speeches.forEach(sp => {
          if (sp.playerId === bot.id) return;
          const a = pass.indexOf(sp.playerId);
          if (a < 0) return;
          const parsed = parsedSpeechById.get(String(sp.playerId)) || {};
          const tr = trustOf(sp.playerId, parsed);
          const profile = prof[sp.playerId];
          const evilPrior = profile && profile.knownCamp === 'evil' ? 1
            : profile && profile.knownCamp === 'good' ? 0
            : U.clamp(profile ? profile.pEvil : (EVIL.length - (isGood ? 0 : 1)) / Math.max(1, room.players.length - 1), 0.03, 0.97);
          (Array.isArray(parsed.claims) ? parsed.claims : []).slice(0, 3).forEach(c => {
            const idx = names.indexOf(c.beast); if (idx < 0 || typeof c.real !== 'boolean') return;
            const objectiveTruth = real.has(idx);
            const asGoodDisplay = objectiveTruth !== (k < a);
            const infoSkill = profile && Number.isFinite(Number(profile.infoSkill)) ? Number(profile.infoSkill) : 50;
            // 好人依自己的畫面發言；姬雲浮免疫擾亂，須從好人機率中另外拆出。
            const goodPrior = 1 - evilPrior;
            const pImmuneAmongGood = goodPrior > 0
              ? U.clamp(((profile && profile.probs && Number(profile.probs['姬雲浮']) || 0) / 100) / goodPrior, 0, 1)
              : 0;
            const goodAccuracy = U.clamp(0.88 + (infoSkill - 50) / 500, 0.78, 0.94);
            const evilAccuracy = U.clamp(0.50 + (infoSkill - 50) / 300, 0.32, 0.68);
            const likelihood = (expected, reported, accuracy) => expected === reported ? accuracy : 1 - accuracy;
            const goodMatch = pImmuneAmongGood * likelihood(objectiveTruth, c.real, goodAccuracy) +
              (1 - pImmuneAmongGood) * likelihood(asGoodDisplay, c.real, goodAccuracy);
            // 壞人可能報真、報假或順勢附和；預設近似中性，再由可驗證公開資訊能力校準，
            // 不再錯誤假設壞人必定知道並公開報出客觀真相。
            const evilMatch = likelihood(objectiveTruth, c.real, evilAccuracy);
            const pMatches = goodPrior * goodMatch + evilPrior * evilMatch;
            const rawLikelihood = tr * pMatches + (1 - tr) * 0.5;
            const evidence = claimEvidenceByKey.get(`${String(sp.playerId)}|${c.beast}|${c.real}`);
            // Self-reported inspection is useful but unverified; inference/echo assertions are progressively weaker.
            // Shrink uncertain public claims toward neutral instead of multiplying every repeated chorus at full strength.
            const sourceWeight = evidence ? evidence.weight : 0.24;
            w *= 0.5 + (rawLikelihood - 0.5) * sourceWeight;
          });
        });
        cfg.forEach(i => { pReal[i] += w; });
        laoAt[k] += w; total += w;
      });
    });
    const post = names.map((n, i) => ({ name: n, pReal: total ? pReal[i] / total : 0.5 }));
    return { post, laoAt: laoAt.map(x => (total ? x / total : 0)), confident: post.some(b => Math.abs(b.pReal - 0.5) > 0.3) };
  }

  function collectPublicUncertaintyReports(room, throughRound) {
    const out = [];
    for (let r = 0; r <= throughRound; r++) {
      const rd = room.rounds && room.rounds[r];
      if (!rd) continue;
      (rd.speeches || []).forEach(sp => {
        if (!sp || !sp.playerId) return;
        const parsed = speechData(sp, room, rd);
        if (!parsed.unsure && !parsed.blind) return;
        const reports = Array.isArray(parsed.uncertaintyReasons) && parsed.uncertaintyReasons.length
          ? parsed.uncertaintyReasons : [{ reason: 'unspecified', provenance: 'self_report', verification: 'not_independently_verified', text: sp.text || '' }];
        reports.forEach(report => out.push({
          round: r + 1, playerId: sp.playerId, reason: report.reason || 'unspecified',
          provenance: report.provenance || 'self_report',
          verification: report.verification || 'not_independently_verified',
          text: report.text || String(sp.text || '')
        }));
      });
    }
    return out;
  }

  function analyze(bot, room) {
    const ctx = context(bot, room);
    const prof = buildProfiles(ctx);
    const claimEvidence = collectPublicClaimEvidence(ctx, prof);
    const uncertaintyReports = collectPublicUncertaintyReports(room, ctx.t);
    ctx.claimEvidence = claimEvidence;
    ctx.uncertaintyReports = uncertaintyReports;
    ctx.publicCountConstraints = collectPublicCountConstraints(ctx);
    const pst = posterior(ctx, prof);
    const laoTiming = buildLaoTimeline(ctx, pst, prof);

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
    const pool = list.filter(r => !(ctx.partner && r.player.id === ctx.partner.id) && !r.knownEvil && r.knownCamp !== 'evil');
    const byEvil = [...list].filter(r => ctx.isGood ? (!r.confessed && !r.knownGood) : r.ally < 90)
      .sort((a, b) => (b.evil + (b.probs['老朝奉'] || 0)) - (a.evil + (a.probs['老朝奉'] || 0)));
    const A = {
      ctx, prof, post: pst.post, laoAt: pst.laoAt, confident: pst.confident,
      laoTiming, claimEvidence, consensusDecomposition: claimEvidence.groups, consensusAlerts: claimEvidence.alerts,
      uncertaintyReports: ctx.uncertaintyReports || [],
      publicCountConstraints: ctx.publicCountConstraints || [],
      topSuspect: byEvil[0] || null,
      byEvil,
      topAlly: [...pool].sort((a, b) => b.ally - a.ally)[0] || null,
      topXu: [...pool].sort((a, b) => ((b.probs['許願'] || 0) + b.ally * 0.5) - ((a.probs['許願'] || 0) + a.ally * 0.5))[0] || null,
      topFang: [...pool].sort((a, b) => ((b.probs['方震'] || 0) + b.ally * 0.4) - ((a.probs['方震'] || 0) + a.ally * 0.4))[0] || null,
      publicCall: findPublicCall(ctx, prof),
      publicCandidateGroups: ctx.publicCandidateGroups || [],
      publicReportedFlipPools: ctx.publicReportedFlipPools || [],
      inferredPartners: ctx.inferredPartners || [],
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
    const hit = (ctx.rd.speeches || []).find(sp => sp.playerId !== ctx.bot.id && (speechData(sp, ctx.room, ctx.rd).asked || []).includes(ctx.bot.id));
    return hit ? { callerId: hit.playerId, callerName: hit.speakerName, round: ctx.t + 1 } : null;
  }

  function findPublicCall(ctx, prof) {
    let call = null;
    for (let r = 0; r <= ctx.t; r++) {
      (ctx.room.rounds[r].speeches || []).forEach(sp => {
        if (sp.playerId === ctx.bot.id) return;
        const caller = prof[sp.playerId];
        if (caller && caller.evil >= 55) return;
        const id = speechData(sp, ctx.room, ctx.room.rounds[r]).callSuspectId;
        if (id && id !== ctx.bot.id) call = { callerId: sp.playerId, callerName: sp.speakerName, targetId: id, round: r + 1 };
      });
    }
    return call;
  }

  GD.Mind = { analyze, context, posterior, buildProfiles, buildInformationSkill, pubFakeVotes, passPositionPrior, voteViewAdjustment, inspectionTruth, observedTruth, auditTruth, blindCandidateWindows, orderedSpeechRows, classifyPublicClaim, collectPublicClaimEvidence, buildLaoTimeline, EVIL };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Mind;
})(typeof window !== 'undefined' ? window : global);