'use strict';

/*
 * 方震第三輪定向策略測試
 * 用法（在 gudong_onlyonline 專案根目錄）：
 *   node tests/fang-round3-targeted.js
 *
 * 此測試只建立記憶體中的模擬房間，直接呼叫 Strategy.nextPlayer；
 * 不會修改 js/bot/strategy.js，也不會部署或寫入正式遊戲資料。
 */
const GD = require('./harness')();
const { Engine, Strategy, Mind, U } = GD;

if (GD.store && GD.CONFIG?.STORAGE?.useGemini) {
  GD.store.set(GD.CONFIG.STORAGE.useGemini, false);
}

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    failures++;
    console.error(`✗ ${message}`);
  }
}

function createScenario(seed, knownEvil) {
  const room = Engine.newRoom(`FANG_TEST_${seed}`, 'test-host');
  Engine.fillBots(room);
  if (!Engine.start(room)) throw new Error('Engine.start 失敗');

  const seats = U.seated(room);
  if (seats.length !== 8) throw new Error(`預期 8 名玩家，實際 ${seats.length}`);

  // 固定角色，只控制測試情境；正式對局資料不會被改動。
  const roles = ['許願', '黃煙煙', '木戶加奈', '鄭國渠', '老朝奉', '方震', '姬雲浮', '藥不然'];
  seats.forEach((p, i) => { p.role = roles[i]; });

  const fang = seats[5];
  const lowCandidate = seats[6];
  const highCandidate = seats[7];

  const round1 = room.rounds[0];
  const round2 = Engine.drawRound(room, 2);
  const round3 = Engine.drawRound(room, 3);
  room.rounds = [round1, round2, round3];
  room.currentRoundIdx = 2;
  room.status = 'playing';
  room.currentTurnPlayerId = fang.id;

  // 前六位已行動，方震是第六位；只剩第七、八位尚未行動。
  round3.passOrder = seats.slice(0, 6).map(p => p.id);
  round3.turnLogs[fang.id] = {
    inspect: [], step: 'c', blind: false, passWhy: ''
  };

  if (knownEvil) {
    // 方震在前一輪已查驗確認第八位玩家是壞人。
    round1.turnLogs[fang.id] = {
      inspect: [], fangTargetId: highCandidate.id, fangCamp: 'evil'
    };
  }

  return { room, fang, lowCandidate, highCandidate, round3, knownEvil };
}

function profileFor(A, p, { evil, ally = 0, lao = 0 }) {
  if (!A.prof[p.id]) {
    A.prof[p.id] = { player: p, evil: 0, ally: 0, reasons: [], probs: {} };
  }
  const r = A.prof[p.id];
  r.player = p;
  r.evil = evil;
  r.ally = ally;
  r.reasons = r.reasons || [];
  r.probs = r.probs || {};
  r.probs['老朝奉'] = lao;
}

function testKnownEvilCase() {
  const s = createScenario('KNOWN_EVIL', true);
  const A = Mind.analyze(s.fang, s.room);
  const left = Engine.remainingToAct(s.room);
  const chosenId = Strategy.nextPlayer(s.fang, s.room, A);
  const reason = String(A.ctx.log.passWhy || '');

  check(A.ctx.t === 2 && A.ctx.myPos === 5 && left.length === 2,
    '測試前置條件成立：第三輪、方震第六位、剩餘兩人');
  check(left.some(p => p.id === s.highCandidate.id),
    '已查明的壞人確實是剩餘未行動者之一');
  check(chosenId !== s.highCandidate.id,
    '方震已查出壞人時，不會直接把手機傳給已知壞人');
  check(reason.includes('第三輪') && reason.includes('尾家') && !reason.includes('白拿下一回合首家優勢'),
    '決策理由符合最後一輪控尾家，沒有沿用舊的錯誤動機');
}

function testTailControlWithoutKnownEvil() {
  const s = createScenario('NO_KNOWN_EVIL', false);
  const A = Mind.analyze(s.fang, s.room);
  const left = Engine.remainingToAct(s.room);

  // 刻意設定明顯不同的嫌疑分數，驗證實際選人方向，不靠隨機局勢。
  profileFor(A, s.lowCandidate, { evil: 10, ally: 0, lao: 0 });
  profileFor(A, s.highCandidate, { evil: 80, ally: 0, lao: 0 });
  A.laoIntersectIds = [];

  const chosenId = Strategy.nextPlayer(s.fang, s.room, A);
  const reason = String(A.ctx.log.passWhy || '');

  check(A.ctx.t === 2 && A.ctx.myPos === 5 && left.length === 2,
    '測試前置條件成立：第三輪、方震第六位、剩餘兩人');
  check(chosenId === s.lowCandidate.id,
    '沒有已知壞人時，低嫌疑者先走第七位，高嫌疑者留第八位');
  check(reason.includes('嫌疑較低') && reason.includes('嫌疑較高') && reason.includes('尾家'),
    '控尾家理由包含低嫌疑先行、高嫌疑留尾家的資訊');
  check(!reason.includes('掌握下輪首家先手權') && !reason.includes('下一輪首家優勢'),
    '第三輪理由不再引用不存在的下一輪首家優勢');
}

try {
  console.log('=== 方震第三輪定向策略測試 ===');
  testKnownEvilCase();
  testTailControlWithoutKnownEvil();
  console.log(`\n測試結果：${failures === 0 ? '全部通過' : '有失敗項'}｜失敗 ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error('\n測試執行失敗：', error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
