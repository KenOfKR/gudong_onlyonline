/* ============================================================================
 * ui/gameover.js — 終局面板（亮色橫幅、傳遞查驗對齊、方震深綠 👍👎、鑑人加寬版）
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, UI, Net } = GD;
  const L = GD.Roster.GENE_LABELS;

  const head = (t, extra = '') => `<div class="b" style="border-bottom:2px solid var(--ink);padding-bottom:3px;margin-bottom:8px">${t}${extra}</div>`;

  function geneBars(res) {
    return GD.Genes.KEYS.map(k => {
      const b = res.before[k], a = res.after[k], d = res.delta[k];
      const lo = Math.min(a, b) * 100, w = Math.max(Math.abs(a - b) * 100, 1.2);
      return `<div class="gene"><span class="b">${L[k]}</span>
        <div class="bar-bg"><i style="left:0;width:${b * 100}%;background:#8c6d46;opacity:.55"></i><i style="left:${lo}%;width:${w}%;background:${d >= 0 ? '#15803d' : '#b91c1c'}"></i></div>
        <span class="mono">${b.toFixed(2)} → <b class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${a.toFixed(2)}</b> <span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">(${d >= 0 ? '+' : ''}${d.toFixed(3)})</span></span></div>`;
    }).join('');
  }

  /** 將單位玩家該回合的獸首查驗結果轉為精煉顯示（字體大小與 黑色・彥 .tag 一致 11px，被封鎖顯示 🔍龍?） */
  function formatPlayerInspectLine(p, l) {
    if (!l) return '';
    // 方震不查驗獸首，直接省略此行（絕不顯示「🔍 無查驗...」）
    if (p && p.role === '方震') return '';
    const insList = l.inspect || [];
    if (l.blind || insList.some(x => x.kind === 'blind')) {
      return `<div style="font-size:11px;font-weight:800;color:#991b1b;line-height:1.3">🔍 🙈 遭偷襲致盲</div>`;
    }
    if (!insList.length) return '';
    const parts = insList.map(ins => {
      if (ins.kind === 'blocked' || ins.kind === 'confused' || ins.displayedReal === null || ins.displayedReal === undefined) {
        return `${ins.beastName}?`;
      }
      return `${ins.beastName}${ins.displayedReal ? '真' : '假'}`;
    });
    return `<div style="font-size:11px;font-weight:800;color:#1e1610;line-height:1.3">🔍 ${U.esc(parts.join('、'))}</div>`;
  }

  /** 將單位玩家該回合的主動技能轉為標籤（字體大小與 黑色・彥 .tag 一致 11px；方震顯示深綠底 🔍驗柚子👍/👎） */
  function formatPlayerSkillLine(p, l, room) {
    if (!l) return '';
    if ((p && p.role === '方震' && l.fangTargetId) || l.fangTargetId) {
      const tgt = U.byId(room, l.fangTargetId);
      const tName = tgt ? tgt.name : '';
      const thumb = l.fangCamp === 'good' ? '👍' : '👎';
      return `<div style="font-size:11px;font-weight:800;background:#14532d;color:#fef3c7;padding:1px 6px;border-radius:4px;display:inline-block;line-height:1.3">🔍驗${U.esc(tName)}${thumb}</div>`;
    }
    if (l.skillTag) {
      return `<div style="font-size:11px;font-weight:800;color:#991b1b;line-height:1.3">${U.esc(l.skillTag)}</div>`;
    }
    return '';
  }

  /** 終局受影響無底色小圖示（🎭擾亂 / ⛓️封印 / 🙈偷襲） */
  function formatAffectedIcons(rd, p, l, posIdx) {
    if (!l || !p) return '';
    const insList = l.inspect || [];
    const wasBlinded = !!(l.blind || insList.some(x => x.kind === 'blind'));
    const wasBlocked = insList.some(x => x.kind === 'blocked');
    const laoIdx = rd.passOrder.findIndex(id => rd.turnLogs[id] && rd.turnLogs[id].skillTag === '🎭擾亂');
    const wasFlipped = insList.some(x => x.flipped === true || (
      x.kind === 'ok' && rd.laoActive && laoIdx >= 0 && posIdx > laoIdx && GD.isGood(p.role) && p.role !== '姬雲浮'
    ));
    const icons = [];
    if (wasBlinded) icons.push('<span title="實際受到偷襲技能影響" style="background:transparent;font-size:13px;line-height:1">🙈</span>');
    if (wasBlocked) icons.push('<span title="實際受到封印技能影響" style="background:transparent;font-size:13px;line-height:1">⛓️</span>');
    if (wasFlipped) icons.push('<span title="實際受到擾亂技能影響" style="background:transparent;font-size:13px;line-height:1">🎭</span>');
    return icons.length ? `<span style="display:inline-flex;align-items:center;gap:1px;background:transparent;margin-left:2px">${icons.join('')}</span>` : '';
  }

  function humanReviewCard(p, room) {
    const good = GD.isGood(p.role);
    const roundsHtml = room.rounds.map((rd, rIdx) => {
      const log = rd.turnLogs[p.id] || { inspect: [] };
      const posIdx = rd.passOrder.indexOf(p.id);
      const posTxt = posIdx >= 0 ? U.nth(posIdx) : '未記錄順位';
      const seenTxt = p.role === '方震'
        ? '（方震不查驗獸首）'
        : log.blind
        ? `在${posTxt}遭偷襲致盲，無法查驗獸首`
        : ((log.inspect || []).map(i => (i.kind === 'blocked' || i.kind === 'confused' || i.displayedReal === null) ? `【${i.beastName}】?（無法辨別真偽）` : i.resultText).join('、') || '無獸首查驗');
      const skillTxt = (log.ability && log.ability !== '無技能操作') ? log.ability : '無主動技能操作';
      const nxt = log.nextPlayerId ? U.byId(room, log.nextPlayerId) : null;
      const isTail = rd.passOrder.length && rd.passOrder[rd.passOrder.length - 1] === p.id;
      const passTxt = nxt ? `傳給 ${U.tag(nxt)}（【${nxt.role}】）` : (isTail ? '本輪尾家（結束查驗進入發言）' : '未指定');
      const sp = (rd.speeches || []).find(s => s.playerId === p.id);
      const ballot = (rd.votes && rd.votes[p.id]) || {};
      const ballotEntries = Object.entries(ballot).filter(([, n]) => n > 0);
      const ballotTxt = ballotEntries.length
        ? ballotEntries.map(([bName, n]) => {
            const bObj = rd.beasts.find(x => x.name === bName);
            const truthTag = bObj ? (bObj.isReal ? '✓真品' : '✕贗品') : '';
            return `【${bName}】${n}票（${truthTag}）`;
          }).join('、')
        : '0 票（全數保留籌碼）';

      return `<div class="panel sm" style="margin-bottom:8px">
        <div class="row between"><b class="red">📍 第 ${rIdx + 1} 回合操作與查驗明細（${posTxt}）</b><span class="xs mute">👤 真人掌眼</span></div>
        ${sp ? `<div class="xs mute" style="font-style:italic;margin:3px 0">發言：「${U.esc(sp.text)}」</div>` : '<div class="xs mute">（本輪未發言）</div>'}
        <div class="step"><b>🔍 查驗獸首</b><span>${U.esc(seenTxt)}</span></div>
        <div class="step"><b>⚡ 技能對象</b><span>${U.esc(skillTxt)}</span></div>
        <div class="step"><b>📱 傳遞下家</b><span>${U.esc(passTxt)}</span></div>
        <div class="step"><b>🗳️ 投票細項</b><span>${U.esc(ballotTxt)}</span></div>
      </div>`;
    }).join('');

    const pvTargetId = room.personVotes && room.personVotes[p.id];
    const pvTarget = pvTargetId ? U.byId(room, pvTargetId) : null;
    let pvVerdict = '';
    if (pvTarget) {
      if (p.role === '老朝奉') pvVerdict = pvTarget.role === '許願' ? '（✓ 精準抓中許願！）' : `（✕ 未抓中許願，對方為【${pvTarget.role}】）`;
      else if (p.role === '藥不然') pvVerdict = pvTarget.role === '方震' ? '（✓ 精準抓中方震！）' : `（✕ 未抓中方震，對方為【${pvTarget.role}】）`;
      else if (p.role === '鄭國渠') pvVerdict = '（鄭國渠鑑人票依規無效）';
      else pvVerdict = pvTarget.role === '老朝奉' ? '（✓ 成功命中老朝奉！）' : `（✕ 誤指【${pvTarget.role}】）`;
    }
    const pvTxt = pvTarget
      ? `終局指認投給 ${U.tag(pvTarget)}（真實身分：【${pvTarget.role}】）${pvVerdict}`
      : '未投出鑑人票';

    return `<details class="mind panel sm" style="padding:0"><summary class="row between wrap">
      <span class="row wrap">${UI.seal(p)}${UI.roleTag(p.role)}<span class="xs">👤 真人玩家（${good ? '許願陣營' : '老朝奉陣營'}）</span></span>
      <span class="xs red">📜 查驗・技能・投票・鑑人明細 ▼ 展開</span></summary>
      <div class="col" style="padding:10px;background:var(--paper-hi)">
        ${roundsHtml}
        <div class="panel sm dark"><b>🎯 終局鑑人明細</b><div class="sm">${U.esc(pvTxt)}</div></div>
      </div></details>`;
  }

  function mindMap(rv, room) {
    const bot = U.byId(room, rv.id), res = rv.learning;
    const rounds = rv.rounds.map(r => `<div class="panel sm" style="margin-bottom:8px">
      <div class="row between"><b class="red">📍 第 ${r.round} 輪推理與操作明細</b>${r.speechSource ? `<span class="xs mute">${r.speechSource === 'gemini' ? '🌐 Gemini 生成' : '🧠 本地推理'}${r.geminiNote ? `（Gemini 未採用：${U.esc(r.geminiNote)}）` : ''}</span>` : ''}</div>
      ${r.speech ? `<div class="xs mute" style="font-style:italic;margin:3px 0">「${U.esc(r.speech)}」</div>` : ''}
      ${r.steps.map(s => `<div class="step"><b>${U.esc(s.k)}</b><span>${U.esc(s.v)}</span></div>`).join('')}</div>`).join('');

    const sus = rv.final.suspects.length ? `<div class="mt xs">${rv.final.suspects.map((s, i) => `<div>${i + 1}. ${U.esc(s.tag)}（真身【${U.esc(s.role)}】）嫌疑 ${s.evil}｜老朝奉 ${s.probs['老朝奉'] ?? '-'}% / 藥不然 ${s.probs['藥不然'] ?? '-'}%${s.reasons.length ? '：' + U.esc(s.reasons.join('；')) : ''}</div>`).join('')}</div>` : '';

    const learn = res ? `<div class="panel sm" style="background:#ecfdf5;border-color:#15803d">
      <div class="row between"><b class="jade">🧬 自我學習與基因修正（BotLearningEngine）</b><span class="tag ${res.won ? 'good' : 'evil'}">${res.won ? '本局獲勝' : '本局落敗'}</span></div>
      <div class="col mt" style="gap:3px">${geneBars(res)}</div>
      <div class="mt">${res.notes.length ? res.notes.map(n => `<div class="xs">• <b class="${n.d > 0 ? 'up' : 'down'}">${L[n.gene]} ${n.d > 0 ? '+' : ''}${(n.d * res.lr).toFixed(3)}</b>：${U.esc(n.why)}</div>`).join('') : '<div class="xs mute">本局表現平穩，沒有需要修正的項目（基因僅向出廠值回歸）。</div>'}</div>
      <div class="xs mute mt">已寫入 localStorage（累計 ${res.games} 局，學習率 ${Math.round(res.lr * 100)}%）。下一局該角色出場就會使用新基因。</div></div>` : '<div class="xs mute">學習結果計算中…</div>';

    return `<details class="mind panel sm" style="padding:0"><summary class="row between wrap">
      <span class="row wrap">${bot ? UI.seal(bot) : ''}${UI.roleTag(rv.role)}<span class="xs mute">🤖 電腦・${U.esc(rv.title)}</span></span>
      <span class="xs red">${res ? '🧬 ' + GD.Genes.KEYS.filter(k => Math.abs(res.delta[k]) >= 0.01).map(k => `${L[k]}${res.delta[k] > 0 ? '↑' : '↓'}`).join(' ') : ''} ▼ 展開</span></summary>
      <div class="col" style="padding:10px;background:var(--paper-hi)">
        ${rounds}
        <div class="panel sm"><b class="red">💡 本局檢討</b><div class="sm">${U.esc(rv.reflection)}</div></div>
        <div class="panel sm dark"><b>🎯 終局鑑人決策</b><div class="sm">${U.esc(rv.final.text)}</div>${sus}</div>
        ${learn}</div></details>`;
  }

  UI.renderGameOver = function (room, me) {
    const box = UI.byId('gameover');
    if (room.status !== 'gameover' || !room.gameOver) { box.hidden = true; return; }
    box.hidden = false;
    const g = room.gameOver;

    /* ★ 1. 獲勝橫幅改為亮色底（使用 !important 壓過原本暗黑 CSS 樣式） */
    const bannerStyle = g.xuWon
      ? 'background:linear-gradient(135deg,#fffbeb 0%,#dcfce7 52%,#fef08a 100%) !important;color:#1e1610 !important;border:2.5px solid #15803d !important;box-shadow:0 6px 20px rgba(21,128,61,0.18) !important;'
      : 'background:linear-gradient(135deg,#fff1f2 0%,#ffedd5 52%,#fecdd3 100%) !important;color:#1e1610 !important;border:2.5px solid #b91c1c !important;box-shadow:0 6px 20px rgba(185,28,28,0.18) !important;';
    const scoreColor = g.xuWon ? '#15803d' : '#b91c1c';

    const banner = `<div style="${bannerStyle}padding:16px;border-radius:12px;text-align:center;margin-bottom:10px">
      <div class="xs b" style="letter-spacing:3px;color:#574534 !important">古董局中局・對局結果</div>
      <div class="xl b" style="font-size:28px;margin:4px 0;color:${scoreColor} !important">${g.xuWon ? '🎉 許願陣營獲勝！' : '😈 老朝奉陣營獲勝！'}</div>
      <div class="mono b" style="font-size:24px;color:${scoreColor} !important">總分 ${g.totalScore} 分</div>
      <div class="grid g4 wrapsm sm mt" style="text-align:left;background:rgba(255,255,255,0.88) !important;border:1.5px solid rgba(30,22,16,0.22) !important;color:#1e1610 !important;padding:10px;border-radius:8px;font-weight:800">
        <div>• 保留真品 <b style="color:#15803d">+${g.savedReal}</b></div>
        <div>• 抓到老朝奉（${g.votesForLao}/${g.goodCount}）<b style="color:${g.laoCaught ? '#15803d' : '#b91c1c'}">${g.laoCaught ? '+1' : '+0'}</b></div>
        <div>• 方震${g.fangCaught ? '被抓 <b style="color:#b91c1c">+0</b>' : '未被抓 <b style="color:#15803d">+1</b>'}</div>
        <div>• 許願${g.xuCaught ? '被抓 <b style="color:#b91c1c">+0</b>' : '未被抓 <b style="color:#15803d">+2</b>'}</div></div></div>`;

    const identities = U.seated(room).map(p => `<div class="row between">${UI.seal(p)}${UI.roleTag(p.role)}${p.isBot ? '<span class="xs mute">電腦</span>' : '<span class="xs">👤 真人</span>'}</div>`).join('');

    const beasts = room.rounds.map(rd => `<div class="panel sm"><div class="b xs">第 ${rd.roundNum} 回合</div>${rd.beasts.map(b => {
      const vr = rd.voteResults, tag = vr.rank1.name === b.name ? '🥇封存' : vr.rank2.name === b.name ? '🥈公開' : '未入選';
      return `<div class="row between xs"><span><b class="lg">【${b.name}】</b> ${vr.totals[b.name]} 票 <span class="mute">${tag}</span></span><b class="${b.isReal ? 'jade' : 'red'}">${b.isReal ? '真品' : '贗品'}</b></div>`;
    }).join('')}<div class="xs mute">${rd.laoActive ? '🎭 本輪老朝奉啟動了擾亂' : ''}${rd.blockedBeast ? ` ⛓️ 封鎖【${rd.blockedBeast}】` : ''}</div></div>`).join('');

    /* ★ 2. 鑑人投票明細：欄位寬度再加寬 10%（右側改為 minmax(360px, 1.28fr)），保證單行不換行 */
    const pv = U.seated(room).map(p => {
      const t = U.byId(room, room.personVotes[p.id]);
      return `<div class="row between xs" style="flex-wrap:nowrap;gap:8px;padding:4px 0;border-bottom:1px dashed rgba(30,22,16,0.12)">
        <span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">${UI.seal(p)}${UI.roleTag(p.role)}${p.role === '鄭國渠' ? '<b class="red" style="font-size:11px">無效票</b>' : ''}</span>
        <span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">➔ ${t ? UI.seal(t) + UI.roleTag(t.role) : '未投'}</span>
      </div>`;
    }).join('');

    /* ★ 3. 三回合傳遞順序、獸首查驗與技能：
         - 字體大小與 `黑色・彥` (11px 粗體) 完全一致
         - 獸首查驗以玩家實際查驗結果為主（如前面封龍，後面驗龍顯示 🔍龍?）
         - 方震拿掉「🔍 無查驗...」，只顯示深綠底 🔍驗柚子👍/👎
         - 受影響者在名牌旁放無底色 🎭 / ⛓️ / 🙈 */
    const chains = room.rounds.map(rd => {
      const cards = rd.passOrder.map((id, i) => {
        const p = U.byId(room, id), l = rd.turnLogs[id];
        if (!p) return '';
        const skillHtml = formatPlayerSkillLine(p, l, room);
        const inspectHtml = formatPlayerInspectLine(p, l);
        const affectedHtml = formatAffectedIcons(rd, p, l, i);
        return `${i ? '<span class="mute b" style="align-self:center;font-size:11px">➔</span>' : ''}
          <div class="panel sm" style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:5px 7px;min-width:82px;text-align:center">
            <div style="display:inline-flex;align-items:center;gap:2px;font-size:11px">${UI.seal(p)}${affectedHtml}</div>
            ${skillHtml}
            ${inspectHtml}
          </div>`;
      }).join('');
      return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding:6px 0;border-bottom:1px dashed rgba(30,22,16,0.15)">
        <b class="red" style="font-size:11px;min-width:22px">R${rd.roundNum}</b>
        <div style="display:flex;align-items:stretch;flex-wrap:wrap;gap:4px;flex:1">${cards}</div>
      </div>`;
    }).join('');

    const botReviews = GD.Review.buildAll(room);
    const botReviewMap = {};
    botReviews.forEach(rv => { botReviewMap[rv.id] = rv; });
    const evolved = botReviews.filter(r => r.learning).length;

    const allPlayersReviewsHtml = U.seated(room).map(p => {
      if (p.isBot && botReviewMap[p.id]) return mindMap(botReviewMap[p.id], room);
      return humanReviewCard(p, room);
    }).join('');

    UI.html(box, `${banner}
      <div style="display:grid;grid-template-columns:minmax(0,1.52fr) minmax(360px,0.5fr);gap:12px;align-items:start">
        <section class="panel col">
          <div>${head('📱 三回合傳遞順序、獸首查驗與技能')}<div class="col" style="gap:6px">${chains}</div></div>
          <div class="mt">${head('🪑 全員真實身分')}<div class="grid g2" style="gap:6px">${identities}</div></div>
        </section>
        <section class="panel col">
          <div>${head('🎯 鑑人投票明細')}<div class="col" style="gap:4px">${pv}</div></div>
        </section>
      </div>
      <section class="panel">${head('🏺 三回合獸首真偽與得票')}<div class="grid g3">${beasts}</div></section>
      <section class="panel">${head('🕵️ 全體掌眼人查驗・技能・投票明細與 AI 推理覆盤', evolved ? `<span class="xs mute" style="float:right">${evolved} 位電腦已完成自我進化</span>` : `<span class="xs mute" style="float:right">全真人對局完整戰報</span>`)}
        <div class="col">${allPlayersReviewsHtml}</div></section>
      <div class="row"><button class="btn red big grow" data-act="again">🔄 原桌再開一局</button><button class="btn big grow" data-act="home">🏠 返回大廳</button></div>`);
  };

  UI.on('again', () => Net.act(r => GD.Engine.start(r)));
})(window.GD);