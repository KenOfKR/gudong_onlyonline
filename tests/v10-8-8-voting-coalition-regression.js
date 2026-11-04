'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Strategy, Mind, Speech } = GD;

function makeRoom(code) {
  const room = Engine.newRoom(code, 'human');
  Engine.addPlayer(room, { id: 'human', name: '真人甲' });
  Engine.fillBots(room);
  assert(Engine.start(room), 'engine start failed');
  return room;
}

try {
  // Public discussion always starts immediately after the actual last pass-order player.
  const room = makeRoom('V1088_PASS_TAIL_SPEECH_START');
  const rd = U.curRound(room);
  let guard = 0;
  while (room.status === 'playing' && guard++ < 12) {
    const pid = room.currentTurnPlayerId;
    const player = U.byId(room, pid);
    const log = Engine.log(room, pid);
    const quota = GD.Rules.inspectQuota(player);
    while (log.inspect.length < quota) {
      const pending = rd.beasts.find(b => !log.inspect.some(x => x.beastName === b.name));
      assert(pending, 'inspection quota must fit the current round');
      assert(Engine.inspect(room, pid, pending.name), 'inspection should be accepted');
    }
    assert(Engine.skill(room, pid, { kind: 'skip' }), 'all players may legally skip optional skill');
    const remaining = room.players.filter(p => !rd.passOrder.includes(p.id));
    const nextId = remaining.length ? remaining[0].id : undefined;
    assert(Engine.pass(room, pid, nextId), 'pass should be accepted');
  }
  assert.strictEqual(room.status, 'discussion', 'all eight passing actions should start public discussion');
  const seats = U.seated(room);
  const tailId = rd.passOrder[rd.passOrder.length - 1];
  const tailIndex = seats.findIndex(p => p.id === tailId);
  assert.strictEqual(rd.speechOrder[0], seats[(tailIndex + 1) % seats.length].id,
    'speech order must begin at the seat immediately after the pass-order tail');
  assert.strictEqual(room.currentSpeakerId, rd.speechOrder[0], 'engine speaker must match tail-derived order');

  // 局中推理只讀玩家可見畫面；客觀真相還原只允許結算後稽核。
  assert.strictEqual(Mind.inspectionTruth({ displayedReal: true, flipped: false }), true);
  assert.strictEqual(Mind.inspectionTruth({ displayedReal: false, flipped: false }), false);
  assert.strictEqual(Mind.inspectionTruth({ displayedReal: true, flipped: true }), true);
  assert.strictEqual(Mind.inspectionTruth({ displayedReal: false, flipped: true }), false);
  assert.strictEqual(Mind.auditTruth({ displayedReal: false, flipped: true }), true);
  assert.strictEqual(Mind.inspectionTruth({ displayedReal: '真', flipped: true }), null);

  // Deferred ambush suspects must come from after the target in the source-round pass chain,
  // not from the current round's pre-target players.
  const target = room.players[2];
  const oldPass = room.players.map(p => p.id);
  const currentPass = [room.players[0].id, room.players[1].id, target.id];
  room.rounds[0].passOrder = oldPass;
  room.currentRoundIdx = 1;
  const windows = Mind.blindCandidateWindows(room, target.id,
    { blindTiming: 'deferred', blindSourceRound: 1 }, currentPass, 2);
  assert.strictEqual(windows.length, 1);
  assert.deepStrictEqual(windows[0].ids, oldPass.slice(3));
  assert(!windows[0].ids.includes(room.players[0].id), 'deferred window must not wrongly include previous-round pre-target players');

  // Move the fixture to a later round before attaching an isolated public-speech record.
  room.rounds.push(Engine.drawRound(room, 2));
  room.currentRoundIdx = 1;

  // A good player may consider a role bluff only when a credible good ally is explicitly under public pressure.
  const current = U.curRound(room);
  const bot = room.players.find(p => p.isBot);
  const speaker = room.players.find(p => p.id !== bot.id);
  const ally = room.players.find(p => p.id !== bot.id && p.id !== speaker.id);
  const A = { prof: {} };
  A.prof[ally.id] = { ally: 32, evil: 7, knownEvil: false };
  current.speeches = [{ playerId: speaker.id, text: `我建議大家一起集火【${ally.name}】。`, p: {} }];
  const pressured = Strategy.findCrediblePressuredAlly(room, current, bot, A);
  assert(pressured && pressured.playerId === ally.id, 'credible publicly pressured ally should be detected');
  A.prof[ally.id].knownEvil = true;
  assert.strictEqual(Strategy.findCrediblePressuredAlly(room, current, bot, A), null,
    'confirmed evil players must never qualify as protected good allies');
  A.prof[ally.id] = { ally: 10, evil: 2, knownEvil: false };
  assert.strictEqual(Strategy.findCrediblePressuredAlly(room, current, bot, A), null,
    'weak ally posterior must not authorize an unmotivated good-role bluff');
  current.speeches = [];
  A.prof[ally.id] = { ally: 32, evil: 7, knownEvil: false };
  assert.strictEqual(Strategy.findCrediblePressuredAlly(room, current, bot, A), null,
    'no public pressure means no protective bluff trigger');

  // The output guard rejects filler acknowledgements but permits substantive responses.
  assert.strictEqual(Speech.isFillerAcknowledgement('我聽到了。'), true);
  assert.strictEqual(Speech.isFillerAcknowledgement('我收到。'), true);
  assert.strictEqual(Speech.isFillerAcknowledgement('你的票型和上一輪矛盾，請解釋傳牌時序。'), false);
  const fillerValidation = Speech.validate('我聽到了。', bot, room, {}, {});
  assert.strictEqual(fillerValidation.ok, false, 'speech validator must reject filler acknowledgement before publication');
  assert(/空泛承接語/.test(fillerValidation.why), 'filler rejection should explain the required rewrite');
  assert.strictEqual(Speech.isFillerAcknowledgement('這件獸首我判為贗品，因為查驗結果與前手說法相反。'), false);

  // These are bot policy changes only; game rule constants and legal abstention remain intact.
  assert(GD.CONFIG.CHIPS_PER_ROUND > 0, 'chip grant rule must remain defined');
  assert(Engine.availableChips(room, bot.id) >= 0, 'available chips must be non-negative');
  console.log('v10.8.9 voting/coalition regression passed: pass-tail order, observation firewall, deferred ambush window, motivated good-role bluff, filler guard.');
  process.exit(0);
} catch (error) {
  console.error('v10.8.9 voting/coalition regression failed:', error && error.stack || error);
  process.exit(1);
}
