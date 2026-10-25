/* ============================================================================
 * tests/run_sim.js — 策略層與發言層連動・單局詳細追蹤模擬器
 * 驗證目標：
 *   1) solveJointRoles 5040 種聯合機率剪枝是否消除世界線矛盾
 *   2) 客觀鐵證（投公開贗品、言行不一）是否成功驅動質詢與發言引用
 *   3) 方震/許願隱蔽保護（方震不裸跳陣營查驗、被偷襲者不自爆）
 * 用法：
 *   node tests/run_sim.js [隨機種子，預設 42]
 * ========================================================================== */
const path = require('path');
const harnessPath = path.join(__dirname, 'harness.js');
const GD = require(harnessPath)();
const { Engine, Strategy, Speech, Mind, U } = GD;

// 1. 關閉 Gemini 雲端代理，強制採用本地說服型推理發言引擎
GD.store.set(GD.CONFIG.STORAGE.useGemini, false);

const SEED = process.argv[2] || '42';
console.log(`\n============================================================`);
console.log(` 🎮 《古董局中局》單局詳細模擬（PRNG 種子：${SEED}）`);
console.log(`============================================================\n`);

// 2. 初始化房間並補滿電腦
const room = Engine.newRoom('SIM_' + SEED, 'sim_host');
Engine.fillBots(room);
Engine.start(room);

const pad = (s, n = 8) => String(s || '').padEnd(n, ' ');
const roleCamp = r => GD.isGood(r) ? '【好人】' : '【壞人】';

console.log('【座位與底牌配置】');
room.players.forEach((p, idx) => {
  const c = U.colorOf(p);
  console.log(`  座位 ${idx + 1}：[${c.name}] ${p.name.padEnd(6, ' ')} -> ${p.role.padEnd(5, ' ')} ${roleCamp(p.role)}`);
});
console.log('------------------------------------------------------------\n');

let guard = 0;
while (room.status !== 'gameover' && guard++ < 300) {
  const rIdx = room.currentRoundIdx;
  const rd = U.curRound(room);

  // ---------------- 階段 A：查驗與技能 ----------------
  if (room.status === 'playing') {
    const p = U.byId(room, room.currentTurnPlayerId);
    const log = Engine.log(room, p.id);

    if (log.step === 'a') {
      const picks = Strategy.inspectPicks(p, room);
      picks.forEach(beastName => Engine.inspect(room, p.id, beastName));
    }

    const A = Mind.analyze(p, room);
    const skillAct = Strategy.skill(p, room, A);
    Engine.skill(room, p.id, skillAct);

    const nextId = Strategy.nextPlayer(p, room, A);
    Engine.pass(room, p.id, nextId);
  }

  // ---------------- 階段 B：陳詞發言 ----------------
  else if (room.status === 'discussion') {
    const p = U.byId(room, room.currentSpeakerId);
    const { plan, A } = Strategy.plan(p, room);
    const text = Speech.localSpeech(p, room, plan, A);
    const v = Speech.validate(text, p, room, plan, A);

    if (!rd._printedHeader) {
      console.log(`>>> 【第 ${rIdx + 1} 回合陳詞】本輪四獸首：${rd.beasts.map(b => `【${b.name}】(${b.isReal ? '真' : '假'})`).join(' ')}`);
      rd._printedHeader = true;
    }

    const c = U.colorOf(p);
    console.log(`\n🗣️  [${c.name}・${p.name}]（${p.role}）發言：`);
    console.log(`   「${text}」`);

    // 檢查驗證狀態與鐵證引用
    if (!v.ok) {
      console.warn(`   ⚠️ 發言自檢警示：${v.why}`);
    }
    if (plan.askId) {
      const target = U.byId(room, plan.askId);
      console.log(`   📌 [鐵證質詢觸發] 點名質問 ${U.tag(target)}：累計 ${plan.askVotes} 票投在贗品【${plan.askBeast}】`);
    }

    Engine.speak(room, p.id, { text, source: 'bot' });
  }

  // ---------------- 階段 C：鑑寶投票 ----------------
  else if (room.status === 'voting') {
    console.log(`\n🗳️  【第 ${rIdx + 1} 回合鑑寶投票明細】`);
    room.players.forEach(p => {
      if (rd.votes[p.id] === undefined) {
        const ballot = Strategy.ballot(p, room);
        Engine.vote(room, p.id, ballot);
        const bStr = Object.entries(ballot).map(([k, v]) => `【${k}】${v}票`).join('、') || '保留籌碼';
        console.log(`   ${U.tag(p)}：${bStr}`);
      }
    });

    const vr = rd.voteResults;
    console.log(`\n📊 【第 ${rIdx + 1} 回合開票結果】`);
    console.log(`   🥇 第一名（封存）：【${vr.rank1.name}】(${vr.rank1.votes} 票，真實為 ${vr.rank1.isReal ? '真品' : '贗品'})`);
    console.log(`   🥈 第二名（公開）：【${vr.rank2.name}】(${vr.rank2.votes} 票，揭曉為 ${vr.rank2.isReal ? '✓真品' : '✕贗品'})`);
    console.log('------------------------------------------------------------\n');

    Engine.advance(room);
  }

  // ---------------- 階段 D：終局鑑人 ----------------
  else if (room.status === 'person_voting') {
    console.log(`🎯 【終局鑑人決策與 5040 種聯合機率剪枝驗證】`);
    room.players.forEach(p => {
      if (!room.personVotes[p.id]) {
        const decision = Strategy.personVote(p, room);
        p.final = decision;
        Engine.personVote(room, p.id, decision.targetId);

        const tgt = U.byId(room, decision.targetId);
        const isTargetLao = tgt.role === '老朝奉';
        console.log(`   ${U.tag(p)}（${p.role}）指認 ➔ ${U.tag(tgt)}（${tgt.role}）${GD.isGood(p.role) ? (isTargetLao ? ' ✓ [抓中老朝奉]' : ' ✕ [抓錯]') : ''}`);
        if (decision.why) console.log(`      └─ 理由：${decision.why}`);
      }
    });
  }
}

// ---------------- 結算覆盤 ----------------
console.log(`\n============================================================`);
console.log(` 🏆 【對局結果總結】`);
console.log(`============================================================`);
const g = room.gameOver;
console.log(`獲勝陣營：${g.xuWon ? '🎉 許願陣營獲勝' : '😈 老朝奉陣營獲勝'}`);
console.log(`總得分數：${g.totalScore} 分（勝負門檻：${GD.CONFIG.WIN_SCORE} 分）`);
console.log(`  • 保留真品數：${g.savedReal} / 4 尊`);
console.log(`  • 抓出老朝奉：${g.laoCaught ? '成功 (+1分)' : '失敗 (+0分)'}（${g.votesForLao}/${g.goodCount} 票）`);
console.log(`  • 方震存活：${g.fangCaught ? '被抓 (+0分)' : '未被抓 (+1分)'}`);
console.log(`  • 許願存活：${g.xuCaught ? '被抓 (+0分)' : '未被抓 (+2分)'}`);
console.log(`============================================================\n`);