'use strict';
const GD = require('./harness')();
const { Engine, Strategy, Mind, U } = GD;
if (GD.store && GD.CONFIG?.STORAGE?.useGemini) GD.store.set(GD.CONFIG.STORAGE.useGemini, false);

let failures = 0;
function check(ok, message) {
  if (ok) console.log(`✓ ${message}`);
  else {
    failures++;
    console.error(`✗ ${message}`);
  }
}

function scenario(seed, fangPosition = 5, knownEvil = false) {
  const room = Engine.newRoom(`FANG_V3_${seed}`, 'test-host');
  Engine.fillBots(room);
  if (!Engine.start(room)) throw new Error('Engine.start 失敗');

  const seats = U.seated(room);
  const roles = ['許願', '黃煙煙', '木戶加奈', '鄭國渠', '老朝奉', '方震', '姬雲浮', '藥不然'];
  const fangIndex = roles.indexOf('方震');
  [roles[fangPosition], roles[fangIndex]] = [roles[fangIndex], roles[fangPosition]];
  seats.forEach((p, i) => { p.role = roles[i]; });

  const fang = seats[fangPosition];
  const low = seats[6];
  const high = seats[7];
  const round1 = room.rounds[0];
  const round2 = Engine.drawRound(room, 2);
  const round3 = Engine.drawRound(room, 3);

  room.rounds = [round1, round2, round3];
  room.currentRoundIdx = 2;
  room.status = 'playing';
  room.currentTurnPlayerId = fang.id;
  round3.passOrder = seats.slice(0, fangPosition + 1).map(p => p.id);
  round3.turnLogs[fang.id] = {
    inspect: [], step: 'c', blind: false, passWhy: ''
  };

  if (knownEvil) {
    round1.turnLogs[fang.id] = {
      inspect: [], fangTargetId: high.id, fangCamp: 'evil'
    };
  }
  return { room, fang, low, high, round3 };
}

function profile(A, p, evil, ally = 0) {
  const r = A.prof[p.id] || (A.prof[p.id] = {
    player: p, evil: 0, ally: 0, reasons: [], probs: {}
  });
  Object.assign(r, {
    player: p, evil, ally,
    reasons: r.reasons || [],
    probs: r.probs || {}
  });
}

function testKnownEvilCanBeChosen() {
  const s = scenario('COVER', 0, true);
  const A = Mind.analyze(s.fang, s.room);
  const left = Engine.remainingToAct(s.room);

  left.forEach(p => profile(A, p, 10, 0));
  profile(A, s.high, 0, 100);

  const selected = Strategy.nextPlayer(s.fang, s.room, A);
  const reason = String(A.ctx.log.passWhy || '');

  check(A.ctx.t === 2 && A.ctx.myPos === 0 && left.includes(s.high),
    '前置條件成立：第三輪、方震第一位、已知壞人尚未行動');
  check(selected === s.high.id,
    '不會硬性禁止傳給已知壞人，策略可依信任排序選中他');
  check(/方震查驗線索|身分掩護|誤傳|判斷失誤/.test(reason),
    '選中已知壞人時，理由有合理的身分掩護解釋');
  check(!/(?:為避免|白拿|保留|爭取|搶走|取得|拿到)[^，。；]{0,60}(?:下一回合|下輪)[^，。；]{0,20}(?:首家|先手)|(?:下一回合|下輪)[^，。；]{0,20}(?:首家|先手)[^，。；]{0,30}(?:留給|保留|爭取|搶走)/.test(reason),
    '第三輪沒有引用不存在的下一輪首家優勢');
}

function testKnownEvilHeldForTail() {
  const s = scenario('TAIL', 5, true);
  const A = Mind.analyze(s.fang, s.room);
  const left = Engine.remainingToAct(s.room);
  const selected = Strategy.nextPlayer(s.fang, s.room, A);
  const reason = String(A.ctx.log.passWhy || '');

  check(A.ctx.myPos === 5 && left.length === 2 && left.includes(s.high),
    '前置條件成立：方震第六位、剩兩人、已知壞人尚未行動');
  check(selected !== s.high.id,
    '第六位控尾家時，優先將已知壞人留在第八位');
  check(reason.includes('第八位尾家') &&
    !/(?:為避免|白拿|保留|爭取|搶走|取得|拿到)[^，。；]{0,60}(?:下一回合|下輪)[^，。；]{0,20}(?:首家|先手)|(?:下一回合|下輪)[^，。；]{0,20}(?:首家|先手)[^，。；]{0,30}(?:留給|保留|爭取|搶走)/.test(reason),
    '理由符合最後一輪控尾家邏輯');
}

function testTailControlWithoutKnownEvil() {
  const s = scenario('NO_KNOWN_TAIL', 5, false);
  const A = Mind.analyze(s.fang, s.room);
  profile(A, s.low, 10, 0);
  profile(A, s.high, 80, 0);
  A.laoIntersectIds = [];

  const selected = Strategy.nextPlayer(s.fang, s.room, A);
  const reason = String(A.ctx.log.passWhy || '');

  check(selected === s.low.id,
    '沒有已知壞人時，低嫌疑者先走第七位、高嫌疑者留第八位');
  check(reason.includes('嫌疑較低') &&
    reason.includes('嫌疑較高') &&
    reason.includes('尾家'),
    '控尾家理由與實際選擇一致');
  check(!/(?:為避免|白拿|保留|爭取|搶走|取得|拿到)[^，。；]{0,60}(?:下一回合|下輪)[^，。；]{0,20}(?:首家|先手)|(?:下一回合|下輪)[^，。；]{0,20}(?:首家|先手)[^，。；]{0,30}(?:留給|保留|爭取|搶走)/.test(reason),
    '最後一輪沒有使用不存在的下一輪首家優勢');
}

try {
  console.log('=== 方震第三輪動態策略定向測試 v3 ===');
  testKnownEvilCanBeChosen();
  testKnownEvilHeldForTail();
  testTailControlWithoutKnownEvil();
  console.log(`\n測試結果：${failures === 0 ? '全部通過' : '有失敗項'}｜失敗 ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error('\n測試執行失敗：', e && e.stack ? e.stack : e);
  process.exitCode = 1;
}

