'use strict';
const assert = require('assert');
const GD = require('./harness')();

try {
  const bot = { id: 'lao', name: '老朝奉測試', role: '老朝奉' };
  const room = {
    currentRoundIdx: 2,
    rounds: [0, 1].map((index) => ({
      roundNum: index + 1,
      voteResults: {
        rank1: { name: index === 0 ? '鼠' : '牛', isReal: true, hidden: true },
        rank2: { name: index === 0 ? '牛' : '虎', isReal: false, hidden: false }
      },
      mind: { lao: {
        post: [{ name: index === 0 ? '鼠' : '牛', p: 1 }],
        beliefProfile: { target: { pZheng: 0.20 } }
      } }
    }))
  };
  const desperation = GD.Strategy.evilStrategicState(room, bot);
  assert.strictEqual(desperation.laoDesperation, true, 'last-round Lao with >=2 estimated good points and no strong Zheng candidate should enter desperation mode');
  assert.strictEqual(desperation.posture, 'desperate');
  assert.strictEqual(desperation.maxOwnPZheng, 0.2);

  const hiddenZheng = JSON.parse(JSON.stringify(room));
  hiddenZheng.rounds.forEach(rd => { rd.mind.lao.beliefProfile.target.pZheng = 0.92; });
  const protectedState = GD.Strategy.evilStrategicState(hiddenZheng, bot);
  assert.strictEqual(protectedState.laoDesperation, false, 'high own pZheng must suppress the desperation trigger');

  const scoreRoom = GD.Engine.newRoom('V10814_SCORE', 'host');
  scoreRoom.players = [bot, { id: 'p1', role: '許願' }, { id: 'p2', role: '方震' }];
  scoreRoom.currentRoundIdx = 0;
  scoreRoom.rounds = [{ roundNum: 1, beasts: [{ name: '鼠' }, { name: '牛' }], votes: {}, voteResults: null }];
  const forecast = { pTopTwo: { 鼠: 0.75, 牛: 0.25 } };
  const projection = GD.Tactics.scoreProjection(scoreRoom, bot, [{ name: '鼠', pReal: 0.70 }, { name: '牛', pReal: 0.30 }], forecast, {});
  assert(projection && Number.isFinite(projection.estimatedWinProbability));
  assert(projection.estimatedWinProbability >= 0 && projection.estimatedWinProbability <= 1);
  assert.strictEqual(projection.probabilityCalibration.method, 'wide-logistic-small-sample');
  assert.strictEqual(projection.probabilityCalibration.isHeuristic, true);
  assert.strictEqual(projection.probabilityCalibration.requiresPairedSeedAndHumanCalibration, true);

  console.log('PASS v10.8.14 score/desperation regression: Lao last-round trigger, pZheng shield, and explicitly heuristic win-probability calibration.');
} catch (error) {
  console.error('FAIL v10.8.14 score/desperation regression:', error.stack || error);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
}
