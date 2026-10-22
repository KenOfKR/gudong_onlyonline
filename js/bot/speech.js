/* ============================================================================
 * bot/speech.js — 發言生成
 *   buildPrompt   結構化 Prompt：[我是誰與身分][我的私密查驗][前手發言與真人號召紀錄][歷史開票真偽]
 *   localSpeech   無網路 / Gemini 失敗時的本地說服型發言（同樣含：查驗矛盾→偽裝或帶風向→明確號召）
 *   validate      檢查 Gemini 輸出是否與計畫一致（不得講錯獸首、不得與自己的查驗矛盾、必須號召）
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Claims } = GD;
  const B = n => `【${n}】`;
  const real = v => (v ? '真' : '假');

  /* ------------------------------------------------------------------ 資料整理 */

  function history(room) {
    const t = room.currentRoundIdx;
    const lines = [];
    for (let r = 0; r < t; r++) {
      const rd = room.rounds[r], vr = rd.voteResults;
      if (!vr) continue;
      const votes = rd.beasts.map(b => `${B(b.name)}${vr.totals[b.name]}票`).join('、');
      lines.push(`第${r + 1}輪：${votes}；公開第二名 ${B(vr.rank2.name)} 為${vr.rank2.isReal ? '真品' : '贗品'}；封存第一名 ${B(vr.rank1.name)}（真偽未公開）`);
    }
    return lines.length ? lines.join('\n') : '（第一輪，尚無歷史開票）';
  }

  function priorSpeeches(room) {
    const rd = U.curRound(room);
    if (!rd.speeches.length) return '（你是本輪第一位發言者）';
    return rd.speeches.map(sp => {
      const who = U.byId(room, sp.playerId);
      const pos = rd.passOrder.indexOf(sp.playerId);
      return `- ${U.tag(who)}（傳遞${U.nth(pos)}，${sp.source === 'human' ? '真人' : '電腦'}）：「${sp.text}」\n  系統摘要：${sp.summary}`;
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
    const extra = [
      q ? `額外任務：用一句話點名${U.tag(q)}，說他累計 ${plan.askVotes} 票投在已公開的贗品上（最近是第 ${plan.askRound} 輪的${B(plan.askBeast)}），請他說明依據。只引用公開票型，不得提到你的私密查驗。` : '',
      plan.confess ? `額外任務：你被點名要說明投贗品的理由，這次選擇認壞。必須明確說出「我認壞」，承認那些票是故意灌的，並把你真實看到的查驗結果（${plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、') || '無'}）攤開給隊友。嚴禁說出任何具體角色名稱（老朝奉、藥不然、鄭國渠）或同伴是誰。`
        : plan.explain ? `額外任務：${plan.explain.callerName}點名要你說明為什麼把票投在贗品上，請簡短解釋當時的依據，${ctx.isGood ? '並承認被帶了風向' : '維持好人的樣子，不得承認自己是壞人'}。` : ''
    ].filter(Boolean);

    const task = evil
      ? [`1. 先回應前手發言，必要時點出與「你公開的立場」矛盾的人以轉移焦點。`,
         plan.mode === 'lie'
           ? `2. 你要帶風向：宣稱 ${B(plan.beast)} 是真品（你其實看到/判斷它不是），語氣要像認真盤邏輯的好人。`
           : plan.mode === 'follow' ? `2. 附和同伴，順著 ${B(plan.beast)} 的風向推。`
           : `2. 你這輪講真話偽裝：宣稱 ${B(plan.beast)} 是真品。`,
         `3. 結尾明確號召落票 ${B(plan.beast)}${plan.suspectId ? `，並暗示鑑人時可疑對象是 ${U.tag(U.byId(room, plan.suspectId))}` : ''}。`]
      : [`1. 點出前手與你「查驗結果」的矛盾（見上方【查驗矛盾】；若沒有矛盾，就說明你的查驗與前手吻合並提升可信度）。`,
         `2. 依你的陣營偽裝/表態：${bot.role === '許願' ? '你是許願，只能報出 1 尊獸首，不得暴露你驗了 2 尊。'
           : plan.hideBlind ? `你這輪其實被偷襲、什麼都看不到，但絕對不能說出「被偷襲」「眼前一片黑」或「驗不到」（會暴露你的身分價值）。請像親眼查驗過一樣，宣稱 ${B(plan.beast)} 是真品。`
           : plan.bluff ? `你其實看不到獸首，但絕對不能說「我驗不到」（會被藥不然認出）。請像親眼查驗過一樣，宣稱 ${B(plan.beast)} 是真品。`
           : '誠實陳述你看到的，不要暴露自己的技能細節。'}`,
         `3. 明確號召落票 ${B(plan.beast)}${plan.suspectId ? `，並號召鑑人時集火 ${U.tag(U.byId(room, plan.suspectId))}` : ''}${bot.role === '方震' ? '。注意：你是方震，絕對不可說出「我查驗過某人陣營」或任何與方震能力有關的字句，集火理由只能用公開的票型、時序與宣稱矛盾' : ''}。`];

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
      `硬性規則：提到獸首與玩家一律加【】（例：${B(plan.beast)}、${U.tag(bot)}）；真偽宣稱與落票只限本輪四尊（回顧歷史時可提前輪獸首）；引用他人說法時請寫成「某某說【X】是真」以免被誤認為你自己的宣稱；不得洩漏你的真實角色名稱${evil ? '，更不得承認自己是壞人' : '（除非你是方震亮查驗結果）'}；保持你的人設語氣。`
    ].filter(Boolean).join('\n');
  }

  /* ------------------------------------------------------------------ 本地備援發言 */

  function localSpeech(bot, room, plan, A) {
    const { ctx } = A, meta = GD.Roster.byId(bot.botId) || { phrases: ['我把證據盤清楚'] };
    const opener = meta.phrases[(ctx.t + Math.max(0, ctx.myPos)) % meta.phrases.length] + '！';
    /* 認壞發言不放人設口頭禪：口頭禪常帶「老朝奉」等字樣，和認壞的內容衝突 */
    const parts = plan.confess ? [] : [opener];
    const pos = U.nth(ctx.myPos);

    /* ① 查驗矛盾 */
    const conflicts = Object.values(A.prof).flatMap(r => r.conflicts).filter(c => c.round === ctx.t + 1);
    if (ctx.isGood && conflicts.length) {
      const c = conflicts[0], sp = U.byId(room, c.speakerId);
      const mid = c.between.map(id => U.tag(U.byId(room, id))).filter(Boolean);
      parts.push(`先對時序：${U.tag(sp)}在${U.nth(c.speakerPos)}說${B(c.beast)}是${real(c.claim)}品，但我${pos}親眼看到的是${real(c.saw)}品，兩邊對不上。要嘛他在騙票，要嘛${U.nth(Math.min(c.speakerPos, c.myPos))}到${U.nth(Math.max(c.speakerPos, c.myPos))}之間${mid.length > 1 ? `（${mid.slice(0, 3).join('、')}）` : ''}有人開了擾亂。`);
    } else if (ctx.isGood && ctx.t > 0 && A.topSuspect && A.topSuspect.evil >= 20) {
      /* 只引用 said（可公開的理由）。reasons 含私密依據（方震查驗、同伴身分），絕不可說出口 */
      parts.push(`回頭看前輪鐵證：${U.tag(A.topSuspect.player)}${A.topSuspect.said[0] ? `——${A.topSuspect.said[0]}` : '——票型與發言對不上'}，這輪他推的線請大家特別小心。`);
    } else if (!ctx.isGood && A.topSuspect && ctx.t > 0 && rndPick(0.5)) {
      parts.push(`我也盤了前輪：${U.tag(A.topSuspect.player)}${A.topSuspect.said[0] ? `——${A.topSuspect.said[0]}` : '——票型有點怪'}，大家別被他帶節奏。`);
    }

    /* ①-b 票型質問（好人）：只引用公開的票型，不碰私密依據 */
    if (plan.askId) {
      const q = U.byId(room, plan.askId);
      parts.push(`有件事要請${U.tag(q)}說明一下：你累計 ${plan.askVotes} 票投在已公開的贗品上，最近一次是第 ${plan.askRound} 輪的${B(plan.askBeast)}，票型大家都看得到，你當時的依據是什麼？`);
    }

    /* ①-c 被質問時的回應（好人照實；壞人維持偽裝；認壞見下方 ②）*/
    if (plan.explain && !plan.confess) {
      const f = plan.explain.votes[plan.explain.votes.length - 1];
      parts.push(ctx.isGood
        ? `${plan.explain.callerName}問我為什麼投贗品，我直說：第 ${f.round} 輪我投了 ${f.n} 票給${B(f.beast)}，是依前手宣稱與自己的查驗判斷，結果被帶了風向，我看走眼，這輪我會更謹慎。`
        : `${plan.explain.callerName}問我第 ${f.round} 輪那 ${f.n} 票，我當時是照前手的說法與自己的判斷跟著投，結果看走眼，事後看才知道被帶了風向，這點我認。`);
    }

    /* ② 偽裝 / 帶風向 / 查驗陳述 */
    const mine = ctx.myIns;
    if (plan.confess) {
      const seen = plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、');
      const f = plan.explain && plan.explain.votes[plan.explain.votes.length - 1];
      parts.push(`被點名了我就直說，我認壞，不再裝了。${f ? `第 ${f.round} 輪那 ${f.n} 票是我故意灌的。` : ''}` +
        `${seen ? `我這輪親眼看到的是${seen}，這是我真實的查驗結果，壞人這邊的朋友可以直接拿去用。` : '我這輪沒有可靠的查驗結果。'}` +
        `其他人不管信不信，總之幫我盯緊誰在亂報、誰在找人，把方震和許願揪出來。`);
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

    /* ③ 明確號召 */
    parts.push(`所以這輪我的籌碼全壓${B(plan.beast)}，請大家跟我集中投${B(plan.beast)}！`);
    if (plan.followHuman) {
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
    // 允許回顧「已經出現過」的前輪獸首（每隻生肖整局只會出現一次），但不得提到從未出現的生肖
    const seen = new Set(room.rounds.slice(0, room.currentRoundIdx + 1).flatMap(r => r.beasts.map(b => b.name)));
    const mentioned = [...s.matchAll(/【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】/g)].map(m => m[1]);
    if (mentioned.some(n => !seen.has(n))) return { ok: false, why: '提到從未出現過的獸首' };
    const parsed = Claims.parse(s, room);
    const claims = parsed.claims;
    // 許願不可同時報出 2 尊
    if (bot.role === '許願' && new Set(claims.map(c => c.beast)).size >= 2) return { ok: false, why: '許願報了 2 尊' };
    // 好人不得與自己的查驗矛盾
    if (A.ctx.isGood) {
      for (const i of A.ctx.myIns) {
        const c = claims.find(x => x.beast === i.beastName);
        if (c && c.real !== i.displayedReal) return { ok: false, why: `與自己對【${i.beastName}】的查驗矛盾` };
      }
    }
    // 必須號召落票，且落在計畫的獸首
    if (!parsed.callBeasts.includes(plan.beast)) return { ok: false, why: `沒有號召投【${plan.beast}】` };
    if (plan.bluff && (parsed.unsure || /驗不到|看不懂|看不到|無法辨別/.test(s))) return { ok: false, why: '方震不可說自己驗不到' };
    if (plan.hideBlind && (parsed.blind || /被偷襲|遭偷襲|眼前一片黑|一片黑|偷襲/.test(s))) return { ok: false, why: '被偷襲者不輕易說出被偷襲' };
    // 不得自曝角色（方震尤其致命：說出「我是方震」或「我查驗過某人陣營」，藥不然會直接指認他，送老朝奉陣營 1 分）
    if (new RegExp(`我是(?:【)?${bot.role}`).test(s)) return { ok: false, why: '自曝角色' };
    if (/(我|本人)[^，。！？]{0,4}(查驗|驗)[^，。！？]{0,6}(陣營|是好人|是壞人|為好人|為壞人|老朝奉陣營)/.test(s) || parsed.campChecks.length) {
      return { ok: false, why: '洩漏陣營查驗（方震身分）' };
    }
    if (/方震/.test(s) && bot.role === '方震') return { ok: false, why: '方震提到自己的角色名' };
    if (plan.confess) {
      /* 認壞只能說「我認壞」，不得報出具體角色（老朝奉 / 藥不然 / 鄭國渠），也不得指名同伴 */
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
