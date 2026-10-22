# 古董局中局 v9.0｜全智能語音博弈・自我進化版

## 怎麼開

- 直接雙擊 `index.html` 就能玩單人局(7 位電腦)。
- 角色圖、語音與 Firebase 在 `file://` 下可能受限,建議在本資料夾執行 `python -m http.server 8000`,再開 `http://localhost:8000`。
- 語音辨識需要 Chrome / Edge / Safari,且麥克風權限要允許。不支援時會自動改用打字。

## 目錄

```
index.html            頁面骨架(只放結構,沒有內嵌 JS/CSS)
css/style.css         全部樣式(不依賴 Tailwind CDN,離線可用)
assets/roles/         放角色圖 <角色名>.png,沒放就用內建 SVG
js/config.js          設定與常數(Proxy 位址、30 分鐘清理、角色資料)
js/roster.js          41 位電腦的人設與出廠基因
js/core/rules.js      規則:查驗判定、偷襲連動、開票、計分(純函式)
js/core/claims.js     發言解析與「重點摘要」
js/core/engine.js     狀態機,真人與電腦走同一套動作
js/bot/mind.js        PersuasiveMindEngine:證據累積 + 世界線貝氏推斷
js/bot/strategy.js    技能、傳遞、發言計畫、投票、鑑人
js/bot/speech.js      Gemini Prompt 組裝、本地備援發言、輸出驗證
js/bot/gemini.js      Proxy 串接(自動偵測路徑格式)
js/bot/driver.js      電腦自動行動(多人時只有房主代打)
js/bot/review.js      AI Deduction Mind-Map 覆盤資料
js/bot/learning.js    BotLearningEngine:評估表現並修正基因
js/bot/genes.js       基因存取(localStorage)
js/net.js             單人本機 / Firestore 連線、30 分鐘大廳清理
js/voice.js           按住說話、同音字校正、TTS
js/ui/*.js            首頁、牌桌、操作台、發言面板、終局面板
tests/                Node 模擬與量測腳本(不影響遊戲)
```

## 電腦的策略要點(2026-10-22 加入)

- 被偷襲:許願、方震一律不在發言說出來,其他好人預設不說(號召力高才說)。`strategy.js` 的 `shouldHideBlind`,`speech.js` 的 `validate` 會擋。
- 票型採人:每輪第二名真偽公開,累計 2 票以上投在公開贗品者會被點名請說明(每輪全場只問一次);被點名者下一次發言會回應,閃躲加嫌疑。
- 認壞:只有藥不然與鄭國渠可以,老朝奉不認(被抓會直接送分)。認壞時攤開自己真實的查驗給隊友,不得報出具體角色。壞人視角會把認壞者標為自己人,找許願 / 方震時排除。
- 位置學:第 1、2 輪壞人盡量讓同伴當尾家(下一輪首家);第六位控第八位尾家會被好人視為同隊,所以只在欺騙力夠高時冒險;第 3 輪反過來把好人推上尾家製造內訌。
- 覆盤每輪多一條「傳遞動機」,在決策當下寫入 `turnLogs[id].passWhy`。

## 調整電腦個性

- 出廠基因:`js/roster.js` 的 `STYLE_GENES`。
- 學習規則:`js/bot/learning.js` 的 `evaluate()`,每條調整都附理由字串。
- 重置進化:首頁右上 ⚙️ →「重置所有電腦基因」。

## 測試

```
node tests/sim.js 200          # 全電腦對局,檢查規則不變量、覆盤、學習寫入
node tests/ui-smoke.js         # 假 DOM 下以真人身分打完一局
node tests/gene-sweep.js 500   # 各項基因對勝負的影響
node tests/evolve-fixed.js 1500 # 學習開啟 vs 基因凍結
```
