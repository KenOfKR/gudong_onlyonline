/* 進化量測：同一批 Bot 連打 N 局，比較「學習開啟」與「基因凍結」的表現，並檢查基因是否貼邊界。
 * 用法：node tests/evolve.js [局數=600]
 * 指標：每位 Bot 作為好人時「鑑寶票命中真品比例」與「鑑人命中老朝奉比例」（看前 1/3 vs 後 1/3），
 *       這是 Bot 個人判斷力的直接指標，比陣營勝率雜訊小。 */
const N = parseInt(process.argv[2], 10) || 600;

function runBatch(freeze) {
  const GD = require('./harness')();
  const { Engine, Strategy, Speech, Mind, U } = GD;
  GD.store.set(GD.CONFIG.STORAGE.useGemini, false);
  const series = [];                                    // 每局：好人 Bot 的 {realVotes, totalVotes, laoHit, goodBots}
  for (let i = 0; i < N; i++) {
    const room = Engine.newRoom('E' + i, 'h');
    Engine.addPlayer(room, { id: 'h1', name: '真人' });
    Engine.fillBots(room); Engine.start(room);
    let guard = 0;
    while (room.status !== 'gameover' && guard++ < 300) {
      const rd = U.curRound(room);
      if (room.status === 'playing') {
        const p = U.byId(room, room.currentTurnPlayerId), log = Engine.log(room, p.id);
        if (log.step === 'a') Strategy.inspectPicks(p, room).forEach(n => Engine.inspect(room, p.id, n));
        const A = Mind.analyze(p, room);
        Engine.skill(room, p.id, Strategy.skill(p, room, A));
        Engine.pass(room, p.id, Strategy.nextPlayer(p, room, A));
      } else if (room.status === 'discussion') {
        const p = U.byId(room, room.currentSpeakerId), { plan, A } = Strategy.plan(p, room);
        Engine.speak(room, p.id, { text: Speech.localSpeech(p, room, plan, A), source: p.isBot ? 'bot' : 'human' });
      } else if (room.status === 'voting') {
        room.players.forEach(p => { if (rd.votes[p.id] === undefined) Engine.vote(room, p.id, Strategy.ballot(p, room)); });
        Engine.advance(room);
      } else if (room.status === 'person_voting') {
        room.players.forEach(p => { if (!room.personVotes[p.id]) { const d = Strategy.personVote(p, room); p.final = d; Engine.personVote(room, p.id, d.targetId); } });
      }
    }
    let rv = 0, tv = 0, hit = 0, gb = 0;
    const lao = room.players.find(p => p.role === '老朝奉');
    room.players.filter(p => p.isBot && GD.isGood(p.role)).forEach(b => {
      gb++;
      const f = GD.Learning.ballotFacts(room, b); rv += f.real; tv += f.real + f.fake;
      if (room.personVotes[b.id] === lao.id) hit++;
    });
    series.push({ rv, tv, hit, gb, xuWon: room.gameOver.xuWon, evilWin: room.gameOver.xuWon ? 0 : 1 });
    const before = freeze ? JSON.stringify(GD.store.get(GD.CONFIG.STORAGE.genes, {})) : null;
    GD.Learning.finalize(room);
    if (freeze) GD.store.set(GD.CONFIG.STORAGE.genes, JSON.parse(before));      // 凍結：丟掉本局學到的東西
  }
  const slice = (a, b) => {
    const s = series.slice(a, b), sum = k => s.reduce((x, y) => x + y[k], 0);
    return { realRate: sum('rv') / Math.max(1, sum('tv')), laoRate: sum('hit') / Math.max(1, sum('gb')), win: s.filter(x => x.xuWon).length / s.length };
  };
  const third = Math.floor(N / 3);
  const store = GD.store.get(GD.CONFIG.STORAGE.genes, {});
  let edge = 0, tot = 0, drift = 0;
  Object.entries(store).forEach(([id, rec]) => GD.Genes.KEYS.forEach(k => {
    tot++; if (rec.genes[k] <= 0.06 || rec.genes[k] >= 0.94) edge++;
    drift += Math.abs(rec.genes[k] - GD.Roster.baseGenes(id)[k]);
  }));
  return { first: slice(0, third), last: slice(N - third, N), edgePct: tot ? edge / tot * 100 : 0, avgDrift: tot ? drift / tot : 0 };
}

const f = x => (x * 100).toFixed(1) + '%';
for (const [label, freeze] of [['學習開啟', false], ['基因凍結(對照)', true]]) {
  const r = runBatch(freeze);
  console.log(`\n【${label}】${N} 局`);
  console.log(`  前 1/3：鑑寶票命中真品 ${f(r.first.realRate)}｜鑑人命中老朝奉 ${f(r.first.laoRate)}｜許願方勝率 ${f(r.first.win)}`);
  console.log(`  後 1/3：鑑寶票命中真品 ${f(r.last.realRate)}｜鑑人命中老朝奉 ${f(r.last.laoRate)}｜許願方勝率 ${f(r.last.win)}`);
  console.log(`  基因貼邊界比例 ${r.edgePct.toFixed(1)}%｜平均偏離出廠值 ${r.avgDrift.toFixed(3)}`);
}
