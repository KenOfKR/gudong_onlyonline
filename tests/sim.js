/* 全電腦對局模擬：驗證規則不變量、推理不崩潰、學習引擎寫入。用法：node tests/sim.js [局數] */
const GD = require('./harness')();
const { Engine, Rules, Strategy, Speech, Mind, U } = GD;
const N = parseInt(process.argv[2], 10) || 200;
GD.store.set(GD.CONFIG.STORAGE.useGemini, false);

let fails = 0;
const stats = { vipBlind: 0, starterN: 0, starterEvil: 0, pairN: 0, pairEvil: 0,
                asks: 0, askAnswered: 0, askReplied: 0, confess: 0, confessByRole: {}, maxRoomBytes: 0 };
const check = (cond, msg) => { if (!cond) { fails++; if (fails <= 12) console.error('  ✗', msg); } };

function playOne(seed) {
  const room = Engine.newRoom('T' + seed, 'host');
  Engine.addPlayer(room, { id: 'h1', name: '真人甲' });                 // 一位「真人」，以電腦策略代打並標記 source=human
  Engine.fillBots(room);
  check(Engine.start(room), 'start 失敗');
  check(room.players.length === 8, '人數不是 8');
  const roles = room.players.map(p => p.role).sort().join();
  check(roles === [...GD.ROLE_ORDER].sort().join(), '角色配置不正確');

  let guard = 0;
  while (room.status !== 'gameover' && guard++ < 400) {
    const rd = U.curRound(room);
    if (room.status === 'playing') {
      const p = U.byId(room, room.currentTurnPlayerId);
      const log = Engine.log(room, p.id);
      check(rd.beasts.length === 4 && rd.beasts.filter(b => b.isReal).length === 2, '每輪應為 2 真 2 假');
      if (log.step === 'a') Strategy.inspectPicks(p, room).forEach(n => Engine.inspect(room, p.id, n));
      const A = Mind.analyze(p, room);
      check(Engine.skill(room, p.id, Strategy.skill(p, room, A)), `技能失敗 ${p.role}`);
      const nxt = Strategy.nextPlayer(p, room, A);
      check(Engine.pass(room, p.id, nxt), `傳遞失敗 (${p.role})`);
    } else if (room.status === 'discussion') {
      const p = U.byId(room, room.currentSpeakerId);
      const { plan, A } = Strategy.plan(p, room);
      const text = Speech.localSpeech(p, room, plan, A);
      const v = Speech.validate(text, p, room, plan, A);
      check(v.ok, `本地發言未通過自己的驗證：${v.why} ← ${text.slice(0, 60)}`);
      check(Engine.speak(room, p.id, { text, source: p.isBot ? 'bot' : 'human' }), '發言失敗');
    } else if (room.status === 'voting') {
      if (!rd.voteResults) room.players.forEach(p => { if (rd.votes[p.id] === undefined) check(Engine.vote(room, p.id, Strategy.ballot(p, room)), '投票失敗'); });
      check(!!rd.voteResults, '全員投完應立即開票');
      const bankBefore = room.players.map(p => p.voteBank);
      check(Engine.advance(room), 'advance 失敗');
      if (room.status === 'playing') {
        room.players.forEach((p, i) => check(p.voteBank === bankBefore[i] + 2, `籌碼應累積：${p.voteBank} vs ${bankBefore[i]}+2`));
        check(room.rounds[room.currentRoundIdx].passOrder.length === 1, '新回合應由尾家起手');
      }
    } else if (room.status === 'person_voting') {
      room.players.forEach(p => { if (!room.personVotes[p.id]) { const d = Strategy.personVote(p, room); p.final = d; check(Engine.personVote(room, p.id, d.targetId), '鑑人投票失敗'); } });
    }
  }
  check(room.status === 'gameover' && !!room.gameOver, `未能結束 (status=${room.status})`);

  /* 身分保密與同伴互認：造假集團不能互投；方震不能亮自己的陣營查驗（會被藥不然直接點掉送分）*/
  const byRole = r => room.players.find(p => p.role === r);
  const lao = byRole('老朝奉'), yao = byRole('藥不然'), fang = byRole('方震');
  check(room.personVotes[lao.id] !== yao.id, '老朝奉把鑑人票投給了同伴藥不然');
  check(room.personVotes[yao.id] !== lao.id, '藥不然把鑑人票投給了同伴老朝奉');
  /* 許願、方震被偷襲時一律不在發言裡說出來（說出口等於告訴壞人偷襲砍中要害）*/
  const xu = byRole('許願');
  room.rounds.forEach(rd => [xu, fang].forEach(vip => {
    const sp = rd.speeches.find(s => s.playerId === vip.id);
    if (!sp || !(rd.turnLogs[vip.id] || {}).blind) return;
    stats.vipBlind++;
    check(!sp.p.blind && !/被偷襲|遭偷襲|眼前一片黑|偷襲/.test(sp.text), `${vip.role}被偷襲卻在發言說出來：${sp.text.slice(0, 60)}`);
  }));
  room.rounds.forEach(rd => {
    const sp = rd.speeches.find(s => s.playerId === fang.id);
    if (!sp) return;
    check(!(sp.p.campChecks || []).length && !/查驗過|驗過|親手查驗|陣營查驗/.test(sp.text), `方震裸跳：${sp.text.slice(0, 60)}`);
    const blind = (rd.turnLogs[fang.id] || {}).blind;
    check(blind || !sp.p.unsure, `方震未被偷襲卻說驗不到（會被藥不然認出）：${sp.text.slice(0, 60)}`);
  });

  /* 票型質問與認壞：好人可以質問，只有藥不然 / 鄭國渠能認壞（老朝奉被抓會直接送分，不認壞），
     認壞時不得報出具體角色，且被質問者的下一次發言要有回應 */
  room.rounds.forEach((rd, ri) => rd.speeches.forEach((sp, si) => {
    const spk = U.byId(room, sp.playerId);
    if ((sp.p.asked || []).length) {
      stats.asks++;
      check(rd.speeches.filter(x => (x.p.asked || []).length).length <= 1, `同一輪質問不應超過 1 次 (R${ri + 1})`);
      (sp.p.asked || []).forEach(aid => {
        const q = rd.speeches.slice(si + 1).find(x => x.playerId === aid);
        if (q) { stats.askReplied += /(說明|解釋|交代|被騙|看走眼|認壞|依據|因為|票)/.test(q.text) ? 1 : 0; stats.askAnswered++; }
      });
    }
    if (sp.p.selfEvil) {
      stats.confess++;
      stats.confessByRole[spk.role] = (stats.confessByRole[spk.role] || 0) + 1;
      check(!GD.isGood(spk.role), `好人 ${spk.role} 說自己是壞人：${sp.text.slice(0, 50)}`);
      check(spk.role !== '老朝奉', `老朝奉不應認壞：${sp.text.slice(0, 50)}`);
      check(!/我是(?:【)?(老朝奉|藥不然|鄭國渠)/.test(sp.text), `認壞時報出具體角色：${sp.text.slice(0, 50)}`);
      const l = rd.turnLogs[spk.id] || {};
      /* 認壞時攤開的查驗要是真的（壞人看到的不會被反轉；被偷襲 / 封鎖則沒有） */
      (sp.p.claims || []).forEach(c => {
        const b = rd.beasts.find(x => x.name === c.beast);
        if (b && (l.inspect || []).some(i => i.beastName === c.beast && typeof i.displayedReal === 'boolean')) {
          check(b.isReal === c.real, `認壞攤開的查驗不是真實結果：${c.beast}`);
        }
      });
    }
  }));

  /* 位置學統計（只量測，不當不變量）：
     下一輪首家 = 上一輪尾家，統計第 2、3 輪首家是老朝奉 / 藥不然的比例（隨機基準 25%）；
     第六位與第八位同為壞人的比例（隨機基準約 10.7%）*/
  room.rounds.forEach((rd, i) => {
    if (i > 0) { stats.starterN++; if (['老朝奉', '藥不然'].includes(U.byId(room, rd.passOrder[0]).role)) stats.starterEvil++; }
    const p6 = U.byId(room, rd.passOrder[5]), p8 = U.byId(room, rd.passOrder[7]);
    stats.pairN++; if (!GD.isGood(p6.role) && !GD.isGood(p8.role)) stats.pairEvil++;
  });

  /* Firestore 單一文件上限 1 MiB：房間整包（含 mind、發言、turnLogs）寫入前要留足餘裕 */
  const bytes = Buffer.byteLength(JSON.stringify(room), 'utf8');
  stats.maxRoomBytes = Math.max(stats.maxRoomBytes, bytes);
  check(bytes < 600 * 1024, `房間文件過大 ${(bytes / 1024).toFixed(0)} KB，逼近 Firestore 1 MiB 上限`);

  /* 不變量 */
  const used = new Set();
  room.rounds.forEach(rd => {
    check(rd.passOrder.length === 8 && new Set(rd.passOrder).size === 8, '傳遞序應含 8 位不重複玩家');
    check(rd.speeches.length === 8, `每輪應有 8 則發言，實際 ${rd.speeches.length}`);
    const tail = rd.passOrder[7], seats = U.seated(room), ti = seats.findIndex(p => p.id === tail);
    check(rd.speechOrder[0] === seats[(ti + 1) % 8].id && rd.speechOrder[7] === tail, '發言應由尾家左手邊開始、尾家壓軸');
    rd.beasts.forEach(b => { check(!used.has(b.name), `生肖重複抽出 ${b.name}`); used.add(b.name); });
    const vr = rd.voteResults;
    check(vr && vr.rank1.votes >= vr.rank2.votes, '第一名票數應 >= 第二名');
  });
  const g = room.gameOver;
  check(g.totalScore === g.savedReal + (g.laoCaught ? 1 : 0) + (g.fangCaught ? 0 : 1) + (g.xuCaught ? 0 : 2), '計分不符規則');
  check(g.xuWon === (g.totalScore >= 6), '勝負判定不符');
  room.players.forEach(p => check(p.voteBank >= 0 && p.voteBank <= 6, `籌碼異常 ${p.voteBank}`));

  /* 學習 + 覆盤（加上絕對防呆保護，避免 null 崩潰） */
  check(GD.Learning.finalize(room), 'learning.finalize 失敗');
  check(!GD.Learning.finalize(room), 'finalize 應為冪等');
  const bots = room.players.filter(p => p.isBot);
  bots.forEach(b => {
    // 防呆保護：若 finalize 失敗導致 room.learning 為 null，退回空物件[cite: 5]
    const L = (room.learning || {})[b.id]; 
    check(L && L.notes && L.after, `缺少學習結果 ${b.name}`);
    
    // 防呆保護：確保有讀取到有效 delta 與 after 才驗證數值[cite: 5]
    if (L && L.delta && L.after) {
      GD.Genes.KEYS.forEach(k => { 
        check(Math.abs(L.delta[k]) <= GD.Learning.STEP_CAP + 1e-9, `單局變化超過上限 ${k}=${L.delta[k]}`); 
        check(L.after[k] >= 0.05 && L.after[k] <= 0.95, `基因越界 ${k}`); 
      });
    }
  });
  const reviews = GD.Review.buildAll(room);
  check(reviews.length === bots.length, '覆盤數量不符');
  reviews.forEach(rv => {
    check(rv.rounds.length === 3 && rv.rounds.every(r => r.steps.length >= 4), '覆盤每輪應至少 4 個推理步驟');
    check(rv.rounds.every(r => r.steps.some(s => s.k === '傳遞動機' && s.v.length > 10)), `覆盤每輪都應有「傳遞動機」(${rv.name})`);
    check(!JSON.stringify(rv).includes('undefined'), `覆盤文字含 undefined (${rv.name})`);
  });
  return { room, reviews };
}

const t0 = Date.now();
let xuWins = 0, lastRoom = null, lastRv = null;
for (let i = 0; i < N; i++) {
  try { const r = playOne(i); lastRoom = r.room; lastRv = r.reviews; if (r.room.gameOver.xuWon) xuWins++; }
  catch (e) { fails++; console.error(`  ✗ 第 ${i} 局拋出例外:`, e.stack.split('\n').slice(0, 4).join('\n')); if (fails > 12) break; }
}
const store = GD.store.get(GD.CONFIG.STORAGE.genes, {});
console.log(`\n局數 ${N}｜許願方勝率 ${(xuWins / N * 100).toFixed(1)}%｜耗時 ${(Date.now() - t0)} ms｜失敗項 ${fails}`);
console.log(`已寫入基因紀錄的 Bot 數：${Object.keys(store).length}｜許願/方震被偷襲樣本 ${stats.vipBlind} 次`);
console.log(`票型質問 ${stats.asks} 次（被質問者後來發言 ${stats.askAnswered} 次，有回應 ${stats.askReplied} 次）｜認壞 ${stats.confess} 次 ${JSON.stringify(stats.confessByRole)}`);
console.log(`房間文件最大 ${(stats.maxRoomBytes / 1024).toFixed(0)} KB（Firestore 上限 1024 KB）`);
console.log(`位置學：第2/3輪首家是老朝奉或藥不然 ${(stats.starterEvil / stats.starterN * 100).toFixed(1)}%（隨機 25%）｜第六位與第八位同為壞人 ${(stats.pairEvil / stats.pairN * 100).toFixed(1)}%（隨機 10.7%）`);
const ex = Object.entries(store).sort((a, b) => b[1].games - a[1].games)[0];
if (ex) console.log('樣本：', ex[0], GD.Roster.byId(ex[0]).name, 'games=' + ex[1].games, JSON.stringify(ex[1].genes), '← 出廠', JSON.stringify(GD.Roster.baseGenes(ex[0])));
if (lastRv) {
  const rv = lastRv.find(r => r.rounds.some(x => x.steps.some(s => s.k === '發現查驗矛盾'))) || lastRv[0];
  console.log(`\n── 覆盤樣本：${rv.tag}【${rv.role}】──`);
  rv.rounds.slice(0, 2).forEach(r => { console.log(' 第' + r.round + '輪'); r.steps.forEach(s => console.log('   ·' + s.k + '：' + s.v)); });
  console.log(' 檢討：' + rv.reflection);
  console.log(' 鑑人：' + rv.final.text);
  
  // 防呆保護：印出學習日誌時也避免 undefined/null 報錯[cite: 5]
  console.log(' 學習：', (rv.learning && rv.learning.notes) ? rv.learning.notes.map(n => `${GD.Roster.GENE_LABELS[n.gene]}${n.d > 0 ? '+' : ''}${n.d} (${n.why})`).join(' ｜ ') : '無學習資料');
}
process.exit(fails ? 1 : 0);