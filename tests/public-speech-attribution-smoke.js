'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Claims } = GD;

const room = {
  currentRoundIdx: 0,
  players: [
    { id: 'h', name: 'H小姐' },
    { id: 'p', name: '佩萱' }
  ],
  rounds: [{ beasts: ['鼠', '狗', '馬', '猴'].map(name => ({ name })) }]
};

try {
  const transcript = '紅色【H小姐】的原話我有收到：前手主張：【狗】贗品；前手號召投【鼠】；前手將疑點指向紫色【佩萱】。我會依公開紀錄逐項核對。我的公開判斷是【馬】假。我把【猴】列為主要票向，並號召投【猴】；若有分票，應以公開證據與票差說明。';
  const parsed = Claims.parse(transcript, room, room.rounds[0]);
  assert.deepStrictEqual(parsed.claims, [{ beast: '馬', real: false }],
    '前手引用的【狗】贗品不得變成目前發言者自己的真假宣稱');
  assert.strictEqual(parsed.callBeast, '猴',
    '前手引用的「投【鼠】」不得成為目前發言者的第一個票向');
  assert.deepStrictEqual(parsed.callBeasts, ['猴'],
    '目前發言者自己的票向清單不得混入引用的【鼠】');
  assert.strictEqual(parsed.callSuspectId, null,
    '引用前手將疑點指向佩萱，不得變成目前發言者的集火指認');

  // 舊紀錄中 p 欄位已被錯誤解析時，parseRecord 仍必須以公開文字重算真假宣稱與票向。
  const poisonedRecord = {
    playerId: 'bot-bear', speakerName: '熊寶', text: transcript,
    p: {
      claims: [{ beast: '狗', real: false }, { beast: '馬', real: false }],
      callBeast: '鼠', callBeasts: ['鼠', '猴'], callSuspectId: 'p'
    }
  };
  const repaired = Claims.parseRecord(poisonedRecord, room, room.rounds[0]);
  assert.deepStrictEqual(repaired.claims, [{ beast: '馬', real: false }],
    'parseRecord must not re-import quoted claims from stale p metadata');
  assert.strictEqual(repaired.callBeast, '猴',
    'parseRecord must ignore stale structured callBeast when it contradicts visible speech');
  assert.deepStrictEqual(repaired.callBeasts, ['猴'],
    'parseRecord must ignore stale structured callBeasts when they include quoted calls');
  assert.strictEqual(repaired.callSuspectId, null,
    'quoted player suspicion must remain attributed to the original speaker');

  // 同一句中引用別人的票向後，發言者明確以「但我」提出自己的票向，必須正常保留。
  const contrast = Claims.parse('紅色【H小姐】希望大家投【鼠】，我聽到了；但我建議大家投【馬】。', room, room.rounds[0]);
  assert.deepStrictEqual(contrast.callBeasts, ['馬'],
    '引用句之後的第一人稱明確票向不得被引用上下文吞掉');

  // 單純回顧前手發言不得建立自己的 call 或 claim。
  const history = Claims.parse('前手曾主張【狗】贗品，也號召投【鼠】。', room, room.rounds[0]);
  assert.deepStrictEqual(history.claims, [], '前手回顧的真假宣稱不屬於當前發言者');
  assert.deepStrictEqual(history.callBeasts, [], '前手回顧的票向不屬於當前發言者');


  // parseRecord 與 parse() 必須使用一致的轉述詞彙；「剛才表示」不能讓舊 metadata 復活。
  const justReported = Claims.parseRecord({
    text: '紅色【H小姐】剛才表示【狗】是真品。',
    p: { claims: [{ beast: '狗', real: true }], callBeast: '狗', callBeasts: ['狗'] }
  }, room, room.rounds[0]);
  assert.deepStrictEqual(justReported.claims, [], '「剛才表示」的轉述不得重新匯入舊真假宣稱');
  assert.strictEqual(justReported.callBeast, null, '「剛才表示」的轉述不得重新匯入舊落票號召');

  const reasoningText = '【張懿】與【佩萱】之中有老朝奉，我第一回驗【蛇】真，開出來【蛇】贗品，信我！';
  const reasoningRoom = { currentRoundIdx: 0, players: [{ id: 'z', name: '張懿' }, { id: 'p', name: '佩萱' }],
    rounds: [{ beasts: ['鼠', '牛', '虎', '蛇'].map(name => ({ name })) }] };
  const reasoning = Claims.parse(reasoningText, reasoningRoom, reasoningRoom.rounds[0]);
  assert.strictEqual(reasoning.candidateSets.length, 1, 'must preserve a multi-person one-of candidate group');
  assert.deepStrictEqual(reasoning.candidateSets[0].candidateIds, ['z', 'p'], 'candidate group must preserve both named players');
  assert.strictEqual(reasoning.inspectionReports.length, 1, 'must preserve the historic inspection report');
  assert.strictEqual(reasoning.inspectionReports[0].round, 1, 'historic report must preserve its round');
  assert.strictEqual(reasoning.inspectionReports[0].beast, '蛇', 'historic report must preserve its beast');
  assert.strictEqual(reasoning.inspectionReports[0].claimedReal, true, 'historic report must preserve the speaker claimed result');
  assert.strictEqual(reasoning.claims.length, 0, 'historical report and public reveal must not create a current-round beast claim even when the beast name is in the active whitelist');
  const rebuilt = Claims.parseRecord({ text: reasoningText, p: { candidateSets: [], inspectionReports: [] } }, reasoningRoom, reasoningRoom.rounds[0]);
  assert.strictEqual(rebuilt.candidateSets.length, 1, 'parseRecord must rebuild candidate sets from public wording');
  assert.strictEqual(rebuilt.inspectionReports.length, 1, 'parseRecord must rebuild inspection reports from public wording');
  const quoted = Claims.parse('我聽到前手原話：張懿與佩萱之中有老朝奉，我第一回驗蛇真。', reasoningRoom, reasoningRoom.rounds[0]);
  assert.strictEqual(quoted.candidateSets.length, 0, 'quoted candidate groups must not be attributed to the current speaker');
  assert.strictEqual(quoted.inspectionReports.length, 0, 'quoted historical inspections must not be attributed to the current speaker');
  const denied = Claims.parse('我不認為張懿與佩萱之中有老朝奉。', reasoningRoom, reasoningRoom.rounds[0]);
  assert.strictEqual(denied.candidateSets.length, 0, 'negated candidate groups must not become accusations');
  console.log('公開發言解析測試通過：原有歸屬／引用回歸，加上複數嫌疑集合、歷史查驗回報與否定歸屬保護。');
  process.exit(0);
} catch (error) {
  console.error('公開發言解析測試失敗：', error && error.stack || error);
  process.exit(1);
}
