'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine, U, Claims } = GD;

const room = Engine.newRoom('V10_8_19_ASK_CONTRACT', 'host');
Engine.addPlayer(room, { id: 'human', name: '真人甲' });
Engine.fillBots(room);
const speaker = room.players.find(player => player.isBot);
const target = room.players.find(player => player.id !== speaker.id && player.id !== 'human');
assert(speaker && target, 'fixture needs a speaker and a target');
const tag = U.tag(target);
const beast = '牛';
const questions = {
  fake_vote: [
    `請${tag}說明一下：回頭看票單，你過去投給後來公開判假的獸首共 3 票，最近一次是第 1 輪的【${beast}】。投票當下你根據什麼判斷？`,
    `請${tag}解釋這筆歷史票型：第 1 輪你投了【${beast}】，它後來公開判為贗品；當時有哪些依據？`,
    `請${tag}說明當時的判斷：你投給後來判假的獸首共 3 票，最近是第 1 輪的【${beast}】。`
  ],
  vote_dissonance: [
    `請${tag}說明一下，第 1 輪你公開喊【${beast}】，票單卻把 2 票放在【${beast}】；當時有分票安排，還是中途改變想法？`,
    `請${tag}解釋第 1 輪的發言和票單：你喊的目標是【${beast}】，實際比較多票落在【${beast}】。`,
    `請${tag}說明這個票向落差：你第 1 輪公開支持【${beast}】，但 2 票投了【${beast}】。`
  ],
  inspection_conflict: [
    `請${tag}說明一下：第 1 輪你公開談【${beast}】的真偽，和我查驗到的結果不一樣。`,
    `請${tag}解釋【${beast}】這段查驗紀錄：你當時公開說法跟我的查驗畫面對不上。`,
    `請${tag}說明你對第 1 輪【${beast}】的判斷；我這邊的結果和你的公開主張有落差。`
  ],
  speech_contradiction: [
    `請${tag}說明一下：你第 1 輪同一段發言裡，把【${beast}】先說成真、後面又說成假。`,
    `請${tag}確認並解釋一下：你對【${beast}】同時用了真品和贗品兩種說法。`
  ],
  claim_shift: [
    `請${tag}說明一下：你第 1 輪對【${beast}】的判斷，和第 2 輪的說法不一樣。`,
    `請${tag}解釋前後判斷的差別：你之前對【${beast}】的說法，和後來那次不一樣。`
  ],
  role_shift: [
    `請${tag}說明角色說法為什麼改變：第 1 輪你自稱【許願】，第 2 輪又說自己是【方震】。`,
    `請${tag}解釋角色說法的前後差異：你之前說自己是【許願】，後來又自稱【方震】。`
  ],
  role_hypothesis: [
    `請${tag}說明一下：你先前提過【藥不然】的身份猜測，這個方向也有其他人提過。`,
    `請${tag}解釋你先前提出的【藥不然】猜測：能不能說出一個可核對的技能紀錄？`
  ]
};

let count = 0;
for (const [kind, variants] of Object.entries(questions)) {
  for (const question of variants) {
    const parsed = Claims.parseRecord({ playerId: speaker.id, speakerName: speaker.name, text: question }, room, null);
    assert(parsed.asked.includes(target.id), `${kind}: question variant must be recorded against the intended player: ${question}`);
    count++;
  }
}
console.log(`v10.8.19 question contract regression: PASS (${count} variants across 7 categories)`);
process.exit(0);
