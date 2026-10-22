/* ============================================================================
 * voice.js — 按住說話（Web Speech API）與語音後處理
 *
 *   按住「🎙️ 按住說話」→ 收音；放開 → 取得完整逐字稿 → 同音字校正 → 補上【】 →
 *   產生重點摘要 → 在 SPEECH_SEND_DELAY_MS 內可取消 → 自動發布到聊天欄。
 *
 * 瀏覽器需支援 SpeechRecognition（Chrome / Edge / Safari；Firefox 目前不支援），
 * 不支援或沒有麥克風權限時，介面會自動退回文字輸入，不影響遊戲進行。
 * correct() 與 prepare() 是純函式，可在 Node 測試。
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
      const cb = onDone; onDone = null;
      finals = interim = '';
      emit();
      if (cb && wantStop) cb(text);          // 只有「使用者放開按鈕」才會送出；意外中斷不送
      wantStop = false;
    };
    return rec;
  }

  const Voice = {
    supported: !!SR, correct, tidy, prepare,

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
})(window.GD);
