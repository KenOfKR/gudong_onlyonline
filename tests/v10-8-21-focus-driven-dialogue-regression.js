'use strict';
const assert = require('assert');
const GD = require('./harness')();
const { Strategy, Speech, U } = GD;

const players = [
  { id: 'bot', name: '紫色順欸', colorId: 'purple', role: '姬雲浮', botId: 'bot', isBot: true },
  { id: 'human', name: '薏涵', colorId: 'blue', role: '平民', isBot: false }
];
const rd = {
  roundNum: 3,
  beasts: [{ name: '狗' }, { name: '鼠' }, { name: '羊' }],
  passOrder: ['bot', 'human'],
  speechOrder: ['human', 'bot'],
  speeches: [{ playerId: 'human', speakerName: '藍色薏涵', text: '我是老朝奉，你們不要懷疑我。' }],
  votes: {}, turnLogs: {}, mind: {}
};
const room = { roomId: 'FOCUS_DIALOGUE_TEST', currentRoundIdx: 2, players, rounds: [{}, {}, rd] };
const bot = players[0];
const A = { ctx: { bot, room, rd, t: 2, isGood: true, genes: { assertiveness: 0.9, skepticism: 0.7, camouflage: 0.2, deception: 0.3 } } };

const focus = Strategy.deriveDialogueFocus(bot, room, {
  askId: 'human', askKind: 'role_swap', askEvidence: { ownRole: '藥不然', otherRole: '老朝奉' }
}, A);
assert.strictEqual(focus.type, 'role_swap', 'role swap challenge becomes the single dominant speech focus');
assert.strictEqual(focus.targetId, 'human');
assert.strictEqual(focus.targetTag, U.tag(players[1]));
assert.strictEqual(focus.style, 'direct', 'high assertiveness changes delivery posture without changing evidence');

const plan = {
  dialogueFocus: focus,
  askId: 'human',
  askKind: 'role_swap',
  beast: '狗',
  claims: [{ beast: '狗', real: true }],
  roleBluff: null,
  fakeFangClaim: null,
  confess: false
};
const prompt = Speech.buildPrompt(bot, room, plan, {
  ...A,
  ctx: { ...A.ctx, myPos: 0 },
  publicCandidateGroups: [],
  publicReportedFlipPools: [],
  uncertaintyReports: [],
  publicCountConstraints: []
});
assert(prompt.includes('本輪唯一戰術焦點：拆解角色互換'), 'Gemini prompt receives the selected tactical focus');
assert(prompt.includes('主要對象是藍色【薏涵】') && prompt.includes('直接、有主見'), 'Gemini prompt receives the focus target and gene-shaped style');

const selected = Speech.focusDrivenSelectParts([
  '我會比對支持與反對這個目標的公開線索，再決定是否跟票。',
  '請藍色【薏涵】說明：你自稱【老朝奉】，但技能和傳牌時點要怎麼對？',
  '我的查驗結果是【狗】真品。',
  '關於【羊】的共識來源有多份，還要逐一確認獨立性。',
  '我這輪把票投向【狗】，因為自己的查驗也支持這個方向。',
  '目前票數預估是【狗】約五票、【鼠】約兩票，但這只是預測。'
], plan, bot, room, A.ctx);
const text = selected.join('');
assert(text.includes('藍色【薏涵】') && /老朝奉|技能|傳牌/.test(text), 'the focus must preserve the role-swap question');
assert(text.includes('【狗】真品') && text.includes('投向【狗】'), 'the selected speech keeps the approved claim and actual vote');
assert(!text.includes('我會比對支持與反對') && !text.includes('票數預估'), 'abstract filler and unrelated forecast are removed');
assert(!text.includes('【羊】'), 'the dialogue does not append an unrelated secondary report');
assert(selected.length <= 5, 'ordinary focus-driven dialogue stays concise while preserving core contracts');

const quietFocus = Strategy.deriveDialogueFocus(bot, room, { beast: '狗', claims: [{ beast: '狗', real: true }] }, {
  ctx: { ...A.ctx, genes: { assertiveness: 0.2, skepticism: 0.8, camouflage: 0.9, deception: 0.8 } }
});
assert.strictEqual(quietFocus.type, 'role_probe', 'pending public role claims take precedence over generic reporting');
console.log('PASS v10.8.21 focus-driven dialogue: one tactical focus, gene-shaped voice, concise evidence-backed speech and vote contract');
process.exit(0);
