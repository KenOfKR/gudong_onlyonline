# 古董局中局 v10.8.0 相容安裝包（依本機相容性報告修正）

這是針對 v10.6.3 本機專案的相容安裝器，不是完整專案 ZIP。它依據 `gudong_compat_report.txt` 已確認的實際程式碼修正兩個已知問題：

1. 台詞庫的 `count`、`categories` 是箭頭函式，不再要求 `function count()`。
2. v10.8.0 的前手回應邏輯已由較早的區段替換；移除後段重複套用、但會找不到舊區塊的補丁。
3. 公開發言索引改用所有玩家的公開號召，不再以 `source === 'human'` 過濾；跨輪延續也改用最近一位公開發言者。

## 套用前提

- `js/config.js` 版本必須是 `10.6.3`。
- 請先關閉遊戲頁面及本機伺服器。
- 安裝器會先在記憶體中比對全部修改錨點、檢查 JavaScript 語法，再建立 `*.v10.8.0-prepatch.bak` 備份並寫檔。任何比對或語法檢查失敗時，會在寫入前一次列出所有已偵測到的不相符項目，然後中止而不寫入專案檔案。
- 我無法直接讀取你的本機整份專案，所以此安裝包已根據報告修正已知不相容點，但尚未在你的實際工作目錄完成整合測試。執行時若安裝器中止，請保留完整錯誤訊息，不要移除檢查或強制覆蓋。

## 安裝方式

把 `install_v10_8_0_strategy_information_compat.js` 與本檔放在專案資料夾的上一層，例如 `新增資料夾 (6)`，再於該層 PowerShell 執行：

```powershell
$project = "C:\Users\9800X3D\Desktop\線上版古董檔案\新增資料夾 (6)\gudongv10_6_2_work"
node ".\install_v10_8_0_strategy_information_compat.js" "$project"
```

## 安裝後測試

```powershell
Set-Location $project
node --check .\js\config.js
node --check .\js\core\claims.js
node --check .\js\bot\dialogueBank.js
node --check .\js\bot\mind.js
node --check .\js\bot\speech.js
node --check .\js\bot\strategy.js
node --check .\js\main.js
node --check .\tests\v10-8-strategic-info-smoke.js
node .\tests\v10-8-strategic-info-smoke.js
node .\tests\conversation-continuity-smoke.js
node .\tests\tactics-smoke.js
```

預期驗證內容包括：尾家左側的第一位發言規則、資訊準確度與陣營分數分離、所有公開發言使用一致的來源中立邏輯，以及台詞庫實際數量為 1,068 條、49 個類別。這些回歸測試通過後，仍應用本機伺服器開一場新遊戲做整合測試。
