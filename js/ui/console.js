/* ============================================================================
 * ui/console.js — 中央下方「操作台」：依階段與步驟顯示真人該做的事
 *   waiting → playing(a 查驗 / b 技能 / c 傳遞) → discussion → voting → person_voting → gameover
 * 所有按鈕只呼叫 Engine 動作（經 Net.act），沒有任何 UI 專用規則。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, UI, Net, Engine, Rules } = GD;
  const S = UI.state;

  const colorBtn = (p, act, label) => {
    const c = U.colorOf(p);
    return `<button class="btn" style="background:${c.hex};color:${c.text}" data-act="${act}" data-arg="${p.id}">${label ? U.esc(label) + '<br>' : ''}<b>${U.esc(p.name)}</b></button>`;
  };

  UI.renderConsole = function (room, me, rd) {
    const box = UI.byId('console');
    if (!me) return UI.html(box, '<div class="mute center">您尚未入座</div>');
    const st = room.status;

    if (st === 'waiting') {
      return UI.html(box, `<div class="center col"><b class="lg">已入座 ${room.players.length} / 8 位掌眼人</b>
        <p class="sm" style="margin:0">開局前可點「◀ 換座 ▶」調整發言序，並選擇印章顏色。多人連線時請其他玩家用同一個房號加入。</p>
        <button class="btn red big" data-act="fill">🤖 補滿電腦並立即開局 ➔</button></div>`);
    }

    if (st === 'playing') {
      const cur = U.byId(room, room.currentTurnPlayerId);
      if (!cur || cur.id !== me.id) {
        return UI.html(box, `<div class="center b red">⏳ 等待【${U.esc(cur ? cur.name : '其他人')}】查驗獸首與施放技能…${cur && cur.isBot ? '<div class="xs mute">電腦思考中</div>' : ''}</div>`);
      }
      const log = Engine.log(room, me.id), quota = Rules.inspectQuota(me);

      if (log.step === 'a') {
        return UI.html(box, `<div class="row between wrap"><b class="red sm">步驟 1：點牌桌中央的獸首查驗（${log.inspect.length}/${quota}）</b><span class="stamp">${me.role}</span></div>
          <div class="grid g4">${rd.beasts.map(b => {
            const f = log.inspect.find(i => i.beastName === b.name);
            const dis = f || log.inspect.length >= quota;
            return `<button class="btn ${f ? 'red' : ''}" ${dis ? 'disabled' : ''} data-act="inspect" data-arg="${b.name}"><b class="xl">${b.name}</b><br><span class="xs">${f ? U.esc(f.resultText.replace(/^【.】\s*/, '')) : '查驗'}</span></button>`;
          }).join('')}</div>`);
      }

      if (log.step === 'b') {
        const others = room.players.filter(p => p.id !== me.id);
        const fb = log.inspect.length ? `<div class="live-text center">🔍 ${U.esc(log.inspect.map(i => i.resultText).join(' ｜ '))}</div>` : '';
        if (Rules.isBlind(me)) {
          return UI.html(box, `${fb}<div class="note evil center">💥 你遭到偷襲，技能被封鎖！</div><button class="btn gold block" data-act="skill" data-arg="skip">下一步：指定傳遞玩家 ➔</button>`);
        }
        let skill = `<div class="center sm">【${me.role}】沒有主動技能。</div><button class="btn gold block" data-act="skill" data-arg="skip">下一步：指定傳遞玩家 ➔</button>`;
        if (me.role === '方震') skill = log.fangTargetId
          ? `<div class="live-text center">${U.esc(log.ability)}</div><button class="btn gold block" data-act="skill" data-arg="skip">下一步 ➔</button>`
          : `<b class="red sm">【方震】請選擇查驗 1 位玩家的陣營</b><div class="grid g4 wrapsm">${others.map(p => colorBtn(p, 'skillFang', '查驗')).join('')}</div>`;
        else if (me.role === '老朝奉') skill = `<b class="red sm">【老朝奉】是否啟動擾亂（反轉其後好人的查驗）？</b>
          <div class="grid g2"><button class="btn red" data-act="skill" data-arg="lao:1">🎭 啟動擾亂</button><button class="btn" data-act="skill" data-arg="skip">不發動</button></div>`;
        else if (me.role === '藥不然') skill = `<b class="red sm">【藥不然】選擇偷襲 1 人（已行動者效果延到下回合）</b>
          <div class="grid g4 wrapsm">${others.map(p => colorBtn(p, 'skillYao', '🗡️偷襲')).join('')}</div><button class="btn block" data-act="skill" data-arg="skip">本輪不偷襲 ➔</button>`;
        else if (me.role === '鄭國渠') skill = `<b class="red sm">【鄭國渠】選擇封鎖 1 尊獸首（使其無法辨別）</b>
          <div class="grid g4">${rd.beasts.map(b => `<button class="btn red" data-act="skill" data-arg="zheng:${b.name}">⛓️ 封鎖【${b.name}】</button>`).join('')}</div><button class="btn block" data-act="skill" data-arg="skip">本輪不封鎖 ➔</button>`;
        return UI.html(box, `${fb}${skill}`);
      }

      const left = Engine.remainingToAct(room);
      return UI.html(box, left.length
        ? `<b class="red sm">步驟 3：指定下一位接手查驗的玩家（也可直接點牌桌座位）</b><div class="grid g4 wrapsm">${left.map(p => colorBtn(p, 'pass')).join('')}</div>`
        : `<button class="btn red big block" data-act="pass" data-arg="">🏛️ 全員查驗完畢！由尾家左手邊開始順時針發言 ➔</button>`);
    }

    if (st === 'discussion') {
      const sp = U.byId(room, room.currentSpeakerId), mine = sp && sp.id === me.id;
      return UI.html(box, `<div class="center b ${mine ? 'red' : ''}">${mine ? '📢 輪到您發言！請在右側按住說話' : `🗣️ 正在聆聽【${U.esc(sp ? sp.name : '')}】發言…`}</div>`);
    }

    if (st === 'voting') {
      if (rd.voteResults) {
        const a = rd.voteResults.rank1, b = rd.voteResults.rank2;
        return UI.html(box, `<div class="center b lg">📊 第 ${rd.roundNum} 回合開票結果</div>
          <div class="grid g2"><div class="note"><b class="gold">🥇 第一名（${a.votes} 票）</b><div class="xl b">【${a.name}】</div><div class="xs mute">🔒 真偽封存</div></div>
          <div class="note"><b class="jade">🥈 第二名（${b.votes} 票）</b><div class="xl b">【${b.name}】</div><b class="sm ${b.isReal ? 'jade' : 'red'}">${b.isReal ? '✓ 真品' : '✕ 贗品'}</b></div></div>
          <button class="btn red big block" data-act="advance">${room.currentRoundIdx < 2 ? '進入下一回合（抽新獸首、籌碼累積）➔' : '進入終局鑑人 🎯'}</button>`);
      }
      if (rd.votes[me.id] !== undefined) return UI.html(box, `<div class="center b jade">✓ 籌碼已送出（保留 ${me.voteBank} 票到下輪），等待其他人…</div>`);
      const used = U.sum(Object.values(S.ballot)), keep = me.voteBank - used;
      return UI.html(box, `<div class="row between wrap"><b class="sm">🗳️ 可用 <span class="red">${me.voteBank}</span> 票｜已配 ${used}｜保留 <span class="jade">${keep}</span></b><a href="#" class="xs red b" data-act="ballotReset">重設</a></div>
        <div class="grid g4 wrapsm">${rd.beasts.map(b => `<div class="panel sm center"><b class="xl">【${b.name}】</b><div class="row center"><button class="btn sq" data-act="ballot" data-arg="${b.name}|-1">−</button><b class="mono lg" style="min-width:22px">${S.ballot[b.name] || 0}</b><button class="btn gold sq" data-act="ballot" data-arg="${b.name}|1">＋</button></div></div>`).join('')}</div>
        <button class="btn red big block" data-act="ballotSend">確認投出 ${used} 票（保留 ${keep} 票）🗳️</button>`);
    }

    if (st === 'person_voting') {
      if (room.personVotes[me.id]) return UI.html(box, '<div class="center b jade">✓ 指認票已封存，等待全員開票…</div>');
      const title = { '老朝奉': '你是【老朝奉】！指認誰是【許願】（抓中好人少 2 分）', '藥不然': '你是【藥不然】！指認誰是【方震】（抓中好人少 1 分）', '鄭國渠': '你是【鄭國渠】，你的鑑人票無效，仍請投票' }[me.role] || '🎯 指認誰是幕後黑手【老朝奉】？';
      return UI.html(box, `<b class="red sm">${title}</b><div class="grid g4 wrapsm">${room.players.filter(p => p.id !== me.id).map(p => colorBtn(p, 'pvote', '指認')).join('')}</div>`);
    }

    UI.html(box, '<div class="center b red">👇 向下捲動查看終局揭曉、電腦推理覆盤與進化結果 👇</div>');
  };

  /* ---------------- 動作 ---------------- */
  const act = fn => (arg, el) => { const me = UI.me(); if (me) Net.act(r => fn(r, me, arg, el)); };

  UI.on('skill', act((r, me, a) => {
    if (a === 'skip') return Engine.skill(r, me.id, { kind: 'skip' });
    const [k, v] = a.split(':');
    return Engine.skill(r, me.id, k === 'lao' ? { kind: 'lao', active: v === '1' } : { kind: 'zheng', beast: v });
  }));
  UI.on('skillFang', act((r, me, id) => Engine.skill(r, me.id, { kind: 'fang', targetId: id })));
  UI.on('skillYao', act((r, me, id) => Engine.skill(r, me.id, { kind: 'yao', targetId: id })));
  UI.on('pass', act((r, me, id) => Engine.pass(r, me.id, id || null)));
  UI.on('advance', () => Net.act(r => Engine.advance(r)));
  UI.on('pvote', act((r, me, id) => Engine.personVote(r, me.id, id)));

  UI.on('ballot', arg => {
    const me = UI.me(); if (!me) return;
    const [name, d] = arg.split('|'), cur = S.ballot[name] || 0, used = U.sum(Object.values(S.ballot));
    if (+d > 0 && used >= me.voteBank) return UI.toast(`您目前最多只有 ${me.voteBank} 張可用籌碼`, 'warn');
    if (cur + +d < 0) return;
    S.ballot[name] = cur + +d;
    UI.render();
  });
  UI.on('ballotReset', () => { S.ballot = {}; UI.render(); });
  UI.on('ballotSend', act((r, me) => { const ok = Engine.vote(r, me.id, S.ballot); if (ok) S.ballot = {}; return ok; }));
})(window.GD);
