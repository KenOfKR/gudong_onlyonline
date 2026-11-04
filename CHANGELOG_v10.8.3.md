# 古董局中局 v10.8.3 — 真人指控、反轉時序與 Gemini 備援修正版

## P0：真人發言解析
- 修正第一人稱「我認為／我懷疑」被誤判為第三人稱轉述，導致整段自有指控遭忽略。
- 新增獨立 `roleClaims`，記錄 `claim`、`deny`、`fake` 三種角色關係；玩家名字與角色名重疊時，按句法位置及明確玩家標籤解析。
- 支援「A不是老朝奉，他應該是鄭國渠」的代名詞承接，以及「老朝奉可能是B」的角色先行句。
- 否定特定角色只降低該角色可能性，不得推論為好人；「假冒某角色」也不會被摘要成「玩家就是該角色」。
- `mind.js` 依角色關係極性分開處理正面指控、角色排除與假冒指控。

## P0：許願反轉時序
- `Rules.inspect()` 的 `flipped:true` 是老朝奉擾亂已反轉該好人查驗的明確紀錄。
- 好人（姬雲浮免疫）可由自身 `flipped:true` 紀錄直接建立該輪前置玩家候選池；許願兩筆以上同輪反轉只建立一個該輪候選池，不虛增獨立樣本數。
- 若同輪同時存在公開宣稱矛盾，交集計算優先使用已確認的私密時序窗口，不讓可能說謊的公開發言縮窄確定候選範圍。

## P1：公開討論
- `latestPublicThread()` 會保留尚未被回答的角色關係指控，即使其後出現中性 BOT 發言。
- Gemini Prompt、本地備援發言、公開回應稽核與摘要都保留每一個「玩家—角色—極性」關係，不只回應第一個被點名者或獸首真假。

## P2：Gemini fallback
- 模型順序：`gemini-3.8-flash` → `gemini-3.5-flash-lite` → `gemini-3.6-flash` → `gemini-2.5-flash`。
- 429 不會立刻終止整次生成；會依序嘗試下一個模型，所有模型都失敗後才套用最長 Retry-After 冷卻。
- 所有模型收到完全相同的完整 Prompt 與 generation options，不因 fallback 刪除對局上下文。
- 全部失敗時仍回傳 `null`，由 `driver.js` 使用 `Speech.localSpeech()`；本地備援同樣經過真人角色指控回應稽核。

## 回歸測試
- `node tests/human-claim-role-flip-regression.js`
- `node tests/gemini-fallback-smoke.js`
- `node tests/public-speech-attribution-smoke.js`
- `node tests/player-reasoning-regression-smoke.js`
- `node tests/conversation-continuity-smoke.js`
- `node tests/v10-8-3-reasoning-smoke.js`
- `node tests/v10-8-public-roleplay-smoke.js`
- `node tests/v10-8-strategic-info-smoke.js`
- `node tests/tactics-smoke.js`
- `node tests/vote-policy-smoke.js`
- `node tests/abstain-policy-smoke.js`
- `node tests/ui-smoke.js`

本版測試通過不等於勝率必然提升；仍需使用固定種子做成對模擬，並以真人實戰紀錄驗證回應品質。
