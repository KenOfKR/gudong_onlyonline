/* ============================================================================
 * core/conversation.js — 公開語音字幕進入 AI 對話上下文的短暫投影
 *
 * voiceTranscripts 是獨立的公開字幕資料，不屬於正式輪流陳詞，不改 speechIndex /
 * speechOrder。AI 決策時才暫時合併成可解析的公開對話列，決策結束立即還原，避免
 * 將字幕寫回正式 speeches、影響輪次或造成重複計數。
 * ========================================================================== */
(function (root) {
  'use strict';
  const GD = root.GD || (root.GD = {});

  function projectRecord(message, room, round) {
    const player = (room.players || []).find(p => String(p.id) === String(message.playerId));
    if (!player || player.isBot || message.scope !== 'public' || message.isFinal !== true) return null;
    const text = String(message.text || '').trim();
    if (!text || text.length > 260) return null;
    let parsed = {};
    try {
      parsed = GD.Claims && GD.Claims.parse
        ? GD.Claims.parse(text, room, round, player.id)
        : {};
    } catch (_) {}
    return {
      playerId: player.id,
      speakerName: player.name,
      colorId: player.colorId,
      text,
      source: 'voice',
      voiceTranscript: true,
      voiceTranscriptId: String(message.id || ''),
      createdAt: Number(message.createdAt) || 0,
      summary: '公開語音字幕（非正式輪流陳詞）',
      p: parsed,
      time: ''
    };
  }

  const Conversation = {
    injectTemporary(room) {
      if (!room || !Array.isArray(room.rounds)) return () => {};
      const originals = [];
      room.rounds.forEach(round => {
        if (!round || !Array.isArray(round.voiceTranscripts) || !round.voiceTranscripts.length) return;
        const old = Array.isArray(round.speeches) ? round.speeches : [];
        const projected = round.voiceTranscripts.map(item => projectRecord(item, room, round)).filter(Boolean);
        if (!projected.length) return;
        const seen = new Set(old.filter(x => x && x.voiceTranscriptId).map(x => String(x.voiceTranscriptId)));
        const additions = projected.filter(x => x.voiceTranscriptId && !seen.has(x.voiceTranscriptId));
        if (!additions.length) return;
        originals.push({ round, speeches: round.speeches });
        const combined = old.concat(additions).map((item, index) => ({ item, index,
          time: Number(item && (item.createdAt || item.timestamp)) || 0 }));
        combined.sort((a, b) => {
          if (a.time && b.time) return a.time - b.time || a.index - b.index;
          if (a.time) return 1;
          if (b.time) return -1;
          return a.index - b.index;
        });
        round.speeches = combined.map(x => x.item);
      });
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        originals.forEach(entry => { entry.round.speeches = entry.speeches; });
      };
    }
  };

  GD.Conversation = Conversation;
  if (typeof module !== 'undefined' && module.exports) module.exports = Conversation;
})(typeof window !== 'undefined' ? window : global);
