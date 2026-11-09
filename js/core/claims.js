/* ============================================================================
 * core/claims.js — 發言解析與「重點摘要」
 * 同一份解析結果同時用於：
 *   1) 真人語音講完後自動發布的重點摘要
 *   2) 電腦玩家讀取前手宣稱、真人號召
 *   3) 驗證 Gemini 產出是否與電腦自己的戰術計畫一致
 * ========================================================================== */
(function (GD) {
  'use strict';

  const BEAST = '鼠牛虎兔龍蛇馬羊猴雞狗豬';
  const TAG_RE = new RegExp(`【([${BEAST}])】|([${BEAST}])(?=真|假|贗)`, 'g');
  const FAKE_RE = /(不是真|並非真|不真|贗品|假貨|假的|是假|假)/;
  const REAL_RE = /(不是假|並非假|真品|真的|是真|保真|很穩|沒問題|真)/;
  const CALL_RE = /(投|集火|集中|號召|落票|落在|押|籌碼|跟我|跟著我)/;
  const SUSPECT_RE = /(集火|一起投|投他|投她|票投|票給|抓|指認|鑑人|懷疑|揪出|就是)/;
  // 只有明確的動員／指認語氣才算「號召集火」；提問、追問或分析某人不等於動員全場。
  const DIRECT_SUSPECT_CALL_RE = /(?:號召|呼籲|建議|請大家|大家|全場|一起|鑑人時)[^，。！？；]{0,16}(?:集火|指認|抓出|看緊|盯緊|揪出|投他|投她)|(?:集火|指認|抓出|看緊|盯緊|揪出)[^，。！？；]{0,10}(?:大家|全場|一起)/;
  const QUOTE_RE = /(說|報|宣稱|講|表示|聲稱|喊|認為|指出)[^，。！？]{0,2}$/;
  const EVIL_ROLES = ['老朝奉', '藥不然', '鄭國渠'];
  const ALL_ROLES = GD.ROLE_ORDER;

  /** 文字中提到哪些玩家：【名字】、色名+名字、單獨色名（例：藍色）。1 字名一律要求有【】 */
  function mentions(text, room) {
    const source = String(text || '');
    const players = room && Array.isArray(room.players) ? room.players : [];
    const found = [];
    const push = p => { if (p && !found.some(x => String(x.id) === String(p.id))) found.push(p); };
    const explicitlyNamed = [];
    players.forEach(p => {
      if (!p || !p.name) return;
      const bracket = `【${p.name}】`;
      if (source.includes(bracket) || (p.name.length >= 2 && source.includes(p.name))) {
        explicitlyNamed.push(p);
        push(p);
      }
    });
    // Color labels must be attached to the adjacent named player, not treated as
    // an independent mention of whichever seated player owns that color. Otherwise
    // 「黃色【皓鈞】紅色【Molly】」can accidentally accuse a third player whose seal is yellow.
    const colorTokens = [...source.matchAll(/黑色|紅色|橘色|黃色|綠色|藍色|紫色|白色|黑(?!色)|紅(?!色)|橘(?!色)|黃(?!色)|綠(?!色)|藍(?!色)|紫(?!色)|白(?!色)/g)];
    colorTokens.forEach(token => {
      const start = token.index;
      const end = start + token[0].length;
      const nearby = explicitlyNamed.some(p => {
        const bracket = `【${p.name}】`;
        const bracketAt = source.indexOf(bracket, Math.max(0, start - 1));
        const plainAt = p.name.length >= 2 ? source.indexOf(p.name, Math.max(0, start - 1)) : -1;
        const at = bracketAt >= 0 && bracketAt - end <= 8 ? bracketAt
          : plainAt >= 0 && plainAt - end <= 6 ? plainAt : -1;
        return at >= 0;
      });
      if (nearby) return;
      const color = (GD.SEAL_COLORS || []).find(item => item.name === token[0] || item.short === token[0]);
      if (!color) return;
      const match = players.find(p => p && p.colorId === color.id);
      if (match) push(match);
    });
    return found;
  }

  // Role words can also be player names. When a role word is used as the predicate
  // (e.g.「A不是方震」「B是假的姬雲浮」), do not count that occurrence as a second player.
  function mentionsInClause(text, room) {
    const all = mentions(text, room);
    return all.filter(p => {
      if (!p || !ALL_ROLES.includes(p.name) || text.includes(`【${p.name}】`)) return true;
      const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rolePredicate = new RegExp(`(?:是|為|就是|並非|不是|不可能是|應該是|可能是|可能為|疑似|看起來像|不像|像|假的|假冒|假扮|冒充)\\s*${escaped}(?=$|[，,。；;！？!?])`);
      const roleFirst = new RegExp(`^\\s*${escaped}\\s*(?:可能)?(?:是|為)`);
      const subjectRole = new RegExp(`^.{0,12}${escaped}(?:就是|是|為|根本不是|不是|並非|應該是|可能是)`);
      return !rolePredicate.test(text) && !roleFirst.test(text) || subjectRole.test(text);
    });
  }

  // Parse claims about another player's role separately from selfRole.
  // polarity: claim = claims the role; deny = excludes that role only; fake = says the role claim is false.
  function parseRoleClaims(clause, room, previousSubjectId = null) {
    const text = String(clause || '');
    const roles = (ALL_ROLES || []).slice().sort((a, b) => b.length - a.length);
    const refs = [];
    (room.players || []).forEach(player => {
      if (!player || !player.id || !player.name) return;
      let at = text.indexOf(`【${player.name}】`);
      if (at >= 0) { refs.push({ id: player.id, at, end: at + player.name.length + 2, explicit: true, explicitName: true }); return; }
      at = text.indexOf(player.name);
      if (at >= 0) {
        const tail = text.slice(at + player.name.length);
        const subjectUse = /^(?:就是|是|為|根本不是|不是|並非|不可能是|應該是|可能是|你才是)/.test(tail) ||
          /^.{0,8}(?:根本不是|不是|並非|不可能是|應該是|可能是)/.test(tail);
        if (!roles.includes(player.name) || subjectUse) refs.push({ id: player.id, at, end: at + player.name.length, explicit: false, explicitName: true });
      }
    });
    // 支援色碼作為玩家主詞：「橘老朝奉！」、「藍色很壞」。
    (GD.SEAL_COLORS || []).forEach(color => {
      const pattern = new RegExp(color.name + '|' + color.short, 'g');
      let match;
      while ((match = pattern.exec(text))) {
        const p = (room.players || []).find(player => player && player.colorId === color.id);
        if (!p || refs.some(ref => ref.id === p.id && Math.abs(ref.at - match.index) < 12)) continue;
        // An adjacent explicit name is stronger than a possibly mistyped color label.
        // Do not let the color token steal a role-first accusation from the named player.
        const adjacentNamedPlayer = refs.some(ref => ref.explicitName && ref.at >= match.index && ref.at - (match.index + match[0].length) <= 10);
        if (adjacentNamedPlayer) continue;
        refs.push({ id: p.id, at: match.index, end: match.index + match[0].length, explicit: false, explicitName: false });
      }
    });
    const out = [];
    roles.forEach(role => {
      let at = text.indexOf(role);
      while (at >= 0) {
        const before = text.slice(0, at);
        const after = text.slice(at + role.length);
        const beforeRefs = refs.filter(ref => ref.end <= at).sort((a, b) => b.end - a.end);
        const afterRefs = refs.filter(ref => ref.at >= at + role.length).sort((a, b) => Number(!!b.explicitName) - Number(!!a.explicitName) || a.at - b.at);
        let subject = beforeRefs[0] || null;
        let roleFirst = false;
        // 支援「老朝奉我認為是黃色【皓鈞】」這種角色在前、玩家在後的自然語序。
        // 舊版只接受「老朝奉可能是【某人】」，遇到「我認為是」就會漏掉整個角色判斷。
        const roleFirstLead = /^(?:(?:我|本人)?(?:認為|懷疑|猜測|覺得|推測|主張|判斷)\s*)?(?:可能|應該|大概|也許)?(?:是|為|就是)\s*/;
        if (!subject && roleFirstLead.test(after)) { subject = afterRefs[0] || null; roleFirst = true; }
        if (!subject && /^(?:他|她|這個人|該玩家)/.test(text.trim()) && previousSubjectId) {
          subject = { id: previousSubjectId };
        }
        if (subject) {
          const prefix = before.slice(-18);
          const polarity = /(?:不是|並非|並不是|不可能是|不屬於|不像)\s*$/.test(prefix) || /(?:不認為|不覺得|不相信|不認定|不指認)[^，。！？；;]{0,14}(?:是|為|像)\s*$/.test(prefix) ? 'deny'
            : /(?:假的|假冒|假扮|冒充)\s*$/.test(prefix) ? 'fake' : 'claim';
          const attachedRole = !!subject && /^\s*$/.test(text.slice(subject.end || subject.at || 0, at));
          const linked = roleFirst || attachedRole || /(?:是|為|就是|不是|並非|並不是|不可能是|不屬於|應該是|可能是|可能為|疑似|看起來像|不像|像|認為|懷疑|指控|判定為|認定為|假的|假冒|假扮|冒充)\s*$/.test(prefix);
          if (linked && !out.some(x => x.playerId === subject.id && x.role === role && x.polarity === polarity)) {
            out.push({ playerId: subject.id, role, polarity, text: text.trim() });
          }
        }
        at = text.indexOf(role, at + role.length);
      }
    });
    return out;
  }

  // 角色名稱相似／能力相同的疑問也屬於有效的公開話題，不能只因沒有玩家 ID 就丟掉。
  function parseRoleComparisons(rawText) {
    const out = [];
    String(rawText || '').split(/[。！？!?\n]+/).forEach(sentence => {
      const roles = (ALL_ROLES || []).slice().sort((a, b) => b.length - a.length)
        .filter(role => sentence.includes(role));
      const unique = [...new Set(roles)];
      if (unique.length < 2 || !/(?:跟|和|與|及|、).*(?:一樣|相同|同一|不同|不一樣|有差|區別|差別)|(?:一樣|相同|同一|不同|不一樣|有差|區別|差別).*(?:跟|和|與|及|、)/.test(sentence)) return;
      const item = {
        roles: unique,
        relation: 'comparison-question',
        text: sentence.trim()
      };
      const key = unique.slice().sort().join('|');
      if (!out.some(x => x.roles.slice().sort().join('|') === key)) out.push(item);
    });
    return out;
  }

  // 「上一輪投羊的很壞」不是單純情緒文字：若上一輪公開投票資料存在，
  // 應轉成可核對的玩家立場，並保留輪次、獸首及實際票數作為來源。
  function parseHistoricalVoteStances(rawText, room, round) {
    const out = [];
    const rounds = Array.isArray(room && room.rounds) ? room.rounds : [];
    let currentIndex = rounds.indexOf(round);
    if (currentIndex < 0) currentIndex = Number.isInteger(room && room.currentRoundIdx) ? room.currentRoundIdx : -1;
    const numeral = { '一': 1, '二': 2, '三': 3, '1': 1, '2': 2, '3': 3 };
    String(rawText || '').split(/[。！？!?\n]+/).forEach(sentence => {
      if (!/(?:壞人|很壞|邪方|老朝奉陣營)/.test(sentence) || !/(?:投|票給|落票)/.test(sentence)) return;
      const beastMatch = sentence.match(/(?:投(?:給)?|票給|落票(?:在|給)?)\s*【?([鼠牛虎兔龍蛇馬羊猴雞狗豬])】?/);
      if (!beastMatch) return;
      const explicitRound = sentence.match(/第\s*([一二三123])\s*(?:回|輪)/);
      let targetIndex = -1;
      if (explicitRound) targetIndex = numeral[explicitRound[1]] - 1;
      else if (/(?:上(?:一)?輪|前一輪|前輪|上一回)/.test(sentence)) targetIndex = currentIndex - 1;
      if (targetIndex < 0 || targetIndex >= rounds.length || targetIndex >= currentIndex) return;
      const voteRound = rounds[targetIndex];
      const votes = voteRound && voteRound.votes;
      if (!votes || typeof votes !== 'object') return;
      Object.entries(votes).forEach(([playerId, ballot]) => {
        const count = Math.max(0, Number(ballot && ballot[beastMatch[1]]) || 0);
        if (!count || !UPlayerExists(room, playerId)) return;
        out.push({
          targetId: playerId,
          camp: 'evil',
          evidence: { type: 'historical-vote', round: targetIndex + 1, beast: beastMatch[1], votes: count },
          text: sentence.trim()
        });
      });
    });
    return out;
  }

  function UPlayerExists(room, playerId) {
    return !!((room && room.players || []).some(player => player && String(player.id) === String(playerId)));
  }

  // 公開候選集合只代表「其中一人」的待驗假設，不把集合內每個人都視為壞人。
  function parsePublicCandidateSets(rawText, room) {
    const out = [];
    String(rawText || "").split(/[。！？!?\n]+/).forEach(sentence => {
      sentence.split(/[，,；;]+/).forEach(clause => {
        const clauseText = clause.trim();
        if (/(?:前手|前一位|上一位|原話|引用|轉述|他剛才說|她剛才說)/.test(clauseText)) return;
        const match = clause.match(/(?:之中|其中)(?:至少)?\s*(?:有\s*)?(?:(?:一|其中一)?(?:位|人|個)\s*)?(?:可能)?(?:是)?\s*(老朝奉陣營|老朝奉|壞人|邪方)/);
        if (!match || /(?:不認為|不覺得|並非|不是|沒有人|不可能)/.test(clauseText.slice(0, match.index))) return;
        const candidateSource = clause.slice(0, match.index);
        const players = mentions(candidateSource, room);
        if (players.length < 2 || players.length > 4) return;
        const role = /老朝奉/.test(match[1]) ? "老朝奉" : "壞人";
        const candidateIds = [...new Set(players.map(p => p.id).filter(Boolean))];
        if (candidateIds.length < 2) return;
        const key = role + "|" + candidateIds.slice().sort().join("|");
        if (!out.some(item => item.key === key)) out.push({ role, relation: "one_of", candidateIds, key, text: clause.trim() });
      });
    });
    return out;
  }

  // 從公開原話擷取歷史查驗回報；這不是私密查驗證明，必須再和已公開結果核對。
  function parsePublicInspectionReports(rawText, roundArg) {
    const out = [];
    const numeral = { "一": 1, "二": 2, "三": 3, "1": 1, "2": 2, "3": 3 };
    const historicalRe = /(?:我|本人)?(?:第)?([一二三123])(?:回|輪)(?:曾經|曾|當時)?(?:查驗|驗)(?:了)?\s*【?([鼠牛虎兔龍蛇馬羊猴雞狗豬])】?\s*(?:是)?\s*(真品|真|贗品|假貨|假)/;
    const currentRe = /^(?:(?:這輪|本輪|這次)\s*(?:我|本人)?|(?:我|本人)\s*(?:這輪|本輪|這次))\s*(?:查驗(?:了|到|出)?|驗過|驗了|驗到|驗出|查到|確認到(?:的)?(?:結果)?(?:是)?|看出)\s*【?([鼠牛虎兔龍蛇馬羊猴雞狗豬])】?\s*(?:的結果)?\s*(?:是)?\s*(真品|真|贗品|假貨|假)/;
    String(rawText || "").split(/[。！？!?\n]+/).forEach(sentence => {
      const clauseText = sentence.trim();
      // Keep comma-linked attribution attached:「前手原話……，我第一回驗……」must not become a current speaker report.
      if (!clauseText || /(?:前手|前一位|上一位|對方|他|她|原話|引用|轉述|轉述內容)/.test(clauseText)) return;
      let match = clauseText.match(historicalRe);
      let item;
      if (match) {
        if (/(?:沒有|並未|未曾|不曾|不是|不可能|未驗)/.test(clauseText.slice(0, match.index))) return;
        item = { round: numeral[match[1]], beast: match[2], claimedReal: /真/.test(match[3]), text: match[0] };
      } else {
        match = clauseText.match(currentRe);
        if (!match || /(?:沒有|並未|未曾|不曾|不是|不可能|未驗|不確定)/.test(clauseText.slice(0, match.index))) return;
        const currentRound = Number(roundArg && roundArg.roundNum);
        if (!Number.isInteger(currentRound) || currentRound < 1) return;
        item = { round: currentRound, beast: match[1], claimedReal: /真/.test(match[2]), text: match[0] };
      }
      if (!out.some(x => x.round === item.round && x.beast === item.beast && x.claimedReal === item.claimedReal)) out.push(item);
    });
    return out;
  }

  function parseCountConstraints(rawText, room) {
    const out = [];
    const source = String(rawText || '');
    // 「三電腦出 1–2 壞」中的三是電腦玩家群體數量，不是第 1、2 個座位。
    const re = /(?:三|3)\s*(?:個|名|位)?\s*(?:電腦|BOT|bot|AI)(?:玩家)?(?:之中|中|裡面)?[^，。！？；;]{0,18}?(?:(?:會)?出|有|裡面有|其中有|其中)\s*([一二兩三123])\s*(?:[-–—~～至到]|到)?\s*([一二兩三123])?\s*(?:個|名|位)?\s*(?:壞人|壞|邪方)/gi;
    const n = { '一':1, '二':2, '兩':2, '三':3, '1':1, '2':2, '3':3 };
    let m;
    while ((m = re.exec(source))) {
      const min = n[m[1]], max = m[2] ? n[m[2]] : min;
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      const bots = (room && room.players || []).filter(p => p && p.isBot);
      const exactlyThreeKnown = bots.length === 3;
      out.push({
        kind: 'count_constraint', scope: 'computer_players', populationSize: 3,
        populationIds: exactlyThreeKnown ? bots.map(p => p.id) : [],
        populationResolved: exactlyThreeKnown,
        populationLabel: '三名電腦玩家', min: Math.min(min, max), max: Math.max(min, max),
        camp: 'evil', weight: 'low', evidenceWeight: 0.12,
        text: m[0].trim()
      });
    }
    return out;
  }

  function parsePositionClaims(rawText, room, round, speakerId) {
    const out = [];
    const source = String(rawText || '');
    const patterns = [
      { kind: 'pass', re: /(?:我|本人)?\s*(?:在|是)?\s*第\s*([一二三四五六七八12345678])\s*(?:位)?\s*(?:傳牌|掌眼)/g },
      { kind: 'speech', re: /(?:我|本人)?\s*(?:在|是)?\s*第\s*([一二三四五六七八12345678])\s*(?:位)?\s*(?:公開)?發言/g }
    ];
    const n = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8 };
    patterns.forEach(({kind,re}) => {
      let m;
      while ((m = re.exec(source))) {
        const expected = n[m[1]];
        const order = kind === 'pass' ? (round && round.passOrder || []) : (round && round.speechOrder || []);
        const index = order.findIndex(id => String(id) === String(speakerId));
        const actual = index >= 0 ? index + 1 : null;
        out.push({ kind, claimed: expected, actual, verified: actual == null ? null : actual === expected,
          speakerId: speakerId || null, text: m[0].trim() });
      }
    });
    return out;
  }

  /** roundArg 省略時以目前回合的四尊獸首為白名單；覆盤舊發言時請傳入該回合 */
  function parse(rawText, room, roundArg, speakerId = null) {
    const text = String(rawText || '');
    const round = roundArg || (room.rounds && room.rounds[room.currentRoundIdx]);
    const valid = new Set(round ? round.beasts.map(b => b.name) : GD.ZODIAC);
    const out = { claims: [], callBeast: null, callBeasts: [], callSuspectId: null, accuse: [], campChecks: [],
                  blind: false, unsure: false, selfRole: null, selfDefense: false, playerStances: [], voteAvoids: [],
                  candidateSets: parsePublicCandidateSets(text, room), countConstraints: parseCountConstraints(text, room),
                  inspectionReports: parsePublicInspectionReports(text, round), roleClaims: [], skillClaims: [], selfContradictions: [],
                  uncertaintyReasons: [], positionClaims: parsePositionClaims(text, room, round, speakerId),
                  roleComparisons: parseRoleComparisons(text),
                  voteCommitments: [], voteCommitment: null, voteCommitmentBinding: false, voteIntents: [], voteIntentBeast: null, voteIntentStrength: 0,
                  // 將本人表態與被引用的他人主張分開保存；舊欄位仍維持相容。
                  speakerClaims: [], speakerCalls: [], speakerCommitments: [], quotedClaims: [], quotedCalls: [], reportedStatements: [],
                  asked: [],          // 被質問者（「請某某說明一下」），對方在本輪稍後發言時應該回應
                  selfEvil: false };  // 發言者公開認壞（不一定報出具體角色）

    // 先以句號分段，再處理逗號／分號。分號常把「前手說了什麼」拆成多段，
    // 若每段各自解析，後面的「前手號召投【鼠】」就會錯算成目前發言者自己的票向。
    text.split(/[。！？!?\n]+/).forEach(sentence => {
      let attributionOpen = false;
      let previousRoleSubjectId = null;
      let quotedReportOpen = false;
      let quotedReportBuffer = '';
      let quotedReportSourceIds = [];
      let historicalContextOpen = false;
      let previousReportedSourceIds = [];
      const speechHistory = round && Array.isArray(round.speeches) ? round.speeches : [];
      const speakerSpeechIndex = speechHistory.findIndex(sp => String(sp && sp.playerId) === String(speakerId));
      const priorSpeaker = speakerSpeechIndex >= 0
        ? [...speechHistory.slice(0, speakerSpeechIndex)].reverse().find(sp => sp && String(sp.playerId) !== String(speakerId))
        : [...speechHistory].reverse().find(sp => sp && String(sp.playerId) !== String(speakerId));
      const priorSpeakerIds = priorSpeaker && priorSpeaker.playerId ? [String(priorSpeaker.playerId)] : [];
      sentence.split(/[，、,；;]+/).forEach(clause => {
      if (!clause) return;
      const trimmedClause = clause.trim();
      if (/(?:有開過|開過技能|技能有開|確實發動過)/.test(trimmedClause)) {
        out.skillClaims.push({ kind: 'used', confidence: 'low', text: trimmedClause });
      }
      const currentTimeCue = /(?:本輪|這輪|這次|目前|現在|我這輪|我本輪)/.test(trimmedClause);
      if (currentTimeCue) historicalContextOpen = false;
      else if (/(?:第\s*[一二三123]\s*(?:回|輪)|上(?:一)?輪|前一輪|前輪|過去|先前|歷史紀錄|當時|曾經|投過)/.test(trimmedClause)) historicalContextOpen = true;
      const reportedLead = /^(?:前手|前一位|上一位|對方|該玩家|該人|原發言者|其主張|他(?:剛才|先前)?(?:說|主張|表示|號召|認為|宣稱|提到|指出|點名|指控|指認|提出|建議)|她(?:剛才|先前)?(?:說|主張|表示|號召|認為|宣稱|提到|指出|點名|指控|指認|提出|建議)|你(?:剛才|先前)?(?:說|主張|表示|號召|認為|宣稱|提到|指出|點名|指控|指認|懷疑|提出|建議))/.test(trimmedClause);
      const quotedReportLead = /^(?:我|本人)?\s*(?:聽到|聽說|引用|轉述|複述|重述|復述|照讀)[^，。！？；;]{0,24}(?:前手|前一位|上一位|對方|他人|原話|原文|說法|內容|說|表示|宣稱|主張)/.test(trimmedClause);
      // 「我認為／我懷疑某人」是發言者自己的判斷，不是「某玩家認為」的轉述。
      // 只有第三人稱玩家作為來源，且不是第一人稱主句時，才開啟歸屬保護。
      // 第一人稱分析句即使把角色放在句首（「老朝奉我認為是黃色【皓鈞】」），
      // 也不能誤判成「皓鈞曾經認為／宣稱」的轉述。只有明確引用他人發言時才開啟歸屬保護。
      const firstPersonAnalysis = /(?:我|本人)(?:認為|懷疑|猜測|覺得|推測|主張|判斷|認定)/.test(clause) &&
        !/(?:說|宣稱|表示|主張|指出|提到|原話|引用|轉述).{0,12}(?:我|本人)(?:認為|懷疑|猜測|覺得|推測|主張|判斷|認定)/.test(clause);
      const namedReportCue = !/^(?:但|不過|可是|然而|另外|此外)?\s*(?:我|本人)/.test(trimmedClause) &&
        !firstPersonAnalysis && mentions(clause, room).length > 0 &&
        /(?:原話|剛才(?:說|主張|表示|號召)|先前(?:說|主張|表示|號召)|曾(?:公開)?(?:說|主張|表示|號召)|說過|主張|表示|宣稱|指出|認為|提到|號召|希望大家投|建議大家投|呼籲大家投|叫大家投|叫大家跟投|要大家投)/.test(clause);
      const tagQuoteCue = [...clause.matchAll(TAG_RE)].some(match => {
        const before = clause.slice(0, match.index);
        return mentions(before, room).length > 0 &&
          (QUOTE_RE.test(before) || /(?:說|宣稱|表示|認為|主張|提到|指出|原話|引用|轉述|號召|希望大家投|建議大家投).{0,20}$/.test(before) ||
            (/[「『“"]\s*$/.test(before) && /[」』”"]/.test(clause.slice(match.index + match[0].length))));
      });
      const ownSpeakerLead = /^(?:但|不過|可是|然而|另外|此外)?\s*(?:我|本人|我的)/.test(trimmedClause) ||
        /^(?:但|不過|可是|然而)\s*(?:如果|若|結果|目前|先|這輪|本輪|這與我|這讓我)/.test(trimmedClause);
      const inheritedQuoteFragment = attributionOpen && !ownSpeakerLead &&
        new RegExp(`^【?[${BEAST}]】?\s*(?:是真品|贗品|假品|真貨|假貨|是真|是假|真|假)`).test(trimmedClause);
      // 一旦明確進入第三人稱引用，後續同一句的延續片語都沿用該歸屬；
      // 直到出現明確的說話者切換（第一人稱或轉折後的本人觀點）才解除。
      const inheritedReport = attributionOpen && !ownSpeakerLead;
      const collectReportedStatement = (reportedText, sourceIds, sourceType = 'attributed-report') => {
        const raw = String(reportedText || '').trim();
        if (!raw) return;
        const ids = [...new Set((sourceIds || []).filter(Boolean).map(String))];
        out.reportedStatements.push({ sourcePlayerIds: ids, sourceType, text: raw });
        const quotedPair = raw.match(/([鼠牛虎兔龍蛇馬羊猴雞狗豬]{2})\s*雙\s*(真|假|贗)/);
        if (quotedPair) [...quotedPair[1]].forEach(beast => {
          if (valid.has(beast) && !out.quotedClaims.some(item => item.beast === beast && item.real === (quotedPair[2] === '真') && JSON.stringify(item.sourcePlayerIds) === JSON.stringify(ids))) {
            out.quotedClaims.push({ beast, real: quotedPair[2] === '真', sourcePlayerIds: ids, sourceType, text: raw });
          }
        });
        const reportedTags = [...raw.matchAll(TAG_RE)].map(match => ({ beast: match[1] || match[2], start: match.index, end: match.index + match[0].length }));
        reportedTags.forEach((tag, index) => {
          if (!valid.has(tag.beast)) return;
          const prefix = raw.slice(Math.max(0, tag.start - 14), tag.start);
          const suffix = raw.slice(tag.end, index + 1 < reportedTags.length ? reportedTags[index + 1].start : tag.end + 18);
          const scope = `${prefix}${suffix}`.replace(/不是假|並非假/g, '');
          const fake = FAKE_RE.test(scope);
          const real = !fake && REAL_RE.test(scope);
          if ((fake || real) && !out.quotedClaims.some(item => item.beast === tag.beast && item.real === real && JSON.stringify(item.sourcePlayerIds) === JSON.stringify(ids))) out.quotedClaims.push({ beast: tag.beast, real, sourcePlayerIds: ids, sourceType, text: raw });
          const targetCall = new RegExp(`(?:投(?:給|向)?|號召(?:大家)?投(?:給|向)?|希望大家投(?:給|向)?|建議大家投(?:給|向)?)[^，。！？；;]{0,12}【?${tag.beast}】?`);
          if (CALL_RE.test(prefix + suffix) && targetCall.test(raw) && !out.quotedCalls.some(item => item.beast === tag.beast && JSON.stringify(item.sourcePlayerIds) === JSON.stringify(ids))) {
            out.quotedCalls.push({ beast: tag.beast, sourcePlayerIds: ids, sourceType, text: raw });
          }
        });
      };
      if (quotedReportOpen) {
        const closeAt = clause.search(/[」』”"]/);
        if (closeAt >= 0) {
          quotedReportBuffer += (quotedReportBuffer ? '，' : '') + clause.slice(0, closeAt);
          collectReportedStatement(quotedReportBuffer, quotedReportSourceIds, 'attributed-quote');
          quotedReportBuffer = '';
          quotedReportSourceIds = [];
          quotedReportOpen = false;
          attributionOpen = false;
        } else {
          quotedReportBuffer += (quotedReportBuffer ? '，' : '') + clause;
        }
        return;
      }
      if (quotedReportLead) {
        const openAt = clause.search(/[「『“\"]/);
        const closeAt = clause.search(/[」』”\"]/);
        if (openAt >= 0 && (closeAt < 0 || closeAt < openAt)) {
          quotedReportBuffer = clause.slice(openAt + 1);
          quotedReportSourceIds = mentions(clause.slice(0, openAt), room).map(player => player.id);
          quotedReportOpen = true;
        } else {
          collectReportedStatement(clause, mentions(clause, room).map(player => player.id), 'attributed-report');
        }
        attributionOpen = true;
        return;
      }
      if (namedReportCue || tagQuoteCue || reportedLead || inheritedReport) {
        // 當來源提示與引號同時出現時，跨逗號維持引用狀態；否則下一段
        // 「我主張投鼠」會被誤認成說話者自己的承諾。
        const openAt = clause.search(/[「『“\"]/);
        const closeAt = clause.search(/[」』”\"]/);
        let sourceIds = mentions(clause.slice(0, openAt >= 0 ? openAt : clause.length), room).map(player => String(player.id));
        if (!sourceIds.length && /^你(?:剛才|先前)?(?:說|主張|表示|宣稱|認為|號召|提出|建議|懷疑)/.test(trimmedClause))
          sourceIds = previousReportedSourceIds.length ? previousReportedSourceIds.slice() : priorSpeakerIds.slice();
        if (sourceIds.length) previousReportedSourceIds = sourceIds.slice();
        if (openAt >= 0 && (closeAt < 0 || closeAt < openAt)) {
          quotedReportBuffer = clause.slice(openAt + 1);
          quotedReportSourceIds = sourceIds;
          quotedReportOpen = true;
        } else if (openAt >= 0 && closeAt > openAt) {
          collectReportedStatement(clause.slice(openAt + 1, closeAt), sourceIds, 'attributed-quote');
        } else {
          collectReportedStatement(clause, sourceIds, 'attributed-report');
        }
        attributionOpen = true;
        return;
      }
      if (ownSpeakerLead) attributionOpen = false;
      // 雙獸首結論只在已確認屬於本人發言的片段解析；引用內容交由 quotedClaims 保存。
      const paired = trimmedClause.match(/([鼠牛虎兔龍蛇馬羊猴雞狗豬]{2})\s*雙\s*(真|假|贗)/);
      if (paired) [...paired[1]].forEach(beast => {
        if (valid.has(beast) && !out.claims.some(item => item.beast === beast && item.real === (paired[2] === '真'))) {
          out.claims.push({ beast, real: paired[2] === '真' });
        }
      });
      if (/(被偷襲|眼前一片黑|一片黑)/.test(clause)) {
        out.blind = true;
        out.uncertaintyReasons.push({ reason: 'ambush', provenance: 'self_report', verification: 'not_independently_verified', text: clause.trim() });
      }
      if (/(封鎖|封住|封掉).{0,10}(?:獸首|首|[鼠牛虎兔龍蛇馬羊猴雞狗豬])|[鼠牛虎兔龍蛇馬羊猴雞狗豬].{0,8}(?:被)?封鎖|(?:鄭國渠|封鎖技能).{0,12}(?:封鎖|封住)/.test(clause)) {
        out.uncertaintyReasons.push({ reason: 'blocked', provenance: 'self_report', verification: 'not_independently_verified', text: clause.trim() });
      }
      if (/(困惑|混亂|本輪.{0,8}(?:無法辨別|驗不到|看不懂)|能力.{0,8}(?:驗不到|無法辨別)|(?:黃煙煙|木戶加奈).{0,14}(?:驗不到|無法辨別|看不懂)|(?:驗不到|無法辨別|看不懂).{0,14}(?:黃煙煙|木戶加奈))/.test(clause)) {
        out.uncertaintyReasons.push({ reason: 'role_confusion', provenance: 'self_report', verification: 'not_independently_verified', text: clause.trim() });
      }
      if (/(老朝奉.{0,10}(?:擾亂|反轉)|(?:被|遭).{0,8}(?:老朝奉)?(?:擾亂|反轉)|視野受影響|查驗.{0,8}被反轉)/.test(clause)) {
        out.uncertaintyReasons.push({ reason: 'lao_disruption', provenance: 'self_report', verification: 'not_independently_verified', text: clause.trim() });
      }
      if (/(驗不到|看不懂|無法辨別|沒看到|看不到|沒驗到)/.test(clause)) {
        out.unsure = true;
        if (!out.uncertaintyReasons.length || !out.uncertaintyReasons.some(item => item.text === clause.trim())) {
          out.uncertaintyReasons.push({ reason: 'unspecified', provenance: 'self_report', verification: 'not_independently_verified', text: clause.trim() });
        }
      }
      if (/(?:我|本人)?\s*(?:這輪|本輪|目前)?\s*(?:先)?(?:棄票|不投票|不落票|保留籌碼|留票|先不投)/.test(clause)) {
        out.abstentionReason = clause.trim();
      }

      /* --- 獸首宣稱與落票號召 --- */
      const tags = [...clause.matchAll(TAG_RE)].map(m => ({ beast: m[1] || m[2], s: m.index, e: m.index + m[0].length }));
      // 口語「我兩票投羊／我投羊」未必帶獸首括號，也未必同時宣稱真偽，仍是獨立的票單承諾。
      const plainVote = clause.match(/(?:我|本人|我的票)[^，。！？；;]{0,12}(?:投(?:給|向)?|落票(?:在|給)?|押(?:在|給)?)\s*【?([鼠牛虎兔龍蛇馬羊猴雞狗豬])】?/);
      const softVoteLanguage = /(?:我|本人|我的票)[^，。！？；;]{0,10}(?:可能|想|傾向|偏向|考慮|或許|也許|應該|打算|大概)[^，。！？；;]{0,8}(?:投|落票|押)/.test(clause) ||
        /(?:我|本人)[^，。！？；;]{0,12}(?:主要|主)票向[^，。！？；;]{0,14}(?:跟隨|偏向|投向|投給|投)/.test(clause);
      const negativeVoteLanguage = /(?:無法|不能|不會|不願(?:意)?|不想|不打算|不準備|不可能|不一定|先不|別|不要|不准|禁止)[^，。！？；;]{0,8}(?:盲目|跟(?:著|你|他|她|大家)?|照(?:著|抄))?[^，。！？；;]{0,8}(?:投|落票|押)/.test(clause) ||
        /(?:不想|不打算|不準備|不會|不願(?:意)?|不可能|不一定|先不|別|不要|不准|禁止)(?:會|要)?(?:把票)?(?:投|落票|押)/.test(clause) ||
        /(?:不投|別投|不要投|想不投|可能不投|也許不投|或許不投|傾向不投|考慮不投|不考慮投|不傾向投)/.test(clause);
      const historicalVote = (historicalContextOpen || /(?:第\s*[一二三123]\s*(?:回|輪)|上輪|上一輪|前輪|前一輪|過去|先前|當時|曾經|投過)/.test(clause)) &&
        !/(?:本輪|這輪|這次|目前|現在|我這輪|我本輪)/.test(clause);
      const quotedVote = /[「『“"]/.test(clause) && /[」』”"]/.test(clause);
      // 「我主張／號召／呼籲投羊」是對外票向，不是本人硬承諾；只有「我會投羊」才進 commitment。
      const callOnlyLanguage = /(?:我|本人)?(?:主張|號召|呼籲|建議|希望|推薦|倡議)[^，。！？；;]{0,14}(?:大家|各位|全場)?(?:把票)?(?:投|落票)/.test(clause);
      if (softVoteLanguage) {
        const softTarget = (tags.length ? tags[0].beast : (plainVote && plainVote[1])) || null;
        if (softTarget && valid.has(softTarget) && !negativeVoteLanguage && !inheritedReport && !quotedVote && !historicalVote && !callOnlyLanguage &&
            !/(?:不想投|不考慮投|不傾向投|不可能投)/.test(clause) &&
            !out.voteIntents.some(item => item.beast === softTarget && item.kind === 'soft-intent')) {
          out.voteIntents.push({ beast: softTarget, binding: false, kind: 'soft-intent', intensity: 0.35, text: clause.trim() });
          out.voteIntentBeast = softTarget;
          out.voteIntentStrength = Math.max(out.voteIntentStrength, 0.35);
        }
      }
      const directPersonalVote = /^(?:(?:因此|所以|那麼|最後)\s*)?(?:我|本人|我的票)(?:(?:這輪|本輪|這次|目前)\s*)?(?:(?:公開)?(?:決定|承諾)\s*(?:(?:這輪|本輪|這次)\s*)?|(?:會|將|一定|就|先)?\s*(?:把票)?\s*|(?:[一二兩三四五六七八12345678])\s*票\s*)(?:投(?:給|向)?|落票(?:在|給)?|押(?:在|給)?)/.test(clause.trim());
      if (plainVote && valid.has(plainVote[1]) && directPersonalVote && !softVoteLanguage && !negativeVoteLanguage && !inheritedReport && !quotedVote && !historicalVote && !callOnlyLanguage && !/(?:建議大家投)/.test(clause) &&
          !/(?:應該|可能|考慮|猶豫|不一定|或許|也許)[^，。！？；;]{0,8}(?:投|落票|押)/.test(clause) &&
          !/(?:第\s*[一二三123]\s*(?:回|輪)|上輪|上一輪|前輪|前一輪|曾經|投過)/.test(clause)) {
        const nMatch = clause.match(/([一二兩三四五六七八12345678])\s*票/);
        const nMap = { '一':1,'二':2,'兩':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8 };
        if (!out.voteCommitments.some(item => item.beast === plainVote[1]))
          out.voteCommitments.push({ beast: plainVote[1], chips: nMatch ? nMap[nMatch[1]] : null, text: clause.trim(), binding: true, kind: 'explicit' });
      }
      // 「鼠不能投／不要投鼠」是公開票向限制，不是肯定的投票承諾；保留給討論回應，不能直接當成 BOT 的硬規則。
      const historicalVoteAvoid = (historicalContextOpen || /(?:第\s*[一二三123]\s*(?:回|輪)|上(?:一)?輪|前一輪|前輪|過去|先前|當時|曾經)/.test(clause)) &&
        !/(?:本輪|這輪|這次|目前|現在|我這輪|我本輪)/.test(clause);
      if (!historicalVoteAvoid) {
        const avoidPattern = /(?:【?([鼠牛虎兔龍蛇馬羊猴雞狗豬])】?\s*(?:絕對)?(?:不能|不可|不准|禁止)(?:把票)?投|(?:不要|別|不准|禁止|不能|不可)(?:把票)?投(?:給|向)?\s*【?([鼠牛虎兔龍蛇馬羊猴雞狗豬])】?)/g;
        let avoidMatch;
        while ((avoidMatch = avoidPattern.exec(clause))) {
          const beast = avoidMatch[1] || avoidMatch[2];
          if (valid.has(beast) && !out.voteAvoids.includes(beast)) out.voteAvoids.push(beast);
        }
      }
      // 只有「我／本人／我的票」明確承諾自己本輪落票才建立硬承諾。
      // 「我建議大家投」「我主張投」是公開建議，不是本人承諾；否定、可能、歷史及引用也不算。
      if (tags.length === 1) {
        const beforeTarget = clause.slice(0, tags[0].s);
        const afterTarget = clause.slice(tags[0].e);
        const explicitFirstPerson = /(?:我|本人|我的票)/.test(beforeTarget);
        const positiveVoteVerb = directPersonalVote;
        const recommendationOnly = /(?:我|本人)?(?:建議|主張|呼籲|號召|希望|推薦|倡議)(?:這輪|本輪|大家|各位|全場)?[^，。！？；;]{0,10}(?:把票)?(?:投|落票)|我希望大家投/.test(beforeTarget);
        const quotedPromise = /[「『“"]/.test(beforeTarget) && /[」』”"]/.test(afterTarget);
        const deniedOrUncertain = softVoteLanguage || negativeVoteLanguage || /(?:不想|不打算|不準備|不會|不願|不可能|不一定|可能|想|傾向|應該|考慮|猶豫|先不|不要|別)\s*(?:會|要)?\s*(?:把票)?\s*(?:投|落票|押)/.test(beforeTarget) ||
          /(?:不投|別投|不要投|不會投|不打算投|可能投|考慮投)/.test(beforeTarget + afterTarget);
        const historical = /(?:第\s*[一二三123]\s*(?:回|輪)|上輪|上一輪|前輪|前一輪|過去|先前|當時|曾經|投過)/.test(beforeTarget + afterTarget) &&
          !/(?:本輪|這輪|這次|目前|現在)/.test(beforeTarget + afterTarget);
        if (valid.has(tags[0].beast) && explicitFirstPerson && positiveVoteVerb && !recommendationOnly && !quotedPromise && !deniedOrUncertain && !historical && !inheritedReport) {
          const beast = tags[0].beast;
          if (!out.voteCommitments.some(item => item.beast === beast)) {
            const chipCountMatch = clause.match(/([一二兩三四五六七八12345678])\s*票/);
            const chipNums = { '一':1,'二':2,'兩':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8 };
            out.voteCommitments.push({ beast, chips: chipCountMatch ? chipNums[chipCountMatch[1]] : null, text: clause.trim(), binding: true, kind: 'explicit' });
          }
        }
      }
      const publicResultReference = /(?:開出來|公開結果|公布結果|結果公布|開票後|開出後)/.test(clause);
      const historicalBeastReference = (historicalContextOpen || /(?:第\s*\d+\s*輪|第\s*[一二三123]\s*(?:回|輪)|上輪|上一輪|前輪|前一輪|過去|先前|最近一次|後來公開|開票前|當時|歷史紀錄)/.test(clause)) &&
        !/(?:本輪|這輪|這次|目前|現在|我這輪|我本輪)/.test(clause);
      tags.forEach((t, i) => {
        if (!valid.has(t.beast)) return;
        const reportOnlyClause = out.inspectionReports.some(report => report.beast === t.beast &&
          clause.includes(report.text) && /(?:確認到(?:的)?(?:查驗)?結果|查驗結果|檢驗結果)/.test(clause) &&
          !/(?:整體|綜合|總體|我判斷|我認為|我的判斷|我推測|我主張)/.test(clause));
        // 引用他人宣稱（「藍色【宗彥】在第三位說【鼠】是假」）不算發言者自己的宣稱
        const before = clause.slice(0, t.s);
        const citedPlayers = mentions(before, room);
        const attributedQuote = citedPlayers.length > 0 &&
          /(?:說|宣稱|表示|認為|主張|提到|指出|原話|引用|轉述).{0,16}$/.test(before);
        // 兼容「針對某人剛才的『【羊】是真品』」這種先開引號、沒有「說」字的引用句。
        const attributedQuotedSpan = /[「『“"]\s*$/.test(before) &&
          /[」』”"]/.test(clause.slice(t.e));
        const enclosedQuote = /[「『“"]/.test(before) && /[」』”"]/.test(clause.slice(t.e));
        if (enclosedQuote || (citedPlayers.length > 0 &&
            (QUOTE_RE.test(before) || attributedQuote || attributedQuotedSpan))) return;
        const suffix = clause.slice(
  t.e,
  i + 1 < tags.length ? tags[i + 1].s : clause.length
);
const prefix = clause.slice(
  Math.max(i ? tags[i - 1].e : 0, t.s - 6),
  t.s
);

// 真假判斷只看獸首標籤附近的短距離語義，避免把同一長句後段的
// 「來源拆開是…」「這是公開自述」等分析文字，誤當成該獸首的真假結論。
// 允許結果在標籤前（「查驗為真【鼠】」）或標籤後（「【鼠】是真」）。
const nearbySuffix = suffix.slice(0, 24);
const nearbyPrefix = i === 0 ? prefix.slice(-14) : '';
const scope = `${nearbyPrefix}${nearbySuffix}`;
const verdictIsMentionedAsAnObject = /的(?:真品|贗品|假品|真假|真偽)?(?:判斷|指控|主張|說法|宣稱|推論|猜測|結論)/.test(nearbySuffix) ||
  /(?:指控|主張|說法|宣稱|推論|猜測|結論)\s*(?:更|比較|反而|仍然)/.test(nearbySuffix);

// 「真偽／真假主張」是對證據類型的抽象描述，不是某尊獸首的真品宣稱；
// 先去除這類名詞短語，避免其中的「真／假」觸發真假結果解析。
const resultScope = scope.replace(/(?:真偽|真假)(?:主張|結論|判斷|結果|資訊|分布)?/g, '');
// 「不是假／並非假」是肯定真品，避免被其中的「假」字誤判。
const fakeScope = resultScope.replace(/不是假|並非假/g, '');
const fake = FAKE_RE.test(fakeScope);
const real = !fake && REAL_RE.test(resultScope);

if ((fake || real) && !publicResultReference && !historicalBeastReference && !verdictIsMentionedAsAnObject && !reportOnlyClause) {
  out.claims.push({ beast: t.beast, real });
}

// 落票判斷只檢查獸首標籤前方的文字。
const callScope = prefix;
const fullCallPrefix = clause.slice(0, t.s);
const deniedCall =
  /(不想(?:去)?投|不打算投|不準備投|不會投|不願(?:意)?投|不可能投|不投|別投|不要投|不想集火|不打算集火|不集火|別集火|不要集火|不跟|別跟|不要跟)/.test(fullCallPrefix) ||
  /(?:不會|不想|不打算|不準備|不願(?:意)?|無法|不能|拒絕|反對|不支持)[^，。！？；;]{0,12}(?:投|號召|呼籲|建議|集火|跟票|跟投)/.test(fullCallPrefix);
// 回顧過去的票數不能被當成本輪落票意圖，例如「第1輪我投了2票給【蛇】」。
// 若同一子句明確標示本輪／這輪／目前，則允許讀取其當前票向。
const historicalClause = (historicalContextOpen || /(?:第\s*\d+\s*輪|第\s*[一二三123]\s*(?:回|輪)|上輪|上一輪|前輪|前一輪|過去|先前|最近一次|後來公開|開票前|當時|歷史紀錄)/.test(clause)) &&
  !/(?:本輪|這輪|這次|目前|現在|我這輪|我本輪)/.test(clause);

const thirdPartyCall = mentions(callScope, room).length > 0 &&
  /(?:叫大家|要大家|希望大家|建議大家|呼籲大家|號召大家|請大家|讓大家|帶大家|跟投)/.test(callScope) &&
  !/^(?:但|不過|可是|然而)?\s*(?:我|本人|我的)/.test(callScope.trim());
if (!deniedCall && !historicalClause && !thirdPartyCall && CALL_RE.test(callScope)) {
  if (!out.callBeast) out.callBeast = t.beast;
  if (!out.callBeasts.includes(t.beast)) {
    out.callBeasts.push(t.beast);
  }
}
      });

      /* --- 玩家指認 / 集火 / 方震陣營查驗 --- */
      const ps = mentionsInClause(clause, room);
      const roleClaims = parseRoleClaims(clause, room, previousRoleSubjectId);
      if (roleClaims.length) {
        roleClaims.forEach(item => {
          out.roleClaims.push(item);
          if (item.polarity !== 'deny') out.accuse.push({ playerId: item.playerId, role: item.role, polarity: item.polarity });
          previousRoleSubjectId = item.playerId;
        });
      } else if (ps.length === 1) {
        previousRoleSubjectId = ps[0].id;
      }
      // 將人物陣營主張與獸首真偽分開解析。多人共用同一個陣營謂語時，
      // 必須把每個目標都保留下來；舊版 ps.length === 1 會整句丟棄。
      if (ps.length >= 1) {
        const goodPhrase = /好人|許願陣營|善方/.test(clause);
        const evilPhrase = /壞人|很壞|壞|老朝奉陣營|邪方/.test(clause);
        const negation = /(?:不是|並非|不算|絕非|不屬於|不覺得|不認為|不像|不會是|不可能是|非得不是)/;
        const negatesGood = negation.test(clause) && /(?:好人|許願陣營|善方)/.test(clause);
        const negatesEvil = negation.test(clause) && /(?:壞人|老朝奉陣營|邪方)/.test(clause);
        const historicalQuote = /(?:曾|先前|以前|上輪|上一輪|前輪|第\s*\d+\s*輪|原話|轉述|引用|說過)/.test(clause) &&
          /(?:說|表示|宣稱|主張|認為|指出|自稱|判為)/.test(clause);
        let stanceCamp = null;
        if (negatesGood !== negatesEvil) {
          if (negatesGood) stanceCamp = 'evil';
          else if (negatesEvil) stanceCamp = 'good';
        } else if (!negatesGood && !negatesEvil) {
          if (evilPhrase) stanceCamp = 'evil';
          else if (goodPhrase) stanceCamp = 'good';
        }
        const collectiveTargetList = ps.length === 1 ||
          /(?:都|全都|全部|皆|兩個|兩位|每個|各自)/.test(clause) ||
          /^(?:我認為|我覺得|我判斷)?\s*(?:好人|壞人|老朝奉陣營|許願陣營|邪方|善方)(?:應該|可能|大概|也許)?(?:就是|是|為|有)?/.test(clause);
        if (stanceCamp && !historicalQuote && collectiveTargetList) {
          ps.forEach(player => out.playerStances.push({
            targetId: player.id,
            camp: stanceCamp,
            evidence: { type: 'direct-public-stance', text: clause.trim() }
          }));
        }
      }
      const selfRole = clause.match(/我是(?:【)?(老朝奉|藥不然|鄭國渠|許願|方震|姬雲浮|黃煙煙|木戶加奈|平民)/);
      if (selfRole) {
        const roleBefore = clause.slice(0, selfRole.index);
        const roleBeforeMentionsPlayer = mentions(roleBefore, room).length > 0;
        const roleCited = roleBeforeMentionsPlayer &&
          /(?:說|宣稱|表示|認為|主張|提到|指出|原話|引用|轉述|自稱|自報).{0,16}$/.test(roleBefore);
        const roleQuoted = /[「『“"]\s*$/.test(roleBefore);
        // Reported/historical self-claims are not the current speaker's own role claim.
        const reportedSelfRole = /(?:曾(?:經)?|先前|此前|之前|以前|跨輪|跨回合|第\s*\d+\s*輪|上(?:一)?輪).{0,20}(?:自稱|自報|聲稱|宣稱|說過|表示|我是)/.test(clause) ||
          /(?:自稱|自報|宣稱自己|聲稱自己|說自己).{0,18}$/.test(roleBefore);
        if (!roleCited && !roleQuoted && !reportedSelfRole) out.selfRole = selfRole[1];
      }
      if (/(我認壞|我是壞人|我們是壞人|我屬於壞人|我站壞人)/.test(clause)) out.selfEvil = true;
      if (/(我是好人|我不是壞人|不要投我|別投我|不要集火我|別把票投我|請別投我|我沒做壞事)/.test(clause)) out.selfDefense = true;
      if (!selfRole) {
        const askPattern = /請[^，。！？；;:：]{0,24}(?:說明|解釋|交代)/g;
        let askMatch;
        while ((askMatch = askPattern.exec(clause))) {
          const askPlayers = mentions(askMatch[0], room);
          if (askPlayers.length === 1 && !out.asked.includes(askPlayers[0].id)) out.asked.push(askPlayers[0].id);
        }
      }
      if (ps.length === 1 && !selfRole && !roleClaims.length) {
        const role = ALL_ROLES.find(r => clause.includes(r)) || null;
        // A role name merely appearing beside a player is not an accusation.
        // Require an explicit role-link, and do not promote a quoted/historical self-claim into a new accusation.
        const historicalRoleMention = /(?:跨輪|跨回合|第\s*\d+\s*輪|上(?:一)?輪|先前|此前|之前|以前|曾(?:經)?|歷史|原話|引用|轉述|自稱|自報|身份版本|身分版本)/.test(clause);
        const explicitRoleLink = role && (
          new RegExp('(?:是|為|就是|其實是|根本是|實際上是|應該是|可能是|疑似|認定為|判定為|指認[^，。！？]{0,12}為)\\s*' + role).test(clause) ||
          new RegExp('(?:認為|懷疑|覺得)[^，。！？]{0,12}(?:是|為)?\\s*' + role).test(clause)
        );
        const roleIndex = role ? clause.indexOf(role) : -1;
        const beforeRole = roleIndex >= 0 ? clause.slice(0, roleIndex) : '';
        const negatedRoleLink = role && (
          new RegExp('(?:不是|並非|並不是|不可能是|不算是)\\s*' + role).test(clause) ||
          /(?:不認為|不懷疑|不覺得|不認定|不指認|沒有指認|不相信)[^，。！？]*$/.test(beforeRole)
        );
        if (role && explicitRoleLink && !historicalRoleMention && !negatedRoleLink) {
          out.accuse.push({ playerId: ps[0].id, role });
        }
        if (DIRECT_SUSPECT_CALL_RE.test(clause)) out.callSuspectId = ps[0].id;
        const camp = clause.match(/(查驗|驗過|驗了).*(好人|壞人|老朝奉陣營|許願陣營)/);
        if (camp) out.campChecks.push({ targetId: ps[0].id, camp: /壞人|老朝奉陣營/.test(camp[2]) ? 'evil' : 'good' });
      }
      });
    });
    out.playerStances.push(...parseHistoricalVoteStances(text, room, round));
    // Repeating the same claim in one speech is not independent evidence.
    // Keep opposite truth values for the same beast so contradictions remain visible.
    const seenClaims = new Set();
    out.claims = out.claims.filter(c => {
      const key = JSON.stringify([c.beast, !!c.real]);
      if (seenClaims.has(key)) return false;
      seenClaims.add(key);
      return true;
    });
    const claimByBeast = new Map();
    (out.claims || []).forEach(c => {
      if (!claimByBeast.has(c.beast)) claimByBeast.set(c.beast, new Set());
      claimByBeast.get(c.beast).add(!!c.real);
    });
    claimByBeast.forEach((verdicts, beast) => {
      if (verdicts.size > 1) out.selfContradictions.push({ beast, verdicts: [...verdicts], scope: 'same_speech', text });
    });
    // A cause stated in one clause (e.g.「我被偷襲，驗不到」) governs the same utterance;
    // do not create a second generic 'unspecified' reason from its follow-up clause.
    const specificUncertainty = new Set(['ambush', 'blocked', 'role_confusion', 'lao_disruption']);
    if (out.uncertaintyReasons.some(item => specificUncertainty.has(item.reason))) {
      out.uncertaintyReasons = out.uncertaintyReasons.filter(item => item.reason !== 'unspecified');
    }
    // 強烈重複喊某尊獸首為真可作為「可能投向」的軟訊號，但不是本人硬承諾。
    const emphatic = new Map();
    for (const match of text.matchAll(/【([鼠牛虎兔龍蛇馬羊猴雞狗豬])】\s*(?:是真品|是贗品|是真|是假|真品|贗品|真|假)/g)) {
      const beast = match[1];
      emphatic.set(beast, (emphatic.get(beast) || 0) + 1);
    }
    const repeatedIntent = [...emphatic.entries()].filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])[0];
    if (repeatedIntent && !(out.voteCommitments || []).length) {
      const [beast, count] = repeatedIntent;
      out.voteIntents.push({ beast, binding: false, kind: 'emphatic-repeated-verdict', intensity: Math.min(1, count / 5), count });
      out.voteIntentBeast = beast;
      out.voteIntentStrength = Math.min(1, count / 5);
    }
    const uniqueCommitmentTargets = [...new Set((out.voteCommitments || []).map(item => item.beast))];
    out.voteCommitment = uniqueCommitmentTargets.length === 1 ? uniqueCommitmentTargets[0] : null;
    out.voteCommitmentBinding = uniqueCommitmentTargets.length === 1;
    const stancesByKey = new Map();
    out.playerStances.forEach(item => {
      const key = JSON.stringify([item.targetId, item.camp]);
      const existing = stancesByKey.get(key);
      if (!existing) stancesByKey.set(key, { ...item, evidence: item.evidence ? [item.evidence] : [] });
      else if (item.evidence) existing.evidence.push(item.evidence);
    });
    out.playerStances = [...stancesByKey.values()];
    out.speakerClaims = out.claims.map(item => ({ ...item }));
    out.truthStances = out.speakerClaims.map(item => ({ ...item }));
    out.speakerCalls = [...out.callBeasts];
    out.speakerCommitments = out.voteCommitments.map(item => ({ ...item }));
    return out;
  }

  // Re-parse visible speech first, then retain non-conflicting legacy structured metadata only
  // when the utterance is not quoting/reporting somebody else. Old p may contain attribution bugs.
  function parseRecord(sp, room, roundArg) {
    const structured = sp && sp.p && typeof sp.p === 'object' ? sp.p : {};
    const sourceText = String(sp && sp.text || '');
    if (!sourceText.trim()) {
      return {
        ...structured,
        claims: Array.isArray(structured.claims) ? structured.claims : [],
        callBeasts: Array.isArray(structured.callBeasts) ? structured.callBeasts : [],
        accuse: Array.isArray(structured.accuse) ? structured.accuse : [],
        campChecks: Array.isArray(structured.campChecks) ? structured.campChecks : [],
        asked: Array.isArray(structured.asked) ? structured.asked : [],
        voteCommitments: Array.isArray(structured.voteCommitments) ? structured.voteCommitments : [],
        voteIntents: Array.isArray(structured.voteIntents) ? structured.voteIntents : [],
        voteIntentBeast: structured.voteIntentBeast || null, voteIntentStrength: Number(structured.voteIntentStrength) || 0,
        voteCommitmentBinding: structured.voteCommitmentBinding === true,
        abstentionReason: structured.abstentionReason || null,
        speakerClaims: Array.isArray(structured.speakerClaims) ? structured.speakerClaims : (Array.isArray(structured.claims) ? structured.claims : []),
        truthStances: Array.isArray(structured.truthStances) ? structured.truthStances : (Array.isArray(structured.claims) ? structured.claims : []),
        speakerCalls: Array.isArray(structured.speakerCalls) ? structured.speakerCalls : (Array.isArray(structured.callBeasts) ? structured.callBeasts : []),
        speakerCommitments: Array.isArray(structured.speakerCommitments) ? structured.speakerCommitments : (Array.isArray(structured.voteCommitments) ? structured.voteCommitments : []),
        quotedClaims: Array.isArray(structured.quotedClaims) ? structured.quotedClaims : [],
        quotedCalls: Array.isArray(structured.quotedCalls) ? structured.quotedCalls : [],
        reportedStatements: Array.isArray(structured.reportedStatements) ? structured.reportedStatements : [],
        roleClaims: Array.isArray(structured.roleClaims) ? structured.roleClaims : [],
        roleComparisons: Array.isArray(structured.roleComparisons) ? structured.roleComparisons : [],
        countConstraints: Array.isArray(structured.countConstraints) ? structured.countConstraints : [],
        skillClaims: Array.isArray(structured.skillClaims) ? structured.skillClaims : [],
        selfContradictions: Array.isArray(structured.selfContradictions) ? structured.selfContradictions : [],
        uncertaintyReasons: Array.isArray(structured.uncertaintyReasons) ? structured.uncertaintyReasons : [],
        positionClaims: Array.isArray(structured.positionClaims) ? structured.positionClaims : [],
        voteAvoids: Array.isArray(structured.voteAvoids) ? structured.voteAvoids : []
      };
    }
    let parsed = {};
    try { parsed = parse(sourceText, room, roundArg, sp && sp.playerId || null); } catch (_) {}
    const hasReportedSpeech = /(?:原話|原文|引用|轉述|複述|重述|復述|照讀|聽到前手|聽說|前手|前一位|上一位|對方|該玩家|該人|原發言者|(?:他|她)(?:剛才|先前)?(?:說|主張|表示|號召)|(?:剛才|先前)(?:說|主張|表示|號召)|曾(?:公開)?(?:說|主張|表示|號召)|說過|(?:希望|建議|呼籲)大家投|(?:曾|先前|此前|之前|以前|跨輪|跨回合|第\s*\d+\s*輪|上(?:一)?輪).{0,20}(?:自稱|自報|聲稱|宣稱|說過|表示|我是))/.test(sourceText) ||
      /[「『“"][^」』”"]*[」』”"]/.test(sourceText);
    const list = key => !hasReportedSpeech && Array.isArray(structured[key]) && structured[key].length
      ? structured[key] : (Array.isArray(parsed[key]) ? parsed[key] : []);
    return {
      ...parsed,
      // Raw text wins whenever it contains a parseable statement or a quote/report cue.
      claims: (hasReportedSpeech || (parsed.claims || []).length) ? (parsed.claims || []) : list('claims'),
      callBeast: parsed.callBeast || (hasReportedSpeech ? null : structured.callBeast || null),
      callBeasts: (hasReportedSpeech || (parsed.callBeasts || []).length) ? (parsed.callBeasts || []) : list('callBeasts'),
      callSuspectId: parsed.callSuspectId || (hasReportedSpeech ? null : structured.callSuspectId || null),
      accuse: (hasReportedSpeech || (parsed.accuse || []).length) ? (parsed.accuse || []) : list('accuse'),
      campChecks: list('campChecks'),
      asked: list('asked'),
      selfRole: parsed.selfRole || (hasReportedSpeech ? null : structured.selfRole || null),
      selfEvil: hasReportedSpeech ? !!parsed.selfEvil : (!!structured.selfEvil || !!parsed.selfEvil),
      selfDefense: !!parsed.selfDefense || (!hasReportedSpeech && !!structured.selfDefense),
      playerStances: (parsed.playerStances || []).length || hasReportedSpeech ? (parsed.playerStances || []) : list('playerStances'),
      candidateSets: parsed.candidateSets || [],
      inspectionReports: parsed.inspectionReports || [],
      roleClaims: parsed.roleClaims || [],
      roleComparisons: parsed.roleComparisons || [],
      countConstraints: parsed.countConstraints || [], skillClaims: parsed.skillClaims || [],
      selfContradictions: parsed.selfContradictions || [], uncertaintyReasons: parsed.uncertaintyReasons || [],
      positionClaims: parsed.positionClaims || [],
      voteAvoids: parsed.voteAvoids || [],
      voteCommitments: parsed.voteCommitments || [],
      voteIntents: parsed.voteIntents || [], voteIntentBeast: parsed.voteIntentBeast || null,
      speakerClaims: parsed.speakerClaims || parsed.claims || [], truthStances: parsed.truthStances || parsed.speakerClaims || parsed.claims || [],
      speakerCalls: parsed.speakerCalls || parsed.callBeasts || [],
      speakerCommitments: parsed.speakerCommitments || parsed.voteCommitments || [],
      quotedClaims: parsed.quotedClaims || [], quotedCalls: parsed.quotedCalls || [], reportedStatements: parsed.reportedStatements || [],
      voteIntentStrength: Number(parsed.voteIntentStrength) || 0,
      voteCommitment: parsed.voteCommitment || null, voteCommitmentBinding: parsed.voteCommitmentBinding === true,
      abstentionReason: parsed.abstentionReason || null,
      blind: hasReportedSpeech ? !!parsed.blind : (!!structured.blind || !!parsed.blind),
      unsure: hasReportedSpeech ? !!parsed.unsure : (!!structured.unsure || !!parsed.unsure)
    };
  }

  /** 例：[真人] 宣稱【鼠】真、【牛】假；號召投【鼠】；號召集火 藍色【宗彥】 */
  function summarize(parsed, label, room, rawText) {
    const parts = [];
    if (parsed.claims.length) parts.push('宣稱' + parsed.claims.map(c => `【${c.beast}】${c.real ? '真' : '假'}`).join('、'));
    (parsed.countConstraints || []).forEach(c => parts.push(`${c.populationLabel}中推測有 ${c.min}–${c.max} 名壞人（低權重數量假設，非座位順位）`));
    (parsed.selfContradictions || []).forEach(c => parts.push(`同一發言對【${c.beast}】自相矛盾`));
    (parsed.positionClaims || []).filter(c => c.verified === false).forEach(c => parts.push(`順位陳述不符：自稱第${c.claimed}位${c.kind === 'pass' ? '掌眼' : '發言'}，紀錄為第${c.actual}位`));
    if (parsed.selfEvil) parts.push('公開認壞');
    parsed.asked.forEach(id => { const p = GD.U.byId(room, id); if (p) parts.push(`質問${GD.U.tag(p)}`); });
    if (parsed.blind) parts.push('自稱遭偷襲');
    else if (parsed.unsure) parts.push('自稱驗不到');
    if (parsed.callBeasts.length) parts.push('號召投' + parsed.callBeasts.map(b => `【${b}】`).join(''));
    if ((parsed.voteAvoids || []).length) parts.push('主張避免投' + parsed.voteAvoids.map(b => `【${b}】`).join('')); 
    parsed.campChecks.forEach(c => {
      const p = GD.U.byId(room, c.targetId);
      if (p) parts.push(`方震式查驗：${GD.U.tag(p)}為${c.camp === 'evil' ? '壞人' : '好人'}`);
    });
    (parsed.playerStances || []).forEach(st => {
      const p = GD.U.byId(room, st.targetId);
      if (p) parts.push(`人物立場：${GD.U.tag(p)}被判為${st.camp === 'evil' ? '壞人' : '好人'}`);
    });
    if (parsed.selfDefense) parts.push('自辯：自稱好人／要求不要投票');
    (parsed.candidateSets || []).forEach(group => {
      const tags = group.candidateIds.map(id => GD.U.byId(room, id)).filter(Boolean).map(p => GD.U.tag(p));
      if (tags.length) parts.push(group.role + "候選集合：" + tags.join("、") + "之中一人（待驗假設）");
    });
    (parsed.inspectionReports || []).forEach(report => {
      parts.push("第" + report.round + "輪公開回報：驗【" + report.beast + "】為" + (report.claimedReal ? "真品" : "贗品") + "（待與公開結果核對）");
    });
    const roleClaims = Array.isArray(parsed.roleClaims) && parsed.roleClaims.length
      ? parsed.roleClaims : (parsed.accuse || []);
    roleClaims.forEach(a => {
      const p = GD.U.byId(room, a.playerId);
      if (!p) return;
      if (a.polarity === 'deny') parts.push(`排除${GD.U.tag(p)}是${a.role}（不等於證明好人）`);
      else if (a.polarity === 'fake') parts.push(`指稱${GD.U.tag(p)}是假冒${a.role}`);
      else parts.push(`指認${GD.U.tag(p)}是${a.role}`);
    });
    (parsed.roleComparisons || []).forEach(item => {
      if (item && Array.isArray(item.roles) && item.roles.length >= 2) {
        parts.push(`角色比較問題：${item.roles.join('與')}是否相同`);
      }
    });
    const sus = GD.U.byId(room, parsed.callSuspectId);
    if (sus) parts.push(`號召集火${GD.U.tag(sus)}`);
    if (!parts.length) {
      const t = String(rawText || '').trim();
      return `${label} ${t.length > 26 ? t.slice(0, 26) + '…' : t || '過'}（無明確宣稱）`;
    }
    return `${label} ${parts.join('；')}`;
  }

  GD.Claims = { parse, parseRecord, summarize, mentions, parsePublicCandidateSets, parsePublicInspectionReports,
    parseRoleComparisons, parseHistoricalVoteStances, parseCountConstraints, parsePositionClaims, EVIL_ROLES };
})(window.GD);
