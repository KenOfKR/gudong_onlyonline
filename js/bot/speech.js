/* ============================================================================
 * bot/speech.js — 發言生成（基於原版嚴格擴充：緊鄰直踩、首家不反轉與跨輪排除）
 *   buildPrompt   僅提供公開紀錄與核准表演策略；不將真實角色或私密查驗交給台詞生成器
 *   localSpeech   無網路 / Gemini 失敗時的本地說服型發言（同樣含：查驗矛盾→偽裝或帶風向→明確號召）
 *   validate      檢查 Gemini 輸出是否與計畫一致（不得講錯獸首、不得與自己的查驗矛盾、必須號召）
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U, Claims } = GD;
  const B = n => `【${n}】`;
  const real = v => (v ? '真' : '假');

  /* ------------------------------------------------------------------ 資料整理 */

  function history(room) {
    const t = room.currentRoundIdx;
    const lines = [];
    for (let r = 0; r < t; r++) {
      const rd = room.rounds[r], vr = rd && rd.voteResults;
      if (!vr) continue;
      const totals = vr.totals && typeof vr.totals === 'object' ? vr.totals : null;
      const votes = (Array.isArray(rd.beasts) ? rd.beasts : []).map(b => {
        const total = totals && Number.isFinite(Number(totals[b.name]))
          ? Math.max(0, Number(totals[b.name]))
          : Object.values(rd.votes || {}).reduce((sum, ballot) => sum + Math.max(0, Number(ballot && ballot[b.name]) || 0), 0);
        return `${B(b.name)}${total}票`;
      }).join('、');
      const rank2 = vr.rank2 && vr.rank2.name
        ? `公開第二名 ${B(vr.rank2.name)} 為${vr.rank2.isReal ? '真品' : '贗品'}`
        : '公開第二名資料缺漏';
      const rank1 = vr.rank1 && vr.rank1.name ? `封存第一名 ${B(vr.rank1.name)}（真偽未公開）` : '封存第一名資料缺漏';
      lines.push(`第${r + 1}輪：${votes || '票數紀錄缺漏'}；${rank2}；${rank1}`);
    }
    return lines.length ? lines.join('\n') : '（第一輪，尚無歷史開票）';
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
      return namedCount > 0 && namesArePresentedAsSuspects && (/老朝奉/.test(text) || explicitUncertainty);
    });
  }

  function priorSpeeches(room) {
    const rd = U.curRound(room);
    if (!rd.speeches.length) return '（你是本輪第一位發言者）';
    // 最新真人未回應議題會另外由 latestPublicThread 完整提供；原始逐字稿只保留最近四位，
    // 避免每往後一位就把整桌長篇發言再次塞進模型，造成 token 與延遲線性膨脹。
    const recent = rd.speeches.slice(-4);
    return recent.map(sp => {
      const who = U.byId(room, sp.playerId);
      const pos = rd.passOrder.indexOf(sp.playerId);
      const raw = String(sp.text || '').trim();
      return `- ${U.tag(who)}（傳遞${U.nth(pos)}）：「${raw}」`;
    }).join('\n');
  }

  // Prior rounds are public: record multi-chip commitments and stated-call mismatches explicitly.
  // Pass order is used for action position; it is not substituted with speech order.
  function publicVoteCommitmentHistory(room) {
    const out = [];
    for (let r = 0; r < (room.currentRoundIdx || 0); r++) {
      const rd = room.rounds[r];
      if (!rd || !rd.votes) continue;
      for (const [pid, ballot] of Object.entries(rd.votes)) {
        const allocations = Object.entries(ballot || {})
          .map(([beast, raw]) => ({ beast, chips: Math.max(0, Number(raw) || 0) }))
          .filter(x => x.chips > 0)
          .sort((a, b) => b.chips - a.chips);
        const dominant = allocations[0];
        const sp = (rd.speeches || []).find(x => String(x.playerId) === String(pid));
        const parsed = Claims.parseRecord
          ? Claims.parseRecord(sp, room, rd)
          : Claims.parse(String(sp && sp.text || ''), room, rd);
        const promised = parsed.voteCommitment || null;
        if (!dominant || (dominant.chips < 2 && !promised)) continue;
        const calls = [...new Set([...(parsed.callBeasts || []), parsed.callBeast].filter(Boolean))];
        const who = U.byId(room, pid);
        const pos = (rd.passOrder || []).indexOf(pid);
        const total = allocations.reduce((n, x) => n + x.chips, 0);
        const callVotes = calls.reduce((n, name) => n + Math.max(0, Number((ballot || {})[name]) || 0), 0);
        const callShare = total > 0 ? callVotes / total : 0;
        const mismatch = calls.length && callShare < 0.5;
        const promisedVotes = promised ? Math.max(0, Number((ballot || {})[promised]) || 0) : null;
        const promiseNote = promised
          ? `；本人明確承諾投${B(promised)}，實際落票 ${promisedVotes}/${total}${promisedVotes > 0 ? '（有履行）' : '（未履行）'}`
          : '';
        out.push(`第${r + 1}輪：${U.tag(who)}（傳遞${U.nth(pos)}）共投 ${total} 票，最大集中為${B(dominant.beast)} ${dominant.chips}票${promiseNote}${calls.length ? `；口頭號召${calls.map(B).join('、')}，其中 ${callVotes}/${total} 票落在號召目標${mismatch ? '（未達半數，需檢查分票理由）' : '（至少半數與號召一致）'}` : '；當輪沒有可辨識的明確號召'}。這是承諾／配置紀錄，不單憑多投就判好壞。`);
      }
    }
    return out.length ? out.slice(-8).join('\n') : '（尚無前輪多票投入紀錄）';
  }

  function publicCalls(room) {
    const out = [];
    (room.rounds || []).slice(0, room.currentRoundIdx + 1).forEach((rd, r) => {
      (rd.speeches || []).forEach(s => {
        const p = U.byId(room, s.playerId);
        const parsed = Claims.parseRecord ? Claims.parseRecord(s, room, rd) : Claims.parse(String(s.text || ''), room, rd);
        const calls = [...new Set([...(parsed.callBeasts || []), parsed.callBeast].filter(Boolean))];
        const stances = (parsed.playerStances || []).map(st => {
          const target = U.byId(room, st.targetId);
          return target ? `${U.tag(target)}${st.camp === 'evil' ? '壞人嫌疑' : '好人立場'}` : '';
        }).filter(Boolean);
        if (!calls.length && !stances.length) return;
        const claims = (parsed.claims || []).map(c => `${B(c.beast)}${c.real ? '真' : '假'}`);
        out.push(`第${r + 1}輪${p ? U.tag(p) : (s.speakerName || '玩家')}：${calls.length ? `號召投${calls.map(B).join('、')}` : ''}${claims.length ? `；宣稱${claims.join('、')}` : ''}${stances.length ? `；指向${stances.join('、')}` : ''}`);
      });
    });
    return out.length ? out.slice(-8).join('\n') : '（目前沒有可辨識的公開號召）';
  }

  function buildPublicPerformanceContract(plan, bot) {
    const target = plan && plan.beast ? '【' + plan.beast + '】' : '本輪目標';
    const bluffRole = plan && plan.roleBluff && plan.roleBluff.role ? plan.roleBluff.role : '';
    if (plan && plan.confess) {
      return '【公開表演規則：不要照讀內心計畫】你選擇公開認壞，但只承認自己是壞人陣營，不說出真正的具體角色或同伴；不得把私密查驗結果全部攤開。公開立場必須明確：' + target + '是贗品，這輪要把票推向同一尊。不可同時稱它為真品，也不可使用「票數取捨」來模糊矛盾。內部目的、私密資訊與真正動機都只是決策材料，不能直接當台詞。';
    }
    if (plan && plan.evilRolePerformance) {
      return '【公開表演規則：不要照讀內心計畫】這輪刻意公開自稱【' + bluffRole + '】，只呈現這個公開版本，不要說出自己真正角色、同伴或「我在假扮／轉移焦點」等內心話。公開立場必須明確：' + target + '是贗品，並號召把票投向同一尊。不得把同一尊同時說成真品；不得以「票數取捨」帶過相反行動。';
    }
    return '【內心計畫與公開台詞分層】真正角色、私密查驗、秘密同伴、欺騙目的、風險估計與策略理由只是內部決策材料，禁止直接照抄進台詞。台詞是經過包裝的公開表演：只說角色此刻願意公開的立場，配一個與本局具體玩家、獸首、原話或票型相關的理由，再給清楚的呼籲。避免「我要轉移焦點／隱藏身分／建立可信度／根據陣營效益／這只是戰術／票數取捨」等內心分析口吻；不要把抽象分析報告當成自然對話，也不可為了圓場捏造證據。';
  }

  function latestPublicThread(room, rd, bot = null) {
    const speeches = Array.isArray(rd && rd.speeches) ? rd.speeches : [];
    let index = -1;
    let latestIndex = -1;
    let pendingHumanIndex = -1;
    let pendingOtherIndex = -1;

    const parsePublicRecord = sp => {
      try {
        return Claims.parseRecord ? Claims.parseRecord(sp, room, rd) : Claims.parse(String(sp && sp.text || ''), room, rd);
      } catch (_) { return {}; }
    };

    const parsePublicClaims = sp => {
      let parsed = {};
      try {
        parsed = Claims.parseRecord
          ? Claims.parseRecord(sp, room, rd)
          : Claims.parse(String(sp && sp.text || ''), room, rd);
      } catch (_) {}
      return (parsed.claims || []).filter(c =>
        c && c.beast && typeof c.real === 'boolean'
      );
    };

    // Check whether a prior public beast verdict has actually been acknowledged.
    const hasUnansweredClaim = (candidateIndex, claims) => {
      if (!claims.length) return false;

      const candidate = speeches[candidateIndex];
      const player = U.byId(room, candidate.playerId);
      const tag = player ? U.tag(player) : (candidate.speakerName || '');
      const later = speeches.slice(candidateIndex + 1);

      return claims.some(c => !later.some(sp => {
        const text = String(sp && sp.text || '');
        const verdict = c.real
          ? /(?:\u771f\u54c1|\u771f\u8ca8|\u662f\u771f\u7684|\u662f\u771f)/
          : /(?:\u8d17\u54c1|\u5047\u54c1|\u5047\u8ca8|\u662f\u5047\u7684|\u662f\u5047)/;
        const acknowledgment =
          /(?:\u67e5\u9a57|\u4e3b\u5f35|\u5ba3\u7a31|\u5224\u65b7|\u539f\u8a71|\u8aaa\u6cd5|\u7acb\u5834|\u66f4\u6b63|\u56de\u61c9|\u6838\u5c0d|\u6536\u5230)/;

        return text.includes(tag) &&
          text.includes(B(c.beast)) &&
          verdict.test(text) &&
          acknowledgment.test(text);
      }));
    };

    const hasUnansweredRoleClaim = (candidateIndex, parsed = null) => {
      const candidate = speeches[candidateIndex];
      const data = parsed || parsePublicRecord(candidate);
      const roleClaims = Array.isArray(data.roleClaims) ? data.roleClaims : [];
      if (!roleClaims.length) return false;
      const player = U.byId(room, candidate.playerId);
      const speakerTag = player ? U.tag(player) : (candidate.speakerName || '');
      const later = speeches.slice(candidateIndex + 1);
      return roleClaims.some(claim => {
        const target = U.byId(room, claim.playerId);
        if (!target) return false;
        return !later.some(sp => {
          const text = String(sp && sp.text || '');
          return text.includes(speakerTag) && text.includes(U.tag(target)) && text.includes(claim.role) &&
            /(?:角色|身分|身份|指控|指認|假冒|自稱|排除|不是|對跳|回應|核對|技能)/.test(text);
        });
      });
    };

    const hasUnansweredStance = (candidateIndex, parsed = null) => {
      const candidate = speeches[candidateIndex];
      const data = parsed || parsePublicRecord(candidate);
      const stances = Array.isArray(data.playerStances) ? data.playerStances : [];
      if (!stances.length) return false;
      const player = U.byId(room, candidate.playerId);
      const speakerTag = player ? U.tag(player) : (candidate.speakerName || '');
      const later = speeches.slice(candidateIndex + 1);
      return stances.some(st => {
        const target = U.byId(room, st.targetId);
        if (!target) return false;
        return !later.some(sp => {
          const text = String(sp && sp.text || '');
          const camp = st.camp === 'evil' ? /壞人|壞人陣營|老朝奉陣營|邪方/ : /好人|好人陣營|許願陣營|善方/;
          return text.includes(speakerTag) && text.includes(U.tag(target)) && camp.test(text) &&
            /(?:立場|判斷|指控|指認|懷疑|主張|認為|回應|原話|你說|你認為)/.test(text);
        });
      });
    };

    const roleComparisonFacts = item => {
      const roles = Array.isArray(item && item.roles) ? item.roles : [];
      const defs = roles.map(roleName => ({ name: roleName, data: GD.ROLES && GD.ROLES[roleName] })).filter(x => x.data);
      const complete = defs.length === roles.length && roles.length >= 2;
      const sameCamp = complete && defs.every(x => x.data.camp === defs[0].data.camp);
      const sameSkill = complete && defs.every(x => x.data.weapon === defs[0].data.weapon);
      return {
        distinctRoleCards: complete && new Set(roles).size === roles.length,
        sameCamp,
        sameSkill,
        campText: sameCamp ? defs[0].data.campText : '',
        skillText: sameSkill ? defs[0].data.weapon : ''
      };
    };
    const comparisonIsAnswered = (text, speakerTag, item) => {
      const source = String(text || '');
      const roles = Array.isArray(item.roles) ? item.roles : [];
      const facts = item.facts || roleComparisonFacts(item);
      return source.includes(speakerTag) && roles.every(role => source.includes(role)) &&
        /(?:不同角色|兩張角色卡|分別是|並非同一|不是同一|角色不同)/.test(source) &&
        (!facts.sameCamp || source.includes(facts.campText)) &&
        (!facts.sameSkill || source.includes(facts.skillText));
    };
    const hasUnansweredRoleComparison = (candidateIndex, parsed = null) => {
      const candidate = speeches[candidateIndex];
      const data = parsed || parsePublicRecord(candidate);
      const comparisons = Array.isArray(data.roleComparisons) ? data.roleComparisons : [];
      if (!comparisons.length) return false;
      const player = U.byId(room, candidate.playerId);
      const speakerTag = player ? U.tag(player) : (candidate.speakerName || '');
      const later = speeches.slice(candidateIndex + 1);
      return comparisons.some(item => !later.some(sp => comparisonIsAnswered(sp && sp.text, speakerTag, item)));
    };
    const hasUnansweredVoteAvoids = (candidateIndex, parsed = null) => {
      const candidate = speeches[candidateIndex];
      const data = parsed || parsePublicRecord(candidate);
      const avoids = Array.isArray(data.voteAvoids) ? data.voteAvoids : [];
      if (!avoids.length) return false;
      const player = U.byId(room, candidate.playerId);
      const speakerTag = player ? U.tag(player) : (candidate.speakerName || '');
      const later = speeches.slice(candidateIndex + 1);
      return avoids.some(beast => !later.some(sp => {
        const text = String(sp && sp.text || '');
        return text.includes(speakerTag) && text.includes(B(beast)) &&
          /(?:不能投|不可投|避免投|不投|暫不投|票向限制|不採納.*票向)/.test(text);
      }));
    };

    // Scan the entire thread. A later BOT monologue must not bury an earlier human
    // accusation simply because that BOT mentioned a beast or made a separate claim.
    // Prefer the newest human speech that still has an unanswered topic; otherwise
    // fall back to the newest other speaker with an unanswered topic, then latest speech.
    for (let i = speeches.length - 1; i >= 0; i--) {
      const sp = speeches[i];
      if (!sp || !sp.playerId ||
          (bot && String(sp.playerId) === String(bot.id))) continue;
      if (latestIndex < 0) latestIndex = i;
      const parsed = parsePublicRecord(sp);
      const pending = hasUnansweredClaim(i, (parsed.claims || []).filter(c => c && c.beast && typeof c.real === 'boolean')) ||
        hasUnansweredRoleClaim(i, parsed) || hasUnansweredStance(i, parsed) || hasUnansweredRoleComparison(i, parsed) || hasUnansweredVoteAvoids(i, parsed);
      if (pending) {
        const speaker = U.byId(room, sp.playerId);
        if (speaker && !speaker.isBot) {
          if (pendingHumanIndex < 0) pendingHumanIndex = i;
        } else if (pendingOtherIndex < 0) {
          pendingOtherIndex = i;
        }
      }
    }

    index = pendingHumanIndex >= 0 ? pendingHumanIndex
      : pendingOtherIndex >= 0 ? pendingOtherIndex : latestIndex;
    if (index < 0) {
      return { speech: null, parsed: {}, tag: '', index: -1, addressed: false,
        claims: [], stances: [], directive: '【公開發言回應】本輪尚無前手發言；請根據角色已知資訊與當前局勢判斷，不要憑空下結論。' };
    }
    const speech = speeches[index];
    const player = U.byId(room, speech.playerId);
    const tag = player ? U.tag(player) : (speech.speakerName || '前手玩家');
    let parsed = {};
    try { parsed = Claims.parseRecord ? Claims.parseRecord(speech, room, rd) : Claims.parse(String(speech.text || ''), room, rd); }
    catch (_) { parsed = {}; }
    const claims = (parsed.claims || []).filter(c => c && c.beast && typeof c.real === 'boolean');
    const roleClaims = (parsed.roleClaims || []).map(item => {
      const target = item && item.playerId ? U.byId(room, item.playerId) : null;
      return target ? { ...item, target, targetTag: U.tag(target) } : null;
    }).filter(Boolean);
    const stances = (parsed.playerStances || []).map(item => {
      const target = item && item.targetId ? U.byId(room, item.targetId) : null;
      return target ? { ...item, targetTag: U.tag(target), campLabel: item.camp === 'evil' ? '壞人' : '好人' } : null;
    }).filter(Boolean);
    const roleComparisons = (parsed.roleComparisons || []).filter(item =>
      item && Array.isArray(item.roles) && item.roles.length >= 2
    ).map(item => ({ ...item, facts: roleComparisonFacts(item) }));
    const voteAvoids = [...new Set((parsed.voteAvoids || []).filter(beast =>
      (rd.beasts || []).some(current => current && current.name === beast)
    ))];
    const candidateSets = (parsed.candidateSets || []).map(group => ({
      ...group, targetTags: (group.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p))
    })).filter(group => group.targetTags.length >= 2);
    const inspectionReports = (parsed.inspectionReports || []).filter(report => report && report.round && report.beast && typeof report.claimedReal === 'boolean');
    const raw = String(speech.text || '').trim();
    const correction = claims.length > 0 && /(?:抱歉|對不起|點錯|打錯|輸入錯|誤觸|更正|修正|剛才弄錯|不小心)/.test(raw);
    const defense = !!parsed.selfDefense || /(?:我是好人|我不是壞人|不要投我|別投我|不要集火我|別把票投我|請別投我|我沒做壞事)/.test(raw);
    const call = parsed.callBeast || (parsed.callBeasts || []).find(b => (rd.beasts || []).some(x => x.name === b)) || null;
    let targetId = parsed.callSuspectId || (parsed.accuse || []).find(a => a && a.playerId)?.playerId || null;
    if (!targetId && /(?:我懷疑|我不信任|有問題的是|疑點在|值得懷疑|可疑的是|把票投給|集火|指認)/.test(raw) && Claims.mentions) {
      const mentioned = Claims.mentions(raw, room).filter(p => p && p.id !== speech.playerId);
      if (mentioned.length === 1) targetId = mentioned[0].id;
    }
    const target = targetId ? U.byId(room, targetId) : null;
    const targetTag = target ? U.tag(target) : '';
    const role = parsed.selfRole || ((raw.match(/我是(?:【)?(老朝奉|藥不然|鄭國渠|許願|方震|姬雲浮|黃煙煙|木戶加奈|平民)/) || [])[1] || null);
    const after = speeches.slice(index + 1);
    const afterBlob = after.map(sp => String(sp && sp.text || '')).join('\n');
    const hasTag = afterBlob.includes(tag);
    const correctionAddressed = correction && claims.every(c => after.some(sp => {
      const text = String(sp && sp.text || '');
      const verdict = c.real ? /(?:真品|真貨|是真的|是真)/ : /(?:贗品|假品|假貨|是假的|是假)/;
      return text.includes(tag) && text.includes(B(c.beast)) && verdict.test(text) &&
        /(?:抱歉|點錯|打錯|更正|修正|誤觸|更正後|舊句|輸入|收到|修正版本)/.test(text);
    }));
    const claimIsAddressed = c => after.some(sp => {
      const text = String(sp && sp.text || '');
      const verdict = c.real ? /(?:真品|真貨|是真的|是真)/ : /(?:贗品|假品|假貨|是假的|是假)/;
      return text.includes(tag) && text.includes(B(c.beast)) && verdict.test(text) &&
        /(?:查驗|宣稱|主張|原話|剛才|你說|判斷|納入|記下|對照|核對|不同意|一致|收到|立場|更正)/.test(text);
    });
    const claimsAddressed = claims.length > 0 && claims.every(claimIsAddressed);
    const stanceSupported = (text, st) => {
      const source = String(text || '');
      return source.includes(tag) && source.includes(st.targetTag) &&
        (st.camp === 'evil' ? /壞人|壞人陣營|老朝奉陣營|邪方/.test(source) : /好人|好人陣營|許願陣營|善方/.test(source)) &&
        /(?:剛才|你說|立場|判斷|主張|背書|回應|認為|原話|好人|壞人)/.test(source);
    };
    // A target being discussed elsewhere is not enough: the later speech must tie the stance back to the human.
    const stanceIsAddressed = st => after.some(sp => stanceSupported(String(sp && sp.text || ''), st));
    const stancesAddressed = stances.length === 0 || stances.every(stanceIsAddressed);
    const roleComparisonsAddressed = roleComparisons.length > 0 && roleComparisons.every(item =>
      after.some(sp => comparisonIsAnswered(sp && sp.text, tag, item))
    );
    const voteAvoidsAddressed = voteAvoids.length > 0 && voteAvoids.every(beast => after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && text.includes(B(beast)) &&
        /(?:不能投|不可投|避免投|不投|暫不投|票向限制|不採納.*票向|雖然.*但.*投)/.test(text);
    }));
    const defenseAddressed = defense && after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && /(?:好人|不要投|別投|投我|自辯|辯護|自稱|否認|立場|求情|防守|辯解)/.test(text);
    });
    const callAddressed = call && after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && text.includes(B(call)) && /(?:號召|建議|投|集票|跟票|票向|主張|原話|剛才)/.test(text);
    });
    const sameRoleAsBot = !!(bot && role && bot.role === role);
    const roleAddressed = role && after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && (sameRoleAsBot ? /(?:角色|身分|身份|自稱|版本|公開主張)/.test(text) : text.includes(role)) &&
        /(?:角色|自稱|身分|身份|對跳|版本|原話|剛才|主張)/.test(text);
    });
    const targetAddressed = targetTag && after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && text.includes(targetTag) && /(?:懷疑|疑點|指認|集火|質疑|指控|原話|剛才|回應)/.test(text);
    });
    const candidateSetsAddressed = candidateSets.length > 0 && candidateSets.every(group => after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && group.targetTags.every(targetTag => text.includes(targetTag)) && /(?:候選|其中一人|其中一位|之一|老朝奉|壞人)/.test(text);
    }));
    const inspectionReportsAddressed = inspectionReports.length > 0 && inspectionReports.every(report => after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && text.includes(B(report.beast)) && /(?:查驗|驗過|反轉|公開結果|開出來|真品|贗品|假貨)/.test(text);
    }));
    const roleClaimsAddressed = roleClaims.length > 0 && roleClaims.every(claim => after.some(sp => {
      const text = String(sp && sp.text || '');
      return text.includes(tag) && text.includes(claim.targetTag) && text.includes(claim.role) &&
        /(?:角色|身分|身份|指控|指認|假冒|自稱|排除|不是|對跳|回應|核對|技能)/.test(text);
    }));
    const sameTopicChecks = [];
    if (correction) sameTopicChecks.push(!!correctionAddressed);
    if (roleClaims.length) sameTopicChecks.push(!!roleClaimsAddressed);
    if (claims.length) sameTopicChecks.push(!!claimsAddressed);
    if (stances.length) sameTopicChecks.push(!!stancesAddressed);
    if (roleComparisons.length) sameTopicChecks.push(!!roleComparisonsAddressed);
    if (voteAvoids.length) sameTopicChecks.push(!!voteAvoidsAddressed);
    if (defense) sameTopicChecks.push(!!defenseAddressed);
    if (call) sameTopicChecks.push(!!callAddressed);
    if (role) sameTopicChecks.push(!!roleAddressed);
    if (targetTag) sameTopicChecks.push(!!targetAddressed);
    if (candidateSets.length) sameTopicChecks.push(!!candidateSetsAddressed);
    if (inspectionReports.length) sameTopicChecks.push(!!inspectionReportsAddressed);
    const hasRecognizedTopic = sameTopicChecks.length > 0;
    const genericAcknowledgement = hasTag && /(?:原話|這句話|你剛才|你說|你的說法|你提到|已經回應|自辯|主張|立場)/.test(afterBlob);
    const addressed = hasRecognizedTopic ? sameTopicChecks.every(Boolean) : genericAcknowledgement;
    const correctionPending = !!(correction && !correctionAddressed);
    const unanswered = {
      correction: correctionPending,
      claims: correctionPending ? claims.slice() : claims.filter(c => !claimIsAddressed(c)),
      roleClaims: roleClaimsAddressed ? [] : roleClaims,
      stances: stances.filter(st => !stanceIsAddressed(st)),
      roleComparisons: roleComparisonsAddressed ? [] : roleComparisons,
      voteAvoids: voteAvoidsAddressed ? [] : voteAvoids,
      defense: !!(defense && !defenseAddressed),
      call: call && !callAddressed ? call : null,
      role: role && !roleAddressed ? role : null,
      target: targetTag && !targetAddressed ? targetId : null,
      candidateSets: candidateSetsAddressed ? [] : candidateSets,
      inspectionReports: inspectionReportsAddressed ? [] : inspectionReports,
      raw: !hasRecognizedTopic && !genericAcknowledgement
    };

    const topics = [];
    if (unanswered.correction) {
      topics.push(`前手已明確更正或道歉，原話是「${raw}」。先承認收到更正，以最新版本為準，不得把誤觸舊句當成仍堅持的立場。`);
    }
    if (unanswered.claims.length) {
      topics.push(`你對尚未被回應的獸首主張是${unanswered.claims.map(c => `${B(c.beast)}${c.real ? '真品' : '贗品'}`).join('、')}；明確接受、反駁或暫列待驗，交代對票向的影響，不要重複已被回答的項目。`);
    }
    if (unanswered.roleClaims && unanswered.roleClaims.length) {
      unanswered.roleClaims.forEach(claim => {
        const action = claim.polarity === 'deny' ? `排除${claim.targetTag}是【${claim.role}】（不代表他就是好人）`
          : claim.polarity === 'fake' ? `指稱${claim.targetTag}是假冒【${claim.role}】`
          : `指認${claim.targetTag}是【${claim.role}】`;
        topics.push(`前手提出角色判斷：${action}；必須區分玩家姓名與角色名稱，並依技能時點及其他公開證據核對。`);
      });
    }
    if (unanswered.stances.length) {
      const stanceDetails = unanswered.stances.map(st => {
        const history = (Array.isArray(st.evidence) ? st.evidence : (st.evidence ? [st.evidence] : []))
          .filter(item => item && item.type === 'historical-vote')
          .map(item => `第${item.round}輪投${B(item.beast)}${item.votes}票`).join('、');
        return `${st.targetTag}是${st.campLabel}${history ? `（${history}）` : ''}`;
      });
      topics.push(`你另外判斷${stanceDetails.join('、')}；必須逐一回應尚未處理的人物立場，不可只答獸首。歷史票型是可核對的行為線索，但必須區分「投票行為可疑」與「已證實壞人」。`);
    }
    if (unanswered.voteAvoids && unanswered.voteAvoids.length) {
      topics.push(`前手明確主張本輪不要投${unanswered.voteAvoids.map(B).join('、')}；請說明是否採納這項票向限制及原因，若仍選擇投該獸首，必須提出能核對的獨立理由，不可假裝沒聽到。`);
    }
    if (unanswered.roleComparisons && unanswered.roleComparisons.length) {
      unanswered.roleComparisons.forEach(item => {
        const defs = item.roles.map(roleName => ({ name: roleName, data: GD.ROLES && GD.ROLES[roleName] })).filter(x => x.data);
        const sameCamp = defs.length === item.roles.length && defs.every(x => x.data.camp === defs[0].data.camp);
        const sameSkill = defs.length === item.roles.length && defs.every(x => x.data.weapon === defs[0].data.weapon);
        const details = [sameCamp ? `兩者同屬${defs[0].data.campText}` : '', sameSkill ? `技能標籤相同（${defs[0].data.weapon}）` : ''].filter(Boolean).join('，');
        topics.push(`前手問【${item.roles.join('】與【')}】是否相同；規則表列為不同角色卡。${details ? details + '，' : ''}請清楚區分「陣營／技能相同」與「角色身分相同」，直接回答這個比較問題，不可只轉談獸首。`);
      });
    }
    if (unanswered.defense) {
      topics.push('前手表示自己是好人或要求不要投他；要承認聽到這項自辯，並說明它是公開立場而不是已驗證證據。');
    }
    if (unanswered.call) {
      topics.push(`前手號召投${B(unanswered.call)}；明確說會跟票、反對或暫不跟票，並交代票差或公開證據理由。`);
    }
    if (unanswered.role) {
      topics.push(bot && bot.role === unanswered.role
        ? '前手提出了與我相同的角色版本；因不能公開說出我的真實角色名，請稱為「前手提出的角色版本」，並要求依原話與技能時點核對。'
        : `前手自稱${B(unanswered.role)}；評估這個公開承諾，指出要用哪些技能時點與原始發言核對。`);
    }
    if (unanswered.target) {
      const pendingTarget = U.byId(room, unanswered.target);
      topics.push(`前手把疑點指向${pendingTarget ? U.tag(pendingTarget) : targetTag}；正面核對這項指控的原始發言、票型與獨立依據。`);
    }
    if (unanswered.candidateSets && unanswered.candidateSets.length) {
      unanswered.candidateSets.forEach(group => topics.push(`前手提出「${group.targetTags.join('、')}之中一人是${group.role}」的候選集合；這只是其中一人的待驗假設，不可把所有候選都當成壞人，請用傳牌時序和獨立證據檢查。`));
    }
    if (unanswered.inspectionReports && unanswered.inspectionReports.length) {
      unanswered.inspectionReports.forEach(report => topics.push(`前手回報第${report.round}輪自己驗【${report.beast}】為${report.claimedReal ? '真品' : '贗品'}；請對照該輪公開結果，若相反，依該輪傳牌順序列出可能反轉區間，並說明這是公開回報而非已核實私密事實。`));
    }
    if (!topics.length) topics.push(`前手剛才的原話是「${raw}」。用一句具體話表明聽到重點，再提出能核對的判斷；不可直接說前手沒有提供資訊。`);

    const directive = addressed
      ? `【公開發言回應狀態】${tag}本輪已被後續發言實質回應；不要再複述同一組內容，接續尚未處理的新線索或提出新增證據。`
      : `【必須回應前手發言】請直接回應${tag}本輪的原話，不可改談別的事來迴避。${topics.join('')} 依內容複雜度完整說明，不限定字數；優先講清楚具體對象、證據、矛盾與自己的判斷，不要重複空泛套句。`;
    return { speech, parsed, tag, index, addressed: !!addressed, correction, defense, claims, stances, roleComparisons, voteAvoids, call, targetId, targetTag, role, unanswered, directive };
  }

  function compactPublicReply(thread, bot = null, plan = null) {
    if (!thread || !thread.speech) return '';
    const u = thread.unanswered || {
      correction: thread.correction, claims: thread.claims || [], stances: thread.stances || [],
      roleClaims: [], roleComparisons: thread.roleComparisons || [], voteAvoids: thread.voteAvoids || [],
      defense: thread.defense, call: thread.call, role: thread.role, target: thread.targetId,
      candidateSets: [], inspectionReports: []
    };
    const clauses = [];
    const withheldBeasts = new Set(
      ((plan && Array.isArray(plan.withheldClaims)) ? plan.withheldClaims : [])
        .map(c => c && c.beast).filter(Boolean)
    );
    const claims = (Array.isArray(u.claims) ? u.claims : []).filter(c => c && !withheldBeasts.has(c.beast));
    if (u.correction) clauses.push('收到更正，以你最新說法為準');
    if (claims.length) clauses.push(`你主張${claims.map(c => `${B(c.beast)}${c.real ? '真品' : '贗品'}`).join('、')}，我會納入本輪判斷`);

    const roleClaims = Array.isArray(u.roleClaims) ? u.roleClaims : [];
    if (roleClaims.length) {
      const roleText = roleClaims.map(claim =>
        `${claim.targetTag}${claim.polarity === 'deny' ? '不是' : claim.polarity === 'fake' ? '假冒' : '可能是'}【${claim.role}】`
      ).join('、');
      clauses.push(`你提出角色判斷：${roleText}；需按技能時點核對`);
    }

    const stances = Array.isArray(u.stances) ? u.stances : [];
    if (stances.length) {
      const details = stances.map(st => {
        const history = (Array.isArray(st.evidence) ? st.evidence : (st.evidence ? [st.evidence] : []))
          .filter(item => item && item.type === 'historical-vote')
          .map(item => `第${item.round}輪投${B(item.beast)}${item.votes}票`);
        return `${st.targetTag}${st.camp === 'evil' ? '壞人嫌疑' : '好人立場'}${history.length ? `（${history.join('、')}）` : ''}`;
      });
      clauses.push(`你點名${details.join('、')}；這是嫌疑，不等於定罪`);
    }

    (Array.isArray(u.roleComparisons) ? u.roleComparisons : []).forEach(item => {
      if (!item || !Array.isArray(item.roles) || item.roles.length < 2) return;
      const defs = item.roles.map(roleName => ({ name: roleName, data: GD.ROLES && GD.ROLES[roleName] }));
      const complete = defs.every(x => x.data);
      const sameCamp = complete && defs.every(x => x.data.camp === defs[0].data.camp);
      const sameSkill = complete && defs.every(x => x.data.weapon === defs[0].data.weapon);
      const facts = [
        sameCamp ? `同屬${defs[0].data.campText}` : '',
        sameSkill ? `技能標籤同為「${defs[0].data.weapon}」` : ''
      ].filter(Boolean).join('，');
      clauses.push(`${item.roles.join('與')}是不同角色卡${facts ? `，${facts}` : ''}`);
    });
    const voteAvoids = Array.isArray(u.voteAvoids) ? u.voteAvoids : [];
    if (voteAvoids.length) clauses.push(`你主張不可投${voteAvoids.map(B).join('、')}；若反向投票，我會交代理由`);
    if (u.call) clauses.push(`你號召投${B(u.call)}，我會明確表態是否跟票`);
    if (u.role && !roleClaims.some(claim => claim && claim.role === u.role)) clauses.push(`你提出【${u.role}】角色版本，應核對技能時點`);
    if (u.target && thread.targetTag && !roleClaims.some(c => c.targetTag === thread.targetTag)) clauses.push(`你把疑點指向${thread.targetTag}，我會查對票型`);
    if (u.defense) clauses.push('你的好人自辯還需要行動紀錄支持');
    (u.candidateSets || []).forEach(group => clauses.push(`${group.targetTags.join('、')}之中一人是${group.role}，不能把全員都當成壞人`));
    (u.inspectionReports || []).forEach(report => clauses.push(`你回報第${report.round}輪驗${B(report.beast)}為${report.claimedReal ? '真品' : '贗品'}，要對照傳牌時序`));

    if (!clauses.length) clauses.push('目前沒有新的公開證據，我先依查驗紀錄與票型判斷');
    const prefix = `${thread.tag}：`;
    // Preserve the highest-value topics first. Do not append the old generic "我會交叉核對" tail.
    const priority = [
      ...clauses.filter(x => /角色判斷|不同角色卡/.test(x)),
      ...clauses.filter(x => /壞人嫌疑|好人立場/.test(x)),
      ...clauses.filter(x => /不可投/.test(x)),
      ...clauses.filter(x => /贗品|真品|更正/.test(x)),
      ...clauses.filter(x => !/角色判斷|不同角色卡|壞人嫌疑|好人立場|不可投|贗品|真品|更正/.test(x))
    ];
    let body = '';
    const seen = new Set();
    for (const clause of priority) {
      if (seen.has(clause)) continue;
      seen.add(clause);
      const next = body ? `${body}；${clause}` : clause;
      body = next;
    }
    return `${prefix}${body || clauses[0]}。`;
  }

  function publicResponseAudit(text, thread, bot = null, plan = null) {
    if (!thread || !thread.speech || thread.addressed) return { ok: true };
    const u = thread.unanswered || {
      correction: thread.correction, claims: thread.claims || [], stances: thread.stances || [],
      roleComparisons: thread.roleComparisons || [], voteAvoids: thread.voteAvoids || [],
      defense: thread.defense, call: thread.call, role: thread.role, target: thread.targetId,
      raw: !(thread.claims || []).length && !(thread.stances || []).length && !thread.defense && !thread.call && !thread.role && !thread.targetTag
    };
    const s = String(text || '');
    const hasTag = s.includes(thread.tag);
    const fail = why => ({ ok: false, why });
    const checkStances = () => {
      const supported = st => hasTag && s.includes(st.targetTag) &&
        (st.camp === 'evil' ? /壞人|壞人陣營|老朝奉陣營|邪方/.test(s) : /好人|好人陣營|許願陣營|善方/.test(s));
      const missing = (u.stances || []).filter(st => !supported(st));
      return missing.length ? fail(`漏回應前手尚未被處理的人物立場：${missing.map(st => `${st.targetTag}為${st.campLabel}`).join('、')}`) : null;
    };
    if (u.correction) {
      if (!hasTag || !(u.claims || []).every(c => s.includes(B(c.beast))) ||
          !/(?:抱歉|道歉|點錯|誤點|打錯|更正|修正|誤觸|更正後|舊句|輸入錯|操作失誤|收到|承認)/.test(s)) {
        return fail('沒有正面回應前手尚未被處理的道歉／更正');
      }
    }
    if (u.claims && u.claims.length) {
      const withheldBeasts = new Set(
        ((plan && Array.isArray(plan.withheldClaims)) ? plan.withheldClaims : [])
          .map(c => c && c.beast)
          .filter(Boolean)
      );
      const hiddenClaims = u.claims.filter(c => c && withheldBeasts.has(c.beast));
      const visibleClaims = u.claims.filter(c => c && !withheldBeasts.has(c.beast));

      if (hiddenClaims.length &&
          (!hasTag || !/(?:\u6536\u5230|\u4e3b\u5f35|\u8aaa\u6cd5|\u539f\u8a71|\u6838\u5c0d|\u4f86\u6e90|\u7968\u578b|\u4fdd\u7559|\u4e0d\u91cd\u8907)/.test(s))) {
        return fail('\u4fdd\u7559\u8cc7\u8a0a\u6642\u4ecd\u9808\u56de\u61c9\u524d\u624b\u7684\u516c\u958b\u4e3b\u5f35\uff0c\u4f46\u4e0d\u5f97\u91cd\u8ff0\u88ab\u4fdd\u7559\u7684\u771f\u5047\u7d50\u679c');
      }

      if (visibleClaims.length &&
          (!hasTag ||
           !visibleClaims.every(c => s.includes(B(c.beast)) &&
             (c.real
               ? /(?:\u771f\u54c1|\u771f\u8ca8|\u662f\u771f\u7684|\u662f\u771f)/.test(s)
               : /(?:\u8d17\u54c1|\u5047\u54c1|\u5047\u8ca8|\u662f\u5047\u7684|\u662f\u5047)/.test(s))) ||
           !/(?:\u771f\u54c1|\u8d17\u54c1|\u5047\u54c1|\u771f\u5047|\u67e5\u9a57|\u4e3b\u5f35|\u5ba3\u7a31|\u5224\u65b7|\u539f\u8a71|\u8aaa\u6cd5|\u7acb\u5834|\u66f4\u6b63)/.test(s))) {
        return fail('\u6c92\u6709\u660e\u78ba\u56de\u61c9\u524d\u624b\u73a9\u5bb6\u5c1a\u672a\u88ab\u56de\u61c9\u7684\u7378\u9996\u771f\u5047\u4e3b\u5f35');
      }
    }
    for (const claim of (u.roleClaims || [])) {
      if (!hasTag || !s.includes(claim.targetTag) || !s.includes(claim.role) ||
          !/(?:角色|身分|身份|指控|指認|假冒|自稱|排除|不是|對跳|回應|核對|技能)/.test(s)) {
        return fail(`沒有正面回應前手對${claim.targetTag}的【${claim.role}】角色判斷`);
      }
    }
    for (const item of (u.roleComparisons || [])) {
      const facts = item.facts || roleComparisonFacts(item);
      if (!hasTag || !(item.roles || []).every(roleName => s.includes(roleName)) ||
          !/(?:不同角色|兩張角色卡|分別是|並非同一|不是同一|角色不同)/.test(s) ||
          (facts.sameCamp && !s.includes(facts.campText)) ||
          (facts.sameSkill && !s.includes(facts.skillText))) {
        return fail(`沒有正面回答前手對【${(item.roles || []).join('】與【')}】是否相同的問題及規則差異`);
      }
    }
    for (const beast of (u.voteAvoids || [])) {
      if (!hasTag || !s.includes(B(beast)) ||
          !/(?:不能投|不可投|避免投|不投|暫不投|票向評估|不同意.*理由|仍投.*理由)/.test(s)) {
        return fail(`沒有回應前手要求本輪不要投${B(beast)}的票向限制`);
      }
    }
    if (u.defense && (!hasTag || !/(?:好人|不要投|別投|投我|自辯|辯護|自稱|否認|立場|求情|防守|辯解|反對被投|反對被集火|不希望被投|請求|不想被投|要求大家)/.test(s))) {
      return fail('忽略前手玩家「我是好人／不要投我」的辯護');
    }
    if (u.call && (!hasTag || !s.includes(B(u.call)) || !/(?:投|號召|集票|跟票|票向|主張)/.test(s))) {
      return fail('沒有回應前手尚未被處理的落票號召');
    }
    if (u.role) {
      const sameRoleAsBot = bot && bot.role === u.role;
      if (!hasTag || !(sameRoleAsBot ? /(?:角色|身分|身份|自稱|版本|公開主張)/.test(s) : s.includes(u.role)) ||
          !/(?:角色|身分|身份|自稱|版本|技能|對跳|公開主張)/.test(s)) {
        return fail('沒有回應前手尚未被處理的公開角色主張');
      }
    }
    if (u.target && thread.targetTag && (!hasTag || !s.includes(thread.targetTag) || !/(?:懷疑|疑點|指控|指認|集火|質疑|原話|好人|壞人|認為|支持|回應)/.test(s))) {
      return fail('沒有回應前手尚未被處理的玩家指控或立場');
    }
    for (const group of (u.candidateSets || [])) {
      if (!hasTag || !(group.targetTags || []).every(targetTag => s.includes(targetTag)) || !/(?:候選|其中一人|其中一位|之一|待驗|核對)/.test(s)) {
        return fail('沒有把前手提出的複數嫌疑集合當作「其中一人」的待驗假設回應');
      }
    }
    for (const report of (u.inspectionReports || [])) {
      if (!hasTag || !s.includes(B(report.beast)) || !/(?:查驗|驗過|反轉|公開結果|開出來|時序|傳牌)/.test(s)) {
        return fail('沒有核對前手回報的歷史查驗與公開結果');
      }
    }
    const stanceFailure = checkStances();
    if (stanceFailure) return stanceFailure;
    const recognized = !!(u.correction || (u.claims || []).length || u.defense || u.call || u.role || u.target || (u.roleClaims || []).length || (u.stances || []).length || (u.roleComparisons || []).length || (u.voteAvoids || []).length || (u.candidateSets || []).length || (u.inspectionReports || []).length);
    if (!recognized && (!hasTag || !/(?:原話|這句話|你說|你提到|你的說法|表示|提到|回應|主張|立場)/.test(s))) {
      return fail('沒有正面承認並回應前手最新發言');
    }
    return { ok: true };
  }


  /* ------------------------------------------------------------------ Prompt */

  function buildPrompt(bot, room, plan, A) {
    const { ctx } = A;
    const meta = GD.Roster.byId(bot.botId) || { title: '理性推演', phrases: [] };
    const rd = ctx.rd;
    const currentBeasts = new Set((rd.beasts || []).map(beast => beast && beast.name).filter(Boolean));
    const approvedClaims = (Array.isArray(plan.claims) ? plan.claims : [])
      .filter(claim => claim && currentBeasts.has(claim.beast) && typeof claim.real === 'boolean');
    const approvedClaimText = approvedClaims.length
      ? approvedClaims.map(claim => `${B(claim.beast)}${real(claim.real)}`).join('、')
      : '本輪沒有核准公開的查驗真偽；不要自行編造查驗結果。';
    const latestPublicPrompt = latestPublicThread(room, rd, bot).directive;
    const acknowledgedAcrossRounds = (speakerId, sourceRoundNumber, predicate) => {
      const sourceIndex = Math.max(0, (Number(sourceRoundNumber) || 1) - 1);
      const sourceRound = (room.rounds || [])[sourceIndex];
      const sourceSpeeches = sourceRound && sourceRound.speeches || [];
      const sourceSpeechIndex = sourceSpeeches.findIndex(sp => sp && sp.playerId === speakerId);
      const sameRoundAfter = sourceSpeechIndex >= 0 ? sourceSpeeches.slice(sourceSpeechIndex + 1) : [];
      const laterRounds = (room.rounds || []).slice(sourceIndex + 1).flatMap(historyRound => historyRound && historyRound.speeches || []);
      return sameRoundAfter.concat(laterRounds).some(sp => sp && sp.playerId !== speakerId && predicate(String(sp.text || ''), sp));
    };
    const crossRoundPublicTopics = [];
    (A.publicCandidateGroups || []).forEach(group => {
      const speaker = U.byId(room, group.speakerId);
      const speakerTag = speaker ? U.tag(speaker) : (group.speakerName || '前手玩家');
      const tags = (group.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));
      const alreadyAddressed = acknowledgedAcrossRounds(group.speakerId, group.speechRound, text =>
        text.includes(speakerTag) && tags.every(tag => text.includes(tag)) && /(?:候選|其中一人|其中一位|之一|老朝奉|壞人)/.test(text)
      );
      if (!alreadyAddressed && tags.length >= 2) crossRoundPublicTopics.push(
        `第${group.speechRound}輪${speakerTag}公開提出${tags.join('、')}之中一人是${group.role}；這是玩家提出的待驗假設，不代表每個候選都可疑。請核對傳牌順序、公開矛盾和獨立證據，可以同意也可以反駁。`
      );
    });
    (A.publicReportedFlipPools || []).forEach(pool => {
      const speaker = U.byId(room, pool.speakerId);
      const speakerTag = speaker ? U.tag(speaker) : (pool.speakerName || '前手玩家');
      const tags = (pool.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));
      const alreadyAddressed = acknowledgedAcrossRounds(pool.speakerId, pool.speechRound, text =>
        text.includes(speakerTag) && text.includes(B(pool.beast)) && /(?:反轉|公開結果|開出來|傳牌順序|前置候選)/.test(text)
      );
      if (!alreadyAddressed && tags.length) crossRoundPublicTopics.push(
        `第${pool.reportRound}輪${speakerTag}公開回報自己驗【${pool.beast}】為${pool.claimedReal ? '真品' : '贗品'}，但公開結果為${pool.revealedReal ? '真品' : '贗品'}；依當輪傳牌順序，${tags.join('、')}是待驗的前置候選。這只代表公開說法與結果有落差，不是已證實私密查驗，也不能單憑此事定罪。`
      );
    });
    const crossRoundPublicPrompt = crossRoundPublicTopics.length ? crossRoundPublicTopics.join('\n') : '沒有尚未被回應的跨輪公開推理。';
    const hasPriorSpeech = Array.isArray(rd.speeches) && rd.speeches.some(sp => sp && sp.playerId !== bot.id);

    // This is deliberately a public-facing brief. Do not add bot.role, ctx.isGood,
    // ctx.partner, ctx.log.inspect, private Fang scans, A.prof/A.post, plan.why,
    // hidden role-swap/ambush metadata, inferred allies, or tactical scoring here.
    let publicIdentity = '本輪不需要主動宣稱具體角色；只表達已核准的公開立場。';
    if (plan.fakeFangClaim) {
      const target = U.byId(room, plan.fakeFangClaim.targetId);
      publicIdentity = target
        ? `本輪對外身分說法：我是方震；對${U.tag(target)}的公開陣營判斷是${plan.fakeFangClaim.isGoodCamp ? '好人' : '壞人'}。`
        : '本輪不提出角色身分主張。';
    } else if (plan.roleBluff && plan.roleBluff.role) {
      publicIdentity = `本輪對外身分說法：我是【${plan.roleBluff.role}】。`;
    } else if (plan.trueRoleSignal && plan.trueRoleSignal.line) {
      publicIdentity = `可以自然使用這句公開提示一次：「${plan.trueRoleSignal.line}」。不要補充未核准的角色能力或查驗細節。`;
    }

    const publicObjectives = [];
    if (plan.confess) {
      publicObjectives.push(`公開承認「我認壞」，但不說具體角色或同伴。明確主張【${plan.beast}】是贗品，並號召投向同一尊。`);
    } else if (plan.evilRolePerformance) {
      publicObjectives.push(`依對外身分說法自然發言；明確主張【${plan.beast}】是贗品，並號召投向同一尊。不要透露這是偽裝。`);
    } else {
      publicObjectives.push(`依核准的公開立場發言：${approvedClaimText}`);
      publicObjectives.push(`本輪主要公開票向是【${plan.beast}】；用一個具體、可由全桌核對的理由說明，不要把內部計算當作理由。`);
    }

    const extra = [
      plan.laoTimingAudit ? '擾亂技能時序規則：技能是否能影響查驗，只看本輪傳牌順位（passOrder）；公開發言順序（speechOrder）只決定誰先說話，所有傳牌行動完成後才進入公開發言。不可因某人較晚發言就推斷技能尚未使用；也不可因本輪沒有確認反轉就排除老朝奉，必須保留「未啟動／刻意保留技能／證據不足」等假設。' : '',
      (plan.consensusAudit || []).map(group => `公開共識拆解：${B(group.beast)}${real(group.real)}目前有${group.speakerCount}人提出；其中${group.selfReportedDirect}人自稱親查、${group.inference}人明說推論、${group.echo}人屬附和、${group.unattributed}人未交代來源、${group.limitedView}人視野受限。自稱親查仍是公開自述，不等於系統驗證；重複主張不可當成同數量的獨立證據。請自然點出這個差異，不要直接否定真偽結論。`).join(' ') ,
      plan.explain ? `${plan.explain.callerName}請你說明過去把票投在贗品上的原因。只引用當時可見的公開發言和實際票數；不要補寫不存在的理由。` : '',
      plan.askId ? (() => {
        const target = U.byId(room, plan.askId);
        return target ? `請簡短點名${U.tag(target)}，詢問他過去投給後來公開判為贗品的獸首共 ${plan.askVotes} 票（最近一次第 ${plan.askRound} 輪投【${plan.askBeast}】）的依據。這是事後對照，不代表他投票時已知道結果。` : '';
      })() : '',
      plan.xuYuanLine ? `可以自然使用這句公開話術一次：「${plan.xuYuanLine}」。不要藉此暗示其他未核准的查驗結果。` : '',
      plan.withholdInfo ? '只陳述上方列出的核准公開結果，不得自行增加其他獸首的真偽宣稱。' : '',
      plan.followHuman ? `可以回應${plan.followHuman.callerName}的公開主張，並說明是否支持。` : '',
      plan.publicRolePressure ? (() => { const speaker = U.byId(room, plan.publicRolePressure.speakerId); const speakerTag = speaker ? U.tag(speaker) : plan.publicRolePressure.speakerName; return `前手${speakerTag}把你指為【${plan.publicRolePressure.role}】（${plan.publicRolePressure.polarity === 'fake' ? '假冒指控' : '角色指認'}）。必須直接回應：指出這項角色判斷尚缺哪些可核對的技能時點；若你有核准的角色偽裝版本，可明確對跳；不可假裝這項指控沒有發生。`; })() : '',
      plan.roleBluff && plan.roleBluff.motive === 'protect_pressured_ally' && plan.roleBluff.protectedAllyId ? (() => { const ally = U.byId(room, plan.roleBluff.protectedAllyId); return ally ? `目前${U.tag(ally)}正在承受公開質疑。你的角色主張必須有自然的公開理由：要求大家先核對對方被指控的技能時點、行動和票型，再決定是否集火。不要說自己在保護盟友、假跳或轉移焦點，也不要只丟下一句身分宣稱。` : ''; })() : '',
      plan.counterAccuseId ? (() => { const target = U.byId(room, plan.counterAccuseId); return target ? `可以反問${U.tag(target)}提出這項角色指控的公開依據；若要反指對方帶風向，只能引用其實際發言，不可捏造私密資訊。` : ''; })() : '',
      plan.suspectId ? (() => { const target = U.byId(room, plan.suspectId); return target ? `可以提出對${U.tag(target)}的公開疑問，但必須依據本輪已公開的發言或票型。` : ''; })() : '',
      plan.ambushFrameHypothesis ? (() => {
        const first = U.byId(room, plan.ambushFrameHypothesis.firstId);
        const second = U.byId(room, plan.ambushFrameHypothesis.secondId);
        return first && second
          ? `若要提出時序推測，只能說第一位${U.tag(first)}可能是藥不然、第二位${U.tag(second)}可能是老朝奉；必須明說這只是待驗假設，不是已確認身分。`
          : '';
      })() : ''
    ].filter(Boolean);

    const task = plan.confess
      ? [
          '1. 用自然口語承認「我認壞」，不要交代真正角色、同伴或私下盤算。',
          `2. 清楚說【${plan.beast}】是贗品，並把自己的主要票向放在同一尊。`,
          `3. 號召大家投【${plan.beast}】；不得同時稱它為真品，也不得用票差或分票說法掩蓋相反行動。`
        ]
      : plan.evilRolePerformance
      ? [
          `1. 自然維持公開身分說法「我是${plan.roleBluff && plan.roleBluff.role || ''}」，不要說自己在假扮。`,
          `2. 清楚說【${plan.beast}】是贗品，並把自己的主要票向放在同一尊。`,
          `3. 號召大家投【${plan.beast}】；其餘籌碼可以合理分配，但這尊必須是主票方向。`
        ]
      : [
          '1. 若有前手發言，優先回應最近一位尚未被回應的玩家；若你是第一位發言，不要假裝有人先說過話。',
          '2. 依重要性處理仍未解決的議題；若有多項彼此相關的證據或指控，可以一併說明，不必湊固定項目。若沒有核准查驗，就用公開發言、票型或時序提出明確標示為推測的看法。',
          `3. 明確說明本輪為何把主要票向放在【${plan.beast}】，不要只講抽象原則。`
        ];

    return [
      `你正在玩《古董局中局》八人桌遊。請以第一人稱產生第 ${ctx.t + 1} 輪自然口語發言，使用繁體中文。發言長短依本輪證據與議題複雜度決定，不限定字數或句數；不要為了短而省略關鍵推理，也不要為了顯得完整而重複空話。只輸出台詞，不要加引號或說明。`,
      '',
      `[玩家與公開人設]`,
      `你是${U.tag(bot)}；說話風格：${meta.title || '理性推演'}。自然、具體，避免重複固定口頭禪。`,
      `本輪傳遞順位：${U.nth(ctx.myPos)}。場上獸首：${(rd.beasts || []).map(beast => B(beast.name)).join('、')}。`,
      '',
      '[本輪允許對外表達的內容]',
      publicIdentity,
      `核准公開判斷：${approvedClaimText}`,
      ...publicObjectives,
      plan.publicSuspectBrief ? `終局嫌疑盤點（推測，非已證實）：${plan.publicSuspectBrief}；若採用，只講一次，不得把陣營查驗等同老朝奉身分。` : '',
      '',
      '[本輪公開發言與公開紀錄]',
      '原話：以下均為玩家公開發言的逐字原文；引用時必須保留原發言者與上下文，不得把系統摘要當成玩家說過的話。',
      priorSpeeches(room),
      latestPublicPrompt,
      `[跨輪公開推理／待驗證，不是真實角色或私密查驗事實]\n${crossRoundPublicPrompt}`,
      `公開號召索引（只看已公開的發言）：\n${publicCalls(room)}`,
      `過往多票配置（只看已結算的實際票單）：\n${publicVoteCommitmentHistory(room)}`,
      `歷史開票真偽：\n${history(room)}`,
      '',
      '[發言任務]',
      ...task,
      ...extra,
      '',
      '[自然對話規則]',
      hasPriorSpeech
        ? '要回應前手時，點出具體玩家、他說過的獸首／立場或票數；可以反駁，不必附和。不要重述已被其他人完整回應的同一話題。'
        : '目前沒有可回應的前手發言。直接提出自己的本輪立場，不要虛構玩家原話或指控。',
      '台詞必須像玩家在桌上說話，不像系統報告。先講清楚主結論，再依需要提出足以支撐判斷的證據，不限制證據項目數；若證據不足，就明說還要觀察本輪票型、傳牌順序或其他人的發言。禁止只說收到、聽到或記下等空泛承接句；直接說支持或反對誰、哪項證據、主票投哪尊。',
      '內部思考與公開台詞是兩件事：真正角色、陣營、秘密同伴、私密查驗、推理機率、風險估計、騙人目的和戰術盤算，無論真假都不得照讀。只把策略轉成符合當前公開立場的自然說法；不要說「我在轉移焦點」「建立可信度」「隱藏身分」「這是我的偽裝策略」等內心話。',
      '引用他人原話時必須能在上方公開發言找到；自己的推測要說「我懷疑／我推測」，不可冒充歷史事實。不要編造沒有發生的查驗、技能或票數。',
      '多票可分配；公開號召是主要票向。若分票，只用一句說明原因，不必重複呼籲。',
      buildPublicPerformanceContract(plan, bot),
      '獸首一律使用【】標示。只可對本輪出現的獸首提出本輪真偽判斷；回顧前輪時要明確說明是歷史紀錄。'
    ].filter(Boolean).join('\n');
  }

  /* ------------------------------------------------------------------
   * 跨回合公開證據鏈：只讀取已結算的公開第二名結果、當輪公開宣稱與投票。
   * 不讀取其他 Bot 的私密 mind，也不把重複引用當成新增證據。
   * ------------------------------------------------------------------ */
  function buildCrossRoundEvidence(room, bot, ctx) {
    if (!room || !Array.isArray(room.rounds) || !ctx || !Number.isInteger(ctx.t) || ctx.t < 1) return '';

    const exposed = [];
    const contradictions = new Map();
    const consistentClaims = new Map();
    const fakeVotes = new Map();
    const end = Math.min(ctx.t, room.rounds.length);

    for (let ri = 0; ri < end; ri++) {
      const rd = room.rounds[ri];
      const rank = rd && rd.voteResults && rd.voteResults.rank2;
      if (!rank || !rank.name || typeof rank.isReal !== 'boolean') continue;

      const roundNo = Number.isInteger(rd.roundNum) ? rd.roundNum : ri + 1;
      exposed.push({ round: roundNo, beast: rank.name, real: rank.isReal });

      // 與已揭露結果相反的公開宣稱，是可驗證的矛盾；同一玩家同輪同獸首只記一次。
      (rd.speeches || []).forEach(sp => {
        if (!sp || !sp.playerId || sp.playerId === bot.id) return;
        let claims = [];
        if (typeof Claims !== 'undefined' && Claims && typeof Claims.parseRecord === 'function') {
          try { claims = Claims.parseRecord(sp, room, rd).claims || []; }
          catch (_) { claims = []; }
        } else if (Array.isArray(sp.p && sp.p.claims) && sp.p.claims.length) {
          claims = sp.p.claims;
        } else if (typeof Claims !== 'undefined' && Claims && typeof Claims.parse === 'function') {
          try { claims = (Claims.parse(String(sp.text || ''), room, rd).claims || []); }
          catch (_) { claims = []; }
        }
        claims = Array.isArray(claims) ? claims : [];
        const conflict = claims.find(c => c && c.beast === rank.name &&
          typeof c.real === 'boolean' && c.real !== rank.isReal);
        const aligned = claims.find(c => c && c.beast === rank.name &&
          typeof c.real === 'boolean' && c.real === rank.isReal);

        // 有矛盾的同輪宣稱優先記為矛盾，不同時把同一玩家算成吻合。
        if (conflict) {
          const key = String(sp.playerId);
          if (!contradictions.has(key)) {
            contradictions.set(key, { playerId: sp.playerId, player: U.byId(room, sp.playerId), events: [] });
          }
          const group = contradictions.get(key);
          const eventKey = `${roundNo}|${rank.name}`;
          if (!group.events.some(e => e.key === eventKey)) {
            group.events.push({ key: eventKey, round: roundNo, beast: rank.name,
              claimedReal: conflict.real, openedReal: rank.isReal });
          }
          return;
        }

        if (!aligned) return;
        const key = String(sp.playerId);
        if (!consistentClaims.has(key)) {
          consistentClaims.set(key, { playerId: sp.playerId, player: U.byId(room, sp.playerId), events: [] });
        }
        const group = consistentClaims.get(key);
        const eventKey = `${roundNo}|${rank.name}`;
        if (!group.events.some(e => e.key === eventKey)) {
          group.events.push({ key: eventKey, round: roundNo, beast: rank.name,
            claimedReal: aligned.real, openedReal: rank.isReal });
        }
      });

      // 票投向後來公開為贗品的獸首，只是可核對的行為線索，不單獨作為定罪依據。
      if (rank.isReal === false) {
        Object.entries(rd.votes || {}).forEach(([pid, ballot]) => {
          if (!pid || pid === bot.id) return;
          const count = Number((ballot || {})[rank.name]) || 0;
          if (count <= 0) return;
          if (!fakeVotes.has(pid)) {
            fakeVotes.set(pid, { playerId: pid, player: U.byId(room, pid), total: 0, events: [] });
          }
          const group = fakeVotes.get(pid);
          group.total += count;
          group.events.push({ round: roundNo, beast: rank.name, count });
        });
      }
    }

    if (!exposed.length) return '';

    const seedText = `${bot && (bot.botId || bot.id || bot.name) || 'bot'}:${ctx.t}`;
    let seed = 2166136261;
    for (const ch of seedText) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
    seed >>>= 0;
    const chooseAmongTop = (items, limit) => {
      const pool = items.slice(0, Math.min(limit, items.length));
      return pool.length ? pool[seed % pool.length] : null;
    };

    const conflictGroups = [...contradictions.values()]
      .filter(g => g.player && g.events.length)
      .sort((a, b) => b.events.length - a.events.length ||
        Math.max(...b.events.map(e => e.round)) - Math.max(...a.events.map(e => e.round)));

    const consistentGroups = [...consistentClaims.values()]
      .filter(g => g.player && g.events.length)
      .sort((a, b) => b.events.length - a.events.length ||
        Math.max(...b.events.map(e => e.round)) - Math.max(...a.events.map(e => e.round)));
    const alignedGroup = chooseAmongTop(consistentGroups, 3);
    const alignedEvent = alignedGroup
      ? alignedGroup.events.slice().sort((a, b) => a.round - b.round).slice(-1)[0]
      : null;
    const consistencyLine = alignedEvent
      ? `${U.tag(alignedGroup.player)}在第${alignedEvent.round}輪宣稱【${alignedEvent.beast}】${alignedEvent.claimedReal ? '真品' : '贗品'}，與該輪公開結果一致`
      : '';

    if (conflictGroups.length) {
      const chosen = chooseAmongTop(conflictGroups, 3);
      const details = chosen.events.slice().sort((a, b) => a.round - b.round).slice(-2).map(e =>
        `第${e.round}輪${U.tag(chosen.player)}宣稱【${e.beast}】${e.claimedReal ? '真品' : '贗品'}，但該輪公開開出的結果是${e.openedReal ? '真品' : '贗品'}`
      );
      const total = chosen.events.length;
      return `跨輪證據鏈：${details.join('；')}。${consistencyLine ? `另有吻合紀錄：${consistencyLine}。` : ''}${total >= 2 ? `這類矛盾累計出現 ${total} 次，` : ''}我會再對照其他輪宣稱與投票，將矛盾列為疑點，但不只憑單一矛盾定案。`;
    }

    const voteGroups = [...fakeVotes.values()]
      .filter(g => g.player && g.events.length)
      .sort((a, b) => b.total - a.total || b.events.length - a.events.length ||
        Math.max(...b.events.map(e => e.round)) - Math.max(...a.events.map(e => e.round)));

    if (voteGroups.length) {
      const chosen = chooseAmongTop(voteGroups, 3);
      const details = chosen.events.slice().sort((a, b) => a.round - b.round).slice(-2).map(e =>
        `第${e.round}輪公開結果後來顯示【${e.beast}】是贗品，而${U.tag(chosen.player)}在開票前投了 ${e.count} 票給它`
      );
      return `跨輪票型對照：${details.join('；')}。${consistencyLine ? `另有吻合紀錄：${consistencyLine}。` : ''}這可能是判斷失誤，也值得與當輪宣稱及其他票型比對；單次投票本身不足以判定身分。`;
    }

    const recent = exposed.slice(-2);
    const facts = recent.map(e => `第${e.round}輪公開開出的【${e.beast}】是${e.real ? '真品' : '贗品'}`);
    return `跨輪公開結果對照：${facts.join('；')}。${consistencyLine ? `另有吻合紀錄：${consistencyLine}。` : ''}我會將這些已揭露結果與各輪宣稱、票型逐一對照；同一項結果被重複提起，不算額外的獨立證據。`;
  }
  function publicSuspectLine(topSuspect, ctx, alreadyBuiltParts = []) {
    const target = topSuspect && topSuspect.player;
    if (!target) return '';
    const visibleSpeeches = Array.isArray(ctx.room?.rounds)
      ? ctx.room.rounds.slice(0, Math.max(0, Number(ctx.t) || 0) + 1)
        .flatMap(rd => Array.isArray(rd && rd.speeches) ? rd.speeches : [])
      : (ctx.rd?.speeches || []);
    const priorTexts = [
      ...visibleSpeeches.map(sp => String(sp && sp.text || '')),
      ...(Array.isArray(alreadyBuiltParts) ? alreadyBuiltParts.map(part => String(part || '')) : [])
    ];
    const normalizeEvidence = s => String(s || '').replace(/[\s。！？；，、：]/g, '');
    const beastNamesInEvidence = s => [...String(s || '').matchAll(/【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】/g)].map(m => m[1]);
    const evidenceAlreadySpoken = s => {
      const candidate = String(s || '').trim();
      const normalized = normalizeEvidence(candidate);
      if (!normalized) return true;
      if (priorTexts.some(text => normalizeEvidence(text).includes(normalized))) return true;
      const targetTag = U.tag(target);
      if (!candidate.includes(targetTag)) return false;
      const beasts = beastNamesInEvidence(candidate);
      const fakeVoteEvidence = /(?:後來公開判為贗品|已公開的贗品|投給.*贗品|贗品.*票|票.*贗品|高票第一名|壓過真品|票灌在|累計.*票)/.test(candidate);
      if (fakeVoteEvidence && beasts.length) {
        const sameVoteClue = /(?:後來公開判為贗品|已公開的贗品|投給.*贗品|贗品.*票|票.*贗品|投了\s*\d+\s*票|累計.*票|過去投給)/;
        if (priorTexts.some(text => text.includes(targetTag) && sameVoteClue.test(text) &&
            beasts.some(beast => text.includes(`【${beast}】`)))) return true;
      }
      const focusMatch = candidate.match(/(?:曾號召大家集火|號召大家集火|號召全場集火)(.+?)(?:[。；，！]|$)/);
      if (focusMatch) {
        const focus = normalizeEvidence(focusMatch[1]);
        return priorTexts.some(text => text.includes(targetTag) &&
          /(?:曾號召大家集火|號召大家集火|號召全場集火)/.test(text) &&
          (!focus || normalizeEvidence(text).includes(focus)));
      }
      return false;
    };
    const raw = Array.isArray(topSuspect.said)
      ? topSuspect.said.find(s => typeof s === 'string' && s.trim() && !evidenceAlreadySpoken(s))
      : '';
    const internalOnly = /指控者可信度|獨立證據加權|跨輪時序交集|老朝奉反轉區間|秘密同伴|親手查驗確認.*陣營|私密查驗|內部權重|時序上最像開了擾亂|世界線推演|機率推演|候選池/.test(String(raw || ''));
    if (raw && !internalOnly) {
      const clean = String(raw).trim().replace(/[。！？；]+$/, '');
      return `${clean}。${ctx.isGood
        ? '這項懷疑仍需要其他公開線索印證，我不會只因為有人號召集火就定案。'
        : '大家先別急著跟票，還要看其他人的公開說法是否一致。'}`;
    }
    return ctx.isGood
      ? `我目前對${U.tag(target)}的公開行動仍有疑問，但現有證據還不足以定案。`
      : `我對${U.tag(target)}的公開行動保留疑問，先核對紀錄再決定是否跟票。`;
  }
  /* ------------------------------------------------------------------ 本地備援發言 */

  function localSpeech(bot, room, plan, A) {
    const { ctx } = A;
    
    const parts = [];
    const pos = U.nth(ctx.myPos);
    const sameRoundSpeeches = Array.isArray(ctx.rd?.speeches) ? ctx.rd.speeches : [];
    const speechFingerprint = sameRoundSpeeches.map(s => { const speaker = s && U.byId(room, s.playerId); const stableId = speaker ? (speaker.botId || speaker.name || speaker.id) : (s && s.speakerName || 'unknown'); return `${stableId}:${String(s && s.text || '').slice(0, 48)}`; }).join('|');
    const dialogueSeedText = `${room.roomId || room.id || ''}:${bot.botId || bot.id || bot.name || ''}:${ctx.t}:${ctx.myPos}:${speechFingerprint}`;
    const dialogueSeed = GD.DialogueBank ? GD.DialogueBank.hash(dialogueSeedText) : [...dialogueSeedText].reduce(
      (hash, ch) => Math.imul(hash ^ ch.charCodeAt(0), 16777619), 2166136261
    ) >>> 0;
    const choosePhrase = options => options[dialogueSeed % options.length];
    const freshPickLine = (category, seed, vars = {}) => {
      const seen = (room.rounds || []).slice(Math.max(0, ctx.t - 2), ctx.t + 1).flatMap(historyRound =>
        (historyRound && historyRound.speeches || []).map(sp => String(sp && sp.text || '')));
      seen.push(...parts);
      return GD.DialogueBank && GD.DialogueBank.pickFresh
        ? GD.DialogueBank.pickFresh(category, seed, vars, seen)
        : GD.DialogueBank.pick(category, seed, vars);
    };
    const passOrder = Array.isArray(ctx.rd?.passOrder) ? ctx.rd.passOrder : [];
    const speechOrder = Array.isArray(ctx.rd?.speechOrder) && ctx.rd.speechOrder.length
      ? ctx.rd.speechOrder
      : null;
    const priorSpeeches = sameRoundSpeeches
      .map((s, storedIndex) => ({
        speech: s,
        position: speechOrder ? speechOrder.indexOf(s && s.playerId) : storedIndex
      }))
      .filter(item => item.position >= 0 &&
        item.speech.playerId !== bot.id &&
        (!speechOrder || item.position < speechOrder.indexOf(bot.id)))
      .sort((a, b) => b.position - a.position)
      .map(item => item.speech);
    const lastPriorSpeech = priorSpeeches[0] || null;
    const parsePriorForThread = speech => {
      try {
        if (Claims.parseRecord) return Claims.parseRecord(speech, room, ctx.rd) || {};
        return Claims.parse(String(speech && speech.text || ''), room, ctx.rd) || {};
      } catch (_) { return {}; }
    };
    const publicThreadForSpeech = latestPublicThread(room, ctx.rd, bot);
    const lastPublicSpeaker = publicThreadForSpeech.speech && !publicThreadForSpeech.addressed
      ? publicThreadForSpeech.speech : null;
    let teamResponseLine = '';
    let publicResponseLine = '';
    let lastPublicClaimForResponse = null;
    let lastPublicLabelForResponse = '';
    const addTeamResponse = (speakerId, speakerLabel, claim) => {
      if (!claim || !plan.beast) return;
      // 只用已核准公開的自家宣稱回應前手；未公開的私密查驗不得成為台詞依據。
      const ownClaim = (plan.claims || []).find(c => c && c.beast === claim.beast && typeof c.real === 'boolean');
      const responseSpeaker = U.byId(room, speakerId);
      const stableSpeakerId = responseSpeaker ? (responseSpeaker.botId || responseSpeaker.name || responseSpeaker.id) : speakerLabel;
      const lineSeed = GD.DialogueBank.hash(`${dialogueSeedText}:team-response:${stableSpeakerId}:${claim.beast}:${claim.real}:${plan.beast}`);
      const verdict = claim.real ? '真品' : '贗品';
      const options = ownClaim
        ? ownClaim.real === claim.real
          ? [
              `${speakerLabel}剛才說【${claim.beast}】是${verdict}，這和我公開的判斷一致。`,
              `你把【${claim.beast}】判為${verdict}，這點跟我目前的立場相同。`
            ]
          : [
              `${speakerLabel}認為【${claim.beast}】是${verdict}，但我的公開判斷不同；開票後就能對照。`,
              `你主張【${claim.beast}】是${verdict}，但我的公開判斷不同；先保留各自的理由。`
            ]
        : [
            `${speakerLabel}說【${claim.beast}】是${verdict}，我先記下這個判斷，還要看其他公開線索。`,
            `你主張【${claim.beast}】；我暫時不只憑這一句改變票向。`
          ];
      teamResponseLine = options[lineSeed % options.length];
      if (lastPublicSpeaker && String(lastPublicSpeaker.playerId) === String(speakerId)) publicResponseLine = teamResponseLine;
      parts.push(teamResponseLine);
    };
    if (lastPublicSpeaker) {
      const humanPlayer = lastPublicSpeaker.playerId ? U.byId(room, lastPublicSpeaker.playerId) : null;
      const humanLabel = humanPlayer ? U.tag(humanPlayer) : (lastPublicSpeaker.speakerName || '前手玩家玩家');
      const humanTextForResponse = String(lastPublicSpeaker.text || '');
      const parsedHumanText = Claims.parse(humanTextForResponse, room, ctx.rd);
      const humanParsed = Claims.parseRecord ? Claims.parseRecord(lastPublicSpeaker, room, ctx.rd)
        : (lastPublicSpeaker.p && typeof lastPublicSpeaker.p === 'object' ? lastPublicSpeaker.p : parsedHumanText);
      const unresolved = publicThreadForSpeech && publicThreadForSpeech.unanswered || {};
      const allHumanClaims = (humanParsed.claims || []).filter(c => c && c.beast && typeof c.real === 'boolean');
      const humanClaims = Array.isArray(unresolved.claims) ? unresolved.claims : allHumanClaims;
      const stanceSource = Array.isArray(unresolved.stances) ? unresolved.stances : (humanParsed.playerStances || []);
      const humanStances = stanceSource.map(st => {
        const target = U.byId(room, st.targetId);
        return target ? { ...st, target, tag: U.tag(target), label: st.camp === 'evil' ? '壞人' : '好人' } : null;
      }).filter(Boolean);
      const humanCorrection = unresolved.correction !== undefined
        ? !!unresolved.correction
        : allHumanClaims.length > 0 && /(?:抱歉|對不起|點錯|打錯|輸入錯|誤觸|更正|修正|剛才弄錯|不小心|操作失誤|誤點)/.test(humanTextForResponse);
      const humanDefense = unresolved.defense === true ||
        !!humanParsed.selfDefense ||
        /(?:\u6211\u662f\u597d\u4eba|\u6211\u4e0d\u662f\u58de\u4eba|\u4e0d\u8981\u6295\u6211|\u5225\u6295\u6211|\u4e0d\u8981\u96c6\u706b\u6211|\u5225\u628a\u7968\u6295\u6211|\u8acb\u5225\u6295\u6211|\u6211\u6c92\u505a\u58de\u4e8b)/.test(humanTextForResponse)
      const rawRoleClaim = humanParsed.selfRole || ((humanTextForResponse.match(/我是(?:【)?(老朝奉|藥不然|鄭國渠|許願|方震|姬雲浮|黃煙煙|木戶加奈|平民)/) || [])[1] || null);
      const humanRoleClaim = unresolved.role ? rawRoleClaim : null;
      const humanCall = unresolved.call || null;
      let humanTargetId = unresolved.target || null;
      if (!unresolved.target && !('target' in unresolved) && !humanTargetId && /(?:我懷疑|我不信任|有問題的是|疑點在|值得懷疑|可疑的是|把票投給|集火|指認)/.test(humanTextForResponse) && Claims.mentions) {
        const mentioned = Claims.mentions(humanTextForResponse, room).filter(p => p && p.id !== lastPublicSpeaker.playerId);
        if (mentioned.length === 1) humanTargetId = mentioned[0].id;
      }
      const humanTarget = humanTargetId ? U.byId(room, humanTargetId) : null;
      const mainClaim = humanClaims.find(c => c.beast === plan.beast) || humanClaims[0] || null;
      if (mainClaim) {
        lastPublicClaimForResponse = mainClaim;
        lastPublicLabelForResponse = humanLabel;
        const ownClaim = (plan.claims || []).find(c => c && c.beast === mainClaim.beast && typeof c.real === 'boolean');
        const verdict = mainClaim.real ? '真品' : '贗品';
        const responseOptions = ownClaim
          ? ownClaim.real === mainClaim.real
            ? [
                `${humanLabel}剛才說【${mainClaim.beast}】是${verdict}，這和我公開的判斷一致。`,
                `${humanLabel}認為【${mainClaim.beast}】是${verdict}，這和我公開的判斷一致。`
              ]
            : [
                `${humanLabel}認為【${mainClaim.beast}】是${verdict}，但我的公開判斷不同；開票後可以直接對照。`,
                `${humanLabel}認為【${mainClaim.beast}】是${verdict}，但我的公開判斷不同；開票後可以對照。`
              ]
          : [
              `${humanLabel}剛才說【${mainClaim.beast}】是${verdict}；但我還要看其他線索能否印證。`,
              `${humanLabel}剛才提到【${mainClaim.beast}】；我還要看其他線索能否印證。`
            ];
        const claimSeed = GD.DialogueBank.hash(`${dialogueSeedText}:human-claim:${humanPlayer && (humanPlayer.botId || humanPlayer.id) || humanLabel}:${humanClaims.map(c => `${c.beast}:${c.real}`).join(',')}:${humanCorrection ? 'correction' : 'normal'}`);
        publicResponseLine = responseOptions[claimSeed % responseOptions.length];
        parts.push(publicResponseLine);
        const additionalClaims = humanClaims.filter(c => c !== mainClaim);
        const visibleAdditionalClaims = additionalClaims.filter(c =>
          !(plan.withheldClaims || []).some(hidden => hidden && hidden.beast === c.beast)
        );
        if (visibleAdditionalClaims.length) {
          const detail = visibleAdditionalClaims.map(c => B(c.beast)).join('\u3001');
          parts.push(`\u53e6\u5916${humanLabel}\u4e5f\u63d0\u5230${detail}\uff0c\u6211\u6703\u5206\u958b\u770b\uff0c\u4e0d\u6703\u53ea\u56e0\u70ba\u4f60\u5148\u4e0b\u7d50\u8ad6\u5c31\u76f4\u63a5\u8ddf\u8457\u5224\u3002`);
        } else if (additionalClaims.length) {
          parts.push('\u53e6\u5916\u4e5f\u6536\u5230' + humanLabel + '\u7684\u5176\u4ed6\u516c\u958b\u4e3b\u5f35\uff0c\u6703\u9010\u9805\u6838\u5c0d\uff0c\u4e0d\u91cd\u8907\u78ba\u8a8d\u5df2\u88ab\u63d0\u53ca\u7684\u7d50\u679c\u3002');
        }
      }
      const humanRoleClaims = Array.isArray(unresolved.roleClaims) ? unresolved.roleClaims : (humanParsed.roleClaims || []);
      const incomingRoleClaim = humanRoleClaims.find(claim => claim.playerId === bot.id && ['claim', 'fake'].includes(claim.polarity));
      if (incomingRoleClaim) {
        if (!ctx.isGood && plan.roleBluff && plan.roleBluff.role) {
          parts.push(`${humanLabel}指我是假冒【${incomingRoleClaim.role}】，但我公開採取的角色版本是【${plan.roleBluff.role}】；後續請用技能時點、票型與對跳紀錄核對，不要只憑標籤定罪。`);
        } else if (!ctx.isGood) {
          parts.push(`${humanLabel}把我指為【${incomingRoleClaim.role}】，但目前沒有提出可驗證的技能時點；我不接受只靠角色標籤定罪，也請你說明這項判斷的公開依據。`);
        } else {
          parts.push(`${humanLabel}把我對應到【${incomingRoleClaim.role}】；我會按自己的公開行動與實際技能紀錄核對，角色推測不能取代證據。`);
        }
        if (!ctx.isGood && plan.counterAccuseId && plan.counterAccuseId === lastPublicSpeaker.playerId) {
          parts.push(`我反而要請${humanLabel}先交代這項角色指控的依據，避免用未驗證的身分標籤帶動投票。`);
        }
      }
      humanRoleClaims.forEach(claim => {
        const target = U.byId(room, claim.playerId);
        if (!target) return;
        const targetTag = U.tag(target);
        if (claim.polarity === 'deny') parts.push(`${humanLabel}排除${targetTag}是【${claim.role}】；這不等於證明他是好人，我會再核對其他角色可能性。`);
        else if (claim.polarity === 'fake') parts.push(`${humanLabel}指稱${targetTag}是假冒【${claim.role}】；我會把這視為角色爭議，不直接當成他的真實角色。`);
        else parts.push(`${humanLabel}指認${targetTag}是【${claim.role}】；我會按技能時點和其他公開證據核對這項角色判斷。`);
      });
      const humanRoleComparisons = Array.isArray(unresolved.roleComparisons) ? unresolved.roleComparisons : (humanParsed.roleComparisons || []);
      humanRoleComparisons.forEach(item => {
        const roles = (item.roles || []).filter(roleName => GD.ROLES && GD.ROLES[roleName]);
        if (roles.length < 2) return;
        const defs = roles.map(roleName => GD.ROLES[roleName]);
        const sameCamp = defs.every(def => def.camp === defs[0].camp);
        const sameSkill = defs.every(def => def.weapon === defs[0].weapon);
        const shared = [sameCamp ? `都屬${defs[0].campText}` : '', sameSkill ? `技能標籤同為「${defs[0].weapon}」` : ''].filter(Boolean).join('，');
        const comparisonLine = `${humanLabel}問【${roles.join('】與【')}】是不是一樣；規則上是兩張不同角色卡${shared ? `，${shared}` : ''}，但角色身分並不相同。不能把相同陣營或技能誤當成同一角色。`;
        parts.push(comparisonLine);
      });
      if (humanStances.length) {
        humanStances.forEach(st => {
          const history = (Array.isArray(st.evidence) ? st.evidence : (st.evidence ? [st.evidence] : []))
            .filter(item => item && item.type === 'historical-vote')
            .map(item => `第${item.round}輪投【${item.beast}】${item.votes}票`);
          const historyLine = history.length ? `，並指出其歷史票型（${history.join('、')}）` : '';
          parts.push(`${humanLabel}認為${st.tag}是${st.label}${historyLine}；我會把這列為待驗立場，再用實際發言、票型和獨立線索核對，不會只憑指控定罪。`);
        });
      }
      (unresolved.candidateSets || []).forEach(group => {
        const tags = (group.targetTags || []).join('、');
        if (tags) parts.push(`${humanLabel}提出${tags}之中一人是${group.role}的假設；我會把他們列為待驗候選，不會直接把所有候選都當成壞人，並依傳牌時序和獨立證據核對。`);
      });
      (unresolved.inspectionReports || []).forEach(report => {
        const matchingPool = (A.publicReportedFlipPools || []).find(pool => pool.speakerId === lastPublicSpeaker.playerId && pool.speechRound === ctx.t + 1 && pool.reportRound === report.round && pool.beast === report.beast);
        const earlierTags = matchingPool ? matchingPool.candidateIds.map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p)) : [];
        const candidateNote = earlierTags.length ? "，檢查前置候選 " + earlierTags.join("、") : "";
        parts.push(`${humanLabel}回報第${report.round}輪驗【${report.beast}】為${report.claimedReal ? '真品' : '贗品'}；我會對照公開結果與當輪傳牌順序${candidateNote}，確認可能的反轉區間。`);
      });
      if (humanDefense && !mainClaim) {
        const defenseSeed = GD.DialogueBank.hash(`${dialogueSeedText}:human-defense:${humanPlayer && (humanPlayer.botId || humanPlayer.id) || humanLabel}`);
        publicResponseLine = freshPickLine('publicDefenseResponse', defenseSeed, { speaker: humanLabel, voteBeast: plan.beast });
        parts.push(publicResponseLine);
      } else if (humanDefense) {
        parts.push(`另記下${humanLabel}的自辯：他自稱好人並要求不要投他；這是立場，不是已驗證結果。`);
      }
      if (humanRoleClaim && !mainClaim) {
        if (bot.role === humanRoleClaim) {
          publicResponseLine = `${humanLabel}提出自己的角色版本；我會按原始發言與技能時點核對，不把口頭自稱當成定案。`;
        } else {
          const roleSeed = GD.DialogueBank.hash(`${dialogueSeedText}:human-role:${humanPlayer && (humanPlayer.botId || humanPlayer.id) || humanLabel}:${humanRoleClaim}`);
          publicResponseLine = freshPickLine('publicRoleResponse', roleSeed, { speaker: humanLabel, role: humanRoleClaim, voteBeast: plan.beast });
        }
        parts.push(publicResponseLine);
      } else if (humanRoleClaim && mainClaim && humanRoleClaim !== bot.role) {
        parts.push(`${humanLabel}也提出【${humanRoleClaim}】的角色版本，我會按技能時點另行核對。`);
      } else if (humanRoleClaim && mainClaim && humanRoleClaim === bot.role) {
        parts.push(`${humanLabel}也提出與我相同的角色版本；這仍需依原始發言與技能時點核對。`);
      }
      if (humanCall && !mainClaim && !humanCorrection) {
        const callSeed = GD.DialogueBank.hash(`${dialogueSeedText}:human-call:${humanPlayer && (humanPlayer.botId || humanPlayer.id) || humanLabel}:${humanCall}:${plan.beast}`);
        publicResponseLine = freshPickLine('publicCallResponse', callSeed, { speaker: humanLabel, beast: humanCall, voteBeast: plan.beast });
        parts.push(publicResponseLine);
      } else if (humanCall && mainClaim) {
        parts.push(humanCall === plan.beast
          ? `${humanLabel}也主張投${B(humanCall)}，這輪我會跟同一個方向。`
          : `${humanLabel}希望大家投${B(humanCall)}，但我的票投${B(plan.beast)}；開票後再看哪個判斷站得住。`);
      }
      if (humanTarget) {
        const accusationSeed = GD.DialogueBank.hash(`${dialogueSeedText}:human-accusation:${humanPlayer && (humanPlayer.botId || humanPlayer.id) || humanLabel}:${humanTarget.botId || humanTarget.name || humanTarget.id}`);
        const accusationLine = freshPickLine('publicAccusationResponse', accusationSeed, {
          speaker: humanLabel, target: U.tag(humanTarget), voteBeast: plan.beast
        });
        if (!parts.some(part => String(part || '').includes(U.tag(humanTarget)) && /懷疑|指控|疑點|指認|質疑/.test(String(part || '')))) {
          parts.push(accusationLine);
          if (!publicResponseLine) publicResponseLine = accusationLine;
        }
      }
      if (!publicResponseLine && !humanClaims.length && !humanStances.length && !humanRoleComparisons.length && !humanDefense && !humanRoleClaim && !humanCall && !humanTarget) {
        publicResponseLine = `${humanLabel}剛才的原話是：「${humanTextForResponse.slice(0, 48)}」。我會按公開紀錄核對，不把它直接當成已證實事實。`;
        parts.push(publicResponseLine);
      }
    }
    // 跨輪公開推理不能只留在 Mind 摘要；本地備援也必須接住，並明確標成待驗假設。
    const laterPublicSpeechMentions = (speakerId, sourceRoundNumber, predicate) => {
      const sourceIndex = Math.max(0, (Number(sourceRoundNumber) || 1) - 1);
      const sourceRound = (room.rounds || [])[sourceIndex];
      const sourceSpeeches = sourceRound && sourceRound.speeches || [];
      const sourceSpeechIndex = sourceSpeeches.findIndex(sp => sp && sp.playerId === speakerId);
      const sameRoundAfter = sourceSpeechIndex >= 0 ? sourceSpeeches.slice(sourceSpeechIndex + 1) : [];
      const laterRounds = (room.rounds || []).slice(sourceIndex + 1).flatMap(historyRound => historyRound && historyRound.speeches || []);
      return sameRoundAfter.concat(laterRounds).some(sp => sp && sp.playerId !== speakerId && predicate(String(sp.text || ''), sp));
    };
    (A.publicCandidateGroups || []).filter(group => group.speechRound < ctx.t + 1).forEach(group => {
      const speaker = U.byId(room, group.speakerId);
      const speakerTag = speaker ? U.tag(speaker) : (group.speakerName || '前手玩家');
      const tags = (group.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));
      const addressed = laterPublicSpeechMentions(group.speakerId, group.speechRound, text =>
        text.includes(speakerTag) && tags.every(tag => text.includes(tag)) && /(?:候選|其中一人|其中一位|之一|老朝奉|壞人)/.test(text)
      );
      if (!addressed && tags.length >= 2) parts.push(
        `補回第${group.speechRound}輪的公開推理：${speakerTag}認為${tags.join('、')}之中一人可能是${group.role}；我會把他們列為待驗候選，而不是同時定罪，再核對傳牌時序與獨立證據。`
      );
    });
    (A.publicReportedFlipPools || []).filter(pool => pool.speechRound < ctx.t + 1).forEach(pool => {
      const speaker = U.byId(room, pool.speakerId);
      const speakerTag = speaker ? U.tag(speaker) : (pool.speakerName || '前手玩家');
      const tags = (pool.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));
      const addressed = laterPublicSpeechMentions(pool.speakerId, pool.speechRound, text =>
        text.includes(speakerTag) && text.includes(B(pool.beast)) && /(?:反轉|公開結果|開出來|傳牌順序|前置候選)/.test(text)
      );
      if (!addressed && tags.length) parts.push(
        `${speakerTag}回報第${pool.reportRound}輪驗【${pool.beast}】為${pool.claimedReal ? '真品' : '贗品'}，公開結果卻相反；我會依當輪傳牌順序檢查${tags.join('、')}，但這仍是公開回報所形成的待驗假設。`
      );
    });
    // 若前手玩家的主張與本輪目標不同，清楚說明已納入考慮、但為何暫不跟票。
    if (lastPublicSpeaker && !publicResponseLine && lastPublicClaimForResponse && lastPublicClaimForResponse.beast !== plan.beast) {
      addTeamResponse(lastPublicSpeaker.playerId, lastPublicLabelForResponse || lastPublicSpeaker.speakerName || '前手玩家玩家', lastPublicClaimForResponse);
    } else if (!lastPublicSpeaker && lastPriorSpeech) {
      const lastParsed = parsePriorForThread(lastPriorSpeech);
      const lastClaims = (lastParsed.claims || []).filter(c => c && c.beast && typeof c.real === 'boolean');
      const priorClaim = lastClaims.find(c => c.beast !== plan.beast);
      const labelPlayer = U.byId(room, lastPriorSpeech.playerId);
      const priorLabel = labelPlayer ? U.tag(labelPlayer) : (lastPriorSpeech.speakerName || '前手玩家');
      if (priorClaim) {
        addTeamResponse(lastPriorSpeech.playerId, priorLabel, priorClaim);
      } else {
        // If the last speaker did not make a different-beast claim, respond to their actual topic
        // instead of jumping back to an older statement: role claim, camp check, vote call or suspect call.
        const priorVoteCall = lastParsed.callBeast || (lastParsed.callBeasts || []).find(b =>
          (ctx.rd?.beasts || []).some(current => current.name === b)) || null;
        const priorTargetId = lastParsed.callSuspectId || (lastParsed.accuse || []).find(a => a && a.playerId)?.playerId;
        const priorTarget = priorTargetId ? U.byId(room, priorTargetId) : null;
        const priorCamp = (lastParsed.campChecks || [])[0];
        const campTarget = priorCamp && U.byId(room, priorCamp.targetId);
        const priorAskedId = (lastParsed.asked || [])[0];
        const askedPlayer = priorAskedId ? U.byId(room, priorAskedId) : null;
        if (priorTarget) {
          parts.push(`${priorLabel}剛才把疑點指向${U.tag(priorTarget)}；我會對照他的原話與公開票型，不只憑單一指控定案。`);
        } else if (priorVoteCall && (ctx.rd?.beasts || []).some(b => b.name === priorVoteCall)) {
          parts.push(`${priorLabel}剛才主張投${B(priorVoteCall)}；我會比對支持與反對這個目標的公開線索，再決定是否跟票。`);
        } else if (priorCamp && campTarget) {
          parts.push(`${priorLabel}公開表示${U.tag(campTarget)}屬於${priorCamp.camp === 'evil' ? '壞人' : '好人'}陣營；這是他的判斷，我會再核對技能時點和其他可見行為。`);
        } else if (lastParsed.selfRole) {
          parts.push(`${priorLabel}剛才自稱【${lastParsed.selfRole}】；角色主張可以對跳，不能只靠自稱定案，還要核對前後原話、技能時點與票型。`);
        } else if (askedPlayer) {
          parts.push(`${priorLabel}剛才請${U.tag(askedPlayer)}說明；我會留意對方是否正面回應問題，以及說法能否和公開紀錄對上。`);
        }
      }
    }

    // 不只辨識固定標籤，也辨識自然語句中的歷史矛盾／事後票型，避免換句話說後重複引用。
    const historyLineAlreadyUsed = (ctx.rd?.speeches || []).some(sp => {
      const text = String(sp && sp.text || '');
      return /跨輪證據鏈|跨輪票型對照|跨輪公開結果對照|跨輪吻合紀錄/.test(text) ||
        /第\s*\d+\s*輪.*(?:宣稱|說過|公開說過).*(?:真品|贗品|是真|是假).*(?:但|卻|結果|證實|判為).*(?:真品|贗品|真|假)/.test(text) ||
        /第\s*\d+\s*輪.*(?:公開結果|開票結果|後來公開).*(?:贗品|真品).*(?:投了|投給|票)/.test(text);
    });
    const crossRoundEvidence = historyLineAlreadyUsed ? '' : buildCrossRoundEvidence(room, bot, ctx);
    if (crossRoundEvidence) parts.push(crossRoundEvidence);    if (!ctx.isGood && plan.evilStyle === 'aggressive' && ctx.t > 0) {
      const lastPublic = [...room.rounds.slice(0, ctx.t)].reverse()
        .find(rd => rd.voteResults && rd.voteResults.rank2);
      const focus = plan.suspectId ? U.byId(room, plan.suspectId) : null;
      const focusHasHistory = !!focus && room.rounds.slice(0, ctx.t).some(rd =>
        (rd.speeches || []).some(sp => sp.playerId === focus.id)
      );

      if (lastPublic && !crossRoundEvidence && !historyLineAlreadyUsed) {
        const rank = lastPublic.voteResults.rank2;
        const result = rank.isReal ? '真品' : '贗品';
        parts.push(choosePhrase([
          `上一輪公開第二名是${B(rank.name)}，開票結果為${result}；這項紀錄可以和本輪宣稱對照。`,
          `回看上一輪，公開第二名${B(rank.name)}最後判為${result}，我會把這筆結果納入比較。`,
          `前一輪的公開紀錄顯示，第二名${B(rank.name)}是${result}；本輪還要看各人的說法是否一致。`
        ]));
      }

      if (focusHasHistory) {
        parts.push(choosePhrase([
          `另外，我想核對${U.tag(focus)}前後的公開說法是否一致。`,
          `還有一點值得查：${U.tag(focus)}過去的發言和行動能否互相對上。`,
          `我會再比對${U.tag(focus)}的公開發言與票型，避免只憑印象判斷。`
        ]));
      }
    }

    /* ① 查驗矛盾（優先挑本輪打算公開報出的獸首，避免許願報出第 2 尊） */
    const plannedBeasts = new Set((plan.claims || []).map(c => c.beast));
    const conflicts = Object.values(A.prof).flatMap(r => r.conflicts)
      .filter(c => {
        if (!c || c.round !== ctx.t + 1) return false;
        const speakerPos = Number.isInteger(c.speakerPos)
          ? c.speakerPos
          : passOrder.indexOf(c.speakerId);
        return speakerPos >= 0 && speakerPos < ctx.myPos;
      });
    const matchedConflict = conflicts.find(c => plannedBeasts.has(c.beast)) || conflicts[0];

    if (ctx.isGood && matchedConflict) {
      const c = matchedConflict, sp = U.byId(room, c.speakerId);
      const mid = (c.between || []).map(id => U.tag(U.byId(room, id))).filter(Boolean);
      // 若這尊獸首在 plan.claims 裡（不是許願隱藏的第 2 尊），才直接講出「看到的是真/假品」，否則只講「對不上」以免許願雙報違規
      const canSayMySaw = plannedBeasts.has(c.beast);
      const contrastClause = canSayMySaw
        ? `說${B(c.beast)}是${real(c.claim)}品，但我${pos}親眼看到的是${real(c.saw)}品，兩邊對不上`
        : `說${B(c.beast)}是${real(c.claim)}品，但跟我${pos}掌握的線索對不上`;

      if (c.isAdjacent && c.speakerPos < c.myPos) {
        /* ★ 修正 1：第四位傳給第五位，中間沒人，直接踩死前手 */
        parts.push(`先對時序：${U.tag(sp)}在${U.nth(c.speakerPos)}${contrastClause}。${U.nth(c.speakerPos)}直接傳給我${pos}，中間根本沒別人，他不是在騙票，就是本人開了擾亂！`);
      } else if (c.speakerPos === 0 && c.speakerPos < c.myPos) {
        /* ★ 修正 3：前手是首家（第一位），首家不會被反轉，並結合跨輪交集消去法 */
        const elimIds = (A.eliminatedFromLaoIds || []).filter(id => (c.between || []).includes(id));
        const interIds = (A.laoIntersectIds || []).filter(id => (c.between || []).includes(id));
        const crossTxt = (elimIds.length > 0 && interIds.length > 0)
          ? `；結合前輪反轉時序排除${elimIds.map(id => U.tag(U.byId(room, id))).join('、')}，老朝奉就鎖定在${interIds.map(id => U.tag(U.byId(room, id))).join('、')}之中`
          : '';
        parts.push(`先對時序：${U.tag(sp)}在第一位${contrastClause}。首家不會被反轉，要嘛他首家騙票，要嘛前面（${mid.join('、')}）有人開了擾亂反轉了我的視野${crossTxt}。`);
      } else {
        parts.push(`先對時序：${U.tag(sp)}在${U.nth(c.speakerPos)}${contrastClause}。要嘛他在騙票，要嘛${U.nth(Math.min(c.speakerPos, c.myPos))}到${U.nth(Math.max(c.speakerPos, c.myPos))}之間${mid.length > 1 ? `（${mid.join('、')}）` : ''}有人開了擾亂。`);
      }
    } else if (
      A.topSuspect && ctx.t > 0 &&
      ((ctx.isGood && A.topSuspect.evil >= 20) || (!ctx.isGood && rndPick(0.5)))
    ) {
      parts.push(publicSuspectLine(A.topSuspect, ctx, parts));
    }

    /* ①-b 票型質問（好人）：只引用公開的票型，不碰私密依據 */
    if (plan.askId) {
      const q = U.byId(room, plan.askId);
      parts.push(`有件事要請${U.tag(q)}說明一下：你過去投給後來公開判為贗品的獸，累計共 ${plan.askVotes} 票；最近一次是第 ${plan.askRound} 輪的${B(plan.askBeast)}。這是事後對照，當時你的判斷依據是什麼？`);
    }

    /* ①-c 被質問時的回應（好人照實；壞人維持偽裝；認壞見下方 ②）*/
    if (plan.explain && !plan.confess) {
      const f = plan.explain.votes[plan.explain.votes.length - 1];
      parts.push(ctx.isGood
        ? `${plan.explain.callerName}問我為什麼投贗品，我直說：第 ${f.round} 輪我投了 ${f.n} 票給${B(f.beast)}，是依前手宣稱與自己的查驗判斷，結果被帶了風向，我看走眼，這輪我會更謹慎。`
        : bot.role === '老朝奉' && plan.evilPosture === 'conceal'
          ? `${plan.explain.callerName}問我第 ${f.round} 輪那 ${f.n} 票，我當時依公開發言與票型做判斷。我不接受只因結果不好就倒推我故意灌票，請回頭檢查誰真正帶歪了整條線。`
        : bot.role === '藥不然' && plan.evilStyle === 'conceal'
          ? `${plan.explain.callerName}問我第 ${f.round} 輪那 ${f.n} 票，我依前手公開資訊作出選擇。票型判斷錯誤不等於身分有問題，現在更該排除誰在趁亂帶風向。`
        : plan.evilStyle === 'aggressive'
          ? `${plan.explain.callerName}問我第 ${f.round} 輪那 ${f.n} 票，我把當時的宣稱、前二名與目前的可疑票型一起攤開。與其只追究某一票，不如現在把最可能帶歪好人的對象集中出來。`
        : `${plan.explain.callerName}問我第 ${f.round} 輪那 ${f.n} 票，我當時是照前手的說法與自己的判斷跟著投，結果看走眼，事後看才知道被帶了風向，這點我認。`);
    }

    /* ② 偽裝 / 帶風向 / 查驗陳述 */
    let publicRoleSwitchLine = '';
    const previousPublicRoleClaim = (() => {
      const claims = [];
      (room.rounds || []).slice(0, Math.max(0, ctx.t)).forEach((historyRound, roundIndex) => {
        (historyRound.speeches || []).forEach(sp => {
          if (!sp || String(sp.playerId) !== String(bot.id)) return;
          let parsed = {};
          try {
            parsed = Claims.parseRecord
              ? Claims.parseRecord(sp, room, historyRound)
              : Claims.parse(String(sp.text || ''), room, historyRound);
          } catch (_) {}
          if (parsed && parsed.selfRole) {
            claims.push({
              role: parsed.selfRole,
              round: Number.isInteger(historyRound.roundNum) ? historyRound.roundNum : roundIndex + 1
            });
          }
        });
      });
      return claims.length ? claims[claims.length - 1] : null;
    })();
    const currentPublicRoleClaim = (plan.roleBluff && plan.roleBluff.role) || (plan.fakeFangClaim ? '方震' : null);
    if (currentPublicRoleClaim && previousPublicRoleClaim && previousPublicRoleClaim.role !== currentPublicRoleClaim) {
      publicRoleSwitchLine = `我第${previousPublicRoleClaim.round}輪曾自稱【${previousPublicRoleClaim.role}】，現在改稱【${currentPublicRoleClaim}】；兩個版本矛盾，請核對原話與技能時點。`;
      parts.push(publicRoleSwitchLine);
    }
    const mine = ctx.myIns;
    if (plan.fakeFangClaim && !plan.confess) {
      const target = U.byId(room, plan.fakeFangClaim.targetId);
      if (target) parts.push(`我是方震，我查驗${U.tag(target)}是${plan.fakeFangClaim.isGoodCamp ? '好人' : '壞人'}，後續請用公開票型反查。`);
    } else if (plan.roleBluff && !plan.confess) {
      const roleTarget = plan.roleBluff.targetId ? U.byId(room, plan.roleBluff.targetId) : null;
      if (plan.roleBluff.motive === 'protect_pressured_ally' && plan.roleBluff.protectedAllyId) {
        const pressuredAlly = U.byId(room, plan.roleBluff.protectedAllyId);
        if (pressuredAlly) parts.push(`場上對${U.tag(pressuredAlly)}的角色質疑還缺少能核對的技能時點；先把身分主張攤開，應該分別檢驗每個人的行動，不要只憑猜測集火。`);
      }
      parts.push(plan.roleBluff.role === '方震' && roleTarget
        ? `我是方震，我查驗${U.tag(roleTarget)}是${plan.roleBluff.isGoodCamp ? '好人' : '壞人'}，後續請用公開票型反查。`
        : plan.roleBluff.fakeConfess
          ? `我是${plan.roleBluff.role}，我認壞。先別把這句當成定案，請用接下來的公開票型和角色對跳反查。`
          : `我是${plan.roleBluff.role}，後續請用公開紀錄驗證。`);
      if (plan.roleBluff.persist && !plan.roleBluff.fakeConfess) {
        const denySeed = GD.DialogueBank ? GD.DialogueBank.hash(`${bot.botId || bot.id}:${ctx.t}:${ctx.myPos}:persistent-denial:${plan.roleBluff.role}`) : ctx.t;
        const denial = GD.DialogueBank ? freshPickLine('persistentDenial', denySeed, { role: plan.roleBluff.role, round: ctx.t + 1 })
          : `我不會只因為有人重複質疑就撤回【${plan.roleBluff.role}】的身分主張，請用公開紀錄反駁。`;
        parts.push(denial);
      }
    }
    if (plan.confess) {
      // 認壞不是只承認陣營：必須同時給出明確贗品判斷與相同的公開票向。
      parts.push('我認壞，不再裝了。');
      if (plan.beast) parts.push(`【${plan.beast}】是贗品，我主張這輪把票投向【${plan.beast}】，也請大家一起投這尊。`);
    } else if (ctx.isGood) {
      if (plan.claims.length) {
        const sayTxt = plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、');
        if (plan.bluff) {
          // myPos 是傳牌順位，不是公開發言順位；多人插話後必須依實際前手發言判斷是否為第一位。
          const bluffLines = priorSpeeches.length === 0
            ? [
                `第一棒先表明我的公開判斷：${sayTxt}。`,
                `我先把目前採取的立場說清楚：${sayTxt}。`,
                `我的初步判斷是${sayTxt}，後續還要和其他公開線索對照。`
              ]
            : [
                `輪到我時，我目前採取的判斷是${sayTxt}。`,
                `補充我的立場：${sayTxt}；其他人的說法也需要交叉核對。`,
                `就目前的推演，我會公開主張${sayTxt}。`
              ];
          parts.push(choosePhrase(bluffLines));
        } else if (bot.role === '姬雲浮') {
          parts.push(`我在${pos}的查驗結果是${sayTxt}，我的眼力不受任何擾亂影響。`);
        } else {
          parts.push(choosePhrase([
            `我的查驗結果是${sayTxt}。`,
            `這輪我確認到的結果是${sayTxt}。`,
            `我手上的查驗顯示${sayTxt}。`
          ]));
        }
      } else if (!plan.fakeFangClaim && plan.withholdInfo) {
        parts.push(`目前已有可信的前置公開線索支持這個方向，我暫不重複攤開已被提過的查驗細節；這輪我投${B(plan.beast)}，後續仍看票型能否獨立印證。`);
      } else if (!plan.fakeFangClaim) {
        parts.push(`我${pos}${ctx.log.blind ? '被偷襲眼前一片黑，上一棒傳給我的人嫌疑不小' : '這輪無法辨別真偽'}，先順著前手可信線索推演。`);
      }
      if (plan.ambushFrameHypothesis && ctx.log.blind && !plan.hideBlind && !plan.roleBluff && !plan.fakeFangClaim) {
        const first = U.byId(room, plan.ambushFrameHypothesis.firstId);
        const second = U.byId(room, plan.ambushFrameHypothesis.secondId);
        if (first && second) {
          parts.push(`我在第三位被偷襲，暫時會把第一位${U.tag(first)}列為「藥不然」假設、第二位${U.tag(second)}列為「老朝奉」假設；這只是按時序建立的可反駁配對，不能當成已確認身分，後續要核對技能紀錄和公開票型。`);
        }
      }
      if (plan.laoTimingAudit && plan.laoTimingAudit.noSkillPossible) {
        parts.push('另外，這輪沒有足夠線索證明擾亂一定發動；我不會因此把老朝奉排除。技能時點要對照傳牌順位，發言先後只是討論順序，不能混為一談。');
      }
      const laterPassCandidates = plan.laoTimingAudit && plan.laoTimingAudit.laterPassCandidates || [];
      if (laterPassCandidates.length) {
        const lateTags = laterPassCandidates.slice(0, 2).map(candidate => `${candidate.name}（第${U.nth(candidate.passIndex)}傳牌位）`);
        parts.push(`我也保留老朝奉可能在我之後的傳牌順位；若時序落在後面，影響的是後手玩家的查驗畫面，不會回頭改變我更早看到的結果。這要核對傳牌順位，不能用誰先發言來推斷。${lateTags.length ? `目前可再核對${lateTags.join('、')}的時序。` : ''}`);
      }
      (plan.consensusAudit || []).forEach(group => {
        const countParts = [];
        if (group.selfReportedDirect) countParts.push(`${group.selfReportedDirect}人自稱親查`);
        if (group.inference) countParts.push(`${group.inference}人是推論`);
        if (group.echo) countParts.push(`${group.echo}人是在附和`);
        if (group.unattributed) countParts.push(`${group.unattributed}人沒交代來源`);
        if (group.limitedView) countParts.push(`${group.limitedView}人視野受限`);
        if (countParts.length) parts.push(`目前關於【${group.beast}】有${group.speakerCount}人提出同方向看法，但來源拆開是${countParts.join('、')}；自稱查驗仍是公開自述，不能把同一個結論的重複出現直接算成同等數量的獨立驗證。`);
      });
    } else if (plan.evilRolePerformance) {
      parts.push(`【${plan.beast}】是贗品，我主張這輪把票投向【${plan.beast}】，也請大家一起投這尊。`);
    } else if (plan.mode === 'lie' || plan.mode === 'follow') {
      const pr = priorSpeeches.find(s =>
        (s.p?.claims || []).some(c =>
          c && c.real === true && c.beast !== plan.beast &&
          (mine || []).some(i => i && i.beastName === c.beast && GD.Mind.inspectionTruth(i) === false)
        )
      );
      if (pr && plan.avoid.length === 0 && rndPick(0.6)) {
        const c = pr.p.claims.find(x =>
          x && x.real === true && x.beast !== plan.beast &&
          (mine || []).some(i => i && i.beastName === x.beast && GD.Mind.inspectionTruth(i) === false)
        );
        parts.push(`${U.tag(U.byId(room, pr.playerId))}說${B(c.beast)}是真品，但傳到我${pos}看到的對不上，前面八成有人反轉過，保險起見別碰${B(c.beast)}。`);
        // lie/follow 的宣稱契約仍須成立：對另一尊獸首提出矛盾，不代表省略自己計畫要公開的假真品線。
        parts.push(`至於${B(plan.beast)}是真品，我仍會按這條主線投票，不會把另一尊的矛盾混為本尊的證據。`);
      } else {
        parts.push(`我在${pos}${mine.length ? '掌眼後' : '綜合判斷'}，${B(plan.beast)}是真品，包漿與工藝都穩。`);
      }
      plan.avoid.forEach(a => parts.push(`倒是${B(a)}有疑點，我建議避開。`));
    } else {
      parts.push(`我在${pos}看下來${B(plan.beast)}是真品，${mine.length ? '這跟我的查驗吻合' : '這是目前最穩的線'}。`);
    }

    /* 真實角色微跳：只加入策略已計畫的真身提示，不直接喊出職業名稱。 */
    if (plan.trueRoleSignal && !plan.confess && !plan.roleBluff && !plan.fakeFangClaim) {
      const signalLine = String(plan.trueRoleSignal.line || '').trim();
      if (signalLine && !parts.some(part => String(part || '').includes(signalLine))) {
        // 真身微跳是策略本身的一部分，不以篇幅預算刪除；後續只做重複句去重。
        if (!parts.some(part => String(part || '').includes(signalLine))) parts.push(signalLine);
      }
    }

    if (plan.publicSuspectBrief && !hasPublicSuspectAssessment(room, sameRoundSpeeches)) {
      parts.push(plan.publicSuspectBrief);
    }

    /* ③ 明確號召 */
    const priorTargetClaims = priorSpeeches
      .filter(s => s && s.playerId !== bot.id)
      .map(s => {
        const parsed = Claims.parseRecord
          ? Claims.parseRecord(s, room)
          : (s.p && Array.isArray(s.p.claims) && s.p.claims.length
            ? s.p : Claims.parse(String(s.text || ''), room));
        const claim = (parsed.claims || []).find(c => c && c.beast === plan.beast);
        return claim ? { speech: s, claim } : null;
      })
      .filter(Boolean);
    const latestTargetClaim = priorTargetClaims[0];
    const targetVoteAlreadyStated = parts.some(part => {
      const parsedPart = Claims.parse(String(part || ''), room, ctx.rd);
      return (parsedPart.callBeasts || []).includes(plan.beast);
    });

    if (latestTargetClaim) {
      const citedSpeech = latestTargetClaim.speech;
      const citedPlayer = citedSpeech.playerId ? U.byId(room, citedSpeech.playerId) : null;
      const citedName = citedPlayer ? U.tag(citedPlayer) : (citedSpeech.speakerName || '前面有玩家');
      const citedVerdict = latestTargetClaim.claim.real ? '真品' : '贗品';
      const isSameBeastVerdictQuote = text => {
        const existing = String(text || '').replace(/\s/g, '');
        const claim = B(plan.beast) + '是' + citedVerdict;
        return existing.includes('「' + claim + '」') ||
          existing.includes('“' + claim + '”') ||
          existing.includes('"' + claim + '"') ||
          existing.includes("'" + claim + "'");
      };
      // Once this beast/verdict has been explicitly quoted this round, avoid echoing the same claim through a different speaker name.
      const citationAlreadyUsedInThisSpeech = parts.some(part =>
        isSameBeastVerdictQuote(part)
      );
      const citationAlreadyUsedEarlierThisRound = priorSpeeches.some(sp =>
        isSameBeastVerdictQuote(sp && sp.text)
      );
      const sameTargetClaimAlreadyStated =
        citationAlreadyUsedInThisSpeech || citationAlreadyUsedEarlierThisRound;
      // A vote may already have been stated in an earlier part of this same speech.
      // Keep one explicit call even when no prior speaker made the same beast claim.
      if (!targetVoteAlreadyStated) {
        if (sameTargetClaimAlreadyStated) {
          parts.push(`我的票投${B(plan.beast)}；這是本輪的選擇，仍要核對其他公開證據。`);
        } else {
          parts.push(choosePhrase([
            `${citedName}先前說「${B(plan.beast)}是${citedVerdict}」。我這輪投${B(plan.beast)}，也會再比對其他公開證據。`,
            `前面${citedName}公開說過「${B(plan.beast)}是${citedVerdict}」。我的票投${B(plan.beast)}，但不只憑單一人的說法定案。`,
            `${citedName}剛才的原話是「${B(plan.beast)}是${citedVerdict}」。目前我投${B(plan.beast)}，仍要看其他線索能否印證。`
          ]));
        }
      }
    } else if (!targetVoteAlreadyStated && ctx.t === 0) {
      parts.push(choosePhrase([
        `第一輪還沒有歷史票型可比，我先投${B(plan.beast)}；之後再核對各人的宣稱是否一致。`,
        `目前沒有前輪紀錄可參照，我把票投給${B(plan.beast)}，後續再看公開說法是否經得起比對。`,
        `這是第一輪，暫時沒有舊票型可驗證；我先投${B(plan.beast)}，有具體反證再調整判斷。`
      ]));
    } else if (!targetVoteAlreadyStated) {
      const lastPublic = [...room.rounds.slice(0, ctx.t)].reverse()
        .find(rd => rd.voteResults && rd.voteResults.rank2);
      if (lastPublic && !crossRoundEvidence && !historyLineAlreadyUsed) {
        const rank = lastPublic.voteResults.rank2;
        const result = rank.isReal ? '真品' : '贗品';
        parts.push(choosePhrase([
          `上一輪公開第二名${B(rank.name)}的結果是${result}；本輪我投${B(plan.beast)}，並會繼續核對宣稱與票型。`,
          `我把前一輪${B(rank.name)}被判為${result}的紀錄當作背景，這輪選擇投${B(plan.beast)}。`,
          `前輪公開結果提供了一項參照：${B(rank.name)}為${result}。本輪我的票投${B(plan.beast)}。`
        ]));
      } else {
        parts.push(choosePhrase([
          `我這輪投${B(plan.beast)}；目前仍需要用已公開的查驗和票型交叉核對。`,
          `我的票投${B(plan.beast)}，這是目前的選擇，還要看後續公開證據能否支撐。`,
          `這輪我選擇投${B(plan.beast)}；若有不同判斷，請提出能核對的線索。`
        ]));
      }
    }
    if (plan.followHuman) {
      parts.push(`鑑人環節我附議【${plan.followHuman.callerName}】，一起集火${U.tag(U.byId(room, plan.followHuman.targetId))}！`);
    } else if (plan.suspectId) {
      parts.push(`鑑人時我建議大家看緊${U.tag(U.byId(room, plan.suspectId))}，一起指認他！`);
    }
    // 不報分數或系統排序；若有角色懷疑，只用自然口語明確標成推測。
    const roleTargetId = plan.followHuman && plan.followHuman.targetId || plan.suspectId;
    const roleTargetProfile = roleTargetId && A.prof && A.prof[roleTargetId];
    if (roleTargetProfile && roleTargetProfile.probs) {
      const roleGuess = Object.entries(roleTargetProfile.probs)
        .filter(([role]) => (GD.ROLE_ORDER || []).includes(role))
        .sort((a, b) => b[1] - a[1])[0];
      if (roleGuess && Number(roleGuess[1]) >= 22) {
        const targetPlayer = U.byId(room, roleTargetId);
        const roleLine = targetPlayer
          ? `我目前也懷疑${U.tag(targetPlayer)}可能是【${roleGuess[0]}】，但這只是推測，還要看他前後說法和票型。`
          : '';
        if (roleLine && !parts.some(part => String(part || '').includes(roleLine))) parts.push(roleLine);
      }
    }
    // 真方震的規則禁止在公開發言中出現自己的角色名；公開證據可能引用別人假跳方震，
    // 因此在本地備援輸出時，略過包含該角色名的整段，而不是把原句中的字硬刪掉。
    if (bot.role === '許願' && plan.xuYuanLine && !plan.roleBluff && !plan.fakeFangClaim && !plan.confess) {
      parts.push(plan.xuYuanLine);
    }

    const safeParts = bot.role === '方震'
      ? parts.filter(part => !String(part || '').includes('方震'))
      : parts;
    // 保留有證據價值的主張、人物回應、角色承諾與票向；只移除重複模板，不按字數刪除內容。
    const voteTag = B(plan.beast);
    const primaryVotePart = safeParts.find(part => String(part || '').includes(voteTag) && /(?:投|落票)/.test(String(part || ''))) || null;
    const mandatory = part => {
      const text = String(part || '');
      if (plan.roleBluff && text.includes(`我是${plan.roleBluff.role}`)) return true;
      if (plan.fakeFangClaim && text.includes('我是方震')) return true;
      if (publicRoleSwitchLine && text.includes(publicRoleSwitchLine)) return true;
      if (plan.askId) {
        const askTarget = U.byId(room, plan.askId);
        if (askTarget && text.includes(U.tag(askTarget)) && /(?:說明|依據|為什麼)/.test(text)) return true;
      }
      if (publicResponseLine && text === publicResponseLine) return true;
      if (plan.trueRoleSignal && plan.trueRoleSignal.line && text.includes(plan.trueRoleSignal.line)) return true;
      if (plan.publicSuspectBrief && text.includes(plan.publicSuspectBrief)) return true;
      if (plan.laoTimingAudit && /擾亂|老朝奉排除|技能時點|後手玩家的查驗畫面/.test(text)) return true;
      if ((plan.consensusAudit || []).some(group => text.includes(B(group.beast)) && /自稱查驗|獨立驗證/.test(text))) return true;
      if (plan.xuYuanLine && text.includes(plan.xuYuanLine)) return true;
      if (teamResponseLine && text === teamResponseLine) return true;
      if (plan.claims && plan.claims.some(c => text.includes(B(c.beast)) && (c.real ? /真品|是真|判真|真（/.test(text) : /贗品|假品|是假|判假/.test(text)))) return true;
      if (text.includes(voteTag) && /(?:投|落票)/.test(text)) return text === primaryVotePart;
      return false;
    };
    const normalizeTemplate = text => String(text || '').toLowerCase()
      .replace(/(?:黑|紅|橘|黃|綠|藍|紫|白)色/g, '玩家色')
      .replace(/【[^】]+】/g, '【標記】')
      .replace(/第[一二三四五六七八九十]+位/g, '第#位')
      .replace(/第[一二三四五六七八九十]+輪/g, '第#輪').replace(/\d+/g, '#')
      .replace(/[\s，。！？!?；;：:「」『』“”、,.]/g, '');
    const historicalTemplateKeys = new Set();
    (room.rounds || []).slice(Math.max(0, ctx.t - 2), ctx.t + 1).forEach(historyRound =>
      (historyRound && historyRound.speeches || []).forEach(sp =>
        String(sp && sp.text || '').split(/[。！？!?；;\n]+/).forEach(sentence => {
          const key = normalizeTemplate(sentence);
          if (key.length >= 8) historicalTemplateKeys.add(key);
        })
      )
    );
    const compactParts = [];
    const currentTemplateKeys = new Set();
    const humanResponseTag = lastPublicSpeaker ? ((U.byId(room, lastPublicSpeaker.playerId) && U.tag(U.byId(room, lastPublicSpeaker.playerId))) || lastPublicSpeaker.speakerName || '') : '';
    let keptPrimaryVote = false;
    for (const rawPart of safeParts) {
      const part = String(rawPart || '').trim();
      if (!part) continue;
      const key = normalizeTemplate(part);
      const targetVote = part.includes(voteTag) && /(?:投|落票)/.test(part);
      const voteFallback = /^(?:第一輪|目前沒有前輪|這是第一輪|我的票投|我這輪投|目前我投|這輪我選擇投|我把票投給|本輪仍投|目前投|我暫投)/.test(part);
      const directHumanReply = !!humanResponseTag && part.includes(humanResponseTag) &&
        /(?:剛才|你說|原話|你的|好人|不要投|別投|點錯|誤點|抱歉|更正|號召|主張|懷疑|指控|聽到|收到|自稱|判斷|人物立場|公開判斷|角色|身分|身份|對跳|版本|立場|陣營)/.test(part);
      const protectedPart = mandatory(part) || directHumanReply ||
        (plan.claims || []).some(c => c && c.beast && part.includes(B(c.beast)) && (c.real ? /真品|是真|判真/.test(part) : /贗品|假品|是假|判假/.test(part)));
      if (targetVote && keptPrimaryVote && voteFallback && !directHumanReply && part !== teamResponseLine) continue;
      if (!protectedPart && key.length >= 8 && (historicalTemplateKeys.has(key) || currentTemplateKeys.has(key))) continue;
      compactParts.push(rawPart);
      if (key.length >= 8) currentTemplateKeys.add(key);
      if (targetVote) keptPrimaryVote = true;
    }
    // normalizeTemplate 已刪除跨輪與本輪重複句；不再因篇幅門檻刪除證據或人物回應。
    let assembled = compactParts.join('');
    // 確保公開主票方向存在；即使補上後較長，也不截斷原有推理內容。
    const finalCallParse = Claims.parse(assembled, room, ctx.rd);
    if (plan.beast && !(finalCallParse.callBeasts || []).includes(plan.beast)) {
      assembled += `我投${B(plan.beast)}。`;
    }
    const localAudit = auditPublicConsistency(assembled, room, bot, plan, A);
    const localHumanAudit = publicResponseAudit(assembled, publicThreadForSpeech, bot, plan);
    const localPerformanceAudit = auditPublicPerformanceClaim(plan, Claims.parse(assembled, room, ctx.rd).claims,
      Claims.parse(assembled, room, ctx.rd).callBeasts);
    const localLeakAudit = auditPrivateThoughtLeakage(assembled);
    if (!localAudit.ok || !localHumanAudit.ok || !localPerformanceAudit.ok || !localLeakAudit.ok) {
      if (typeof process !== 'undefined' && process.env && process.env.DEBUG_SPEECH_AUDIT) console.error('LOCAL_AUDIT', bot.name, bot.role, plan.mode, localAudit.why, '\nTEXT=', assembled);
      // Remove only the sentence that fails the public-fact audit; preserve any planned bluff, role claim,
      // true-role signal and ballot call elsewhere in the generated local speech.
      const sentenceParts = assembled.match(/[^。！？!?]+[。！？!?]?/g) || [assembled];
      const kept = sentenceParts.filter(part => auditPublicConsistency(part, room, bot, plan, A).ok);
      const sanitized = kept.join('');
      const sanitizedParsed = sanitized ? Claims.parse(sanitized, room, ctx.rd) : {};
      if (sanitized && auditPublicConsistency(sanitized, room, bot, plan, A).ok &&
          publicResponseAudit(sanitized, publicThreadForSpeech, bot, plan).ok &&
          auditPublicPerformanceClaim(plan, sanitizedParsed.claims, sanitizedParsed.callBeasts).ok &&
          auditPrivateThoughtLeakage(sanitized).ok) return sanitized;

      // Last-resort construction retains required strategy contracts instead of dropping all role-play.
      const safeParts = [];
      if (publicRoleSwitchLine) safeParts.push(publicRoleSwitchLine);
      if (plan.askId) {
        const askTarget = U.byId(room, plan.askId);
        if (askTarget) safeParts.push(`有件事要請${U.tag(askTarget)}說明一下：你過去投給後來公開判為贗品的獸，累計共 ${plan.askVotes} 票；最近一次是第 ${plan.askRound} 輪的${B(plan.askBeast)}。這是事後對照，當時你的判斷依據是什麼？`);
      }
      const visibleClaims = (plan.claims || []).filter(c => c && c.beast &&
        (ctx.rd.beasts || []).some(b => b.name === c.beast));
      if (!ctx.isGood && !plan.confess && !plan.evilRolePerformance && ['lie', 'follow'].includes(plan.mode)) {
        safeParts.push(`我目前主張${B(plan.beast)}是真品，請把這個公開立場和後續票型一起核對。`);
      }
      if (plan.roleBluff && plan.roleBluff.role === '方震' && plan.roleBluff.targetId) {
        const target = U.byId(room, plan.roleBluff.targetId);
        if (target) safeParts.push(`我是方震，我查驗${U.tag(target)}是${plan.roleBluff.isGoodCamp ? '好人' : '壞人'}。`);
      } else if (plan.fakeFangClaim && plan.fakeFangClaim.targetId) {
        const target = U.byId(room, plan.fakeFangClaim.targetId);
        if (target) safeParts.push(`我是方震，我查驗${U.tag(target)}是${plan.fakeFangClaim.isGoodCamp ? '好人' : '壞人'}。`);
      } else if (plan.roleBluff) {
        safeParts.push(`我是${plan.roleBluff.role}，後續請依公開紀錄核對。`);
      } else if (plan.trueRoleSignal && plan.trueRoleSignal.line) {
        safeParts.push(plan.trueRoleSignal.line);
      } else if (visibleClaims.length && bot.role !== '方震') {
        safeParts.push(`我的公開判斷是${visibleClaims.map(c => `${B(c.beast)}${real(c.real)}`).join('、')}。`);
      }
      if (plan.publicSuspectBrief && !safeParts.some(part => part.includes(plan.publicSuspectBrief))) safeParts.push(plan.publicSuspectBrief);
      if (plan.xuYuanLine && !safeParts.some(part => part.includes(plan.xuYuanLine))) safeParts.push(plan.xuYuanLine);
      if (plan.confess || plan.evilRolePerformance) {
        safeParts.push(`【${plan.beast}】是贗品，我主張這輪把票投向【${plan.beast}】，也請大家一起投這尊。`);
      } else {
        safeParts.push(`我把${B(plan.beast)}列為主要票向，並號召投${B(plan.beast)}；若有分票，應以公開證據與票差說明。`);
      }
      const humanCore = compactPublicReply(publicThreadForSpeech, bot, plan);
      if (humanCore && !publicThreadForSpeech.addressed) safeParts.unshift(humanCore);
      let fallbackSpeech = safeParts.join('');
      const withheldInfoLine = plan.withholdInfo
        ? '\u76ee\u524d\u5df2\u6709\u53ef\u4fe1\u7684\u524d\u7f6e\u516c\u958b\u7dda\u7d22\u652f\u6301\u9019\u500b\u65b9\u5411\uff0c\u6211\u66ab\u4e0d\u91cd\u8907\u6524\u958b\u5df2\u88ab\u63d0\u904e\u7684\u67e5\u9a57\u7d30\u7bc0\uff1b\u672c\u8f2a\u4f9d\u516c\u958b\u7968\u578b\u8207\u4f86\u6e90\u7368\u7acb\u6027\u6c7a\u5b9a\u6295\u7968\u3002'
        : '';
      if (withheldInfoLine && !fallbackSpeech.includes('\u66ab\u4e0d\u91cd\u8907\u6524\u958b')) {
        fallbackSpeech = [fallbackSpeech, withheldInfoLine].filter(Boolean).join('');
      }
      return fallbackSpeech;
    }
    return assembled;
  }
  function rndPick(p) { return Math.random() < p; }

  /* ------------------------------------------------------------------ 公開發言一致性審核
   * 僅檢查可驗證的自相矛盾與「某人曾說/曾指稱」的歷史歸因。
   * 不禁止反跳身分、戰術說謊或合法多票分配；有明確栽贓計畫時可保留未經證實的歸因。
   */
  function allAvailablePublicSpeeches(room) {
    const out = [];
    const end = Math.min(Number(room.currentRoundIdx) || 0, (room.rounds || []).length - 1);
    for (let r = 0; r <= end; r++) {
      const rd = room.rounds[r];
      (rd && Array.isArray(rd.speeches) ? rd.speeches : []).forEach(sp => {
        if (sp && sp.playerId) out.push({ speech: sp, round: rd, roundIndex: r });
      });
    }
    return out;
  }

  function speechPlayerMentionIndex(text, player, room) {
    const s = String(text || '');
    const aliases = [];
    if (player && player.name) {
      aliases.push(U.tag(player));
      if (player.name.length >= 2) aliases.push(player.name);
      try {
        const color = U.colorOf(player);
        if (color && color.name) aliases.push(color.name);
      } catch (_) {}
    }
    let best = -1;
    [...new Set(aliases.filter(Boolean))].forEach(alias => {
      const ix = s.indexOf(alias);
      if (ix >= 0 && (best < 0 || ix < best)) best = ix;
    });
    if (best < 0 && Claims && typeof Claims.mentions === 'function') {
      try {
        if (Claims.mentions(s, room).some(p => p && p.id === player.id)) return 0;
      } catch (_) {}
    }
    return best;
  }

  function beastVerdictsInText(text) {
    const out = [];
    const re = /【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】\s*(?:是|為)?\s*(真品|真貨|真的|是真|贗品|假品|假貨|假的|是假|真|假)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const word = m[2];
      out.push({ beast: m[1], real: /真品|真貨|真的|是真|真/.test(word), index: m.index });
    }
    return out;
  }

  function historicalClaimMatches(entries, source, beast, real, room) {
    return entries.some(entry => {
      if (String(entry.speech.playerId) !== String(source.id)) return false;
      let parsed = {};
      try { parsed = Claims.parseRecord(entry.speech, room, entry.round); } catch (_) {}
      return (parsed.claims || []).some(c => c && c.beast === beast && c.real === real);
    });
  }

  // Extract only the verdict that a historical attribution actually assigns to its source.
  // Do not validate the speaker's later counterclaim as though the original speaker said it too.
  function attributedVerdictsInText(clause, verbIndex, verbLength) {
    const tail = String(clause || '').slice(verbIndex + verbLength);
    const openIndex = tail.search(/[「『“"]/);
    if (openIndex >= 0 && openIndex <= 36) {
      const opener = tail[openIndex];
      const closer = ({ '「': '」', '『': '』', '“': '”', '"': '"' })[opener];
      const closeIndex = tail.indexOf(closer, openIndex + 1);
      if (closer && closeIndex > openIndex) {
        const quoted = tail.slice(openIndex + 1, closeIndex);
        const quotedVerdicts = beastVerdictsInText(quoted);
        if (quotedVerdicts.length) return quotedVerdicts;
      }
    }
    // Older speech records sometimes omit quotation marks. Stop at punctuation,
    // adversatives, or the beginning of a clearly separate first-person judgement.
    const boundary = tail.search(/[，,；;。！？]|(?:但是|然而|不過|可是|但)(?!是)|(?:我(?:認為|判斷|查驗|檢查|覺得|不同意|不認同)|本人(?:認為|判斷|查驗))/);
    const attributedPart = boundary >= 0 ? tail.slice(0, boundary) : tail;
    return beastVerdictsInText(attributedPart);
  }

  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function isInsideQuotedSpan(text, index) {
    const s = String(text || '');
    const pairs = [['「', '」'], ['『', '』'], ['“', '”']];
    for (const [open, close] of pairs) {
      let cursor = 0;
      while (cursor < s.length) {
        const start = s.indexOf(open, cursor);
        if (start < 0 || start > index) break;
        const end = s.indexOf(close, start + 1);
        if (end < 0) return index >= start;
        if (index >= start && index < end) return true;
        cursor = end + close.length;
      }
    }
    // Straight quotes use the same marker to open and close.
    const straight = [...s.slice(0, index)].filter(c => c === '"').length;
    return straight % 2 === 1;
  }

  function historicalFocusMatches(entries, source, target, room) {
    return entries.some(entry => {
      if (String(entry.speech.playerId) !== String(source.id)) return false;
      const raw = String(entry.speech.text || '');
      // 解析原始文字，不採信舊版保存的 callSuspectId 或摘要。
      let parsed = {};
      try { parsed = Claims.parse(raw, room, entry.round); } catch (_) {}
      return String(parsed.callSuspectId || '') === String(target.id);
    });
  }

  function historicalRoleLinkMatches(entries, source, target, role, room) {
    const aliases = [target && target.name, target && U.tag(target)];
    try { const color = target && U.colorOf(target); if (color && color.name) aliases.push(color.name); } catch (_) {}
    const targetPattern = [...new Set(aliases.filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    if (!targetPattern) return false;
    const rolePattern = escapeRegExp(role);
    const direct = new RegExp(`(?:${targetPattern})[^，。！？；\\n]{0,16}(?:是|為|當作|可能是|疑似|像是|懷疑是|指稱為|指認為|宣稱是|聲稱是|認為是)[^，。！？；\\n]{0,8}${rolePattern}`);
    const reverse = new RegExp(`${rolePattern}[^，。！？；\\n]{0,14}(?:可能是|疑似|就是|其實是|是|為)[^，。！？；\\n]{0,8}(?:${targetPattern})`);
    return entries.some(entry => {
      if (String(entry.speech.playerId) !== String(source.id)) return false;
      // Engine.speak stores Claims.parse(text) in p; use the recorded public accusation first,
      // then the text heuristic for older/imported records without structured accuse metadata.
      let parsed = {};
      try { parsed = Claims.parseRecord(entry.speech, room, entry.round); } catch (_) {}
      if ((parsed.accuse || []).some(a => String(a.playerId) === String(target.id) && a.role === role)) return true;
      const text = String(entry.speech.text || '');
      return text.includes(role) && (direct.test(text) || reverse.test(text));
    });
  }

  function historicalSelfRoleMatches(entries, source, role, room) {
    return entries.some(entry => {
      if (String(entry.speech.playerId) !== String(source.id)) return false;
      let parsed = {};
      try { parsed = Claims.parseRecord(entry.speech, room, entry.round); } catch (_) {}
      return parsed.selfRole === role;
    });
  }

  function auditPublicConsistency(text, room, bot, plan, A) {
    const s = String(text || '').trim();
    if (!s || !room || !Claims || typeof Claims.parse !== 'function') return { ok: true };

    // 先檢查未被標記為引用的「自身宣稱」是否對同一獸首同時判真又判假。
    const parsed = Claims.parse(s, room);
    const verdicts = new Map();
    for (const claim of (parsed.claims || [])) {
      if (!claim || !claim.beast || typeof claim.real !== 'boolean') continue;
      if (!verdicts.has(claim.beast)) verdicts.set(claim.beast, new Set());
      verdicts.get(claim.beast).add(claim.real);
    }
    for (const [beast, values] of verdicts.entries()) {
      if (values.size > 1) return { ok: false, why: `同一段發言對【${beast}】同時宣稱真品與贗品` };
    }

    // 「這與我的查驗一致」會把前面的引述變成發言者自己的背書；不能再反向主張。
    const own = new Map((parsed.claims || []).filter(c => c && c.beast && typeof c.real === 'boolean').map(c => [c.beast, c.real]));
    // 限定在同一個完整句子內判斷「這與我的查驗一致」，避免把全篇不同位置的引述錯誤串在一起。
    const sentences = s.split(/(?<=[。！？!?])/).filter(Boolean);
    for (const sentence of sentences) {
      const endorsement = /(?:一致|吻合|相符|相同|對得上|符合)/.test(sentence) &&
        /(?:我|本人).{0,14}(?:查驗|檢查|掌眼|看到|驗到|檢驗|判斷|結果)/.test(sentence) &&
        /(?:說|宣稱|表示|認為|主張|指出|原話|引用|轉述)/.test(sentence);
      if (!endorsement) continue;
      const quoted = beastVerdictsInText(sentence);
      const quoteMarkers = /(?:說|宣稱|表示|認為|主張|指出|原話|引用|轉述).{0,20}[「『“"]|[「『“"]/;
      if (!quoteMarkers.test(sentence)) continue;
      for (const q of quoted) {
        if (own.has(q.beast) && own.get(q.beast) !== q.real) {
          return { ok: false, why: `引用後表示與自己的查驗一致，卻又反向宣稱【${q.beast}】${own.get(q.beast) ? '真品' : '贗品'}` };
        }
      }
    }

    // 沒有明確栽贓計畫時，引用他人過往發言必須能在當時的公開台詞中找到依據。
    // 壞人仍可在明確的栽贓／角色互換戰術中故意歪曲紀錄；這種行為是策略，不是記憶事實。
    const deliberateFrame = !!(A && A.ctx && !A.ctx.isGood && plan &&
      (plan.ambushFrame || plan.roleSwapTrap || plan.falseAttribution));
    if (deliberateFrame) return { ok: true };

    const entries = allAvailablePublicSpeeches(room);
    const historyCue = /(?:曾|先前|之前|過去|上輪|上一輪|前輪|前一輪|剛才|方才|前面|第\s*(?:\d+|[一二三])\s*輪)/;
    const attributionVerb = /(?:指稱|指認|宣稱|聲稱|說過|說|表示|認為|懷疑|自稱|主張|指出|提過|提及|號召|呼籲)/g;
    const clauses = s.split(/[。！？；\n]+/).filter(Boolean);
    for (const clause of clauses) {
      const players = (room.players || []).map(p => ({ p, index: speechPlayerMentionIndex(clause, p, room) }))
        .filter(x => x.index >= 0).sort((a, b) => a.index - b.index);
      if (!players.length) continue;
      const role = (GD.ROLE_ORDER || []).filter(r => r && clause.includes(r)).sort((a, b) => b.length - a.length)[0] || null;
      attributionVerb.lastIndex = 0;
      let vm;
      while ((vm = attributionVerb.exec(clause))) {
        // An attribution verb inside someone else's quoted sentence is not a new historical assertion.
        if (isInsideQuotedSpan(clause, vm.index)) continue;
        const sourceEntry = players.filter(x => x.index < vm.index).slice(-1)[0];
        if (!sourceEntry) continue;
        const source = sourceEntry.p;
        const subjectTail = clause.slice(sourceEntry.index, vm.index);
        const cueMatches = [...subjectTail.matchAll(new RegExp(historyCue.source, 'g'))];
        if (!cueMatches.length) continue;
        const lastCue = cueMatches[cueMatches.length - 1];
        const betweenCueAndVerb = subjectTail.slice(lastCue.index + lastCue[0].length);
        // Do not accidentally attach an earlier "just said" to the speaker's separate counterclaim
        // after a comma or adversative (e.g. "X just said A, but I believe B").
        if (/[，,。！？；;]/.test(betweenCueAndVerb) || /(?:但|不過|然而|可是|而我|我(?:認為|判斷|查驗|檢查|覺得|不同意|不認同)|本人(?:認為|判斷|查驗))/.test(betweenCueAndVerb)) continue;
        const afterVerb = clause.slice(vm.index + vm[0].length);
        const targets = players.filter(x => x.index >= vm.index + vm[0].length && x.p.id !== source.id);
        const target = targets[0] && targets[0].p;

        // 「某人曾號召集火另一人」屬於可核對的歷史事實，必須在來源玩家原話中
        // 找到明確動員語句；單純追問、質疑或請對方解釋，不能被改寫成集火。
        if (target && /(?:號召|呼籲)/.test(vm[0]) && /(?:集火|指認|看緊|盯緊|抓出|揪出|一起投)/.test(afterVerb) &&
            !historicalFocusMatches(entries, source, target, room)) {
          return { ok: false, why: `歷史歸因沒有公開紀錄支持：找不到${source.name}曾號召集火${target.name}的原話` };
        }

        // 過去角色自稱（「某人先前自稱是方震」）必須真的出現在該玩家的公開發言。
        if (role && (vm[0] === '自稱' || /(?:說自己是|聲稱自己是|宣稱自己是|公開自稱)/.test(afterVerb)) &&
            !historicalSelfRoleMatches(entries, source, role, room)) {
          return { ok: false, why: `歷史歸因沒有公開紀錄支持：${source.name}未曾公開自稱【${role}】` };
        }

        // 某人曾指稱另一位玩家是特定角色，必須能找到同一人的原始公開指控。
        if (target && role && /(?:指稱|指認|懷疑|認為|主張|指出|宣稱|聲稱)/.test(vm[0]) &&
            !historicalRoleLinkMatches(entries, source, target, role, room)) {
          return { ok: false, why: `歷史歸因沒有公開紀錄支持：找不到${source.name}曾指稱${target.name}是【${role}】的原話` };
        }

        // 引述他人以前說某獸首真／假，也要能回到該玩家自己的發言查證。
        if (/(?:說過|說|宣稱|聲稱|表示|認為|主張|指出|提過|提及)/.test(vm[0])) {
          const attributedVerdicts = attributedVerdictsInText(clause, vm.index, vm[0].length);
          for (const verdict of attributedVerdicts) {
            if (!historicalClaimMatches(entries, source, verdict.beast, verdict.real, room)) {
              return { ok: false, why: `歷史歸因沒有公開紀錄支持：找不到${source.name}曾宣稱【${verdict.beast}】${verdict.real ? '真品' : '贗品'}的原話` };
            }
          }
        }
      }
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ 驗證 Gemini 輸出 */

  function auditPrivateThoughtLeakage(text) {
    const s = String(text || '');
    const patterns = [
      /(?:我的|真正的|真實的)?(?:內心|內部)(?:計畫|策略)/,
      /(?:我的)?(?:真正|真實)(?:角色|身分|身份)是/,
      /(?:我的)?秘密同伴(?:是|叫)/,
      /我(?:正在|其實在|這輪在)(?:假扮|假跳)/,
      /我(?:想|要|正在)建立可信度/,
      /我(?:想|要|正在)轉移焦點/,
      /為了隱藏(?:我的)?(?:身分|身份)/,
      /(?:後驗機率|預期保真得分|陣營效益|風險估計|候選池|內部權重)/
    ];
    return patterns.some(pattern => pattern.test(s))
      ? { ok: false, why: '發言洩漏內心計畫或私密決策語言，必須改寫成公開理由' }
      : { ok: true };
  }

  function auditPublicPerformanceClaim(plan, claims, callBeasts) {
    if (!(plan && (plan.confess || plan.evilRolePerformance))) return { ok: true };
    const targetClaims = (Array.isArray(claims) ? claims : []).filter(c => c && c.beast === plan.beast && typeof c.real === 'boolean');
    if (!targetClaims.some(c => c.real === false) || targetClaims.some(c => c.real === true)) {
      return { ok: false, why: '認壞／跳壞必須把同一目標說成贗品，不能一邊認壞一邊替它背書為真品' };
    }
    if (!Array.isArray(callBeasts) || !callBeasts.includes(plan.beast)) {
      return { ok: false, why: '認壞／跳壞的公開號召必須指向同一尊贗品' };
    }
    return { ok: true };
  }

  // 方震不得洩漏自己的真實角色，但引用別人公開提到「方震」不等於自曝。
  function disclosesFangIdentity(text) {
    const s = String(text || '').replace(/[【】「」『』]/g, '');
    return /(?:我|本人)(?:(?:真實|真正)?的?(?:角色|身分|身份)(?:是|為)?|其實|就是|才是|是|身為|作為|扮演|假扮|這個|這張)\s*(?:一名)?方震/.test(s) ||
      /方震[^，。！？；;]{0,5}(?:是我|就是我|為我|屬於我|我的(?:真實)?(?:角色|身分|身份))/.test(s);
  }

  function isFillerAcknowledgement(text) {
    return /(?:我(?:有)?(?:聽到|聽見|收到)(?:了)?|我的?這邊(?:有)?收到|我記下了)/.test(String(text || ''));
  }

  function validate(text, bot, room, plan, A) {
    if (!text || typeof text !== 'string') return { ok: false, why: '空回應' };
    const s = text.trim();
    if (!s) return { ok: false, why: '空白回應' };
    if (isFillerAcknowledgement(s)) return { ok: false, why: '含有空泛承接語，應直接回應立場或證據' };
    // 允許回顧「已經出現過」的前輪獸首（每隻生肖整局只會出現一次），但不得提到從未出現的生肖
    const seen = new Set(room.rounds.slice(0, room.currentRoundIdx + 1).flatMap(r => r.beasts.map(b => b.name)));
    const mentioned = [...s.matchAll(/【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】/g)].map(m => m[1]);
    if (mentioned.some(n => !seen.has(n))) return { ok: false, why: '提到從未出現過的獸首' };
    const publicAudit = auditPublicConsistency(s, room, bot, plan, A);
    if (!publicAudit.ok) return publicAudit;
    const privateLeakAudit = auditPrivateThoughtLeakage(s);
    if (!privateLeakAudit.ok) return privateLeakAudit;
    const parsed = Claims.parse(s, room);
    if (plan && typeof plan.publicSuspectBrief === 'string' && plan.publicSuspectBrief) {
      const namedTags = Array.isArray(plan.publicSuspectTags) ? plan.publicSuspectTags : [];
      const missingNames = namedTags.filter(tag => !s.includes(tag));
      if (missingNames.length) return { ok: false, why: '終局嫌疑分析漏掉已選定的具體候選人' };
      if (!/(?:嫌疑|懷疑|推測|候選|證據不足|尚未收斂|暫不指認)/.test(s)) {
        return { ok: false, why: '終局嫌疑分析必須區分推測與已確認事實' };
      }
      if (plan.publicLaoCandidateTag) {
        if (!s.includes(plan.publicLaoCandidateTag) || !/老朝奉/.test(s)) {
          return { ok: false, why: '終局發言漏掉有證據支持的老朝奉候選' };
        }
      } else if (!/老朝奉/.test(s) || !/(?:尚未|暫不|無法|還要看|仍需|未能)/.test(s)) {
        return { ok: false, why: '老朝奉證據未收斂時，應說明暫時無法指認' };
      }
      if (namedTags.length < 3 && !/(?:其餘|剩下|其他人|票型|完整發言|發言|傳牌|時序|再看|還要看|待觀察|暫時不下結論|證據不足)/.test(s)) {
        return { ok: false, why: '目前有根據的嫌疑人未滿三名時，應自然交代仍待觀察的資訊' };
      }
    }
    const currentRound = U.curRound(room);
    const humanThread = latestPublicThread(room, currentRound, bot);
    const humanReplyAudit = publicResponseAudit(s, humanThread, bot, plan);
    if (!humanReplyAudit.ok) return humanReplyAudit;

    // If a later speaker already acknowledged the most recent human's same topic, Gemini must not resurrect it.
    // This only suppresses duplicate conversational references; it does not force agreement or alter voting.
    const continuityRound = room.rounds[room.currentRoundIdx];
    const continuityOrder = Array.isArray(continuityRound && continuityRound.speechOrder) ? continuityRound.speechOrder : [];
    const botSpeechIndex = continuityOrder.indexOf(bot.id);
    const earlierSpeeches = (continuityRound && Array.isArray(continuityRound.speeches) ? continuityRound.speeches : [])
      .filter(sp => sp && sp.playerId !== bot.id && (botSpeechIndex < 0 || continuityOrder.indexOf(sp.playerId) < botSpeechIndex))
      .sort((a, b) => (continuityOrder.indexOf(b.playerId) - continuityOrder.indexOf(a.playerId)));
    const latestHumanSpeech = earlierSpeeches.find(sp => sp && sp.playerId !== bot.id);
    if (!plan.confess && latestHumanSpeech) {
      const humanPlayer = U.byId(room, latestHumanSpeech.playerId);
      const humanTag = humanPlayer ? U.tag(humanPlayer) : (latestHumanSpeech.speakerName || '前手玩家玩家');
      const humanParsed = Claims.parseRecord
        ? Claims.parseRecord(latestHumanSpeech, room, continuityRound)
        : Claims.parse(String(latestHumanSpeech.text || ''), room, continuityRound);
      const humanClaims = (humanParsed.claims || []).filter(c => c && c.beast);
      const humanCall = humanParsed.callBeast || (humanParsed.callBeasts || [])[0] || null;
      const humanPos = continuityOrder.indexOf(latestHumanSpeech.playerId);
      const laterSpeeches = earlierSpeeches.filter(sp => {
        const pos = continuityOrder.indexOf(sp.playerId);
        return humanPos >= 0 && pos > humanPos;
      });
      const acknowledged = laterSpeeches.some(sp => {
        const parsedLater = Claims.parseRecord
          ? Claims.parseRecord(sp, room, continuityRound)
          : Claims.parse(String(sp.text || ''), room, continuityRound);
        const laterText = String(sp.text || '');
        const sameBeast = humanClaims.some(hc =>
          ((parsedLater.claims || []).some(lc => lc && lc.beast === hc.beast) && laterText.includes(humanTag)) ||
          (laterText.includes(humanTag) && laterText.includes(B(hc.beast)) && /(?:回應|剛才|你說|原話|宣稱|主張|對照|核對|一致|不同|判斷)/.test(laterText))
        );
        const sameCall = humanCall && ((parsedLater.callBeasts || []).includes(humanCall) || parsedLater.callBeast === humanCall) &&
          (laterText.includes(humanTag) || /(?:剛才|你說|號召|投票|主張)/.test(laterText));
        const sameRole = humanParsed.selfRole && laterText.includes(humanTag) && laterText.includes(humanParsed.selfRole) &&
          /(?:角色|自稱|身分|身份|對跳|主張|版本)/.test(laterText);
        const sameTarget = humanParsed.callSuspectId &&
          (parsedLater.callSuspectId === humanParsed.callSuspectId || (laterText.includes(humanTag) && /(?:疑點|指認|集火|懷疑|質疑|回應)/.test(laterText)));
        return sameBeast || sameCall || sameRole || sameTarget;
      });
      const echoedBeast = humanClaims.some(hc => s.includes(B(hc.beast)) && s.includes(humanTag) &&
        /(?:剛才|原話|先前說|公開說過|你說|你的宣稱|你的說法|你主張)/.test(s));
      const echoedCall = humanCall && s.includes(humanTag) && s.includes(B(humanCall)) &&
        /(?:剛才|原話|先前說|公開說過|你說|你的號召|你的主張)/.test(s);
      if (acknowledged && (echoedBeast || echoedCall)) {
        return { ok: false, why: '重複引用已被後續發言接住的前手玩家主張' };
      }
    }

    // A planned role bluff remains legal, but a cross-round switch must acknowledge the public contradiction.
    const plannedPublicRole = (plan.roleBluff && plan.roleBluff.role) || (plan.fakeFangClaim ? '方震' : null);
    if (plannedPublicRole) {
      let previousPublicRole = null;
      for (let ri = 0; ri < room.currentRoundIdx; ri++) {
        const historicalRound = room.rounds[ri];
        for (const sp of (historicalRound && historicalRound.speeches || [])) {
          if (!sp || String(sp.playerId) !== String(bot.id)) continue;
          let historicalParsed = {};
          try {
            historicalParsed = Claims.parseRecord
              ? Claims.parseRecord(sp, room, historicalRound)
              : Claims.parse(String(sp.text || ''), room, historicalRound);
          } catch (_) {}
          if (historicalParsed && historicalParsed.selfRole) {
            previousPublicRole = {
              role: historicalParsed.selfRole,
              round: Number.isInteger(historicalRound.roundNum) ? historicalRound.roundNum : ri + 1
            };
          }
        }
      }
      const acknowledgesSwitch = previousPublicRole && previousPublicRole.role !== plannedPublicRole &&
        s.includes(previousPublicRole.role) && s.includes(plannedPublicRole) &&
        /(?:矛盾|改口|版本不同|不能同時成立|前後不一致|前後兩個版本|身份主張|身分主張)/.test(s) &&
        /(?:第\s*\d+\s*輪|上(?:一)?輪|前輪|前一輪|先前|之前)/.test(s);
      if (previousPublicRole && previousPublicRole.role !== plannedPublicRole && !acknowledgesSwitch) {
        return { ok: false, why: '跨輪角色改口未交代已公開的身分矛盾' };
      }
    }

    if (plan.trueRoleSignal && plan.trueRoleSignal.line && !s.includes(plan.trueRoleSignal.line)) {
      return { ok: false, why: '真身微跳計畫的指定提示句未納入發言' };
    }
    if (plan.xuYuanLine && !plan.roleBluff && !plan.fakeFangClaim && !plan.confess && !s.includes(plan.xuYuanLine)) {
      return { ok: false, why: '許願自然話術未納入發言' };
    }
    const claims = parsed.claims;
    if (plan.withholdInfo && (plan.withheldClaims || []).some(hidden =>
      claims.some(c => c && c.beast === hidden.beast && c.real === hidden.real)
    )) {
      return { ok: false, why: '保留資訊策略被違反：發言洩漏了已決定隱藏的重複查驗結果' };
    }
    // 認壞／跳壞以「贗品主張＋同目標號召」為硬性契約；一般壞人偽裝好人維持原本帶風向規則。
    const performanceAudit = auditPublicPerformanceClaim(plan, claims, parsed.callBeasts);
    if (!performanceAudit.ok) return performanceAudit;
    if (!plan.confess && !plan.evilRolePerformance && !GD.isGood(bot.role) && ['lie', 'follow'].includes(plan.mode)) {
      const targetClaims = claims.filter(c => c && c.beast === plan.beast && typeof c.real === 'boolean');
      if (!targetClaims.some(c => c.real === true) || targetClaims.some(c => c.real === false)) {
        const modeName = plan.mode === 'lie' ? '帶風向' : '附和';
        return { ok: false, why: `${modeName}計畫要求宣稱【${plan.beast}】為真品` };
      }
    }
    // 許願不可同時報出 2 尊
    if (bot.role === '許願' && new Set(claims.map(c => c.beast)).size >= 2) return { ok: false, why: '許願報了 2 尊' };
    // 好人不得與自己的查驗矛盾
    if (A.ctx.isGood) {
      for (const i of A.ctx.myIns) {
        const c = claims.find(x => x.beast === i.beastName);
        if (c && c.real !== GD.Mind.inspectionTruth(i)) return { ok: false, why: `與自己對【${i.beastName}】的查驗矛盾` };
      }
    }
    // 必須號召落票，且落在計畫的獸首
    if (!parsed.callBeasts.includes(plan.beast)) return { ok: false, why: `沒有號召投【${plan.beast}】` };
    if (plan.bluff && (parsed.unsure || /驗不到|看不懂|看不到|無法辨別/.test(s))) return { ok: false, why: '方震不可說自己驗不到' };
    if (plan.hideBlind && (parsed.blind || /被偷襲|遭偷襲|眼前一片黑|一片黑|偷襲/.test(s))) return { ok: false, why: '被偷襲者不輕易說出被偷襲' };
    // 不得自曝真實角色；預先計畫的假跳方震是明確的戰術例外，且只能報指定對象／陣營。
    if (new RegExp(`我是(?:【)?${bot.role}`).test(s)) return { ok: false, why: '自曝角色' };
    const plannedFangClaim = plan.fakeFangClaim || (plan.roleBluff && plan.roleBluff.role === '方震' && plan.roleBluff.targetId ? plan.roleBluff : null);
    const plannedFakeFangOK = !!plannedFangClaim && parsed.selfRole === '方震' &&
      parsed.campChecks.length === 1 &&
      parsed.campChecks[0].targetId === plannedFangClaim.targetId &&
      parsed.campChecks[0].camp === (plannedFangClaim.isGoodCamp ? 'good' : 'evil');
    const plannedFalseRoleOK = !!plan.roleBluff && parsed.selfRole === plan.roleBluff.role && parsed.selfRole !== bot.role;
    const plannedFalseConfessOK = plannedFalseRoleOK && !!plan.roleBluff.fakeConfess && parsed.selfEvil;
    if ((plan.fakeFangClaim || (plan.roleBluff && plan.roleBluff.role === '方震')) && !plannedFakeFangOK) {
      return { ok: false, why: '假跳方震發言未依計畫報出指定的單一陣營查驗' };
    }
    if (/(我|本人)[^，。！？]{0,4}(查驗|驗)[^，。！？]{0,6}(陣營|是好人|是壞人|為好人|為壞人|老朝奉陣營)/.test(s) && !plannedFakeFangOK) {
      return { ok: false, why: '洩漏陣營查驗（方震身分）' };
    }
    if (parsed.campChecks.length && !plannedFakeFangOK) return { ok: false, why: '洩漏陣營查驗（方震身分）' };
    if (plan.roleBluff && parsed.selfRole !== plan.roleBluff.role) {
      return { ok: false, why: `角色偽裝計畫要求公開假稱【${plan.roleBluff.role}】` };
    }
    if (!plan.roleBluff && !plan.fakeFangClaim && parsed.selfRole && parsed.selfRole !== bot.role) {
      return { ok: false, why: '未計畫的角色偽裝' };
    }
    if (bot.role === '方震' && disclosesFangIdentity(s)) return { ok: false, why: '方震洩漏自己的真實角色' };
    if (plan.confess) {
      /* 認壞只能說「我認壞」，不得報出具體角色（老朝奉 / 藥不然 / 鄭國渠），也不得指名同伴 */
      if (!parsed.selfEvil) return { ok: false, why: '認壞計畫但發言沒有明確認壞' };
      if (/(我|本人|咱)[^，。！？]{0,4}(是|為|當|扮|就是)[^，。！？]{0,3}(老朝奉|藥不然|鄭國渠)|(老朝奉|藥不然|鄭國渠)[^，。！？]{0,4}(是我|就是我|是本人)|(同伴|隊友|搭檔)[^，。！？]{0,4}(是|就是)[^，。！？]{0,3}(老朝奉|藥不然|鄭國渠|【)/.test(s)) {
        return { ok: false, why: '認壞時不得報出自己的具體角色或同伴身分' };
      }
    } else if (!A.ctx.isGood && (parsed.selfEvil || /我是(?:【)?(老朝奉|藥不然|鄭國渠)|我們是壞人|我是壞人/.test(s)) &&
      !(plannedFalseRoleOK && !parsed.selfEvil) && !plannedFalseConfessOK) {
      return { ok: false, why: '壞人自曝' };
    }
    if (A.ctx.isGood && parsed.selfEvil && !plannedFalseConfessOK) return { ok: false, why: '好人不可說自己是壞人' };
    if (plan.askId && !parsed.asked.includes(plan.askId)) return { ok: false, why: '計畫要質問票型，發言卻沒有點名請對方說明' };
    return { ok: true, parsed };
  }

  GD.Speech = { buildPrompt, localSpeech, validate, isFillerAcknowledgement, history, publicVoteCommitmentHistory, auditPublicConsistency,
    latestPublicThread, compactPublicReply, publicResponseAudit, disclosesFangIdentity,
    buildPublicPerformanceContract, auditPublicPerformanceClaim, auditPrivateThoughtLeakage };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Speech;
})(typeof window !== 'undefined' ? window : global);