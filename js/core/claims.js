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
  const FAKE_RE = /(不是真|並非真|不真|贗品|假貨|假的|是假|避開|別投|不要投|別碰|假)/;
  const REAL_RE = /(不是假|並非假|真品|真的|是真|保真|很穩|沒問題|真)/;
  const CALL_RE = /(投|集火|集中|號召|落票|落在|押|籌碼|跟我|跟著我)/;
  const SUSPECT_RE = /(集火|一起投|投他|投她|票投|票給|抓|指認|鑑人|懷疑|揪出|就是)/;
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
                  blind: false, unsure: false, selfRole: null,
                  asked: [],          // 被質問者（「請某某說明一下」），對方在本輪稍後發言時應該回應
                  selfEvil: false };  // 發言者公開認壞（不一定報出具體角色）

    text.split(/[，。！？!?,；;\n]+/).forEach(clause => {
      if (!clause) return;
      if (/(被偷襲|眼前一片黑|一片黑)/.test(clause)) out.blind = true;
      if (/(驗不到|看不懂|無法辨別|沒看到|看不到|沒驗到)/.test(clause)) out.unsure = true;

      /* --- 獸首宣稱與落票號召 --- */
      const tags = [...clause.matchAll(TAG_RE)].map(m => ({ beast: m[1] || m[2], s: m.index, e: m.index + m[0].length }));
      tags.forEach((t, i) => {
        if (!valid.has(t.beast)) return;
        // 引用他人宣稱（「藍色【宗彥】在第三位說【鼠】是假」）不算發言者自己的宣稱
        const before = clause.slice(0, t.s);
        if (QUOTE_RE.test(before) && mentions(before, room).length > 0) return;
        const suffix = clause.slice(t.e, i + 1 < tags.length ? tags[i + 1].s : clause.length);
        const prefix = clause.slice(Math.max(i ? tags[i - 1].e : 0, t.s - 6), t.s);
        const scope = (FAKE_RE.test(suffix) || REAL_RE.test(suffix)) ? suffix : prefix + suffix;
        const fake = FAKE_RE.test(scope), real = !fake && REAL_RE.test(scope);
        if (fake || real) out.claims.push({ beast: t.beast, real });
        if (!fake && CALL_RE.test(clause)) {
          if (!out.callBeast) out.callBeast = t.beast;
          if (!out.callBeasts.includes(t.beast)) out.callBeasts.push(t.beast);
        }
      });

      /* --- 玩家指認 / 集火 / 方震陣營查驗 --- */
      const ps = mentions(clause, room);
      const selfRole = clause.match(/我是(?:【)?(老朝奉|藥不然|鄭國渠|許願|方震|姬雲浮|黃煙煙|木戶加奈)/);
      if (selfRole) out.selfRole = selfRole[1];
      if (/(我認壞|我是壞人|我們是壞人|我屬於壞人|我站壞人)/.test(clause)) out.selfEvil = true;
      if (ps.length === 1 && /請[^，。！？]{0,16}(說明|解釋|交代)/.test(clause) && !selfRole) out.asked.push(ps[0].id);
      if (ps.length === 1 && !selfRole) {
        const role = ALL_ROLES.find(r => clause.includes(r)) || null;
        if (role) out.accuse.push({ playerId: ps[0].id, role });
        if (SUSPECT_RE.test(clause)) out.callSuspectId = ps[0].id;
        const camp = clause.match(/(查驗|驗過|驗了).*(好人|壞人|老朝奉陣營|許願陣營)/);
        if (camp) out.campChecks.push({ targetId: ps[0].id, camp: /壞人|老朝奉陣營/.test(camp[2]) ? 'evil' : 'good' });
      }
    });
    return out;
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

  GD.Claims = { parse, summarize, mentions, EVIL_ROLES };
})(window.GD);
