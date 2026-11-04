'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, Claims, Mind, Strategy, Speech } = GD;

function makeRoom() {
  const room = Engine.newRoom('HUMAN_ROLE_FLIP_REGRESSION', 'human');
  Engine.addPlayer(room, { id: 'human', name: '歪ㄟ恩' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  const roster = [
    ['歪ㄟ恩', '木戶加奈'], ['凱基柏宇', '老朝奉'], ['源阿', '藥不然'], ['洪吉', '許願'],
    ['老吳', '方震'], ['隻貓', '姬雲浮'], ['大鈞哥', '黃煙煙'], ['卓毅', '鄭國渠']
  ];
  room.players.forEach((p, i) => {
    [p.name, p.role] = roster[i];
    p.genes = { skepticism: 0.6, deception: 0.5, camouflage: 0.5, assertiveness: 0.5, conformity: 0.5 };
  });
  const rd = room.rounds[0];
  rd.beasts = ['鼠', '牛', '虎', '兔'].map(name => ({ name, isReal: name === '牛' }));
  rd.passOrder = room.players.map(p => p.id);
  rd.speechOrder = rd.passOrder.slice();
  rd.turnLogs = {};
  rd.mind = {};
  return { room, rd };
}

try {
  const { room, rd } = makeRoom();
  const byName = name => room.players.find(p => p.name === name);
  const human = byName('歪ㄟ恩');
  const xu = byName('洪吉');
  const lao = byName('凱基柏宇');
  const yao = byName('源阿');
  const observer = byName('老吳');

  // Actual round-two wording: role-name must not be confused with the named target.
  const r2Text = '【蛇】假代表藍色【凱基柏宇】是假的姬雲浮，【牛】真，大家一起投【牛】！';
  const r2 = Claims.parse(r2Text, room, rd);
  assert.deepStrictEqual(r2.claims, [{ beast: '牛', real: true }], 'keep the current beast claim');
  assert.strictEqual(r2.callBeast, '牛', 'keep the current public vote call');
  assert(r2.roleClaims.some(x => x.playerId === byName('凱基柏宇')?.id && x.role === '姬雲浮' && x.polarity === 'fake'),
    'parse a fake-姬雲浮 role accusation against 凱基柏宇');

  // Actual round-three wording: preserve the subject across a pronoun clause and role-first syntax.
  const r3Text = '我認為紫色【隻貓】不是老朝奉，他應該是鄭國渠，我驗不到，老朝奉可能是藍色【凱基柏宇】！';
  const r3 = Claims.parse(r3Text, room, rd);
  assert(r3.roleClaims.some(x => x.playerId === byName('隻貓')?.id && x.role === '老朝奉' && x.polarity === 'deny'),
    '否認老朝奉只排除該角色，不可推成好人');
  assert(r3.roleClaims.some(x => x.playerId === byName('隻貓')?.id && x.role === '鄭國渠' && x.polarity === 'claim'),
    'pronoun「他」must inherit the immediately preceding player subject');
  assert(r3.roleClaims.some(x => x.playerId === byName('凱基柏宇')?.id && x.role === '老朝奉' && x.polarity === 'claim'),
    'role-first「老朝奉可能是某玩家」must bind to the following player');
  assert.strictEqual(r3.unsure, true, 'preserve the human statement that the inspection was unreadable');

  // A player whose display name is itself a role must still be parsed as the subject.
  const collisionRoom = { players: [
    { id: 'jy-name', name: '姬雲浮' }, { id: 'xu-name', name: '許願' }, { id: 'target', name: '凱基柏宇' }
  ], rounds: [rd], currentRoundIdx: 0 };
  const collision = Claims.parse('我認為姬雲浮就是老朝奉。', collisionRoom, rd);
  assert(collision.roleClaims.some(x => x.playerId === 'jy-name' && x.role === '老朝奉' && x.polarity === 'claim'),
    'player-name / role-name collision must not select the first role token as the accused role');
  const roleDenial = Claims.parse('許願根本不是方震。', collisionRoom, rd);
  assert(roleDenial.roleClaims.some(x => x.playerId === 'xu-name' && x.role === '方震' && x.polarity === 'deny'),
    'a role-name player must not be confused with a role predicate');

  // Post-game public cross-check: only a displayed result contradicted by the opened rank2
  // may create a verified timing window. Hidden engine flipped flags are never gameplay evidence.
  rd.passOrder = [lao.id, yao.id, xu.id, human.id, observer.id,
    ...room.players.filter(p => ![lao.id, yao.id, xu.id, human.id, observer.id].includes(p.id)).map(p => p.id)];
  rd.speechOrder = rd.passOrder.slice();
  rd.turnLogs[xu.id] = { inspect: [
    { beastName: '豬', displayedReal: false, flipped: true },
    { beastName: '蛇', displayedReal: true, flipped: true }
  ] };
  rd.voteResults = { rank1: { name: '鼠', isReal: false, hidden: true, votes: 4 }, rank2: { name: '豬', isReal: true, hidden: false, votes: 3 } };
  rd.speeches = [{ playerId: yao.id, speakerName: yao.name, source: 'bot',
    text: '我第一輪驗【豬】是假。', p: Claims.parse('我第一輪驗【豬】是假。', room, rd) }];
  const A = Mind.analyze(xu, room);
  assert.strictEqual(A.laoPools.filter(pool => pool.source === 'public-result-crosscheck').length, 1,
    'only the publicly revealed rank2 mismatch can create one verified timing pool');
  const pool = A.laoPools.find(item => item.source === 'public-result-crosscheck');
  assert.deepStrictEqual(pool.ids, [lao.id, yao.id], 'candidate pool must include exactly the players who acted before 許願');
  assert.deepStrictEqual(pool.beasts, ['豬'], 'the hidden rank1 beast must not be used to infer an unobservable flip');
  assert.deepStrictEqual(A.laoIntersectIds, [lao.id, yao.id], 'a same-round public contradiction must not shrink the verified timing window');
  const safeCtx = Mind.context(xu, room);
  assert(!Object.prototype.hasOwnProperty.call(safeCtx.myIns[0], 'flipped'), 'decision context must strip the engine-only flip marker');
  assert.strictEqual(Mind.inspectionTruth(safeCtx.myIns[0]), false, 'the observed screen must remain false');
  const flipVariant = JSON.parse(JSON.stringify(room));
  flipVariant.rounds[0].turnLogs[xu.id].inspect.forEach(item => { item.flipped = false; });
  const AWithoutAuditBits = Mind.analyze(xu, flipVariant);
  assert.deepStrictEqual(A.post, AWithoutAuditBits.post, 'posterior must not change when only the hidden audit flag changes');
  assert.deepStrictEqual(A.laoAt, AWithoutAuditBits.laoAt, 'Lao timing posterior must not read hidden flipped metadata');

  // A neutral later speaker must not hide the human's unresolved role accusation from the next bot.
  const humanSpeech = { playerId: human.id, speakerName: human.name, source: 'human', text: r3Text, p: r3 };
  const neutralSpeaker = byName('老吳');
  rd.speeches = [humanSpeech, {
    playerId: neutralSpeaker.id, speakerName: neutralSpeaker.name, source: 'bot',
    text: '我先聽其他人的意見，暫時沒有新的角色判斷。',
    p: Claims.parse('我先聽其他人的意見，暫時沒有新的角色判斷。', room, rd)
  }];
  const planResult = Strategy.plan(observer, room);
  const prompt = Speech.buildPrompt(observer, room, planResult.plan, planResult.A);
  assert(prompt.includes('前手提出角色判斷'), 'Gemini prompt must retain unresolved human role claims behind a later neutral speech');
  assert(prompt.includes('隻貓') && prompt.includes('鄭國渠') && prompt.includes('凱基柏宇') && prompt.includes('老朝奉'),
    'prompt must preserve each player-to-role mapping from the human statement');
  const localFallback = Speech.localSpeech(observer, room, planResult.plan, planResult.A);
  assert(localFallback.includes('隻貓') && localFallback.includes('鄭國渠') && localFallback.includes('凱基柏宇'),
    'local speech fallback must preserve the same human role-accusation context when Gemini is unavailable');

  // An evil player directly named as Lao must enter a counter-pressure state and explicitly answer.
  const counterPlanResult = Strategy.plan(lao, room);
  assert(counterPlanResult.plan.publicRolePressure && counterPlanResult.plan.publicRolePressure.role === '老朝奉',
    'strategy must detect a public role accusation directed at this evil player');
  assert.strictEqual(counterPlanResult.plan.counterAccuseId, human.id,
    'evil player must be able to challenge the accuser instead of silently following the beast topic');
  assert.strictEqual(counterPlanResult.plan.suspectId, human.id,
    'when no stronger target exists, the evil player must be able to counter-accuse the speaker');
  const counterPrompt = Speech.buildPrompt(lao, room, counterPlanResult.plan, counterPlanResult.A);
  assert(counterPrompt.includes('必須直接回應') && counterPrompt.includes('角色指控'),
    'Gemini prompt must explicitly request a role-defense / counterclaim response');
  const counterSpeech = Speech.localSpeech(lao, room, counterPlanResult.plan, counterPlanResult.A);
  assert(counterSpeech.includes('凱基柏宇') && counterSpeech.includes('老朝奉') && /依據|技能時點/.test(counterSpeech),
    'local fallback must directly refute or challenge the role accusation against the evil player');

  console.log('真人指控／角色歸屬／許願反轉時序回歸通過。');
  process.exit(0);
} catch (error) {
  console.error('真人指控／角色歸屬／許願反轉時序回歸失敗：', error && error.stack || error);
  process.exit(1);
}
