/* ============================================================================
 * bot/review.js — AI Deduction Mind-Map（終局推理覆盤・基於原版擴充首家鐵律與跨輪排除）
 *
 * 覆盤內容全部取自賽中寫入的 round.mind[botId]（當時的推理依據、後驗機率、查驗矛盾、
 * 發言計畫），再對照終局揭曉的真相產生「事後檢討」，不是事後編故事。
 * 本模組只產生資料結構，HTML 由 ui/gameover.js 渲染。
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});
  const { U } = GD;
  const B = n => `【${n}】`;
  const real = v => (v ? '真品' : '贗品');

  /** 整理在 bot 發言當下，場上已經發言過的前置位與後置位玩家宣稱摘要 */
  function buildPriorSpeechesNote(room, rd, bot) {
    const speeches = rd.speeches || [];
    const mySpIdx = speeches.findIndex(s => s.playerId === bot.id);
    const priorSpeeches = mySpIdx >= 0 ? speeches.slice(0, mySpIdx) : speeches;
    if (!priorSpeeches.length) return '（我是本輪第一位發言，尚無其他已發言玩家的宣稱資訊）';

    const myPassIdx = rd.passOrder.indexOf(bot.id);
    const preItems = [];
    const postItems = [];

    priorSpeeches.forEach(s => {
      if (s.playerId === bot.id) return;
      const spk = U.byId(room, s.playerId);
      if (!spk) return;
      const passIdx = rd.passOrder.indexOf(s.playerId);
      const posLabel = passIdx >= 0 ? U.nth(passIdx) : '未知順位';
      const colorName = U.colorOf(spk).name;

      // 優先從發言解析結構 (s.p.claims) 或電腦決策 (rd.mind) 提取宣稱
      const claims = (s.p && s.p.claims && s.p.claims.length)
        ? s.p.claims
        : (rd.mind[s.playerId] && rd.mind[s.playerId].claims) || [];

      let actDesc = '';
      if (claims.length) {
        actDesc = `宣稱${claims.map(c => `${B(c.beast)}${c.real ? '真' : '假'}`).join('、')}`;
      } else if (s.p && s.p.blind) {
        actDesc = '宣稱被偷襲';
      } else if (s.p && s.p.blocked) {
        actDesc = '宣稱無法查驗';
      } else if (s.pass) {
        actDesc = '選擇過麥';
      } else {
        actDesc = s.summary ? s.summary : '未明確報出獸首真偽';
      }

      const entry = `${posLabel}: [${colorName}] ${actDesc}`;
      if (myPassIdx >= 0 && passIdx >= 0 && passIdx < myPassIdx) {
        preItems.push({ passIdx, text: entry });
      } else {
        postItems.push({ passIdx, text: entry });
      }
    });

    preItems.sort((a, b) => a.passIdx - b.passIdx);
    postItems.sort((a, b) => a.passIdx - b.passIdx);
    const all = [...preItems.map(x => x.text), ...postItems.map(x => x.text)];
    return all.length ? `（${all.join('，')}）` : '';
  }

  /** 單輪覆盤：把當時的推理說成「有理有據」的句子 */
  function reviewRound(room, bot, r) {
    const rd = room.rounds[r], m = rd.mind[bot.id];
    const log = rd.turnLogs[bot.id] || { inspect: [] };
    const sp = rd.speeches.find(s => s.playerId === bot.id);
    const ballot = rd.votes[bot.id] || {};
    const vr = rd.voteResults;
    const good = GD.isGood(bot.role);
    const out = { round: r + 1, steps: [], speech: sp ? sp.text : null, speechSource: sp ? sp.source : null, geminiNote: m && m.geminiNote };

    /* ① 資訊：我知道什麼 */
    const seen = (log.inspect || []).map(i => i.resultText).join('、');
    out.steps.push({ k: '我掌握的資訊', v: log.blind
      ? `第 ${r + 1} 輪我在${U.nth(rd.passOrder.indexOf(bot.id))}遭偷襲致盲，什麼都看不到${log.fangTargetId ? '' : '。'}`
      : `${U.nth(rd.passOrder.indexOf(bot.id))}查驗：${seen || '無獸首查驗'}${log.fangTargetId ? `；方震查驗${U.tag(U.byId(room, log.fangTargetId))}為${log.fangCamp === 'evil' ? '壞人' : '好人'}` : ''}${log.ability && log.ability !== '無技能操作' ? `；技能：${log.ability}` : ''}` });

    /* ①-b 傳遞動機：為什麼把手機傳給他（決策當下寫入 log.passWhy；尾家無人可傳）*/
    {
      const nxt = U.byId(room, log.nextPlayerId);
      const isTail = rd.passOrder.length && rd.passOrder[rd.passOrder.length - 1] === bot.id;
      const who = nxt ? `把手機傳給${U.tag(nxt)}（${GD.isGood(nxt.role) ? '好人陣營' : '壞人陣營'}【${nxt.role}】）` : '';
      if (nxt && log.passWhy) {
        out.steps.push({ k: '傳遞動機', v: `${who}。動機：${log.passWhy}。` });
      } else if (isTail) {
        out.steps.push({ k: '傳遞動機', v: `我是第 ${r + 1} 輪的尾家，手機不用再傳，由我結束查驗進入發言，下一回合也由我起手。` });
      }
    }

    /* ② 矛盾：前手 vs 我（含緊鄰直踩、首家不反轉鐵律與跨輪排除法） */
    if (m && m.conflicts.length) {
      const elimSet = new Set(m.eliminatedFromLaoIds || []);
      const interSet = new Set(m.laoIntersectIds || []);
      m.conflicts.forEach(c => {
        const spk = U.byId(room, c.speakerId);
        // ★ 完整列出所有前置區間人選，移除原本的 .slice(0, 4) 截斷
        const mids = (c.between || []).map(id => U.tag(U.byId(room, id))).filter(Boolean);
        const spkReal = spk ? (GD.isGood(spk.role) ? '好人' : '壞人') : '?';
        const elimTags = (c.between || []).filter(id => elimSet.has(id)).map(id => U.tag(U.byId(room, id))).filter(Boolean);
        const interTags = (c.between || []).filter(id => interSet.has(id)).map(id => U.tag(U.byId(room, id))).filter(Boolean);
        const crossNote = (elimTags.length > 0 && interTags.length > 0)
          ? `；結合前輪老朝奉反轉區間交叉比對，可把${elimTags.join('、')}排除，將老朝奉鎖定在${interTags.join('、')}之中`
          : '';

        let inferClause = '';
        if (c.isAdjacent && c.speakerPos < c.myPos) {
          inferClause = `因為${U.nth(c.speakerPos)}直接傳給我${U.nth(c.myPos)}，中間完全沒別人，我直接斷定不是${U.tag(spk)}在說謊騙票，就是他本人按下了老朝奉擾亂。`;
        } else if (c.speakerPos === 0 && c.speakerPos < c.myPos) {
          inferClause = `因為第一位（首家）絕對不會被擾亂反轉，因此若${U.tag(spk)}不是壞人說謊，就必定是排在我前面的行動者（${mids.join('、')}）有人啟動了老朝奉擾亂，把我${U.nth(c.myPos)}的查驗視野反轉了${crossNote}。`;
        } else {
          inferClause = `因此我推測${mids.length > 1 ? `中間（${mids.join('、')}）有人啟動老朝奉反轉，或` : ''}他本人在說謊${crossNote}。`;
        }

        let revealClause = '';
        if (spk && !GD.isGood(spk.role)) {
          revealClause = `【事後揭曉】${U.tag(spk)}真身是${spk.role}（${spkReal}）——我的懷疑正確。`;
        } else if (c.speakerPos === 0) {
          revealClause = `【事後揭曉】${U.tag(spk)}真身是${spk && spk.role}（${spkReal}）——他是首家不會被反轉，確實是後續傳遞區間內的老朝奉啟動了擾亂，把我${U.nth(c.myPos)}看到的結果反轉了。`;
        } else if (c.myPos === 0) {
          revealClause = `【事後揭曉】${U.tag(spk)}真身是${spk && spk.role}（${spkReal}）——我是首家看到真身，他在${U.nth(c.speakerPos)}其實是被擾亂反轉而不自知。`;
        } else {
          revealClause = `【事後揭曉】${U.tag(spk)}真身是${spk && spk.role}（${spkReal}）——我們之間的傳遞區間被老朝奉擾亂切開，導致好人視野相反。`;
        }

        out.steps.push({
          k: '發現查驗矛盾',
          v: `第 ${r + 1} 輪我發現前手${U.tag(spk)}在${U.nth(c.speakerPos)}報${B(c.beast)}${c.claim ? '真' : '假'}，但我在${U.nth(c.myPos)}看到的是${c.saw ? '真' : '假'}，${inferClause}${revealClause}`
        });
      });
    }

    /* ③ 推論：世界線後驗 */
    if (m) {
      const laoIdx = m.laoAt.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0])[0];
      const actual = rd.beasts.map(b => `${B(b.name)}${b.isReal ? '真' : '假'}`).join(' ');
      out.steps.push({ k: '世界線推演', v: `綜合我的查驗與全場宣稱，我估計 ${m.post.map(b => `${B(b.name)}為真 ${Math.round(b.p * 100)}%`).join('、')}` +
        (laoIdx && laoIdx[0] > 0.12 && laoIdx[1] < 8 ? `；並認為老朝奉在${U.nth(laoIdx[1])}擾亂的機率約 ${Math.round(laoIdx[0] * 100)}%` : '') +
        `。【事後揭曉】實際為 ${actual}${rd.laoActive ? '，本輪老朝奉確實啟動過擾亂' : '，本輪沒有擾亂'}。` });

      /* ④ 發言動機：為什麼這樣說 ＋ 當時接收到的前/後置位已發言玩家宣稱資訊 */
      const myPosTxt = rd.passOrder.indexOf(bot.id) >= 0 ? `我在${U.nth(rd.passOrder.indexOf(bot.id))}查驗，` : '';
      const heardNote = buildPriorSpeechesNote(room, rd, bot);
      const baseWhy = (m.why || []).join('；') + (m.mode === 'lie' ? '。（我刻意與自己的所見相反，目的在帶偏好人籌碼。）' : '。');
      out.steps.push({ k: '發言動機', v: `${myPosTxt}${baseWhy}${heardNote}` });

      // v10：把決策時的票數預測、前二機率、分票結果和保真得分估值顯示在覆盤，方便與實際開票比較。
      const vf = m.voteForecast;
      if (vf && Array.isArray(vf.ranking) && vf.ranking.length) {
        const rows = vf.ranking.map(x => `${B(x.name)}預估 ${Number(x.expectedVotes || 0).toFixed(1)} 票（已落 ${Number(x.observedVotes || 0)} 票、前二機率 ${Math.round((Number(x.pTopTwo) || 0) * 100)}%）`);
        out.steps.push({
          k: '全局算票預測',
          v: `決策時預估：${rows.join('；')}。這是依公開發言與已落票推算，不是已開票結果。`
        });
      }
      const projection = m.scoreProjection;
      if (projection) {
        out.steps.push({
          k: '保真得分估值',
          v: `決策時保真分數約 ${Number(projection.expectedSavedReal || 0).toFixed(1)} 分（公開第二名確真累積 ${Number(projection.publicRank2RealPoints || 0).toFixed(0)} 分；封存第一名期望貢獻 ${Number(projection.hiddenRank1Expected || 0).toFixed(1)} 分）；距 ${projection.winScore} 分門檻約差 ${Number(projection.pointsNeededBeforeRoleBonuses || 0).toFixed(1)} 分。此為估值，最後還要計入鑑人與角色任務。`
        });
      }
      const bm = m.ballotModel;
      if (bm && Array.isArray(bm.after)) {
        const after = bm.after.map(x => `${B(x.name)}約 ${Number(x.expectedVotes || 0).toFixed(1)} 票／前二 ${Math.round((Number(x.pTopTwo) || 0) * 100)}%`);
        out.steps.push({
          k: '分票方案覆盤',
          v: `目標錨點【${bm.anchor || m.beast || '?'}】；實際花費 ${Number(bm.spent || 0)} 票、保留 ${Number(bm.held || 0)} 票；模型目標 ${bm.objective || '依陣營評估'}。套用本次票型後的估算：${after.join('；')}。`
        });
      }
    }

    /* ⑤ 投票 */
    const ballotTxt = Object.entries(ballot).filter(([, n]) => n > 0).map(([k, n]) => `${B(k)}${n}票`).join('、') || '全數保留至下輪';
    let verdict = '';
    Object.keys(ballot).forEach(name => {
      const b = rd.beasts.find(x => x.name === name);
      if (!b) return;
      verdict += good
        ? (b.isReal ? `${B(name)}確為真品，這票投對了。` : `${B(name)}實為贗品，這票被騙了。`)
        : (b.isReal ? `${B(name)}其實是真品，我反而幫好人加了分。` : `${B(name)}是贗品，成功抬轎。`);
    });
    out.steps.push({ k: '投票與結果', v: `我投了 ${ballotTxt}。${verdict}${vr ? `開票後第二名 ${B(vr.rank2.name)} 公開為${real(vr.rank2.isReal)}，第一名 ${B(vr.rank1.name)}（${vr.rank1.votes} 票）被封存${vr.rank1.isReal ? '，實為真品' : '，實為贗品'}。` : ''}` });
    return out;
  }

  /** 終局鑑人決策說明 */
  function reviewFinal(room, bot) {
    const tid = room.personVotes[bot.id], tgt = U.byId(room, tid), f = bot.final || {};
    const hit = (() => {
      if (!tgt) return '';
      if (bot.role === '老朝奉') return tgt.role === '許願' ? '——命中許願！' : `——抓錯了，${tgt.name} 不是許願。`;
      if (bot.role === '藥不然') return tgt.role === '方震' ? '——命中方震！' : `——抓錯了，${tgt.name} 不是方震。`;
      if (bot.role === '鄭國渠') return '（鄭國渠的鑑人票本就無效）';
      return tgt.role === '老朝奉' ? '——命中老朝奉！' : `——抓錯了，${tgt.name} 其實是${tgt.role}。`;
    })();
    const sus = (f.top || []).map(t => {
      const p = U.byId(room, t.id); if (!p) return null;
      return { tag: U.tag(p), role: p.role, evil: t.evil, probs: t.probs, reasons: t.reasons };
    }).filter(Boolean);
    return { text: tgt ? `我把鑑人票投給 ${U.tag(tgt)}（真身【${tgt.role}】）。理由：${f.why || '綜合三輪證據'}${hit}` : '未留下鑑人紀錄', suspects: sus };
  }

  /** 總結：本局這位電腦的表現（給學習引擎的前言）*/
  function reflection(room, bot) {
    const facts = (GD.Learning && GD.Learning.ballotFacts) ? GD.Learning.ballotFacts(room, bot) : { real: 0, fake: 0, duped: [] };
    const good = GD.isGood(bot.role);
    if (good) {
      if (facts.duped.length) {
        const d = facts.duped[0], liar = U.byId(room, d.liarId);
        return `我是好人陣營的【${bot.role}】。第 ${d.round} 輪被 ${U.tag(liar)}（真身【${liar && liar.role}】）帶風向，投了 ${d.n} 票給贗品${B(d.beast)}，這是本局最大的失誤。`;
      }
      return facts.fake ? `我是【${bot.role}】。三輪共 ${facts.real} 票投中真品、${facts.fake} 票落在贗品。` : `我是【${bot.role}】。三輪 ${facts.real} 張選票全數命中真品，沒有被騙票。`;
    }
    return facts.real > facts.fake
      ? `我是【${bot.role}】。三輪我投出 ${facts.real} 張真品票、${facts.fake} 張贗品票，偽裝有餘但干擾不足。`
      : `我是【${bot.role}】。三輪我有 ${facts.fake} 張票灌進贗品、僅 ${facts.real} 張投給真品，控盤成功。`;
  }

  function build(room, bot) {
    return {
      id: bot.id, name: bot.name, role: bot.role, tag: U.tag(bot), colorId: bot.colorId,
      title: (GD.Roster.byId(bot.botId) || {}).title || '',
      rounds: room.rounds.map((_, r) => reviewRound(room, bot, r)),
      reflection: reflection(room, bot),
      final: reviewFinal(room, bot),
      learning: room.learning && room.learning[bot.id] || null
    };
  }

  GD.Review = { build, buildAll: room => room.players.filter(p => p.isBot).map(b => build(room, b)) };
  if (typeof module !== 'undefined' && module.exports) module.exports = GD.Review;
})(typeof window !== 'undefined' ? window : global);