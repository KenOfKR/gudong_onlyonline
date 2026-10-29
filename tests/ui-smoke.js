/* UI 冒煙測試：用極簡假 DOM 載入全部 UI 模組，真人以 UI 動作完整打完一局（其餘為電腦），
 * 每一步都觸發完整渲染，確認沒有執行期例外、沒有 "undefined"/"NaN" 漏進畫面。
 * 這不能取代真瀏覽器測試（版面/樣式/語音 API 無法驗證），只驗證渲染與動作接線。 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- 假 DOM ---------- */
const byId = {};
function mkEl(id) {
  const el = {
    id, hidden: false, innerHTML: '', textContent: '', value: '', open: false, disabled: false, dataset: {}, style: { setProperty() {} },
    className: '', children: [], offsetWidth: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild(c) { this.children.push(c); }, remove() {},
    querySelector: () => mkEl('q'), querySelectorAll: () => [], focus() {}, closest: () => null
  };
  return el;
}
global.document = {
  readyState: 'complete',
  getElementById: id => byId[id] || (byId[id] = mkEl(id)),
  querySelector: () => mkEl('q'), querySelectorAll: () => [],
  createElement: () => mkEl('new'),
  addEventListener() {}
};
global.window = global;
global.sessionStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } };
global.Image = function () {};
global.confirm = () => true;
global.alert = () => {};
global.fetch = () => Promise.reject(new Error('offline'));        // 驗證 Gemini 失敗時會安全退回本地
global.setInterval = () => 0;

const ORDER = ['config', 'utils', 'roster', 'core/rules', 'core/claims', 'core/engine', 'bot/genes', 'bot/mind', 'bot/dialogueBank', 'bot/tactics', 'bot/strategy',
  'bot/speech', 'bot/gemini', 'bot/driver', 'bot/learning', 'bot/review', 'net', 'voice', 'ui/art', 'ui/ui', 'ui/home', 'ui/board',
  'ui/console', 'ui/speech', 'ui/gameover', 'main'];
ORDER.forEach(m => require(path.join(ROOT, 'js', m + '.js')));
const GD = window.GD, { UI, Net, Engine, U } = GD;
Object.assign(GD.CONFIG.BOT_DELAY_MS, { turn: 3, speech: 3, vote: 3 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
global.__geminiMock = process.argv.includes('--gemini');

let fails = 0;
const bad = msg => { fails++; if (fails < 15) console.error('  ✗', msg); };
const dump = () => Object.entries(byId).filter(([, e]) => typeof e.innerHTML === 'string' && /undefined|NaN|\[object/.test(e.innerHTML)).map(([k]) => k);

(async () => {
  GD.store.set(GD.CONFIG.STORAGE.useGemini, false);
  UI.initHome();
  UI.showHome();
  await Net.join({ code: '4242', name: '測試員', asMode: 'solo', fillBots: true });
  UI.showBoard();
  await Net.act(r => Engine.start(r));
  const room = () => Net.room(), me = () => UI.me();
  const click = (act, arg) => { try { /* 直接呼叫 UI 註冊的動作 */ require(path.join(ROOT, 'js/ui/ui.js')); } catch (e) {} };

  /* 呼叫已註冊的 UI 動作（透過 document click 委派的同一張表）*/
  const press = (name, arg, ds = {}) => {
    const handlers = UI._acts || {};
    if (!handlers[name]) throw new Error('UI 未註冊動作 ' + name);
    return handlers[name](arg, { dataset: ds }, {});
  };

  let guard = 0, renders = 0;
  GD.bus.on('room', () => { renders++; const b = dump(); if (b.length) bad('畫面含 undefined/NaN：' + b.join(',')); });

  while (room().status !== 'gameover' && guard++ < 600) {
    const r = room(), rd = U.curRound(r), m = me();
    let did = false;

    if (r.status === 'playing' && r.currentTurnPlayerId === m.id) {
      const log = Engine.log(r, m.id);
      if (log.step === 'a') { for (const b of rd.beasts) { if (GD.Rules.inspectQuota(m) > log.inspect.length) { press('inspect', b.name); await settle(); } } did = true; }
      else if (log.step === 'b') { press('skill', 'skip'); did = true; }
      else { const left = Engine.remainingToAct(r); press('pass', left.length ? left[0].id : ''); did = true; }
    } else if (r.status === 'voting' && rd.votes[m.id] === undefined) {
      press('ballot', rd.beasts[0].name + '|1'); press('ballot', rd.beasts[1].name + '|1'); press('ballotSend'); did = true;
    } else if (r.status === 'voting' && rd.voteResults) { press('advance'); did = true; }
    else if (r.status === 'person_voting' && !r.personVotes[m.id]) { press('pvote', r.players.find(p => p.id !== m.id).id); did = true; }
    else if (r.status === 'discussion' && r.currentSpeakerId === m.id) { press('speakPass'); did = true; }

    if (did) await settle();
    else await sleep(8);                         // 輪到電腦：交給 driver 自動代打
  }
  for (let i = 0; i < 40 && !room().learning; i++) await sleep(50);
  await settle();

  if (room().status !== 'gameover') bad('未能打完（status=' + room().status + '）');
  UI.render();
  const html = byId.gameover.innerHTML;
  if (!/Mind-Map|推理覆盤/.test(html)) bad('終局面板缺少覆盤區');
  if (!/自我學習與基因修正/.test(html)) bad('終局面板缺少學習區');
  if ((html.match(/<details class="mind/g) || []).length !== 8) bad('覆盤數量應為 8（7 位電腦＋1 位真人），實際 ' + (html.match(/<details class="mind/g) || []).length);
  if (!room().learning) bad('learning 未寫入');
  const stale = dump(); if (stale.length) bad('最終畫面含 undefined：' + stale.join(','));

  console.log(`UI 冒煙測試：渲染 ${renders} 次｜失敗 ${fails}｜終局面板 ${html.length} 字元｜覆盤 ${(html.match(/<details class="mind/g) || []).length} 份`);
  const h = byId.speechBody.innerHTML;
  console.log('發言區含摘要：', /📌/.test(h), '｜票型頁籤含 R1/R2/R3：', /R3/.test(byId.votePager.innerHTML), '｜大廳清單：', (await Net.lobby()).length, '間');
  process.exit(fails ? 1 : 0);

  function settle() { return new Promise(res => setImmediate(res)); }
  async function botStep() {
    const r = room();
    if (r.status === 'playing') { const b = U.byId(r, r.currentTurnPlayerId); await Net.act(x => { const log = Engine.log(x, b.id); if (log.step === 'a') GD.Strategy.inspectPicks(b, x).forEach(n => Engine.inspect(x, b.id, n)); const A = GD.Mind.analyze(b, x); Engine.skill(x, b.id, GD.Strategy.skill(b, x, A)); return Engine.pass(x, b.id, GD.Strategy.nextPlayer(b, x, A)); }); }
    else if (r.status === 'discussion') { const b = U.byId(r, r.currentSpeakerId); const { plan, A } = GD.Strategy.plan(b, r); await Net.act(x => Engine.speak(x, b.id, { text: GD.Speech.localSpeech(b, x, plan, A), source: 'bot' })); }
    else if (r.status === 'voting') await Net.act(x => { const rd = U.curRound(x); x.players.filter(p => p.isBot && rd.votes[p.id] === undefined).forEach(p => Engine.vote(x, p.id, GD.Strategy.ballot(p, x))); return true; });
    else if (r.status === 'person_voting') await Net.act(x => { x.players.filter(p => p.isBot && !x.personVotes[p.id]).forEach(p => { const d = GD.Strategy.personVote(p, x); p.final = d; Engine.personVote(x, p.id, d.targetId); }); return true; });
    else if (r.status === 'gameover') return;
    await settle();
  }
})().catch(e => { console.error('例外：', e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); });
