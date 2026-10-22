/* ============================================================================
 * ui/gameover.js — 終局面板：結果與計分、全員身分、傳遞圖、三輪獸首真偽、
 *                  鑑人明細、發言紀錄、AI Deduction Mind-Map 與 🧬 自我進化結果
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

  function mindMap(rv, room) {
    const bot = U.byId(room, rv.id), res = rv.learning;
    const rounds = rv.rounds.map(r => `<div class="panel sm" style="margin-bottom:8px">
      <div class="row between"><b class="red">📍 第 ${r.round} 輪推理</b>${r.speechSource ? `<span class="xs mute">${r.speechSource === 'gemini' ? '🌐 Gemini 生成' : '🧠 本地推理'}${r.geminiNote ? `（Gemini 未採用：${U.esc(r.geminiNote)}）` : ''}</span>` : ''}</div>
      ${r.speech ? `<div class="xs mute" style="font-style:italic;margin:3px 0">「${U.esc(r.speech)}」</div>` : ''}
      ${r.steps.map(s => `<div class="step"><b>${U.esc(s.k)}</b><span>${U.esc(s.v)}</span></div>`).join('')}</div>`).join('');

    const sus = rv.final.suspects.length ? `<div class="mt xs">${rv.final.suspects.map((s, i) => `<div>${i + 1}. ${U.esc(s.tag)}（真身【${U.esc(s.role)}】）嫌疑 ${s.evil}｜老朝奉 ${s.probs['老朝奉'] ?? '-'}% / 藥不然 ${s.probs['藥不然'] ?? '-'}%${s.reasons.length ? '：' + U.esc(s.reasons.join('；')) : ''}</div>`).join('')}</div>` : '';

    const learn = res ? `<div class="panel sm" style="background:#ecfdf5;border-color:#15803d">
      <div class="row between"><b class="jade">🧬 自我學習與基因修正（BotLearningEngine）</b><span class="tag ${res.won ? 'good' : 'evil'}">${res.won ? '本局獲勝' : '本局落敗'}</span></div>
      <div class="col mt" style="gap:3px">${geneBars(res)}</div>
      <div class="mt">${res.notes.length ? res.notes.map(n => `<div class="xs">• <b class="${n.d > 0 ? 'up' : 'down'}">${L[n.gene]} ${n.d > 0 ? '+' : ''}${(n.d * res.lr).toFixed(3)}</b>：${U.esc(n.why)}</div>`).join('') : '<div class="xs mute">本局表現平穩，沒有需要修正的項目（基因僅向出廠值回歸）。</div>'}</div>
      <div class="xs mute mt">已寫入 localStorage（累計 ${res.games} 局，學習率 ${Math.round(res.lr * 100)}%）。下一局該角色出場就會使用新基因。</div></div>` : '<div class="xs mute">學習結果計算中…</div>';

    return `<details class="mind panel sm" style="padding:0"><summary class="row between wrap">
      <span class="row wrap">${bot ? UI.seal(bot) : ''}${UI.roleTag(rv.role)}<span class="xs mute">${U.esc(rv.title)}</span></span>
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

    const banner = `<div class="banner ${g.xuWon ? 'win' : 'lose'}"><div class="xs b" style="letter-spacing:3px">古董局中局・對局結果</div>
      <div class="xl b" style="font-size:28px;margin:4px 0">${g.xuWon ? '🎉 許願陣營獲勝！' : '😈 老朝奉陣營獲勝！'}</div>
      <div class="mono b" style="font-size:24px;color:#34d399">總分 ${g.totalScore} 分</div>
      <div class="grid g4 wrapsm sm mt" style="text-align:left;background:rgba(0,0,0,.35);padding:10px;border-radius:8px">
        <div>• 保留真品 <b>+${g.savedReal}</b></div>
        <div>• 抓到老朝奉（${g.votesForLao}/${g.goodCount}）<b>${g.laoCaught ? '+1' : '+0'}</b></div>
        <div>• 方震${g.fangCaught ? '被抓 <b>+0</b>' : '未被抓 <b>+1</b>'}</div>
        <div>• 許願${g.xuCaught ? '被抓 <b>+0</b>' : '未被抓 <b>+2</b>'}</div></div></div>`;

    const identities = U.seated(room).map(p => `<div class="row between">${UI.seal(p)}${UI.roleTag(p.role)}${p.isBot ? '<span class="xs mute">電腦</span>' : '<span class="xs">👤 真人</span>'}</div>`).join('');

    const beasts = room.rounds.map(rd => `<div class="panel sm"><div class="b xs">第 ${rd.roundNum} 回合</div>${rd.beasts.map(b => {
      const vr = rd.voteResults, tag = vr.rank1.name === b.name ? '🥇封存' : vr.rank2.name === b.name ? '🥈公開' : '未入選';
      return `<div class="row between xs"><span><b class="lg">【${b.name}】</b> ${vr.totals[b.name]} 票 <span class="mute">${tag}</span></span><b class="${b.isReal ? 'jade' : 'red'}">${b.isReal ? '真品' : '贗品'}</b></div>`;
    }).join('')}<div class="xs mute">${rd.laoActive ? '🎭 本輪老朝奉啟動了擾亂' : ''}${rd.blockedBeast ? ` ⛓️ 封鎖【${rd.blockedBeast}】` : ''}</div></div>`).join('');

    const pv = U.seated(room).map(p => {
      const t = U.byId(room, room.personVotes[p.id]);
      return `<div class="row between xs"><span>${UI.seal(p)} ${UI.roleTag(p.role)}${p.role === '鄭國渠' ? ' <b class="red">無效票</b>' : ''}</span><span>➔ ${t ? UI.seal(t) + UI.roleTag(t.role) : '未投'}</span></div>`;
    }).join('');

    const chains = room.rounds.map(rd => `<div class="xs"><b class="red">R${rd.roundNum}</b> ${rd.passOrder.map((id, i) => { const p = U.byId(room, id), l = rd.turnLogs[id]; return `${i ? '➔ ' : ''}${UI.seal(p)}${l && l.skillTag ? `<em class="xs red">${U.esc(l.skillTag)}</em>` : ''}`; }).join(' ')}</div>`).join('');

    const reviews = GD.Review.buildAll(room);
    const evolved = reviews.filter(r => r.learning).length;

    UI.html(box, `${banner}
      <div class="grid g2" style="align-items:start">
        <section class="panel col"><div>${head('🪑 全員真實身分')}<div class="col" style="gap:5px">${identities}</div></div></section>
        <section class="panel col"><div>${head('📱 三回合傳遞順序與技能')}<div class="col" style="gap:7px">${chains}</div></div>
          <div>${head('🎯 鑑人投票明細')}<div class="col" style="gap:5px">${pv}</div></div></section>
      </div>
      <section class="panel">${head('🏺 三回合獸首真偽與得票')}<div class="grid g3">${beasts}</div></section>
      <section class="panel">${head('💻 電腦角色推理覆盤 AI Deduction Mind-Map', `<span class="xs mute" style="float:right">${evolved} 位電腦已完成自我進化並寫入瀏覽器</span>`)}
        <div class="col">${reviews.map(rv => mindMap(rv, room)).join('') || '<div class="mute">本局沒有電腦玩家。</div>'}</div></section>
      <div class="row"><button class="btn red big grow" data-act="again">🔄 原桌再開一局（電腦帶著新基因出場）</button><button class="btn big grow" data-act="home">🏠 返回大廳</button></div>`);
    /* 保留使用者已展開的覆盤：innerHTML 快取命中時不會被重寫，因此展開狀態不會被打斷 */
  };

  UI.on('again', () => Net.act(r => GD.Engine.start(r)));
})(window.GD);
