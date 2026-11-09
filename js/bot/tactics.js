/* ============================================================================
 * bot/tactics.js — 全局算票、保真期望與籌碼配置（v10 Tactical Intelligence）
 * 規則：只讀公開發言／已投選票、玩家可用籌碼，以及當前 Bot 自己的後驗；不讀其他 Bot 的私密 mind。
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U, Rules, Claims } = GD;
  const T = {};

  const sigmoid = x => 1 / (1 + Math.exp(-U.clamp(x, -12, 12)));
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const sum = obj => Object.values(obj || {}).reduce((n, v) => n + (Number(v) || 0), 0);

  function currentRound(room) {
    return room && room.rounds && room.rounds[room.currentRoundIdx] || null;
  }
  function beastNames(rd) {
    return (rd && rd.beasts || []).map(b => b.name);
  }
  function parseSpeech(sp, room, rd) {
    if (Claims && typeof Claims.parseRecord === 'function') return Claims.parseRecord(sp, room, rd);
    if (sp && sp.p && Array.isArray(sp.p.claims) && sp.p.claims.length) return sp.p;
    return Claims.parse(String(sp && sp.text || ''), room, rd);
  }
  function addWeight(weights, name, value) {
    if (Object.prototype.hasOwnProperty.call(weights, name)) weights[name] += value;
  }
  function normalized(weights, names) {
    const rawTotal = names.reduce((n, name) => n + Math.max(0, Number(weights[name]) || 0), 0);
    if (!(rawTotal > 0)) {
      const equal = 1 / Math.max(1, names.length);
      return Object.fromEntries(names.map(name => [name, equal]));
    }
    return Object.fromEntries(names.map(name => [name, Math.max(0, Number(weights[name]) || 0) / rawTotal]));
  }

  function speechPreference(sp, room, rd, names, callWeightOverride = null) {
    const weights = Object.fromEntries(names.map(name => [name, 0]));
    if (!sp) return normalized(weights, names);
    const p = parseSpeech(sp, room, rd);
    const calls = [...new Set([...(p.callBeasts || []), p.callBeast].filter(name => names.includes(name)))];
    const claims = (p.claims || []).filter(c => c && names.includes(c.beast));
    if (calls.length) {
      // A call is informative, not a guaranteed ballot. Past public misalignment lowers its forecast weight.
      const callWeight = callWeightOverride == null ? 0.70 : U.clamp(callWeightOverride, 0.45, 0.70);
      const claimWeight = claims.length ? Math.min(0.20, 1 - callWeight) : 0;
      calls.forEach(name => addWeight(weights, name, callWeight / calls.length));
      if (claims.length) {
        const claimTotal = claims.reduce((n, c) => n + (c.real === true ? 1.15 : 0.75), 0);
        claims.forEach(c => addWeight(weights, c.beast, claimWeight * (c.real === true ? 1.15 : 0.75) / claimTotal));
      }
      const residual = Math.max(0, 1 - callWeight - claimWeight);
      names.forEach(name => addWeight(weights, name, residual / names.length));
    } else if (claims.length) {
      const claimTotal = claims.reduce((n, c) => n + (c.real === true ? 1.10 : 0.80), 0);
      claims.forEach(c => addWeight(weights, c.beast, 0.62 * (c.real === true ? 1.10 : 0.80) / claimTotal));
      names.forEach(name => addWeight(weights, name, 0.38 / names.length));
    } else {
      names.forEach(name => addWeight(weights, name, 1 / names.length));
    }
    return normalized(weights, names);
  }

  function chipsAvailable(room, player) {
    // Engine history is authoritative; voteBank is a UI/cache field and can be stale in replays or simulations.
    if (GD.Engine && typeof GD.Engine.availableChips === 'function' && player) {
      return Math.max(0, Math.floor(Number(GD.Engine.availableChips(room, player.id)) || 0));
    }
    if (player && Number.isFinite(Number(player.voteBank))) return Math.max(0, Math.floor(Number(player.voteBank)));
    return Math.max(0, Number(GD.CONFIG.CHIPS_PER_ROUND) || 2);
  }

  // Read only completed public ballots and their public speeches. Some players concentrate 2+ chips;
  // the forecast should learn this tendency without assuming every player spends exactly one vote.
  function historicalBallotProfile(room, playerId) {
    const end = Math.max(0, Number(room && room.currentRoundIdx) || 0);
    const chipsPerRound = Math.max(1, Number(GD.CONFIG && GD.CONFIG.CHIPS_PER_ROUND) || 2);
    const records = [];
    for (let r = 0; r < end; r++) {
      const rd = room.rounds && room.rounds[r];
      if (!rd || !rd.votes || !Object.prototype.hasOwnProperty.call(rd.votes, playerId)) continue;
      const ballot = rd.votes[playerId] || {};
      const allocations = Object.entries(ballot)
        .map(([beast, raw]) => ({ beast, chips: Math.max(0, Number(raw) || 0) }))
        .filter(x => x.chips > 0)
        .sort((a, b) => b.chips - a.chips || zodiacIndex(a.beast) - zodiacIndex(b.beast));
      const total = sum(ballot);
      const priorSpent = records.reduce((n, rec) => n + rec.total, 0);
      const available = Math.max(1, (r + 1) * chipsPerRound - priorSpent);
      const sp = (rd.speeches || []).find(s => s && String(s.playerId) === String(playerId));
      const parsed = sp ? parseSpeech(sp, room, rd) : null;
      const calls = parsed ? [...new Set([...(parsed.callBeasts || []), parsed.callBeast].filter(Boolean))] : [];
      const primary = allocations[0] || null;
      const callVotes = calls.reduce((n, name) => n + Math.max(0, Number(ballot[name]) || 0), 0);
      const callShare = total > 0 ? callVotes / total : 0;
      records.push({
        round: r + 1, total, available,
        spendRatio: U.clamp(total / available, 0, 1),
        primaryBeast: primary && primary.beast || null,
        primaryChips: primary && primary.chips || 0,
        primaryShare: total > 0 && primary ? primary.chips / total : 0,
        multiChip: !!(primary && primary.chips >= 2),
        calls, callVotes, callShare,
        callAligned: calls.length ? callShare >= 0.5 : null
      });
    }
    const n = records.length;
    const avg = key => n ? records.reduce((acc, rec) => acc + (Number(rec[key]) || 0), 0) / n : 0;
    const callRecords = records.filter(rec => rec.callAligned !== null);
    const heavyRounds = records.filter(rec => rec.multiChip).length;
    const callAlignedCount = callRecords.filter(rec => rec.callAligned).length;
    return {
      roundsObserved: n,
      multiChipRounds: heavyRounds,
      multiChipRate: n ? heavyRounds / n : 0,
      averageSpendRatio: avg('spendRatio'),
      averagePrimaryShare: avg('primaryShare'),
      averagePrimaryChips: avg('primaryChips'),
      callRoundsObserved: callRecords.length,
      callAlignedCount,
      callAlignmentRate: callRecords.length ? callAlignedCount / callRecords.length : null,
      lastPrimaryBeast: records.length ? records[records.length - 1].primaryBeast : null,
      records
    };
  }

  /** 估算各獸首最後票數與不確定性；不使用其他玩家的 role / rd.mind / 內部計畫。 */
  function forecastVotes(room, botOrId, beliefProfile = null) {
    const rd = currentRound(room);
    const names = beastNames(rd);
    const botId = typeof botOrId === 'string' ? botOrId : (botOrId && botOrId.id);
    const expected = Object.fromEntries(names.map(name => [name, 0]));
    const variance = Object.fromEntries(names.map(name => [name, 0]));
    const observed = Object.fromEntries(names.map(name => [name, 0]));
    const callSupport = Object.fromEntries(names.map(name => [name, 0]));
    const claimSupport = Object.fromEntries(names.map(name => [name, 0]));
    const goodExpectedVotes = Object.fromEntries(names.map(name => [name, 0]));
    const evilExpectedVotes = Object.fromEntries(names.map(name => [name, 0]));
    const coordinationVariance = Object.fromEntries(names.map(name => [name, 0]));
    const observer = U.byId(room, botId);
    const defaultPevil = observer && GD.isGood(observer.role) ? 3 / 7 : 2 / 7;
    const ballots = rd && rd.votes || {};
    const cast = new Set(Object.keys(ballots));
    let observedTotal = 0;
    let projectedTotal = 0;

    Object.entries(ballots).forEach(([pid, ballot]) => {
      Object.entries(ballot || {}).forEach(([name, raw]) => {
        if (!Object.prototype.hasOwnProperty.call(expected, name)) return;
        const n = Math.max(0, Number(raw) || 0);
        expected[name] += n;
        observed[name] += n;
        const profile = beliefProfile && beliefProfile[pid];
        const pEvil = profile && Number.isFinite(Number(profile.pEvil)) ? U.clamp(Number(profile.pEvil), 0, 1) : defaultPevil;
        evilExpectedVotes[name] += n * pEvil;
        goodExpectedVotes[name] += n * (1 - pEvil);
        observedTotal += n;
      });
    });

    (rd && rd.speeches || []).forEach(sp => {
      const p = parseSpeech(sp, room, rd);
      [...new Set([...(p.callBeasts || []), p.callBeast].filter(name => names.includes(name)))].forEach(name => callSupport[name]++);
      (p.claims || []).filter(c => c && c.real === true && names.includes(c.beast)).forEach(c => claimSupport[c.beast]++);
    });

    const speechById = new Map((rd && rd.speeches || []).map(sp => [sp.playerId, sp]));
    const projectedVoters = [];
    (room && room.players || []).forEach(player => {
      if (!player || player.id === botId || cast.has(player.id)) return;
      const chips = chipsAvailable(room, player);
      if (!(chips > 0)) return;
      const sp = speechById.get(player.id) || null;
      const parsed = sp ? parseSpeech(sp, room, rd) : null;
      const calls = parsed ? [...new Set([...(parsed.callBeasts || []), parsed.callBeast].filter(name => names.includes(name)))] : [];
      const claims = parsed ? (parsed.claims || []).filter(c => c && names.includes(c.beast)) : [];
      const history = historicalBallotProfile(room, player.id);
      let callWeightOverride = null;
      if (calls.length && history.callAlignmentRate !== null && history.callRoundsObserved > 0) {
        // Shrink tiny samples toward 65% reliability; only lower call weight when this player's past ballot mostly ignored their own call.
        const reliability = (history.callAlignmentRate * history.callRoundsObserved + 1.30) / (history.callRoundsObserved + 2);
        callWeightOverride = U.clamp(0.70 - Math.max(0, 0.65 - reliability) * 0.40, 0.45, 0.70);
      }
      const pref = speechPreference(sp, room, rd, names, callWeightOverride);
      const belief = beliefProfile && beliefProfile[player.id];
      const pEvil = belief && Number.isFinite(Number(belief.pEvil)) ? U.clamp(Number(belief.pEvil), 0, 1) : defaultPevil;
      const baseSpendRate = calls.length ? 0.84 : claims.length ? 0.70 : 0.56;
      // Blend the current public intent with the player's observed spending fraction; prior history is a style signal, not destiny.
      const historyBlend = Math.min(0.42, history.roundsObserved * 0.18);
      const spendRate = U.clamp(baseSpendRate * (1 - historyBlend) + history.averageSpendRatio * historyBlend, 0.35, 1);
      let concentration = Math.min(0.22, Math.max(0, history.averagePrimaryShare - 0.40) * 0.55 * Math.min(1, history.roundsObserved / 2));
      if (calls.length && concentration > 0) {
        const alignmentReliability = history.callAlignmentRate === null || !history.callRoundsObserved
          ? 1
          : 0.35 + 0.65 * ((history.callAlignmentRate * history.callRoundsObserved + 1.30) / (history.callRoundsObserved + 2));
        concentration *= alignmentReliability;
        names.forEach(name => {
          const callTarget = calls.includes(name) ? 1 / calls.length : 0;
          pref[name] = (pref[name] || 0) * (1 - concentration) + callTarget * concentration;
        });
      } else if (claims.length && concentration > 0) {
        const focused = [...names].sort((a, b) => (pref[b] || 0) - (pref[a] || 0))[0];
        names.forEach(name => { pref[name] = (pref[name] || 0) * (1 - concentration * 0.5) + (name === focused ? concentration * 0.5 : 0); });
      }
      const prefTotal = names.reduce((n, name) => n + Math.max(0, pref[name] || 0), 0) || 1;
      names.forEach(name => { pref[name] = Math.max(0, pref[name] || 0) / prefTotal; });
      const spendExpected = Math.min(chips, chips * spendRate);
      const prefs = names.map(name => ({ name, p: pref[name] || 0 }));
      projectedVoters.push({ id: player.id, chips, spendExpected, spendRate: round2(spendRate), pEvil: round2(pEvil), pGood: round2(1 - pEvil), preferences: prefs,
        explicitCall: calls.length > 0, history: { roundsObserved: history.roundsObserved,
          multiChipRate: round2(history.multiChipRate), averagePrimaryShare: round2(history.averagePrimaryShare),
          callAlignmentRate: history.callAlignmentRate == null ? null : round2(history.callAlignmentRate),
          multiChipRounds: history.multiChipRounds, averageSpendRatio: round2(history.averageSpendRatio) } });
      prefs.forEach(({ name, p }) => {
        const contribution = spendExpected * p;
        expected[name] += contribution;
        goodExpectedVotes[name] += contribution * (1 - pEvil);
        evilExpectedVotes[name] += contribution * pEvil;
        variance[name] += spendExpected * p * (1 - p) + (chips - spendExpected) * p * 0.20;
      });
      projectedTotal += spendExpected;
    });

    // 敵方協同票不是獨立樣本：若多名高壞人後驗玩家偏向同一獸首，增加該目標的共變異，
    // 避免把一支可能整隊同步的 3 票狼隊，錯估成三個完全獨立的隨機選擇。
    for (let i = 0; i < projectedVoters.length; i++) {
      for (let j = i + 1; j < projectedVoters.length; j++) {
        const a = projectedVoters[i], b = projectedVoters[j];
        const jointEvil = a.pEvil * b.pEvil;
        if (jointEvil < 0.035) continue;
        const prefA = Object.fromEntries(a.preferences.map(x => [x.name, x.p]));
        const prefB = Object.fromEntries(b.preferences.map(x => [x.name, x.p]));
        names.forEach(name => {
          const pa = prefA[name] || 0, pb = prefB[name] || 0;
          const explicitSameCall = a.explicitCall && b.explicitCall && pa >= 0.45 && pb >= 0.45;
          const concentratedSameTarget = pa >= 0.58 && pb >= 0.58;
          if (!explicitSameCall && !concentratedSameTarget) return;
          const rho = explicitSameCall ? 0.24 : 0.14;
          coordinationVariance[name] += 2 * rho * jointEvil * Math.min(a.spendExpected, b.spendExpected) * pa * pb;
        });
      }
    }
    names.forEach(name => { variance[name] += coordinationVariance[name]; });

    const topTwo = probabilitiesTopTwo(names, expected, variance);
    const ranking = names.map(name => ({
      name,
      expectedVotes: round2(expected[name]),
      observedVotes: observed[name],
      variance: round2(variance[name]),
      pTopTwo: round2(topTwo[name]),
      callSupport: callSupport[name],
      claimSupport: claimSupport[name]
    })).sort((a, b) => b.expectedVotes - a.expectedVotes || zodiacIndex(a.name) - zodiacIndex(b.name));
    const consensus = [...names].sort((a, b) => callSupport[b] - callSupport[a] || claimSupport[b] - claimSupport[a] || expected[b] - expected[a])[0] || null;
    return {
      round: room.currentRoundIdx + 1,
      expectedVotes: expected,
      observedVotes: observed,
      variance,
      pTopTwo: topTwo,
      callSupport,
      claimSupport,
      goodExpectedVotes,
      evilExpectedVotes,
      coordinationVariance,
      coalitionTarget: names.slice().sort((a, b) => (evilExpectedVotes[b] + coordinationVariance[b]) - (evilExpectedVotes[a] + coordinationVariance[a]))[0] || null,
      consensusBeast: consensus,
      consensusCallers: consensus ? callSupport[consensus] : 0,
      projectedTotalVotes: round2(projectedTotal + observedTotal),
      observedTotalVotes: observedTotal,
      projectedVoters,
      historicalHeavyVoters: projectedVoters.filter(v => v.history && v.history.roundsObserved > 0 && v.history.multiChipRate >= 0.5).map(v => ({
        id: v.id, multiChipRate: v.history.multiChipRate, averagePrimaryShare: v.history.averagePrimaryShare,
        averageSpendRatio: v.history.averageSpendRatio
      })),
      ranking
    };
  }

  function zodiacIndex(name) {
    const list = GD.ZODIAC || [];
    const i = list.indexOf(name);
    return i < 0 ? 99 : i;
  }

  /** 用成對比較機率估算每尊獸首進入前二的機率，避免把期望票數當作確定名次。 */
  function probabilitiesTopTwo(names, mean, variance) {
    const out = {};
    // 當所有剩餘票勢都沒有不確定性時，直接套用 Rules.tally 的確定排序：票數高者優先，同票按生肖順序。
    // 不再用連續常態近似把確定同票誤當成各半機率。
    const deterministic = names.every(name => Math.abs(Number(variance[name]) || 0) < 1e-9);
    if (deterministic) {
      const ranked = names.slice().sort((a, b) =>
        (Number(mean[b]) || 0) - (Number(mean[a]) || 0) || zodiacIndex(a) - zodiacIndex(b));
      names.forEach(name => { out[name] = ranked.indexOf(name) < 2 ? 1 : 0; });
      return out;
    }
    names.forEach(name => {
      let dp = [1, 0, 0, 0];
      names.filter(other => other !== name).forEach(other => {
        // tally() 的平手規則是生肖序較前者勝出；以 ±0.5 票連續性修正對應整數平手優先權。
        const tieCorrection = zodiacIndex(other) < zodiacIndex(name) ? 0.5 : -0.5;
        const scale = Math.max(1.05, Math.sqrt(Math.max(0.1, variance[name] || 0) + Math.max(0.1, variance[other] || 0) + 1) * 1.18);
        const pOtherAbove = sigmoid(((Number(mean[other]) || 0) - (Number(mean[name]) || 0) + tieCorrection) / scale);
        const next = [0, 0, 0, 0];
        for (let count = 0; count < dp.length; count++) {
          next[count] += dp[count] * (1 - pOtherAbove);
          if (count + 1 < next.length) next[count + 1] += dp[count] * pOtherAbove;
        }
        dp = next;
      });
      out[name] = U.clamp(dp[0] + dp[1], 0, 1);
    });
    return out;
  }

  function posteriorMap(post, room) {
    const map = {};
    (post || []).forEach(x => {
      if (!x || !x.name) return;
      const p = Number.isFinite(Number(x.pReal)) ? Number(x.pReal) : Number.isFinite(Number(x.p)) ? Number(x.p) : null;
      if (p !== null) map[x.name] = U.clamp(p, 0, 1);
    });
    const rd = currentRound(room);
    (rd && rd.beasts || []).forEach(b => { if (!Number.isFinite(map[b.name])) map[b.name] = 0.5; });
    return map;
  }

  /**
   * 壞人公開資訊下的贗品集火選擇：只使用公開發言、已投票、票數預測與自己視角的真偽後驗。
   * 當原目標明顯落後，且另一尊低真偽後驗的贗品更有機會進前二時，允許反向分票／轉移。
   */
  function chooseEvilCoalitionTarget(room, botOrId, mindRecord) {
    const rd = currentRound(room);
    const names = beastNames(rd);
    if (!rd || !names.length || !mindRecord) return null;
    const post = posteriorMap(mindRecord.post, room);
    const forecast = forecastVotes(room, botOrId, mindRecord.beliefProfile || null);
    const current = names.includes(mindRecord.beast) ? mindRecord.beast : null;
    const rows = names.map(name => ({
      name,
      pReal: Number.isFinite(post[name]) ? post[name] : 0.5,
      pTopTwo: U.clamp(Number(forecast.pTopTwo && forecast.pTopTwo[name]) || 0, 0, 1),
      expectedVotes: Number(forecast.expectedVotes && forecast.expectedVotes[name]) || 0,
      callSupport: Number(forecast.callSupport && forecast.callSupport[name]) || 0
    }));
    const fakeRows = rows.filter(row => row.pReal <= 0.48)
      .sort((a, b) => (b.pTopTwo + Math.min(3, b.callSupport) * 0.018) -
        (a.pTopTwo + Math.min(3, a.callSupport) * 0.018) || b.expectedVotes - a.expectedVotes);
    if (!fakeRows.length) return { current, target: current, shouldRedirect: false, reason: 'no-supported-counterfeit' };
    const best = fakeRows[0];
    const own = rows.find(row => row.name === current) || null;
    if (!own || best.name === current) return { current, target: current, shouldRedirect: false, reason: 'current-target-best' };
    const gap = best.pTopTwo - own.pTopTwo;
    const currentUnderdog = own.pTopTwo < 0.42 && best.pTopTwo >= 0.42;
    const decisiveAdvantage = gap >= 0.12 && best.pTopTwo >= 0.38;
    const shouldRedirect = currentUnderdog || decisiveAdvantage;
    return {
      current, target: shouldRedirect ? best.name : current, shouldRedirect,
      reason: currentUnderdog ? 'current-target-underdog' : decisiveAdvantage ? 'higher-counterfeit-top-two' : 'insufficient-top-two-gap',
      gap: round2(gap),
      currentPTopTwo: round2(own.pTopTwo), targetPTopTwo: round2(best.pTopTwo),
      currentExpectedVotes: round2(own.expectedVotes), targetExpectedVotes: round2(best.expectedVotes),
      targetCallSupport: best.callSupport, targetPReal: round2(best.pReal),
      publicRanking: rows.slice().sort((a, b) => b.expectedVotes - a.expectedVotes).map(row => ({
        name: row.name, expectedVotes: round2(row.expectedVotes), pTopTwo: round2(row.pTopTwo),
        pReal: round2(row.pReal), callSupport: row.callSupport
      }))
    };
  }

  function forecastExpectedRealTopTwo(forecast, post) {
    const pm = posteriorMap(post, null);
    return Object.keys(forecast.pTopTwo || {}).reduce((n, name) => n + (forecast.pTopTwo[name] || 0) * (Number.isFinite(pm[name]) ? pm[name] : 0.5), 0);
  }

  /** 估算好人保真分數：公開第二名用確定結果；封存第一名只用本 Bot 保存的後驗。 */
  function scoreProjection(room, bot, currentPost, currentForecast, beliefProfile = null) {
    const idx = Number(room && room.currentRoundIdx) || 0;
    const botId = bot && bot.id;
    let completedExpected = 0;
    let publicRank2RealPoints = 0;
    let hiddenRank1Expected = 0;
    let completedRounds = 0;
    for (let i = 0; i < (room.rounds || []).length; i++) {
      const rd = room.rounds[i];
      if (!rd || !rd.voteResults) continue;
      completedRounds++;
      if (rd.voteResults.rank2 && rd.voteResults.rank2.isReal) publicRank2RealPoints++;
      const mind = rd.mind && rd.mind[botId];
      const post = i === idx && currentPost ? currentPost : mind && mind.post;
      const one = (post || []).find(x => x && x.name === rd.voteResults.rank1.name);
      const p = one && Number.isFinite(Number(one.pReal)) ? Number(one.pReal)
        : one && Number.isFinite(Number(one.p)) ? Number(one.p) : 0.5;
      hiddenRank1Expected += U.clamp(p, 0, 1);
      completedExpected += (rd.voteResults.rank2 && rd.voteResults.rank2.isReal ? 1 : 0) + U.clamp(p, 0, 1);
    }
    let currentExpected = 0;
    if (currentForecast && !currentRound(room)?.voteResults) currentExpected = forecastExpectedRealTopTwo(currentForecast, currentPost);
    const expectedSavedReal = completedExpected + currentExpected;
    const threshold = Number(GD.CONFIG && GD.CONFIG.WIN_SCORE) || 6;

    const roleProb = (player, role) => {
      if (player && player.id === botId) return bot.role === role ? 1 : 0;
      const rec = beliefProfile && beliefProfile[player && player.id];
      const value = rec && rec.probs && Number(rec.probs[role]);
      return Number.isFinite(value) ? U.clamp(value / 100, 0, 1) : 0;
    };
    const candidates = (room.players || []).filter(p => p && p.id !== botId);
    const maxRole = role => Math.max(bot.role === role ? 1 : 0, 0, ...candidates.map(p => roleProb(p, role)));
    const pLao = maxRole('老朝奉');
    const pYao = maxRole('藥不然');
    const pFang = maxRole('方震');
    const pXu = maxRole('許願');
    // 能否抓出老朝奉取決於角色後驗及終局證據收斂；抓到方震／許願則是反向風險。
    const laoDetection = U.clamp(0.28 + 0.62 * pLao, 0.20, 0.88);
    const fangExposure = U.clamp(0.30 + 0.50 * pFang, 0.20, 0.82);
    const xuExposure = U.clamp(0.30 + 0.52 * pXu, 0.20, 0.85);
    const pLaoCaught = U.clamp(pLao * laoDetection, 0, 1);
    const pFangCaught = U.clamp(pYao * pFang * fangExposure, 0, 1);
    const pXuCaught = U.clamp(pLao * pXu * xuExposure, 0, 1);
    const expectedRoleBonuses = pLaoCaught + (1 - pFangCaught) + 2 * (1 - pXuCaught);
    const expectedTotalScore = expectedSavedReal + expectedRoleBonuses;
    const roundsRemaining = Math.max(0, 3 - completedRounds);
    const uncertaintyScale = 2.75 + 0.25 * roundsRemaining + 0.12 * Math.sqrt(completedRounds);
    const estimatedWinProbability = sigmoid((expectedTotalScore - threshold) / uncertaintyScale);
    return {
      completedRounds, publicRank2RealPoints, hiddenRank1Expected: round2(hiddenRank1Expected),
      completedExpectedSavedReal: round2(completedExpected), currentExpectedSavedReal: round2(currentExpected),
      expectedSavedReal: round2(expectedSavedReal), winScore: threshold,
      pointsNeededBeforeRoleBonuses: round2(Math.max(0, threshold - expectedSavedReal)),
      expectedRoleBonuses: round2(expectedRoleBonuses),
      roleBonusBreakdown: { laoCaught: round2(pLaoCaught), fangSurvives: round2(1 - pFangCaught), xuSurvives: round2(2 * (1 - pXuCaught)) },
      rolePosteriorMaxima: { lao: round2(pLao), yao: round2(pYao), fang: round2(pFang), xu: round2(pXu) },
      expectedTotalScore: round2(expectedTotalScore),
      pointsNeededAfterExpectedRoleBonuses: round2(Math.max(0, threshold - expectedTotalScore)),
      estimatedWinProbability: round2(estimatedWinProbability),
      probabilityCalibration: { method: 'wide-logistic-small-sample', uncertaintyScale: round2(uncertaintyScale), roundsRemaining,
        isHeuristic: true, requiresPairedSeedAndHumanCalibration: true },
      note: '以本 Bot 自己的角色後驗估計保真與終局任務效用；機率是保守啟發式，不是實測勝率，也不讀取其他 AI 私有心智或真實身分'
    };
  }

  function voteSpendLimit(room, bot, mindRecord) {
    const bank = chipsAvailable(room, bot);
    if (bank <= 1) return bank;
    // 認壞／跳壞表演的票向是公開承諾契約，維持原有完整籌碼上限，
    // 避免在票型收尾時被一般保留策略削弱；一般票型才使用個人化上限。
    if (!GD.isGood(bot.role) && mindRecord &&
        (mindRecord.mode === 'confess' || mindRecord.confess || mindRecord.evilRolePerformance)) return bank;
    const idx = Math.max(0, Number(room && room.currentRoundIdx) || 0);
    if (idx >= 2) return bank;

    const names = beastNames(currentRound(room));
    if (!names.length || !mindRecord) return Math.max(1, bank - 1);
    const isGood = GD.isGood(bot.role);
    const post = posteriorMap(mindRecord.post, room);
    const anchor = names.includes(mindRecord.beast) ? mindRecord.beast :
      [...names].sort((a, b) => (post[b] || 0.5) - (post[a] || 0.5) || zodiacIndex(a) - zodiacIndex(b))[0];
    const targetConfidence = U.clamp(isGood ? (post[anchor] ?? 0.5) : 1 - (post[anchor] ?? 0.5), 0, 1);
    const forecast = forecastVotes(room, bot.id, mindRecord.beliefProfile);
    const targetTopTwo = U.clamp(Number(forecast.pTopTwo && forecast.pTopTwo[anchor]) || 0, 0, 1);
    const racePressure = U.clamp((0.65 - targetTopTwo) / 0.65, 0, 1);

    let scorePressure = racePressure;
    if (isGood) {
      const score = scoreProjection(room, bot, mindRecord.post, forecast, mindRecord.beliefProfile);
      const roundsLeft = Math.max(1, 3 - idx);
      const requiredPerRemaining = score.pointsNeededAfterExpectedRoleBonuses / (roundsLeft * 2);
      scorePressure = U.clamp((requiredPerRemaining - 0.72) / 0.80, 0, 1);
    }

    const genes = bot.genes || (GD.Genes && GD.Genes.load ? GD.Genes.load(bot.botId) : {});
    const assertiveness = U.clamp(Number(genes.assertiveness) || 0.5, 0, 1);
    const conformity = U.clamp(Number(genes.conformity) || 0.5, 0, 1);
    const deception = U.clamp(Number(genes.deception) || 0.5, 0, 1);
    const camouflage = U.clamp(Number(genes.camouflage) || 0.5, 0, 1);
    const skepticism = U.clamp(Number(genes.skepticism) || 0.5, 0, 1);
    const stylePush = U.clamp(
      0.50 * assertiveness + 0.20 * conformity + 0.15 * deception +
      0.10 * camouflage + 0.05 * (1 - skepticism), 0, 1
    );
    const commitment = 0.55 * stylePush + 0.20 * targetConfidence +
      0.15 * racePressure + 0.10 * scorePressure;
    const threshold = idx === 0 ? 0.56 : 0.49;
    return commitment >= threshold ? bank : Math.max(1, bank - 1);
  }

  function enumerateAllocations(names, anchor, maxSpend) {
    const out = [];
    const limits = Math.max(0, Math.floor(Number(maxSpend) || 0));
    // 零票是合法候選：保留全部籌碼，不因公開主張而被強制落票。
    out.push(Object.fromEntries(names.map(name => [name, 0])));
    for (let spend = 1; spend <= limits; spend++) {
      const counts = Object.fromEntries(names.map(name => [name, 0]));
      function walk(i, remaining) {
        if (i >= names.length) {
          if (remaining === 0) out.push({ ...counts });
          return;
        }
        const name = names[i];
        for (let n = 0; n <= remaining; n++) {
          counts[name] = n;
          walk(i + 1, remaining - n);
        }
        counts[name] = 0;
      }
      walk(0, spend);
    }
    return out;
  }

  /** 用目前 Bot 自己的後驗評估可行票型；第一張票保留在本輪公開主張目標，其餘可分票或留到下一輪。 */
  function optimizeBallot(room, bot, mindRecord, maxSpend) {
    const rd = currentRound(room);
    const names = beastNames(rd);
    if (!rd || !names.length || !bot || !mindRecord) return null;
    const bank = chipsAvailable(room, bot);
    const cap = Math.max(0, Math.min(bank, Math.floor(Number(maxSpend === undefined ? bank : maxSpend) || 0)));
    if (cap <= 0) return { ballot: {}, diagnostic: null };
    const post = posteriorMap(mindRecord.post, room);
    let anchor = names.includes(mindRecord.beast) ? mindRecord.beast : null;
    if (!anchor) anchor = [...names].sort((a, b) => (post[b] || 0.5) - (post[a] || 0.5) || zodiacIndex(a) - zodiacIndex(b))[0];
    const base = forecastVotes(room, bot.id, mindRecord.beliefProfile);
    const choices = enumerateAllocations(names, anchor, cap);
    if (!choices.length) return { ballot: {}, diagnostic: null };

    const isGood = GD.isGood(bot.role);
    const idx = Math.max(0, Number(room.currentRoundIdx) || 0);
    const genes = bot.genes || (GD.Genes && GD.Genes.load ? GD.Genes.load(bot.botId) : {});
    const assertiveness = U.clamp(Number(genes.assertiveness) || 0.5, 0, 1);
    const conformity = U.clamp(Number(genes.conformity) || 0.5, 0, 1);
    const deception = U.clamp(Number(genes.deception) || 0.5, 0, 1);
    const camouflage = U.clamp(Number(genes.camouflage) || 0.5, 0, 1);
    const skepticism = U.clamp(Number(genes.skepticism) || 0.5, 0, 1);
    const spendStyle = U.clamp(0.50 * assertiveness + 0.20 * conformity + 0.15 * deception +
      0.10 * camouflage + 0.05 * (1 - skepticism), 0, 1);
    const targetConfidence = U.clamp(isGood ? (post[anchor] ?? 0.5) : 1 - (post[anchor] ?? 0.5), 0, 1);
    const baseTopTwo = probabilitiesTopTwo(names, base.expectedVotes, base.variance);
    const baseExpectedGoodPoints = names.reduce((n, name) => n + (baseTopTwo[name] || 0) * (post[name] ?? 0.5), 0);
    const globalScore = scoreProjection(room, bot, mindRecord.post, base, mindRecord.beliefProfile);
    const racePressure = U.clamp((0.65 - (baseTopTwo[anchor] || 0)) / 0.65, 0, 1);
    const holdStyleFactor = U.clamp(1.38 - spendStyle, 0.45, 1.30);
    const confidenceFactor = 1 - 0.22 * targetConfidence;
    const urgencyFactor = 1 - 0.20 * racePressure;
    const futureChipValue = (idx === 0 ? 0.085 : idx === 1 ? 0.040 : 0) *
      holdStyleFactor * confidenceFactor * urgencyFactor;
    // 早期一票有資訊價值：讓投票者表態可供後續校準；回合越晚，這項誘因越弱。
    // 保留零票候選，當所有目標的預期損失高於參與價值時仍可棄票。
    const participationBonus = idx === 0 ? 0.11 : idx === 1 ? 0.065 : 0.02;
    let best = null;
    choices.forEach(ballot => {
      const mean = { ...base.expectedVotes };
      names.forEach(name => { mean[name] = (mean[name] || 0) + (ballot[name] || 0); });
      const pTop = probabilitiesTopTwo(names, mean, base.variance);
      const expectedGoodPoints = names.reduce((n, name) => n + (pTop[name] || 0) * (post[name] ?? 0.5), 0);
      const marginalPoints = expectedGoodPoints - baseExpectedGoodPoints;
      const projectedWin = sigmoid((globalScore.expectedTotalScore + marginalPoints - globalScore.winScore) / 0.78);
      let utility = isGood ? projectedWin + expectedGoodPoints * 0.025 : -projectedWin;
      let counterfeitTopTwoGain = 0;
      if (!isGood) {
        // 壞人不只追求「假貨的前二機率」，還要獎勵本次投票真正帶來的增幅；
        // 否則所有票型共享相同的靜態目標分數，難以學會把落後贗品推過前二門檻。
        counterfeitTopTwoGain = names.reduce((n, name) =>
          n + ((pTop[name] || 0) - (baseTopTwo[name] || 0)) * (1 - (post[name] ?? 0.5)), 0);
        utility += counterfeitTopTwoGain * (idx === 2 ? 0.42 : 0.34);
        // 原先 padBeast 仍是弱偏好，不可蓋過更有機會進前二的替代目標。
        if (mindRecord.padBeast && names.includes(mindRecord.padBeast)) utility += (pTop[mindRecord.padBeast] || 0) * 0.02;
      }
      const spent = sum(ballot);
      const held = Math.max(0, cap - spent);
      utility += held * futureChipValue;
      const firstVoteBonus = spent > 0 ? participationBonus : 0;
      utility += firstVoteBonus;
      let coordinationBonus = 0;
      if (isGood && spent > 0) {
        const speechCount = Math.max(1, (rd.speeches || []).filter(sp => sp && String(sp.playerId) !== String(bot.id)).length);
        const allocatedShare = names.reduce((n, name) => n + (Number(ballot[name]) || 0), 0) || 1;
        names.forEach(name => {
          const support = Math.max(0, Number(base.callSupport && base.callSupport[name]) || 0);
          const posteriorAgreement = U.clamp(((post[name] ?? 0.5) - 0.50) / 0.40, 0, 1);
          // Own speech is also in base.callSupport; discount one potential self-call to keep this a public-peer signal.
          const ownCall = (rd.speeches || []).some(sp => String(sp.playerId) === String(bot.id) &&
            ((parseSpeech(sp, room, rd).callBeasts || []).includes(name) || parseSpeech(sp, room, rd).callBeast === name)) ? 1 : 0;
          const independentSupport = Math.max(0, support - ownCall);
          const consensusStrength = U.clamp(independentSupport / speechCount, 0, 0.75);
          coordinationBonus += (Number(ballot[name]) || 0) / allocatedShare * consensusStrength * posteriorAgreement * (idx === 2 ? 0.12 : 0.075);
        });
        coordinationBonus = U.clamp(coordinationBonus, 0, idx === 2 ? 0.12 : 0.075);
        utility += coordinationBonus;
      }
      // 號召力高的玩家對「多投入一枚票」有較高行動偏好；只獎勵第一枚追加票，
      // 且隨回合減弱，避免高 assertiveness 變成無條件全押或大幅偏離算票收益。
      const commitmentBonus = spent > 1
        ? (idx === 0 ? 0.045 : idx === 1 ? 0.035 : 0.020) * spendStyle
        : 0;
      utility += commitmentBonus;
      // 效益相近時仍由個人保留成本與行動風格共同決定，不再讓全體套用同一留票門檻。
      if (!best || utility > best.utility + 1e-8) best = { ballot, utility, expectedGoodPoints, pTop, forecastAfter: mean, spent, held, commitmentBonus, firstVoteBonus, coordinationBonus, counterfeitTopTwoGain };
    });
    const clean = {};
    Object.entries(best.ballot).forEach(([name, n]) => { if (n > 0) clean[name] = n; });
    return {
      ballot: clean,
      diagnostic: {
        anchor,
        expectedGoodPoints: round2(best.expectedGoodPoints),
        projectedTopTwo: [...names].sort((a, b) => (best.pTop[b] || 0) - (best.pTop[a] || 0)).slice(0, 2),
        before: base.ranking,
        after: names.map(name => ({ name, expectedVotes: round2(best.forecastAfter[name]), pTopTwo: round2(best.pTop[name]), pReal: round2(post[name] ?? 0.5) }))
          .sort((a, b) => b.expectedVotes - a.expectedVotes || zodiacIndex(a.name) - zodiacIndex(b.name)),
        spent: best.spent,
        held: Math.max(0, bank - best.spent),
        futureChipValue: round2(futureChipValue),
        commitmentBonus: round2(best.commitmentBonus || 0),
        firstVoteBonus: round2(best.firstVoteBonus || 0),
        participationBonus: round2(participationBonus),
        coordinationBonus: round2(best.coordinationBonus || 0),
        spendStyle: round2(spendStyle),
        targetConfidence: round2(targetConfidence),
        racePressure: round2(racePressure),
        counterfeitTopTwoGain: round2(best.counterfeitTopTwoGain || 0),
        objective: isGood ? 'max_expected_whole_game_win_probability' : 'minimize_good_win_probability_and_raise_fake_top_two_probability',
        baseExpectedGoodPoints: round2(baseExpectedGoodPoints), marginalExpectedGoodPoints: round2(best.expectedGoodPoints - baseExpectedGoodPoints),
        baselineWinProbability: globalScore.estimatedWinProbability,
        projectedWinProbability: round2(sigmoid((globalScore.expectedTotalScore + best.expectedGoodPoints - baseExpectedGoodPoints - globalScore.winScore) / 0.78))
      }
    };
  }

  function choosePublicTactic(state = {}) {
    if (state.unsupportedTell) return 'sourceAudit';
    if (state.echoedConsensus) return 'echoBrake';
    if (state.pairGuardReady) return 'pairGuard';
    if (state.marginalStopReady) return 'marginalStop';
    if (state.plannedPivotReady) return 'plannedPivot';
    return null;
  }

  function publicNarrative(room, bot, A, plan, seed) {
    const forecast = forecastVotes(room, bot.id, A && A.prof);
    const score = scoreProjection(room, bot, A && A.post, forecast, A && A.prof);
    const ranking = forecast.ranking || [];
    const beast = forecast.consensusBeast || plan.beast || (ranking[0] && ranking[0].name) || '';
    const other = ranking.find(x => x.name !== beast);
    const target = plan.suspectId && U.byId(room, plan.suspectId);
    const frame = plan.roleSwapTrap || plan.ambushFrame || plan.ambushFrameHypothesis || null;
    const vars = {
      beast,
      otherBeast: other ? other.name : beast,
      first: frame && frame.firstId ? U.tag(U.byId(room, frame.firstId)) : '第一位',
      second: frame && frame.secondId ? U.tag(U.byId(room, frame.secondId)) : '第二位',
      victim: frame && frame.victimId ? U.tag(U.byId(room, frame.victimId)) : '被偷襲者',
      votes: Math.round(forecast.expectedVotes[beast] || 0),
      gap: round2((forecast.expectedVotes[beast] || 0) - (other ? other.expectedVotes : 0)),
      publicPoints: score.publicRank2RealPoints,
      expectedSaved: score.expectedSavedReal.toFixed(1),
      needed: score.pointsNeededBeforeRoleBonuses.toFixed(1),
      winScore: score.winScore,
      target: target ? U.tag(target) : '目前被點名的對象',
      role: plan.roleBluff && plan.roleBluff.role || '某個角色',
      round: room.currentRoundIdx + 1,
      callers: forecast.consensusCallers,
      heavyVoterCount: (forecast.historicalHeavyVoters || []).length,
      observedMultiChipCount: Object.values(((room.rounds || [])[room.currentRoundIdx] || {}).votes || {}).filter(ballot =>
        Object.values(ballot || {}).some(value => (Number(value) || 0) >= 2)).length
    };
    const t = room.currentRoundIdx;
    const rd = room.rounds[t];
    const currentSpeeches = (rd && rd.speeches) || [];
    let category = 'tempo';

    // 「一名角色宣稱」不等於「角色對跳」。先依不同 playerId 計數，避免單一跳職就觸發「兩人都…」類台詞。
    const roleClaimersByRole = new Map();
    let publicIdentityClaimCount = 0;
    currentSpeeches.forEach(sp => {
      if (!sp || !sp.playerId) return;
      let role = sp.p && sp.p.selfRole;
      if (!role && GD.Claims && typeof GD.Claims.parse === 'function') {
        try { role = GD.Claims.parse(String(sp.text || ''), room, rd).selfRole; } catch (_) {}
      }
      if (!role) return;
      publicIdentityClaimCount++;
      // 「平民」只是偽裝標籤，不是唯一遊戲角色；不同角色的不同宣稱也不構成互相對跳。
      if (role === '平民') return;
      if (!roleClaimersByRole.has(role)) roleClaimersByRole.set(role, new Map());
      roleClaimersByRole.get(role).set(sp.playerId, sp);
    });
    const existingContest = [...roleClaimersByRole.entries()]
      .find(([, claimers]) => claimers.size >= 2) || null;
    const plannedRole = plan.roleBluff && plan.roleBluff.role && plan.roleBluff.role !== '平民'
      ? plan.roleBluff.role : null;
    const plannedRoleClaimers = plannedRole ? roleClaimersByRole.get(plannedRole) : null;
    const plannedClaimCollides = !!(plannedRoleClaimers && plannedRoleClaimers.size >= 1);
    const hasRoleClaim = publicIdentityClaimCount >= 1;
    const hasRoleContest = !!existingContest || plannedClaimCollides;
    // 優先點出與自己當前假跳直接衝突的角色；否則處理場上已形成的同角色對跳。
    const activeContestRole = plannedClaimCollides ? plannedRole : (existingContest ? existingContest[0] : null);
    const activeContestClaimers = activeContestRole ? new Map(roleClaimersByRole.get(activeContestRole) || []) : new Map();
    const plannedClaimCount = activeContestRole && plannedRole === activeContestRole && !activeContestClaimers.has(bot.id) ? 1 : 0;
    const activeContestCount = activeContestClaimers.size + plannedClaimCount;
    if (activeContestRole) {
      vars.role = activeContestRole;
      vars.claimCount = activeContestCount;
      const names = [...activeContestClaimers.keys()].map(id => U.tag(U.byId(room, id))).filter(Boolean);
      if (plannedClaimCount) names.push('我');
      vars.claimers = names.join('、') || '尚未辨識的玩家';
    } else {
      vars.role = plannedRole || vars.role || '某個角色';
      vars.claimCount = 0;
      vars.claimers = '目前的宣稱者';
    }
    const hasMicroSignal = !!(GD.DialogueBank && currentSpeeches.some(sp =>
      sp && GD.DialogueBank.detectRoleSignal(String(sp.text || ''))));
    const targetId = plan.followHuman && plan.followHuman.targetId || plan.suspectId;
    const targetTag = targetId ? U.tag(U.byId(room, targetId)) : '';
    const sameTargetCalls = targetId ? currentSpeeches.filter(sp => {
      if (!sp) return false;
      const parsed = parseSpeech(sp, room, rd);
      return parsed.callSuspectId === targetId || (parsed.accuse || []).some(a => a && a.playerId === targetId);
    }).length : 0;
    const quoteEchoes = currentSpeeches.filter(sp =>
      sp && /(?:曾公開指稱|先前說|公開說過|剛才的原話|原話是)/.test(String(sp.text || ''))).length;
    const voteRank = [...ranking].sort((a, b) => b.expectedVotes - a.expectedVotes);
    const voteGap = voteRank.length > 1 ? voteRank[0].expectedVotes - voteRank[1].expectedVotes : 0;
    const roleBonusMoment = score.expectedSavedReal < score.winScore && score.expectedSavedReal >= score.winScore - 3;
    const hasPartnerCoordination = !!(plan.inferredBuddyId || plan.partnerBeast || plan.followHuman || (A && A.ctx && A.ctx.partner));

    // Situation selector: these public strategies are triggered only by visible, auditable state.
    const unsupportedTell = currentSpeeches.some(sp =>
      sp && /(?:眼神|微表情|肢體(?:僵硬|反應)|音準|聲音(?:發抖|顫抖)|臉色|面色|呼吸急促).{0,16}(?:看出|證明|代表|顯示|心虛|可疑|緊張)/.test(String(sp.text || '')));
    const echoedConsensus = !!(forecast.consensusBeast && forecast.consensusCallers >= 3 &&
      (forecast.claimSupport[forecast.consensusBeast] || 0) <= 1);
    const postRows = Array.isArray(A && A.post) ? A.post.slice().sort((a, b) =>
      Number(b.pReal ?? b.p) - Number(a.pReal ?? a.p)) : [];
    const pairGuardReady = t >= 1 && postRows.length >= 2 &&
      Number(postRows[0].pReal ?? postRows[0].p) >= 0.57 &&
      Number(postRows[1].pReal ?? postRows[1].p) >= 0.52;
    const leadingBeast = voteRank[0] && voteRank[0].name;
    const marginalStopReady = t >= 1 && leadingBeast &&
      Number(forecast.pTopTwo && forecast.pTopTwo[leadingBeast]) >= 0.84 && voteGap >= 2.5;
    const plannedPivotReady = !!(plan.beast && forecast.consensusBeast &&
      plan.beast !== forecast.consensusBeast && (plan.coalitionRedirect || plan.padBeast || plan.partnerBeast || plan.mode === 'split'));
    const tacticalStrategy = choosePublicTactic({ unsupportedTell, echoedConsensus, pairGuardReady, marginalStopReady, plannedPivotReady });

    if (plan.ambushFrame) category = 'ambushFrame';
    else if (plan.roleSwapTrap || (plan.roleBluff && plan.roleBluff.origin === 'ambush-role-swap')) category = 'roleSwap';
    else if (plan.ambushFrameHypothesis) category = 'passOrderTrap';
    else if (plan.roleBluff && plan.roleBluff.persist && plan.roleBluff.continued) category = 'longCon';
    else if (plan.roleBluff && plan.roleBluff.persist) category = 'persistentDenial';
    else if (hasRoleContest && !plan.fakeFangClaim) category = 'roleContestAudit';
    else if (plan.roleBluff || plan.fakeFangClaim) category = 'roleBluff';
    else if (hasRoleClaim) category = 'identityAudit';
    else if (tacticalStrategy === 'sourceAudit') category = 'sourceAuditTactics';
    else if (tacticalStrategy === 'echoBrake') category = 'echoBrakeTactics';
    else if (tacticalStrategy === 'pairGuard') category = 'pairGuardTactics';
    else if (tacticalStrategy === 'marginalStop') category = 'marginalStopTactics';
    else if (tacticalStrategy === 'plannedPivot') category = 'plannedPivotTactics';
    else if (hasMicroSignal) category = 'microSignalAnalysis';
    else if (roleBonusMoment && t >= 1) category = 'scoreTradeoff';
    else if (sameTargetCalls >= 2) category = 'crowdPressureAudit';
    else if (quoteEchoes >= 2) category = 'sourceIndependence';
    else if (A && A.topSuspect && A.topSuspect.conflicts && A.topSuspect.conflicts.length) category = 'claimConsistency';
    else if (plan.askId) category = 'ballotCommitment';
    else if (t >= 2) category = 'endgameRoleTradeoff';
    else if (forecast.consensusCallers >= 2) category = 'voteMath';
    else if (voteGap <= 1.4) category = 'voteUncertainty';
    else if (plan.explain || (A && A.askedMe)) category = 'defense';
    else if (hasPartnerCoordination) category = 'alliance';
    else if (plan.suspectId || plan.followHuman) category = 'pressure';
    else if (!GD.isGood(bot.role)) category = 'deception';
    else category = 'tempo';

    // 真方震禁止公開角色名；改用不含該角色名的通用推理類別。
    if (bot.role === '方震' && ['roleBluff', 'roleContest', 'roleContestAudit', 'identityAudit'].includes(category)) category = 'evidence';
    const stableSeed = Number.isFinite(seed) ? seed : GD.DialogueBank.hash(`${bot.botId || bot.id}:${t}:${A && A.ctx ? A.ctx.myPos : 0}`);
    const line = GD.DialogueBank ? GD.DialogueBank.pick(category, stableSeed, vars) : '';
    return { forecast, score, category, line, strategy: tacticalStrategy };
  }

  T.forecastVotes = forecastVotes;
  T.chooseEvilCoalitionTarget = chooseEvilCoalitionTarget;
  T.historicalBallotProfile = historicalBallotProfile;
  T.probabilitiesTopTwo = probabilitiesTopTwo;
  T.scoreProjection = scoreProjection;
  T.optimizeBallot = optimizeBallot;
  T.voteSpendLimit = voteSpendLimit;
  T.enumerateAllocations = enumerateAllocations;
  T.publicNarrative = publicNarrative;
  T.choosePublicTactic = choosePublicTactic;
  T.speechPreference = speechPreference;
  T.chipsAvailable = chipsAvailable;
  T.count = () => GD.DialogueBank && GD.DialogueBank.count ? GD.DialogueBank.count() : 0;
  GD.Tactics = T;
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
})(typeof window !== 'undefined' ? window : global);
