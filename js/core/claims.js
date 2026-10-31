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
    const found = [];
    const push = p => { if (p && !found.includes(p)) found.push(p); };
    (room.players || []).forEach(p => {
      const sc = GD.U.colorOf(p);
      const bracket = `【${p.name}】`;
      if (text.includes(bracket) || (p.name.length >= 2 && text.includes(p.name))) push(p);
      else if (text.includes(sc.name)) push(p);
    });
    return found;
  }

  /** roundArg 省略時以目前回合的四尊獸首為白名單；覆盤舊發言時請傳入該回合 */
  function parse(rawText, room, roundArg) {
    const text = String(rawText || '');
    const round = roundArg || (room.rounds && room.rounds[room.currentRoundIdx]);
    const valid = new Set(round ? round.beasts.map(b => b.name) : GD.ZODIAC);
    const out = { claims: [], callBeast: null, callBeasts: [], callSuspectId: null, accuse: [], campChecks: [],
                  blind: false, unsure: false, selfRole: null, selfDefense: false, playerStances: [],
                  asked: [],          // 被質問者（「請某某說明一下」），對方在本輪稍後發言時應該回應
                  selfEvil: false };  // 發言者公開認壞（不一定報出具體角色）

    // 先以句號分段，再處理逗號／分號。分號常把「前手說了什麼」拆成多段，
    // 若每段各自解析，後面的「前手號召投【鼠】」就會錯算成目前發言者自己的票向。
    text.split(/[。！？!?\n]+/).forEach(sentence => {
      let attributionOpen = false;
      sentence.split(/[，、,；;]+/).forEach(clause => {
      if (!clause) return;
      const trimmedClause = clause.trim();
      const reportedLead = /^(?:前手|前一位|上一位|對方|該玩家|該人|原發言者|他(?:剛才|先前)?|她(?:剛才|先前)?|其主張)/.test(trimmedClause);
      const namedReportCue = mentions(clause, room).length > 0 &&
        /(?:原話|剛才(?:說|主張|表示|號召)|先前(?:說|主張|表示|號召)|曾(?:公開)?(?:說|主張|表示|號召)|說過|主張|表示|宣稱|指出|認為|提到|號召|希望大家投|建議大家投|呼籲大家投)/.test(clause);
      const tagQuoteCue = [...clause.matchAll(TAG_RE)].some(match => {
        const before = clause.slice(0, match.index);
        return mentions(before, room).length > 0 &&
          (QUOTE_RE.test(before) || /(?:說|宣稱|表示|認為|主張|提到|指出|原話|引用|轉述|號召|希望大家投|建議大家投).{0,20}$/.test(before) ||
            (/[「『“"]\s*$/.test(before) && /[」』”"]/.test(clause.slice(match.index + match[0].length))));
      });
      const ownSpeakerLead = /^(?:但|不過|可是|然而|另外|此外)?\s*(?:我|本人|我的)/.test(trimmedClause);
      const inheritedReport = attributionOpen && !ownSpeakerLead && (
        /^(?:前手|前一位|上一位|對方|該玩家|該人|原發言者|他|她|其主張)/.test(trimmedClause) ||
        /^(?:也|並且|而且|同時|另外|此外)\s*(?:號召|主張|認為|表示|宣稱|指出|投票|希望大家投|建議大家投|呼籲大家投)/.test(trimmedClause)
      );
      if (namedReportCue || tagQuoteCue || reportedLead || inheritedReport) {
        attributionOpen = true;
        return;
      }
      if (ownSpeakerLead) attributionOpen = false;
      if (/(被偷襲|眼前一片黑|一片黑)/.test(clause)) out.blind = true;
      if (/(驗不到|看不懂|無法辨別|沒看到|看不到|沒驗到)/.test(clause)) out.unsure = true;

      /* --- 獸首宣稱與落票號召 --- */
      const tags = [...clause.matchAll(TAG_RE)].map(m => ({ beast: m[1] || m[2], s: m.index, e: m.index + m[0].length }));
      tags.forEach((t, i) => {
        if (!valid.has(t.beast)) return;
        // 引用他人宣稱（「藍色【宗彥】在第三位說【鼠】是假」）不算發言者自己的宣稱
        const before = clause.slice(0, t.s);
        const citedPlayers = mentions(before, room);
        const attributedQuote = citedPlayers.length > 0 &&
          /(?:說|宣稱|表示|認為|主張|提到|指出|原話|引用|轉述).{0,16}$/.test(before);
        // 兼容「針對某人剛才的『【羊】是真品』」這種先開引號、沒有「說」字的引用句。
        const attributedQuotedSpan = citedPlayers.length > 0 &&
          /[「『“"]\s*$/.test(before) &&
          /[」』”"]/.test(clause.slice(t.s));
        if (citedPlayers.length > 0 &&
            (QUOTE_RE.test(before) || attributedQuote || attributedQuotedSpan)) return;
        const suffix = clause.slice(
  t.e,
  i + 1 < tags.length ? tags[i + 1].s : clause.length
);
const prefix = clause.slice(
  Math.max(i ? tags[i - 1].e : 0, t.s - 6),
  t.s
);

// 真假判斷優先使用獸首標籤後方的文字。
// 只有第一個獸首才允許參考前文，避免串用不同獸首的真假判斷。
const scope =
  FAKE_RE.test(suffix) || REAL_RE.test(suffix)
    ? suffix
    : (i === 0 ? prefix + suffix : suffix);

// 「不是假／並非假」是肯定真品，避免被其中的「假」字誤判。
const fakeScope = scope.replace(/不是假|並非假/g, '');
const fake = FAKE_RE.test(fakeScope);
const real = !fake && REAL_RE.test(scope);

if (fake || real) {
  out.claims.push({ beast: t.beast, real });
}

// 落票判斷只檢查獸首標籤前方的文字。
const callScope = prefix;

const deniedCall =
  /(不想(?:去)?投|不打算投|不準備投|不會投|不願(?:意)?投|不可能投|不投|別投|不要投|不想集火|不打算集火|不集火|別集火|不要集火|不跟|別跟|不要跟)/.test(callScope);
// 回顧過去的票數不能被當成本輪落票意圖，例如「第1輪我投了2票給【蛇】」。
// 若同一子句明確標示本輪／這輪／目前，則允許讀取其當前票向。
const historicalClause = /(?:第\s*\d+\s*輪|上輪|上一輪|前輪|前一輪|過去|先前|最近一次|後來公開|開票前|當時|歷史紀錄)/.test(clause) &&
  !/(?:本輪|這輪|這次|目前|現在|我這輪|我本輪)/.test(clause);

if (!deniedCall && !historicalClause && CALL_RE.test(callScope)) {
  if (!out.callBeast) out.callBeast = t.beast;
  if (!out.callBeasts.includes(t.beast)) {
    out.callBeasts.push(t.beast);
  }
}
      });

      /* --- 玩家指認 / 集火 / 方震陣營查驗 --- */
      const ps = mentions(clause, room);
      // 將人物陣營主張與獸首真偽分開解析，避免複合發言只留下獸首那一半。
      if (ps.length === 1) {
        const goodPhrase = /好人|許願陣營|善方/.test(clause);
        const evilPhrase = /壞人|老朝奉陣營|邪方/.test(clause);
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
        if (stanceCamp && !historicalQuote) {
          out.playerStances.push({ targetId: ps[0].id, camp: stanceCamp });
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
      if (ps.length === 1 && /請[^，。！？]{0,16}(說明|解釋|交代)/.test(clause) && !selfRole) out.asked.push(ps[0].id);
      if (ps.length === 1 && !selfRole) {
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
    // Repeating the same claim in one speech is not independent evidence.
    // Keep opposite truth values for the same beast so contradictions remain visible.
    const seenClaims = new Set();
    out.claims = out.claims.filter(c => {
      const key = JSON.stringify([c.beast, !!c.real]);
      if (seenClaims.has(key)) return false;
      seenClaims.add(key);
      return true;
    });
    const seenStances = new Set();
    out.playerStances = out.playerStances.filter(item => {
      const key = JSON.stringify([item.targetId, item.camp]);
      if (seenStances.has(key)) return false;
      seenStances.add(key);
      return true;
    });
    return out;
  }

  // Merge stored structured metadata with a fresh parse of the public text.
  // This repairs older/incomplete speech records where p exists but claims/calls/selfRole are empty.
  // Non-empty structured values remain authoritative; quoted claims are still filtered by parse().
  function parseRecord(sp, room, roundArg) {
    const structured = sp && sp.p && typeof sp.p === 'object' ? sp.p : {};
    const sourceText = String(sp && sp.text || '');
    let parsed = {};
    try { parsed = parse(sourceText, room, roundArg); } catch (_) {}
    if (!Object.keys(structured).length) return parsed;
    // 舊格式可能只把一段無法辨認的第一人稱票向存在 p；但只要原文有明確的前手／原話歸屬，
    // 即使當前發言者沒有自己的票向，也必須以文字解析結果為準，不能回退到被污染的 p。
    const hasReportedSpeech = /(?:原話|引用|轉述|前手|前一位|上一位|對方|該玩家|該人|原發言者|(?:他|她)(?:剛才|先前)?(?:說|主張|表示|號召)|(?:剛才|先前)(?:說|主張|表示|號召)|曾(?:公開)?(?:說|主張|表示|號召)|說過|(?:希望|建議|呼籲)大家投)/.test(sourceText);
    const list = key => Array.isArray(structured[key]) && structured[key].length
      ? structured[key]
      : (Array.isArray(parsed[key]) ? parsed[key] : []);
    return {
      ...parsed,
      ...structured,
      // claims/calls are always recalculated from visible text. In particular, an older p.callBeast
      // can contain a quoted previous speaker's call and must not override the corrected text parser.
      claims: (hasReportedSpeech || (parsed.claims || []).length)
        ? (parsed.claims || []) : list('claims'),
      callBeast: parsed.callBeast || (hasReportedSpeech ? null : structured.callBeast || null),
      callBeasts: (hasReportedSpeech || (parsed.callBeasts || []).length)
        ? (parsed.callBeasts || []) : list('callBeasts'),
      // 舊版本的 p.callSuspectId 可能把「請某人說明投票理由」誤存成集火。
      // 以原始公開台詞重新解析；不能讓過期的錯誤摘要／metadata 當作歷史證據。
      callSuspectId: parsed.callSuspectId || null,
      // accuse/selfRole are re-derived from the original public utterance. Older p metadata
      // may contain false positives from role-history descriptions; do not let it poison Mind.
      accuse: Array.isArray(parsed.accuse) ? parsed.accuse : [],
      campChecks: list('campChecks'),
      asked: list('asked'),
      selfRole: parsed.selfRole || null,
      selfEvil: !!structured.selfEvil || !!parsed.selfEvil,
      selfDefense: !!parsed.selfDefense,
      playerStances: parsed.playerStances || [],
      blind: !!structured.blind || !!parsed.blind,
      unsure: !!structured.unsure || !!parsed.unsure
    };
  }

  /** 例：[真人] 宣稱【鼠】真、【牛】假；號召投【鼠】；號召集火 藍色【宗彥】 */
  function summarize(parsed, label, room, rawText) {
    const parts = [];
    if (parsed.claims.length) parts.push('宣稱' + parsed.claims.map(c => `【${c.beast}】${c.real ? '真' : '假'}`).join('、'));
    if (parsed.selfEvil) parts.push('公開認壞');
    parsed.asked.forEach(id => { const p = GD.U.byId(room, id); if (p) parts.push(`質問${GD.U.tag(p)}`); });
    if (parsed.blind) parts.push('自稱遭偷襲');
    else if (parsed.unsure) parts.push('自稱驗不到');
    if (parsed.callBeasts.length) parts.push('號召投' + parsed.callBeasts.map(b => `【${b}】`).join(''));
    parsed.campChecks.forEach(c => {
      const p = GD.U.byId(room, c.targetId);
      if (p) parts.push(`方震式查驗：${GD.U.tag(p)}為${c.camp === 'evil' ? '壞人' : '好人'}`);
    });
    (parsed.playerStances || []).forEach(st => {
      const p = GD.U.byId(room, st.targetId);
      if (p) parts.push(`人物立場：${GD.U.tag(p)}被判為${st.camp === 'evil' ? '壞人' : '好人'}`);
    });
    if (parsed.selfDefense) parts.push('自辯：自稱好人／要求不要投票');
    parsed.accuse.forEach(a => {
      const p = GD.U.byId(room, a.playerId);
      if (p) parts.push(`指認${GD.U.tag(p)}為${a.role}`);
    });
    const sus = GD.U.byId(room, parsed.callSuspectId);
    if (sus) parts.push(`號召集火${GD.U.tag(sus)}`);
    if (!parts.length) {
      const t = String(rawText || '').trim();
      return `${label} ${t.length > 26 ? t.slice(0, 26) + '…' : t || '過'}（無明確宣稱）`;
    }
    return `${label} ${parts.join('；')}`;
  }

  GD.Claims = { parse, parseRecord, summarize, mentions, EVIL_ROLES };
})(window.GD);
