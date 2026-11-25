#Requires -Version 7
# Offline test double; never calls a model or reads authentication files.
$CliArgs = @($args)
$ErrorActionPreference = 'Stop'
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$prompt = [Console]::In.ReadToEnd()
$finalIndex = [Array]::IndexOf($CliArgs, '-o')
$finalPath = $CliArgs[$finalIndex + 1]
$markerRoot = Split-Path -Parent $finalPath
$isReadOnly = $CliArgs -contains 'sandbox_mode="read-only"'
$dirtySeen = Test-Path -LiteralPath (Join-Path (Get-Location).Path 'dirty-main.txt')
@{ arguments = $CliArgs; prompt = $prompt; cwd = (Get-Location).Path; isReadOnly = $isReadOnly; dirtyMainSeen = $dirtySeen } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $markerRoot 'fake-input.json') -Encoding utf8
if ($prompt.Contains('TEST_TOUCH_WORKTREE') -and -not $isReadOnly) {
    Set-Content -LiteralPath (Join-Path (Get-Location).Path 'worker-touched.txt') -Value 'codex-touched' -NoNewline -Encoding utf8
}
$resumeIndex = [Array]::IndexOf($CliArgs, 'resume')
$threadId = if ($resumeIndex -ge 0) { $CliArgs[$resumeIndex + 1] } else { [guid]::NewGuid().ToString() }
@{ type = 'thread.started'; thread_id = $threadId } | ConvertTo-Json -Compress
if ($prompt.Contains('TEST_CHILD')) {
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    foreach ($argument in @('-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 120')) {
        $start.ArgumentList.Add($argument)
    }
    $child = [Diagnostics.Process]::Start($start)
    @{ pid = $child.Id; startedAt = $child.StartTime.ToUniversalTime().ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $markerRoot 'fake-child.json') -Encoding utf8
    $child.Dispose()
}
if ($prompt.Contains('TEST_WAIT')) { Start-Sleep -Seconds 120 }
if ($prompt.Contains('TEST_ACTIVE_WRITER')) {
    [Console]::Error.WriteLine('error: thread already has an active writer')
    exit 1
}
if ($prompt.Contains('TEST_FAIL')) {
    [Console]::Error.WriteLine('Simulated CLI failure')
    exit 7
}
if ($prompt.Contains('TEST_EMPTY_FINAL')) {
    [IO.File]::WriteAllText($finalPath, '', $utf8NoBom)
    @{ type = 'turn.completed'; usage = @{ input_tokens = 0; output_tokens = 0 } } | ConvertTo-Json -Compress
    exit 0
}
if ($prompt.Contains('TEST_NO_COMPLETED')) {
    Set-Content -LiteralPath $finalPath -Value '无终止事件的报告' -Encoding utf8
    exit 0
}
$schemaIndex = [Array]::IndexOf($CliArgs, '--output-schema')
if ($schemaIndex -ge 0) {
    if ($prompt.Contains('TEST_NULL_HANDOFF')) {
        [IO.File]::WriteAllText($finalPath, 'null', $utf8NoBom)
    } elseif ($prompt.Contains('TEST_DONE_WITH_QUESTIONS')) {
        $payload = [ordered]@{
            status = 'done'; summary = 'done with stray question'; root_cause = $null
            changed_files = @(); guards_and_fallbacks = @(); verification = @()
            assumptions = @(); design_concerns = @(); unverified_gaps = @()
            questions = @(@{ question = 'q'; facts_found = 'f'; recommended_option = 'a'; alternatives = @('b') })
            permission_request = $null
        }
        [IO.File]::WriteAllText($finalPath, ($payload | ConvertTo-Json -Depth 6), $utf8NoBom)
    } elseif ($prompt.Contains('TEST_BAD_HANDOFF')) {
        $payload = [ordered]@{
            status = 'needs_input'; summary = 'blocked'; root_cause = $null
            changed_files = @(); guards_and_fallbacks = @(); verification = @()
            assumptions = @(); design_concerns = @(); unverified_gaps = @()
            questions = @(); permission_request = $null
        }
        [IO.File]::WriteAllText($finalPath, ($payload | ConvertTo-Json -Depth 6), $utf8NoBom)
    } elseif ($prompt.Contains('TEST_READONLY_CHANGED')) {
        $payload = [ordered]@{
            status = 'done'; summary = 'reviewed'; root_cause = $null
            changed_files = @(@{ path = 'a.txt'; change = 'edited' }); guards_and_fallbacks = @(); verification = @()
            assumptions = @(); design_concerns = @(); unverified_gaps = @()
            questions = @(); permission_request = $null
        }
        [IO.File]::WriteAllText($finalPath, ($payload | ConvertTo-Json -Depth 6), $utf8NoBom)
    } else {
        $payload = [ordered]@{
            status = 'done'; summary = '结构化模拟完成'; root_cause = $null
            changed_files = @(); guards_and_fallbacks = @(); verification = @()
            assumptions = @(); design_concerns = @(); unverified_gaps = @()
            questions = @(); permission_request = $null
        }
        [IO.File]::WriteAllText($finalPath, ($payload | ConvertTo-Json -Depth 6), $utf8NoBom)
    }
} else {
    Set-Content -LiteralPath $finalPath -Value '模拟完成：中文路径和提示词正常。' -Encoding utf8
}
@{ type = 'turn.completed'; usage = @{ input_tokens = 0; output_tokens = 0 } } | ConvertTo-Json -Compress
exit 0
