# Read-only compatibility report for gudong_online v10.6.3-derived projects.
# Run from the project root; this script does not modify game files.
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path (Join-Path $root 'js\config.js'))) {
    Write-Host '錯誤：請先在 gudongv10_6_2_work 專案根目錄執行。' -ForegroundColor Red
    exit 1
}
function Show-Pattern([string]$rel, [string]$pattern, [int]$before = 2, [int]$after = 5, [int]$maxMatches = 1) {
    $path = Join-Path $root $rel
    Write-Output "`n===== $rel | pattern: $pattern ====="
    if (-not (Test-Path -LiteralPath $path)) { Write-Output '[檔案不存在]'; return }
    $lines = Get-Content -LiteralPath $path
    $hits = @(Select-String -LiteralPath $path -Pattern $pattern | Select-Object -First $maxMatches)
    if ($hits.Count -eq 0) { Write-Output '[沒有匹配]'; return }
    $seen = @{}
    foreach ($hit in $hits) {
        $start = [Math]::Max(1, $hit.LineNumber - $before)
        $end = [Math]::Min($lines.Count, $hit.LineNumber + $after)
        if ($seen.ContainsKey("$start-$end")) { continue }
        $seen["$start-$end"] = $true
        Write-Output "--- lines $start-$end ---"
        for ($i = $start; $i -le $end; $i++) {
            Write-Output ('{0,5}: {1}' -f $i, $lines[$i - 1])
        }
    }
}
Write-Output '古董局中局相容性報告（唯讀；不會改動專案）'
Write-Output "專案：$root"
Show-Pattern 'js\config.js' 'VERSION\s*:' 0 2 1
Show-Pattern 'js\bot\dialogueBank.js' 'const\s+count\s*=\s*\(\)\s*=>' 2 4 1
Show-Pattern 'js\bot\dialogueBank.js' 'const\s+categories\s*=\s*\(\)\s*=>' 2 3 1
Show-Pattern 'js\bot\dialogueBank.js' 'function\s+fill\(' 2 4 1
Show-Pattern 'js\core\claims.js' 'blind:\s*false,\s*unsure:\s*false' 2 4 1
Show-Pattern 'js\core\claims.js' 'selfEvil|return\s+out;' 2 4 2
Show-Pattern 'js\bot\strategy.js' '\.sort\(\s*\(\s*a\s*,\s*b\s*\)' 2 5 2
Show-Pattern 'js\bot\mind.js' 'findHumanCall' 3 8 2
Show-Pattern 'js\bot\mind.js' 'source\s*!==' 2 5 2
Show-Pattern 'js\bot\speech.js' 'function\s+priorSpeeches|function\s+humanCalls' 2 6 2
Show-Pattern 'js\bot\speech.js' 'latestHumanCandidate' 3 6 1
Show-Pattern 'js\bot\speech.js' 'joinLength\(\)\s*>\s*420' 2 4 2
Show-Pattern 'js\bot\speech.js' 'latestHumanSpeech' 3 6 1
Show-Pattern 'js\bot\speech.js' 'function\s+compactHumanReply' 2 5 1
Show-Pattern 'js\bot\speech.js' 'source\s*===' 2 3 2
Show-Pattern 'js\core\engine.js' 'speechOrder' 2 5 2
Show-Pattern 'js\core\engine.js' 'passOrder' 2 5 2
Show-Pattern 'js\ui\home.js' 'DialogueBank|dialogueBank|台詞|台詞庫|count\(' 2 4 2
Write-Output "`n===== 報告結束 ====="
Write-Output '請將此視窗輸出的全部文字貼回聊天；若輸出太長，可先貼 dialogueBank、mind.js、speech.js 三段。'
