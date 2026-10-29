# trace_genes.js v3 — 基因生命週期因果鏈稽核

## 這版修正

1. **邏輯身分正規化**：將 `plan.fakeFangClaim.targetId` 從每次對局動態產生的 `player.id` 映射為穩定的 `bot:<botId>` 或 `human:<name>`，避免 `U.uid()` 的時間戳／隨機尾碼造成假分歧。這只改變測試摘要的比較表示，不修改正式遊戲程式碼，也不改變 PRNG。
2. **A/A 覆蓋全部有效配對案例**：不再只重跑仍被認定為分歧的案例，因此即使正規化後案例不再算分歧，仍會被重新驗證。
3. **A/A 首個差異診斷**：若重跑仍失敗，依序檢查 environment、decision、gene reads、genes-at-start，輸出第一個差異類別、JSON 路徑與左右值。
4. **保留行為證據分級**：只有同一決策階段有目標基因讀取紀錄時，才標記為與基因讀取對齊；沒有直接讀取的分歧仍只算探索性觀察。

## 安裝

把此檔案放進專案的 `tests` 資料夾，檔名為 `trace_genes.js`，覆蓋舊版。請先保留舊版備份。

## 執行

在專案根目錄執行：

```bash
node tests/trace_genes.js 水豚 120 40 deception
```

可選擇將完整結果寫成 JSON：

PowerShell：

```powershell
$env:TRACE_GENES_REPORT_PATH = "$PWD\trace-genes-report.json"
node tests/trace_genes.js 水豚 120 40 deception
```

## 相容性與限制

- 本版已通過 `node --check` JavaScript 語法檢查。
- 尚未在使用者完整專案環境中完成端到端執行；首次執行結果才會確認本機 harness 與模組介面相容。
- 不更改 `U.uid()`、環境 PRNG 或正式核心邏輯；只把決策摘要中的動態玩家 ID 正規化為邏輯身份。若 A/A 仍失敗，請依輸出的首個差異路徑追查，而不是直接歸因於時間戳。
