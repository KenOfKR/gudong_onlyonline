# ASCII-only PowerShell script for Windows PowerShell 5.1 compatibility.
# Read-only: it scans source files and writes a UTF-8 BOM report outside the project.
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'js\config.js'))) {
    Write-Host 'ERROR: Run this script from the gudong project root (the folder containing js\config.js).' -ForegroundColor Red
    exit 1
}

$reportPath = Join-Path (Split-Path $root -Parent) 'gudong_compat_report.txt'
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('GUDONG SOURCE COMPATIBILITY REPORT (READ-ONLY)')
[void]$sb.AppendLine(('Project: ' + $root))
[void]$sb.AppendLine(('Created: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')))
[void]$sb.AppendLine('')

function Add-PatternContext {
    param(
        [string]$RelativePath,
        [string]$Pattern,
        [int]$Before = 2,
        [int]$After = 5,
        [int]$MaxMatches = 1
    )
    $path = Join-Path $root $RelativePath
    [void]$sb.AppendLine(('===== ' + $RelativePath + ' | /' + $Pattern + '/ ====='))
    if (-not (Test-Path -LiteralPath $path)) {
        [void]$sb.AppendLine('[FILE NOT FOUND]')
        [void]$sb.AppendLine('')
        return
    }
    $lines = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)
    $hits = @()
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ([System.Text.RegularExpressions.Regex]::IsMatch($lines[$i], $Pattern)) {
            $hits += $i
            if ($hits.Count -ge $MaxMatches) { break }
        }
    }
    if ($hits.Count -eq 0) {
        [void]$sb.AppendLine('[NO MATCH]')
        [void]$sb.AppendLine('')
        return
    }
    $seenRanges = @{}
    foreach ($hitIndex in $hits) {
        $start = [Math]::Max(0, $hitIndex - $Before)
        $end = [Math]::Min($lines.Length - 1, $hitIndex + $After)
        $rangeKey = "$start-$end"
        if ($seenRanges.ContainsKey($rangeKey)) { continue }
        $seenRanges[$rangeKey] = $true
        [void]$sb.AppendLine(('--- lines ' + ($start + 1) + '-' + ($end + 1) + ' ---'))
        for ($j = $start; $j -le $end; $j++) {
            [void]$sb.AppendLine(('{0,5}: {1}' -f ($j + 1), $lines[$j]))
        }
    }
    [void]$sb.AppendLine('')
}

Add-PatternContext 'js\config.js' 'VERSION\s*:' 0 2 1
Add-PatternContext 'js\bot\dialogueBank.js' 'const\s+count\s*=\s*\(\)\s*=>' 2 4 1
Add-PatternContext 'js\bot\dialogueBank.js' 'const\s+categories\s*=\s*\(\)\s*=>' 2 3 1
Add-PatternContext 'js\bot\dialogueBank.js' 'function\s+fill\(' 2 4 1
Add-PatternContext 'js\core\claims.js' 'blind\s*:' 2 4 1
Add-PatternContext 'js\core\claims.js' 'selfEvil|return\s+out\s*;' 2 4 2
Add-PatternContext 'js\bot\strategy.js' '\.sort\(' 2 5 2
Add-PatternContext 'js\bot\strategy.js' 'infoSkill|information|reveal|conceal|pass|utility|score' 2 4 3
Add-PatternContext 'js\bot\mind.js' 'findHumanCall' 3 8 2
Add-PatternContext 'js\bot\mind.js' 'source\s*!==|source\s*===' 2 5 3
Add-PatternContext 'js\bot\speech.js' 'function\s+priorSpeeches|function\s+humanCalls' 2 6 2
Add-PatternContext 'js\bot\speech.js' 'latestHumanCandidate' 3 6 1
Add-PatternContext 'js\bot\speech.js' 'joinLength\(\)\s*>\s*420' 2 4 2
Add-PatternContext 'js\bot\speech.js' 'latestHumanSpeech' 3 6 1
Add-PatternContext 'js\bot\speech.js' 'function\s+compactHumanReply|lastHuman' 2 5 3
Add-PatternContext 'js\bot\speech.js' 'source\s*===' 2 3 3
Add-PatternContext 'js\core\engine.js' 'speechOrder|passOrder' 2 5 3
Add-PatternContext 'js\ui\home.js' 'DialogueBank|dialogueBank|count\(' 2 4 2

[void]$sb.AppendLine('===== END OF REPORT =====')
[void]$sb.AppendLine('This script is read-only. Paste the report text back into the chat; do not send the project ZIP.')
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($reportPath, $sb.ToString(), $utf8Bom)
Write-Host 'Compatibility report created:' -ForegroundColor Green
Write-Host $reportPath
Write-Host 'Open the report in Notepad, then copy and paste its contents into the chat.'
