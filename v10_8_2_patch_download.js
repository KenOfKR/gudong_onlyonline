#!/usr/bin/env node
'use strict';

// v10.8.2 local-only surgical patch. No Git commit/push/deploy is performed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(process.argv[2] || '');
const EXPECTED = '10.8.1';
const TARGET = '10.8.2';
const join = lines => lines.join('\n');

function stop(message) { console.error('\n[停止] ' + message); process.exit(1); }
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'); }
function occurrences(source, needle) { return source.split(needle).length - 1; }
function patch(rel, oldText, newText, label) {
  const count = occurrences(changed[rel], oldText);
  if (count !== 1) throw new Error(label + '：預期錨點 1 次，實際 ' + count + ' 次；拒絕猜測修改。');
  changed[rel] = changed[rel].replace(oldText, newText);
}
function requireMarker(rel, marker) { if (!changed[rel].includes(marker)) throw new Error(rel + ' 缺少必要標記：' + marker); }
function checkSyntax(rel, source) { if (/\.m?js$/.test(rel)) new vm.Script(source, { filename: rel }); }

if (!process.argv[2]) stop('用法：node apply_v10_8_2_reasoning_patch.js "C:\\完整\\專案路徑"');
if (!fs.existsSync(path.join(root, 'js/config.js'))) stop('指定路徑不是專案根目錄（找不到 js/config.js）。');
const files = [
  'js/config.js','index.html','local-server.cjs','js/core/claims.js','js/bot/mind.js',
  'js/bot/strategy.js','js/bot/tactics.js','js/bot/speech.js','js/bot/review.js','js/ui/gameover.js',
  'tests/public-speech-attribution-smoke.js','tests/vote-policy-smoke.js',
  'tests/tactics-smoke.js','tests/conversation-continuity-smoke.js',
  'tests/v10-8-strategic-info-smoke.js','tests/v10-8-public-roleplay-smoke.js'
];
for (const rel of files) if (!fs.existsSync(path.join(root, rel))) stop('缺少必要檔案：' + rel);
const newTestPath = 'tests/player-reasoning-regression-smoke.js';
if (fs.existsSync(path.join(root, newTestPath))) stop(newTestPath + ' 已存在，拒絕覆蓋。');
const originals = Object.fromEntries(files.map(rel => [rel, read(rel)]));
const changed = { ...originals };

// --- claims.js -------------------------------------------------------------
patch('js/core/claims.js',
  '  /** roundArg 省略時以目前回合的四尊獸首為白名單；覆盤舊發言時請傳入該回合 */\n  function parse(rawText, room, roundArg) {',
  join([
    '  // 公開候選集合只代表「其中一人」的待驗假設，不把集合內每個人都視為壞人。',
    '  function parsePublicCandidateSets(rawText, room) {',
    '    const out = [];',
    '    String(rawText || "").split(/[。！？!?\\n]+/).forEach(sentence => {',
    '      sentence.split(/[，,；;]+/).forEach(clause => {',
    '        const clauseText = clause.trim();',
    '        if (/(?:前手|前一位|上一位|原話|引用|轉述|他剛才說|她剛才說)/.test(clauseText)) return;',
    '        const match = clause.match(/(?:之中|其中)(?:至少)?\\s*(?:有\\s*)?(?:(?:一|其中一)?(?:位|人|個)\\s*)?(?:可能)?(?:是)?\\s*(老朝奉陣營|老朝奉|壞人|邪方)/);',
    '        if (!match || /(?:不認為|不覺得|並非|不是|沒有人|不可能)/.test(clauseText.slice(0, match.index))) return;',
    '        const candidateSource = clause.slice(0, match.index);',
    '        const players = mentions(candidateSource, room);',
    '        if (players.length < 2 || players.length > 4) return;',
    '        const role = /老朝奉/.test(match[1]) ? "老朝奉" : "壞人";',
    '        const candidateIds = [...new Set(players.map(p => p.id).filter(Boolean))];',
    '        if (candidateIds.length < 2) return;',
    '        const key = role + "|" + candidateIds.slice().sort().join("|");',
    '        if (!out.some(item => item.key === key)) out.push({ role, relation: "one_of", candidateIds, key, text: clause.trim() });',
    '      });',
    '    });',
    '    return out;',
    '  }',
    '',
    '  // 從公開原話擷取歷史查驗回報；這不是私密查驗證明，必須再和已公開結果核對。',
    '  function parsePublicInspectionReports(rawText) {',
    '    const out = [];',
    '    const numeral = { "一": 1, "二": 2, "三": 3, "1": 1, "2": 2, "3": 3 };',
    '    const re = /(?:我|本人)?(?:第)?([一二三123])(?:回|輪)(?:曾經|曾|當時)?(?:查驗|驗)(?:了)?\\s*【?([鼠牛虎兔龍蛇馬羊猴雞狗豬])】?\\s*(?:是)?\\s*(真品|真|贗品|假貨|假)/;',
    '    String(rawText || "").split(/[。！？!?\\n]+/).forEach(sentence => {',
    '      const clauseText = sentence.trim();',
    '      // Keep comma-linked attribution attached:「前手原話……，我第一回驗……」must not become a current speaker report.',
    '      if (!clauseText || /(?:前手|前一位|上一位|對方|他|她|原話|引用|轉述|轉述內容)/.test(clauseText)) return;',
    '      const match = clauseText.match(re);',
    '      if (!match || /(?:沒有|並未|未曾|不曾|不是|不可能|未驗)/.test(clauseText.slice(0, match.index))) return;',
    '      const item = { round: numeral[match[1]], beast: match[2], claimedReal: /真/.test(match[3]), text: match[0] };',
    '      if (!out.some(x => x.round === item.round && x.beast === item.beast && x.claimedReal === item.claimedReal)) out.push(item);',
    '    });',
    '    return out;',
    '  }',
    '',
    '  /** roundArg 省略時以目前回合的四尊獸首為白名單；覆盤舊發言時請傳入該回合 */',
    '  function parse(rawText, room, roundArg) {'
  ]),
  '新增 claims 公開候選／歷史查驗解析器');
patch('js/core/claims.js',
  '                  blind: false, unsure: false, selfRole: null, selfDefense: false, playerStances: [],\n                  asked: [],',
  '                  blind: false, unsure: false, selfRole: null, selfDefense: false, playerStances: [],\n                  candidateSets: parsePublicCandidateSets(text, room), inspectionReports: parsePublicInspectionReports(text),\n                  asked: [],',
  'claims.parse 增加兩種公開推理欄位');

patch('js/core/claims.js',
  '      const tags = [...clause.matchAll(TAG_RE)].map(m => ({ beast: m[1] || m[2], s: m.index, e: m.index + m[0].length }));\n      tags.forEach((t, i) => {',
  '      const tags = [...clause.matchAll(TAG_RE)].map(m => ({ beast: m[1] || m[2], s: m.index, e: m.index + m[0].length }));\n      const publicResultReference = /(?:開出來|公開結果|公布結果|結果公布|開票後|開出後)/.test(clause);\n      const historicalBeastReference = /(?:第\\s*\\d+\\s*輪|第\\s*[一二三123]\\s*(?:回|輪)|上輪|上一輪|前輪|前一輪|過去|先前|最近一次|後來公開|開票前|當時|歷史紀錄)/.test(clause) && !/(?:本輪|這輪|這次|目前|現在|我這輪|我本輪)/.test(clause);\n      tags.forEach((t, i) => {',
  '區分歷史查驗與公開開票結果，不誤記為本輪獸首判斷');
patch('js/core/claims.js',
  'if (fake || real) {\n  out.claims.push({ beast: t.beast, real });\n}',
  'if ((fake || real) && !publicResultReference && !historicalBeastReference) {\n  out.claims.push({ beast: t.beast, real });\n}',
  '歷史查驗回報與公開揭曉不可污染本輪宣稱');
patch('js/core/claims.js',
  "const historicalClause = /(?:第\\s*\\d+\\s*輪|上輪|上一輪|前輪|前一輪|過去|先前|最近一次|後來公開|開票前|當時|歷史紀錄)/.test(clause) &&",
  "const historicalClause = /(?:第\\s*\\d+\\s*輪|第\\s*[一二三123]\\s*(?:回|輪)|上輪|上一輪|前輪|前一輪|過去|先前|最近一次|後來公開|開票前|當時|歷史紀錄)/.test(clause) &&",
  '更新第一回／第二回等中文數字歷史判斷');
patch('js/core/claims.js',
  '      playerStances: parsed.playerStances || [],\n      blind: !!structured.blind || !!parsed.blind,',
  '      playerStances: parsed.playerStances || [],\n      // 從公開文字重建，不沿用舊 metadata 中可能失真的推理摘要。\n      candidateSets: parsed.candidateSets || [],\n      inspectionReports: parsed.inspectionReports || [],\n      blind: !!structured.blind || !!parsed.blind,',
  'parseRecord 重建候選與查驗回報');
patch('js/core/claims.js',
  "    if (parsed.selfDefense) parts.push('自辯：自稱好人／要求不要投票');",
  join([
    "    if (parsed.selfDefense) parts.push('自辯：自稱好人／要求不要投票');",
    '    (parsed.candidateSets || []).forEach(group => {',
    '      const tags = group.candidateIds.map(id => GD.U.byId(room, id)).filter(Boolean).map(p => GD.U.tag(p));',
    '      if (tags.length) parts.push(group.role + "候選集合：" + tags.join("、") + "之中一人（待驗假設）");',
    '    });',
    '    (parsed.inspectionReports || []).forEach(report => {',
    '      parts.push("第" + report.round + "輪公開回報：驗【" + report.beast + "】為" + (report.claimedReal ? "真品" : "贗品") + "（待與公開結果核對）");',
    '    });'
  ]),
  '摘要顯示新增公開推理');
patch('js/core/claims.js',
  '  GD.Claims = { parse, parseRecord, summarize, mentions, EVIL_ROLES };',
  '  GD.Claims = { parse, parseRecord, summarize, mentions, parsePublicCandidateSets, parsePublicInspectionReports, EVIL_ROLES };',
  '匯出公開推理解析器');

// --- mind.js ---------------------------------------------------------------
patch('js/bot/mind.js',
  '    const laoPools = [];\n\n    for (let r = 0; r <= t; r++) {',
  join([
    '    const laoPools = [];',
    '    const publicCandidateGroups = [];',
    '    const publicReportedFlipPools = [];',
    '    const seenCandidateGroups = new Set();',
    '    const seenPublicFlipReports = new Set();',
    '',
    '    for (let r = 0; r <= t; r++) {'
  ]),
  'Mind 建立公開推理證據池');
patch('js/bot/mind.js',
  '    /* ★ 跨輪老朝奉候選池交集消去法 + 「場上只有 3 個壞人」總量重盤機制 */',
  join([
    '    // 僅使用公開發言和已公開的 rank1/rank2；不讀其他玩家的私密 turnLogs 或 mind。',
    '    for (let speechRoundIndex = 0; speechRoundIndex <= t; speechRoundIndex++) {',
    '      const speechRound = room.rounds[speechRoundIndex];',
    '      if (!speechRound) continue;',
    '      (speechRound.speeches || []).forEach(sp => {',
    '        if (!sp || !sp.playerId || sp.playerId === bot.id) return;',
    '        const pub = speechData(sp, room, speechRound);',
    '        (pub.candidateSets || []).forEach(group => {',
    '          const candidateIds = [...new Set((group.candidateIds || []).filter(id => U.byId(room, id)))];',
    '          if (candidateIds.length < 2) return;',
    '          const key = sp.playerId + "|" + (speechRoundIndex + 1) + "|" + group.role + "|" + candidateIds.slice().sort().join("|");',
    '          if (seenCandidateGroups.has(key)) return;',
    '          seenCandidateGroups.add(key);',
    '          publicCandidateGroups.push({ speakerId: sp.playerId, speakerName: sp.speakerName, speechRound: speechRoundIndex + 1,',
    '            role: group.role || "壞人", relation: "one_of", candidateIds, text: group.text || "" });',
    '          candidateIds.forEach(id => {',
    '            if (prof[id]) bump(prof[id], { roles: { "老朝奉": 0.28 },',
    '              why: "公開玩家提出單選候選集合；只作弱參考，不代表每名候選都可疑或已被驗明", say: null });',
    '          });',
    '        });',
    '        (pub.inspectionReports || []).forEach(report => {',
    '          const sourceRound = room.rounds[(Number(report.round) || 0) - 1];',
    '          if (!sourceRound || !sourceRound.voteResults || !Array.isArray(sourceRound.passOrder)) return;',
    '          const revealed = [sourceRound.voteResults.rank1, sourceRound.voteResults.rank2]',
    '            .find(result => result && result.name === report.beast && typeof result.isReal === "boolean");',
    '          if (!revealed || revealed.isReal === report.claimedReal) return;',
    '          const speakerPos = sourceRound.passOrder.indexOf(sp.playerId);',
    '          if (speakerPos <= 0) return;',
    '          const candidateIds = sourceRound.passOrder.slice(0, speakerPos).filter(id => id !== bot.id && prof[id]);',
    '          if (!candidateIds.length) return;',
    '          const key = sp.playerId + "|" + report.round + "|" + report.beast + "|" + report.claimedReal + "|" + revealed.isReal;',
    '          if (seenPublicFlipReports.has(key)) return;',
    '          seenPublicFlipReports.add(key);',
    '          publicReportedFlipPools.push({ speakerId: sp.playerId, speakerName: sp.speakerName, reportRound: report.round,',
    '            speechRound: speechRoundIndex + 1, beast: report.beast, claimedReal: report.claimedReal,',
    '            revealedReal: revealed.isReal, candidateIds, source: "public-reported-inspection-mismatch" });',
    '          candidateIds.forEach(id => {',
    '            const weight = 4.5 / Math.sqrt(candidateIds.length);',
    '            if (prof[id]) bump(prof[id], { evil: weight, roles: { "老朝奉": 0.42 / Math.sqrt(candidateIds.length) },',
    '              why: "公開玩家回報的歷史查驗與已公開結果相反；此人位於可能的前置反轉區間，仍需獨立證據", say: null });',
    '          });',
    '        });',
    '      });',
    '    }',
    '',
    '    /* ★ 跨輪老朝奉候選池交集消去法 + 「場上只有 3 個壞人」總量重盤機制 */'
  ]),
  'Mind 匯入公開候選集合及歷史查驗反轉假設');
patch('js/bot/mind.js',
  '    ctx.laoPools = laoPools;\n    ctx.laoIntersectIds = laoIntersectIds;',
  '    ctx.publicCandidateGroups = publicCandidateGroups;\n    ctx.publicReportedFlipPools = publicReportedFlipPools;\n    ctx.laoPools = laoPools;\n    ctx.laoIntersectIds = laoIntersectIds;',
  'Mind 保存公開推理證據');
patch('js/bot/mind.js',
  '      publicCall: findPublicCall(ctx, prof),\n      fakeVoters: list.filter',
  '      publicCall: findPublicCall(ctx, prof),\n      publicCandidateGroups: ctx.publicCandidateGroups || [],\n      publicReportedFlipPools: ctx.publicReportedFlipPools || [],\n      fakeVoters: list.filter',
  'Mind 輸出公開推理證據');

// --- strategy.js -----------------------------------------------------------
patch('js/bot/strategy.js',
  '  /* ---------------------------------------------------------------- 終局鑑人 */\n\n  S.personVote = function (bot, room) {',
  join([
    '  /* ---------------------------------------------------------------- 終局鑑人 */',
    '',
    '  function finalLaoCandidateScore(rec, A) {',
    '    const id = rec && rec.player && rec.player.id;',
    '    if (!id) return -Infinity;',
    '    const base = (rec.probs && rec.probs["老朝奉"] || 0) * 1.15 + Math.min(20, Math.max(0, rec.evil || 0) * 0.15) +',
    '      (rec.conflicts && rec.conflicts.length ? 12 : 0) + (rec.knownEvil ? 24 : 0) - Math.min(6, Math.max(0, rec.ally || 0) * 0.05);',
    '    // 私人時序交集權重最高；公開歷史回報與玩家候選集合僅作弱佐證。',
    '    const privateIntersection = (A.laoIntersectIds || []).includes(id) ? 35 : 0;',
    '    const publicFlipCount = (A.publicReportedFlipPools || []).filter(pool => (pool.candidateIds || []).includes(id)).length;',
    '    const publicFlipBonus = Math.min(12, publicFlipCount * 6);',
    '    const publicCandidateCount = (A.publicCandidateGroups || []).filter(group => group.role === "老朝奉" && (group.candidateIds || []).includes(id)).length;',
    '    const publicCandidateBonus = Math.min(6, publicCandidateCount * 3);',
    '    const bot = A && A.ctx && A.ctx.bot;',
    '    const fangConfirmed = bot && bot.role === \"方震\" && (A.ctx.room.rounds || []).some(round => {',
    '      const log = round && round.turnLogs && round.turnLogs[bot.id];',
    '      return log && log.fangTargetId === id && log.fangCamp === \"evil\";',
    '    });',
    '    return base + privateIntersection + publicFlipBonus + publicCandidateBonus + (fangConfirmed ? 1000 : 0);',
    '  }',
    '',
    '  S.personVote = function (bot, room) {'
  ]),
  '加入一致的終局候選評分');
patch('js/bot/strategy.js',
  '    const any = pickDecision(anyPool.length ? anyPool : room.players.filter(p => p.id !== bot.id)).id;\n    let id = null, why = \'\', followId = null;',
  join([
    '    const any = pickDecision(anyPool.length ? anyPool : room.players.filter(p => p.id !== bot.id)).id;',
    '    const finalLaoCandidates = Object.values(A.prof)',
    '      .filter(r => r && r.player && r.player.id !== bot.id && !r.confessed)',
    '      .map(rec => ({ rec, score: finalLaoCandidateScore(rec, A) }))',
    '      .sort((a, b) => b.score - a.score || String(a.rec.player.id).localeCompare(String(b.rec.player.id)));',
    '    let id = null, why = \'\', followId = null;'
  ]),
  '建立統一終局候選排序');
patch('js/bot/strategy.js',
  "          evilChecked.sort((a, b) => ((A.prof[b]?.probs['老朝奉'] || 0) + (A.prof[b]?.evil || 0)) - ((A.prof[a]?.probs['老朝奉'] || 0) + (A.prof[a]?.evil || 0)));",
  '          evilChecked.sort((a, b) => finalLaoCandidateScore(A.prof[b], A) - finalLaoCandidateScore(A.prof[a], A));',
  '方震確證對象亦使用統一終局評分');

patch('js/bot/strategy.js',
  join([
    '        const finalLaoCandidates = Object.values(A.prof).filter(r => r && r.player && r.player.id !== bot.id && !r.confessed)',
    '          .map(r => ({ rec: r, score: (r.probs && r.probs[\'老朝奉\'] || 0) + Math.min(18, Math.max(0, r.evil || 0) * 0.16) + (r.conflicts && r.conflicts.length ? 10 : 0) + (r.knownEvil ? 18 : 0) - Math.min(18, Math.max(0, r.ally || 0) * 0.14) }))',
    '          .sort((a, b) => b.score - a.score);',
    '        const bestLao = finalLaoCandidates[0] && finalLaoCandidates[0].rec;'
  ]),
  join([
    '        const bestLaoEntry = finalLaoCandidates[0] || null;',
    '        const bestLao = bestLaoEntry && bestLaoEntry.rec;'
  ]),
  '終局決策使用統一評分');
patch('js/bot/strategy.js',
  join([
    '        const hasLaoEvidence = bestLao && (bestLao.knownEvil || (bestLao.conflicts || []).length > 0 ||',
    '          ((bestLao.probs && bestLao.probs[\'老朝奉\'] || 0) >= 22 && (bestLao.evil || 0) >= 22));'
  ]),
  join([
    '        const hasReportedFlip = bestLao && (A.publicReportedFlipPools || []).some(pool => (pool.candidateIds || []).includes(bestLao.player.id));',
    '        const supportedPublicFlip = hasReportedFlip && (bestLao.probs && bestLao.probs[\'老朝奉\'] || 0) >= 15 && (bestLao.evil || 0) >= 12;',
    '        const hasLaoEvidence = bestLao && (bestLao.knownEvil || (bestLao.conflicts || []).length > 0 || supportedPublicFlip ||',
    '          ((bestLao.probs && bestLao.probs[\'老朝奉\'] || 0) >= 22 && (bestLao.evil || 0) >= 22));'
  ]),
  '公開歷史查驗回報可作弱佐證');

patch('js/bot/strategy.js',
  "        const scoreModel = GD.Tactics && typeof GD.Tactics.scoreProjection === 'function'\n          ? GD.Tactics.scoreProjection(room, bot, A.post, null)\n          : null;",
  '',
  '終局指認不再被保真分數門檻提前跳過');
patch('js/bot/strategy.js',
  "        const savedEstimate = scoreModel ? scoreModel.expectedSavedReal : null;\n        const scoreStillMatters = scoreModel && savedEstimate < (Number(GD.CONFIG && GD.CONFIG.WIN_SCORE) || 6);",
  '',
  '移除與嫌疑證據脫節的勝分門檻');
patch('js/bot/strategy.js',
  '        if (ctx.t === 2 && scoreStillMatters && hasLaoEvidence) {',
  '        if (ctx.t === 2 && hasLaoEvidence) {',
  '有足夠老朝奉證據時終局必須進入人物指認');
patch('js/bot/strategy.js',
  '          why = `終局算分：目前保真部分估約 ${savedEstimate.toFixed(1)} 分，距 ${GD.CONFIG.WIN_SCORE} 分門檻仍有差距；我按公開矛盾與老朝奉後驗優先指認${U.tag(bestLao.player)}，爭取好人過半命中老朝奉的 1 分`;',
  '          why = `終局指認：${U.tag(bestLao.player)}在共用嫌疑排序中最高，且有可回查的陣營、查驗矛盾或傳牌時序證據支持；我優先指認此人`;',
  '終局理由對應共用證據評分');
patch('js/bot/strategy.js',
  '    const top = Object.values(A.prof).sort((a, b) => b.evil - a.evil).slice(0, 3).map(r => ({ id: r.player.id, evil: Math.round(r.evil), probs: { \'老朝奉\': r.probs[\'老朝奉\'], \'藥不然\': r.probs[\'藥不然\'], \'許願\': r.probs[\'許願\'], \'方震\': r.probs[\'方震\'] }, reasons: r.reasons.slice(0, 3) }));',
  join([
    '    const top = (ctx.isGood ? finalLaoCandidates : Object.values(A.prof).sort((a, b) => b.evil - a.evil).map(rec => ({ rec, score: rec.evil })))',
    '      .slice(0, 3).map(entry => {',
    '        const r = entry.rec;',
    '        return { id: r.player.id, evil: Math.round(r.evil), score: Math.round(entry.score * 100) / 100,',
    '          evidence: { privateLaoIntersection: (A.laoIntersectIds || []).includes(r.player.id),',
    '            publicFlipReports: (A.publicReportedFlipPools || []).filter(pool => (pool.candidateIds || []).includes(r.player.id)).length,',
    '            publicCandidateGroups: (A.publicCandidateGroups || []).filter(group => (group.candidateIds || []).includes(r.player.id)).length },',
    '          probs: { \'老朝奉\': r.probs[\'老朝奉\'], \'藥不然\': r.probs[\'藥不然\'], \'許願\': r.probs[\'許願\'], \'方震\': r.probs[\'方震\'] },',
    '          reasons: r.reasons.slice(0, 4) };',
    '      });'
  ]),
  '終局顯示排名與實際選票共用分數');
patch('js/bot/review.js',
  '      return { tag: U.tag(p), role: p.role, evil: t.evil, probs: t.probs, reasons: t.reasons };',
  '      return { tag: U.tag(p), role: p.role, evil: t.evil, score: t.score, evidence: t.evidence, probs: t.probs, reasons: t.reasons };',
  '覆盤保留共用終局分數與證據來源');
patch('js/ui/gameover.js',
  "嫌疑 ${s.evil}｜老朝奉 ${s.probs['老朝奉'] ?? '-'}% / 藥不然 ${s.probs['藥不然'] ?? '-'}%",
  "嫌疑 ${s.evil}${Number.isFinite(Number(s.score)) ? '｜排序分 ' + Number(s.score).toFixed(1) : ''}｜老朝奉 ${s.probs['老朝奉'] ?? '-'}% / 藥不然 ${s.probs['藥不然'] ?? '-'}%${s.evidence ? '｜證據 ' + [s.evidence.privateLaoIntersection ? '私密時序交集' : '', s.evidence.publicFlipReports ? '公開反轉回報×' + s.evidence.publicFlipReports : '', s.evidence.publicCandidateGroups ? '公開候選×' + s.evidence.publicCandidateGroups : ''].filter(Boolean).join('、') : ''}",
  '終局嫌疑列表顯示實際決策分數與證據來源');

// --- tactics.js ------------------------------------------------------------
patch('js/bot/tactics.js',
  join([
    '    const futureChipValue = (idx === 0 ? 0.22 : idx === 1 ? 0.11 : 0) *',
    '      holdStyleFactor * confidenceFactor * urgencyFactor;',
    '    let best = null;'
  ]),
  join([
    '    const futureChipValue = (idx === 0 ? 0.22 : idx === 1 ? 0.11 : 0) *',
    '      holdStyleFactor * confidenceFactor * urgencyFactor;',
    '    // 對不同人格給出可觀測但不強迫的第一票偏好；真正獎勵仍只在候選票型有投入時套用。',
    '    const firstVotePreference = idx === 0',
    '      ? 0.18 + 0.18 * assertiveness + 0.08 * conformity + 0.06 * targetConfidence',
    '      : 0;',
    '    let best = null;'
  ]),
  '計算第一輪人格化參與偏好');

patch('js/bot/tactics.js',
  join([
    '      const commitmentBonus = spent > 1',
    '        ? (idx === 0 ? 0.10 : idx === 1 ? 0.07 : 0.035) * spendStyle',
    '        : 0;',
    '      utility += commitmentBonus;',
    '      // 效益相近時仍由個人保留成本與行動風格共同決定，不再讓全體套用同一留票門檻。'
  ]),
  join([
    '      const commitmentBonus = spent > 1',
    '        ? (idx === 0 ? 0.10 : idx === 1 ? 0.07 : 0.035) * spendStyle',
    '        : 0;',
    '      utility += commitmentBonus;',
    '      // 第一輪只對至少投入第一票給溫和偏好；零票候選仍然保留。',
    '      const firstVoteBonus = spent > 0 ? firstVotePreference : 0;',
    '      utility += firstVoteBonus;',
    '      // 效益相近時仍由個人保留成本與行動風格共同決定，不再讓全體套用同一留票門檻。'
  ]),
  '加入第一輪第一票參與偏好');
patch('js/bot/tactics.js',
  '      if (!best || utility > best.utility + 1e-8) best = { ballot, utility, expectedGoodPoints, pTop, forecastAfter: mean, spent, held, commitmentBonus };',
  '      if (!best || utility > best.utility + 1e-8) best = { ballot, utility, expectedGoodPoints, pTop, forecastAfter: mean, spent, held, commitmentBonus, firstVoteBonus };',
  '保存最佳票型第一票偏好');
patch('js/bot/tactics.js',
  '        commitmentBonus: round2(best.commitmentBonus || 0),\n        spendStyle: round2(spendStyle),',
  '        commitmentBonus: round2(best.commitmentBonus || 0),\n        firstVoteBonus: round2(best.firstVoteBonus || 0),\n        firstVotePreference: round2(firstVotePreference),\n        spendStyle: round2(spendStyle),',
  '回傳第一票偏好診斷');

// --- speech.js -------------------------------------------------------------
patch('js/bot/speech.js',
  join([
    '    const stances = (parsed.playerStances || []).map(item => {',
    '      const target = item && item.targetId ? U.byId(room, item.targetId) : null;',
    '      return target ? { ...item, targetTag: U.tag(target), campLabel: item.camp === \'evil\' ? \'壞人\' : \'好人\' } : null;',
    '    }).filter(Boolean);',
    '    const raw = String(speech.text || \'\').trim();'
  ]),
  join([
    '    const stances = (parsed.playerStances || []).map(item => {',
    '      const target = item && item.targetId ? U.byId(room, item.targetId) : null;',
    '      return target ? { ...item, targetTag: U.tag(target), campLabel: item.camp === \'evil\' ? \'壞人\' : \'好人\' } : null;',
    '    }).filter(Boolean);',
    '    const candidateSets = (parsed.candidateSets || []).map(group => ({',
    '      ...group, targetTags: (group.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p))',
    '    })).filter(group => group.targetTags.length >= 2);',
    '    const inspectionReports = (parsed.inspectionReports || []).filter(report => report && report.round && report.beast && typeof report.claimedReal === \'boolean\');',
    '    const raw = String(speech.text || \'\').trim();'
  ]),
  '公開回應解析候選集合與歷史查驗回報');
patch('js/bot/speech.js',
  join([
    '    const targetAddressed = targetTag && after.some(sp => {',
    '      const text = String(sp && sp.text || \'\');',
    '      return text.includes(tag) && text.includes(targetTag) && /(?:懷疑|疑點|指認|集火|質疑|指控|原話|剛才|回應)/.test(text);',
    '    });',
    '    const sameTopicChecks = [];'
  ]),
  join([
    '    const targetAddressed = targetTag && after.some(sp => {',
    '      const text = String(sp && sp.text || \'\');',
    '      return text.includes(tag) && text.includes(targetTag) && /(?:懷疑|疑點|指認|集火|質疑|指控|原話|剛才|回應)/.test(text);',
    '    });',
    '    const candidateSetsAddressed = candidateSets.length > 0 && candidateSets.every(group => after.some(sp => {',
    '      const text = String(sp && sp.text || \'\');',
    '      return text.includes(tag) && group.targetTags.every(targetTag => text.includes(targetTag)) && /(?:候選|其中一人|其中一位|之一|老朝奉|壞人)/.test(text);',
    '    }));',
    '    const inspectionReportsAddressed = inspectionReports.length > 0 && inspectionReports.every(report => after.some(sp => {',
    '      const text = String(sp && sp.text || \'\');',
    '      return text.includes(tag) && text.includes(B(report.beast)) && /(?:查驗|驗過|反轉|公開結果|開出來|真品|贗品|假貨)/.test(text);',
    '    }));',
    '    const sameTopicChecks = [];'
  ]),
  '追蹤候選集合及歷史查驗是否被回應');
patch('js/bot/speech.js',
  '    if (targetTag) sameTopicChecks.push(!!targetAddressed);\n    const hasRecognizedTopic = sameTopicChecks.length > 0;',
  '    if (targetTag) sameTopicChecks.push(!!targetAddressed);\n    if (candidateSets.length) sameTopicChecks.push(!!candidateSetsAddressed);\n    if (inspectionReports.length) sameTopicChecks.push(!!inspectionReportsAddressed);\n    const hasRecognizedTopic = sameTopicChecks.length > 0;',
  '將候選與查驗回報納入回應狀態');
patch('js/bot/speech.js',
  '      target: targetTag && !targetAddressed ? targetId : null,\n      raw: !hasRecognizedTopic && !genericAcknowledgement',
  '      target: targetTag && !targetAddressed ? targetId : null,\n      candidateSets: candidateSetsAddressed ? [] : candidateSets,\n      inspectionReports: inspectionReportsAddressed ? [] : inspectionReports,\n      raw: !hasRecognizedTopic && !genericAcknowledgement',
  '保存尚未回應的公開推理');
patch('js/bot/speech.js',
  join([
    '    if (unanswered.target) {',
    '      const pendingTarget = U.byId(room, unanswered.target);',
    '      topics.push(`前手把疑點指向${pendingTarget ? U.tag(pendingTarget) : targetTag}；正面核對這項指控的原始發言、票型與獨立依據。`);',
    '    }',
    '    if (!topics.length)'
  ]),
  join([
    '    if (unanswered.target) {',
    '      const pendingTarget = U.byId(room, unanswered.target);',
    '      topics.push(`前手把疑點指向${pendingTarget ? U.tag(pendingTarget) : targetTag}；正面核對這項指控的原始發言、票型與獨立依據。`);',
    '    }',
    '    if (unanswered.candidateSets && unanswered.candidateSets.length) {',
    '      unanswered.candidateSets.forEach(group => topics.push(`前手提出「${group.targetTags.join(\'、\')}之中一人是${group.role}」的候選集合；這只是其中一人的待驗假設，不可把所有候選都當成壞人，請用傳牌時序和獨立證據檢查。`));',
    '    }',
    '    if (unanswered.inspectionReports && unanswered.inspectionReports.length) {',
    '      unanswered.inspectionReports.forEach(report => topics.push(`前手回報第${report.round}輪自己驗【${report.beast}】為${report.claimedReal ? \'真品\' : \'贗品\'}；請對照該輪公開結果，若相反，依該輪傳牌順序列出可能反轉區間，並說明這是公開回報而非已核實私密事實。`));',
    '    }',
    '    if (!topics.length)'
  ]),
  'Gemini 提示納入候選與歷史查驗');
patch('js/bot/speech.js',
  '    if (!items.length) {',
  '    (u.candidateSets || []).forEach(group => items.push(group.targetTags.join(\'、\') + \'之中一人是\' + group.role + \'（待驗候選，不代表每人都可疑）\'));\n    (u.inspectionReports || []).forEach(report => items.push(\'第\' + report.round + \'輪自稱驗【\' + report.beast + \'】為\' + (report.claimedReal ? \'真品\' : \'贗品\') + \'，應與公開結果和傳牌順序核對\'));\n    if (!items.length) {',
  '壓縮版回應保留候選與查驗回報');
patch('js/bot/speech.js',
  join([
    '    if (u.target && thread.targetTag && (!hasTag || !s.includes(thread.targetTag) || !/(?:懷疑|疑點|指控|指認|集火|質疑|原話|好人|壞人|認為|支持|回應)/.test(s))) {',
    '      return fail(\'沒有回應前手尚未被處理的玩家指控或立場\');',
    '    }',
    '    const stanceFailure = checkStances();'
  ]),
  join([
    '    if (u.target && thread.targetTag && (!hasTag || !s.includes(thread.targetTag) || !/(?:懷疑|疑點|指控|指認|集火|質疑|原話|好人|壞人|認為|支持|回應)/.test(s))) {',
    '      return fail(\'沒有回應前手尚未被處理的玩家指控或立場\');',
    '    }',
    '    for (const group of (u.candidateSets || [])) {',
    '      if (!hasTag || !(group.targetTags || []).every(targetTag => s.includes(targetTag)) || !/(?:候選|其中一人|其中一位|之一|待驗|核對)/.test(s)) {',
    '        return fail(\'沒有把前手提出的複數嫌疑集合當作「其中一人」的待驗假設回應\');',
    '      }',
    '    }',
    '    for (const report of (u.inspectionReports || [])) {',
    '      if (!hasTag || !s.includes(B(report.beast)) || !/(?:查驗|驗過|反轉|公開結果|開出來|時序|傳牌)/.test(s)) {',
    '        return fail(\'沒有核對前手回報的歷史查驗與公開結果\');',
    '      }',
    '    }',
    '    const stanceFailure = checkStances();'
  ]),
  '回應驗證器檢查新增推理議題');
patch('js/bot/speech.js',
  '    const recognized = !!(u.correction || (u.claims || []).length || u.defense || u.call || u.role || u.target || (u.stances || []).length);',
  '    const recognized = !!(u.correction || (u.claims || []).length || u.defense || u.call || u.role || u.target || (u.stances || []).length || (u.candidateSets || []).length || (u.inspectionReports || []).length);',
  '新議題列入已辨識語意');
patch('js/bot/speech.js',
  join([
    '      if (humanStances.length) {',
    '        const firstStance = humanStances[0];',
    '        let stanceLine = `${humanLabel}也認為${firstStance.tag}是${firstStance.label}；這是他的判斷，我會再看實際行動。`;',
    '        if (humanStances.length > 1) {',
    '          const rest = humanStances.slice(1).map(st => `${st.tag}是${st.label}`).join(\'、\');',
    '          stanceLine += `另外你也提到${rest}，我會分開核對。`;',
    '        }',
    '        parts.push(stanceLine);',
    '      }',
    '      if (humanDefense && !mainClaim) {'
  ]),
  join([
    '      if (humanStances.length) {',
    '        const firstStance = humanStances[0];',
    '        let stanceLine = `${humanLabel}也認為${firstStance.tag}是${firstStance.label}；這是他的判斷，我會再看實際行動。`;',
    '        if (humanStances.length > 1) {',
    '          const rest = humanStances.slice(1).map(st => `${st.tag}是${st.label}`).join(\'、\');',
    '          stanceLine += `另外你也提到${rest}，我會分開核對。`;',
    '        }',
    '        parts.push(stanceLine);',
    '      }',
    '      (unresolved.candidateSets || []).forEach(group => {',
    '        const tags = (group.targetTags || []).join(\'、\');',
    '        if (tags) parts.push(`${humanLabel}提出${tags}之中一人是${group.role}的假設；我會把他們列為待驗候選，不會直接把所有候選都當成壞人，並依傳牌時序和獨立證據核對。`);',
    '      });',
    '      (unresolved.inspectionReports || []).forEach(report => {',
    '        const matchingPool = (A.publicReportedFlipPools || []).find(pool => pool.speakerId === lastPublicSpeaker.playerId && pool.speechRound === ctx.t + 1 && pool.reportRound === report.round && pool.beast === report.beast);',
    '        const earlierTags = matchingPool ? matchingPool.candidateIds.map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p)) : [];',
    '        const candidateNote = earlierTags.length ? "，檢查前置候選 " + earlierTags.join("、") : "";',
    '        parts.push(`${humanLabel}回報第${report.round}輪驗【${report.beast}】為${report.claimedReal ? \'真品\' : \'贗品\'}；我會對照公開結果與當輪傳牌順序${candidateNote}，確認可能的反轉區間。`);',
    '      });',
    '      if (humanDefense && !mainClaim) {'
  ]),
  '本地備援直接回應玩家的推理');

// Cross-round reasoning must survive the round boundary in Gemini and local fallback.
patch('js/bot/speech.js',
  join([
    '    const latestPublicPrompt = latestPublicThread(room, rd, bot).directive;',
    '    const hasPriorSpeech = Array.isArray(rd.speeches) && rd.speeches.some(sp => sp && sp.playerId !== bot.id);'
  ]),
  join([
    '    const latestPublicPrompt = latestPublicThread(room, rd, bot).directive;',
    '    const acknowledgedAcrossRounds = (speakerId, sourceRoundNumber, predicate) => {',
    '      const sourceIndex = Math.max(0, (Number(sourceRoundNumber) || 1) - 1);',
    '      const sourceRound = (room.rounds || [])[sourceIndex];',
    '      const sourceSpeeches = sourceRound && sourceRound.speeches || [];',
    '      const sourceSpeechIndex = sourceSpeeches.findIndex(sp => sp && sp.playerId === speakerId);',
    '      const sameRoundAfter = sourceSpeechIndex >= 0 ? sourceSpeeches.slice(sourceSpeechIndex + 1) : [];',
    '      const laterRounds = (room.rounds || []).slice(sourceIndex + 1).flatMap(historyRound => historyRound && historyRound.speeches || []);',
    "      return sameRoundAfter.concat(laterRounds).some(sp => sp && sp.playerId !== speakerId && predicate(String(sp.text || ''), sp));",
    '    };',
    '    const crossRoundPublicTopics = [];',
    '    (A.publicCandidateGroups || []).forEach(group => {',
    '      const speaker = U.byId(room, group.speakerId);',
    "      const speakerTag = speaker ? U.tag(speaker) : (group.speakerName || '前手玩家');",
    '      const tags = (group.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));',
    '      const alreadyAddressed = acknowledgedAcrossRounds(group.speakerId, group.speechRound, text =>',
    '        text.includes(speakerTag) && tags.every(tag => text.includes(tag)) && /(?:候選|其中一人|其中一位|之一|老朝奉|壞人)/.test(text)',
    '      );',
    '      if (!alreadyAddressed && tags.length >= 2) crossRoundPublicTopics.push(',
    "        `第${group.speechRound}輪${speakerTag}公開提出${tags.join('、')}之中一人是${group.role}；這是玩家提出的待驗假設，不代表每個候選都可疑。請核對傳牌順序、公開矛盾和獨立證據，可以同意也可以反駁。`",
    '      );',
    '    });',
    '    (A.publicReportedFlipPools || []).forEach(pool => {',
    '      const speaker = U.byId(room, pool.speakerId);',
    "      const speakerTag = speaker ? U.tag(speaker) : (pool.speakerName || '前手玩家');",
    '      const tags = (pool.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));',
    '      const alreadyAddressed = acknowledgedAcrossRounds(pool.speakerId, pool.speechRound, text =>',
    '        text.includes(speakerTag) && text.includes(B(pool.beast)) && /(?:反轉|公開結果|開出來|傳牌順序|前置候選)/.test(text)',
    '      );',
    '      if (!alreadyAddressed && tags.length) crossRoundPublicTopics.push(',
    "        `第${pool.reportRound}輪${speakerTag}公開回報自己驗【${pool.beast}】為${pool.claimedReal ? '真品' : '贗品'}，但公開結果為${pool.revealedReal ? '真品' : '贗品'}；依當輪傳牌順序，${tags.join('、')}是待驗的前置候選。這只代表公開說法與結果有落差，不是已證實私密查驗，也不能單憑此事定罪。`",
    '      );',
    '    });',
    "    const crossRoundPublicPrompt = crossRoundPublicTopics.length ? crossRoundPublicTopics.join('\\n') : '沒有尚未被回應的跨輪公開推理。';",
    '    const hasPriorSpeech = Array.isArray(rd.speeches) && rd.speeches.some(sp => sp && sp.playerId !== bot.id);'
  ]),
  '建立跨輪公開推理的 Gemini 提示');
patch('js/bot/speech.js',
  '      latestPublicPrompt,',
  '      latestPublicPrompt,\n      `[跨輪公開推理／待驗證，不是真實角色或私密查驗事實]\\n${crossRoundPublicPrompt}`,',
  '將跨輪公開推理放入 Gemini 脈絡');
patch('js/bot/speech.js',
  '    // 若前手玩家的主張與本輪目標不同，清楚說明已納入考慮、但為何暫不跟票。',
  join([
    '    // 跨輪公開推理不能只留在 Mind 摘要；本地備援也必須接住，並明確標成待驗假設。',
    '    const laterPublicSpeechMentions = (speakerId, sourceRoundNumber, predicate) => {',
    '      const sourceIndex = Math.max(0, (Number(sourceRoundNumber) || 1) - 1);',
    '      const sourceRound = (room.rounds || [])[sourceIndex];',
    '      const sourceSpeeches = sourceRound && sourceRound.speeches || [];',
    '      const sourceSpeechIndex = sourceSpeeches.findIndex(sp => sp && sp.playerId === speakerId);',
    '      const sameRoundAfter = sourceSpeechIndex >= 0 ? sourceSpeeches.slice(sourceSpeechIndex + 1) : [];',
    '      const laterRounds = (room.rounds || []).slice(sourceIndex + 1).flatMap(historyRound => historyRound && historyRound.speeches || []);',
    "      return sameRoundAfter.concat(laterRounds).some(sp => sp && sp.playerId !== speakerId && predicate(String(sp.text || ''), sp));",
    '    };',
    '    (A.publicCandidateGroups || []).filter(group => group.speechRound < ctx.t + 1).forEach(group => {',
    '      const speaker = U.byId(room, group.speakerId);',
    "      const speakerTag = speaker ? U.tag(speaker) : (group.speakerName || '前手玩家');",
    '      const tags = (group.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));',
    '      const addressed = laterPublicSpeechMentions(group.speakerId, group.speechRound, text =>',
    '        text.includes(speakerTag) && tags.every(tag => text.includes(tag)) && /(?:候選|其中一人|其中一位|之一|老朝奉|壞人)/.test(text)',
    '      );',
    '      if (!addressed && tags.length >= 2) parts.push(',
    "        `補回第${group.speechRound}輪的公開推理：${speakerTag}認為${tags.join('、')}之中一人可能是${group.role}；我會把他們列為待驗候選，而不是同時定罪，再核對傳牌時序與獨立證據。`",
    '      );',
    '    });',
    '    (A.publicReportedFlipPools || []).filter(pool => pool.speechRound < ctx.t + 1).forEach(pool => {',
    '      const speaker = U.byId(room, pool.speakerId);',
    "      const speakerTag = speaker ? U.tag(speaker) : (pool.speakerName || '前手玩家');",
    '      const tags = (pool.candidateIds || []).map(id => U.byId(room, id)).filter(Boolean).map(p => U.tag(p));',
    '      const addressed = laterPublicSpeechMentions(pool.speakerId, pool.speechRound, text =>',
    '        text.includes(speakerTag) && text.includes(B(pool.beast)) && /(?:反轉|公開結果|開出來|傳牌順序|前置候選)/.test(text)',
    '      );',
    '      if (!addressed && tags.length) parts.push(',
    "        `${speakerTag}回報第${pool.reportRound}輪驗【${pool.beast}】為${pool.claimedReal ? '真品' : '贗品'}，公開結果卻相反；我會依當輪傳牌順序檢查${tags.join('、')}，但這仍是公開回報所形成的待驗假設。`",
    '      );',
    '    });',
    '    // 若前手玩家的主張與本輪目標不同，清楚說明已納入考慮、但為何暫不跟票。'
  ]),
  '本地備援跨輪回應玩家推理');

// --- versions and smoke tests ---------------------------------------------
patch('js/config.js', "VERSION: '10.8.1',", "VERSION: '10.8.2',", '更新應用程式版本');
changed['index.html'] = changed['index.html'].replace(/v10\.6\.2/g, 'v10.8.2');
changed['local-server.cjs'] = changed['local-server.cjs'].replace(/古董局中局 v10\.6\.0 本機伺服器已啟動/g, '古董局中局 v10.8.2 本機伺服器已啟動');
for (const rel of ['tests/tactics-smoke.js','tests/conversation-continuity-smoke.js','tests/v10-8-strategic-info-smoke.js']) {
  changed[rel] = changed[rel].replace(/'10\.8\.1'/g, "'10.8.2'");
}
changed['tests/v10-8-public-roleplay-smoke.js'] = changed['tests/v10-8-public-roleplay-smoke.js'].replace(/v10\.8\.1/g, 'v10.8.2');
changed['tests/conversation-continuity-smoke.js'] = changed['tests/conversation-continuity-smoke.js'].replace(/v10\.8\.0/g, 'v10.8.2');
changed['tests/v10-8-strategic-info-smoke.js'] = changed['tests/v10-8-strategic-info-smoke.js'].replace(/v10\.8\.0/g, 'v10.8.2');

patch('tests/public-speech-attribution-smoke.js',
  "  console.log('公開發言解析測試通過：分號引用歸屬、舊 p 欄位修復、第一人稱反轉、前手回顧與剛才表示皆正確。');",
  join([
    "  const reasoningText = '【張懿】與【佩萱】之中有老朝奉，我第一回驗【蛇】真，開出來【蛇】贗品，信我！';",
    '  const reasoningRoom = { currentRoundIdx: 0, players: [{ id: \'z\', name: \'張懿\' }, { id: \'p\', name: \'佩萱\' }],',
    "    rounds: [{ beasts: ['鼠', '牛', '虎', '蛇'].map(name => ({ name })) }] };",
    '  const reasoning = Claims.parse(reasoningText, reasoningRoom, reasoningRoom.rounds[0]);',
    "  assert.strictEqual(reasoning.candidateSets.length, 1, 'must preserve a multi-person one-of candidate group');",
    "  assert.deepStrictEqual(reasoning.candidateSets[0].candidateIds, ['z', 'p'], 'candidate group must preserve both named players');",
    "  assert.strictEqual(reasoning.inspectionReports.length, 1, 'must preserve the historic inspection report');",
    "  assert.strictEqual(reasoning.inspectionReports[0].round, 1, 'historic report must preserve its round');",
    "  assert.strictEqual(reasoning.inspectionReports[0].beast, '蛇', 'historic report must preserve its beast');",
    "  assert.strictEqual(reasoning.inspectionReports[0].claimedReal, true, 'historic report must preserve the speaker claimed result');",
    "  assert.strictEqual(reasoning.claims.length, 0, 'historical report and public reveal must not create a current-round beast claim even when the beast name is in the active whitelist');",
    '  const rebuilt = Claims.parseRecord({ text: reasoningText, p: { candidateSets: [], inspectionReports: [] } }, reasoningRoom, reasoningRoom.rounds[0]);',
    "  assert.strictEqual(rebuilt.candidateSets.length, 1, 'parseRecord must rebuild candidate sets from public wording');",
    "  assert.strictEqual(rebuilt.inspectionReports.length, 1, 'parseRecord must rebuild inspection reports from public wording');",
    "  const quoted = Claims.parse('我聽到前手原話：張懿與佩萱之中有老朝奉，我第一回驗蛇真。', reasoningRoom, reasoningRoom.rounds[0]);",
    "  assert.strictEqual(quoted.candidateSets.length, 0, 'quoted candidate groups must not be attributed to the current speaker');",
    "  assert.strictEqual(quoted.inspectionReports.length, 0, 'quoted historical inspections must not be attributed to the current speaker');",
    "  const denied = Claims.parse('我不認為張懿與佩萱之中有老朝奉。', reasoningRoom, reasoningRoom.rounds[0]);",
    "  assert.strictEqual(denied.candidateSets.length, 0, 'negated candidate groups must not become accusations');",
    "  console.log('公開發言解析測試通過：原有歸屬／引用回歸，加上複數嫌疑集合、歷史查驗回報與否定歸屬保護。');"
  ]),
  '新增複數嫌疑與歷史查驗解析回歸');
patch('tests/vote-policy-smoke.js',
  "    assert(model && model.ballot && model.diagnostic, label + ' optimizer must return a ballot and diagnostics');",
  "    assert(model && model.ballot && model.diagnostic, label + ' optimizer must return a ballot and diagnostics');\n    assert(model.diagnostic.firstVoteBonus >= 0 && model.diagnostic.firstVotePreference >= 0, label + ' first-vote preference must be reported');",
  '檢查第一票偏好診斷');
patch('tests/vote-policy-smoke.js',
  "  assert(allocations.some(allocation => spent(allocation) === 0), 'the optimizer candidate set must include complete abstention');",
  "  assert(allocations.some(allocation => spent(allocation) === 0), 'the optimizer candidate set must include complete abstention');\n  assert(allocations.some(allocation => spent(allocation) === 1), 'the optimizer must retain a one-chip first-round participation option');",
  '保留單票候選並維持棄票');
patch('tests/vote-policy-smoke.js',
  "  assert.notStrictEqual(cautiousModel.diagnostic.futureChipValue, assertiveModel.diagnostic.futureChipValue,\n    'different personalities should have different future chip opportunity costs');",
  "  assert.notStrictEqual(cautiousModel.diagnostic.futureChipValue, assertiveModel.diagnostic.futureChipValue,\n    'different personalities should have different future chip opportunity costs');\n  assert(assertiveModel.diagnostic.firstVotePreference > cautiousModel.diagnostic.firstVotePreference,\n    'assertive personalities should receive a stronger but non-forcing first-vote preference');",
  '確認第一票偏好保有人格差異');

// New public evidence integration regression.
const newTest = 'tests/player-reasoning-regression-smoke.js';
const newTestContent = "'use strict';\nconst assert = require('assert');\nconst load = require('./harness');\nconst GD = load();\nconst { Engine, U, Claims, Mind, Strategy, Speech } = GD;\nassert.strictEqual(GD.CONFIG.VERSION, '10.8.2', 'application version must be bumped for the new reasoning patch');\n\nfunction makeReplayRoom() {\n  const room = Engine.newRoom('V1082_ACTUAL_MATCH_REPLAY', 'human');\n  Engine.addPlayer(room, { id: 'human', name: 'Yan' });\n  Engine.fillBots(room);\n  assert(Engine.start(room), 'engine start failed');\n\n  const roster = [\n    ['彥棋', '方震'], ['小黛', '鄭國渠'], ['H小姐', '老朝奉'], ['佩萱', '黃煙煙'],\n    ['張懿', '許願'], ['凡凡', '藥不然'], ['卓毅', '姬雲浮']\n  ];\n  const bots = room.players.filter(p => p.isBot);\n  assert.strictEqual(bots.length, 7, 'actual match fixture needs seven bots');\n  roster.forEach(([name, role], i) => { bots[i].name = name; bots[i].role = role; });\n  const byName = name => room.players.find(p => p.name === name);\n  const yan = byName('Yan');\n  yan.role = '木戶加奈';\n\n  const rd1 = U.curRound(room);\n  rd1.beasts = ['龍', '蛇', '馬', '羊'].map(name => ({ name }));\n  rd1.passOrder = ['張懿', 'H小姐', 'Yan', '彥棋', '小黛', '佩萱', '凡凡', '卓毅'].map(name => byName(name).id);\n  rd1.speechOrder = rd1.passOrder.slice();\n  rd1.turnLogs = {};\n  rd1.mind = {};\n  rd1.voteResults = {\n    rank1: { name: '龍', votes: 1, isReal: false, hidden: true },\n    rank2: { name: '蛇', votes: 1, isReal: false, hidden: false }\n  };\n  const hSpeech = '我在第二位掌眼後，【蛇】是真品，包漿與工藝都穩。';\n  rd1.speeches = [{ playerId: byName('H小姐').id, speakerName: 'H小姐', source: 'bot', text: hSpeech, p: Claims.parse(hSpeech, room, rd1) }];\n\n  const rd2 = Engine.drawRound(room, 2);\n  room.rounds.push(rd2);\n  room.currentRoundIdx = 1;\n  rd2.beasts = ['鼠', '虎', '兔', '豬'].map(name => ({ name }));\n  rd2.passOrder = ['卓毅', '張懿', '小黛', '彥棋', '凡凡', 'H小姐', '佩萱', 'Yan'].map(name => byName(name).id);\n  rd2.speechOrder = rd2.passOrder.slice();\n  rd2.turnLogs = {};\n  rd2.mind = {};\n  rd2.voteResults = {\n    rank1: { name: '虎', votes: 6, isReal: true, hidden: true },\n    rank2: { name: '豬', votes: 4, isReal: false, hidden: false }\n  };\n  const reportText = '【張懿】與【佩萱】之中有老朝奉，我第一回驗【蛇】真，開出來【蛇】假，信我！';\n  rd2.speeches = [{ playerId: yan.id, speakerName: 'Yan', source: 'human', text: reportText, p: Claims.parse(reportText, room, rd2) }];\n\n  const rd3 = Engine.drawRound(room, 3);\n  room.rounds.push(rd3);\n  room.currentRoundIdx = 2;\n  rd3.beasts = ['牛', '猴', '雞', '狗'].map(name => ({ name }));\n  rd3.passOrder = ['Yan', '卓毅', '張懿', '小黛', 'H小姐', '凡凡', '彥棋', '佩萱'].map(name => byName(name).id);\n  rd3.speechOrder = rd3.passOrder.slice();\n  rd3.turnLogs = {};\n  rd3.mind = {};\n  return { room, byName, rd1, rd2, rd3, reportText };\n}\n\ntry {\n  const { room, byName, rd1, rd2, rd3, reportText } = makeReplayRoom();\n  const observer = byName('卓毅');\n  const zhang = byName('張懿');\n  const huang = byName('H小姐');\n  const peixuan = byName('佩萱');\n  const yan = byName('Yan');\n\n  const parsed = Claims.parse(reportText, room, rd2);\n  assert.strictEqual(parsed.candidateSets.length, 1, 'must preserve the speaker’s one-of two-person Lao hypothesis');\n  assert.deepStrictEqual(parsed.candidateSets[0].candidateIds.slice().sort(), [zhang.id, peixuan.id].sort(), 'candidate group must preserve exactly the named players');\n  assert.deepStrictEqual(parsed.inspectionReports, [{ round: 1, beast: '蛇', claimedReal: true, text: '我第一回驗【蛇】真' }], 'must parse the public first-round inspection report');\n  assert.strictEqual(parsed.claims.length, 0, 'historic private inspection and the public revealed result must not be mistaken for current-round beast claims');\n  const rebuilt = Claims.parseRecord({ text: reportText, p: { candidateSets: [], inspectionReports: [] } }, room, rd2);\n  assert.strictEqual(rebuilt.candidateSets.length, 1, 'parseRecord must rebuild public candidate groups from source wording');\n  assert.strictEqual(rebuilt.inspectionReports.length, 1, 'parseRecord must rebuild public inspection reports from source wording');\n  const quoted = Claims.parse('我聽到前手原話：【張懿】與【佩萱】之中有老朝奉，我第一回驗蛇真。', room, rd2);\n  assert.strictEqual(quoted.candidateSets.length, 0, 'quoted candidate sets must not be attributed to the current speaker');\n  assert.strictEqual(quoted.inspectionReports.length, 0, 'quoted historic reports must not be attributed to the current speaker');\n  const negated = Claims.parse('我不認為【張懿】與【佩萱】之中有老朝奉；我沒有第一回驗【蛇】真。', room, rd2);\n  assert.strictEqual(negated.candidateSets.length, 0, 'negated candidate hypotheses must not become claims');\n  assert.strictEqual(negated.inspectionReports.length, 0, 'negated inspection reports must not become public evidence');\n\n  const A = Mind.analyze(observer, room);\n  const group = A.publicCandidateGroups.find(x => x.speakerId === yan.id && x.speechRound === 2);\n  assert(group, 'Mind must retain the exact public candidate group from round two');\n  assert.deepStrictEqual(group.candidateIds.slice().sort(), [zhang.id, peixuan.id].sort(), 'Mind must preserve the two-person hypothesis without treating both as guilty');\n  const flip = A.publicReportedFlipPools.find(x => x.speakerId === yan.id && x.reportRound === 1 && x.beast === '蛇');\n  assert(flip, 'Mind must cross-check the public historic report against the already opened result');\n  assert.deepStrictEqual(flip.candidateIds, [zhang.id, huang.id], 'the timing pool must be based only on the actual first-round pass order before Yan');\n  assert(!A.prof[zhang.id].knownEvil && !A.prof[peixuan.id].knownEvil, 'a public one-of hypothesis must not mark either candidate as confirmed evil');\n  const zhangView = Mind.analyze(zhang, room);\n  const selfIncludedGroup = zhangView.publicCandidateGroups.find(x => x.speakerId === yan.id && x.speechRound === 2);\n  assert(selfIncludedGroup && selfIncludedGroup.candidateIds.includes(zhang.id) && selfIncludedGroup.candidateIds.includes(peixuan.id), 'a bot named inside the hypothesis must retain itself in the public candidate set');\n\n  const planned = Strategy.plan(observer, room);\n  const prompt = Speech.buildPrompt(observer, room, planned.plan, planned.A);\n  assert(prompt.includes(U.tag(zhang)) && prompt.includes(U.tag(peixuan)), 'Gemini prompt must preserve both candidates from the player’s hypothesis');\n  assert(prompt.includes('之中一人是老朝奉'), 'Gemini prompt must state the candidate relationship as one-of, not two accusations');\n  assert(prompt.includes(U.tag(huang)) && prompt.includes('公開結果為贗品'), 'Gemini prompt must surface the H小姐 timing candidate and public result mismatch');\n  assert(prompt.includes('不是真實角色或私密查驗事實'), 'cross-round reasoning must be explicitly marked as public hypotheses, not hidden facts');\n\n  // Final-person vote and displayed shortlist must share one scoring function.\n  const allOthers = room.players.filter(p => p.id !== observer.id);\n  const mkProfile = (player, evil, laoProb, ally = 0) => ({\n    player, evil, ally, knownEvil: false, confessed: false, conflicts: [], reasons: ['公開證據回歸測試'],\n    probs: { '老朝奉': laoProb, '藥不然': 10, '許願': 10, '方震': 10 }\n  });\n  const prof = {};\n  allOthers.forEach(p => { prof[p.id] = mkProfile(p, 8, 8, 0); });\n  prof[huang.id] = mkProfile(huang, 45, 60, 0);\n  prof[byName('凡凡').id] = mkProfile(byName('凡凡'), 45, 60, 0);\n  const syntheticA = {\n    ctx: { bot: observer, room, t: 2, isGood: true, partner: null },\n    prof, post: [], laoIntersectIds: [], publicCandidateGroups: A.publicCandidateGroups,\n    publicReportedFlipPools: A.publicReportedFlipPools, publicCall: null\n  };\n  const oldAnalyze = Mind.analyze;\n  const oldProjection = GD.Tactics.scoreProjection;\n  try {\n    Mind.analyze = () => syntheticA;\n    GD.Tactics.scoreProjection = () => null;\n    const decision = Strategy.personVote(observer, room);\n    assert.strictEqual(decision.targetId, huang.id, 'final accusation must choose the strongest supported Lao candidate');\n    assert.strictEqual(decision.top[0].id, decision.targetId, 'displayed top suspect must match the actual final-person vote');\n    assert(Number.isFinite(decision.top[0].score), 'the common final score must be included for review');\n\n    const fang = byName('彥棋');\n    rd1.turnLogs[fang.id] = { fangTargetId: huang.id, fangCamp: 'evil' };\n    const fangA = { ...syntheticA, ctx: { ...syntheticA.ctx, bot: fang } };\n    Mind.analyze = () => fangA;\n    const fangDecision = Strategy.personVote(fang, room);\n    assert.strictEqual(fangDecision.targetId, huang.id, 'Fang’s verified evil scan must remain the top final accusation');\n    assert.strictEqual(fangDecision.top[0].id, fangDecision.targetId, 'Fang’s displayed ranking must use the same final score as his vote');\n  } finally {\n    Mind.analyze = oldAnalyze;\n    GD.Tactics.scoreProjection = oldProjection;\n  }\n\n  console.log('v10.8.2 玩家推理回歸通過：以實際對局姓名與傳牌順序驗證雙人候選、歷史查驗反轉、公開提示延續及終局排名／指認一致。');\n  process.exit(0);\n} catch (err) {\n  console.error('v10.8.2 玩家推理回歸失敗：', err.stack || err.message || err);\n  process.exit(1);\n}";

// Refuse duplicate install / wrong base before writing anything.
if (!originals['js/config.js'].includes("VERSION: '10.8.1'")) stop('目前版本必須是 v10.8.1；不是預期基底，沒有寫入。');
for (const rel of files) {
  if (/firstVoteBonus|publicReportedFlipPools/.test(originals[rel])) stop('偵測到疑似已安裝 v10.8.2：' + rel + '；拒絕重複套用。');
}

const allChanged = { ...changed, [newTest]: newTestContent };
for (const [rel, content] of Object.entries(allChanged)) checkSyntax(rel, content);
for (const [rel, markers] of Object.entries({
  'js/core/claims.js': ['candidateSets: parsePublicCandidateSets(text, room)', 'inspectionReports: parsePublicInspectionReports(text)', 'function parsePublicInspectionReports'],
  'js/bot/mind.js': ['publicReportedFlipPools', 'publicCandidateGroups'],
  'js/bot/strategy.js': ['finalLaoCandidateScore', 'publicReportedFlipPools'],
  'js/bot/tactics.js': ['firstVoteBonus'],
  'js/bot/speech.js': ['unanswered.candidateSets', 'unanswered.inspectionReports']
})) for (const marker of markers) if (!allChanged[rel].includes(marker)) throw new Error(rel + ' 缺少新接線標記：' + marker);

if (process.argv.includes('--dry-run')) {
  console.log('v10.8.2 修補預檢通過，將修改 ' + (files.length + 1) + ' 個檔案；未寫入任何內容。');
  console.log('變更模組：claims、mind、strategy、tactics、speech、review/gameover 診斷顯示、版本標籤及回歸測試。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backups = [];
for (const rel of files) {
  const backup = path.join(root, rel) + '.pre-v10.8.2-' + stamp + '.bak';
  if (fs.existsSync(backup)) stop('備份檔已存在，拒絕覆寫：' + backup);
  backups.push({ backup, content: originals[rel] });
}
try {
  for (const item of backups) fs.writeFileSync(item.backup, item.content, 'utf8');
  for (const [rel, content] of Object.entries(allChanged)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content.replace(/\n/g, '\r\n'), 'utf8');
  }
} catch (err) {
  for (const rel of files) { try { fs.writeFileSync(path.join(root, rel), originals[rel], 'utf8'); } catch (_) {} }
  try { fs.unlinkSync(path.join(root, newTest)); } catch (_) {}
  for (const item of backups) { try { fs.unlinkSync(item.backup); } catch (_) {} }
  stop('寫入失敗，已嘗試還原原始檔：' + (err.stack || err.message || err));
}

console.log('v10.8.2 本機修補已套用：' + Object.keys(allChanged).length + ' 個檔案（含新增回歸測試）。');
console.log('已建立 .pre-v10.8.2-<timestamp>.bak 備份；沒有執行 Git commit/push 或部署。');
console.log('修正範圍：複數嫌疑候選、公開歷史查驗反轉、AI 發言回應、終局評分一致、第一輪第一票溫和偏好。');
