/* ============================================================================
 * bot/speech.js — 發言生成（基於原版嚴格擴充：緊鄰直踩、首家不反轉與跨輪排除）
 *   buildPrompt   結構化 Prompt：[我是誰與身分][我的私密查驗][前手發言與真人號召紀錄][歷史開票真偽]
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
      // 只提供原始公開台詞。舊版系統摘要曾把「請對方說明」誤標成「號召集火」，
      // 若將摘要再餵給 Gemini，錯誤會被當成歷史事實不斷複製。
      return `- ${U.tag(who)}（傳遞${U.nth(pos)}，${sp.source === 'human' ? '真人' : '電腦'}）原話：「${sp.text}」`;
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
        if (!dominant || dominant.chips < 2) continue;
        const sp = (rd.speeches || []).find(x => String(x.playerId) === String(pid));
        const parsed = Claims.parseRecord
          ? Claims.parseRecord(sp, room, rd)
          : (sp && sp.p && Array.isArray(sp.p.callBeasts) && sp.p.callBeasts.length
            ? sp.p : Claims.parse(String(sp && sp.text || ''), room, rd));
        const calls = [...new Set([...(parsed.callBeasts || []), parsed.callBeast].filter(Boolean))];
        const who = U.byId(room, pid);
        const pos = (rd.passOrder || []).indexOf(pid);
        const total = allocations.reduce((n, x) => n + x.chips, 0);
        const callVotes = calls.reduce((n, name) => n + Math.max(0, Number((ballot || {})[name]) || 0), 0);
        const callShare = total > 0 ? callVotes / total : 0;
        const mismatch = calls.length && callShare < 0.5;
        out.push(`第${r + 1}輪：${U.tag(who)}（傳遞${U.nth(pos)}）共投 ${total} 票，最大集中為${B(dominant.beast)} ${dominant.chips}票${calls.length ? `；口頭號召${calls.map(B).join('、')}，其中 ${callVotes}/${total} 票落在號召目標${mismatch ? '（未達半數，需檢查分票理由）' : '（至少半數與號召一致）'}` : '；當輪沒有可辨識的明確號召'}。這是承諾／配置紀錄，不單憑多投就判好壞。`);
      }
    }
    return out.length ? out.join('\n') : '（尚無前輪多票投入紀錄；本輪仍可能有人將兩票或更多籌碼集中投出）';
  }

  function humanCalls(room) {
    const out = [];
    room.rounds.slice(0, room.currentRoundIdx + 1).forEach((rd, r) => {
      rd.speeches.filter(s => s.source === 'human').forEach(s => out.push(`第${r + 1}輪真人原話：${s.text}`));
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
      ? conflicts.map(c => {
          const spk = U.byId(room, c.speakerId);
          if (c.isAdjacent && c.speakerPos < c.myPos) {
            return `${U.tag(spk)}在${U.nth(c.speakerPos)}緊鄰傳給你${U.nth(c.myPos)}，宣稱${B(c.beast)}${real(c.claim)}，但你親眼看到${real(c.saw)}（中間沒有其他傳遞者，這是高強度矛盾；仍須核對規則上是否可能由他本人觸發技能，不要只憑一句話宣告百分之百定案）`;
          }
          if (c.speakerPos === 0 && c.speakerPos < c.myPos) {
            return `${U.tag(spk)}在第一位（首家不會被反轉）宣稱${B(c.beast)}${real(c.claim)}，但你在${U.nth(c.myPos)}親眼看到${real(c.saw)}（首家資訊通常較少受到後續技能反轉影響；需比較首家是否說謊與後續傳遞區間是否有人擾亂，不能直接把後手判真）`;
          }
          return `${U.tag(spk)}在${U.nth(c.speakerPos)}宣稱${B(c.beast)}${real(c.claim)}，但你在${U.nth(c.myPos)}親眼看到${real(c.saw)}（這是待解釋的矛盾；依雙方位置、反轉可能與其他獨立證據加權，不能只憑矛盾直接定罪）`;
        }).join('\n')
      : '（目前沒有與你查驗直接矛盾的前手宣稱）';
    const top = A.topSuspect;

    const q = plan.askId ? U.byId(room, plan.askId) : null;
    const extra = [
      q ? `額外任務：用一句話點名${U.tag(q)}，指出他過去投給後來公開判為贗品的獸，共計 ${plan.askVotes} 票（最近一次是第 ${plan.askRound} 輪的${B(plan.askBeast)}），請他說明當時的判斷依據。這是事後對照，不得暗示他投票時已知道結果；只引用公開票型，不得提到你的私密查驗。` : '',
      plan.confess ? `額外任務：你被點名要說明投贗品的理由，這次選擇認壞。必須明確說出「我認壞」，承認那些票是故意灌的，並把你真實看到的查驗結果（${plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、') || '無'}）攤開給隊友。嚴禁說出任何具體角色名稱（老朝奉、藥不然、鄭國渠）或同伴是誰。`
        : plan.explain ? `額外任務：${plan.explain.callerName}點名要你說明為什麼把票投在贗品上，請簡短解釋當時的依據，${ctx.isGood ? '並承認被帶了風向' : '維持好人的樣子，不得承認自己是壞人'}。` : '',
      plan.fakeFangClaim ? `戰術任務：你不是真方震，但這輪要冒險假跳方震。必須明確說「我是方震」，並且只按計畫宣稱查驗${U.tag(U.byId(room, plan.fakeFangClaim.targetId))}是${plan.fakeFangClaim.isGoodCamp ? '好人' : '壞人'}；不得改換目標或陣營，後續仍要交代獸首投票理由。` : '',
      plan.roleBluff ? `戰術任務：這輪刻意假稱自己是【${plan.roleBluff.role}】。必須在公開台詞中清楚說出「我是${plan.roleBluff.role}」，不要自曝真實角色；這個假身份是戰術，不代表你真的擁有該角色能力。${plan.roleBluff.role === '方震' && plan.roleBluff.targetId ? `另須宣稱查驗${U.tag(U.byId(room, plan.roleBluff.targetId))}是${plan.roleBluff.isGoodCamp ? '好人' : '壞人'}，不可換目標或陣營。` : ''}${plan.roleBluff.persist ? `這是持續承諾路線：${plan.roleBluff.continued ? '延續前輪已公開的同一身份，不得自行改口或承認真正角色。' : '從本輪開始承諾同一身份；第2、3輪若未出現能直接反駁的公開紀錄，不因壓力而自行改口。'}可以解釋對方提出的具體證據，但不得捏造沒有執行過的技能。` : ''}${plan.roleBluff.fakeConfess ? '另外必須假認壞，清楚說出「我認壞」，但不得承認真正角色或洩漏同伴；這是公開偽裝，會讓對手提高警戒，後續需能承擔反查。' : ''}` : '',
      plan.roleSwapTrap ? `【第二位偷襲第三位的角色互換戰術】內部計畫：第一位是${U.tag(U.byId(room, plan.roleSwapTrap.firstId))}，第二位是${U.tag(U.byId(room, plan.roleSwapTrap.secondId))}，第三位受害者是${U.tag(U.byId(room, plan.roleSwapTrap.victimId))}。你只公開自己的計畫身份宣稱；不要說出真實身份、同伴關係或不存在的技能操作。延續身份交換布局時，說法要和前輪一致。` : '',
      plan.ambushFrame ? `【栽贓戰術】你本輪確實執行了對${U.tag(U.byId(room, plan.ambushFrame.targetId))}的偷襲，並安排把手機直接傳給他。可利用第三位視野受限造成的角色推論混淆對手，但不要在公開發言承認真實角色或直接透露這是栽贓計畫。` : '',
      plan.ambushFrameHypothesis ? `【被偷襲時序假設】你在第三位受到偷襲，僅能提出「第一位可能是藥不然、第二位可能是老朝奉」作為待驗假設；必須明說這不是確定答案，並要求用公開時序、技能紀錄與後續行為核對。` : '',
      plan.trueRoleSignal ? `【真身微跳任務】你是真正持有【${plan.trueRoleSignal.role}】的人，不是假跳。請把這句提示原樣自然地放進發言一次：「${plan.trueRoleSignal.line}」。這只能表現判斷習慣，不得暗示自己有額外或第二筆查驗，不要直接喊出職業，也不要捏造技能操作。` : '',
      plan.xuYuanLine ? `【許願自然話術】請自然使用這句，讓表達風格有變化：「${plan.xuYuanLine}」。不得提及查驗數量、第二尊獸首的結果或暗示自己還藏有另一筆答案。這句話不代表任何新的私密查驗資訊。` : '',
      plan.withholdInfo ? `【保留資訊策略】本輪有 ${plan.withheldClaims.length} 筆私密查驗已被可靠的前三傳遞順位重複提出，而且你的後驗已相當清楚。公開發言只可陳述計畫清單中的結果（${plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、') || '本輪不公開具體查驗真偽'}）；不得透露、暗示或換句話說出被保留獸首的真偽。可以說明自己會依現有公開線索投票，不必重述已知答案。這是策略性保留，不代表你沒有查驗。` : '',
      plan.tacticalLine ? `【全局盤面提示】${plan.tacticalLine}（票數是公開資訊推估，不是已開票事實；不得把估值說成確定結果。）` : ''
    ].filter(Boolean);

    const task = evil
      ? [`1. 先回應前手發言，必要時點出與「你公開的立場」矛盾的人以轉移焦點。`,
         plan.mode === 'lie'
           ? `2. 你要帶風向：宣稱 ${B(plan.beast)} 是真品（你其實看到/判斷它不是），語氣要像認真盤邏輯的好人。`
           : plan.mode === 'follow' ? `2. 附和同伴，順著 ${B(plan.beast)} 的風向推。`
           : `2. 你這輪講真話偽裝：宣稱 ${B(plan.beast)} 是真品。`,
         `3. 結尾明確號召落票 ${B(plan.beast)}${plan.suspectId ? `，並暗示鑑人時可疑對象是 ${U.tag(U.byId(room, plan.suspectId))}` : ''}。`]
      : [`1. 優先回應會改變判斷的新矛盾、獨立來源與多票配置；不要為了每輪都報查驗而重複已被證實的資訊。前三傳遞順位一般資訊噪音較低，但也可能是壞人刻意亂報；第四位以後的宣稱要提高對老朝奉反轉的敏感度，尤其尾家公開說假又把票投向該獸，可能是在逆讀技能，不能機械判壞。`,
         `2. 依你的陣營偽裝/表態：${plan.withholdInfo ? '本輪已有清楚且重複的公開資訊，按【保留資訊策略】不公開被保留的查驗答案；不要說自己沒驗到，也不要用同義句洩漏真偽。' : ''}${plan.fakeFangClaim ? '你正在假跳方震保護真正方震，按額外任務報出指定的單一陣營查驗；不要把它寫成真實角色能力，並繼續說明獸首票向。'
           : bot.role === '許願' ? '本輪只能明確公開 1 尊獸首結果；不要刻意暗示自己還掌握其他查驗，也不要提及查驗數量或把隱藏結果換句話說出。自然說明當前判斷與投票理由即可.'
           : plan.hideBlind ? `你這輪其實被偷襲、什麼都看不到，但絕對不能說出「被偷襲」「眼前一片黑」或「驗不到」（會暴露你的身分價值）。請像親眼查驗過一樣，宣稱 ${B(plan.beast)} 是真品。`
           : plan.bluff ? `你其實看不到獸首，但絕對不能說「我驗不到」（會被藥不然認出）。請像親眼查驗過一樣，宣稱 ${B(plan.beast)} 是真品。`
           : '誠實陳述你看到的，不要暴露自己的技能細節。'}`,
         `3. 明確號召落票 ${B(plan.beast)}${plan.suspectId ? `，並號召鑑人時集火 ${U.tag(U.byId(room, plan.suspectId))}` : ''}${bot.role === '方震' ? (plan.trueRoleSignal ? '。注意：只可原樣使用指定的真身微跳句暗示有另一條人物線索；不得說出「方震」，也不可再新增明確的人物陣營查驗報告' : '。注意：你是方震，絕對不可說出「我查驗過某人陣營」或任何與方震能力有關的字句，集火理由只能用公開的票型、時序與宣稱矛盾') : ''}。`];

    return [
      `你正在玩《古董局中局》8 人桌遊，請以第一人稱產生第 ${ctx.t + 1} 回合的發言（70~110 字，繁體中文，直接輸出台詞，不要加引號、角色名前綴或說明）。`,
      ``,
      `[我是誰與身分]`,
      `你是 ${U.tag(bot)}，人設：${meta.title}；請表現角色個性，但不要固定重複口頭禪或照抄標語；優先回應前手發言、公開宣稱與票型。`,
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
      `【真人原話索引；不得以系統摘要取代原文，也不得把質問／追問解讀成集火】\n${humanCalls(room)}`,
      ``,
      `[傳遞順位與資訊判讀]`,
      `passOrder 是技能與傳遞順位，speechOrder 是發言順序，兩者不可混用。前三置位的資訊通常較乾淨但不是保證可信；第四位以後更要檢查老朝奉反轉和時序。把每個人的宣稱、投票、實際投入幾票分開看；兩票以上集中是更強的行動承諾，但不能單獨證明好壞。`,
      ``,
      `[歷史多票投入與言行對照]`,
      publicVoteCommitmentHistory(room),
      ``,
      `[歷史開票真偽]`,
      history(room),
      ``,
      `[公開資訊回應要求]至少直接回應一位前置玩家本輪公開的獸首宣稱或投票號召：可以認同、反駁或暫列待驗，但不能完全略過。若你投的獸首與對方主張不同，必須說明是因為自己的查驗、順位反轉可能、前二票差或分票收益；不要只用「還要核對公開紀錄」敷衍。若對方資訊有被採納但最後不跟票，也要清楚交代理由。`,
      `[發言要求]`,
      ...task,
      ...(plan.evilStyle ? [plan.evilPosture === 'desperate'
        ? '【逆風強攻】好人目前的已得分估計偏高，我方不能只靠躲藏。把公開發言、已揭露的第二名真偽、票型與傳遞時序連成一條可辯論的推理線，主動質疑關鍵好人並為最後鑑人鋪線；可公開推理，但不得自曝具體壞人角色、不得謊稱自己知道不可能知道的私密情報。'
        : plan.evilPosture === 'conceal'
          ? '【優勢藏身】好人目前的已得分估計偏低，優先隱藏身分、避免每輪都過度強勢；老朝奉可以堅決否認故意帶票，藥不然也可刻意低調或用反向心理製造好人互疑。已知的秘密同伴要互相掩護，但不能在公開發言中直接說出角色身分。'
          : '【混合姿態】依局勢在藏身與主動推理間切換；不要每個壞人都同樣激進或同樣沉默。'] : []),
      ...(plan.inferredBuddyId ? ['【同伴協同】只根據公開線索與公開票型做配合，不要宣稱掌握他人未公開的私密查驗。鄭國渠可透過同一條公開推線、共同支持一尊獸首或適度掩護，讓隊友有機會從行為辨認你的站位。'] : []),
      ...extra,
      `發言事實稽核：只要說「某人曾說／曾指稱／上一輪宣稱」，就必須能在該玩家當時的公開原話中找到依據；若只是自己的推測，要明說「我懷疑／我推測」，不能把推測包裝成歷史事實。引用別人的說法時要清楚標明是對方立場；若說「這與我的查驗一致」，後文不能再把同一獸首反說成相反真偽。角色對跳或換身分可以是戰術，但若改口要回應對手的具體證據或說明戰術目的，不可捏造不存在的技能操作。` ,
      `多票規則：一名玩家可以分配多枚籌碼，公開號召的獸首代表主要票向，不等於整張票單只能有一個目標；不要將合理分票一概視為矛盾。若你主張分票，請根據已知票差、前二名預期保真得分或明確的偽裝／帶風向目的說明理由；不要把尚未結算的未來票數講成已發生事實。` ,
      `硬性規則：提到獸首與玩家一律加【】（例：${B(plan.beast)}、${U.tag(bot)}）；真偽宣稱與落票只限本輪四尊（回顧歷史時可提及前輪獸首）；不得洩漏你的真實角色名稱${evil ? '，更不得承認自己是壞人' : '（除非你是方震亮查驗結果）'}；保持你的人設語氣。`
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
    const priorTexts = [
      ...(ctx.rd?.speeches || []).map(sp => String(sp && sp.text || '')),
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
    // 回應最新一位真人，不限於緊鄰前手；否則真人資訊只要被別的 AI 插話就會消失。
    const lastHuman = !plan.confess
      ? priorSpeeches.find(s => s && s.source === 'human' && s.playerId !== bot.id) || null
      : null;
    let teamResponseLine = '';
    let lastHumanClaimForResponse = null;
    let lastHumanLabelForResponse = '';
    const addTeamResponse = (speakerId, speakerLabel, claim) => {
      if (!claim || !plan.beast || !GD.DialogueBank) return;
      const withheld = (plan.withheldClaims || []).some(c => c && c.beast === claim.beast);
      // Never confirm/deny a private scan that the strategy deliberately withheld from public speech.
      const ownInspect = withheld ? null : (ctx.myIns || []).find(i => i.beastName === claim.beast);
      const ownClaim = (plan.claims || []).find(c => c.beast === claim.beast);
      const assessment = withheld
        ? '這項說法可以用公開票型和來源獨立性核對，我不在這裡透露私密查驗細節'
        : ownInspect
          ? (ownInspect.displayedReal === claim.real
            ? '這和我願意公開的查驗依據一致，可信度因此提高'
            : '這和我的查驗不同，而且還要依順位檢查是否可能受反轉影響')
          : ownClaim
            ? (ownClaim.real === claim.real ? '目前和我的公開立場一致' : '這和我目前的公開立場不同，仍需找獨立依據')
            : '我尚未獨立驗證，會保留為待核對主張';
      const responseSpeaker = U.byId(room, speakerId);
      const stableSpeakerId = responseSpeaker ? (responseSpeaker.botId || responseSpeaker.name || responseSpeaker.id) : speakerLabel;
      const lineSeed = GD.DialogueBank.hash(`${dialogueSeedText}:team-response:${stableSpeakerId}:${claim.beast}:${claim.real}:${plan.beast}`);
      teamResponseLine = GD.DialogueBank.pick('teamResponse', lineSeed, {
        speaker: speakerLabel, beast: claim.beast, verdict: claim.real ? '真品' : '贗品',
        voteBeast: plan.beast, assessment
      });
      parts.push(teamResponseLine);
    };
    if (lastHuman) {
      const humanPlayer = lastHuman.playerId ? U.byId(room, lastHuman.playerId) : null;
      const humanLabel = humanPlayer ? U.tag(humanPlayer) : (lastHuman.speakerName || '真人玩家');
      const parsedHumanText = Claims.parse(String(lastHuman.text || ''), room);
      const humanParsed = lastHuman.p && Array.isArray(lastHuman.p.claims) && lastHuman.p.claims.length
        ? lastHuman.p
        : parsedHumanText;
      const humanClaims = (humanParsed.claims || []).filter(c => c && c.beast);
      const humanClaim = humanClaims.find(c => c.beast === plan.beast)
        || humanClaims.find(c => (plan.claims || []).some(p => p.beast === c.beast))
        || humanClaims[0];

      if (humanClaim) {
        lastHumanClaimForResponse = humanClaim;
        lastHumanLabelForResponse = humanLabel;
        // 若票向不同，留給下方精簡的 teamResponse 說明，避免先重述一遍再重述理由。
        if (humanClaim.beast === plan.beast) {
          const withheldHumanClaim = (plan.withheldClaims || []).some(c => c.beast === humanClaim.beast);
          const visibleOwnClaim = (plan.claims || []).some(c => c.beast === humanClaim.beast);
          // 許願的第二筆私密查驗不是公開資訊；除非它已在本輪公開計畫中，否則禁止拿它來表態。
          const ownInspect = (bot.role === '許願' && !visibleOwnClaim) || withheldHumanClaim
            ? null
            : (ctx.myIns || []).find(i => i.beastName === humanClaim.beast);
          const ownClaim = (plan.claims || []).find(c => c.beast === humanClaim.beast);
          const humanVerdict = humanClaim.real ? '是真品' : '是假品';
          if (withheldHumanClaim) {
            parts.push(`${humanLabel}剛才說「${B(humanClaim.beast)}${humanVerdict}」；這項主張可以直接和公開票型、獨立來源交叉核對，我先不重複已知資訊。`);
          } else if (ownInspect) {
            const aligned = ownInspect.displayedReal === humanClaim.real;
            parts.push(`${humanLabel}剛才說「${B(humanClaim.beast)}${humanVerdict}」，${aligned
              ? '這和我願意公開的查驗依據一致，我會繼續核對其他線索。'
              : '但它和我目前能公開支持的判斷不同，必須再查時序與來源。'}`);
          } else if (ownClaim) {
            const aligned = ownClaim.real === humanClaim.real;
            parts.push(`${humanLabel}剛才說「${B(humanClaim.beast)}${humanVerdict}」，${aligned
              ? '和我目前公開的立場一致，但還要看其他線索。'
              : '和我目前公開的立場不同，得對照其他人的說法再判斷。'}`);
          } else {
            parts.push(choosePhrase([
              `${humanLabel}剛才說「${B(humanClaim.beast)}${humanVerdict}」，我先把這項判斷和已公開的線索對照。`,
              `${humanLabel}剛才的原話是「${B(humanClaim.beast)}${humanVerdict}」；我還要核對其他人的說法能否互相印證。`,
              `我先記下${humanLabel}的宣稱：「${B(humanClaim.beast)}${humanVerdict}」。接著再看其他公開證據是否支持。`,
              `${humanLabel}剛才把立場說得很清楚：「${B(humanClaim.beast)}${humanVerdict}」。我會比對其餘線索，不急著只憑一句話定案。`,
              `針對${humanLabel}剛才的「${B(humanClaim.beast)}${humanVerdict}」，下一步要看其他玩家的公開說法是否一致。`
            ]));
          }
        }
      } else {
        const humanCall = humanParsed.callBeast || (humanParsed.callBeasts || [])[0];
        const currentBeasts = new Set((ctx.rd?.beasts || []).map(b => b.name));
        if (humanCall && currentBeasts.has(humanCall)) {
          parts.push(`${humanLabel}剛才號召投${B(humanCall)}，我會先核對支持這個目標的公開證據，再決定是否跟票。`);
        } else {
          const humanTargetId = humanParsed.callSuspectId || (humanParsed.accuse || []).find(a => a && a.playerId)?.playerId;
          const humanTarget = humanTargetId ? U.byId(room, humanTargetId) : null;
          if (humanTarget) {
            parts.push(`${humanLabel}剛才把疑點指向${U.tag(humanTarget)}，我會把這項指控和他的公開發言、票型交叉核對。`);
          } else {
            const humanText = String(lastHuman.text || '');
            if (/(?:被|遭到?|有人對我).{0,5}(?:偷襲|襲擊|攻擊)|(?:偷襲|襲擊|攻擊)我/.test(humanText)) {
              parts.push(choosePhrase([
                `${humanLabel}說自己被偷襲，但目前還不能據此判定是誰動手；我會留意後續發言和票型。`,
                `我先記下${humanLabel}聲稱遭到偷襲；這句話本身還不能指出攻擊者，得再看其他公開線索。`,
                `${humanLabel}提到自己被偷襲，我暫時不認定是哪位玩家所為，先觀察後續證據。`
              ]));
            } else {
              parts.push(choosePhrase([
                `${humanLabel}這句話目前沒有可直接核對的獸首宣稱、投票號召或明確指控；我先保留判斷，等具體線索出現再分析。`,
                `我先記下${humanLabel}的說法；目前還缺少可核對的對象或具體證據，暫時不急著下結論。`
              ]));
            }
          }
        }
      }
    }
    // 若真人的主張與本輪目標不同，清楚說明已納入考慮、但為何暫不跟票。
    if (lastHuman && lastHumanClaimForResponse && lastHumanClaimForResponse.beast !== plan.beast) {
      addTeamResponse(lastHuman.playerId, lastHumanLabelForResponse || lastHuman.speakerName || '真人玩家', lastHumanClaimForResponse);
    } else if (!lastHuman && lastPriorSpeech) {
      const lastParsed = Claims.parseRecord
        ? Claims.parseRecord(lastPriorSpeech, room, ctx.rd)
        : Claims.parse(String(lastPriorSpeech.text || ''), room, ctx.rd);
      const lastClaims = (lastParsed.claims || []).filter(c => c && c.beast && typeof c.real === 'boolean');
      const priorClaim = lastClaims.find(c => c.beast !== plan.beast);
      if (priorClaim) {
        const labelPlayer = U.byId(room, lastPriorSpeech.playerId);
        addTeamResponse(lastPriorSpeech.playerId, labelPlayer ? U.tag(labelPlayer) : (lastPriorSpeech.speakerName || '前手玩家'), priorClaim);
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
    const mine = ctx.myIns;
    if (plan.fakeFangClaim && !plan.confess) {
      const target = U.byId(room, plan.fakeFangClaim.targetId);
      if (target) parts.push(`我是方震，我查驗${U.tag(target)}是${plan.fakeFangClaim.isGoodCamp ? '好人' : '壞人'}，後續請用公開票型反查。`);
    } else if (plan.roleBluff && !plan.confess) {
      const roleTarget = plan.roleBluff.targetId ? U.byId(room, plan.roleBluff.targetId) : null;
      parts.push(plan.roleBluff.role === '方震' && roleTarget
        ? `我是方震，我查驗${U.tag(roleTarget)}是${plan.roleBluff.isGoodCamp ? '好人' : '壞人'}，後續請用公開票型反查。`
        : plan.roleBluff.fakeConfess
          ? `我是${plan.roleBluff.role}，我認壞。先別把這句當成定案，請用接下來的公開票型和角色對跳反查。`
          : `我是${plan.roleBluff.role}，後續請用公開紀錄驗證。`);
      if (plan.roleBluff.persist && !plan.roleBluff.fakeConfess) {
        const denySeed = GD.DialogueBank ? GD.DialogueBank.hash(`${bot.botId || bot.id}:${ctx.t}:${ctx.myPos}:persistent-denial:${plan.roleBluff.role}`) : ctx.t;
        const denial = GD.DialogueBank ? GD.DialogueBank.pick('persistentDenial', denySeed, { role: plan.roleBluff.role, round: ctx.t + 1 })
          : `我不會只因為有人重複質疑就撤回【${plan.roleBluff.role}】的身分主張，請用公開紀錄反駁。`;
        parts.push(denial);
      }
    }
    if (plan.confess) {
      const seen = plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、');
      const f = plan.explain && plan.explain.votes[plan.explain.votes.length - 1];
      parts.push(`被點名了我就直說，我認壞，不再裝了。${f ? `第 ${f.round} 輪那 ${f.n} 票是我故意灌的。` : ''}` +
        `${seen ? `我這輪親眼看到的是${seen}，這是我真實的查驗結果，壞人這邊的朋友可以直接拿去用。` : '我這輪沒有可靠的查驗結果。'}` +
        `其他人不管信不信，總之幫我盯緊誰在亂報、誰在找人，把方震和許願揪出來。`);
    } else if (ctx.isGood) {
      if (plan.claims.length) {
        const sayTxt = plan.claims.map(c => `${B(c.beast)}${real(c.real)}`).join('、');
        if (plan.bluff) {
          const bluffLines = ctx.myPos <= 0
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
    } else if (plan.mode === 'lie' || plan.mode === 'follow') {
      const pr = priorSpeeches.find(s =>
        (s.p?.claims || []).some(c =>
          c && c.real === true && c.beast !== plan.beast &&
          (mine || []).some(i => i && i.beastName === c.beast && i.displayedReal === false)
        )
      );
      if (pr && plan.avoid.length === 0 && rndPick(0.6)) {
        const c = pr.p.claims.find(x =>
          x && x.real === true && x.beast !== plan.beast &&
          (mine || []).some(i => i && i.beastName === x.beast && i.displayedReal === false)
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
        // 優先保留微跳句；若篇幅緊張，先移除一般性的收尾套句，而不刪除查驗或證據。
        const fits = () => parts.join('').length + signalLine.length <= 390;
        const removable = [/我的票投.*但不只憑單一人的說法定案。?$/,
          /我的票投.*這是目前的選擇，還要看後續公開證據能否支撐。?$/,
          /我這輪投.*目前仍需要用已公開的查驗和票型交叉核對。?$/,
          /我這輪選擇投.*若有不同判斷，請提出能核對的線索。?$/];
        for (const re of removable) {
          if (fits()) break;
          const ix = parts.findIndex(part => re.test(String(part || '')));
          if (ix >= 0) parts.splice(ix, 1);
        }
        // The validation contract requires the selected signal, so append it even if the overall fallback needs later compaction.
        // The final compactor will remove non-essential evidence summaries while preserving this exact clue.
        if (!parts.some(part => String(part || '').includes(signalLine))) parts.push(signalLine);
      }
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
      if (sameTargetClaimAlreadyStated) {
        parts.push(`我的票投${B(plan.beast)}；這是本輪的選擇，仍要核對其他公開證據。`);
      } else {
        parts.push(choosePhrase([
          `${citedName}先前說「${B(plan.beast)}是${citedVerdict}」。我這輪投${B(plan.beast)}，也會再比對其他公開證據。`,
          `前面${citedName}公開說過「${B(plan.beast)}是${citedVerdict}」。我的票投${B(plan.beast)}，但不只憑單一人的說法定案。`,
          `${citedName}剛才的原話是「${B(plan.beast)}是${citedVerdict}」。目前我投${B(plan.beast)}，仍要看其他線索能否印證。`
        ]));
      }
    } else if (ctx.t === 0) {
      parts.push(choosePhrase([
        `第一輪還沒有歷史票型可比，我先投${B(plan.beast)}；之後再核對各人的宣稱是否一致。`,
        `目前沒有前輪紀錄可參照，我把票投給${B(plan.beast)}，後續再看公開說法是否經得起比對。`,
        `這是第一輪，暫時沒有舊票型可驗證；我先投${B(plan.beast)}，有具體反證再調整判斷。`
      ]));
    } else {
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
    // probs 是角色 logits 經 softmax 後的相對排序，並非用校準資料驗證過的後驗機率；不公開百分比，避免 98%-100% 假精確。
    const roleTargetId = plan.followHuman && plan.followHuman.targetId || plan.suspectId;
    const roleTargetProfile = roleTargetId && A.prof && A.prof[roleTargetId];
    if (roleTargetProfile && roleTargetProfile.probs) {
      const roleGuess = Object.entries(roleTargetProfile.probs)
        .filter(([role]) => (GD.ROLE_ORDER || []).includes(role))
        .sort((a, b) => b[1] - a[1])[0];
      if (roleGuess && Number(roleGuess[1]) >= 22) {
        const targetPlayer = U.byId(room, roleTargetId);
        const roleLine = `依我目前整理的角色線索，${U.tag(targetPlayer)}在相對嫌疑排序中是【${roleGuess[0]}】的優先核查候選；這不是校準過的機率，也不能單憑排序定案，還要核對技能時點與原始公開紀錄。`;
        if (targetPlayer && parts.join('').length + roleLine.length <= 385) parts.push(roleLine);
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
    // Keep all mandatory claims / planned identity / target vote, but drop optional evidence summaries
    // as whole sentences when the fallback would exceed the validator's 420-character limit.
    const voteTag = B(plan.beast);
    const mandatory = part => {
      const text = String(part || '');
      if (plan.roleBluff && text.includes(`我是${plan.roleBluff.role}`)) return true;
      if (plan.fakeFangClaim && text.includes('我是方震')) return true;
      if (plan.trueRoleSignal && plan.trueRoleSignal.line && text.includes(plan.trueRoleSignal.line)) return true;
      if (plan.xuYuanLine && text.includes(plan.xuYuanLine)) return true;
      if (teamResponseLine && text === teamResponseLine) return true;
      if (plan.claims && plan.claims.some(c => text.includes(B(c.beast)) && (c.real ? /真品|是真|判真|真（/.test(text) : /贗品|假品|是假|判假/.test(text)))) return true;
      if (text.includes(voteTag) && /(?:投|落票)/.test(text)) return true;
      return false;
    };
    const compactParts = safeParts.slice();
    const dropMatchers = [
      /跨輪證據鏈|跨輪票型對照|跨輪公開結果對照/,
      /(?:剛才說|先前說|公開說過|原話是|曾公開指稱)/,
      /這項懷疑仍需要其他公開線索印證|大家先別急著跟票/,
      /目前對.+?的公開行動(?:仍有疑問|保留疑問)/,
      /相對嫌疑排序中是|優先核查候選/,
      /這個身份故事能否|這個身分故事能否/,
      /同一項結果被重複提起/,
      /鑑人時我建議大家看緊/,
      /曾號召大家集火|號召大家集火/,
      /我先記下.+?(?:說法|聲稱)/
    ];
    const joinLength = () => compactParts.join('').length;
    for (const matcher of dropMatchers) {
      while (joinLength() > 420) {
        const index = compactParts.findIndex(part => !mandatory(part) && matcher.test(String(part || '')));
        if (index < 0) break;
        compactParts.splice(index, 1);
      }
    }
    while (joinLength() > 420) {
      const index = compactParts.findIndex(part => !mandatory(part));
      if (index < 0) break;
      compactParts.splice(index, 1);
    }
    let assembled = compactParts.join('');
    const tacticalLine = String(plan.tacticalLine || '').trim();
    const safeTacticalLine = bot.role === '方震' && tacticalLine.includes('方震') ? '' : tacticalLine;
    if (safeTacticalLine && assembled.length + safeTacticalLine.length + 1 <= 420) {
      assembled += (assembled && !/[。！？]$/.test(assembled) ? '。' : '') + safeTacticalLine;
    }
    const localAudit = auditPublicConsistency(assembled, room, bot, plan, A);
    if (!localAudit.ok) {
      if (process.env.DEBUG_SPEECH_AUDIT) console.error('LOCAL_AUDIT', bot.name, bot.role, plan.mode, localAudit.why, '\nTEXT=', assembled);
      // Remove only the sentence that fails the public-fact audit; preserve any planned bluff, role claim,
      // true-role signal and ballot call elsewhere in the generated local speech.
      const sentenceParts = assembled.match(/[^。！？!?]+[。！？!?]?/g) || [assembled];
      const kept = sentenceParts.filter(part => auditPublicConsistency(part, room, bot, plan, A).ok);
      const sanitized = kept.join('');
      if (sanitized && auditPublicConsistency(sanitized, room, bot, plan, A).ok) return sanitized;

      // Last-resort construction retains required strategy contracts instead of dropping all role-play.
      const safeParts = [];
      const visibleClaims = (plan.claims || []).filter(c => c && c.beast &&
        (ctx.rd.beasts || []).some(b => b.name === c.beast));
      if (!ctx.isGood && !plan.confess && ['lie', 'follow'].includes(plan.mode)) {
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
      if (plan.xuYuanLine && !safeParts.some(part => part.includes(plan.xuYuanLine))) safeParts.push(plan.xuYuanLine);
      safeParts.push(`我把${B(plan.beast)}列為主要票向，並號召投${B(plan.beast)}；若有分票，應按票差與預期保真得分判斷。`);
      return safeParts.join('');
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

  function validate(text, bot, room, plan, A) {
    if (!text || typeof text !== 'string') return { ok: false, why: '空回應' };
    const s = text.trim();
    if (s.length < 25 || s.length > 420) return { ok: false, why: `長度 ${s.length} 不合理` };
    // 允許回顧「已經出現過」的前輪獸首（每隻生肖整局只會出現一次），但不得提到從未出現的生肖
    const seen = new Set(room.rounds.slice(0, room.currentRoundIdx + 1).flatMap(r => r.beasts.map(b => b.name)));
    const mentioned = [...s.matchAll(/【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】/g)].map(m => m[1]);
    if (mentioned.some(n => !seen.has(n))) return { ok: false, why: '提到從未出現過的獸首' };
    const publicAudit = auditPublicConsistency(s, room, bot, plan, A);
    if (!publicAudit.ok) return publicAudit;
    const parsed = Claims.parse(s, room);
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
    // lie 與 follow 都要求宣稱計畫指定的獸首為真品
if (
  !A.ctx.isGood &&
  ['lie', 'follow'].includes(plan.mode)
) {
  const targetClaims = claims.filter(
    c => c.beast === plan.beast
  );

  if (
    !targetClaims.some(c => c.real) ||
    targetClaims.some(c => !c.real)
  ) {
    const modeName = plan.mode === 'lie' ? '帶風向' : '附和';

    return {
      ok: false,
      why: `${modeName}計畫要求宣稱【${plan.beast}】為真品`
    };
  }
}
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
    if (/方震/.test(s) && bot.role === '方震') return { ok: false, why: '方震提到自己的角色名' };
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

  GD.Speech = { buildPrompt, localSpeech, validate, history, publicVoteCommitmentHistory, auditPublicConsistency };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Speech;
})(typeof window !== 'undefined' ? window : global);