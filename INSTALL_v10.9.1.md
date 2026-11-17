# v10.9.1 安裝與驗收

1. 先備份目前網站資料夾與 Firebase 設定。
2. 解壓 `gudong_v10.9.1_full_strategy_update_candidate.zip`，以解壓後的完整目錄覆蓋測試環境；不要只挑選 `js/` 的部分檔案更新。
3. 確認 `index.html` 顯示 v10.9.1，遊戲可正常建立房間與開始對局。
4. 在專案根目錄執行 `node tests/run-v10-9.1-all-regressions.js`，應顯示 68/68 PASS。
5. 先以測試環境進行真人完整三輪對局，再決定是否部署到 GitHub Pages。

本候選版沒有更動 `js/core/rules.js`，也沒有更動 Firebase 專案設定或 Cloudflare Worker 設定；不要以本機測試通過取代線上端到端驗收。
