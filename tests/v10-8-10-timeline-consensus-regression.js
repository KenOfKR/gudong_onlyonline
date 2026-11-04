'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, Claims, Mind, Strategy, Speech } = GD;

function fixture() {
  const room = Engine.newRoom('V10810_TIMELINE_CONSENSUS', 'human');
  Engine.addPlayer(room, { id: 'human', name: '測試玩家' });
  Engine.fillBots(room);
  assert(Engine.start(room));
  const roster = [
    ['歪ㄟ恩', '藥不然'], ['柚子', '老朝奉'], ['源阿', '黃煙煙'], ['老吳', '木戶加奈'],
    ['Alli', '姬雲浮'], ['薏涵', '許願'], ['Peter倫', '鄭國渠'], ['丞峻', '方震']
  ];
  room.players.forEach((player, index) => {
    player.name = roster[index][0];
    player.role = roster[index][1];
  });
  const byName = name => room.players.find(player => player.name === name);
  const rd = room.rounds[0];
  rd.beasts = [
    { name: '羊', isReal: true }, { name: '馬', isReal: false },
    { name: '猴', isReal: true }, { name: '鼠', isReal: false }
  ];
  const pass = ['老吳', '柚子', '歪ㄟ恩', '源阿', '丞峻', '薏涵', 'Peter倫', 'Alli'];
  const speech = ['源阿', 'Peter倫', '柚子', '老吳', '丞峻', '薏涵', '歪ㄟ恩', 'Alli'];
  rd.passOrder = pass.map(name => byName(name).id);
  rd.speechOrder = speech.map(name => byName(name).id);
  rd.laoActive = false; // engine audit state must not be read by the live posterior
  rd.turnLogs = {};
  rd.mind = {};
  const statements = [
    ['源阿', '我親自查驗【猴】是真品。'],
    ['Peter倫', '【猴】是真品。'],
    ['柚子', '依照前面的發言，我推測【猴】是真品。'],
    ['老吳', '我同意【猴】是真品，大家都說猴真。']
  ];
  rd.speeches = statements.map(([name, text]) => ({
    playerId: byName(name).id, speakerName: name, source: 'bot', text,
    p: Claims.parse(text, room, rd)
  }));
  return { room, rd, byName };
}

try {
  const { room, rd, byName } = fixture();
  const bot = byName('Alli');
  const analysis = Mind.analyze(bot, room);

  assert.strictEqual(GD.CONFIG.VERSION, '10.8.10');
  assert.strictEqual(analysis.claimEvidence.current.length, 4,
    'every parsed public beast claim should have one provenance record');
  const monkey = analysis.consensusDecomposition.find(group => group.beast === '猴' && group.real === true);
  assert(monkey, 'same-beast/same-verdict statements should be grouped');
  assert.strictEqual(monkey.speakerCount, 4);
  assert.strictEqual(monkey.selfReportedDirect, 1,
    'a direct-check sentence is still only a self-reported public claim');
  assert.strictEqual(monkey.inference, 1, 'explicit inference should not be counted as direct inspection');
  assert.strictEqual(monkey.echo, 2, 'later repeated statements should be classified as echo when source is not independently stated');
  assert(analysis.consensusAlerts.some(group => group.beast === '猴'),
    'large consensus with non-direct sources should produce a decomposition alert');

  const source = analysis.claimEvidence.current.find(entry => entry.playerId === byName('源阿').id);
  assert.strictEqual(source.type, 'self-reported-direct');
  assert.strictEqual(source.passIndex, rd.passOrder.indexOf(source.playerId));
  assert.strictEqual(source.speechIndex, rd.speechOrder.indexOf(source.playerId));
  assert.notStrictEqual(source.passIndex, source.speechIndex,
    'pass and speech positions must be retained as separate indices');

  assert(Number.isFinite(analysis.laoTiming.noSkillProbability));
  assert(Number.isFinite(analysis.laoTiming.activationProbability));
  assert(Math.abs(analysis.laoTiming.noSkillProbability + analysis.laoTiming.activationProbability - 1) < 1e-9,
    'no-skill and activated hypotheses must cover the posterior mass');
  assert(analysis.laoTiming.current.candidates.every(candidate =>
    candidate.passIndex === rd.passOrder.indexOf(candidate.playerId)),
    'skill activation candidates must be indexed by passOrder');
  const sourceTiming = analysis.laoTiming.current.candidates.find(candidate => candidate.playerId === source.playerId);
  assert.strictEqual(sourceTiming.speechIndex, rd.speechOrder.indexOf(source.playerId));

  const oldPosterior = analysis.laoAt.slice();
  rd.laoActive = true; // hidden engine bit toggled; no live belief should change
  const afterAuditToggle = Mind.analyze(bot, room);
  assert.deepStrictEqual(afterAuditToggle.laoAt, oldPosterior,
    'live posterior must not read engine-only laoActive ground truth');
  rd.laoActive = false;

  const { plan, A } = Strategy.plan(bot, room);
  assert(plan.laoTimingAudit, 'good strategy must receive the Lao timing audit');
  assert.strictEqual(plan.laoTimingAudit.rule, 'skill timing uses passOrder; speechOrder is discussion order only');
  assert(Array.isArray(plan.consensusAudit) && plan.consensusAudit.some(group => group.beast === '猴'),
    'strategy must pass consensus decomposition to speech generation');
  const line = Speech.localSpeech(bot, room, plan, A);
  assert(/自稱查驗|獨立驗證/.test(line), 'public speech should explain why a chorus is not equal to independent verification');

  // Existing abstention / public-call-vs-ballot regression tests remain in the suite unchanged.
  console.log('PASS v10.8.10 timeline/consensus regression');
} catch (error) {
  console.error('FAIL v10.8.10 timeline/consensus regression:', error && error.stack || error);
  process.exitCode = 1;
} finally {
  // The harness can leave service handles open in Node; terminate after synchronous assertions.
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
