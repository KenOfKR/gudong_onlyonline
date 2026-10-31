/* ============================================================================
 * tests/lib/play.js — 隔離亂數流與凍結基因的單局模擬沙盒（完全確定性版）
 * ========================================================================== */
'use strict';

function playOne(GD, { seed, brains = {}, genes = {} }) {
  const { U, Engine, Roster } = GD;

  // 1. 建立獨立種子流
  const dealerStream = U.rngStream(seed + '_dealer');
  const seatStreams = {};

  // ★ 強制將目前作用中的全域流切換成發牌流
  U.useStream(dealerStream);

  // 2. 開局建立房間
  const room = Engine.newRoom(`test_${seed}`);
  room.mode = 'solo';

  // 關閉 Gemini
  GD.Gemini = { enabled: () => false, state: {} };

  // ★ 使用發牌流確定性抽籤（洗牌並抽出 8 位電腦）
  const rosterCopy = Roster.list.slice();
  const pool = U.shuffle(rosterCopy);
  for (let i = 0; i < 8; i++) {
    const b = pool.pop();
    Engine.addPlayer(room, { id: U.uid('bot_' + b.id), name: b.name, isBot: true, botId: b.id });
  }

  // 為 8 個座位建立各自專屬的決策流
  const seatedPlayers = U.seated(room);
  seatedPlayers.forEach(p => {
    seatStreams[p.id] = U.rngStream(seed + '_seat_' + p.seatIndex);
  });

  // 確保發牌流主導開局（抽首家、獸首、真偽、角色）
  U.useStream(dealerStream);
  Engine.start(room);

  // 覆寫基因與大腦旗標 (確保不會退化成 undefined)
  room.players.forEach(p => {
    const rawGene = genes[p.id] || genes[p.botId] || (genes && genes[p.id?.replace(/^bot_/, '')]);
    p.genes = rawGene ? { ...rawGene } : Roster.baseGenes(p.botId);
    p.brain = brains[p.id] || brains[p.botId] || {};
  });

  // 3. 遊戲主迴圈
  const maxSteps = 500;
  let step = 0;

  while (room.status !== 'gameover' && step++ < maxSteps) {
    if (room.status === 'voting') {
      U.seated(room).forEach(p => {
        const curRd = room.rounds[room.currentRoundIdx];
        if (curRd && curRd.votes[p.id] === undefined) {
          U.useStream(seatStreams[p.id]);
          Engine.vote(room, p.id, GD.Strategy.ballot(p, room));
        }
      });
      U.useStream(dealerStream);
      Engine.advance(room);
      continue;
    }

    if (room.status === 'person_voting') {
      U.seated(room).forEach(p => {
        if (!room.personVotes[p.id]) {
          U.useStream(seatStreams[p.id]);
          const d = GD.Strategy.personVote(p, room);
          p.final = { why: d.why, followId: d.followId, top: d.top };
          Engine.personVote(room, p.id, d.targetId);
        }
      });
      continue;
    }

    let actingPid = null;
    if (room.status === 'playing') actingPid = room.currentTurnPlayerId;
    else if (room.status === 'discussion') actingPid = room.currentSpeakerId;

    if (actingPid) {
      U.useStream(seatStreams[actingPid]);
      const bot = U.byId(room, actingPid);
      if (room.status === 'playing') {
        const log = Engine.log(room, actingPid);
        if (log.step === 'a') {
          const picks = GD.Strategy.inspectPicks(bot, room) || [];
          picks.forEach(n => { if (Engine.log(room, actingPid).step === 'a') Engine.inspect(room, actingPid, n); });
          if (Engine.log(room, actingPid).step === 'a') {
            const rd = U.curRound(room);
            for (const b of rd.beasts) { if (Engine.log(room, actingPid).step !== 'a') break; Engine.inspect(room, actingPid, b.name); }
          }
        }
        const A = GD.Mind.analyze(bot, room);
        if (Engine.log(room, actingPid).step === 'b') {
          Engine.skill(room, actingPid, GD.Strategy.skill(bot, room, A));
        }
        if (Engine.log(room, actingPid).step === 'c') {
          Engine.pass(room, actingPid, GD.Strategy.nextPlayer(bot, room, A));
        }
      } else if (room.status === 'discussion') {
        const A = GD.Mind.analyze(bot, room);
        const plan = GD.Strategy.plan(bot, room).plan;
        const text = GD.Speech.localSpeech(bot, room, plan, A);
        Engine.speak(room, actingPid, { text, source: 'bot' });
      }
    } else {
      break;
    }
  }

  return room;
}

module.exports = { playOne };