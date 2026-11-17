/* ============================================================================
 * voice.js — 語音輸入、公開字幕與語音指令辨識（Web Speech API）
 *
 * draft 模式：辨識完成後填入發言草稿，由玩家自行送出。
 * subtitle 模式：只同步已完成辨識的公開文字字幕，不傳送或保存原始音訊。
 * command 模式：將語音解析成待確認意圖；只有玩家確認後才呼叫既有 Engine 動作。
 *
 * 本模組不保證離線辨識；瀏覽器／平台需支援 SpeechRecognition。correct()、prepare()
 * 與 CommandInterceptor.parse() 為可測試的純解析入口。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const { U, Claims } = GD;

  /* 常見語音辨識誤聽 → 正確詞（角色名、生肖+真假、品相詞）*/
  const FIX = [
    [/(老潮風|老朝鳳|老嘲諷|老超風|老招風|老朝風|老曹奉|老朝奉奉)/g, '老朝奉'],
    [/(要不然|藥不燃|耀不然|要不藍|藥部然)/g, '藥不然'],
    [/(正國去|鄭國去|正國渠|鄭國曲|鄭國區|鄭國巨)/g, '鄭國渠'],
    [/(許院|許苑|許願望|徐願)/g, '許願'],
    [/(方正|方陣|方鎮|房震|芳震)/g, '方震'],
    [/(機雲浮|積雲浮|基雲浮|姬雲福|雞雲浮|吉雲浮)/g, '姬雲浮'],
    [/(黃煙|黃嫣嫣|黃煙烟|黃燕燕)(?!煙)/g, '黃煙煙'],
    [/(木戸加奈|木戶佳奈|木護加奈|目戶加奈|木戶嘉奈)/g, '木戶加奈'],
    [/(屬針|數真|鼠針|黍真|署真|輸真)/g, '鼠真'], [/(屬假|數假|鼠甲|暑假|輸假)/g, '鼠假'],
    [/(扭真|劉真|牛針)/g, '牛真'], [/(扭假|牛甲)/g, '牛假'],
    [/(苦真|虎針|琥真|護真)/g, '虎真'], [/(苦假|虎甲|護假)/g, '虎假'],
    [/(吐真|兔針|途真)/g, '兔真'], [/(吐假|兔甲)/g, '兔假'],
    [/(隆真|龍針|聾真)/g, '龍真'], [/(隆假|龍甲)/g, '龍假'],
    [/(舌真|蛇針|十真)/g, '蛇真'], [/(舌假|蛇甲)/g, '蛇假'],
    [/(碼真|馬針|麻真)/g, '馬真'], [/(碼假|馬甲|麻假)/g, '馬假'],
    [/(洋真|羊針|陽真|楊真)/g, '羊真'], [/(洋假|羊甲|陽假)/g, '羊假'],
    [/(侯真|猴針|喉真)/g, '猴真'], [/(侯假|猴甲)/g, '猴假'],
    [/(機真|雞針|基真|積真)/g, '雞真'], [/(機假|雞甲|基假)/g, '雞假'],
    [/(苟真|狗針|夠真)/g, '狗真'], [/(苟假|狗甲)/g, '狗假'],
    [/(珠真|豬針|朱真|租真)/g, '豬真'], [/(珠假|豬甲|朱假)/g, '豬假'],
    [/(真平|珍品|針品|正品)/g, '真品'], [/(燕品|驗品|厭品|贗平|贗頻)/g, '贗品']
  ];
  const FILLER = /(那個+|呃+|嗯+|啊+|欸+|然後+|其實+|基本上+|就是說+|我個人認為|我覺得)/g;
  const BEAST = '鼠牛虎兔龍蛇馬羊猴雞狗豬';

  /** 同音字校正 + 把裸露的「鼠真」補成「【鼠】真」。不會對已有【】的重複加括號 */
  function correct(raw) {
    let s = String(raw || '');
    FIX.forEach(([re, to]) => { s = s.replace(re, to); });
    s = s.replace(new RegExp(`(?<!【)([${BEAST}])(真品|贗品|真|假)(?!】)`, 'g'), '【$1】$2');
    return s;
  }

  /** 去贅字、補標點。純文字整理，不改變語意 */
  function tidy(s) {
    let t = correct(s).replace(FILLER, '').replace(/\s+/g, '，').replace(/[,，]{2,}/g, '，').replace(/^，|，$/g, '');
    if (t && !/[！!。？?]$/.test(t)) t += '！';
    return t;
  }

  /** 語音逐字稿 → {text, summary}。summary 用 Claims 解析，與電腦玩家讀到的是同一份理解 */
  function prepare(raw, room) {
    const text = tidy(raw);
    const parsed = Claims.parse(text, room);
    return { text, summary: Claims.summarize(parsed, '[真人]', room, text), parsed };
  }

  function resolveVoicePlayer(text, room) {
    const source = String(text || '');
    const players = room && Array.isArray(room.players) ? room.players.filter(p => p) : [];
    const found = players.filter(player => {
      const name = String(player.name || '').trim();
      if (name && (source.includes(`【${name}】`) || (name.length >= 2 && source.includes(name)))) return true;
      const color = (GD.SEAL_COLORS || []).find(item => item.id === player.colorId);
      return !!(color && (source.includes(color.name) || source.includes(`${color.short}色`)));
    });
    const unique = [...new Map(found.map(p => [String(p.id), p])).values()];
    return unique.length === 1 ? { player: unique[0] } : { player: null, ambiguous: unique.length > 1, candidates: unique };
  }

  // 語音只解析成待確認的意圖，不在辨識 callback 內直接操作遊戲狀態。
  function withIntentSchema(base, extra = {}) {
    const out = { ...base };
    const phaseVal = extra.phase || (base.type === 'inspect' || base.type === 'skill' || base.type === 'pass' ? 'playing' : base.type === 'vote' ? 'voting' : base.type === 'personVote' ? 'person_voting' : base.type === 'sendSpeech' || base.type === 'speechDraft' ? 'discussion' : null);
    const confReq = extra.confirmationRequired !== undefined ? extra.confirmationRequired : !['invalid', 'confirm', 'cancel', 'speechDraft'].includes(base.type);
    Object.defineProperties(out, {
      intent: { value: extra.intent || base.type || 'invalid', enumerable: false, configurable: true },
      target: { value: extra.target !== undefined ? extra.target : (base.targetId || null), enumerable: false, configurable: true },
      object: { value: extra.object !== undefined ? extra.object : (base.beast || base.kind || null), enumerable: false, configurable: true },
      amount: { value: extra.amount !== undefined ? extra.amount : null, enumerable: false, configurable: true },
      phase: { value: phaseVal, enumerable: false, configurable: true },
      confidence: { value: extra.confidence !== undefined ? extra.confidence : (base.type === 'invalid' ? 0 : 0.92), enumerable: false, configurable: true },
      requiredArguments: { value: extra.requiredArguments || [], enumerable: false, configurable: true },
      confirmationRequired: { value: confReq, enumerable: false, configurable: true }
    });
    return out;
  }
  function parseCommandRaw(raw, room, me, options = {}) {
    if (options && options.isRemoteTranscript) return { type: 'invalid', reason: '遠端玩家字幕不得觸發本機遊戲操作。' };
    if (options && options.sourcePlayerId && me && String(options.sourcePlayerId) !== String(me.id)) return { type: 'invalid', reason: '非本人語音不得觸發本機遊戲操作。' };
    const cleaned = correct(String(raw || '')).replace(/[，。！？!?、\s]/g, '').trim();
    const hasWake = /^(?:系統指令|語音指令|指令模式)/.test(cleaned);
    if (options && options.requireWakeWord && !hasWake) return { type: 'invalid', reason: '一般聊天模式不直接執行動作。' };
    const text = cleaned.replace(/^(?:系統指令|語音指令|指令模式)/, '');
    if (!text) return { type: 'invalid', reason: '沒有辨識到指令內容。' };
    if (/(確認執行|確定執行|執行指令|確認操作)$/.test(text)) return { type: 'confirm' };
    if (/(取消操作|取消指令|取消執行|不要執行)$/.test(text)) return { type: 'cancel' };
    if (/^(?:系統指令|指令模式)?(?:打出功能牌|使用功能牌|發動技能)$/.test(text)) {
      return { type: 'invalid', reason: '請說出具體技能，例如「發動擾亂」、「封鎖鼠」、「偷襲藍色玩家」或「查驗陣營藍色玩家」。' };
    }
    if (/^(?:送出發言|發布發言|送出陳詞)$/.test(text)) return { type: 'sendSpeech', label: '送出目前陳詞草稿' };

    const beastMatch = text.match(/[【]?([鼠牛虎兔龍蛇馬羊猴雞狗豬])[】]?/);
    const beast = beastMatch ? beastMatch[1] : null;

    const declaration = text.match(/(?:宣告|聲明|報)(?:【)?([鼠牛虎兔龍蛇馬羊猴雞狗豬])(?:】)?(?:是|為)?(真品|贗品|假品|真|假)/);
    if (/^(?:宣告|聲明|報)(?:真品|贗品|真|假)$/.test(text)) {
      return { type: 'invalid', reason: '宣告缺少獸首名稱。請說「宣告狗是真品」或「宣告鼠是贗品」。' };
    }
    if (declaration) {
      const real = /^(?:真品|真)$/.test(declaration[2]);
      return { type: 'speechDraft', text: `【${declaration[1]}】${real ? '真品' : '贗品'}。`, label: `將「【${declaration[1]}】${real ? '真品' : '贗品'}」加入陳詞草稿` };
    }
    if (/^(?:我驗不到|這輪驗不到|我看不到獸首)$/.test(text)) return { type: 'speechDraft', text: '我驗不到。', label: '將「我驗不到」加入陳詞草稿' };
    if (/^(?:我被偷襲|我遭到偷襲|我被襲擊)$/.test(text)) return { type: 'speechDraft', text: '我被偷襲。', label: '將「我被偷襲」加入陳詞草稿' };

    const inspect = text.match(/^(?:系統指令)?(?:鑑定|鑒定|查驗)(?:獸首)?(?:【)?([鼠牛虎兔龍蛇馬羊猴雞狗豬])(?:】)?$/);
    if (inspect) return { type: 'inspect', beast: inspect[1], label: `查驗【${inspect[1]}】` };

    if (/^(?:發動|啟動|打出)(?:老朝奉)?擾亂$/.test(text)) return { type: 'skill', kind: 'lao', label: '發動擾亂技能' };
    const block = text.match(/^(?:封鎖|封印)(?:獸首)?(?:【)?([鼠牛虎兔龍蛇馬羊猴雞狗豬])(?:】)?$/);
    if (block) return { type: 'skill', kind: 'zheng', beast: block[1], label: `封鎖【${block[1]}】` };

    const yaoPrefix = text.match(/^(?:偷襲|襲擊|攻擊)(.+)$/);
    if (yaoPrefix) {
      const found = resolveVoicePlayer(yaoPrefix[1], room);
      if (!found.player) return { type: 'invalid', reason: found.ambiguous ? '聽到多位可能的目標，請加上玩家顏色或完整姓名。' : '沒有辨識到偷襲目標，請說出顏色或玩家姓名。' };
      return { type: 'skill', kind: 'yao', targetId: found.player.id, label: `偷襲${found.player.name}` };
    }
    const fangPrefix = text.match(/^(?:查驗陣營|陣營查驗|檢查陣營)(.+)$/);
    if (fangPrefix) {
      const found = resolveVoicePlayer(fangPrefix[1], room);
      if (!found.player) return { type: 'invalid', reason: found.ambiguous ? '聽到多位可能的目標，請加上玩家顏色或完整姓名。' : '沒有辨識到陣營查驗目標，請說出顏色或玩家姓名。' };
      return { type: 'skill', kind: 'fang', targetId: found.player.id, label: `查驗${found.player.name}的陣營` };
    }
    const passPrefix = text.match(/^(?:傳牌給|傳遞給|把手機傳給|交給)(.+)$/);
    if (passPrefix) {
      const found = resolveVoicePlayer(passPrefix[1], room);
      if (!found.player) return { type: 'invalid', reason: found.ambiguous ? '聽到多位可能的接牌者，請加上顏色或完整姓名。' : '沒有辨識到接牌者，請說出顏色或玩家姓名。' };
      return { type: 'pass', targetId: found.player.id, label: `把手機傳給${found.player.name}` };
    }

    if (/^(?:棄票|不投票|這輪棄票)$/.test(text)) return { type: 'vote', ballot: {}, label: '本輪棄票' };
    const vote = text.match(/^(?:投票|投)(一|二|兩|三|四|1|2|3|4)?(?:票)?(?:給|到|向)?(?:【)?([鼠牛虎兔龍蛇馬羊猴雞狗豬])(?:】)?$/);
    if (vote) {
      const amountMap = { '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '1': 1, '2': 2, '3': 3, '4': 4 };
      const amount = amountMap[vote[1] || '一'];
      return { type: 'vote', ballot: { [vote[2]]: amount }, label: `投 ${amount} 票給【${vote[2]}】` };
    }
    const personVote = text.match(/^(?:鑑人指認|最終指認|指認|鑑人投給)(.+)$/);
    if (personVote) {
      const found = resolveVoicePlayer(personVote[1], room);
      if (!found.player) return { type: 'invalid', reason: found.ambiguous ? '有多位可能的指認對象，請加上顏色或完整姓名。' : '沒有辨識到指認對象，請說出顏色或完整姓名。' };
      return { type: 'personVote', targetId: found.player.id, label: `終局指認${found.player.name}` };
    }
    return { type: 'invalid', reason: '沒有辨識到可執行的遊戲指令。可說「鑑定狗」、「封鎖鼠」、「傳牌給藍色玩家」、「投兩票給狗」或「宣告狗是真品」。' };
  }

  /* ---------------------------------------------------------------- 收音控制（瀏覽器）*/
  const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  let rec = null, listening = false, finals = '', interim = '', wantStop = false, onDone = null;

  const emit = () => GD.bus.emit('voice', { listening, interim: (finals + interim).trim(), supported: !!SR });

  function ensure() {
    if (rec || !SR) return rec;
    rec = new SR();
    rec.lang = 'zh-TW';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = e => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += t; else interim += t;
      }
      emit();
    };
    rec.onerror = e => {
      const msg = { 'not-allowed': '麥克風權限被拒絕，請改用文字輸入或在瀏覽器允許麥克風', 'service-not-allowed': '此環境不允許語音辨識',
                    'no-speech': '沒有聽到聲音', 'audio-capture': '找不到麥克風', 'network': '語音辨識需要網路連線' }[e.error];
      if (msg) GD.bus.emit('voiceerror', msg);
    };
    rec.onend = () => {
      listening = false;
      const text = (finals + interim).trim();
      const finalText = finals.trim();
      const cb = onDone; onDone = null;
      finals = interim = '';
      emit();
      const requestedStop = wantStop;
      try {
        if (cb && requestedStop) cb(text, finalText); // 只有使用者主動停止才提交；意外中斷不送
      } finally {
        wantStop = false;
        GD.bus.emit('voiceend', { requestedStop });
      }
    };
    return rec;
  }

  function parseCommand(raw, room, me, options = {}) { return withIntentSchema(parseCommandRaw(raw, room, me, options)); }
  let currentProvider = 'web-speech', publicScope = true;
  function validateLocalWsUrl(url) { try { const u = new URL(url); return (u.protocol === 'ws:' || u.protocol === 'wss:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'); } catch (_) { return false; } }
  const CommandInterceptor = Object.freeze({ parse: parseCommand });

  const Voice = {
    supported: !!SR, correct, tidy, prepare, parseCommand, CommandInterceptor,
    getProvider: () => currentProvider,
    setProvider(p, opts = {}) { if (!['web-speech', 'transformers-whisper', 'local-ws'].includes(p)) return false; if (p === 'local-ws' && opts.wsUrl && !validateLocalWsUrl(opts.wsUrl)) return false; currentProvider = p; return true; },
    isPublicScope: () => publicScope,
    setPublicScope(f) { publicScope = !!f; return publicScope; },

    /** 按下：開始收音。done(text) 會在放開後、辨識完全結束時被呼叫一次 */
    start(done) {
      if (!ensure()) { GD.bus.emit('voiceerror', '此瀏覽器不支援語音辨識，請改用 Chrome / Edge / Safari 或文字輸入'); return false; }
      if (listening) return true;
      finals = interim = ''; wantStop = false; onDone = done;
      try { rec.start(); listening = true; emit(); return true; }
      catch (e) { GD.bus.emit('voiceerror', '麥克風啟動失敗，請稍後再試'); return false; }
    },
    /** 放開：結束收音並觸發 done */
    stop() {
      if (!rec || !listening) return;
      wantStop = true;
      try { rec.stop(); } catch (e) { /* ignore */ }
    },
    /** 取消：丟棄這次收音 */
    abort() {
      wantStop = false; onDone = null; finals = interim = '';
      if (rec && listening) { try { rec.abort(); } catch (e) { /* ignore */ } }
      listening = false; emit();
    },
    isListening: () => listening
  };

  /* ---------------------------------------------------------------- TTS 播報 */
  Voice.speak = function (text) {
    if (typeof window === 'undefined' || !window.speechSynthesis || GD.store.get(GD.CONFIG.STORAGE.tts, true) === false) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/[【】]/g, ''));
      u.lang = 'zh-TW'; u.rate = 1.08;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  };

  GD.Voice = Voice;
  GD.VoiceManager = Voice;
})(window.GD);
