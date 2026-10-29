古董局中局 — tests/trace_genes.js

用途
- 查核單局自然結算後，指定 Bot 的指定基因是否改變。
- 比對 Engine.start 下一局載入的基因是否等於 Learning.finalize 寫回的快照。
- 在策略流程中用 Proxy 記錄實際讀取指定基因的 stage、回合與數值。
- 對同一客觀環境種子，比較全出廠基因與「僅目標 Bot 換成學習後基因」的決策。
- 檢查相同種子、相同出廠狀態下的 A/A 可重現性。

放置位置
把 trace_genes.js 放入現有專案的 tests/ 資料夾，使它與 tests/harness.js、tests/sim.js 位於同一層。

執行（PowerShell / CMD 均可）
  node tests/trace_genes.js
  node tests/trace_genes.js 水豚 120 40 deception

參數依序為：Bot 名稱、搜尋訓練種子的上限、配對評估種子數、欲追蹤的基因欄位。
預設：水豚、80、40、deception。

輸出 JSON 報告（PowerShell）
  $env:TRACE_GENES_REPORT_PATH = "$PWD\trace-genes-report.json"
  node tests/trace_genes.js 水豚 120 40 deception

前提
- 使用與目前 tests/sim.js 相同的模組化專案與 tests/harness.js。
- harness 必須能載入 GD.Engine、GD.Strategy、GD.Speech、GD.Mind、GD.U、GD.Genes、GD.Learning、GD.Roster。
- 需有 U.withPRNG、GD.Roster.list、GD.Roster.baseGenes、GD.CONFIG.STORAGE.genes。
- 腳本不修改正式遊戲程式碼；它會在測試程序內暫時用 Proxy 包裝目標玩家的 genes 物件。

判讀提醒
- 查核點 1 的訓練種子是從指定上限中搜尋能改變所選基因的一局，這是診斷用案例，不是效益統計。
- 評估時僅替換目標 Bot 的學習後基因，其他 Bot 維持出廠基因，以減少混雜。
- 有讀取不代表該值一定改變了行為；有基因變動但單一種子下沒有行為分歧，也不能單獨證明基因無效。
- 若無法找到基因變動，請提高訓練種子上限或更換 geneKey。若 Proxy 沒捕捉到讀取，應檢查實際策略讀取路徑，而不是直接宣告通過。
- 本環境僅對腳本進行 node --check 語法檢查；尚未在使用者完整專案中執行端到端對局測試。
