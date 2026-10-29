# `tests/trace_genes.js` — 因果鏈稽核加強版

## 用途

這個版本將「策略函式讀取的基因值」附加到同一決策紀錄上，並只對同環境下實際發生決策分歧的案例列印完整軌跡：

1. 訓練局 `Learning.finalize()` 前後的指定基因值。
2. 出廠組與學習組在 `Engine.start()` 後載入的基因值及完整快照比對。
3. 分歧決策對應的策略 stage／回合中，Proxy 實際捕捉到的指定基因讀取值。
4. 同一決策索引上的出廠決策與學習後決策內容。
5. 對所有分歧案例分別重跑 factory A/A 與 learned A/A，確認相同處理與相同種子可重現。

## 放置與執行

將本檔複製到專案 `tests/` 並命名為 `trace_genes.js`，與 `tests/harness.js` 放在同一層；在專案根目錄執行：

```bash
node tests/trace_genes.js
node tests/trace_genes.js 水豚 120 40 deception
```

參數依序是 Bot 名稱、訓練種子搜尋上限、候選評估種子數、欲追蹤的基因欄位。

輸出完整 JSON 報告（PowerShell）：

```powershell
$env:TRACE_GENES_REPORT_PATH = "$PWD\trace-genes-report.json"
node tests/trace_genes.js 水豚 120 40 deception
```

## 重要判讀

- 報告只會把「同一環境下，實際決策內容不同」計入分歧。
- 每個分歧案例都會獨立列出不同模式載入的數值，以及**分歧決策本身**的同 stage／round 基因讀取。若該決策函式沒有讀到目標基因，報告會明確標示，避免把較早的讀取紀錄錯配到後面的決策差異。
- 這是因果鏈的診斷／PoC，不是效果大小或勝率改善的統計估計。
- 環境種子相同、角色／座位／真偽配置一致是必要控制，但若策略共享一條消耗式 PRNG，前面決策造成的隨機數消耗差異仍可能影響後續決策；因此「同一決策函式內有讀取」是比全局讀取更強的對齊證據，但仍不等同於形式化因果證明。
- 本執行環境無法載入你的完整本機模組化遊戲專案，所以這裡只做了 `node --check` 語法檢查，尚未完成端到端遊戲測試。實際結果請以你本機的輸出為準。
