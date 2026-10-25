/* ============================================================================
 * config.js — 靜態設定與資料表（雙環境相容：Browser + Node.js）
 * ========================================================================== */
(function (root) {
  'use strict';
  // 確保在 Node.js (global) 或 瀏覽器 (window) 都能建立 GD 命名空間
  const GD = root.GD || (root.GD = {});

  GD.CONFIG = {
    VERSION: '9.0',
    PROXY_URL: 'https://gudong-proxy.gjack61112.workers.dev',
    GEMINI_MODELS: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    GEMINI_TIMEOUT_MS: 9000,
    GEMINI_COOLDOWN_MS: 20000,
    ROOM_COLLECTION: 'GudongOnlineGame',
    ROOM_PREFIX: 'v9_room_',
    ROOM_STALE_MS: 10 * 60 * 1000,
    LOBBY_REFRESH_MS: 30 * 1000,
    CHIPS_PER_ROUND: 2,
    WIN_SCORE: 6,
    BOT_DELAY_MS: { turn: 700, speech: 900, vote: 350 },
    SPEECH_SEND_DELAY_MS: 1800,
    STORAGE: {
      name: 'gudong_v9_name', room: 'gudong_v9_room_',
      genes: 'gudong_v9_bot_genes', useGemini: 'gudong_v9_use_gemini',
      tts: 'gudong_v9_tts'
    }
  };

  GD.FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDYjZgkYowjqDt0tidAF5sgLlLAdU7Jhxw',
    authDomain: 'gudong-787878.firebaseapp.com',
    projectId: 'gudong-787878',
    storageBucket: 'gudong-787878.firebasestorage.app',
    messagingSenderId: '294046765776',
    appId: '1:294046765776:web:e06dd1494009e6339784d5'
  };

  // ★ 實驗性演算法功能旗標：未達顯著標準前，主線預設全數關閉
  GD.FLAGS = {
    xuFingerprint: false, 
    xuCounter: false,     
    jointRoles: false     
  };

  GD.ZODIAC = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];

  GD.SEAL_COLORS = [
    { id: 'black',  name: '黑色', short: '黑', hex: '#171717', text: '#ffffff' },
    { id: 'red',    name: '紅色', short: '紅', hex: '#dc2626', text: '#ffffff' },
    { id: 'orange', name: '橘色', short: '橘', hex: '#ff8c00', text: '#171717' },
    { id: 'yellow', name: '黃色', short: '黃', hex: '#fde047', text: '#171717' },
    { id: 'green',  name: '綠色', short: '綠', hex: '#16a34a', text: '#ffffff' },
    { id: 'blue',   name: '藍色', short: '藍', hex: '#2563eb', text: '#ffffff' },
    { id: 'purple', name: '紫色', short: '紫', hex: '#9333ea', text: '#ffffff' },
    { id: 'white',  name: '白色', short: '白', hex: '#f8fafc', text: '#0f172a' }
  ];

  GD.ROLE_ORDER = ['許願', '方震', '姬雲浮', '黃煙煙', '木戶加奈', '老朝奉', '藥不然', '鄭國渠'];

  GD.ROLES = {
    '許願':   { camp: 'good', campText: '許願陣營（好人）', badge: '許家傳人', weapon: '每輪查驗 2 尊獸首', desc: '白字門許家後人，經營「四悔齋」小古董鋪。看似玩世不恭，實則深諳《素鼎錄》絕學，因父親遺留的佛頭謎局被捲入五脈與老朝奉的宿命爭端。' },
    '方震':   { camp: 'good', campText: '許願陣營（好人）', badge: '鐵血保鏢', weapon: '每輪查驗 1 人陣營', desc: '公安部指派保護許願的幹警，沉默寡言、警覺幹練。不懂古董鑑偽，卻精於洞察人心與危機防範，是許願一路探尋真相最信賴的後盾。' },
    '姬雲浮': { camp: 'good', campText: '許願陣營（好人）', badge: '鑑寶泰斗', weapon: '免疫老朝奉擾亂', desc: '許一城昔日摯友，海鶴居主人，學識淵博的古董界名宿。手握當年佛頭案的關鍵線索，為人剛正孤介，在暗流湧動中恪守鑑古初心。' },
    '黃煙煙': { camp: 'good', campText: '許願陣營（好人）', badge: '玄字千金', weapon: '隨機 1 輪無法查驗', desc: '五脈玄字門掌門黃克武的孫女，行事果斷幹練，外表冷艷內心剛烈。代表黃門隨行調查，在重重疑雲中全力守護五脈傳承與正道。' },
    '木戶加奈': { camp: 'good', campText: '許願陣營（好人）', badge: '東瀛歸客', weapon: '隨機 1 輪無法查驗', desc: '日本木戶家族繼承人，木戶有三的孫女。溫婉堅毅、精通文博，為查清祖父與許家的佛頭因緣遠赴中國，執意追尋歷史掩蓋的真相。' },
    '老朝奉': { camp: 'evil', campText: '老朝奉陣營（壞人）', badge: '造假首腦', weapon: '擾亂：反轉好人查驗', desc: '古董界神秘莫測的造假巨擘與地下組織魁首。數十年來隱於幕後操弄假古董黑產，設局滲透五脈，手段狠辣深沉，身分始終成謎。' },
    '藥不然': { camp: 'evil', campText: '老朝奉陣營（壞人）', badge: '藥家少主', weapon: '偷襲 1 人致盲', desc: '五脈玄字門兼紅字門藥來之孫，綽號「藥二爺」。看似風流倜儻、幽默機智，身懷西洋科學鑑寶絕技，實則背負家族隱秘走上險徑。' },
    '鄭國渠': { camp: 'evil', campText: '老朝奉陣營（壞人）', badge: '偽古心腹', weapon: '封鎖 1 尊獸首', desc: '老朝奉麾下的造假核心骨幹與執行爪牙。深諳江湖陰鷙手段與高仿作偽之術，隱匿於暗處替組織清掃障礙、混淆視聽。' }
  };

  GD.isGood = function (role) { return !!GD.ROLES[role] && GD.ROLES[role].camp === 'good'; };

  // Node.js 匯出支援
  if (typeof module !== 'undefined' && module.exports) module.exports = GD;
})(typeof window !== 'undefined' ? window : global);