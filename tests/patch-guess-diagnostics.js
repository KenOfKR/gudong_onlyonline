const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, 'sim-evil-strategy-ab.js');
let src = fs.readFileSync(target, 'utf8');

function replaceOnce(oldText, newText, label) {
  const first = src.indexOf(oldText);
  if (first < 0 || src.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`${label}：錨點不存在或不唯一，未寫入修改。`);
  }
  src = src.slice(0, first) + newText + src.slice(first + oldText.length);
}

replaceOnce(
  '    games: 0, goodWins: 0, badWins: 0, errors: 0,',
  `    games: 0, goodWins: 0, badWins: 0, errors: 0,
    guessHitGames: 0, guessHitBadWins: 0,
    guessMissGames: 0, guessMissBadWins: 0,
    noGuessGames: 0, noGuessBadWins: 0,`,
  'createStats 計數器'
);

replaceOnce(
  'function collect(room, stats) {',
  `function diagnoseZhengGuess(room) {
  let hasGuess = false;
  let hasHit = false;

  const zheng = (room.players || []).find(p => p.role === '鄭國渠');
  if (!zheng) return { hasGuess, hasHit };

  for (const rd of room.rounds || []) {
    const m = rd.mind && rd.mind[zheng.id];
    if (!m || !m.inferredBuddyId) continue;

    hasGuess = true;
    const guessed = U.byId(room, m.inferredBuddyId);

    if (guessed && ['老朝奉', '藥不然'].includes(guessed.role)) {
      hasHit = true;
    }
  }

  return { hasGuess, hasHit };
}

function collect(room, stats) {`,
  'collect 函式'
);

replaceOnce(
  '  const goodWon = !!room.gameOver.xuWon;',
  `  const goodWon = !!room.gameOver.xuWon;

  // 每局只分類一次；曾猜中至少一次就歸入「曾命中」。
  const guessDiag = diagnoseZhengGuess(room);

  if (!guessDiag.hasGuess) {
    stats.noGuessGames++;
    if (!goodWon) stats.noGuessBadWins++;
  } else if (guessDiag.hasHit) {
    stats.guessHitGames++;
    if (!goodWon) stats.guessHitBadWins++;
  } else {
    stats.guessMissGames++;
    if (!goodWon) stats.guessMissBadWins++;
  }`,
  'collect 勝負分類'
);

// 以正規表示式定位 printStats 的結尾，兼容 Windows/Unix 換行。
const boundary = /\r?\n}\r?\n\r?\nconst statsBase = createStats\(\);/g;
const matches = [...src.matchAll(boundary)];

if (matches.length !== 1) {
  throw new Error(
    `printStats 報表：結尾錨點應出現一次，實際找到 ${matches.length} 次。未寫入修改。`
  );
}

const nl = src.includes('\r\n') ? '\r\n' : '\n';

const reportLines = [
  '',
  '  const classifiedGames =',
  '    stats.guessHitGames + stats.guessMissGames + stats.noGuessGames;',
  '',
  '  console.log(',
  "    '鄭國渠推測診斷：曾命中 ' +",
  "    pct(stats.guessHitBadWins, stats.guessHitGames) +",
  "    ' 壞人勝率；有推測但未命中 ' +",
  "    pct(stats.guessMissBadWins, stats.guessMissGames) +",
  "    ' 壞人勝率；沒有推測 ' +",
  "    pct(stats.noGuessBadWins, stats.noGuessGames) + ' 壞人勝率'",
  '  );',
  '',
  "  console.log('推測分類局數：' + classifiedGames + '/' + stats.games);",
  '',
  '  if (classifiedGames !== stats.games) {',
  "    console.error('診斷錯誤：推測分類局數與總局數不一致。');",
  '  }',
  '}',
  '',
  'const statsBase = createStats();'
].join(nl);

src = src.replace(boundary, reportLines);

const backup = target + '.before-guess-diagnostics-auto.bak';
fs.copyFileSync(target, backup);
fs.writeFileSync(target, src, 'utf8');

console.log('補丁已套用。備份：' + backup);
