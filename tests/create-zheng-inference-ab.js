const fs = require('node:fs');
const path = require('node:path');

const input = path.join(__dirname, 'sim-evil-strategy-ab.js');
const output = path.join(__dirname, 'sim-zheng-inference-ab.js');

if (!fs.existsSync(input)) {
  throw new Error('找不到原始配對測試檔。');
}
if (fs.existsSync(output)) {
  throw new Error('新測試檔已存在；為避免覆蓋，請先檢查該檔案。');
}

let src = fs.readFileSync(input, 'utf8');

function replaceOnce(oldText, newText, label) {
  const first = src.indexOf(oldText);
  if (first < 0 || src.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(label + '：錨點不存在或不唯一，未建立測試檔。');
  }
  src = src.slice(0, first) + newText + src.slice(first + oldText.length);
}

const setupStart =
  "const baselineStrategyPath = path.join(__dirname, 'fixtures', 'strategy.pre-evil-macro-v1.js');";
const setupEnd = 'GD.Speech = treatment.speech;';

const start = src.indexOf(setupStart);
const end = src.indexOf(setupEnd, start);

if (
  start < 0 ||
  src.indexOf(setupStart, start + setupStart.length) >= 0 ||
  end < 0 ||
  src.indexOf(setupEnd, end + setupEnd.length) >= 0
) {
  throw new Error('原始策略載入區塊不符合預期，未建立測試檔。');
}

const replacementSetup = `
const strategyPath = path.join(ROOT, 'js', 'bot', 'strategy.js');
const liveStrategySource = fs.readFileSync(strategyPath, 'utf8');

// 保留目前策略作為「推測開啟」組。
const enabledStrategy = GD.Strategy;
const sharedSpeech = GD.Speech;

// 僅替換 inferEvilTeammate 函式本身，其他程式碼保持完全相同。
const inferenceStart = '  function inferEvilTeammate(bot, A, room) {';
const inferenceEnd = '\\n  function bestFinalRoleCandidate(bot, room, A, targetRole) {';

const inferenceAt = liveStrategySource.indexOf(inferenceStart);
const nextFunctionAt = liveStrategySource.indexOf(
  inferenceEnd,
  inferenceAt + inferenceStart.length
);

if (
  inferenceAt < 0 ||
  liveStrategySource.indexOf(inferenceStart, inferenceAt + inferenceStart.length) >= 0 ||
  nextFunctionAt < 0 ||
  liveStrategySource.indexOf(inferenceEnd, nextFunctionAt + inferenceEnd.length) >= 0
) {
  throw new Error('策略函式邊界不符合預期，停止測試。');
}

const disabledStrategySource =
  liveStrategySource.slice(0, inferenceAt) +
  '  function inferEvilTeammate(bot, A, room) { return null; }' +
  liveStrategySource.slice(nextFunctionAt);

// 在記憶體中執行關閉推測的策略副本，不寫回正式策略檔。
const Module = require('node:module');
const testModule = new Module(strategyPath, module);
testModule.filename = strategyPath;
testModule.paths = Module._nodeModulePaths(path.dirname(strategyPath));
testModule._compile(disabledStrategySource, strategyPath);

const disabledStrategy = GD.Strategy;

if (
  !enabledStrategy ||
  !disabledStrategy ||
  enabledStrategy === disabledStrategy ||
  typeof enabledStrategy.personVote !== 'function' ||
  typeof disabledStrategy.personVote !== 'function'
) {
  throw new Error('策略副本建立失敗，停止測試。');
}

const baseline = {
  strategy: disabledStrategy,
  speech: sharedSpeech
};
const treatment = {
  strategy: enabledStrategy,
  speech: sharedSpeech
};

GD.Strategy = treatment.strategy;
GD.Speech = treatment.speech;
`.trimStart();

src = src.slice(0, start) +
  replacementSetup +
  src.slice(end + setupEnd.length);

replaceOnce(
  'console.log(`=== 壞人宏觀策略配對 A/B：${N} 組固定種子，兩組皆使用出廠基因、不啟動學習 ===`);',
  'console.log(`=== 鄭國渠推測功能配對 A/B：${N} 組固定種子，兩組皆使用出廠基因、不啟動學習 ===`);',
  '測試標題'
);

replaceOnce(
  "printStats('基準策略', statsBase);",
  "printStats('推測關閉', statsBase);",
  '關閉推測標籤'
);

replaceOnce(
  "printStats('壞人宏觀策略 v1', statsNew);",
  "printStats('推測開啟', statsNew);",
  '開啟推測標籤'
);

replaceOnce(
  '新策略讓壞人由敗轉勝',
  '開啟推測後壞人由敗轉勝',
  '配對結果標籤一'
);

replaceOnce(
  '新策略讓壞人由勝轉敗',
  '開啟推測後壞人由勝轉敗',
  '配對結果標籤二'
);

fs.writeFileSync(output, src, 'utf8');
console.log('已建立獨立測試檔：' + output);
console.log('正式 strategy.js 與原始 A/B 測試檔均未修改。');
