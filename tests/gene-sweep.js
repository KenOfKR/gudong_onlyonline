/* 基因敏感度掃描：把所有電腦的某一項基因固定在低 / 高值，量測好人與壞人的表現。
 * 若某項基因對結果幾乎沒影響，學習引擎調它就沒有意義。用法：node tests/gene-sweep.js [局數=400] */
const N = parseInt(process.argv[2], 10) || 400;
const GD = require('./harness')();
const { Engine, Strategy, Speech, Mind, U } = GD;
GD.store.set(GD.CONFIG.STORAGE.useGemini, false);

function batch(forceGene, value) {
  let realV = 0, totV = 0, laoHit = 0, goodBots = 0, evilWins = 0, laoCaught = 0, games = 0, duped = 0;
  for (let i = 0; i < N; i++) {
    const room = Engine.newRoom('S' + i, 'h');
    Engine.fillBots(room); Engine.start(room);
    if (forceGene) room.players.forEach(p => { if (p.genes) p.genes[forceGene] = value; });
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
    games++;
    const lao = room.players.find(p => p.role === '老朝奉');
    if (!room.gameOver.xuWon) evilWins++;
    if (room.gameOver.laoCaught) laoCaught++;
    room.players.filter(p => GD.isGood(p.role)).forEach(b => {
      const f = GD.Learning.ballotFacts(room, b); realV += f.real; totV += f.real + f.fake; duped += f.duped.length ? 1 : 0;
      goodBots++; if (room.personVotes[b.id] === lao.id) laoHit++;
    });
  }
  return { real: realV / totV, lao: laoHit / goodBots, evilWin: evilWins / games, laoCaught: laoCaught / games, duped: duped / goodBots };
}
const f = x => (x * 100).toFixed(1).padStart(5) + '%';
console.log(`基準（出廠基因）`, JSON.stringify(Object.fromEntries(Object.entries(batch()).map(([k, v]) => [k, +(v * 100).toFixed(1)]))));
for (const g of GD.Genes.KEYS) {
  const lo = batch(g, 0.1), hi = batch(g, 0.9);
  console.log(`${GD.Roster.GENE_LABELS[g].padEnd(4, '　')} 低(0.1)→高(0.9) | 好人鑑寶票命中真品 ${f(lo.real)} → ${f(hi.real)} | 好人鑑人命中老朝奉 ${f(lo.lao)} → ${f(hi.lao)} | 壞人勝率 ${f(lo.evilWin)} → ${f(hi.evilWin)} | 被騙票比例 ${f(lo.duped)} → ${f(hi.duped)}`);
}
