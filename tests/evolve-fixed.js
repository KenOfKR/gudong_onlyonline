/* 固定名單進化測試：同樣 8 位電腦連打 N 局（每位都吃滿 N 局的學習），
 * 比較「學習開啟」與「基因凍結」。分 3 段回報，並附標準誤差，避免把雜訊當成進步。
 * 用法：node tests/evolve-fixed.js [局數=1500] */
const N = parseInt(process.argv[2], 10) || 1500;
const SEG = 3, per = Math.floor(N / SEG);

function run(freeze) {
  const GD = require('./harness')();
  const { Engine, Strategy, Speech, Mind, U } = GD;
  GD.store.set(GD.CONFIG.STORAGE.useGemini, false);
  const ids = ['bot_002', 'bot_005', 'bot_008', 'bot_011', 'bot_019', 'bot_024', 'bot_030', 'bot_036'];
  const segs = Array.from({ length: SEG }, () => ({ g: 0, xu: 0, real: 0, tot: 0, laoHit: 0, goodN: 0, evilLie: 0 }));
  for (let i = 0; i < N; i++) {
    const room = Engine.newRoom('X' + i, 'h');
    ids.forEach(id => { const b = GD.Roster.byId(id); Engine.addPlayer(room, { id: 'b_' + id, name: b.name, isBot: true, botId: id }); });
    Engine.start(room);
    let guard = 0;
    while (room.status !== 'gameover' && guard++ < 300) {
      const rd = U.curRound(room);
      if (room.status === 'playing') {
        const p = U.byId(room, room.currentTurnPlayerId), log = Engine.log(room, p.id);
        if (log.step === 'a') Strategy.inspectPicks(p, room).forEach(n => Engine.inspect(room, p.id, n));
        const A = Mind.analyze(p, room);
        Engine.skill(room, p.id, Strategy.skill(p, room, A)); Engine.pass(room, p.id, Strategy.nextPlayer(p, room, A));
      } else if (room.status === 'discussion') {
        const p = U.byId(room, room.currentSpeakerId), { plan, A } = Strategy.plan(p, room);
        Engine.speak(room, p.id, { text: Speech.localSpeech(p, room, plan, A), source: 'bot' });
      } else if (room.status === 'voting') {
        room.players.forEach(p => { if (rd.votes[p.id] === undefined) Engine.vote(room, p.id, Strategy.ballot(p, room)); });
        Engine.advance(room);
      } else if (room.status === 'person_voting') {
        room.players.forEach(p => { if (!room.personVotes[p.id]) { const d = Strategy.personVote(p, room); p.final = d; Engine.personVote(room, p.id, d.targetId); } });
      }
    }
    const s = segs[Math.min(SEG - 1, Math.floor(i / per))], lao = room.players.find(p => p.role === '老朝奉');
    s.g++; s.xu += room.gameOver.xuWon ? 1 : 0;
    room.players.filter(p => GD.isGood(p.role)).forEach(b => {
      const f = GD.Learning.ballotFacts(room, b); s.real += f.real; s.tot += f.real + f.fake; s.goodN++;
      if (room.personVotes[b.id] === lao.id) s.laoHit++;
    });
    const snap = freeze ? JSON.stringify(GD.store.get(GD.CONFIG.STORAGE.genes, {})) : null;
    GD.Learning.finalize(room);
    if (freeze) GD.store.set(GD.CONFIG.STORAGE.genes, JSON.parse(snap));
  }
  const store = GD.store.get(GD.CONFIG.STORAGE.genes, {});
  const fin = ids.map(id => (store[id] || { genes: GD.Roster.baseGenes(id) }).genes);
  const avg = k => fin.reduce((a, g) => a + g[k], 0) / fin.length;
  return { segs, genes: Object.fromEntries(GD.Genes.KEYS.map(k => [k, avg(k)])), base: Object.fromEntries(GD.Genes.KEYS.map(k => [k, ids.reduce((a, id) => a + GD.Roster.baseGenes(id)[k], 0) / ids.length])) };
}

const pct = x => (x * 100).toFixed(1) + '%';
const se = (p, n) => (Math.sqrt(p * (1 - p) / n) * 100).toFixed(1);
for (const [label, freeze] of [['學習開啟', false], ['基因凍結(對照)', true]]) {
  const r = run(freeze);
  console.log(`\n【${label}】${N} 局，固定 8 位電腦`);
  r.segs.forEach((s, i) => {
    const w = s.xu / s.g, rl = s.real / s.tot, lh = s.laoHit / s.goodN;
    console.log(`  第${i + 1}段(${s.g}局)  許願方勝率 ${pct(w)} ±${se(w, s.g)}｜好人鑑寶命中真品 ${pct(rl)} ±${se(rl, s.tot)}｜好人鑑人命中老朝奉 ${pct(lh)} ±${se(lh, s.goodN)}`);
  });
  console.log('  平均基因  ' + Object.keys(r.genes).map(k => `${k} ${r.base[k].toFixed(2)}→${r.genes[k].toFixed(2)}`).join('｜'));
}
