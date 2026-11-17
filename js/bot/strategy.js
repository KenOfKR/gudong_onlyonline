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

  S.collectPublicRoleHypotheses = function (room, excludeSpeakerId = null, throughRoundIndex = null) {
    const rounds = Array.isArray(room && room.rounds) ? room.rounds : [];
    const end = Number.isInteger(throughRoundIndex) ? Math.min(throughRoundIndex, rounds.length - 1) : rounds.length - 1;
    const hypotheses = new Map();
    for (let roundIndex = 0; roundIndex <= end; roundIndex++) {
      const historyRound = rounds[roundIndex];
      (historyRound && historyRound.speeches || []).forEach(sp => {
        if (!sp || !sp.playerId || String(sp.playerId) === String(excludeSpeakerId)) return;
        let parsed = sp.p || {};
        if (GD.Claims && GD.Claims.parseRecord) {
          try { parsed = GD.Claims.parseRecord(sp, room, historyRound); } catch (_) {}
        }
        const sourceRound = historyRound.roundNum || roundIndex + 1;
        const add = (candidateId, role, polarity, text) => {
          if (!candidateId || !role || role === '平民' || polarity === 'deny' || polarity === 'fake') return;
          const key = `${candidateId}|${role}`;
          if (!hypotheses.has(key)) hypotheses.set(key, {
            candidateId, role, sourceSpeakerId: sp.playerId, sourceRound,
            sourceText: String(text || '').slice(0, 180), sources: new Set()
          });
          hypotheses.get(key).sources.add(String(sp.playerId));
        };
        add(sp.playerId, parsed.selfRole, 'claim', sp.text);
        (parsed.roleClaims || []).forEach(claim => add(claim.playerId, claim.role, claim.polarity, claim.text || sp.text));
      });
    }
    return [...hypotheses.values()].map(item => ({ ...item, sources: [...item.sources] }));
  };

  // Mind.context() exposes a sanitized clone of the player's inspection log so audit-only flags
  // never enter decision logic. Strategy metadata still needs an explicit write-through to the
  // real private turn log; keep that mutation narrow and keyed only to the acting player's record.
  function persistOwnLog(ctx, patch) {
    if (!ctx || !patch || typeof patch !== 'object') return;
    const round = ctx.room && ctx.room.rounds && ctx.room.rounds[ctx.t];
    if (round && round.turnLogs && round.turnLogs[ctx.bot.id]) Object.assign(round.turnLogs[ctx.bot.id], patch);
    if (ctx.log) Object.assign(ctx.log, patch);
  }
  const zIdx = name => {
    const arr = (GD.CONFIG && GD.CONFIG.ZODIAC) || ZODIAC_LIST;
    const idx = arr.indexOf(name);
    return idx >= 0 ? idx : 99;
  };

  // Stable context hash: optional tactical branches must not shift the shared random stream.
  const stableRoll = text => ((GD.DialogueBank && GD.DialogueBank.hash
    ? GD.DialogueBank.hash(text) : Array.from(String(text || '')).reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0) % 10000) / 10000;

  // Single source of truth for public claims: merge structured metadata with parsed speech text.
  // Some older/generated records contain p.claims=[] even when the speaker clearly said a result.
  function publicSpeechData(sp, room, rd) {
    if (GD.Claims && typeof GD.Claims.parseRecord === 'function') {
      try { return GD.Claims.parseRecord(sp, room, rd) || {}; } catch (_) {}
    }
    if (sp && sp.p && typeof sp.p === 'object' && Object.keys(sp.p).length) return sp.p;
    if (GD.Claims && typeof GD.Claims.parse === 'function') {
      try { return GD.Claims.parse(String(sp && sp.text || ''), room, rd) || {}; } catch (_) {}
    }
    return {};
  }
  const publicSpeechClaims = (sp, room, rd) => {
    const data = publicSpeechData(sp, room, rd);
    return Array.isArray(data.claims) ? data.claims : [];
  };


  // Select one public-facing dialogue focus per turn. The focus is a presentation
  // contract, not a new game rule and not a disclosure of private reasoning.
  function deriveDialogueFocus(bot, room, plan, A) {
    const ctx = A && A.ctx || {};
    const rd = ctx.rd || U.curRound(room) || {};
    const genes = ctx.genes || {};
    const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0.5));
    const assertiveness = clamp01(genes.assertiveness);
    const camouflage = clamp01(genes.camouflage);
    const deception = clamp01(genes.deception);
    const skepticism = clamp01(genes.skepticism);
    const targetFor = id => id ? U.byId(room, id) : null;
    let type = 'vote';
    let targetId = null;
    let source = 'plan';
    let priority = 20;

    if (plan.publicRolePressure) {
      type = 'defend_identity';
      targetId = plan.publicRolePressure.speakerId || null;
      source = 'public_role_pressure';
      priority = 100;
    } else if (plan.explain) {
      type = 'defend_vote';
      source = 'direct_question';
      priority = 98;
    } else if (plan.askKind === 'role_swap' || plan.askKind === 'role_shift') {
      type = 'role_swap';
      targetId = plan.askId || null;
      source = 'role_claim_crosscheck';
      priority = 96;
    } else if (plan.askId) {
      type = 'challenge';
      targetId = plan.askId;
      source = plan.askKind || 'public_evidence';
      priority = 92;
    } else if (plan.socialTactic && plan.socialTactic.focus === 'attack' && plan.socialTactic.targetId) {
      type = 'suspect_pressure';
      targetId = plan.socialTactic.targetId;
      source = 'social_tactic';
      priority = 90;
    } else if (plan.socialTactic && plan.socialTactic.focus === 'bait' && plan.socialTactic.targetId) {
      type = 'reply_vote';
      targetId = plan.socialTactic.targetId;
      source = 'social_tactic_bait';
      priority = 84;
    } else if (plan.roleDiscussionEvent && plan.roleDiscussionEvent.candidateId) {
      type = 'role_probe';
      targetId = plan.roleDiscussionEvent.candidateId;
      source = 'public_role_hypothesis';
      priority = 88;
    } else {
      const thread = GD.Speech && typeof GD.Speech.latestPublicThread === 'function'
        ? GD.Speech.latestPublicThread(room, rd, bot) : null;
      if (thread && thread.speech && !thread.addressed) {
        const unanswered = thread.unanswered || {};
        targetId = thread.speech.playerId || null;
        if ((unanswered.roleClaims && unanswered.roleClaims.length) || unanswered.role) type = 'role_probe';
        else if (unanswered.stances && unanswered.stances.length) type = 'soft_accusation';
        else if (unanswered.defense) type = 'reply_defense';
        else if (unanswered.claims && unanswered.claims.length) type = 'reply_claim';
        else if (unanswered.call) type = 'reply_vote';
        else type = 'reply_public';
        source = 'unanswered_public_thread';
        priority = 82;
      } else if (plan.publicSuspectBrief || plan.suspectId) {
        type = 'suspect_pressure';
        targetId = plan.suspectId || (plan.publicSuspectTags && plan.publicSuspectTags[0] &&
          (room.players || []).find(player => U.tag(player) === plan.publicSuspectTags[0])?.id) || null;
        source = 'public_suspicion';
        priority = 65;
      } else if (plan.claims && plan.claims.length) {
        type = 'inspection_report';
        source = 'approved_public_claim';
        priority = 45;
      }
    }

    let style = 'conversational';
    if (type === 'defend_identity' || type === 'defend_vote' || type === 'reply_defense') {
      style = assertiveness >= 0.62 ? 'firm_defensive' : 'guarded';
    } else if (type === 'role_swap' || type === 'role_probe' || type === 'challenge' || type === 'soft_accusation') {
      style = assertiveness >= 0.68 ? 'direct' : skepticism >= 0.66 ? 'probing' : 'measured';
    } else if (!ctx.isGood && (plan.roleBluff || plan.evilRolePerformance)) {
      style = camouflage >= 0.66 || deception >= 0.70 ? 'subtle' : assertiveness >= 0.62 ? 'provocative' : 'persuasive';
    } else if (camouflage >= 0.68 && assertiveness < 0.48) {
      style = 'understated';
    } else if (assertiveness >= 0.72) {
      style = 'direct';
    } else if (skepticism >= 0.70) {
      style = 'probing';
    }

    const player = targetFor(targetId);
    const focusLabels = {
      defend_identity: '回應角色質疑', defend_vote: '解釋自己的票型', role_swap: '拆解角色互換',
      challenge: '追問具體證據', role_probe: '核對角色假設', soft_accusation: '回應人物指控',
      reply_defense: '回應玩家自辯', reply_claim: '回應前手查驗主張', reply_vote: '表態是否跟票',
      reply_public: '接續前手發言', suspect_pressure: '提出有根據的嫌疑', inspection_report: '說明自己的查驗',
      vote: '交代本輪票向'
    };
    return {
      type, targetId, targetTag: player ? U.tag(player) : '', source, priority, style,
      label: focusLabels[type] || focusLabels.vote,
      round: Number(ctx.t || 0) + 1,
      // Keep only presentation metadata in the public plan; never copy private role or inspection data.
      publicOnly: true
    };
  }

  function hasPublicSuspectAssessment(room, speeches) {
    const players = Array.isArray(room && room.players) ? room.players : [];
    return (Array.isArray(speeches) ? speeches : []).some(sp => {
      const text = String(sp && sp.text || '');
      if (!/(?:壞人|嫌疑|懷疑|可疑|疑犯)/.test(text)) return false;
      const namedCount = new Set(players.filter(player => {
        const tag = U.tag(player);
        return tag && text.includes(tag);
      }).map(player => player.id)).size;
      const explicitUncertainty = /(?:證據不足|尚未收斂|暫不指認|不硬湊|還要看|再對照|仍待觀察|需要再看|尚待確認|目前不下結論)/.test(text);
      const namesArePresentedAsSuspects = /(?:嫌疑|懷疑|可疑|壞人)/.test(text);
      // 只在有人真正提出具名嫌疑或明確的待觀察結論時，才抑制後續重複盤點；不要求湊滿三人。
      return namedCount > 0 && namesArePresentedAsSuspects && ( /老朝奉/.test(text) || explicitUncertainty );
    });
  }

  function buildPublicSuspectBrief(A, bot, genes) {
    const skepticism = Number(genes && genes.skepticism);
    const threshold = 42 + 18 * (Number.isFinite(skepticism) ? Math.max(0, Math.min(1, skepticism)) : 0.5);
    const rows = (A && A.byEvil || []).filter(rec => rec && rec.player && rec.player.id !== bot.id && !rec.confessed && !rec.knownGood && rec.knownCamp !== 'good');
    const candidates = rows.filter(rec => {
      const directConflict = Array.isArray(rec.conflicts) && rec.conflicts.length > 0;
      const repeatedLaoTiming = Number(rec.inLaoPoolCount || 0) >= 2;
      return !!rec.knownEvil || Number(rec.evil || 0) >= threshold ||
        (directConflict && Number(rec.evil || 0) >= threshold * 0.68) ||
        (repeatedLaoTiming && Number(rec.evil || 0) >= 30);
    }).slice(0, 3);

    const tags = candidates.map(rec => U.tag(rec.player)).filter(Boolean);
    const laoRows = rows.map(rec => {
      const probs = rec.probs || {};
      const laoProb = Number(probs['老朝奉'] || 0);
      const repeatedTiming = Number(rec.inLaoPoolCount || 0) >= 2 ||
        ((A.laoIntersectIds || []).includes(rec.player.id) && (A.laoPools || []).length >= 2);
      const supported = (laoProb >= 43 && (Number(rec.evil || 0) >= 30 || (rec.conflicts || []).length > 0)) ||
        (repeatedTiming && laoProb >= 27 && Number(rec.evil || 0) >= 28);
      return { rec, laoProb, supported, repeatedTiming };
    }).filter(item => item.supported).sort((a, b) =>
      (Number(b.rec.probs && b.rec.probs['老朝奉'] || 0) + (b.repeatedTiming ? 18 : 0) + (Number(b.rec.evil || 0) * 0.08)) -
      (Number(a.rec.probs && a.rec.probs['老朝奉'] || 0) + (a.repeatedTiming ? 18 : 0) + (Number(a.rec.evil || 0) * 0.08))
    );
    const lao = laoRows[0] || null;
    const lines = [];

    if (tags.length) {
      lines.push(`目前有具體線索支持的壞人嫌疑：${tags.join('、')}。`);
    } else {
      lines.push('目前還沒有足夠證據點名任何人，我暫時不下結論。');
    }
    if (tags.length === 0) {
      lines.push('接下來要看本輪實際票型、手機傳遞順序，以及其他人的完整發言，再決定是否增加嫌疑對象。');
    } else if (tags.length < 3) {
      lines.push('其餘玩家目前證據不足，我不硬湊名單；還要看本輪票型、傳牌順位和其他人的發言。');
    } else {
      lines.push('這些是目前優先核查的對象，不代表身分已經證實。');
    }
    if (lao) {
      lines.push(`老朝奉方面，我目前較懷疑${U.tag(lao.rec.player)}，但仍是候選，還要對照擾亂時序。`);
    } else {
      lines.push('老朝奉身分目前尚未收斂，我暫時不指認，還要看擾亂時序與後續發言。');
    }
    const noSkillProbability = A && A.laoTiming && Number(A.laoTiming.noSkillProbability);
    if (Number.isFinite(noSkillProbability) && noSkillProbability >= 0.12) {
      lines.push('本輪目前也保留「老朝奉沒有啟動擾亂、刻意保留技能」的可能；沒有看到反轉不等於排除老朝奉。技能時點只按傳牌順位判斷，不能拿公開發言先後代替。');
    }
    const chorus = A && A.consensusAlerts && A.consensusAlerts[0];
    if (chorus) {
      lines.push(`【${chorus.beast}】的看法被多人提到，但部分來源是玩家自述或沿用前面說法；我會先核對原始依據，不把重複次數當成新證據。`);
    }

    return {
      tags,
      laoTag: lao ? U.tag(lao.rec.player) : null,
      brief: lines.join(''),
      candidateCount: tags.length,
      laoUnresolved: !lao
    };
  }

  function findCrediblePressuredAlly(room, rd, bot, A) {
    if (!room || !rd || !bot || !A || !A.prof) return null;
    const pressure = new Map();
    (rd.speeches || []).forEach(sp => {
      if (!sp || String(sp.playerId) === String(bot.id)) return;
      const parsed = publicSpeechData(sp, room, rd);
      const targets = new Set();
      if (parsed.callSuspectId) targets.add(String(parsed.callSuspectId));
      (parsed.accuse || []).forEach(item => { if (item && item.playerId) targets.add(String(item.playerId)); });
      targets.forEach(id => {
        if (id === String(bot.id)) return;
        const rec = A.prof[id];
        if (!rec || rec.knownEvil || Number(rec.ally || 0) < 18 || Number(rec.ally || 0) < Number(rec.evil || 0) + 8) return;
        const entry = pressure.get(id) || { playerId: id, count: 0, speakers: new Set(), ally: Number(rec.ally || 0), evil: Number(rec.evil || 0) };
        entry.count++;
        entry.speakers.add(String(sp.playerId));
        pressure.set(id, entry);
      });
    });
    const candidates = [...pressure.values()].filter(item => item.count > 0)
      .sort((a,b) => (b.ally - 0.65*b.evil + 5*b.count + 2*b.speakers.size) -
        (a.ally - 0.65*a.evil + 5*a.count + 2*a.speakers.size));
    const best = candidates[0];
    if (!best) return null;
    const player = U.byId(room, best.playerId);
    return player ? { player, playerId: best.playerId, pressureCount: best.count,
      independentPressurers: best.speakers.size, ally: best.ally, evil: best.evil } : null;
  }

  function publicRolePressure(room, rd, bot) {
    let latest = null;
    (rd && rd.speeches || []).forEach((sp, speechIndex) => {
      if (!sp || sp.playerId === bot.id) return;
      const data = publicSpeechData(sp, room, rd);
      (data.roleClaims || []).forEach(claim => {
        if (!claim || claim.playerId !== bot.id || !['claim', 'fake'].includes(claim.polarity)) return;
        const speaker = U.byId(room, sp.playerId);
        const speakerTag = speaker ? U.tag(speaker) : (sp.speakerName || '前手玩家');
        const targetTag = U.tag(bot);
        const addressedLater = (rd.speeches || []).slice(speechIndex + 1).some(next => {
          const text = String(next && next.text || '');
          return text.includes(speakerTag) && text.includes(targetTag) && text.includes(claim.role) &&
            /(?:角色|身分|身份|指控|指認|假冒|自稱|排除|不是|對跳|回應|核對|技能)/.test(text);
        });
        if (addressedLater) return;
        latest = { speakerId: sp.playerId, speakerName: speaker ? speaker.name : (sp.speakerName || '前手玩家'),
          role: claim.role, polarity: claim.polarity, text: claim.text || String(sp.text || '') };
      });
    });
    return latest;
  }

  function committedFalseRoleBluff(room, bot, beforeRoundIndex) {
    const claims = [];
    const rounds = (room && room.rounds) || [];
    // beforeRoundIndex is the zero-based index of the round currently being planned.
    // A public false-role claim in any earlier round is already a live commitment in
    // the current round, including the immediately preceding round.
    const roundLimit = Number.isFinite(Number(beforeRoundIndex))
      ? Math.max(0, Math.min(Math.floor(Number(beforeRoundIndex)), rounds.length))
      : rounds.length;
    for (let i = 0; i < roundLimit; i++) {
      const rd = rounds[i];
      const speech = (rd && rd.speeches || []).find(sp => String(sp && sp.playerId) === String(bot.id));
      if (!speech) continue;
      const claimed = publicSpeechData(speech, room, rd).selfRole;
      if (!claimed || claimed === bot.role) continue;
      const saved = rd && rd.mind && rd.mind[bot.id] && rd.mind[bot.id].roleBluff;
      claims.push({ roundIndex: i, role: claimed, text: String(speech.text || ''), saved });
    }
    if (!claims.length) return null;
    const first = claims[0];
    const latest = claims[claims.length - 1];
    let chosen = first;
    if (latest.role !== first.role) {
      const explicitSwitch = /(?:改口|改稱|撤回|更正|重新自稱|先前自稱|之前自稱|原先自稱)/.test(latest.text) &&
        latest.text.includes(first.role) && latest.text.includes(latest.role);
      if (explicitSwitch) chosen = latest;
    }
    const saved = chosen.saved && chosen.saved.role === chosen.role ? chosen.saved : {};
    return { ...saved, role: chosen.role, kind: 'false_claim', persist: true,
      commitment: 'public-role-persistence', continued: chosen.roundIndex < roundLimit,
      committedRound: saved.committedRound || chosen.roundIndex + 1 };
  }

  function chooseAbilityCoverStory(bot, room, plan, A) {
    if (!bot || GD.isGood(bot.role) || !room) return null;
    const rd = room.rounds && room.rounds[room.currentRoundIdx];
    if (!rd) return null;
    const log = rd.turnLogs && rd.turnLogs[bot.id] || {};
    const ownAmbush = !!(log.ambushTargetId || (Array.isArray(log.ambushIds) && log.ambushIds.length));
    const ownSeal = /封鎖|封印|封住/.test(String(log.ability || '') + ' ' + String(log.skillTag || ''));
    const ownAmbushTarget = ownAmbush ? U.byId(room, log.ambushTargetId) : null;
    const ownSealBeastMatch = String(log.ability || '').match(/封鎖【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】/);
    const ownSealBeast = ownSealBeastMatch && ownSealBeastMatch[1] || null;
    const publicAbilityReports = [];
    (room.rounds || []).slice(0, room.currentRoundIdx + 1).forEach(round => {
      (round && round.speeches || []).forEach(sp => {
        if (!sp) return;
        const parsed = publicSpeechData(sp, room, round);
        (parsed.abilityReports || []).forEach(report => publicAbilityReports.push({ ...report, speakerId: sp.playerId }));
      });
    });
    const preferredRole = plan && plan.roleBluff && ['藥不然', '鄭國渠'].includes(plan.roleBluff.role)
      ? plan.roleBluff.role : null;
    const options = [
      { role: '藥不然', kind: 'ambush', beast: plan && plan.beast, ownAction: bot.role === '藥不然' && ownAmbush,
        targetId: ownAmbushTarget && ownAmbushTarget.id || null },
      { role: '鄭國渠', kind: 'seal', beast: (bot.role === '鄭國渠' && ownSealBeast) || plan && plan.zhengBlindSignal && plan.zhengBlindSignal.beast || plan && plan.beast,
        ownAction: bot.role === '鄭國渠' && ownSeal, targetId: null }
    ];
    let candidates = options.filter(item => item.beast && (rd.beasts || []).some(beast => beast.name === item.beast));
    if (preferredRole) candidates = candidates.filter(item => item.role === preferredRole);
    // 不可無故在假稱中點出自己的真實角色；只有自己當輪確有該技能行動時才可如實報告。
    candidates = candidates.filter(item => item.role !== bot.role || item.ownAction);
    if (!candidates.length) return null;
    const genes = bot.genes || GD.Genes.load(bot.botId);
    const deception = U.clamp(Number(genes.deception) || 0.5, 0, 1);
    const camouflage = U.clamp(Number(genes.camouflage) || 0.5, 0, 1);
    const seed = `${room.gameId || room.roomId || 'local'}:${room.currentRoundIdx}:${bot.botId || bot.id}:ability-cover`;
    const opportunity = 0.18 + 0.22 * deception + 0.16 * camouflage;
    if (!candidates.some(item => item.ownAction) && stableRoll(seed) > opportunity) return null;
    const roleTieBreak = stableRoll(`${seed}:role`) < 0.5 ? '藥不然' : '鄭國渠';
    const selected = candidates.slice().sort((a, b) => {
      const aPublic = publicAbilityReports.filter(report => report.role === a.role && report.stance !== 'denial').length;
      const bPublic = publicAbilityReports.filter(report => report.role === b.role && report.stance !== 'denial').length;
      const scoreDelta = (Number(b.ownAction) * 4 + bPublic) - (Number(a.ownAction) * 4 + aPublic);
      return scoreDelta || (a.role === roleTieBreak ? -1 : b.role === roleTieBreak ? 1 : 0);
    })[0];
    if (!selected) return null;
    const targetId = selected.targetId || (A && A.prof ? Object.values(A.prof)
      .filter(rec => rec && rec.player && rec.player.id !== bot.id && !(A.ctx && A.ctx.partner && rec.player.id === A.ctx.partner.id))
      .sort((a, b) => Number(b.evil || 0) - Number(a.evil || 0))[0]?.player.id : null) || null;
    const target = targetId && U.byId(room, targetId);
    const isOwnVerifiedAction = !!selected.ownAction;
    const priorPublicSupport = publicAbilityReports.filter(report => report.role === selected.role).length;
    const styleRoll = stableRoll(`${seed}:stance`);
    let stance, truthMode, line;
    const targetText = target ? U.tag(target) : '相關玩家';
    if (isOwnVerifiedAction) {
      stance = 'assertion';
      truthMode = 'verified-own-action';
      line = selected.role === '藥不然'
        ? `我能確認，${U.tag(ownAmbushTarget || target)}本輪受到藥不然攻擊；【${selected.beast}】的回報必須連同失明時序一起核對。`
        : `我能確認，【${selected.beast}】本輪確實受到鄭國渠封印影響，不能直接當成一般查驗結果。`;
    } else if (styleRoll < 0.24 + deception * 0.38) {
      // 壞人可故意提出未經證實、甚至錯誤的技能斷言；推理端仍只記為公開說法。
      stance = 'assertion';
      truthMode = 'fabricated-public-assertion';
      line = selected.role === '藥不然'
        ? `我判斷${targetText}本輪確實受到藥不然攻擊；【${selected.beast}】這筆不能直接當成一般查驗結果。`
        : `我判斷【${selected.beast}】本輪確實受到鄭國渠封印影響，這筆結果不能直接當成一般查驗。`;
    } else if (styleRoll > 0.77 - camouflage * 0.18) {
      stance = 'denial';
      truthMode = 'fabricated-public-denial';
      line = selected.role === '藥不然'
        ? `我認為這輪沒有藥不然攻擊，別急著用偷襲解釋${targetText}的【${selected.beast}】回報。`
        : `我認為這輪沒有鄭國渠封印，先不要用封印替【${selected.beast}】的結果找理由。`;
    } else {
      stance = 'hypothesis';
      truthMode = 'fabricated-public-hypothesis';
      line = selected.role === '藥不然'
        ? `${targetText}的視野異常也可能是藥不然攻擊造成；我先把【${selected.beast}】列成待核對線索，不能直接當成已證實。`
        : `${targetText}這筆查驗也可能受到鄭國渠封印影響；【${selected.beast}】先保留，必須再對照傳牌順位與其他回報。`;
    }
    return {
      role: selected.role, kind: selected.kind, beast: selected.beast, targetId,
      targetTag: target ? U.tag(target) : null, truthMode, stance,
      priorPublicReports: priorPublicSupport,
      provenance: isOwnVerifiedAction ? 'own-action-log' : 'generated-public-bluff',
      verification: isOwnVerifiedAction ? 'own-action-only' : 'unverified', line
    };
  }

  function roleBluffFeasibility(role, bot, ctx, A) {
    if (!role || !bot || !ctx) return 0;
    const room = ctx.room || {};
    if (role === '許願') {
      const names = new Set();
      ((ctx.myIns || ctx.log && ctx.log.inspect || [])).forEach(item => { if (item && item.beastName) names.add(item.beastName); });
      if (names.size < 2) (room.rounds || []).slice(0, ctx.t + 1).forEach(rd => {
        const own = (rd && rd.speeches || []).find(sp => String(sp && sp.playerId) === String(bot.id));
        const data = own && publicSpeechData(own, room, rd);
        (data && data.claims || []).forEach(claim => { if (claim && claim.beast) names.add(claim.beast); });
      });
      return names.size >= 2 ? 0.82 : 0.18;
    }
    if (role === '黃煙煙' || role === '木戶加奈') {
      const hasUnable = (room.rounds || []).slice(0, ctx.t + 1).some(rd =>
        (rd && rd.speeches || []).some(sp => String(sp && sp.playerId) === String(bot.id) &&
          /驗不到|無法辨別真偽|看不懂真偽/.test(String(sp.text || ''))));
      return hasUnable || ctx.t < 2 ? 0.82 : 0.35;
    }
    if (role === '方震') {
      const ownLogs = (room.rounds || []).slice(0, ctx.t + 1).map(rd => rd && rd.turnLogs && rd.turnLogs[bot.id]).filter(Boolean);
      const hasOwnCampCheck = ownLogs.some(log => !!(log.fangTargetId && ['good', 'evil'].includes(log.fangCamp)));
      const candidates = (room.players || []).filter(player => player && player.id !== bot.id &&
        !(ctx.partner && player.id === ctx.partner.id));
      // 沒有自己的陣營查驗紀錄時，只能低調鋪陳，不能直接假稱「我查了某人」。
      return hasOwnCampCheck ? 0.82 : (candidates.length && ctx.t === 0 ? 0.47 : 0.12);
    }
    if (role === '平民') return 0.78;
    const ownLogs = (room.rounds || []).slice(0, ctx.t + 1).map(rd => rd && rd.turnLogs && rd.turnLogs[bot.id]).filter(Boolean);
    const ownAmbush = ownLogs.some(log => !!(log.ambushTargetId || (log.ambushIds || []).length || /偷襲|攻擊/.test(String(log.ability || ''))));
    const ownBlock = ownLogs.some(log => /封鎖|封印|封住/.test(String(log.ability || '') + ' ' + String(log.skillTag || '')));
    const ownDisruption = ownLogs.some(log => /擾亂/.test(String(log.ability || '') + ' ' + String(log.skillTag || '')) || log.laoSkillDecision === 'activate');
    const publicSelfAbilityClaim = (room.rounds || []).slice(0, ctx.t + 1).some(rd =>
      (rd && rd.speeches || []).some(sp => String(sp && sp.playerId) === String(bot.id) &&
        (publicSpeechData(sp, room, rd).abilityReports || []).some(report => report.role === role &&
          (report.selfAttribution === true || report.selfRoleClaim === true))));
    if (role === '鄭國渠') return ownBlock ? 0.82 : publicSelfAbilityClaim ? 0.72 : (ctx.t === 0 ? 0.49 : 0.16);
    if (role === '藥不然') return ownAmbush ? 0.82 : publicSelfAbilityClaim ? 0.72 : (ctx.t === 0 ? 0.49 : 0.16);
    if (role === '老朝奉') return ownDisruption ? 0.82 : (ctx.t === 0 ? 0.49 : 0.20);
    if (role === '姬雲浮') return 0.62;
    return 0.50;
  }

  // Decide the frame using a stable roll shared by Lao's pass decision and Yao's skill decision.
  // Without Lao deliberately handing the phone to Yao, the ordinary evil pass policy keeps the partner late,
  // so the intended Lao-first / Yao-second setup almost never occurs in complete games.
  // v10.9 retires the legacy forced Lao-first / Yao-second third-seat script.
  // Ordinary Yao ambush selection and pass evaluation remain unchanged.
  function shouldActivateThirdSeatFrame() { return false; }
  function currentAmbushSwap() { return null; }

  /* EVIL_MACRO_STRATEGY_V1: 只依公開資訊與 Bot 自己保存的後驗估分，不讀取封存第一名的真實真偽。 */
  function evilStrategicState(room, bot) {
    const t = Number(room.currentRoundIdx) || 0;
    const estimates = [];
    for (let i = 0; i < t; i++) {
      const rd = (room.rounds || [])[i];
      const vr = rd && rd.voteResults;
      if (!vr || !vr.rank2) continue;
      const ownMind = bot && rd.mind && rd.mind[bot.id];
      const rank1Posterior = ownMind && Array.isArray(ownMind.post)
        ? ownMind.post.find(x => x.name === (vr.rank1 && vr.rank1.name)) : null;
      const hiddenTopExpected = rank1Posterior && Number.isFinite(rank1Posterior.p)
        ? U.clamp(rank1Posterior.p, 0, 1) : 0.5;
      estimates.push((vr.rank2.isReal ? 1 : 0) + hiddenTopExpected);
    }
    const estimatedGoodScore = estimates.reduce((sum, n) => sum + n, 0);
    const avg = estimates.length ? estimatedGoodScore / estimates.length : null;
    let maxOwnPZheng = 0;
    if (bot && bot.role === '老朝奉') {
      for (let i = 0; i < t; i++) {
        const ownMind = room.rounds[i] && room.rounds[i].mind && room.rounds[i].mind[bot.id];
        Object.values(ownMind && ownMind.beliefProfile || {}).forEach(profile => {
          const p = Number(profile && profile.pZheng);
          if (Number.isFinite(p)) maxOwnPZheng = Math.max(maxOwnPZheng, p);
        });
      }
    }
    let posture = 'mixed';
    if (!estimates.length) posture = 'neutral';
    else if (avg <= 1.05) posture = 'conceal';
    else if (avg >= 1.55) posture = 'desperate';
    const laoDesperation = !!(bot && bot.role === '老朝奉' && t >= 2 && estimatedGoodScore >= 2 && maxOwnPZheng < 0.36);
    if (laoDesperation) posture = 'desperate';
    return {
      posture, laoDesperation, maxOwnPZheng: U.round3(maxOwnPZheng),
      completedRounds: estimates.length,
      estimatedGoodScore: U.round3(estimatedGoodScore),
      estimatedGoodPointsPerRound: avg == null ? null : U.round3(avg)
    };
  }

  function chooseEvilStyle(bot, state, genes) {
    // 情勢有利時老朝奉較常藏；藥不然保留更多反心態裸打；鄭國渠依情報與個性混合。
    let hideP = 0.45;
    if (state.posture === 'conceal') {
      hideP = bot.role === '老朝奉' ? 0.68 : bot.role === '藥不然' ? 0.45 : 0.52;
    } else if (state.posture === 'desperate') {
      hideP = bot.role === '老朝奉' ? 0.28 : bot.role === '藥不然' ? 0.20 : 0.18;
    } else {
      hideP = bot.role === '老朝奉' ? 0.50 : bot.role === '藥不然' ? 0.43 : 0.38;
    }
    hideP = U.clamp(hideP + ((genes && genes.camouflage != null ? genes.camouflage : 0.5) - 0.5) * 0.25, 0.08, 0.88);
    return rnd() < hideP ? 'conceal' : 'aggressive';
  }

  // 終局角色候選只建立一次排序；決策、前三名與覆盤共用同一份分數和證據。
  // 局中只讀自己的私密查驗，以及全場公開發言／票單；絕不讀其他玩家的私密 turnLogs。
  function assessFinalRoleCandidates(bot, room, A, targetRole) {
    const ctx = A.ctx || {};
    const partnerId = ctx.partner && ctx.partner.id;
    const goodTarget = targetRole === '許願' || targetRole === '方震' || targetRole === '好人誘餌';
    const hardExcluded = [];
    const ranked = [];
    const rounds = Array.isArray(room.rounds) ? room.rounds : [];

    Object.values(A.prof || {}).forEach(rec => {
      if (!rec || !rec.player || rec.player.id === bot.id) return;
      const player = rec.player;
      const id = player.id;
      let hardReason = '';
      if (partnerId && id === partnerId) {
        hardReason = `我的秘密同伴（${bot.role === '老朝奉' ? '藥不然' : bot.role === '藥不然' ? '老朝奉' : '已知同伴'}）已確認，不可能是目標角色`;
      } else if (!goodTarget && targetRole === '老朝奉' && (rec.knownCamp === 'good' || rec.knownGood)) {
        hardReason = '我自己的方震陣營查驗已確認他是好人，不可能是老朝奉';
      } else if (goodTarget && (rec.knownCamp === 'evil' || rec.knownEvil || rec.confessed)) {
        hardReason = '已有可靠陣營資訊確認他屬於壞人方，不可能是好人角色';
      }
      if (hardReason) {
        hardExcluded.push({ id, tag: U.tag(player), role: player.role || '', reason: hardReason, strength: 'hard' });
        return;
      }

      const probs = rec.probs || {};
      const evidence = [];
      let roleAdjust = 0;
      const seenReports = new Set();
      const seenUncertainty = new Set();
      let roleClaimRounds = 0;
      let campCheckCount = 0;
      let dualInspectionRounds = 0;
      let limitedInspectionRounds = 0;
      let blindRounds = 0;

      rounds.forEach((rd, roundIndex) => {
        if (!rd) return;
        const sp = (rd.speeches || []).find(item => item && item.playerId === id);
        if (!sp) return;
        const data = publicSpeechData(sp, room, rd) || {};
        if (data.selfRole === targetRole) {
          roleClaimRounds++;
          roleAdjust += 0.12;
          evidence.push({ strength: 'weak', round: roundIndex + 1, source: 'public-role-claim', text: `第${roundIndex + 1}輪公開自稱【${targetRole}】；自稱可能是假跳，只給少量支持` });
        }
        // 角色指控／技能歸因僅來自公開語句，權重刻意低於可交叉核對的技能時序。
        if (targetRole === '老朝奉') {
          const laoAccusations = (data.roleClaims || []).filter(item => item && item.playerId === id && item.role === '老朝奉' &&
            !['deny', 'fake'].includes(item.polarity));
          if (laoAccusations.length) {
            roleAdjust += Math.min(0.48, laoAccusations.length * 0.24);
            evidence.push({ strength: 'weak', round: roundIndex + 1, source: 'public-role-attribution', text: `第${roundIndex + 1}輪有公開發言把此人列為老朝奉候選；可能是錯誤指認或栽贓，僅作弱佐證` });
          }
        }
        const abilityReports = Array.isArray(data.abilityReports) ? data.abilityReports : [];
        abilityReports.forEach(report => {
          if (!report || report.stance === 'denial') return;
          const roleMatch = report.role === targetRole;
          const targetMatch = (report.targetIds || []).some(targetId => String(targetId) === String(id));
          if (roleMatch && targetMatch) {
            const weight = report.stance === 'assertion' ? 0.62 : 0.34;
            roleAdjust += weight;
            evidence.push({ strength: 'weak', round: roundIndex + 1, source: 'public-unverified-ability-attribution', text: `第${roundIndex + 1}輪有玩家公開把${U.tag(player)}與${report.role === '藥不然' ? '攻擊' : '封印'}線索連結；尚未驗證，也可能是假線索` });
          }
          if (roleMatch && report.selfAttribution === true && String(sp.playerId) === String(id)) {
            roleAdjust += 0.14;
            evidence.push({ strength: 'weak', round: roundIndex + 1, source: 'public-self-ability-claim', text: `第${roundIndex + 1}輪本人公開提到【${targetRole}】技能；可能是真實報告或偽裝，不當成技能已發動` });
          }
        });

        const reports = Array.isArray(data.inspectionReports) ? data.inspectionReports : [];
        const thisRoundBeasts = new Set();
        reports.forEach(report => {
          if (!report || Number(report.round) !== roundIndex + 1 || !report.beast || typeof report.claimedReal !== 'boolean') return;
          const key = `${roundIndex + 1}|${report.beast}|${report.claimedReal}`;
          if (seenReports.has(key)) return;
          seenReports.add(key);
          thisRoundBeasts.add(report.beast);
        });
        if (targetRole === '許願' && thisRoundBeasts.size >= 2) {
          dualInspectionRounds++;
          roleAdjust += 3.2;
          evidence.push({ strength: 'medium', round: roundIndex + 1, source: 'public-dual-inspection-report', text: `第${roundIndex + 1}輪公開回報查驗至少兩尊不同獸首，符合許願的雙查驗能力；仍屬自述，未獨立驗證` });
        }

        const uncertainty = Array.isArray(data.uncertaintyReasons) ? data.uncertaintyReasons : [];
        const hasLimitedView = !!(data.blind || data.unsure || uncertainty.length);
        if (hasLimitedView) {
          const reasonKey = `${roundIndex + 1}|${uncertainty.map(x => x && x.reason).join(',')}|${data.blind ? 1 : 0}|${data.unsure ? 1 : 0}`;
          if (!seenUncertainty.has(reasonKey)) {
            seenUncertainty.add(reasonKey);
            const reasons = uncertainty.map(x => x && x.reason).filter(Boolean);
            const isBlind = !!data.blind || reasons.includes('ambush');
            const isBlocked = reasons.includes('blocked');
            if (isBlind) blindRounds++;
            if (targetRole === '許願') {
              limitedInspectionRounds++;
              const penalty = isBlind ? 0.9 : isBlocked ? 0.6 : 0.8;
              roleAdjust -= penalty;
              const explanation = isBlind
                ? '自述該輪遭偷襲／看不清，可能是藥不然造成，不能直接當成角色證明'
                : isBlocked
                  ? '自述該輪有查驗受阻；封印可能只影響部分查驗，故只列弱反證'
                  : '自述該輪驗不到，只能算很弱的反證；黃煙煙／木戶加奈本身也有一次困惑回合，偷襲或封鎖也可能造成看不到結果，不能單憑這一輪把人刪掉';
              evidence.push({ strength: 'weak', round: roundIndex + 1, source: 'public-limited-inspection', text: `第${roundIndex + 1}輪${explanation}` });
            } else if (targetRole === '藥不然' && isBlind) {
              roleAdjust += 0.12;
              evidence.push({ strength: 'weak', round: roundIndex + 1, source: 'public-blind-report', text: `第${roundIndex + 1}輪自述遭偷襲致盲；受害者回報不代表本人就是藥不然，只保留極弱時序參考` });
            }
          }
        }

        const campChecks = Array.isArray(data.campChecks) ? data.campChecks : [];
        if (targetRole === '方震' && campChecks.length) {
          campCheckCount += campChecks.length;
          const bonus = Math.min(4.5, campChecks.length * 2.2);
          roleAdjust += bonus;
          evidence.push({ strength: 'medium', round: roundIndex + 1, source: 'public-camp-check-claim', text: `第${roundIndex + 1}輪公開提到${campChecks.length}次陣營查驗，符合方震能力特徵；但口頭宣稱仍可能是假跳` });
        }
      });

      // 歷史投票只在第二名公開揭曉後做事後比對；不把投票當下未知的結果當成定罪證據。
      let retrospectiveFakeVotes = 0;
      rounds.forEach((rd, roundIndex) => {
        const opened = rd && rd.voteResults && rd.voteResults.rank2;
        if (!opened || opened.hidden !== false || opened.isReal !== false || !opened.name || !rd.votes) return;
        const chips = Math.max(0, Number(rd.votes[id] && rd.votes[id][opened.name]) || 0);
        if (!chips) return;
        retrospectiveFakeVotes += chips;
        const delta = Math.min(1.8, chips * 0.28);
        roleAdjust += targetRole === '老朝奉' ? delta : (goodTarget ? -delta : 0);
        evidence.push({ strength: 'weak', round: roundIndex + 1, source: 'retrospective-public-ballot', text: `第${roundIndex + 1}輪投給後來公開判假的【${opened.name}】${chips}票；當時尚未知道結果，僅是事後弱線索，可能是誤判或戰術分票` });
      });

      let baseScore;
      if (targetRole === '老朝奉') baseScore = finalLaoCandidateScore(rec, A);
      else if (targetRole === '好人誘餌') baseScore = Number(rec.ally || 0);
      else baseScore = Number(probs[targetRole] || 0) + Number(rec.ally || 0) * 0.12;

      // 姬雲浮只作柔性競爭角色，不因機率超過 55% 就把玩家從候選名單硬刪。
      const jiProbability = Number(probs['姬雲浮'] || 0);
      const jiPenalty = goodTarget ? Math.min(3.5, Math.max(0, jiProbability - 35) * 0.07) : 0;
      if (jiProbability >= 45 && goodTarget) {
        evidence.push({ strength: 'weak', round: null, source: 'competing-role-posterior', text: `姬雲浮後驗 ${Math.round(jiProbability)}%，是競爭角色，僅降低許願／方震排序 ${jiPenalty.toFixed(1)} 分，不直接排除` });
      }
      if (rec.isPartner && targetRole !== '老朝奉') {
        roleAdjust -= 2.0;
        evidence.push({ strength: 'weak', round: null, source: 'inferred-partner', text: '推理模型暫時把他列為疑似同伴；這不是已確認身分，只作輕微降權' });
      }
      if (Number(rec.conflicts && rec.conflicts.length || 0) > 0 && targetRole === '老朝奉') {
        evidence.push({ strength: 'medium', round: null, source: 'public-contradiction', text: `公開發言有 ${rec.conflicts.length} 項可回查矛盾` });
      }
      const score = baseScore + roleAdjust - jiPenalty;
      if (!evidence.length) evidence.push({ strength: 'weak', round: null, source: 'posterior-only', text: '目前沒有足夠的具體公開技能／查驗紀錄，主要依角色後驗排序；把握度有限' });
      const supportingEvidence = evidence.filter(e => ['public-role-claim', 'public-dual-inspection-report', 'public-blind-report', 'public-camp-check-claim', 'public-contradiction'].includes(e.source) || (e.source === 'retrospective-public-ballot' && targetRole === '老朝奉'));
      const counterEvidence = evidence.filter(e => ['public-limited-inspection', 'competing-role-posterior', 'inferred-partner'].includes(e.source) || (e.source === 'retrospective-public-ballot' && goodTarget));
      const inEliminatedLaoPool = targetRole === '老朝奉' && (A.eliminatedFromLaoIds || []).includes(id);
      if (inEliminatedLaoPool) counterEvidence.push({ strength: 'medium', round: null, source: 'lao-window-elimination', text: '未同時出現在多輪老朝奉反轉時序交集內，降低老朝奉可能性' });
      const hasOnlyPosterior = evidence.length === 1 && evidence[0].source === 'posterior-only';
      const roleProb = Number(probs[targetRole] || 0);
      let eliminationTier = '保留候選';
      if (inEliminatedLaoPool || (roleProb < 6 && counterEvidence.length > 0 && supportingEvidence.length === 0)) eliminationTier = '高度不可能';
      else if (counterEvidence.length > supportingEvidence.length && roleProb < 16) eliminationTier = '暫時排除';
      else if (hasOnlyPosterior && Math.abs(roleProb - 14.28) < 4) eliminationTier = '資訊不足，無法判斷';
      ranked.push({ id, player, tag: U.tag(player), score, baseScore, roleProbability: roleProb, jiProbability,
        roleAdjust, jiPenalty, evidence, supportingEvidence, counterEvidence, eliminationTier,
        reasons: (rec.reasons || []).slice(0, 4), evil: Math.round(Number(rec.evil || 0)),
        ally: Math.round(Number(rec.ally || 0)), knownCamp: rec.knownCamp || null, metrics: { roleClaimRounds, campCheckCount, dualInspectionRounds, limitedInspectionRounds, blindRounds, retrospectiveFakeVotes } });
    });

    ranked.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    const selected = ranked[0] || null;
    return {
      targetRole, selectedId: selected && selected.id,
      hardExcluded,
      ranked,
      top: ranked.slice(0, 3),
      summary: selected ? `依同一套角色後驗與公開技能／查驗／票型證據，${selected.tag}暫列${targetRole}第一候選；這是相對排序，不是已證實身分。` : '沒有可用候選人。'
    };
  }


  // 把同一份候選證據轉成桌上能聽懂的刪除法；不把機率分數念成內部報表。
  function finalDeductionNarrative(assessment, selectedId) {
    if (!assessment) return '目前沒有完整候選資料，這次指認把握有限。';
    const hard = assessment.hardExcluded || [];
    const selected = (assessment.ranked || []).find(item => item.id === selectedId) || assessment.ranked[0];
    const hardLine = hard.length
      ? `我先把${hard.map(item => item.tag).join('、')}排除，因為${hard.map(item => item.reason).join('；')}。`
      : '我沒有足以一刀刪人的硬證據，所以沒有只憑機率把任何人直接踢出候選。';
    if (!selected) return `${hardLine}剩下的人證據都不夠，這次只能保留低把握指認。`;
    const rank = assessment.ranked.findIndex(item => item.id === selected.id) + 1;
    const evidence = (selected.evidence || []).slice(0, 2).map(item => item.text).filter(Boolean);
    const weakOnly = (selected.evidence || []).length > 0 && selected.evidence.every(item => item.strength === 'weak');
    const candidateLabel = weakOnly ? '待驗候選' : '候選';
    const reasonLine = evidence.length ? `我把${selected.tag}暫列第${rank}順位${candidateLabel}，主要看的是：${evidence.join('；')}。`
      : `我把${selected.tag}暫列第${rank}順位${candidateLabel}，但目前缺少能獨立核實的技能或查驗紀錄。`;
    const runner = (assessment.ranked || []).find(item => item.id !== selected.id);
    const runnerLine = runner ? `下一個候選是${runner.tag}；兩人的差距還不足以當成百分之百確定。` : '';
    const certaintyLine = weakOnly ? '目前證據偏弱，這只是待驗候選，不是已確認指控。' : '這是依目前證據排出的優先候選，不代表身分已經確認。';
    return `${hardLine}${reasonLine}${runnerLine}${certaintyLine}`;
  }


  function inferEvilTeammate(bot, A, room) {
    // 用角色後驗、公開發言與公開選票推測未確認的壞人同伴；不讀其他 Bot 私密 mind 或真實 role。
    if (!bot || !A || !A.prof || bot.role !== '鄭國渠') return null;
    const knownPartnerId = A.ctx && A.ctx.partner ? A.ctx.partner.id : null;
    const confirmedFromPublicHandshake = (A.inferredPartners || []).filter(item => item && item.player && item.player.id !== knownPartnerId);
    if (confirmedFromPublicHandshake.length) {
      const best = confirmedFromPublicHandshake.slice().sort((a, b) =>
        (Number(b.kinds && b.kinds.length) || 0) - (Number(a.kinds && a.kinds.length) || 0) ||
        (Number(b.pEvil) || 0) - (Number(a.pEvil) || 0))[0];
      if (best) return { player: best.player, roleScore: Number(best.pEvil || 0) * 100,
        signal: (best.kinds || []).length * 12, score: Number(best.pEvil || 0) * 100 + (best.kinds || []).length * 12,
        rec: A.prof[best.playerId] || null, evidence: best.evidence || [], isPartner: true };
    }
    const candidates = Object.values(A.prof).filter(r => r && r.player && r.player.id !== bot.id && r.player.id !== knownPartnerId).map(rec => {
      const probs = rec.probs || {};
      const roleScore = (probs['老朝奉'] || 0) + (probs['藥不然'] || 0);
      let signal = 0;
      for (let i = 0; i <= (room.currentRoundIdx || 0); i++) {
        const rd = (room.rounds || [])[i];
        if (!rd) continue;
        // 僅使用已公開的發言與選票；不能讀取其他 Bot 的 rd.mind 私密計畫。
        const mySpeech = (rd.speeches || []).find(s => s.playerId === bot.id);
        const theirSpeech = (rd.speeches || []).find(s => s.playerId === rec.player.id);
        const myClaims = mySpeech ? publicSpeechClaims(mySpeech, room, rd) : [];
        const theirClaims = theirSpeech ? publicSpeechClaims(theirSpeech, room, rd) : [];
        const sharedPublicClaims = myClaims.filter(c => c.real === true && theirClaims.some(d => d.real === true && d.beast === c.beast));
        if (sharedPublicClaims.length) signal += Math.min(6, sharedPublicClaims.length * 4);
        const exposedFake = rd.voteResults && rd.voteResults.rank2 && !rd.voteResults.rank2.isReal ? rd.voteResults.rank2.name : null;
        if (exposedFake && sharedPublicClaims.some(c => c.beast === exposedFake)) signal += 5;
        const myBallot = rd.votes && rd.votes[bot.id] || {};
        const theirBallot = rd.votes && rd.votes[rec.player.id] || {};
        const sharedSpend = Object.keys(myBallot).reduce((sum, name) => sum + Math.min(Number(myBallot[name]) || 0, Number(theirBallot[name]) || 0), 0);
        signal += Math.min(5, sharedSpend * 2);
        if (exposedFake && (Number(myBallot[exposedFake]) || 0) > 0 && (Number(theirBallot[exposedFake]) || 0) > 0) signal += 3;
      }
      return { player: rec.player, roleScore, signal, score: roleScore + Math.min(22, signal), rec };
    }).sort((a, b) => b.score - a.score);
    const best = candidates[0], runner = candidates[1];
    if (!best) return null;
    const gap = best.score - (runner ? runner.score : 0);
    const confident = bot.role === '鄭國渠'
      ? ((best.roleScore >= 37 && gap >= 4) || (best.roleScore >= 29 && best.signal >= 8 && gap >= 4))
      : ((best.roleScore >= 38 && gap >= 5) || (best.roleScore >= 28 && best.signal >= 10 && gap >= 4));
    return confident ? best : null;
  }

  // 舊版模擬器相容入口：不再執行「姬雲浮機率門檻硬排除」，只包裝共用排序結果.
  // 保留函式名稱與位置，讓既有 A/B 模擬工具仍能切出 inferEvilTeammate。
  function bestFinalRoleCandidate(bot, room, A, targetRole) {
    const assessment = assessFinalRoleCandidates(bot, room, A, targetRole);
    const best = assessment.ranked[0] || null;
    return {
      record: best ? (A.prof && A.prof[best.id]) || null : null,
      excludedJi: null,
      inferredBuddy: inferEvilTeammate(bot, A, room),
      assessment
    };
  }

  // 只使用已公開發言，保留每位玩家最近一次明確身分宣稱；不讀其他 Bot 的私密 mind.
  function latestPublicRoleClaims(room, beforeRoundIndex, excludeId = null) {
    const latest = new Map();
    (room.rounds || []).slice(0, beforeRoundIndex + 1).forEach((rd, roundIndex) => {
      (rd && rd.speeches || []).forEach(sp => {
        if (!sp || !sp.playerId || sp.playerId === excludeId) return;
        let role = publicSpeechData(sp, room, room.rounds[roundIndex]).selfRole;
        if (!role && GD.Claims && typeof GD.Claims.parse === 'function') {
          try { role = GD.Claims.parse(String(sp.text || ''), room, rd).selfRole; } catch (_) {}
        }
        if (role) latest.set(sp.playerId, { playerId: sp.playerId, role, roundIndex, speakerName: sp.speakerName || '' });
      });
    });
    return latest;
  }

  // 對跳是合法的心理戰，不因已有玩家認領某角色就機械式避開。
  // 角色可信度交由 mind.js 根據能力時點、公開行動與票型評估；此處只維持自身承諾及同伴保護。
  // 單次加權抽籤取代原先的等機率 pickDecision，不增加額外 RNG 消耗。
  function chooseRoleBluffRole(rolePool, room, bot, beforeRoundIndex, partner) {
    if (!Array.isArray(rolePool) || rolePool.length === 0) return null;
    const latest = latestPublicRoleClaims(room, beforeRoundIndex, null);
    let ownLatestRole = null;
    latest.forEach(item => {
      if (item.playerId === bot.id) ownLatestRole = item.role;
    });
    const partnerClaim = partner && latest.get(partner.id);
    const partnerHasFalsePublicCommitment = !!(partnerClaim && partner.role && partnerClaim.role !== partner.role);
    const weights = rolePool.map(role => {
      // 不對已被認領的角色施加懲罰：對跳可能是故意搶身分、反踩或誘出真身。
      let weight = role === '平民' ? 0.9 : 1.0;
      // 若自己上一輪已公開過身份，優先維持同一說法，避免無必要地製造跨輪改口證據。
      if (ownLatestRole === role) weight *= 3.5;
      // 不把已知秘密同伴的真實唯一角色當作一般可用假身份；特殊角色互換戰術另行處理。
      if (partner && role === partner.role) weight *= 0.55;
      // 隊友已公開扛起某個假身分時，若本輪仍要假跳，降低無意義地複製同一敘事的權重；不封鎖反跳。
      if (partnerHasFalsePublicCommitment && role === partnerClaim.role) weight *= 0.42;
      return Math.max(0.001, weight);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = rnd() * total;
    for (let i = 0; i < rolePool.length; i++) {
      roll -= weights[i];
      if (roll < 0) return rolePool[i];
    }
    return rolePool[rolePool.length - 1];
  }

  // 隊友的假身分只讀公開發言，不讀隊友私有 mind／turnLogs。
  // 一名壞人已經承擔角色敘事時，另一名壞人仍可反跳，但預設降低「各自亂跳」機率。
  function teamRoleBluffAdjustment(room, bot, partner, beforeRoundIndex) {
    if (!partner || !partner.id) return { multiplier: 1, active: false, reason: 'no-public-partner' };
    const latest = latestPublicRoleClaims(room, beforeRoundIndex, bot && bot.id);
    const claim = latest.get(partner.id);
    if (!claim || !partner.role || claim.role === partner.role) {
      return { multiplier: 1, active: false, antiMirror: false, reason: 'no-public-false-role-commitment' };
    }
    if (String(claim.role) === String(bot && bot.role)) {
      return { multiplier: 0, active: true, antiMirror: true, partnerClaim: claim.role,
        partnerTrueRole: partner.role, currentRound: claim.roundIndex === beforeRoundIndex,
        reason: 'partner-publicly-claims-actor-true-role-mirror-blocked' };
    }
    const isCurrentRound = claim.roundIndex === beforeRoundIndex;
    const raw = (room.rounds || []).slice(0, beforeRoundIndex + 1)
      .flatMap(rd => rd && rd.speeches || [])
      .filter(sp => sp && sp.playerId === partner.id)
      .map(sp => String(sp.text || '')).join(' ');
    const persistenceLanguage = /維持到終局|持續否認|不會改口|角色說法維持|硬跳|假身分/.test(raw);
    const multiplier = isCurrentRound ? (persistenceLanguage ? 0.38 : 0.52) : (persistenceLanguage ? 0.55 : 0.68);
    return {
      multiplier,
      active: true,
      partnerClaim: claim.role,
      partnerTrueRole: partner.role,
      currentRound: isCurrentRound,
      reason: isCurrentRound
        ? 'partner-already-carries-current-public-false-role-story'
        : 'partner-has-persistent-public-false-role-story'
    };
  }

  function publicPlayerSuspicion(room, targetId, actorId, beforeRoundIndex) {
    let score = 0;
    let evidenceCount = 0;
    (room.rounds || []).slice(0, beforeRoundIndex + 1).forEach(rd => {
      (rd && rd.speeches || []).forEach(sp => {
        if (!sp) return;
        const data = publicSpeechData(sp, room, rd);
        const namesActor = String(sp.text || '').includes(U.tag(U.byId(room, actorId)) || '\u0000');
        const explicit = data.callSuspectId === actorId || (data.accuse || []).some(a => a && a.playerId === actorId) ||
          (data.playerStances || []).some(x => x && x.targetId === actorId && /evil|bad|壞|懷疑|suspect/i.test(String(x.camp || '') + ' ' + String(x.evidence || '')));
        const textual = namesActor && /嫌疑|懷疑|可疑|壞人|老朝奉|指認|盯緊|不可信|假跳|冒充/.test(String(sp.text || ''));
        if (explicit || textual) {
          score += sp.playerId === targetId ? (explicit ? 0.34 : 0.16) : (explicit ? 0.12 : 0.055);
          evidenceCount++;
        }
      });
    });
    return { score: Math.max(0, Math.min(0.85, score)), evidenceCount };
  }

  function publicVoteBehavior(room, playerId, beforeRoundIndex) {
    let mismatchCount = 0;
    let callMismatchCount = 0;
    let observableRounds = 0;
    const actualFor = (rd) => {
      const chips = rd && rd.voteResults && rd.voteResults.chips;
      if (chips && typeof chips === 'object') {
        return Object.keys(chips).filter(beast => Array.isArray(chips[beast]) && chips[beast].some(item => item && item.voterId === playerId));
      }
      const raw = rd && (rd.votes || rd.ballots);
      if (raw && raw[playerId] && typeof raw[playerId] === 'object') {
        return Object.keys(raw[playerId]).filter(beast => Number(raw[playerId][beast]) > 0);
      }
      return null;
    };
    (room.rounds || []).slice(0, beforeRoundIndex + 1).forEach(rd => {
      if (!rd) return;
      const speech = (rd.speeches || []).find(sp => sp && sp.playerId === playerId);
      if (!speech) return;
      const data = publicSpeechData(speech, room, rd);
      const promised = new Set((data.voteCommitments || []).map(x => x && x.beast).filter(Boolean));
      const calls = new Set([...(data.callBeasts || []), data.callBeast].filter(Boolean));
      const actual = actualFor(rd);
      if (actual === null) return;
      observableRounds++;
      if (promised.size && ![...promised].some(beast => actual.includes(beast))) mismatchCount++;
      else if (!promised.size && calls.size && ![...calls].some(beast => actual.includes(beast))) callMismatchCount++;
    });
    return { mismatchCount, callMismatchCount, observableRounds };
  }

  function publicPassPairHistory(room, actorId, partnerId, beforeRoundIndex) {
    let consecutiveCount = 0;
    (room.rounds || []).slice(0, beforeRoundIndex).forEach(rd => {
      const order = (rd && rd.passOrder || []).map(x => typeof x === 'string' ? x : String(x && (x.id || x.playerId) || '')).filter(Boolean);
      const index = order.indexOf(actorId);
      if (index >= 0 && order[index + 1] === partnerId) consecutiveCount++;
    });
    return consecutiveCount;
  }

  function publicActorPartnerLink(room, actorId, partnerId, beforeRoundIndex) {
    if (!partnerId) return 0;
    let strength = 0;
    (room.rounds || []).slice(0, beforeRoundIndex + 1).forEach(rd => {
      const actorSpeech = (rd && rd.speeches || []).find(sp => sp && sp.playerId === actorId);
      const partnerSpeech = (rd && rd.speeches || []).find(sp => sp && sp.playerId === partnerId);
      if (!actorSpeech || !partnerSpeech) return;
      const a = publicSpeechData(actorSpeech, room, rd);
      const b = publicSpeechData(partnerSpeech, room, rd);
      const aCalls = new Set([...(a.callBeasts || []), a.callBeast].filter(Boolean));
      const bCalls = new Set([...(b.callBeasts || []), b.callBeast].filter(Boolean));
      if ([...aCalls].some(x => bCalls.has(x))) strength += 0.22;
      const aClaims = new Set((a.claims || []).filter(x => x && x.beast && typeof x.real === 'boolean').map(x => `${x.beast}:${x.real}`));
      const bClaims = new Set((b.claims || []).filter(x => x && x.beast && typeof x.real === 'boolean').map(x => `${x.beast}:${x.real}`));
      if ([...aClaims].some(x => bClaims.has(x))) strength += 0.16;
      const aVote = (a.voteCommitments || []).map(x => x && x.beast).filter(Boolean);
      const bVote = (b.voteCommitments || []).map(x => x && x.beast).filter(Boolean);
      if (aVote.some(x => bVote.includes(x))) strength += 0.12;
      const publicBallotFor = (playerId) => {
        const chips = rd && rd.voteResults && rd.voteResults.chips;
        if (!chips || typeof chips !== 'object') return [];
        return Object.keys(chips).filter(beast => Array.isArray(chips[beast]) &&
          chips[beast].some(item => item && item.voterId === playerId));
      };
      const aActual = publicBallotFor(actorId), bActual = publicBallotFor(partnerId);
      if (aActual.length && bActual.length && aActual.some(x => bActual.includes(x))) strength += 0.16;
      const aBehavior = publicVoteBehavior(room, actorId, beforeRoundIndex);
      const bBehavior = publicVoteBehavior(room, partnerId, beforeRoundIndex);
      if ((aBehavior.mismatchCount || aBehavior.callMismatchCount) && (bBehavior.mismatchCount || bBehavior.callMismatchCount)) strength += 0.10;
    });
    return Math.max(0, Math.min(0.85, strength));
  }

  function evaluateYaoAmbushPass(bot, room, A, leftOverride) {
    const left = Array.isArray(leftOverride) ? leftOverride : Engine().remainingToAct(room);
    const rd = A && A.ctx && A.ctx.rd || U.curRound(room);
    const t = Number.isInteger(A && A.ctx && A.ctx.t) ? A.ctx.t : Number(room.currentRoundIdx || 0);
    const passOrder = Array.isArray(rd && rd.passOrder) ? rd.passOrder.map(x => typeof x === 'string' ? x : String(x && (x.id || x.playerId) || '')).filter(Boolean) : [];
    const victimId = A && A.ctx && A.ctx.log && A.ctx.log.ambushTargetId || null;
    const victim = victimId && U.byId(room, victimId);
    const partner = A && A.ctx && A.ctx.partner || null;
    const profiles = A && A.prof || {};
    const alreadyActed = [...new Set([...passOrder, bot.id])];
    const candidates = left.filter(p => p && p.id !== bot.id);
    const priorCount = Math.max(1, alreadyActed.length);
    const expectedGoodAfterPartner = left.filter(p => partner && p.id !== partner.id).reduce((sum, p) => {
      const r = profiles[p.id] || {};
      const pEvil = Number.isFinite(Number(r.evil)) ? Number(r.evil) / 100 : 0.5;
      const probs = r.probs || {};
      const pJi = Number.isFinite(Number(probs['姬雲浮'])) ? Number(probs['姬雲浮']) / 100 : 0.125;
      return sum + Math.max(0, Math.min(1, 1 - pEvil)) * Math.max(0, Math.min(1, 1 - pJi));
    }, 0);
    const partnerAvailable = !!(partner && candidates.some(p => p.id === partner.id));
    const linkStrength = partnerAvailable ? publicActorPartnerLink(room, bot.id, partner.id, t) : 0;
    const repeatPassPairCount = partnerAvailable ? publicPassPairHistory(room, bot.id, partner.id, t) : 0;
    const ownVoteBehavior = publicVoteBehavior(room, bot.id, t);
    const suspicion = victim ? publicPlayerSuspicion(room, victim.id, bot.id, t) : { score: 0, evidenceCount: 0 };
    const actorHasPublicYaoSignal = (room.rounds || []).slice(0, t + 1).some(history =>
      (history && history.speeches || []).some(sp => sp && sp.playerId === bot.id && /視野被中斷|偷襲|暗中襲擊|我是藥不然/.test(String(sp.text || ''))));
    const priorActorIds = new Set(alreadyActed.filter(id => id !== bot.id));
    const publiclySuspectedAlternatives = new Set();
    (room.rounds || []).slice(0, t + 1).forEach(history => (history && history.speeches || []).forEach(sp => {
      if (!sp) return;
      const d = publicSpeechData(sp, room, history);
      (d.accuse || []).forEach(a => { if (a && a.playerId && a.playerId !== bot.id && priorActorIds.has(a.playerId)) publiclySuspectedAlternatives.add(a.playerId); });
      if (d.callSuspectId && d.callSuspectId !== bot.id && priorActorIds.has(d.callSuspectId)) publiclySuspectedAlternatives.add(d.callSuspectId);
    }));
    const alternativeNoise = Math.min(0.38, publiclySuspectedAlternatives.size * 0.10);

    const rows = candidates.map(candidate => {
      const isVictim = !!(victim && candidate.id === victim.id);
      const isPartner = !!(partner && candidate.id === partner.id);
      // 反事實：直傳時受害者緊接在行動者之後；墊棒時，受害者可能在剩餘玩家中較後才行動。
      const directN = priorCount + 1;
      const broadNMin = priorCount + 2;
      const broadNMax = Math.max(broadNMin, room.players.length - 1);
      const directBase = Math.min(0.78, 0.58 / directN + 0.12);
      const bufferLow = 0.58 / broadNMax + 0.03;
      const bufferHigh = Math.min(0.78, 0.58 / broadNMin + 0.10);
      const publicSignalCost = actorHasPublicYaoSignal ? 0.035 : 0;
      // 公開承諾與實際票單不一致不是違規，但可能增加旁人追問／受害者回溯時的辨識線索。
      const voteMismatchCost = Math.min(0.16, ownVoteBehavior.mismatchCount * 0.055 + ownVoteBehavior.callMismatchCount * 0.035);
      const directRisk = Math.max(0.03, Math.min(0.92, directBase * (1 - alternativeNoise) + suspicion.score * 0.42 + publicSignalCost + voteMismatchCost));
      const bufferRisk = Math.max(0.03, Math.min(0.92, ((bufferLow + bufferHigh) / 2) * (1 - alternativeNoise) + suspicion.score * 0.42 + publicSignalCost + voteMismatchCost));
      const risk = isVictim ? directRisk : bufferRisk;
      // 老朝奉早拿手機的價值，按行動後仍有多少「預期可被擾亂的好人」估算；姬雲浮免疫機率用本 AI 自己的後驗折減。
      const laoSkillValue = isPartner
        ? Math.min(1.35, 0.24 + 0.15 * expectedGoodAfterPartner + (t < 2 ? 0.16 : 0))
        : (partnerAvailable ? Math.min(0.42, 0.08 + 0.045 * expectedGoodAfterPartner) : 0);
      // 相鄰能模糊隊友連線，但若兩人已公開同方向呼籲／主張，則相鄰反而放大連線風險。
      const adjacencyCamouflage = isPartner ? 0.18 * (1 - linkStrength) * (1 - Math.min(0.75, repeatPassPairCount * 0.35)) : 0;
      const adjacencyLinkRisk = isPartner ? 0.34 * linkStrength + Math.min(0.30, repeatPassPairCount * 0.13) : 0;
      // 前兩輪保留同伴尾家／下輪首家有價值；直接傳同伴會犧牲部分控位機會，但不把它當硬規則。
      const nextRoundLeadCost = isPartner && t < 2 ? 0.22 : 0;
      const roleValue = Number(profiles[candidate.id] && profiles[candidate.id].evil || 0) / 100;
      const roleProbs = profiles[candidate.id] && profiles[candidate.id].probs || {};
      const pZheng = U.clamp(Number(profiles[candidate.id] && profiles[candidate.id].pZheng != null
        ? profiles[candidate.id].pZheng : (Number(roleProbs['鄭國渠']) || 0) / 100) || 0, 0, 1);
      const zhengShieldPenalty = pZheng >= 0.72 ? 1.80 * ((pZheng - 0.72) / 0.28) : 0;
      const score = -2.35 * risk + laoSkillValue + adjacencyCamouflage - adjacencyLinkRisk - nextRoundLeadCost + (isVictim ? 0 : 0.03 * roleValue) - zhengShieldPenalty;
      return {
        candidateId: candidate.id,
        candidateName: candidate.name || U.tag(candidate),
        isVictim,
        isPartner,
        exposure: { low: Number((isVictim ? directRisk : Math.max(0.03, bufferLow * (1 - alternativeNoise) + suspicion.score * 0.42 + publicSignalCost)).toFixed(3)),
          high: Number((isVictim ? directRisk : Math.min(0.92, bufferHigh * (1 - alternativeNoise) + suspicion.score * 0.42 + publicSignalCost)).toFixed(3)),
          estimate: Number(risk.toFixed(3)), confidence: suspicion.evidenceCount ? 'medium' : 'low' },
        publicSuspicion: Number(suspicion.score.toFixed(3)),
      publiclySuspectedAlternatives: publiclySuspectedAlternatives.size,
        laoSkillValue: Number(laoSkillValue.toFixed(3)),
        adjacencyCamouflage: Number(adjacencyCamouflage.toFixed(3)),
        adjacencyLinkRisk: Number(adjacencyLinkRisk.toFixed(3)),
        nextRoundLeadCost: Number(nextRoundLeadCost.toFixed(3)),
        pZheng: Number(pZheng.toFixed(3)), zhengShieldPenalty: Number(zhengShieldPenalty.toFixed(3)),
        score: Number(score.toFixed(4))
      };
    });
    // Runtime player IDs contain Date.now()-based suffixes and are intentionally different
    // between otherwise identical simulation runs. Never feed them into a tactical tie-break.
    const stablePlayerKey = playerId => {
      const player = U.byId(room, playerId);
      return player ? String(player.botId || player.name || `seat:${player.seatIndex}`) : String(playerId || '');
    };
    const actorKey = String(bot.botId || bot.name || `seat:${bot.seatIndex}`);
    rows.sort((a, b) => b.score - a.score ||
      (stableRoll(`${room.roomId || ''}:${t}:${actorKey}:${stablePlayerKey(a.candidateId)}`) -
       stableRoll(`${room.roomId || ''}:${t}:${actorKey}:${stablePlayerKey(b.candidateId)}`)) ||
      stablePlayerKey(a.candidateId).localeCompare(stablePlayerKey(b.candidateId)));
    const chosen = rows[0] || null;
    return {
      version: '10.9', victimId, victimIds: [...new Set((A && A.ctx && A.ctx.log && A.ctx.log.ambushIds || []).map(String).filter(Boolean))], chosenId: chosen && chosen.candidateId,
      formula: 'score=-2.35*exposure+laoSkillValue+adjacencyCamouflage-adjacencyLinkRisk-nextRoundLeadCost+0.03*evilPosterior(for non-victim); exposure also includes public target suspicion, alternative suspect noise, role-signal and public commitment/ballot mismatch',
      publicSuspicion: suspicion,
      alternativeNoise,
      publiclySuspectedAlternatives: [...publiclySuspectedAlternatives],
      publicVoteBehavior: ownVoteBehavior,
      repeatPassPairCount,
      expectedGoodAfterPartner: Number(expectedGoodAfterPartner.toFixed(3)),
      candidates: rows,
      limitations: ['暴露風險是情境評分區間，不是經實戰校準的真實機率', '只使用本 AI 自己的後驗與公開發言／票型；不讀受害者或隊友私有 mind', '未來傳牌路徑未知，因此 buffer 風險以剩餘座位範圍估計']
    };
  }

  /* ---------------------------------------------------------------- 查驗階段 (智慧查驗升級) */

  S.chooseRoleBluffRole = chooseRoleBluffRole;
  S.teamRoleBluffAdjustment = teamRoleBluffAdjustment;
  S.evaluateYaoAmbushPass = evaluateYaoAmbushPass;

  S.inspectPicks = (bot, room) => {
    const rd = U.curRound(room);
    const quota = Rules.inspectQuota(bot);
    
    const attention = {};
    rd.beasts.forEach(b => { attention[b.name] = 0; });
    
    (rd.speeches || []).forEach(sp => {
      const publicData = publicSpeechData(sp, room, rd);
      (Array.isArray(publicData.claims) ? publicData.claims : []).forEach(c => {
        if (c && attention[c.beast] !== undefined) attention[c.beast] += 3;
      });
      const called = [...new Set([...(publicData.callBeasts || []), publicData.callBeast].filter(Boolean))];
      called.forEach(beast => { if (attention[beast] !== undefined) attention[beast] += 2; });
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
        const state = evilStrategicState(room, bot);
        const impact = pool.reduce((sum, p) => {
          const probs = A.prof[p.id] && A.prof[p.id].probs || {};
          const pGood = ((probs['許願'] || 0) + (probs['方震'] || 0) + (probs['姬雲浮'] || 0) + (probs['黃煙煙'] || 0) + (probs['木戶加奈'] || 0)) / 100;
          const pVulnerable = U.clamp(1 - ((probs['方震'] || 0) + (probs['姬雲浮'] || 0)) / 100, 0, 1);
          const xuValue = 0.65 + ((probs['許願'] || 0) / 100) * 0.9;
          return sum + pGood * pVulnerable * xuValue;
        }, 0);
        const likelyXu = pool.some(p => ((A.prof[p.id] && A.prof[p.id].probs && A.prof[p.id].probs['許願']) || 0) >= 28);
        let chance = U.clamp(0.30 + 0.45 * genes.deception, 0.15, 0.85);
        if (state.posture === 'conceal') chance -= 0.08;
        if (state.posture === 'desperate') chance += 0.15;
        if (likelyXu) chance += 0.18;
        // 技能有實質影響且存在足夠目標時，適度降低無理由保留；仍保留策略性不發動空間。
        const meaningfulTarget = pool.length >= 2 && impact >= 0.38;
        if (meaningfulTarget) chance += 0.10 + 0.04 * U.clamp(Number(genes.assertiveness) || 0.5, 0, 1);
        // 無技能深水偽裝：只在低價值、非許願目標時才保留擾亂。
        const reserveForCover = state.posture === 'conceal' && !likelyXu && impact < 0.24 && pool.length > 0;
        if (reserveForCover) chance *= 0.72;
        chance = U.clamp(chance, 0.10, 0.95);
        const active = pool.length > 0 && impact >= 0.12 && rnd() < chance;
        persistOwnLog(ctx, {
          laoSkillDecision: active ? 'activate' : 'reserve-or-no-impact',
          laoSkillReason: active ? (likelyXu ? 'high-value-Xu-window' : 'estimated-view-disruption') :
            (reserveForCover ? 'concealment-reserve-low-impact' : 'low-impact-or-no-target'),
          laoSkillChance: Math.round(chance * 100) / 100, laoSkillImpact: Math.round(impact * 100) / 100
        });
        return { kind: 'lao', active };
      }
      case '藥不然': {
        const leftIds = new Set(Engine().remainingToAct(room).map(p => p.id));
        const state = evilStrategicState(room, bot);
        const selfPos = rd.passOrder.indexOf(bot.id);
        // Lao can deliberately pass to Yao only when the shared stable roll says the swap setup is viable.
        // Re-evaluating the same helper here guarantees pass and skill decisions use the exact same roll.
        const frameEligible = selfPos === 1 && !!ctx.partner && rd.passOrder[0] === ctx.partner.id && leftIds.size >= 2;
        const frameActive = frameEligible && shouldActivateThirdSeatFrame(room, bot, ctx.partner, ctx.t);
        const cand = Object.values(A.prof)
          .filter(r => (!ctx.partner || r.player.id !== ctx.partner.id) && !r.knownEvil && !r.player.isPermanentlyAmbushed && !r.player.isAmbushed && !r.player.pendingAmbush && !r.player.pendingImmediateAmbush)
          .filter(r => frameActive ? leftIds.has(r.player.id) : (ctx.t < 2 || leftIds.has(r.player.id)))
          .map(r => {
            const pXu = r.probs['許願'] || 0;
            const pFang = r.probs['方震'] || 0;
            const pJi = r.probs['姬雲浮'] || 0;
            const pLikelyGood = U.clamp(((r.probs['許願'] || 0) + (r.probs['方震'] || 0) + (r.probs['姬雲浮'] || 0) + (r.probs['黃煙煙'] || 0) + (r.probs['木戶加奈'] || 0)) / 100, 0, 1);
            const actBonus = leftIds.has(r.player.id) ? (ctx.t === 2 ? 18 : 10) : 0;
            const postureBonus = state.posture === 'desperate' ? pFang * 0.35 + pXu * 0.12 : 0;
            // A credible good-side victim gives the frame a plausible public story; still prefer a target that has strategic value.
            const frameBonus = frameActive ? 18 * pLikelyGood + Math.max(0, r.ally - r.evil) * 0.04 : 0;
            return {
              r,
              s: pXu * 0.95 + pFang * (ctx.t === 2 ? 2.25 : 1.8) + pJi * 0.55 + r.ally * 0.25 + actBonus + postureBonus + frameBonus + rnd() * 8
            };
          })
          .sort((a, b) => b.s - a.s);
        if (!cand.length) return { kind: 'skip' };
        const selected = cand[0].r.player;
        if (frameActive) {
          persistOwnLog(ctx, {
            ambushFrameTactic: true,
            ambushFrameRound: ctx.t + 1,
            ambushFrameVictimId: selected.id
          });
        }
        return { kind: 'yao', targetId: selected.id };
      }
      case '鄭國渠': {
        const leftToAct = Engine().remainingToAct(room);
        if (leftToAct.length === 0) return { kind: 'skip' };
        const seenReal = ctx.myIns.find(i => GD.Mind.inspectionTruth(i) === true);
        const inferredReal = [...(A.post || [])].sort((a, b) => b.pReal - a.pReal)[0];
        const beast = seenReal ? seenReal.beastName : (inferredReal && inferredReal.name) || pickDecision(rd.beasts).name;
        return { kind: 'zheng', beast };
      }
      default: return { kind: 'skip' };
    }
  };

  /* ---------------------------------------------------------------- 傳遞階段 */

  S.nextPlayer = function (bot, room, A) {
    const left = Engine().remainingToAct(room);
    if (!left.length) return null;
    // 引擎在 Strategy.skill() 之後會把 ambushIds／ambushTargetId 寫回原始 log。
    // 重新讀取自己的安全視圖，保留新動作欄位，同時再次排除 flipped 稽核位元。
    const freshOwnContext = Mind.context(bot, room);
    A.ctx.log = freshOwnContext.log;
    A.ctx.myIns = freshOwnContext.myIns;
    const rd = A.ctx.rd, t = A.ctx.t;
    const recOf = p => A.prof[p.id];
    const choose = (p, why) => { persistOwnLog(A.ctx, { passWhy: why }); return p.id; };
    const trust = p => (recOf(p)?.ally || 0) - (recOf(p)?.evil || 0);
    const basis = p => {
      const r = recOf(p);
      return r && r.reasons[0] ? `（${r.reasons[0]}）` : '（目前沒有任何可疑紀錄）';
    };

    if (left.length === 1) return choose(left[0], '只剩他還沒行動，沒有其他選擇');

    // For a selected long-con, the real Lao must sometimes deliberately give the phone to the real Yao as position two.
    // This is the missing setup step: ordinary evil-position logic intentionally kept the partner late, so complete games saw zero frames.
    if (bot.role === '老朝奉') {
      const yao = room.players.find(p => p.role === '藥不然');
      const laoPos = rd.passOrder.indexOf(bot.id);
      if (yao && laoPos === 0 && !rd.passOrder.includes(yao.id) && left.some(p => p.id === yao.id) &&
          shouldActivateThirdSeatFrame(room, yao, bot, t)) {
        return choose(yao, `這局採用長線嫁禍布局：我先把手機傳給同伴以形成第二位偷襲第三位的可反轉時序；後續再用持續否認與角色互換故事混淆判斷。`);
      }
    }

    /* 藥不然通常不直接把手機傳給受害者；但偶爾啟動第三位栽贓戰術時，刻意直傳是整個陷阱的一部分。 */
    const justAmbushedIds = A.ctx.log.ambushIds || [];
    if (bot.role === '藥不然' && justAmbushedIds.length && left.length > 1) {
      const passPos = A.ctx.rd.passOrder.indexOf(bot.id);
      const frameVictimId = A.ctx.log.ambushTargetId;
      const frameVictim = frameVictimId && U.byId(room, frameVictimId);
      // 舊存檔可能仍帶有 ambushFrameTactic；不再執行固定第三位栽贓路線。
      // 保留下方 evaluateYaoAmbushPass，正常藥不然偷襲後仍可依風險選擇傳牌對象。
      const passAudit = evaluateYaoAmbushPass(bot, room, A, left);
      const passPick = left.find(p => p.id === passAudit.chosenId);
      if (passPick) {
        persistOwnLog(A.ctx, { passDecisionAudit: passAudit });
        const row = passAudit.candidates.find(x => x.candidateId === passPick.id);
        const victimTag = frameVictim ? U.tag(frameVictim) : '受害者';
        const why = row && row.isVictim
          ? `我比較了直傳與墊棒：${victimTag}目前沒有公開點名我的強證據，且前置行動者已形成足夠候選來源；本次直傳的情境暴露估計約${Math.round(row.exposure.estimate * 100)}%，因此不再機械式避開受害者。`
          : `我比較了直傳${victimTag}與其他傳牌路線，選擇${U.tag(passPick)}：此選項的暴露風險分數約${Math.round((row ? row.exposure.estimate : 0.5) * 100)}/100，老朝奉技能價值${row ? row.laoSkillValue.toFixed(2) : '0.00'}，隊友連線風險${row ? row.adjacencyLinkRisk.toFixed(2) : '0.00'}；同時保留對下輪首家利益的權衡。`;
        return choose(passPick, why);
      }
    }

    if (A.ctx.isGood) {
      /* ★ 方震已知壞人：前兩輪保留原本控位；第三輪允許策略自行權衡，不一律禁止傳給他 */
      const knownEvilLeft = bot.role === '方震' ? left.find(p => {
        return room.rounds.some(r => {
          const l = r.turnLogs[bot.id];
          return l && l.fangTargetId === p.id && l.fangCamp === 'evil';
        });
      }) : null;
      if (knownEvilLeft && left.length >= 2 && t < 2) {
        return choose(knownEvilLeft, `我親手查驗出${U.tag(knownEvilLeft)}是壞人；前兩輪若讓他落尾家，下一輪可能取得首家先手，因此現在讓他提前行動`);
      }
      /* 第三輪不在這裡直接 return：讓一般信任排序決定是否傳給已知壞人；若真的選中，下面會給出身分掩護理由。 */
      /* 方震第六位：本輪剛直接查驗為好人的玩家優先留第八位，不能被一般嫌疑分數覆蓋。
         這避免像 v10.8.10 實戰一樣，把黑色已驗好人送第七，卻把未查明的藥不然送第八。 */
      if (bot.role === '方震' && t < 2 && A.ctx.myPos === 5 && left.length === 2) {
        const directlyVerifiedGood = new Set((room.rounds || []).map(historyRound => {
          const check = historyRound && historyRound.turnLogs && historyRound.turnLogs[bot.id];
          return check && check.fangCamp === 'good' ? check.fangTargetId : null;
        }).filter(Boolean));
        const protectedGood = left.find(player => directlyVerifiedGood.has(player.id));
        if (protectedGood) {
          const unverified = left.find(player => player.id !== protectedGood.id);
          if (unverified) {
            return choose(unverified, `我已用方震能力直接查驗${U.tag(protectedGood)}屬於好人陣營；第六位控尾家時，先讓尚未確認的${U.tag(unverified)}行動放第七位，把直接驗好的${U.tag(protectedGood)}留在第八位尾家，避免把已確認好人送入不必要的風險，也不把未查明者當成鐵好人。`);
          }
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
          if (t === 2 && knownEvilLeft && p.id === knownEvilLeft.id) sc += 1000;
          return sc;
        };

        const scA = scoreEvilFor7th(pA), scB = scoreEvilFor7th(pB);
        const send7th = t === 2
          ? (scA <= scB ? pA : pB)
          : (scA >= scB ? pA : pB);
        const keep8th = t === 2
          ? (scA <= scB ? pB : pA)
          : (scA >= scB ? pB : pA);

        /* 最後一輪控尾家：第七位先放嫌疑較低者，若有方震已知壞人則優先將他留在第八位。 */
        if (t === 2) {
          const send7th = scA <= scB ? pA : pB;
          const keep8th = scA <= scB ? pB : pA;
          if (knownEvilLeft && keep8th.id === knownEvilLeft.id) {
            return choose(send7th, `第三輪已沒有下一回合首家優勢；我把手機傳給嫌疑較低的${U.tag(send7th)}放第七位，讓我親手查驗確認的壞人${U.tag(knownEvilLeft)}留在第八位尾家，優先控制最後一輪行動順序`);
          }
          return choose(send7th, `第三輪是最後一輪，沒有下一回合首家優勢；我先把嫌疑較低的${U.tag(send7th)}放在第七位，讓嫌疑較高的${U.tag(keep8th)}留在第八位尾家，控制最後一輪的行動順序`);
        }
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

      /* 方震 R1 查明的好人：R2 若方震在第 3 位，預設不要把這名已驗好人直接送成第 4 位。
         第四位之後雜訊／反轉風險更高；只有場上已形成方震身分壓力時，才偶爾刻意反常傳遞以藏身。 */
      if (bot.role === '方震' && t === 1 && A.ctx.myPos === 2 && left.length > 1) {
        const firstRoundLog = room.rounds[0] && room.rounds[0].turnLogs && room.rounds[0].turnLogs[bot.id];
        const verifiedGoodId = firstRoundLog && firstRoundLog.fangTargetId && firstRoundLog.fangCamp === 'good'
          ? firstRoundLog.fangTargetId : null;
        const verifiedGoodLeft = verifiedGoodId && left.find(p => p.id === verifiedGoodId);
        if (verifiedGoodLeft) {
          const rolePressure = (room.rounds || []).slice(0, t + 1).some(historyRound =>
            (historyRound.speeches || []).some(sp => {
              if (!sp || sp.playerId === bot.id) return false;
              const parsed = publicSpeechData(sp, room, rd);
              return parsed.selfRole === '方震' || (parsed.campChecks || []).length > 0 ||
                /我是(?:【)?方震|懷疑.{0,5}方震|方震.*(假跳|冒充|身份)/.test(String(sp.text || ''));
            })
          );
          if (rolePressure && rnd() < 0.18) {
            return choose(verifiedGoodLeft, `我第一輪已查明${U.tag(verifiedGoodLeft)}是好人；場上已有人把討論帶到方震身分，我這次刻意反常把他放到第四位，讓自己看起來不像在保護已驗好的人，承擔藏身與反轉風險`);
          }
          const candidates = left.filter(p => p.id !== verifiedGoodId)
            .map(p => ({ p, tie: (rnd() - 0.5) * 10 }))
            .sort((a, b) => (trust(b.p) - trust(a.p)) || (a.tie - b.tie))
            .map(x => x.p);
          if (candidates.length) {
            const pick = candidates[0];
            return choose(pick, `我第一輪已用方震能力確認${U.tag(verifiedGoodLeft)}是好人；若我現在在第三位把他直接送成第四位，會讓這個特殊保護痕跡過於明顯，也把他放進較需要反轉校正的位置。除非我刻意藏身，這次先讓${U.tag(pick)}成為第四位，之後再安排已驗好的人`);
          }
        }
      }

      /* 前中段（第 1～4 位）：挑最放心的好人先查驗拿乾淨資訊 */
      const sorted = [...left]
        .map(p => ({ p, tie: (rnd() - 0.5) * 10 }))
        .sort((a, b) => (trust(b.p) - trust(a.p)) || (a.tie - b.tie))
        .map(x => x.p);
      const pick = sorted[0];
      if (t === 2 && bot.role === '方震' && knownEvilLeft && pick.id === knownEvilLeft.id) {
        return choose(pick, `第三輪沒有下一回合首家優勢。我明知${U.tag(knownEvilLeft)}是壞人仍把手機傳給他，不是為了消耗不存在的下輪先手，而是用反常傳遞淡化我掌握的方震查驗線索；這會放棄控尾家收益，若被追問可以裝成判斷失誤／不小心傳錯人，也可能被旁人解讀成偽裝壞人`);
      }
      if (t === 2 && bot.role === '方震' && knownEvilLeft) {
        return choose(pick, `第三輪沒有下一回合首家優勢；我先讓${U.tag(pick)}行動，保留之後讓已知壞人${U.tag(knownEvilLeft)}留在尾家的機會。這一手是在控最後一輪順序，不是把下輪先手當成理由${basis(pick)}`);
      }
      return choose(pick, `他是剩下的人裡我最放心的好人人選${basis(pick)}，先讓他查驗掌握乾淨資訊`);
    }

    const inferredPartner = bot.role === '鄭國渠' ? inferEvilTeammate(bot, A, room) : null;
    const partner = A.ctx.partner || (inferredPartner && inferredPartner.player) || null;
    const partnerLeft = partner && left.find(p => p.id === partner.id);

    /* ---- 壞人位置學 ---- */
    if (A.ctx.myPos === 5 && left.length === 2) {
      const other = left.find(p => !(partner && p.id === partner.id)) || left[0];
      if (t < 2 && partnerLeft) {
        const state = evilStrategicState(room, bot);
        const tailChance = state.posture === 'desperate' ? 0.82 : state.posture === 'conceal' ? 0.25 + 0.15 * A.ctx.genes.deception : 0.35 + 0.55 * A.ctx.genes.deception;
        if (rnd() < tailChance) {
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

    if (bot.role === '藥不然' && partnerLeft && t === 2) {
      return choose(partner, `第三輪沒有下一輪先手收益；我把查驗順序交給秘密同伴，由他依自己掌握的行動資訊決定後續策略`);
    }

    if (bot.role === '老朝奉') {
      const goodish = [...left].sort((a, b) => trust(b) - trust(a));
      return choose(goodish[0], `我作為老朝奉會把查驗機會送給看起來最像好人的他，讓公開判斷更容易產生分歧${basis(goodish[0])}`);
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
        const parsed = publicSpeechData(sp, room, rd);
        if (((parsed.campChecks || []).length || parsed.callSuspectId) || /鐵好人|鐵壞人|陣營|一起指認|看緊/.test(txt)) {
          return sp.playerId;
        }
      }
    }
    return null;
  }

  // Only suppress a private claim when it adds little new information: at least one independent
  // first-three pass-order claimant already said the same thing and our own evidence is clear,
  // or two early claimants independently align. Conflicts stay visible; the rule is not blanket silence.
  function reduceRedundantPublicClaims(bot, room, ctx, A, plan) {
    if (!ctx.isGood || !Array.isArray(plan.claims) || !plan.claims.length || plan.bluff ||
        plan.fakeFangClaim || plan.roleBluff || plan.confess) {
      return { hidden: [], kept: (plan.claims || []).slice() };
    }
    const rd = ctx.rd;
    const getId = item => typeof item === 'string' ? item : String(item && (item.playerId ?? item.id) || '');
    const speechOrder = Array.isArray(rd.speechOrder) && rd.speechOrder.length
      ? rd.speechOrder.map(getId)
      : (rd.speeches || []).map(sp => String(sp.playerId));
    const ownSpeechIndex = speechOrder.indexOf(String(bot.id));
    const prior = (rd.speeches || []).filter(sp => {
      if (!sp || sp.playerId === bot.id) return false;
      const ix = speechOrder.indexOf(String(sp.playerId));
      return ownSpeechIndex >= 0 ? ix >= 0 && ix < ownSpeechIndex : true;
    });
    const readClaims = sp => {
      if (GD.Claims && typeof GD.Claims.parseRecord === 'function') {
        try { return GD.Claims.parseRecord(sp, room, rd).claims || []; } catch (_) {}
      }
      const parsed = publicSpeechData(sp, room, rd);
      if (Array.isArray(parsed.claims) && parsed.claims.length) return parsed.claims;
      if (GD.Claims && typeof GD.Claims.parse === 'function') {
        try { return GD.Claims.parse(String(sp.text || ''), room, rd).claims || []; } catch (_) {}
      }
      return [];
    };
    const kept = [], hidden = [];
    for (const claim of plan.claims) {
      const posterior = (A.post || []).find(x => x.name === claim.beast);
      const confidence = posterior
        ? (claim.real ? posterior.pReal : 1 - posterior.pReal)
        : 0.5;
      const matches = new Set(), conflicts = new Set();
      prior.forEach(sp => {
        const pos = (rd.passOrder || []).indexOf(sp.playerId);
        if (pos < 0 || pos > 2) return; // first-three position in passOrder, not speechOrder
        readClaims(sp).filter(c => c && c.beast === claim.beast && typeof c.real === 'boolean')
          .forEach(c => (c.real === claim.real ? matches : conflicts).add(sp.playerId));
      });
      const sufficientlyClear = confidence >= 0.82;
      const redundant = !conflicts.size && (matches.size >= 2 || (matches.size >= 1 && sufficientlyClear));
      if (redundant) hidden.push({ beast: claim.beast, real: claim.real, confidence, matchedEarlyClaimants: [...matches] });
      else kept.push(claim);
    }
    if (hidden.length) {
      plan.claims = kept;
      plan.withholdInfo = true;
      plan.withheldClaims = hidden;
      plan.withholdReason = '同一結論已由可信的前三傳遞順位提供，且自身後驗支持；保留私密細節以避免重複洩漏';
      persistOwnLog(ctx, {
        withheldRedundantInfo: hidden.map(x => ({ beast: x.beast, real: x.real, matchedEarlyClaimants: x.matchedEarlyClaimants })),
        withholdInfoReason: plan.withholdReason
      });
      plan.why.push(`資訊揭露策略：有 ${hidden.length} 項查驗已由前三傳遞順位的獨立宣稱重複支持，且後驗清楚；本輪不重複公開，仍依完整私密資料決定投票`);
    }
    return { hidden, kept: plan.claims.slice() };
  }

  S.reduceRedundantPublicClaims = reduceRedundantPublicClaims;

  // 選擇可公開判為贗品的目標；已知真品絕不可被選作認壞／跳壞目標。
  function chooseCounterfeitTarget(myIns, ranked, preferred) {
    const inspections = Array.isArray(myIns) ? myIns : [];
    const rankedList = Array.isArray(ranked) ? ranked.filter(item => item && item.name) : [];
    const availableNames = new Set(rankedList.map(item => item.name));
    const isAvailable = name => !!name && (availableNames.size === 0 || availableNames.has(name));
    const realNames = new Set(inspections
      .filter(item => item && GD.Mind.inspectionTruth(item) === true && item.beastName)
      .map(item => item.beastName));

    // 優先目標只有在本輪確實出現、且沒有被自己確認為真品時才可使用。
    if (isAvailable(preferred) && !realNames.has(preferred)) return preferred;

    const knownFake = inspections.find(item => item && GD.Mind.inspectionTruth(item) === false &&
      item.beastName && isAvailable(item.beastName));
    if (knownFake) return knownFake.beastName;

    const candidates = rankedList
      .filter(item => isAvailable(item.name) && !realNames.has(item.name))
      .sort((a, b) => (Number.isFinite(Number(a.pReal)) ? Number(a.pReal) : 0.5) -
        (Number.isFinite(Number(b.pReal)) ? Number(b.pReal) : 0.5));
    // 沒有任何可安全宣稱為贗品的目標時，回傳 null；絕不退回已確認真品。
    return candidates.length ? candidates[0].name : null;
  }
  // 好人不假扮壞人角色或假認壞；這會破壞好人勝利目標並製造錯誤的票向訊號。
  function buildRoleBluffPool(bot, ctx, allowCounterBluff = false) {
    const isGood = ctx && typeof ctx.isGood === 'boolean' ? ctx.isGood : !!(GD.isGood && bot && GD.isGood(bot.role));
    return [...(GD.ROLE_ORDER || []).filter(role => role !== (bot && bot.role) &&
      // 真方震沒有許願的雙獸首查驗能力，不能選這個必須能交代兩筆查驗的假身分。
      !(bot && bot.role === '方震' && role === '許願') &&
      // 好人平時只用好人角色做掩護；被公開指認時才開放低機率反反心理，不代表承諾角色是真實身分。
      (!isGood || allowCounterBluff || !GD.ROLES || !GD.ROLES[role] || GD.ROLES[role].camp !== 'evil')), '平民'];
  }
  function enforcePublicTargetAnchor(ballot, target, maxSpend) {
    const limit = Math.max(0, Math.floor(Number(maxSpend) || 0));
    if (!target || limit < 1) return {};

    const out = {};
    Object.keys(ballot && typeof ballot === 'object' ? ballot : {}).forEach(name => {
      const votes = Math.max(0, Math.floor(Number(ballot[name]) || 0));
      if (votes > 0) out[name] = votes;
    });

    const totalVotes = () => Object.values(out).reduce((sum, votes) => sum + votes, 0);
    // 先把超額票數削回可用籌碼；優先保留公開目標，其次保留原本分票最多的結構。
    while (totalVotes() > limit) {
      const donors = Object.keys(out).filter(name => name !== target && out[name] > 0)
        .sort((a, b) => out[b] - out[a] || a.localeCompare(b));
      const donor = donors[0] || (out[target] > 0 ? target : null);
      if (!donor) break;
      out[donor] -= 1;
      if (out[donor] <= 0) delete out[donor];
    }

    let total = totalVotes();
    // 最佳化器若刻意回傳空票，公開表演仍至少要有一票可供後續核對。
    if (total === 0) return { [target]: 1 };

    // 先確保公開號召目標有票，不把其他籌碼全灌到目標。
    if (!out[target]) {
      const donor = Object.keys(out).filter(name => name !== target && out[name] > 0)
        .sort((a, b) => out[b] - out[a] || a.localeCompare(b))[0];
      if (donor) {
        out[donor] -= 1;
        if (out[donor] <= 0) delete out[donor];
      }
      out[target] = 1;
    }

    // 公開目標必須是主票方向（可與另一尊並列最多），其餘票仍可分配。
    // 只在既有配置間移動籌碼，不新增票數，也不破壞分票能力。
    while (true) {
      const donors = Object.keys(out).filter(name => name !== target && out[name] > 0)
        .sort((a, b) => out[b] - out[a] || a.localeCompare(b));
      if (!donors.length || out[target] >= out[donors[0]]) break;
      const donor = donors[0];
      out[donor] -= 1;
      if (out[donor] <= 0) delete out[donor];
      out[target] = (out[target] || 0) + 1;
    }
    return out;
  }
  S.chooseCounterfeitTarget = chooseCounterfeitTarget;
  S.buildRoleBluffPool = buildRoleBluffPool;
  S.assessFinalRoleCandidates = assessFinalRoleCandidates;
  S.finalDeductionNarrative = finalDeductionNarrative;
  S.deriveDialogueFocus = deriveDialogueFocus;
  S.roleBluffFeasibility = roleBluffFeasibility;
  S.latestPublicRoleClaims = latestPublicRoleClaims;
  S.chooseRoleBluffRole = chooseRoleBluffRole;
  S.findCrediblePressuredAlly = findCrediblePressuredAlly;
  S.enforcePublicTargetAnchor = enforcePublicTargetAnchor;

  function ensureFakeXuAbilityProfile(plan, bot, rd, A, roundIndex) {
    if (!plan || !plan.roleBluff || plan.roleBluff.role !== '許願' || !bot || bot.role === '許願') return plan;
    const currentNames = (rd && rd.beasts || []).map(beast => beast.name);
    if (currentNames.length < 2) return plan;
    const visible = (Array.isArray(plan.claims) ? plan.claims : [])
      .filter(item => item && currentNames.includes(item.beast));
    const hidden = (Array.isArray(plan.withheldClaims) ? plan.withheldClaims : [])
      .filter(item => item && currentNames.includes(item.beast));
    const all = [];
    [...visible, ...hidden].forEach(item => {
      if (!all.some(existing => existing.beast === item.beast)) all.push({ ...item });
    });
    const ranked = [...(A && A.post || [])].filter(item => currentNames.includes(item.name))
      .sort((a, b) => b.pReal - a.pReal || zIdx(a.name) - zIdx(b.name));
    const first = all[0] || visible[0] || {
      beast: plan.beast || (ranked[0] && ranked[0].name), real: true, source: 'cover-story'
    };
    if (first.beast && !all.some(item => item.beast === first.beast)) all.unshift(first);
    if (new Set(all.map(item => item.beast)).size < 2) {
      const second = ranked.find(item => item.name !== first.beast);
      if (second) all.push({ beast: second.name, real: second.pReal >= 0.5, source: 'inferred-cover-story' });
    }
    const byBeast = new Map();
    all.forEach(item => { if (item && item.beast && !byBeast.has(item.beast)) byBeast.set(item.beast, item); });
    const sources = [...byBeast.values()].slice(0, 2);
    if (sources.length < 2) return plan;

    // Keep an already-public first result, but allow the second distinct beast to remain withheld.
    // The cover story records two different beast sources without forcing full disclosure every round.
    const publicName = visible[0] && visible[0].beast || sources[0].beast;
    const publicClaim = sources.find(item => item.beast === publicName) || sources[0];
    const withheldClaims = sources.filter(item => item.beast !== publicClaim.beast)
      .map(item => ({ ...item, source: item.source || 'withheld-roleplay-source' }));
    const retainOtherPublic = visible.length >= 2 && !plan.withholdInfo;
    if (!retainOtherPublic) {
      plan.claims = [publicClaim];
      plan.withheldClaims = [...hidden.filter(item => item.beast !== publicClaim.beast), ...withheldClaims]
        .filter((item, index, array) => array.findIndex(other => other.beast === item.beast) === index);
      plan.withholdInfo = true;
      plan.withholdReason = plan.withholdReason || '假扮許願時保留一筆不同獸首來源，不必每輪公開兩尊完整結果';
    }
    plan.roleBluff.abilityProfile = {
      kind: 'double-inspection', minimumDistinctBeasts: 2,
      beastNames: sources.map(item => item.beast), round: Number(roundIndex) + 1,
      publicBeastNames: retainOtherPublic ? visible.map(item => item.beast) : [publicClaim.beast],
      withheldBeastNames: retainOtherPublic ? [] : withheldClaims.map(item => item.beast),
      secondSourceType: sources[1].source || 'withheld-roleplay-source'
    };
    return plan;
  }

  S.ensureFakeXuAbilityProfile = ensureFakeXuAbilityProfile;

  function visibleInteractionSpeeches(bot, room, ctx) {
    const rows = [];
    for (let roundIndex = 0; roundIndex <= ctx.t; roundIndex++) {
      const rd = room.rounds && room.rounds[roundIndex];
      if (!rd) continue;
      let speeches = Array.isArray(rd.speeches) ? rd.speeches : [];
      if (roundIndex === ctx.t) {
        const order = Array.isArray(rd.speechOrder) ? rd.speechOrder : [];
        const mySpeechPosition = order.indexOf(bot.id);
        if (mySpeechPosition >= 0) {
          speeches = speeches.filter(sp => {
            if (sp && sp.voiceTranscript === true) return true; // async public captions are not constrained by formal speech order
            const position = order.indexOf(sp && sp.playerId);
            return position >= 0 && position < mySpeechPosition;
          });
        } else speeches = speeches.filter(sp => sp && sp.playerId !== bot.id);
      }
      speeches.forEach(sp => {
        if (!sp || !sp.playerId || sp.playerId === bot.id) return;
        rows.push({ roundIndex, rd, sp, data: publicSpeechData(sp, room, rd) });
      });
    }
    return rows;
  }

  function classifyAskedKind(text) {
    const value = String(text || '');
    if (/後來(?:公開)?判(?:為)?贗品|後來判假|公開判假的獸/.test(value)) return 'fake_vote';
    if (/號召|喊票|實際.*(?:投|票單)|票單.*(?:喊|號召)/.test(value)) return 'vote_dissonance';
    if (/同一段發言|同一句|同時用了真品和贗品|真品和贗品兩種說法/.test(value)) return 'speech_contradiction';
    if (/前後(?:兩次|說法|判斷)|之前.*後來.*(?:真品|贗品)|前後判斷的差別/.test(value)) return 'claim_shift';
    if (/技能時點|查驗結果不同|查驗紀錄|我的(?:查驗|結果|查驗畫面)|反轉時點/.test(value)) return 'inspection_conflict';
    if (/你和.{0,30}分別自稱|互換身分|角色互換|兩個身分分開認領/.test(value)) return 'role_swap';
    if (/角色說法.*(?:改變|差異)|自稱.{0,18}又說|之前說自己是.{0,22}後來又自稱/.test(value)) return 'role_shift';
    if (/身份猜測|身分猜測|角色猜測|某角色.{0,12}猜測|提出的.{0,8}猜測|提過.{0,8}猜測/.test(value)) return 'role_hypothesis';
    if (/把.{0,16}說成|角色依據|自稱.{0,12}又/.test(value)) return 'role_claim';
    return '';
  }

  function selectInteractionChallenge(bot, room, A) {
    const ctx = A && A.ctx;
    const rd = ctx && ctx.rd;
    if (!bot || !room || !ctx || !rd || !Array.isArray(room.players)) return null;

    const visible = visibleInteractionSpeeches(bot, room, ctx);
    const askedTargets = new Set();
    const usedKinds = new Set();
    visible.filter(row => row.roundIndex === ctx.t).forEach(row => {
      const asked = Array.isArray(row.data.asked) ? row.data.asked : [];
      asked.forEach(id => askedTargets.add(String(id)));
      const kind = classifyAskedKind(row.sp.text);
      if (kind) usedKinds.add(kind);
    });
    // Multiple different people may be questioned in one round, but never keep asking the same person.
    if (askedTargets.size >= 3) return null;

    const protectedIds = new Set();
    if (ctx.partner && ctx.partner.id) protectedIds.add(String(ctx.partner.id));
    (A.inferredPartners || []).forEach(item => { if (item && item.playerId) protectedIds.add(String(item.playerId)); });
    const inferredMate = !ctx.isGood ? inferEvilTeammate(bot, A, room) : null;
    if (inferredMate && inferredMate.player) protectedIds.add(String(inferredMate.player.id));

    const candidates = [];
    const push = (targetId, kind, evidence, baseScore, roundNum) => {
      const id = String(targetId || '');
      const target = U.byId(room, id);
      if (!target || id === String(bot.id) || askedTargets.has(id) || protectedIds.has(id)) return;
      const profile = A.prof && A.prof[id];
      if (ctx.isGood && profile && (profile.knownGood || profile.confessed || profile.knownCamp === 'good')) return;
      if (!ctx.isGood && profile && (profile.knownEvil || profile.confessed || profile.knownCamp === 'evil' || Number(profile.ally || 0) >= 82)) return;
      const suspicion = ctx.isGood ? Math.max(0, Math.min(2.2, Number(profile && profile.evil || 0) / 28)) : 0;
      const diversity = usedKinds.has(kind) ? -1.8 : 0;
      const score = baseScore + suspicion + diversity;
      candidates.push({ targetId: id, kind, evidence: evidence || {}, round: roundNum || null, score });
    };

    // 1. Direct conflict between this bot's own visible inspection and a prior public claim.
    // 許願的雙查驗資訊必須保留：不以私人查驗衝突作為公開盤問素材，避免暴露她看過哪些獸首。
    if (bot.role !== '許願') {
      Object.values(A.prof || {}).forEach(profile => {
        (profile && profile.conflicts || []).forEach(conflict => {
          if (!conflict || !conflict.speakerId || !conflict.beast) return;
          push(conflict.speakerId, 'inspection_conflict', {
            beast: conflict.beast, claimedReal: conflict.claim, sawReal: conflict.saw,
            round: conflict.round, speakerPosition: conflict.speakerPos
          }, 9.6, conflict.round);
        });
      });
    }

    // 2. A player's own speech contradicts itself in one statement.
    visible.forEach(row => (row.data.selfContradictions || []).forEach(item => {
      if (!item || !item.beast || !Array.isArray(item.verdicts) || !item.verdicts.includes(true) || !item.verdicts.includes(false)) return;
      push(row.sp.playerId, 'speech_contradiction', {
        beast: item.beast, round: row.roundIndex + 1, verdicts: item.verdicts.slice()
      }, 9.2, row.roundIndex + 1);
    }));

    // 3. Across public speeches, ask about a changed verdict without assuming that changing one's mind is guilt.
    const claimHistory = new Map();
    visible.forEach(row => (row.data.claims || []).forEach(claim => {
      if (!claim || !claim.beast || typeof claim.real !== 'boolean') return;
      const key = `${row.sp.playerId}|${claim.beast}`;
      const previous = claimHistory.get(key);
      if (previous && previous.real !== claim.real) {
        push(row.sp.playerId, 'claim_shift', {
          beast: claim.beast, earlierReal: previous.real, latestReal: claim.real,
          earlierRound: previous.round, latestRound: row.roundIndex + 1
        }, 7.8, row.roundIndex + 1);
      }
      claimHistory.set(key, { real: claim.real, round: row.roundIndex + 1 });
    }));

    // 4. A public role claim changes between rounds; ask for the concrete ability/timing evidence.
    const roleHistory = new Map();
    visible.forEach(row => {
      const role = row.data.selfRole;
      if (!role || role === '平民') return;
      const previous = roleHistory.get(row.sp.playerId);
      if (previous && previous.role !== role) {
        push(row.sp.playerId, 'role_shift', {
          earlierRole: previous.role, latestRole: role,
          earlierRound: previous.round, latestRound: row.roundIndex + 1
        }, 8.1, row.roundIndex + 1);
      }
      roleHistory.set(row.sp.playerId, { role, round: row.roundIndex + 1 });
    });

    // 5. Public call vs actual ballot: a split can be legitimate, so the question is neutral.
    Object.values(A.prof || {}).forEach(profile => {
      (profile && profile.voteDissonance || []).forEach(item => {
        if (!item || !item.calledBeasts || !item.calledBeasts.length || !item.investedBeast || Number(item.round) > ctx.t) return;
        push(profile.player && profile.player.id, 'vote_dissonance', {
          round: item.round, calledBeasts: item.calledBeasts.slice(), investedBeast: item.investedBeast,
          investedChips: item.investedChips, callVotes: item.callVotes
        }, 8.2, item.round);
      });
    });

    // 6. Retrospective public fake-vote trail. The prompt explicitly says the result was revealed after voting.
    (A.fakeVoters || []).forEach(profile => {
      const targetId = profile && profile.player && profile.player.id;
      if (!targetId) return;
      const history = Mind.pubFakeVotes(room, targetId, ctx.t) || [];
      const latest = history[history.length - 1];
      if (!latest) return;
      push(targetId, 'fake_vote', {
        votes: Number(profile.pubFake || 0), round: latest.round, beast: latest.beast
      }, 7.0, latest.round);
    });

    // 7. Reciprocal Lao/Yao public claims may be a coordinated role-swap frame.
    // It is a question trigger only: do not infer that either claimant is evil from the pair alone.
    (A.roleSwapPairs || []).forEach(pair => {
      if (!pair || !pair.first || !pair.second) return;
      [pair.first, pair.second].forEach((claim, index) => {
        const other = index === 0 ? pair.second : pair.first;
        const profile = A.prof && A.prof[claim.playerId];
        const evidence = {
          round: pair.round,
          ownRole: claim.role,
          otherRole: other.role,
          otherTag: U.tag(U.byId(room, other.playerId)),
          pattern: pair.pattern,
          note: pair.note
        };
        push(claim.playerId, 'role_swap', evidence,
          9.8 + Math.min(1.0, Number(profile && profile.evil || 0) / 100), pair.round);
      });
    });

    // 8. Independent public claims about a role candidate: ask the speaker who made the claim to show evidence.
    const roleHypotheses = S.collectPublicRoleHypotheses(room, bot.id, ctx.t);
    roleHypotheses.filter(item => (item.sources || []).length >= 2).forEach(item => {
      const sourceId = item.sourceSpeakerId || (item.sources || []).slice(-1)[0];
      const candidate = U.byId(room, item.candidateId);
      if (!sourceId || !candidate) return;
      push(sourceId, 'role_hypothesis', {
        candidateId: candidate.id, candidateName: U.tag(candidate), role: item.role,
        sourceCount: (item.sources || []).length, round: item.sourceRound
      }, 6.6, item.sourceRound);
    });

    if (!candidates.length) return null;
    const genes = ctx.genes || {};
    const triggerChance = U.clamp(0.48 + 0.45 * (Number(genes.assertiveness) || 0.5), 0.48, 0.93);
    if (rnd() >= triggerChance) return null;

    // Prefer a category not yet used this round, then randomize among similarly strong evidence
    // so every bot does not mechanically repeat the single highest-scoring clue.
    const freshCategory = candidates.filter(item => !usedKinds.has(item.kind));
    const pool = (freshCategory.length ? freshCategory : candidates)
      .sort((a, b) => (b.score - a.score) || String(a.targetId).localeCompare(String(b.targetId)));
    const ceiling = pool[0].score - 1.6;
    const shortlist = pool.filter(item => item.score >= ceiling).slice(0, 5);
    const selected = shortlist[Math.floor(rnd() * shortlist.length)];
    return selected ? { ...selected } : null;
  }

  S.selectInteractionChallenge = selectInteractionChallenge;

  S.plan = function (bot, room) {
    const A = Mind.analyze(bot, room), { ctx } = A;
    const { genes, rd, myIns, names, t } = ctx;
    const why = [];
    const ranked = [...A.post].sort((a, b) => (b.pReal - a.pReal) || (zIdx(a.name) - zIdx(b.name)));
    const oldCommittedRole = committedFalseRoleBluff(room, bot, t);
    const swapNow = !ctx.isGood ? currentAmbushSwap(room) : null;
    const isYaoOrLao = ['藥不然', '老朝奉'].includes(bot.role);
    const desiredSwapRole = bot.role === '藥不然' ? '老朝奉' : bot.role === '老朝奉' ? '藥不然' : null;
    let openingRoleBluff = oldCommittedRole;
    // 舊版固定第三位栽贓／角色互換故事全面退役，不讓任何角色從舊存檔續演。
    if (oldCommittedRole && oldCommittedRole.origin === 'ambush-role-swap') {
      openingRoleBluff = null;
      persistOwnLog(ctx, { roleBluffAbandonedReason: 'legacy-fixed-ambush-role-swap-retired' });
    }
    // 相容舊存檔：真方震無法提供雙獸首查驗，不延續不相容許願假跳。
    if (bot.role === '方震' && openingRoleBluff && openingRoleBluff.role === '許願') openingRoleBluff = null;
    let roleSwapContext = null;
    if (swapNow && isYaoOrLao) {
      if (!openingRoleBluff) {
        openingRoleBluff = {
          role: desiredSwapRole, kind: 'false_claim', persist: true, commitment: 'ambush-role-swap', origin: 'ambush-role-swap',
          committedRound: t + 1, swapContext: swapNow
        };
      } else if (openingRoleBluff.role === desiredSwapRole) {
        // Re-label a compatible previous commitment as part of the coordinated swap, without changing its identity.
        openingRoleBluff = { ...openingRoleBluff, persist: true, commitment: 'ambush-role-swap', origin: 'ambush-role-swap', swapContext: swapNow };
      }
      roleSwapContext = openingRoleBluff && openingRoleBluff.role === desiredSwapRole ? swapNow : null;
    }
    const plan = { mode: 'truth', beast: ranked[0].name, avoid: [], claims: [], suspectId: null, softShadeId: null, fakeFangClaim: null,
      roleBluff: openingRoleBluff, roleSwapTrap: roleSwapContext, ambushFrame: null, ambushFrameHypothesis: null,
      tacticalLine: '', tactics: null, padBeast: null, partnerBeast: null, why };
    const log = ctx.log;
    if (log.blind !== true && (log.blindTiming != null || log.blindSourceRound != null)) {
      persistOwnLog(ctx, { blindTiming: null, blindSourceRound: null });
    }
    const explicitRoleSwapFrame = false;
    if (ctx.isGood && A.laoTiming) {
      const topTiming = (A.laoTiming.candidates || []).slice(0, 3).map(candidate => {
        const player = U.byId(room, candidate.playerId);
        return { playerId: candidate.playerId, name: player ? U.tag(player) : candidate.playerId,
          passIndex: candidate.passIndex, speechIndex: candidate.speechIndex, probability: U.round3(candidate.probability) };
      });
      plan.laoTimingAudit = {
        noSkillPossible: Number(A.laoTiming.noSkillProbability) >= 0.12,
        noSkillProbability: U.round3(Number(A.laoTiming.noSkillProbability) || 0),
        activationProbability: U.round3(Number(A.laoTiming.activationProbability) || 0),
        topCandidates: topTiming,
        laterPassCandidates: (A.laoTiming.candidates || []).filter(candidate =>
          candidate.passIndex > ctx.myPos && candidate.probability >= 0.12
        ).slice(0, 3).map(candidate => {
          const player = U.byId(room, candidate.playerId);
          return { playerId: candidate.playerId, name: player ? U.tag(player) : candidate.playerId,
            passIndex: candidate.passIndex, probability: U.round3(candidate.probability) };
        }),
        rule: 'skill timing uses passOrder; speechOrder is discussion order only'
      };
      plan.consensusAudit = (A.consensusAlerts || []).slice(0, 2).map(group => ({
        beast: group.beast, real: group.real, speakerCount: group.speakerCount,
        selfReportedDirect: group.selfReportedDirect, inference: group.inference,
        echo: group.echo, unattributed: group.unattributed, limitedView: group.limitedView
      }));
    }
    plan.publicRolePressure = publicRolePressure(room, rd, bot);
    // 低頻角色討論：同時讀取公開自稱與對他人的明確角色假設，不讀取其他人的私有推理。
    if (bot.isBot && t >= 1 && t <= 2 && GD.DialogueBank && !plan.publicRolePressure) {
      const discussionEvents = (room.rounds || []).flatMap(historyRound => Object.values(historyRound.mind || {})
        .map(record => record && record.roleDiscussionEvent).filter(event => event && event.gameEvent));
      const initiatingEvent = discussionEvents.find(event => event.phase !== 'response') || null;
      const hasResponse = discussionEvents.some(event => event.phase === 'response');
      const publicRoleHypotheses = S.collectPublicRoleHypotheses(room, bot.id, t);
      const publicRoleSourceIds = new Set(publicRoleHypotheses.flatMap(item => item.sources));
      const stableRolePlayerKey = id => {
        const player = U.byId(room, id);
        return player ? String(player.botId || player.name || `seat:${player.seatIndex}`) : String(id || '');
      };
      const eventHash = GD.DialogueBank.hash(`${room.roomId || ''}:${t}:role-discussion:${bot.botId || bot.id}`);
      let roleDiscussionEligible = false;
      let roleDiscussionRoll = eventHash % 100;
      if (!initiatingEvent && publicRoleHypotheses.length >= 2 && publicRoleSourceIds.size >= 2 && eventHash % 100 < 30) {
        roleDiscussionEligible = true;
        const candidates = publicRoleHypotheses.filter(candidate => !(bot.role === '方震' && candidate.candidateId === bot.id))
          .sort((a, b) => `${stableRolePlayerKey(a.candidateId)}:${a.role}`.localeCompare(`${stableRolePlayerKey(b.candidateId)}:${b.role}`));
        const candidate = candidates.length ? candidates[eventHash % candidates.length] : null;
        if (candidate) plan.roleDiscussionEvent = {
          gameEvent: true, phase: 'initiate', eventId: `${t}:${stableRolePlayerKey(candidate.candidateId)}:${candidate.role}`,
          act: ['question', 'counterpoint', 'probe'][Math.floor(eventHash / 7) % 3],
          candidateId: candidate.candidateId, candidateRole: candidate.role,
          sourceSpeakerId: candidate.sourceSpeakerId, sourceRound: candidate.sourceRound,
          sourceText: candidate.sourceText, sourceCount: candidate.sources.length
        };
      } else if (!initiatingEvent && publicRoleHypotheses.length >= 2 && publicRoleSourceIds.size >= 2) {
        roleDiscussionEligible = true;
      } else if (initiatingEvent && !hasResponse && String(initiatingEvent.candidateId) !== String(bot.id)) {
        const responseHash = GD.DialogueBank.hash(`${room.roomId || ''}:${initiatingEvent.eventId}:response:${bot.botId || bot.id}`);
        roleDiscussionRoll = responseHash % 100;
        roleDiscussionEligible = true;
        if (responseHash % 100 < 38) plan.roleDiscussionEvent = {
          ...initiatingEvent, gameEvent: true, phase: 'response',
          act: responseHash % 2 ? 'counterpoint' : 'probe', responseTo: initiatingEvent.sourceSpeakerId
        };
      }
      plan.roleDiscussionAudit = {
        eligible: roleDiscussionEligible, phase: initiatingEvent ? 'response' : 'initiate',
        clueCount: publicRoleHypotheses.length, independentSourceCount: publicRoleSourceIds.size,
        roll: roleDiscussionRoll, triggered: !!plan.roleDiscussionEvent
      };
    }
    if (ctx.partner && plan.publicRolePressure && plan.publicRolePressure.speakerId === ctx.partner.id) {
      plan.publicRolePressure = null;
    }
    if (!ctx.isGood && plan.publicRolePressure &&
        !(ctx.partner && ctx.partner.id === plan.publicRolePressure.speakerId)) {
      plan.counterAccuseId = plan.publicRolePressure.speakerId;
      why.push(`前手公開把我指為【${plan.publicRolePressure.role}】；我需要正面反駁並要求對方提出可核對的技能時點，必要時以其他公開票型反制，而不是只跟著獸首話題走`);
    }
    const hideBlind = ctx.isGood && !!log.blind && (bot.role === '方震' || shouldHideBlind(bot, genes));
    if (ctx.isGood && log.blind && !hideBlind && ctx.myPos === 2 && rd.passOrder.length >= 3) {
      plan.ambushFrameHypothesis = { firstId: rd.passOrder[0], secondId: rd.passOrder[1], victimId: bot.id };
    }
    if (!ctx.isGood && bot.role === '藥不然' && false && log.ambushFrameTactic && log.ambushTargetId) {
      plan.ambushFrame = {
        firstId: rd.passOrder[0] || null, secondId: bot.id,
        victimId: log.ambushTargetId, targetId: log.ambushTargetId,
        round: log.ambushFrameRound || t + 1
      };
    }
    if (ctx.isGood) {
      let say = myIns.slice();
      if (bot.role === '許願' && say.length >= 2) {
        const reals = say.filter(i => GD.Mind.inspectionTruth(i) === true).sort((a, b) => zIdx(a.beastName) - zIdx(b.beastName));
        const keep = reals[0] || say[0];
        say = [keep];
        why.push('身為許願，雙查驗只報 1 尊以藏住身分');
      }
      plan.claims = say.map(i => ({ beast: i.beastName, real: GD.Mind.inspectionTruth(i) }));
      plan.avoid = myIns.filter(i => GD.Mind.inspectionTruth(i) === false).map(i => i.beastName);
      const cand = ranked.filter(b => !plan.avoid.includes(b.name));
      plan.beast = (cand[0] || ranked[0]).name;

      if (bot.role === '方震') {
        const verifiedGoodIds = new Set();
        room.rounds.forEach(r => {
          const l = r.turnLogs[bot.id];
          if (l && l.fangTargetId && l.fangCamp === 'good') verifiedGoodIds.add(l.fangTargetId);
        });
        // 方震的陣營查驗只約束「是不是壞人」，不會替對方的每句獸首發言背書。
        // 僅把有自稱親查、非矛盾、非受限視野的公開說法當作有限參考；且不能推翻自己的後驗排序。
        const evidence = (A.claimEvidence && A.claimEvidence.current) || [];
        const rankedTop = [...A.post].sort((a, b) => b.pReal - a.pReal || zIdx(a.name) - zIdx(b.name))[0];
        const trustedClaims = evidence.filter(entry => verifiedGoodIds.has(entry.playerId) &&
          entry.type === 'self-reported-direct' && entry.selfReportedDirect && entry.weight >= 0.6 &&
          entry.real === true && !plan.avoid.includes(entry.beast) &&
          !evidence.some(other => other.playerId === entry.playerId && other.beast === entry.beast && other.type === 'self-contradictory'));
        trustedClaims.sort((a, b) => {
          const pa = A.post.find(x => x.name === a.beast)?.pReal ?? 0.5;
          const pb = A.post.find(x => x.name === b.beast)?.pReal ?? 0.5;
          const ia = A.prof[a.playerId]?.infoSkill ?? 50;
          const ib = A.prof[b.playerId]?.infoSkill ?? 50;
          return (pb + ib / 100 * 0.02) - (pa + ia / 100 * 0.02);
        });
        const trusted = trustedClaims[0];
        if (trusted && rankedTop && trusted.beast !== plan.beast) {
          const trustedPosterior = A.post.find(x => x.name === trusted.beast)?.pReal ?? 0.5;
          const currentPosterior = A.post.find(x => x.name === plan.beast)?.pReal ?? 0.5;
          if (trustedPosterior >= 0.55 && currentPosterior - trustedPosterior <= 0.15) {
            plan.beast = trusted.beast;
            why.push(`我確認${U.tag(U.byId(room, trusted.playerId))}屬於好人陣營；他的這筆獸首主張另有自稱親查來源，且與我自己的後驗差距不大，因此只作為同分附近的參考，而非直接當成系統驗證`);
          } else {
            why.push(`我確認${U.tag(U.byId(room, trusted.playerId))}是好人，但陣營可信不代表獸首判斷必然正確；這次先保留自己的後驗排序`);
          }
        }
      }

      /* ★ 定案 6：收斂無證據的開局假跳機率，移除原本 0.45 的固定隨機假跳分支 */
      const canFakeFang = (bot.role === '黃煙煙' || bot.role === '木戶加奈' || bot.role === '姬雲浮');
      const suspectedFangId = canFakeFang ? detectSuspectedFangOnBoard(room, bot.id) : null;
      const pressuredAllyForBluff = ctx.isGood ? findCrediblePressuredAlly(room, rd, bot, A) : null;
      const alreadyFakeJumped = (rd.speeches || []).some(sp => /我驗了|查驗.*是好人|查驗.*是壞人|看不到獸首/.test(sp.text || ''));
      const wantToProtectFang = canFakeFang && !alreadyFakeJumped && !!pressuredAllyForBluff &&
        rnd() < U.clamp(0.18 + 0.28 * genes.assertiveness + 0.10 * genes.camouflage, 0.12, 0.55);

      if (wantToProtectFang) {
        const pickEvil = A.topSuspect && A.topSuspect.evil >= 30;
        const targetP = pressuredAllyForBluff.player;
        if (targetP) {
          plan.fakeFangClaim = { targetId: targetP.id, isGoodCamp: !pickEvil };
          plan.claims = [];
          why.push(`我判斷${U.tag(targetP)}有可信的好人訊號，卻正在承受公開施壓；我假扮方震並提出單一陣營查驗，迫使討論回到技能時序與證據，而不是讓票勢直接壓垮他。`);
        }
      }

      const isConfusedOrBlockedGood = !log.blind && myIns.length === 0 && bot.role !== '方震' && !plan.fakeFangClaim;
      const coverBluff = isConfusedOrBlockedGood && rnd() < 0.65;
      const bluff = (bot.role !== '方震' && (hideBlind || coverBluff)) && !plan.fakeFangClaim && !plan.revealFang;

      if (bluff) {
        plan.claims = [{ beast: plan.beast, real: true }];
        plan.bluff = true;
        plan.hideBlind = hideBlind;
        why.push(hideBlind ? `我這輪遭偷襲、什麼都看不到，但不輕易說出被偷襲${bot.role === '許願' || bot.role === '方震' ? `（我是${bot.role}，說出口等於告訴壞人這刀砍中了要害）` : '（說了只會讓壞人確認偷襲有效）'}；改把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出`
          : coverBluff ? `我這輪查驗顯示無法辨別真偽，但為了不暴露弱點並替方震分擔保護色，我順著後驗最穩的【${plan.beast}】報真品護航`
          : `我是方震，看不到獸首。為了不被藥不然靠「驗不到」認出，我把後驗最像真品的【${plan.beast}】當成自己的查驗結果報出`);
      } else if (log.blind && !plan.fakeFangClaim && bot.role !== '方震' && !hideBlind) {
        plan.revealBlind = true;
        why.push('我這輪遭偷襲，決定公開說出來，好讓大家知道偷襲者排在我前面的行動者之中');
      }

      if (bot.role === '方震' && !plan.fakeFangClaim && !plan.revealFang) {
        plan.claims = [];
        plan.hideBlind = !!log.blind;
      }
      if (!bluff && !plan.fakeFangClaim && bot.role !== '方震') {
        why.push(myIns.length ? `我親眼看到 ${myIns.map(i => `【${i.beastName}】${GD.Mind.inspectionTruth(i) ? '真' : '假'}`).join('、')}，結合前手宣稱，後驗最像真品的是【${plan.beast}】(${Math.round(A.post.find(b => b.name === plan.beast).pReal * 100)}%)`
          : `這輪我${log.blind ? '遭偷襲' : '無法辨別真偽'}，只能依前手宣稱的可信度，後驗最像真品的是【${plan.beast}】`);
      }

      if (A.reEvalNote) {
        why.push(A.reEvalNote);
      }
    } else {
      /* ★ 定案 1 & 2：pLie 僅由 deception 控制；雙重宣稱以 camouflage = 0.5 為基準中心進行調節 */
      const knownReal = myIns.filter(i => GD.Mind.inspectionTruth(i) === true).map(i => i.beastName);
      const knownFake = myIns.filter(i => GD.Mind.inspectionTruth(i) === false).map(i => i.beastName);
      const inferredBuddy = inferEvilTeammate(bot, A, room);
      // 只有老朝奉／藥不然知道彼此身分，才可使用對方的私密 mind；猜測的第三名同伴只能依公開發言協同。
      const partnerMind = ctx.partner && rd.mind[ctx.partner.id];
      const inferredBuddySpeech = inferredBuddy
        ? (rd.speeches || []).slice().reverse().find(sp => sp.playerId === inferredBuddy.player.id && (sp.p || sp.text))
        : null;
      const publicBuddyClaim = inferredBuddySpeech
        ? ((inferredBuddySpeech.p.claims || []).find(c => c.real === true && c.beast && !knownReal.includes(c.beast)) || null)
        : null;
      const tacticalState = evilStrategicState(room, bot);
      const evilStyle = chooseEvilStyle(bot, tacticalState, genes);
      plan.evilPosture = tacticalState.posture;
      plan.evilStyle = evilStyle;
      plan.estimatedGoodScore = tacticalState.estimatedGoodScore;
      plan.inferredBuddyId = inferredBuddy ? inferredBuddy.player.id : null;

      const pLieBase = U.clamp(
        0.125 + 0.6 * genes.deception + (t === 2 ? 0.2 : 0),
        0.12,
        0.95
      );
      const pLie = U.clamp(pLieBase + (evilStyle === 'conceal' ? -0.14 : 0.12) +
        (tacticalState.posture === 'desperate' ? 0.10 : tacticalState.posture === 'conceal' ? -0.06 : 0), 0.08, 0.95);
      const followChance = tacticalState.posture === 'desperate' ? 0.90 :
        tacticalState.posture === 'conceal' ? (evilStyle === 'conceal' ? 0.52 : 0.66) : 0.75;

      if (partnerMind && ['lie', 'follow'].includes(partnerMind.mode) && !knownReal.includes(partnerMind.beast) && rnd() < followChance) {
        plan.mode = 'follow';
        plan.beast = partnerMind.beast;
        plan.partnerBeast = partnerMind.beast;
        plan.claims = [{ beast: plan.beast, real: true }];
        why.push(`同伴已帶風向推【${plan.beast}】，我順著他附和以加固假線`);
      } else if (publicBuddyClaim && rnd() < followChance) {
        plan.mode = 'follow';
        plan.beast = publicBuddyClaim.beast;
        plan.partnerBeast = publicBuddyClaim.beast;
        plan.claims = [{ beast: plan.beast, real: true }];
        why.push(`我根據${U.tag(inferredBuddy.player)}已公開的【${plan.beast}】真品宣稱協同，讓同伴能從公開票型與共同推線辨認我的站位`);
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

    /* ---- 多來源公開採人：言行矛盾、票型、角色宣稱與事後結果分開提問 ---- */
    const challenge = selectInteractionChallenge(bot, room, A);
    if (challenge) {
      plan.askId = challenge.targetId;
      plan.askKind = challenge.kind;
      plan.askEvidence = challenge.evidence;
      plan.askRound = challenge.round;
      const target = U.byId(room, challenge.targetId);
      const sourceLabel = ({
        inspection_conflict: '本人的查驗畫面與公開主張不一致',
        speech_contradiction: '同一段發言前後矛盾',
        claim_shift: '跨輪公開真偽判斷改變',
        role_shift: '跨輪角色自稱改變',
        vote_dissonance: '公開號召與實際票單有落差',
        fake_vote: '事後公開結果與歷史票單的對照',
        role_hypothesis: '多人提出同一角色猜測，仍需核對依據'
      })[challenge.kind] || '公開紀錄有待釐清';
      why.push(`${target ? U.tag(target) : challenge.targetId}有一項值得核對的公開紀錄：${sourceLabel}。先針對具體事實提問，不把單一矛盾或分票直接當成定罪；也不要重複本輪已有人問過的對象`);
    }

    /* ★ 定案 4：被點名要說明為什麼把票投在贗品上（保留抗壓，加入第三輪 cantExplain 退讓例外） */
    if (!ctx.isGood && A.askedMe && A.myFake.length) {
      plan.explain = { callerName: A.askedMe.callerName, votes: A.myFake };
      // 已承諾持續假身分的壞人不會因一般票型質問而自行認壞；要一路演到第三輪才有長線博弈價值。
      const canConfess = !ctx.isGood && !plan.roleBluff?.persist && (bot.role === '藥不然' || bot.role === '鄭國渠');
      const cantExplain = A.myFake.some(f => { const m = room.rounds[f.round - 1].mind[bot.id]; return m && m.mode === 'lie'; });
      let pConfess = canConfess
        ? U.clamp((cantExplain ? 0.35 : 0.08) + 0.4 * (1 - genes.camouflage), 0.05, 0.8)
        : 0;
      if (canConfess && cantExplain && t === 2) {
        pConfess = Math.max(pConfess, 0.45);
      }
      if (canConfess && plan.evilPosture === 'conceal') pConfess *= 0.55;
      if (rnd() < pConfess) {
        const target = chooseCounterfeitTarget(myIns, ranked, plan.padBeast);
        if (target) {
          plan.mode = 'confess';
          plan.confess = true;
          plan.beast = target;
          plan.claims = [{ beast: plan.beast, real: false }];
          plan.avoid = [];
          plan.partnerBeast = null;
          plan.padBeast = null;
          plan.withholdInfo = false;
          plan.withheldClaims = [];
          why.unshift(`${U.tag(U.byId(room, A.askedMe.callerId))}點名要我說明投贗品的理由。這次選擇認壞，但只公開把【${plan.beast}】判作贗品並把票推向同一目標，不攤開其他私密查驗，也不透露同伴。`);
        } else {
          why.unshift('目前沒有可安全公開判為贗品的目標，因此不執行認壞表演，也不把已確認真品硬說成贗品。');
        }
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
        const othersAlreadyCalled = (rd.speeches || []).some(sp => sp.playerId !== bot.id && publicSpeechData(sp, room, rd).callSuspectId === tgtId);
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
      const hc = A.publicCall;
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

      if (ctx.isGood && hc && Number(A.prof[hc.targetId]?.pEvil || 0) > 0.60 && (A.prof[hc.targetId]?.ally || 0) < 85 && rnd() < 0.3 + 0.65 * genes.conformity) {
        plan.suspectId = hc.targetId; plan.followHuman = hc;
        why.push(`公開玩家【${hc.callerName}】號召集火，其發言可信度夠，我附議`);
      } else if (ctx.isGood && bot.role !== '方震' && A.topSuspect && canAccuseNow && rnd() < 0.35 + 0.6 * genes.assertiveness) {
        plan.suspectId = A.topSuspect.player.id;
        why.push(`${U.tag(A.topSuspect.player)}嫌疑最高且明顯領先（${A.topSuspect.reasons[0] || '票型與發言矛盾'}），先為鑑人鋪梗`);
      } else if (!ctx.isGood && t === 2 && rnd() < (plan.evilPosture === 'desperate' ? 0.82 : plan.evilPosture === 'conceal' ? 0.18 : 0.3 + 0.5 * genes.deception)) {
        const inferredBuddy = inferEvilTeammate(bot, A, room);
        const protectedIds = new Set([ctx.partner && ctx.partner.id, inferredBuddy && inferredBuddy.player.id].filter(Boolean));
        const scapegoat = Object.values(A.prof).filter(r => !protectedIds.has(r.player.id) && !r.knownEvil)
          .sort((a, b) => (b.ally - b.evil) - (a.ally - a.evil))[0];
        if (scapegoat) {
          plan.suspectId = scapegoat.player.id;
          why.push(plan.evilPosture === 'desperate'
            ? `局勢對我方不利，第三輪必須主動提出一條可討論的嫌疑線，把注意力引向${U.tag(scapegoat.player)}，爭取鑑人翻盤`
            : `目前優先保住身分，我只用較低強度的公開質疑牽制${U.tag(scapegoat.player)}，避免過早暴露同伴配合`);
        }
      }
    }

    // If a bad player has been directly role-accused and no better public suspicion target exists,
    // make the accuser the counter-pressure target. This is a public counterclaim, not hidden-role leakage.
    if (!ctx.isGood && plan.publicRolePressure && !plan.suspectId && plan.counterAccuseId) {
      const accuser = U.byId(room, plan.counterAccuseId);
      if (accuser && !(ctx.partner && ctx.partner.id === accuser.id)) {
        plan.suspectId = accuser.id;
        plan.counterAccuseMode = 'direct-role-counter';
        why.push(`遭到公開角色指控後，若目前沒有更強的第三方公開疑點，就直接反問${U.tag(accuser)}並要求他交代角色判斷依據，避免單方面承受指控`);
      }
    }

    /* ---- 真身微跳：真實角色也會偶爾透露一點可驗證的角色線索 ---- */
    if (!plan.confess && !plan.fakeFangClaim) {
      const roleSignalCategory = {
        '許願': 'trueXuSignal', '方震': 'trueFangSignal', '姬雲浮': 'trueJiSignal',
        '黃煙煙': 'trueHuangSignal', '木戶加奈': 'trueKidoSignal', '老朝奉': 'trueLaoSignal',
        '藥不然': 'trueYaoSignal', '鄭國渠': 'trueZhengSignal'
      }[bot.role];
      const roleClaims = [];
      (room.rounds || []).slice(0, t + 1).forEach((historyRound, roundIndex) => {
        (historyRound.speeches || []).forEach(sp => {
          if (!sp || sp.playerId === bot.id) return;
          let mentionedRole = publicSpeechData(sp, room, rd).selfRole;
          if (!mentionedRole && GD.Claims && typeof GD.Claims.parse === 'function') {
            try { mentionedRole = GD.Claims.parse(String(sp.text || ''), room, historyRound).selfRole; } catch (_) {}
          }
          if (mentionedRole === bot.role) roleClaims.push({ speech: sp, roundIndex });
        });
      });
      const roleClaimed = roleClaims.length > 0;
      const directlyPressured = (rd.speeches || []).some(sp => {
        if (!sp || sp.playerId === bot.id) return false;
        const parsed = publicSpeechData(sp, room, rd);
        return parsed.callSuspectId === bot.id || (parsed.accuse || []).some(a => a && a.playerId === bot.id) ||
          (String(sp.text || '').includes(`【${bot.name}】`) && /假跳|冒充|身份不對|不是本人|角色不符/.test(String(sp.text || '')));
      });
      const signalledEarlier = (room.rounds || []).slice(0, t).some(historyRound =>
        !!(historyRound.mind && historyRound.mind[bot.id] && historyRound.mind[bot.id].trueRoleSignal));
      const latestFangEvidence = (() => {
        if (bot.role !== '方震') return null;
        for (let i = t; i >= 0; i--) {
          const priorLog = room.rounds[i] && room.rounds[i].turnLogs && room.rounds[i].turnLogs[bot.id];
          if (priorLog && priorLog.fangTargetId && ['good', 'evil'].includes(priorLog.fangCamp)) {
            return { targetId: priorLog.fangTargetId, camp: priorLog.fangCamp, round: i + 1 };
          }
        }
        return null;
      })();
      const signalEligible = !!roleSignalCategory && (
        bot.role !== '許願' || (!log.blind && myIns.length >= 2)
      ) && (bot.role !== '方震' || (!!latestFangEvidence && (roleClaimed || directlyPressured)));
      const abilityEvidence = (
        bot.role === '許願' && myIns.length >= 2 ||
        bot.role === '方震' && !!latestFangEvidence ||
        bot.role === '老朝奉' && (String(log.skillTag || '').includes('擾亂') || /擾亂/.test(String(log.ability || '')) ) ||
        bot.role === '藥不然' && !!(log.ambushTargetId || (log.ambushIds || []).length) ||
        bot.role === '鄭國渠' && (String(log.skillTag || '').includes('封') || /封鎖/.test(String(log.ability || '')))
      );
      // Keep a genuine role hint occasional: mostly triggered by an active role contest or pressure,
      // rather than volunteering a role-shaped tell every round.
      let trueSignalChance = ctx.isGood
        ? 0.035 + 0.06 * genes.assertiveness
        : 0.03 + 0.06 * genes.deception;
      if (t > 0) trueSignalChance += 0.015;
      if (t === 2) trueSignalChance += 0.025;
      if (roleClaimed) trueSignalChance += ctx.isGood ? 0.22 : 0.18;
      if (directlyPressured) trueSignalChance += 0.20;
      if (abilityEvidence && bot.role !== '方震') trueSignalChance += 0.05;
      trueSignalChance = U.clamp(trueSignalChance, 0.02, 0.62);
      // 許願應靠判斷與言行一致性建立可信度，不應反覆暗示自己握有額外查驗。
      if (bot.role === '許願') trueSignalChance = U.clamp(trueSignalChance * 0.45, 0.01, 0.26);
      if (bot.role === '方震' && !roleClaimed && !directlyPressured) trueSignalChance = 0;
      if (signalledEarlier && !roleClaimed && !directlyPressured) trueSignalChance = 0;
      // Derive the signal roll from a stable context hash instead of consuming Math.random().
      // This keeps existing vote/ability random streams unchanged when the optional signal is added.
      const signalSeedText = `${bot.botId || bot.id}:${room.roomId || ''}:${t}:${ctx.myPos}:true-role:${bot.role}:${roleClaimed ? 'contested' : 'quiet'}:${directlyPressured ? 'pressured' : 'unpressured'}:${signalledEarlier ? 'prior' : 'fresh'}`;
      const signalRoll = GD.DialogueBank ? (GD.DialogueBank.hash(signalSeedText) % 10000) / 10000 : 1;
      if (signalEligible && !plan.roleBluff && !plan.trueRoleSignal && signalRoll < trueSignalChance && GD.DialogueBank) {
        const signalSeed = GD.DialogueBank.hash(signalSeedText);
        const targetPlayer = latestFangEvidence ? U.byId(room, latestFangEvidence.targetId) : null;
        const campText = latestFangEvidence ? (latestFangEvidence.camp === 'evil' ? '壞人' : '好人') : '';
        const line = GD.DialogueBank.pick(roleSignalCategory, signalSeed, {
          target: targetPlayer ? U.tag(targetPlayer) : '這位玩家', camp: campText,
          beast: plan.beast, round: t + 1
        });
        plan.trueRoleSignal = {
          role: bot.role, kind: roleClaimed ? 'role_contest' : directlyPressured ? 'under_pressure' : 'soft_hint',
          category: roleSignalCategory, line, hasAbilityEvidence: !!abilityEvidence
        };
        why.push(`真身微跳：我是真正的【${bot.role}】，視角色被冒認、被質疑與可驗證線索，公開透露一點真實特徵但不直接自報職業`);
      }
    }

    /* ---- 方震終局揭露：多筆跨輪陣營查驗已可核對、且場上出現方震角色冒認時，停止不合能力的假跳 ---- */
    if (bot.role === '方震' && ctx.isGood && t === 2 && !plan.confess && !plan.fakeFangClaim) {
      const verifiedChecks = [];
      (room.rounds || []).slice(0, t + 1).forEach((historyRound, roundIndex) => {
        const check = historyRound && historyRound.turnLogs && historyRound.turnLogs[bot.id];
        if (!check || !check.fangTargetId || !['good', 'evil'].includes(check.fangCamp)) return;
        if (!verifiedChecks.some(entry => entry.targetId === check.fangTargetId)) {
          verifiedChecks.push({ targetId: check.fangTargetId, camp: check.fangCamp, round: roundIndex + 1 });
        }
      });
      const roleContest = (room.rounds || []).slice(0, t + 1).some(historyRound =>
        (historyRound && historyRound.speeches || []).some(sp => {
          if (!sp || sp.playerId === bot.id) return false;
          const parsed = publicSpeechData(sp, room, historyRound);
          const raw = String(sp.text || '');
          return parsed.selfRole === '方震' ||
            (parsed.accuse || []).some(acc => acc && acc.role === '方震') ||
            /(?:我是|自稱|可能是|懷疑|指認|冒充|假跳).{0,12}方震|方震.{0,12}(?:冒充|假跳|身分|身份)/.test(raw);
        })
      );
      if (verifiedChecks.length >= 2 && roleContest) {
        const evidenceLines = verifiedChecks.map(entry => {
          const target = U.byId(room, entry.targetId);
          return `第${entry.round}輪${target ? U.tag(target) : '一名玩家'}的陣營查驗為${entry.camp === 'good' ? '好人' : '壞人'}`;
        });
        const directChecks = verifiedChecks.map(entry => ({ ...entry }));
        plan.revealFang = true;
        plan.bluff = false;
        plan.claims = [];
        plan.roleBluff = null;
        plan.fakeFangClaim = null;
        plan.trueRoleSignal = {
          role: '方震', kind: 'decisive_reveal', reveal: true,
          category: 'trueFangSignal', hasAbilityEvidence: true,
          verifiedCampChecks: directChecks,
          line: `我是方震。我的能力紀錄可以逐輪核對：${evidenceLines.join('；')}。場上把其他人指成方震的說法不能取代這些實際查驗紀錄；我才是方震。` 
        };
        why.push(`終局揭露：我已累積 ${verifiedChecks.length} 筆可核對的方震陣營查驗，而且場上出現方震角色爭議；現在公開真身比繼續假跳許願更可信。我不會把獸首推論偽裝成親自查驗。`);
      }
    }

    /* ---- 動態角色偽裝：身分宣稱是戰術承諾，後續必須能被公開紀錄驗證 ---- */
    if (!plan.confess && !plan.fakeFangClaim) {
      const allowGoodCounterBluff = !!(ctx.isGood && plan.publicRolePressure);
      const rolePool = buildRoleBluffPool(bot, ctx, allowGoodCounterBluff);
      const teamMirrorPreview = !ctx.isGood ? teamRoleBluffAdjustment(room, bot, ctx.partner, t) : null;
      if (teamMirrorPreview && teamMirrorPreview.antiMirror) {
        for (let i = rolePool.length - 1; i >= 0; i--) {
          if (rolePool[i] === teamMirrorPreview.partnerClaim) rolePool.splice(i, 1);
        }
        plan.roleBluffAbandonedReason = 'partner-publicly-claims-actor-true-role-mirror-blocked';
        if (plan.roleBluff && plan.roleBluff.role === bot.role) plan.roleBluff = null;
      }
      const feasibilityRows = rolePool.map(role => ({ role, feasibility: roleBluffFeasibility(role, bot, ctx, A) }));
      const feasibleRolePool = feasibilityRows.filter(item => item.feasibility >= 0.45).map(item => item.role);
      rolePool.splice(0, rolePool.length, ...feasibleRolePool);
      const pressuredAllyForRoleBluff = ctx.isGood ? findCrediblePressuredAlly(room, rd, bot, A) : null;
      // 好人假跳只用來保護「有足夠可信度、且正遭公開施壓」的盟友；沒有保護對象就不假跳。
      // 壞人仍依欺騙基因與局勢姿態決定是否用假身份爭取敘事主導權。
      const stableGoodConsensus = (A.consensusAlerts || []).some(group =>
        Number(group.speakerCount || 0) >= 3 && (Number(group.selfReportedDirect || 0) + Number(group.inference || 0)) >= 2);
      const laoNoConsensusBoost = !ctx.isGood && bot.role === '老朝奉' && !stableGoodConsensus ? 0.20 : 0;
      const baseRoleBluffChance = ctx.isGood
        ? ((pressuredAllyForRoleBluff || allowGoodCounterBluff)
            ? U.clamp(0.035 + 0.075 * genes.deception + (t === 2 ? 0.02 : 0) + 0.045 * genes.assertiveness + (allowGoodCounterBluff ? 0.035 : 0), 0.035, 0.19)
            : 0)
        : U.clamp(0.045 + 0.16 * genes.deception + (plan.evilPosture === 'desperate' ? 0.10 : plan.evilPosture === 'conceal' ? -0.025 : 0) +
            (t > 0 ? 0.035 : 0) + (plan.publicRolePressure ? 0.14 : 0) + (explicitRoleSwapFrame ? 0.18 : 0) +
            laoNoConsensusBoost * 0.35, 0.025, 0.48);
      const teamRolePosture = ctx.isGood ? { multiplier: 1, active: false, reason: 'good-side' }
        : teamRoleBluffAdjustment(room, bot, ctx.partner, t);
      const roleBluffChance = !ctx.isGood && teamRolePosture.antiMirror
        ? 0
        : !ctx.isGood && teamRolePosture.active && !explicitRoleSwapFrame
          ? U.clamp(baseRoleBluffChance * teamRolePosture.multiplier, 0, 0.78)
          : baseRoleBluffChance;
      if (!ctx.isGood) {
        plan.teamDeceptionPosture = {
          partnerPublicFalseRole: !!teamRolePosture.active,
          partnerClaim: teamRolePosture.partnerClaim || null,
          multiplier: teamRolePosture.multiplier,
          explicitRoleSwapFrame,
          baseChance: Number(baseRoleBluffChance.toFixed(3)),
          adjustedChance: Number(roleBluffChance.toFixed(3)),
          reason: teamRolePosture.reason
        };
      }
      // Always consume the original role-bluff RNG draw when this stage is eligible.
      // A true-role micro-signal suppresses the false claim, but must not shift all later RNG decisions.
      const roleBluffRoll = rolePool.length ? rnd() : 1;
      if (rolePool.length && !plan.roleBluff && !plan.trueRoleSignal && roleBluffRoll < roleBluffChance) {
        // 好人也可冒險假扮壞角色；「平民」只是公開說法，不是新增職業。
        // 低機率的假認壞只在非真正鄭國渠的好人假跳鄭國渠時啟用，作為高風險心理戰。
        const picks = rolePool;
        plan.roleBluff = {
          role: chooseRoleBluffRole(picks, room, bot, t, ctx.partner),
          kind: 'false_claim',
          ...(ctx.isGood && pressuredAllyForRoleBluff ? {
            motive: 'protect_pressured_ally',
            protectedAllyId: pressuredAllyForRoleBluff.playerId,
            pressureCount: pressuredAllyForRoleBluff.pressureCount
          } : {})
        };
        if (!ctx.isGood && t < 2) {
          const postureCommitBonus = plan.evilPosture === 'desperate' ? 0.12 : plan.evilPosture === 'conceal' ? -0.08 : 0;
          const persistChance = U.clamp(0.34 + 0.38 * genes.deception + postureCommitBonus, 0.20, 0.82);
          const persistKey = `${bot.botId || bot.id}:${room.roomId || ''}:${t}:${ctx.myPos}:role-commit:${plan.roleBluff.role}`;
          if (stableRoll(persistKey) < persistChance) {
            plan.roleBluff.persist = true;
            plan.roleBluff.commitment = 'hard-denial';
            plan.roleBluff.committedRound = t + 1;
          }
        }
        if (ctx.isGood && plan.roleBluff.role === '鄭國渠') {
          const fakeConfessChance = U.clamp(0.14 + 0.24 * genes.assertiveness + (t === 2 ? 0.30 : 0), 0.10, 0.68);
          plan.roleBluff.fakeConfess = rnd() < fakeConfessChance;
        }
        if (plan.roleBluff.role === '方震') {
          const targetP = ctx.isGood
            ? (pressuredAllyForRoleBluff && pressuredAllyForRoleBluff.player ? pressuredAllyForRoleBluff.player : (A.topAlly && A.topAlly.player && A.topAlly.player.id !== bot.id ? A.topAlly.player : pickDecision(room.players.filter(p => p.id !== bot.id))))
            : (plan.suspectId ? U.byId(room, plan.suspectId) : A.topSuspect && A.topSuspect.player) || pickDecision(room.players.filter(p => p.id !== bot.id));
          if (targetP && targetP.id !== bot.id) {
            plan.roleBluff.targetId = targetP.id;
            plan.roleBluff.isGoodCamp = !!ctx.isGood;
          } else {
            plan.roleBluff.role = picks.find(role => role !== '方震') || plan.roleBluff.role;
          }
        }
        why.push(plan.roleBluff.persist
          ? `我決定公開假稱自己是【${plan.roleBluff.role}】，並採取持續承諾路線：後續若沒有確切矛盾，不因壓力自行改口，直到終局都接受公開紀錄反查`
          : `我決定公開假稱自己是【${plan.roleBluff.role}】，用角色承諾改變對手對查驗與終局鑑人的判斷；後續要承擔被對跳與按時序反查的風險`);
      }
    }

    // 身分偽裝採漸進式表現：沒有被點名／對跳時，不急著在第一句自報角色。
    // 已公開承諾沿用原版本，但下一輪不重複自我介紹；被追問或執行協同換位時才明確對跳。
    if (plan.roleBluff && plan.roleBluff.role) {
      const priorPublicClaims = latestPublicRoleClaims(room, t, null);
      const ownPriorClaim = priorPublicClaims.get(bot.id) || null;
      const roleCanBePubliclySupported = (() => {
        const logs = (room.rounds || []).slice(0, t + 1).map(historyRound => historyRound && historyRound.turnLogs && historyRound.turnLogs[bot.id]).filter(Boolean);
        if (plan.roleBluff.role === '方震') return logs.some(log => !!(log.fangTargetId && ['good', 'evil'].includes(log.fangCamp)));
        if (plan.roleBluff.role === '許願') return !!(plan.roleBluff.abilityProfile && plan.roleBluff.abilityProfile.beastNames.length >= 2);
        if (plan.roleBluff.role === '黃煙煙' || plan.roleBluff.role === '木戶加奈') return !!plan.roleBluff.abilityProfile || logs.some(log => log.blind === false && log.inspect && log.inspect.some(item => item && item.displayedReal === null));
        if (plan.roleBluff.role === '鄭國渠') return logs.some(log => /封鎖|封住/.test(String(log.ability || '') + ' ' + String(log.skillTag || '')));
        if (plan.roleBluff.role === '藥不然') return logs.some(log => !!(log.ambushTargetId || (log.ambushIds || []).length));
        if (plan.roleBluff.role === '老朝奉') return logs.some(log => /擾亂/.test(String(log.ability || '') + ' ' + String(log.skillTag || '')) || log.laoSkillDecision === 'activate');
        return true;
      })();
      // 明確的藥不然／老朝奉換位框架本身就是預先規劃的特殊戰術；
      // 其他偽裝則必須先有可公開核對的能力表現，才可直接報角色。
      const explicitClaimNeeded = !!(explicitRoleSwapFrame || (roleCanBePubliclySupported &&
        (plan.publicRolePressure || (t >= 2 && plan.evilPosture === 'desperate' && !ownPriorClaim))));
      plan.roleBluff.explicitClaim = explicitClaimNeeded;
      plan.roleBluff.presentation = explicitClaimNeeded ? 'direct-claim' : (ownPriorClaim ? 'quiet-continuation' : 'gradual-cover');
      plan.roleBluff.previousPublicRole = ownPriorClaim && ownPriorClaim.role || null;
      plan.roleBluff.reassert = explicitClaimNeeded && !!ownPriorClaim;
      if (!explicitClaimNeeded) plan.roleBluff.fakeConfess = false;
      plan.roleBluff.coverStyle = plan.roleBluff.role === '許願' ? 'selective-two-source' :
        ['黃煙煙', '木戶加奈'].includes(plan.roleBluff.role) ? 'one-unreadable-round' :
        plan.roleBluff.role === '方震' ? 'single-camp-check' : 'public-behavior-first';
    }

    // 假扮許願的任何非許願角色，都必須能交代兩尊不同獸首的來源；但可以謹慎隱藏其中一筆。
    ensureFakeXuAbilityProfile(plan, bot, rd, A, t);
    if (plan.roleBluff && plan.roleBluff.role === '許願' && plan.roleBluff.abilityProfile) {
      const profile = plan.roleBluff.abilityProfile;
      why.push(`假扮許願的能力輪廓有兩尊不同獸首來源：${profile.beastNames.join('、')}；本輪公開${profile.publicBeastNames.join('、')}，其餘來源可以保留，不必把雙查驗全部攤開`);
    }

    // 假扮黃煙煙／木戶加奈時，必須履行「三輪中有一輪驗不到」的角色能力輪廓。
    // 這只約束公開表演，不改變本 Bot 私下取得的查驗結果與實際投票能力。
    if (plan.roleBluff && ['黃煙煙', '木戶加奈'].includes(plan.roleBluff.role)) {
      const hasPublicUnable = (room.rounds || []).slice(0, t + 1).some((historyRound, roundIndex) =>
        (historyRound.speeches || []).some(sp => {
          if (!sp || sp.playerId !== bot.id) return false;
          const raw = String(sp.text || '');
          const parsed = publicSpeechData(sp, room, historyRound);
          return !!parsed.unsure || /驗不到|無法辨別真偽|看不懂真偽/.test(raw);
        })
      );
      const profile = plan.roleBluff.abilityProfile || (hasPublicUnable ? { unreadableRound: null, satisfied: true } : null);
      if (!profile && !hasPublicUnable) {
        plan.roleBluff.abilityProfile = { unreadableRound: t + 1, kind: 'single-unreadable-round' };
        plan.roleAbilityCover = 'unreadable';
        plan.claims = [];
        plan.withholdInfo = false;
        why.push(`我假扮【${plan.roleBluff.role}】，這個角色三輪中應有一輪無法辨別；我把第${t + 1}輪安排為公開驗不到，其餘輪次再用能力相容的說法維持身分可信度。`);
      } else if (profile && !profile.satisfied && profile.unreadableRound === t + 1 && !hasPublicUnable) {
        plan.roleAbilityCover = 'unreadable';
        plan.claims = [];
        plan.withholdInfo = false;
      }
    }

    // 許願若公開報出一尊自己實際驗真的獸首，預設也把它作為本輪主票目標，避免「口頭告知隊友、落票卻投別尊」損害資訊可信度。
    // 若該資訊只是偽裝/盲視，或是贗品宣稱，則不套用這個一致性錨點。
    if (bot.role === '許願' && ctx.isGood && !plan.bluff && !plan.fakeFangClaim && !plan.roleBluff && !plan.confess) {
      const reportedRealInspection = (plan.claims || []).find(c => c.real === true && myIns.some(i => i.beastName === c.beast && GD.Mind.inspectionTruth(i) === true));
      if (reportedRealInspection && !plan.avoid.includes(reportedRealInspection.beast) && plan.beast !== reportedRealInspection.beast) {
        why.push(`許願本輪公開了【${reportedRealInspection.beast}】真品資訊，主票先與自己公開的真實查驗保持一致，讓隊友能根據可核對的言行建立信任`);
        plan.beast = reportedRealInspection.beast;
      }
    }

    // 許願專屬自然話術：風格多樣化，但不暗示還有第二筆查驗，更不公開隱藏獸首。
    if (bot.role === '許願' && !plan.roleBluff && !plan.fakeFangClaim && !plan.confess && GD.DialogueBank) {
      const publicFingerprint = (rd.speeches || []).map(sp => { const speaker = U.byId(room, sp.playerId); const stableId = speaker ? (speaker.botId || speaker.name || speaker.id) : (sp.speakerName || 'unknown'); return `${stableId}:${String(sp.text || '').slice(0, 48)}`; }).join('|');
      const xuSeed = GD.DialogueBank.hash(`${room.roomId || room.id || ''}:${bot.botId || bot.id}:${t}:${ctx.myPos}:${plan.beast}:${publicFingerprint}:xu-yuan-tactics`);
      const rolePressure = (rd.speeches || []).some(sp => sp && /許願|第二尊|兩筆查驗|多查驗/.test(String(sp.text || '')));
      if (xuSeed % 100 < (rolePressure ? 82 : 62)) {
        plan.xuYuanLine = GD.DialogueBank.pick('xuYuanTactics', xuSeed, { beast: plan.beast, round: t + 1 });
      }
    }

    /* ---- 隱藏已被可信早位重複證實的私密資訊；不改內部後驗、避投與票型計算 ---- */
    reduceRedundantPublicClaims(bot, room, ctx, A, plan);

    // 認壞／公開假扮壞人角色：主張、表演與實際投票共用同一贗品目標。
    if (plan.confess) {
      const target = chooseCounterfeitTarget(myIns, ranked, plan.beast);
      plan.beast = target || plan.beast;
      plan.claims = plan.beast ? [{ beast: plan.beast, real: false }] : [];
      plan.avoid = [];
      plan.withholdInfo = false;
      plan.withheldClaims = [];
    } else if (!ctx.isGood && plan.roleBluff && GD.ROLES && GD.ROLES[plan.roleBluff.role] && GD.ROLES[plan.roleBluff.role].camp === 'evil') {
      const target = chooseCounterfeitTarget(myIns, ranked, plan.padBeast);
      if (target) {
        plan.evilRolePerformance = true;
        plan.beast = target;
        plan.claims = [{ beast: plan.beast, real: false }];
        plan.avoid = [];
        plan.padBeast = null;
        plan.partnerBeast = null;
        plan.withholdInfo = false;
        plan.withheldClaims = [];
      } else {
        // 沒有可合理主張的贗品時，取消這次假跳，不以已確認真品硬湊一套演技。
        plan.roleBluff = null;
        plan.evilRolePerformance = false;
        why.unshift('沒有可安全主張為贗品的目標，本輪取消假跳壞人角色表演，避免公開立場與票向失去依據。');
      }
    }

    /* ---- 全局算票、保真得分估值與條件式台詞 ---- */
    if (GD.Tactics && typeof GD.Tactics.publicNarrative === 'function') {
      const seedText = `${bot.botId || bot.id}:${t}:${ctx.myPos}:${plan.mode}:${plan.beast}:${plan.roleBluff ? plan.roleBluff.role : ''}`;
      const seed = GD.DialogueBank && GD.DialogueBank.hash ? GD.DialogueBank.hash(seedText) : undefined;
      plan.tactics = GD.Tactics.publicNarrative(room, bot, A, plan, seed);
      plan.tacticalLine = plan.tactics && plan.tactics.line || '';
      plan.tacticalStrategy = plan.tactics && plan.tactics.strategy || null;
      if (plan.tactics && plan.tactics.score) {
        why.push(`全局盤面估算：保真部分約 ${plan.tactics.score.expectedSavedReal} 分，公開第二名確真累積 ${plan.tactics.score.publicRank2RealPoints} 分；票數預測仍有不確定性`);
      }
    }

    /* ---- 終局好人嫌疑盤點：只公開有證據支持的人，其他人保留待觀察 ---- */
    if (ctx.isGood && t === 2 && !hasPublicSuspectAssessment(room, rd.speeches)) {
      const brief = buildPublicSuspectBrief(A, bot, genes);
      plan.publicSuspectTags = brief.tags;
      plan.publicLaoCandidateTag = brief.laoTag;
      plan.publicSuspectBrief = brief.brief;
      plan.publicSuspectCandidateCount = brief.candidateCount;
      plan.publicLaoUnresolved = brief.laoUnresolved;
    }

    if (bot.role === '鄭國渠' && t < 2 && !plan.confess && !plan.evilRolePerformance) {
      const hardPromise = (rd.speeches || []).some(sp => String(sp && sp.playerId) === String(bot.id) &&
        !!publicSpeechData(sp, room, rd).voteCommitmentBinding);
      if (!hardPromise && plan.beast) {
        const ownPost = A.post || [];
        const passIndex = Array.isArray(rd.passOrder) ? rd.passOrder.indexOf(bot.id) : ctx.myPos;
        const earlierClaims = (rd.speeches || []).filter(sp => {
          if (!sp || String(sp.playerId) === String(bot.id)) return false;
          const pos = Array.isArray(rd.passOrder) ? rd.passOrder.indexOf(sp.playerId) : -1;
          return pos >= 0 && passIndex >= 0 && pos < passIndex;
        }).flatMap(sp => {
          const data = publicSpeechData(sp, room, rd);
          return (data.claims || []).filter(claim => claim && claim.real === true && claim.beast)
            .map(claim => ({ beast: claim.beast, speakerId: sp.playerId, speakerName: sp.speakerName || '' }));
        });
        const probOf = name => {
          const item = ownPost.find(row => row && row.name === name);
          return item && Number.isFinite(Number(item.pReal)) ? Number(item.pReal) :
            item && Number.isFinite(Number(item.p)) ? Number(item.p) : 0.5;
        };
        const candidates = earlierClaims.filter(item => item.beast !== plan.beast &&
          (rd.beasts || []).some(beast => beast.name === item.beast) && probOf(item.beast) <= 0.38)
          .sort((a, b) => probOf(a.beast) - probOf(b.beast));
        const fallback = ownPost.filter(item => item && item.name !== plan.beast &&
          (rd.beasts || []).some(beast => beast.name === item.name) &&
          (Number.isFinite(Number(item.pReal)) ? Number(item.pReal) : Number(item.p)) <= 0.34)
          .sort((a, b) => (Number(a.pReal ?? a.p) - Number(b.pReal ?? b.p)))[0];
        const chosen = candidates[0] || (fallback ? { beast: fallback.name, speakerId: null, speakerName: '' } : null);
        if (chosen) {
          plan.zhengBlindSignal = { beast: chosen.beast, mainBeast: plan.beast,
            sourceSpeakerId: chosen.speakerId || null, source: candidates.length ? 'front-public-false-real-claim' : 'low-posterior-fallback',
            posterior: Number(probOf(chosen.beast).toFixed(3)) };
        }
      }
    }

    // v10.9 social tactical layer: derive one public-information-only tactic after belief/skill planning.
    plan.socialTactic = GD.Tactics && typeof GD.Tactics.chooseSocialTactic === 'function'
      ? GD.Tactics.chooseSocialTactic(room, bot, A, plan) : null;
    if (plan.socialTactic && plan.socialTactic.targetId && plan.socialTactic.focus === 'attack') {
      const socialTarget = U.byId(room, plan.socialTactic.targetId);
      plan.socialTactic.targetTag = socialTarget ? U.tag(socialTarget) : plan.socialTactic.targetTag || '';
    }
    // One dominant conversational objective is selected after the tactical plan is complete.
    // It shapes phrasing and focus only; voting, skills, and all game rules remain unchanged.
    plan.dialogueFocus = deriveDialogueFocus(bot, room, plan, A);
    // 壞人可把真正技能或未核實的技能假說當成公開掩護；不改動任何技能執行與查驗結果。
    plan.skillCoverStory = plan.trueRoleSignal && plan.trueRoleSignal.reveal ||
      (plan.roleBluff && !['藥不然', '鄭國渠'].includes(plan.roleBluff.role))
      ? null : chooseAbilityCoverStory(bot, room, plan, A);
    plan.tacticalPlan = {
      id: `${room.gameId || room.roomId || 'local'}:${t + 1}:${bot.id}`,
      chosenTactic: plan.socialTactic && plan.socialTactic.mode || plan.tacticalStrategy || plan.mode || 'baseline',
      targetPlayerId: plan.socialTactic && plan.socialTactic.targetId || plan.dialogueFocus && plan.dialogueFocus.targetId || null,
      targetBeast: plan.socialTactic && (plan.socialTactic.ballotBeast || plan.socialTactic.targetBeast) || plan.beast || null,
      backupBeast: plan.socialTactic && plan.socialTactic.coverBeast || null,
      speechObjective: { type: plan.dialogueFocus && plan.dialogueFocus.type || 'position', targetId: plan.dialogueFocus && plan.dialogueFocus.targetId || null },
      ballotObjective: { mode: plan.socialTactic && plan.socialTactic.ballotMode || 'optimize', targetBeast: plan.socialTactic && plan.socialTactic.ballotBeast || plan.beast || null },
      skillCoverStory: plan.skillCoverStory ? { role: plan.skillCoverStory.role, truthMode: plan.skillCoverStory.truthMode, beast: plan.skillCoverStory.beast } : null,
      riskTolerance: Number(plan.socialTactic && plan.socialTactic.riskTolerance) || U.clamp(0.34 * (Number(ctx.genes.assertiveness) || 0.5) + 0.34 * (Number(ctx.genes.deception) || 0.5) + 0.20 * (1 - (Number(ctx.genes.skepticism) || 0.5)) + 0.12 * (Number(ctx.genes.camouflage) || 0.5), 0, 1),
      status: 'planned', actualBallot: null
    };

    /* ---- 寫入覆盤用紀錄 ---- */
    const top = Object.values(A.prof).filter(r => !r.knownGood && r.knownCamp !== 'good').sort((a, b) => (Number(b.pEvil) - Number(a.pEvil)) || (b.evil - a.evil)).slice(0, 2);
    rd.mind[bot.id] = {
      pos: ctx.myPos, mode: plan.mode, beast: plan.beast, avoid: plan.avoid, claims: plan.claims,
      evilRolePerformance: !!plan.evilRolePerformance,
      revealFang: !!plan.revealFang, roleAbilityCover: plan.roleAbilityCover || null,
      withholdInfo: !!plan.withholdInfo, withheldClaimCount: (plan.withheldClaims || []).length,
      withholdReason: plan.withholdReason || null,
      evilPosture: plan.evilPosture || null, evilStyle: plan.evilStyle || null,
      teamDeceptionPosture: plan.teamDeceptionPosture || null,
      estimatedGoodScore: plan.estimatedGoodScore == null ? null : plan.estimatedGoodScore,
      roleBluff: plan.roleBluff || null,
      roleBluffAbandonedReason: plan.roleBluffAbandonedReason || null,
      roleDiscussionEvent: plan.roleDiscussionEvent || null,
      roleDiscussionAudit: plan.roleDiscussionAudit || null,
      zhengBlindSignal: plan.zhengBlindSignal || null,
      roleSwapTrap: plan.roleSwapTrap || null,
      ambushFrame: plan.ambushFrame || null,
      ambushFrameHypothesis: plan.ambushFrameHypothesis || null,
      trueRoleSignal: plan.trueRoleSignal ? { role: plan.trueRoleSignal.role, kind: plan.trueRoleSignal.kind, reveal: !!plan.trueRoleSignal.reveal, verifiedCampChecks: plan.trueRoleSignal.verifiedCampChecks || [], category: plan.trueRoleSignal.category, line: plan.trueRoleSignal.line, hasAbilityEvidence: !!plan.trueRoleSignal.hasAbilityEvidence } : null,
      tacticalCategory: plan.tactics && plan.tactics.category || null,
      tacticalStrategy: plan.tacticalStrategy || null,
      tacticalLine: plan.tacticalLine || '',
      skillCoverStory: plan.skillCoverStory ? { ...plan.skillCoverStory } : null,
      tacticalPlan: plan.tacticalPlan ? { ...plan.tacticalPlan } : null,
      socialTactic: plan.socialTactic ? {
        name: plan.socialTactic.name, mode: plan.socialTactic.mode, focus: plan.socialTactic.focus,
        targetId: plan.socialTactic.targetId || null, targetTag: plan.socialTactic.targetTag || '',
        targetBeast: plan.socialTactic.targetBeast || null, coverBeast: plan.socialTactic.coverBeast || null,
        ballotMode: plan.socialTactic.ballotMode || null, ballotBeast: plan.socialTactic.ballotBeast || null,
        reason: plan.socialTactic.reason || null, confidence: plan.socialTactic.confidence || 0,
        teamAssignment: !ctx.isGood ? { actorRole: bot.role, duty: ({ decoy: 'partner-cover-and-pressure-redirection', 'all-in': 'counterfeit-vote-push', 'camouflage-betrayal': 'create-public-distance-and-split-vote', 'false-agreement': 'mirror-consensus-while-shifting-ballot', 'coalition-break': 'break-opposing-coalition', 'sacrifice-cover': 'absorb-pressure-to-protect-ally' })[plan.socialTactic.mode] || 'public-misdirection', partnerId: ctx.partner && ctx.partner.id || null, basis: 'own-role-and-public-information-only' } : null,
        publicDirective: plan.socialTactic.publicDirective || '', executed: false
      } : null,
      dialogueFocus: plan.dialogueFocus ? { type: plan.dialogueFocus.type, targetId: plan.dialogueFocus.targetId || null,
        targetTag: plan.dialogueFocus.targetTag || '', source: plan.dialogueFocus.source, priority: plan.dialogueFocus.priority,
        style: plan.dialogueFocus.style, label: plan.dialogueFocus.label, round: plan.dialogueFocus.round } : null,
      xuYuanLine: plan.xuYuanLine || null,
      voteForecast: plan.tactics && plan.tactics.forecast ? {
        round: plan.tactics.forecast.round,
        consensusBeast: plan.tactics.forecast.consensusBeast,
        consensusCallers: plan.tactics.forecast.consensusCallers,
        coalitionTarget: plan.tactics.forecast.coalitionTarget || null,
        goodExpectedVotes: { ...(plan.tactics.forecast.goodExpectedVotes || {}) },
        evilExpectedVotes: { ...(plan.tactics.forecast.evilExpectedVotes || {}) },
        coordinationVariance: { ...(plan.tactics.forecast.coordinationVariance || {}) },
        ranking: (plan.tactics.forecast.ranking || []).map(x => ({ name: x.name, expectedVotes: x.expectedVotes, observedVotes: x.observedVotes, pTopTwo: x.pTopTwo }))
      } : null,
      scoreProjection: plan.tactics && plan.tactics.score ? { ...plan.tactics.score } : null,
      inferredBuddyId: plan.inferredBuddyId || null,
      suspectId: plan.suspectId, softShadeId: plan.softShadeId, fakeFangClaim: plan.fakeFangClaim,
      padBeast: plan.padBeast, why, publicSuspectBrief: plan.publicSuspectBrief || null, hideBlind: !!plan.hideBlind,
      askId: plan.askId || null, askKind: plan.askKind || null,
      askEvidence: plan.askEvidence || null, askRound: plan.askRound || null,
      confess: !!plan.confess, explained: !!plan.explain,
      followHuman: plan.followHuman ? plan.followHuman.callerId : null,
      insText: (log.inspect || []).map(i => i.resultText),
      blind: !!log.blind,
      post: A.post.map(b => ({ name: b.name, p: U.round3(b.pReal) })),
      // 只保存本 Bot 自己推導的機率，不讀取其他 AI 的私有 mind 或真實角色。
      beliefProfile: Object.fromEntries(Object.entries(A.prof).map(([id, rec]) => [id, {
        pEvil: rec.pEvil, pGood: rec.pGood, pLao: rec.pLao, pZheng: rec.pZheng, isPartner: !!rec.isPartner, flipWindowSupport: rec.flipWindowSupport || 0, knownCamp: rec.knownCamp || null,
        probs: { ...(rec.probs || {}) }
      }])),
      laoAt: A.laoAt.map(U.round3),
      laoTimingAudit: plan.laoTimingAudit || null,
      consensusAudit: plan.consensusAudit || [],
      publicCountConstraints: A.publicCountConstraints || [],
      claimEvidence: A.claimEvidence ? A.claimEvidence.current.map(entry => ({ ...entry })) : [],
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
    const bank = GD.Engine && typeof GD.Engine.availableChips === 'function'
      ? GD.Engine.availableChips(room, bot.id)
      : Math.max(0, Number(bot.voteBank) || 0);
    if (bank <= 0) return {};
    const genes = bot.genes || GD.Genes.load(bot.botId);
    const spend = GD.Tactics && typeof GD.Tactics.voteSpendLimit === 'function'
      ? GD.Tactics.voteSpendLimit(room, bot, m)
      : bank;
    const ownSpeech = (rd.speeches || []).find(sp => String(sp && sp.playerId) === String(bot.id));
    const ownSpeechData = publicSpeechData(ownSpeech, room, rd);
    const promisedBeast = ownSpeechData.voteCommitmentBinding ? (ownSpeechData.voteCommitment || null) : null;
    const social = m.socialTactic || null;
    const annotateBallotTactic = (candidate, diagnostic) => {
      const positive = Object.entries(candidate || {}).filter(([, value]) => Number(value) > 0).sort((a, b) => Number(b[1]) - Number(a[1]));
      const mode = !positive.length ? 'abstain' : positive.length > 1 ? 'split' : Number(positive[0][1]) <= 1 ? 'probe' : 'concentrate';
      const projected = diagnostic && diagnostic.projectedTopTwo || [];
      const votedForProjectedPair = positive.some(([name]) => projected.includes(name));
      const publicCalls = [...new Set([...(ownSpeechData.speakerCalls || ownSpeechData.callBeasts || []), ownSpeechData.callBeast].filter(Boolean))];
      const primaryTarget = positive[0] && positive[0][0] || null;
      const alignsWithPublicCall = !publicCalls.length || positive.some(([name]) => publicCalls.includes(name));
      const speechTopTwo = (m.voteForecast && m.voteForecast.ranking || []).slice().sort((a, b) => Number(b.expectedVotes) - Number(a.expectedVotes)).slice(0, 2).map(row => row.name);
      const ballotForecast = GD.Tactics && GD.Tactics.forecastVotes
        ? GD.Tactics.forecastVotes(room, bot.id, m.beliefProfile) : null;
      const ballotTopTwo = (ballotForecast && ballotForecast.ranking || []).slice().sort((a, b) => Number(b.expectedVotes) - Number(a.expectedVotes)).slice(0, 2).map(row => row.name);
      const forecastShifted = speechTopTwo.length > 0 && ballotTopTwo.length > 0 &&
        speechTopTwo.join('|') !== ballotTopTwo.join('|');
      const divergenceReason = mode === 'abstain' ? 'preserve_chips_after_low_marginal_value_check'
        : alignsWithPublicCall ? null
        : (m.coalitionRedirect && m.coalitionRedirect.executed) ? 'bait_and_redirect_to_improve_fake_top_two'
          : forecastShifted ? 'updated_after_later_public_speeches_changed_the_top_two_forecast'
            : (positive.some(([name]) => projected.includes(name)) ? 'joint_top_two_marginal_value_outweighed_the_called_target'
              : 'private_posterior_value_outweighed_the_called_target');
      m.ballotTactic = { mode, rationale: mode === 'abstain' ? 'preserve_chips_when_marginal_value_is_low' :
        mode === 'split' ? 'support_two_targets_for_joint_top_two_value' :
          mode === 'probe' ? 'single_chip_probe' : 'concentrate_on_high_marginal_target',
        objective: diagnostic && diagnostic.objective || null, projectedTopTwo: projected.slice(),
        marginalExpectedGoodPoints: (diagnostic && diagnostic.marginalExpectedGoodPoints) ?? null,
        alignsWithProjectedTopTwo: votedForProjectedPair,
        publicCallTargets: publicCalls, primaryTarget,
        alignsWithPublicCall, divergenceReason,
        speechForecastTopTwo: speechTopTwo, ballotForecastTopTwo: ballotTopTwo, forecastShifted };
    };
    const ballot = {};
    const finalizePublicPerformanceBallot = candidate => {
      const hasCandidateVotes = Object.values(candidate || {}).some(value => Number(value) > 0);
      m.plannedBallot = { ...(candidate || {}) };
      let finalBallot = { ...(candidate || {}) };
      // A concrete first-person promise is binding only when the legal spend limit permits at least one chip.
      // In the absence of such a promise, a zero-chip abstention remains legal for both camps.
      const intentionalModes = ['all-in', 'decoy', 'camouflage-betrayal', 'counter-consensus',
        'false-agreement', 'coalition-break', 'sacrifice-cover', 'planned-pivot'];
      const intentionalDivergence = !GD.isGood(bot.role) && social && intentionalModes.includes(social.mode) &&
        (social.ballotBeast || social.targetBeast) && Object.entries(finalBallot).some(([name, chips]) => Number(chips) > 0 && name !== promisedBeast);
      if (promisedBeast && spend > 0 && !intentionalDivergence) {
        finalBallot = enforcePublicTargetAnchor(finalBallot, promisedBeast, spend);
        m.votePromiseHonored = true;
      } else if (promisedBeast && spend > 0 && intentionalDivergence) {
        m.votePromiseHonored = Number(finalBallot[promisedBeast] || 0) > 0;
        m.votePromiseMismatchReason = 'intentional-social-tactic-divergence';
      } else if (hasCandidateVotes && !GD.isGood(bot.role) && (m.mode === 'confess' || m.confess || m.evilRolePerformance) && m.beast && spend > 0) {
        finalBallot = enforcePublicTargetAnchor(finalBallot, m.beast, spend);
      } else if (promisedBeast && spend <= 0) {
        m.votePromiseHonored = false;
        m.votePromiseBlockedBySpendLimit = true;
      } else if (bot.role === '鄭國渠' && t < 2 && spend >= 2 && m.zhengBlindSignal &&
          m.zhengBlindSignal.beast && m.zhengBlindSignal.beast !== m.beast) {
        finalBallot = { [m.beast]: spend - 1, [m.zhengBlindSignal.beast]: 1 };
        m.zhengBlindSignal.executed = true;
      }
      m.adjustedBallot = { ...finalBallot };
      annotateBallotTactic(finalBallot, m.ballotModel);
      m.actualBallot = { ...finalBallot };
      if (social) {
        const intendedBeast = social.ballotBeast || social.targetBeast || null;
        social.executedBallot = { ...finalBallot };
        social.executed = Object.values(finalBallot).some(value => Number(value) > 0) &&
          (!intendedBeast || Number(finalBallot[intendedBeast] || 0) > 0 ||
            (social.coverBeast && Number(finalBallot[social.coverBeast] || 0) > 0));
      }
      if (m.tacticalPlan) {
        m.tacticalPlan.actualBallot = { ...finalBallot };
        m.tacticalPlan.status = 'ballot-executed';
        m.tacticalPlan.ballotObjective = { ...(m.tacticalPlan.ballotObjective || {}), actualBallot: { ...finalBallot } };
      }
      const commitmentRows = (ownSpeechData.voteCommitments || []).map(item => {
        const actualVotes = Math.max(0, Number(finalBallot[item.beast]) || 0);
        const expectedVotes = Number.isFinite(Number(item.chips)) && Number(item.chips) > 0
          ? Number(item.chips) : (item.kind === 'probe' ? 1 : 1);
        return {
          beast: item.beast, chips: item.chips ?? null, binding: item.binding !== false,
          kind: item.kind || 'explicit', text: item.text || '', actualVotes, expectedVotes,
          fulfilled: item.binding !== false ? actualVotes >= expectedVotes : null
        };
      });
      const probeAudit = (ownSpeechData.voteProbeTargets || []).map(beast => ({
        beast, expectedVotes: 1, actualVotes: Math.max(0, Number(finalBallot[beast]) || 0),
        fulfilled: Number(finalBallot[beast] || 0) >= 1
      }));
      const primaryCommitment = commitmentRows.find(item => item.kind !== 'probe') || commitmentRows[0] || null;
      m.commitmentAudit = {
        publicCalls: [...new Set([...(ownSpeechData.speakerCalls || ownSpeechData.callBeasts || []), ownSpeechData.callBeast].filter(Boolean))],
        commitments: commitmentRows, probeAudit,
        softIntents: (ownSpeechData.voteIntents || []).map(item => ({ beast: item.beast, kind: item.kind || 'soft-intent', intensity: item.intensity || 0 })),
        plannedBallot: { ...(m.plannedBallot || {}) }, adjustedBallot: { ...(m.adjustedBallot || {}) },
        actualBallot: { ...finalBallot },
        totalSpent: Object.values(finalBallot).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0),
        votePromiseHonored: primaryCommitment ? primaryCommitment.fulfilled !== false : m.votePromiseHonored !== false,
        votePromiseMismatchReason: m.votePromiseMismatchReason || null,
        socialTactic: social ? { name: social.name, mode: social.mode, executed: !!social.executed,
          executedBallot: { ...(social.executedBallot || {}) }, reason: social.reason || null } : null,
        recordedAt: Date.now()
      };
      return finalBallot;
    };

    // v10.9.1：同一個效用模型評估所有社會戰術，不再讓 All-In／Decoy／偽裝分票繞過前二名與留票效益。
    if (GD.Tactics && typeof GD.Tactics.optimizeBallot === 'function' &&
        (GD.isGood(bot.role) || social)) {
      const model = GD.Tactics.optimizeBallot(room, bot, m, spend);
      if (model && model.ballot) {
        m.ballotModel = model.diagnostic || null;
        annotateBallotTactic(model.ballot, model.diagnostic);
        m.actualBallot = { ...model.ballot };
        return finalizePublicPerformanceBallot(model.ballot);
      }
    }

    if (!GD.isGood(bot.role)) {
      // A. 偽裝講真話模式：如何在「維持口頭真品宣稱一致」與「偷墊假貨」之間取捨
      if (m.mode === 'camouflage' && m.padBeast && spend >= 2 && m.padBeast !== m.beast) {
        if (rnd() < 0.25 + 0.65 * genes.camouflage) {
          // 具備偽裝執行力：留 1 票護航口頭宣稱的真品（避免 0 票矛盾），其餘墊給假貨
          ballot[m.beast] = 1;
          ballot[m.padBeast] = spend - 1;
          return finalizePublicPerformanceBallot(ballot);
        } else if (rnd() < 0.55 * (1 - genes.camouflage)) {
          // 低偽裝力露出明顯破綻：嘴上報真品 m.beast，卻把全部籌碼灌給假貨 m.padBeast（產生 0 票言行矛盾）
          ballot[m.padBeast] = spend;
          return finalizePublicPerformanceBallot(ballot);
        }
      }

      // B. 說謊／跟風模式：當自己喊的假貨在場上孤立無援時，如何處理選票
      const callCounts = {};
      (rd.speeches || []).forEach(sp => {
        const cb = publicSpeechData(sp, room, rd).callBeast;
        if (cb) callCounts[cb] = (callCounts[cb] || 0) + 1;
      });
      if (spend >= 2 && GD.Tactics && typeof GD.Tactics.chooseEvilCoalitionTarget === 'function') {
        const redirect = GD.Tactics.chooseEvilCoalitionTarget(room, bot.id, m);
        const rallyFake = redirect && redirect.shouldRedirect
          ? m.post.find(b => b.name === redirect.target && b.p <= 0.48)
          : (callCounts[m.beast] <= 1 ? [...m.post]
            .filter(b => b.name !== m.beast && b.p <= 0.48 && (callCounts[b.name] || 0) >= 1)
            .sort((a, b) => (callCounts[b.name] || 0) - (callCounts[a.name] || 0) || (zIdx(a.name) - zIdx(b.name)))[0] : null);
        if (rallyFake && rallyFake.name !== m.beast) {
          m.coalitionRedirect = redirect || null;
          const redirectChance = m.evilPosture === 'desperate' ? 0.92 : U.clamp(0.18 + 0.48 * genes.deception + 0.22 * genes.camouflage, 0.15, 0.82);
          if (rnd() < redirectChance) {
            if (genes.camouflage >= 0.62 && spend >= 2 && rnd() < 0.68) {
              // 保留一票維持公開立場，其餘投入更有機會進前二的替代贗品。
              ballot[m.beast] = 1;
              ballot[rallyFake.name] = spend - 1;
            } else {
              // 可以讓公開號召與實際票向不同；這是有目的的分票／轉移，不是解析錯誤。
              ballot[rallyFake.name] = spend;
            }
            m.coalitionRedirect.executed = true;
            return finalizePublicPerformanceBallot(ballot);
          }
        }
      }
    }

    // 壞人的原有偽裝／衝票特例優先；未觸發時，以公開票數估計和本人的後驗選擇更有效的假貨前二配置。
    if (GD.Tactics && typeof GD.Tactics.optimizeBallot === 'function') {
      const model = GD.Tactics.optimizeBallot(room, bot, m, spend);
      if (model && model.ballot) {
        m.ballotModel = model.diagnostic || null;
        annotateBallotTactic(model.ballot, model.diagnostic);
        m.actualBallot = { ...model.ballot };
        return finalizePublicPerformanceBallot(model.ballot);
      }
    }
    if (spend > 0) ballot[m.beast] = spend;
    return finalizePublicPerformanceBallot(ballot);
  };

  /* ---------------------------------------------------------------- 終局鑑人 */

  function finalLaoCandidateScore(rec, A) {
    const id = rec && rec.player && rec.player.id;
    if (!id) return -Infinity;
    if (rec.knownCamp === 'good' || rec.knownGood) return -Infinity;
    const pLao = Number(rec.probs && rec.probs['老朝奉'] || 0);
    const timingSupport = U.clamp(Number(rec.laoTimingSupport) || 0, 0, 1);
    const timingBonus = Math.min(4, timingSupport * 5);
    const flipWindowBonus = Math.min(4, Math.max(0, Number(rec.flipWindowSupport) || 0) * 4);
    let publicBallotSignal = 0;
    (A.ctx.room.rounds || []).forEach(rd => {
      if (!rd || !rd.voteResults || !rd.voteResults.rank2 || !rd.votes) return;
      const opened = rd.voteResults.rank2;
      if (typeof opened.isReal !== 'boolean' || !opened.name) return;
      const chips = Number(rd.votes[id] && rd.votes[id][opened.name]) || 0;
      if (!chips) return;
      // 票投向後來揭露的假貨只算弱角色線索，不單憑一輪投票定義身分。
      if (opened.isReal === false) publicBallotSignal += Math.min(1.25, chips * 0.45);
      else publicBallotSignal -= Math.min(0.35, chips * 0.12);
    });
    const independentLaoSupport = Math.min(3, Math.max(0, Number(rec.laoTimingRounds || 0)) * 0.65 + (timingSupport >= 0.35 ? 0.8 : 0));
    const base = pLao * 2.35 + Math.min(5, Math.max(0, rec.evil || 0) * 0.045) +
      (rec.conflicts && rec.conflicts.length ? 2.2 : 0) + timingBonus + flipWindowBonus + independentLaoSupport + publicBallotSignal - Math.min(8, Math.max(0, rec.ally || 0) * 0.08);
    // 私人時序交集權重最高；公開歷史回報與玩家候選集合僅作弱佐證。
    const privateIntersection = (A.laoIntersectIds || []).includes(id) ? 25 : 0;
    const publicFlipCount = (A.publicReportedFlipPools || []).filter(pool => (pool.candidateIds || []).includes(id)).length;
    const publicFlipBonus = Math.min(8, publicFlipCount * 4);
    const publicCandidateCount = (A.publicCandidateGroups || []).filter(group => group.role === "老朝奉" && (group.candidateIds || []).includes(id)).length;
    const publicCandidateBonus = Math.min(6, publicCandidateCount * 3);
    // 方震查驗只證明對方屬於壞人陣營，不能證明對方就是老朝奉。
    return base + privateIntersection + publicFlipBonus + publicCandidateBonus;
  }

  S.personVote = function (bot, room) {
    const A = Mind.analyze(bot, room), { ctx } = A;
    const last = [...room.rounds].reverse().map(r => r.mind && r.mind[bot.id]).find(Boolean);
    const targetRole = ctx.isGood ? '老朝奉'
      : bot.role === '老朝奉' ? '許願'
      : bot.role === '藥不然' ? '方震'
      : '好人誘餌';
    const assessment = assessFinalRoleCandidates(bot, room, A, targetRole);
    // 終局好人使用已公開的前序鑑人票收斂目標；只按自己的陣營後驗加權，不讀其他玩家的私有 mind。
    const priorGoodTargetSupport = new Map();
    Object.entries(room.personVotes || {}).forEach(([voterId, targetId]) => {
      if (!voterId || voterId === bot.id || !targetId || targetId === bot.id) return;
      const voter = A.prof && A.prof[voterId];
      if (!voter) return;
      const pEvil = Number(voter.pEvil);
      const weight = voter.knownCamp === 'good' || voter.knownGood ? 1.0
        : Number.isFinite(pEvil) && pEvil <= 0.30 ? 0.78
          : Number.isFinite(pEvil) && pEvil <= 0.42 ? 0.38 : 0.08;
      if (weight > 0) priorGoodTargetSupport.set(targetId, (priorGoodTargetSupport.get(targetId) || 0) + weight);
    });
    const bestLaoForCoordination = assessment.ranked[0] || null;
    const coordinatedLao = ctx.isGood && ctx.t === 2 && bestLaoForCoordination
      ? [...priorGoodTargetSupport.entries()].map(([targetId, support]) => ({
          targetId, support, candidate: assessment.ranked.find(item => item.id === targetId) || null
        })).filter(item => item.candidate && item.support >= 0.78 &&
          item.candidate.score >= bestLaoForCoordination.score - 4.5)
        .sort((a, b) => b.support - a.support || b.candidate.score - a.candidate.score)[0] || null
      : null;
    const anyPool = room.players.filter(p => p.id !== bot.id && !(ctx.partner && p.id === ctx.partner.id) &&
      !(A.prof[p.id] && (A.prof[p.id].knownEvil || (ctx.isGood && (A.prof[p.id].confessed || A.prof[p.id].knownGood || A.prof[p.id].knownCamp === 'good')))));
    const any = pickDecision(anyPool.length ? anyPool : room.players.filter(p => p.id !== bot.id)).id;
    let id = null, why = '', followId = null;

    if (ctx.isGood) {
      if (bot.role === '方震') {
        // 陣營查驗只能指出壞人方；再用同一份老朝奉排序選擇候選，不把壞人方直接等同老朝奉。
        const evilChecked = [];
        (room.rounds || []).forEach(rd => {
          const ownLog = rd.turnLogs && rd.turnLogs[bot.id];
          if (ownLog && ownLog.fangTargetId && ownLog.fangCamp === 'evil' &&
              assessment.ranked.some(item => item.id === ownLog.fangTargetId)) evilChecked.push(ownLog.fangTargetId);
        });
        evilChecked.sort((a, b) => {
          const sa = assessment.ranked.find(item => item.id === a)?.score ?? -Infinity;
          const sb = assessment.ranked.find(item => item.id === b)?.score ?? -Infinity;
          return sb - sa;
        });
        if (evilChecked.length) {
          const checked = A.prof[evilChecked[0]];
          const laoPosterior = Number(checked && checked.probs && checked.probs['老朝奉']) || 0;
          if (checked && (laoPosterior >= 18 || (A.laoIntersectIds || []).includes(evilChecked[0]))) {
            id = evilChecked[0];
            why = `我的方震陣營查驗確認${U.tag(U.byId(room, id))}是壞人；再加上老朝奉角色線索，才把他排在第一，不是把陣營查驗當成身分證明`;
          }
        }
      }
      if (!id) {
        const bestLao = coordinatedLao && coordinatedLao.candidate || assessment.ranked[0];
        if (ctx.t === 2 && bestLao) {
          id = bestLao.id;
          const bestEvidence = bestLao.evidence && bestLao.evidence[0];
          why = `${assessment.summary}${bestEvidence ? `主要依據：${bestEvidence.text}` : ''}${coordinatedLao ? `；另有前序已公開的鑑人票 ${coordinatedLao.support.toFixed(2)} 權重支持此候選，且其個人證據與第一名差距在 4.5 內，因此採取集火收斂。` : ''}`;
        } else if (A.publicCall && Number(A.prof[A.publicCall.targetId]?.pEvil || 0) > 0.60 &&
          (A.prof[A.publicCall.targetId]?.ally || 0) < 85 && rnd() < 0.3 + 0.65 * ctx.genes.conformity) {
          id = A.publicCall.targetId;
          followId = A.publicCall.callerId;
          why = `響應公開玩家【${A.publicCall.callerName}】的集火號召，但保留自己的嫌疑排序`;
        } else if (last && last.suspectId && last.suspectId !== bot.id && !(A.prof[last.suspectId] && A.prof[last.suspectId].confessed)) {
          id = last.suspectId;
          why = '沿用自己前面公開提出、仍未被新證據推翻的懷疑對象';
        } else if (A.topSuspect) {
          id = A.topSuspect.player.id;
          why = `目前公開與私有可用證據中，${U.tag(A.topSuspect.player)}的老朝奉嫌疑最高`;
        }
      }
    } else if (bot.role === '老朝奉' || bot.role === '藥不然') {
      const best = assessment.ranked[0];
      id = (best && best.id) || any;
      why = `${assessment.summary}${best && best.evidence && best.evidence.length ? `主要依據：${best.evidence[0].text}` : ''}`;
    } else {
      const inferred = inferEvilTeammate(bot, A, room);
      id = (assessment.ranked[0] && assessment.ranked[0].id) || any;
      why = inferred
        ? `鄭國渠的鑑人票不計分；我避開已知同伴，挑選目前最像好人的對象作為誘餌，讓終局指認留下錯誤線索`
        : '鄭國渠的鑑人票不計分；挑選目前最像好人的對象作為誘餌，讓終局指認留下錯誤線索';
    }

    id = id || any;
    const top = assessment.top.map(entry => {
      const rec = A.prof[entry.id] || {};
      return {
        id: entry.id, evil: entry.evil, score: Math.round(entry.score * 100) / 100,
        evidence: {
          privateLaoIntersection: (A.laoIntersectIds || []).includes(entry.id),
          timingPositionSupport: U.round3(Number(rec.laoTimingSupport) || 0),
          publicFlipReports: (A.publicReportedFlipPools || []).filter(pool => (pool.candidateIds || []).includes(entry.id)).length,
          publicCandidateGroups: (A.publicCandidateGroups || []).filter(group => (group.candidateIds || []).includes(entry.id)).length
        },
        probs: {
          '老朝奉': Number(rec.probs && rec.probs['老朝奉'] || 0),
          '藥不然': Number(rec.probs && rec.probs['藥不然'] || 0),
          '許願': Number(rec.probs && rec.probs['許願'] || 0),
          '方震': Number(rec.probs && rec.probs['方震'] || 0),
          '姬雲浮': Number(rec.probs && rec.probs['姬雲浮'] || 0)
        },
        reasons: entry.evidence.map(item => item.text).slice(0, 5)
      };
    });
    const eliminationNarrative = finalDeductionNarrative(assessment, id);
    why = [eliminationNarrative, why].filter(Boolean).join(' ');
    const slimEntry = r => ({ id: r.id, tag: r.tag, score: Math.round(r.score * 100) / 100, roleProbability: r.roleProbability, eliminationTier: r.eliminationTier || '保留候選' });
    const tiers = {
      confirmedExcluded: (assessment.hardExcluded || []).map(item => ({ id: item.id, tag: item.tag, role: item.role || '', reason: item.reason, eliminationTier: '確認排除' })),
      highlyUnlikely: assessment.ranked.filter(r => r.eliminationTier === '高度不可能').map(slimEntry),
      tentativelyExcluded: assessment.ranked.filter(r => r.eliminationTier === '暫時排除').map(slimEntry),
      retainedCandidates: assessment.ranked.filter(r => r.eliminationTier === '保留候選').map(slimEntry),
      insufficientInfo: assessment.ranked.filter(r => r.eliminationTier === '資訊不足，無法判斷').map(slimEntry)
    };
    const deduction = {
      targetRole,
      selectedId: id,
      summary: assessment.summary,
      eliminationNarrative,
      hardExcluded: assessment.hardExcluded,
      tiers,
      ranked: assessment.ranked.map(entry => ({
        id: entry.id, tag: entry.tag, score: Math.round(entry.score * 100) / 100,
        roleProbability: entry.roleProbability, jiProbability: entry.jiProbability,
        eliminationTier: entry.eliminationTier || '保留候選',
        supportingEvidence: (entry.supportingEvidence || []).map(item => ({ ...item })),
        counterEvidence: (entry.counterEvidence || []).map(item => ({ ...item })),
        evidence: entry.evidence.map(item => ({ ...item }))
      }))
    };
    return { targetId: id, why: why || '目前證據不足，依共用候選排序指認', followId, top, deduction };
  };

  S.roleBluffFeasibility = roleBluffFeasibility;
  S.committedFalseRoleBluff = committedFalseRoleBluff;
  S.evilStrategicState = evilStrategicState;
  S.buildPublicSuspectBrief = buildPublicSuspectBrief;
  S.hasPublicSuspectAssessment = hasPublicSuspectAssessment;
  function Engine() { return GD.Engine; }
  GD.Strategy = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Strategy;
})(typeof window !== 'undefined' ? window : global);
