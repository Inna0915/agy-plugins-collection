#Requires -Version 7
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$scriptRoot = Split-Path -Parent $PSScriptRoot
$dispatcher = Join-Path $scriptRoot 'Invoke-CodexTask.ps1'
$fixture = Join-Path $PSScriptRoot 'Fake-Codex.ps1'
$scratch = Join-Path (Resolve-Path -LiteralPath $ScratchRoot).Path ('.test-run-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $scratch '中文 项目'
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[object]]::new()
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Start-TestRun([string]$Name, [string]$Prompt, [string[]]$ExtraArguments = @(), [string]$TargetProject = '') {
    $proj = if ($TargetProject) { $TargetProject } else { $project }
    $promptFile = Join-Path $scratch "$Name-$([guid]::NewGuid().ToString('N').Substring(0,6)).md"
    Set-Content -LiteralPath $promptFile -Value $Prompt -NoNewline -Encoding utf8
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in (@('-NoLogo', '-NoProfile', '-File', $dispatcher, '-Task', $Name,
                '-Project', $proj, '-PromptFile', $promptFile, '-CodexPath', $fixture,
                '-SkipGitRepoCheck') + $ExtraArguments)) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::Start($start)
    $ownedProcesses.Add($process)
    return @{ Process = $process; Output = $process.StandardOutput.ReadToEndAsync()
        Error = $process.StandardError.ReadToEndAsync(); Name = $Name; Project = $proj }
}
function Complete-TestRun($Run) {
    if (-not $Run.Process.WaitForExit(30000)) { throw "测试超时：$($Run.Name)" }
    if (-not $Run.Output.Wait(5000) -or -not $Run.Error.Wait(5000)) { throw 'Test output pipes did not close.' }
    $statusFile = Get-ChildItem -LiteralPath (Join-Path $Run.Project "work\alpha\logs\$($Run.Name)") -Filter '*.status.json' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $statusFile) { throw "没有状态文件：$($Run.Error.Result) $($Run.Output.Result)" }
    $status = Get-Content -LiteralPath $statusFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($Run.Process.ExitCode -eq $status.exitCode) 'Dispatcher exit code differs from status.'
    Assert-True $status.cleanupVerified "Owned processes were not cleaned: $($status | ConvertTo-Json -Compress -Depth 5)"
    return $status
}
function Read-FakeInput([string]$Name, [string]$TargetProject = '') {
    $proj = if ($TargetProject) { $TargetProject } else { $project }
    Get-Content -LiteralPath (Join-Path $proj "work\alpha\logs\$Name\fake-input.json") -Raw -Encoding utf8 | ConvertFrom-Json
}
function Wait-ForChild([string]$Name, [string]$TargetProject = '') {
    $proj = if ($TargetProject) { $TargetProject } else { $project }
    $marker = Join-Path $proj "work\alpha\logs\$Name\fake-child.json"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 15) {
        if (Test-Path -LiteralPath $marker) {
            try { return Get-Content -LiteralPath $marker -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Child process was not started: $Name"
}
function Assert-ChildStopped($Child) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $process = Get-Process -Id $Child.pid -ErrorAction SilentlyContinue
        if (-not $process -or $process.StartTime.ToUniversalTime().ToString('o') -ne $Child.startedAt) { return }
        Start-Sleep -Milliseconds 100
    } while ($timer.Elapsed.TotalSeconds -lt 5)
    throw "Child process still alive: $($Child.pid)"
}
try {
    New-Item -ItemType Directory -Path $project -Force | Out-Null
    $longPrompt = ('中文内容 $literal `markdown` ' * 1800) + ' TEST_CHILD'
    $run = Start-TestRun 'success' $longPrompt @('-ReportStartup', '-Caller', 'Antigravity')
    $status = Complete-TestRun $run
    $errOut = $run.Error.GetAwaiter().GetResult()
    Assert-True ($status.state -eq 'finished') "Success failed: $($status.error)"
    Assert-True ($status.sessionId -match '^[0-9a-fA-F-]{36}$') 'Session ID was not parsed.'
    Assert-True ($status.caller -eq 'Antigravity') 'Caller was not recorded.'
    Assert-True ($errOut -match 'WORKER_STARTUP\s+\{') 'WORKER_STARTUP was not emitted on stderr.'
    Assert-True $status.turnCompleted 'Completed event was not parsed.'
    $input = Read-FakeInput 'success'
    Assert-True (-not ($input.arguments -contains '--model')) 'Model should inherit config.toml when omitted.'
    Assert-True (-not ($input.arguments -match '^model_reasoning_effort=')) 'Effort should inherit config.toml when omitted.'
    Assert-True ($input.arguments -contains 'notify=[]') 'Notify suppression missing.'
    Assert-True ($input.arguments -contains 'default_mode_request_user_input') 'Interactive user input disable missing.'
    Assert-True ($input.arguments -contains '--dangerously-bypass-approvals-and-sandbox') 'Full access default was not explicit.'
    Assert-True ($input.prompt.StartsWith('【Antigravity → Codex 交接】')) 'Caller header was not applied.'
    Assert-True ($input.prompt.Contains('任务类型：实现（implement）。')) 'TaskKind note was truncated or missing.'
    Assert-True ($input.prompt.Contains('先读取工作目录及涉及路径上适用的 AGENTS.md')) 'AGENTS.md instruction was truncated by interpolation.'
    Assert-True ($input.prompt.EndsWith($longPrompt)) 'Long Unicode stdin prompt was corrupted.'
    Assert-True ($input.cwd -eq $project) 'Working directory was corrupted.'
    Assert-ChildStopped (Wait-ForChild 'success')
    $results.Add(@{ name = 'new_session_unicode_config_inherit_startup_and_cleanup'; passed = $true })

    $run = Start-TestRun 'resume' '续接测试' @('-SessionId', $status.sessionId, '-Model', 'gpt-6.2-astra', '-Effort', 'xhigh', '-Mode', 'read-only', '-Fast')
    $resumed = Complete-TestRun $run
    $input = Read-FakeInput 'resume'
    Assert-True ($resumed.sessionId -eq $status.sessionId) 'Wrong resumed session ID.'
    Assert-True ([Array]::IndexOf($input.arguments, '-C') -lt [Array]::IndexOf($input.arguments, 'resume')) 'Wrong resume argument order.'
    Assert-True ($input.arguments -contains 'gpt-6.2-astra') 'Explicit model override lost.'
    Assert-True ($input.arguments -contains 'model_reasoning_effort="xhigh"') 'Resume lost explicit effort setting.'
    Assert-True ($input.arguments -contains 'sandbox_mode="read-only"') 'Resume lost permission setting.'
    Assert-True ($input.arguments -contains 'features.fast_mode=true') 'Fast feature was not enabled.'
    Assert-True ([Array]::IndexOf($input.arguments, 'service_tier="fast"') -gt [Array]::IndexOf($input.arguments, 'resume')) 'Fast override was placed before resume.'
    $results.Add(@{ name = 'resume_explicit_id_model_effort_permissions'; passed = $true })

    # Resume without -Mode must inherit previous read-only mode (no silent escalation back to yolo)
    $run = Start-TestRun 'resume-inherit' '继承只读权限' @('-SessionId', $status.sessionId)
    $inherited = Complete-TestRun $run
    $input = Read-FakeInput 'resume-inherit'
    Assert-True ($inherited.requestedMode -eq 'read-only') "Resume silently escalated mode to $($inherited.requestedMode)."
    Assert-True ($input.arguments -contains 'sandbox_mode="read-only"') 'Inherited read-only sandbox missing.'
    Assert-True ($input.arguments -contains 'gpt-6.2-astra') 'Inherited model override lost.'
    Assert-True ($input.arguments -contains 'model_reasoning_effort="xhigh"') 'Inherited effort override lost.'
    # Missing history resume without explicit -Mode must fail with unknown_resume_mode even for .ps1 launcher
    $unknownResume = Complete-TestRun (Start-TestRun 'unknown-resume' 'must fail' @('-SessionId', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))
    Assert-True ($unknownResume.exitCode -ne 0 -and $unknownResume.errorKind -eq 'unknown_resume_mode') 'Unknown PS1 resume did not fail with unknown_resume_mode.'
    $results.Add(@{ name = 'resume_inherits_readonly_mode_and_rejects_unknown_mode'; passed = $true })

    # TaskKind review/plan hard-locks read-only, rejects writable Mode, ExtraConfig permission overrides, and WorktreeMode required
    $badKind = Complete-TestRun (Start-TestRun 'review-bad-mode' 'must reject' @('-TaskKind', 'review', '-Mode', 'yolo'))
    Assert-True ($badKind.exitCode -ne 0 -and $badKind.errorKind -eq 'invalid_arguments') 'Review with yolo was not rejected.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $project 'work\alpha\logs\review-bad-mode\fake-input.json'))) 'Review with yolo still started Codex.'
    $badExtra = Complete-TestRun (Start-TestRun 'review-bad-extra' 'must reject' @('-TaskKind', 'review', '-ExtraConfig', 'sandbox_mode="danger-full-access"'))
    Assert-True ($badExtra.exitCode -ne 0 -and $badExtra.errorKind -eq 'invalid_arguments') 'ExtraConfig sandbox override on review was not rejected.'
    $badWtReq = Complete-TestRun (Start-TestRun 'review-bad-wt' 'must reject' @('-TaskKind', 'plan', '-WorktreeMode', 'required'))
    Assert-True ($badWtReq.exitCode -ne 0 -and $badWtReq.errorKind -eq 'invalid_arguments') 'WorktreeMode required on plan was not rejected.'

    # Structured handoff valid + prompt completeness + 3-state mutual exclusion + null rejection
    $okHandoff = Complete-TestRun (Start-TestRun 'structured-ok' 'review ok' @('-TaskKind', 'review', '-StructuredHandoff'))
    $okInput = Read-FakeInput 'structured-ok'
    Assert-True ($okHandoff.state -eq 'finished' -and $okHandoff.handoff.status -eq 'done') 'Valid structured handoff failed.'
    Assert-True ($okInput.prompt.Contains('严格按 --output-schema 约束的 JSON Schema')) 'Structured schema instruction was lost in prompt header.'
    Assert-True ($okInput.prompt.Contains('先读取工作目录及涉及路径上适用的 AGENTS.md')) 'AGENTS.md line was lost in structured review header.'
    $nullHandoff = Complete-TestRun (Start-TestRun 'structured-null' 'TEST_NULL_HANDOFF' @('-StructuredHandoff'))
    Assert-True ($nullHandoff.state -eq 'failed' -and $nullHandoff.errorKind -eq 'invalid_handoff') 'JSON null handoff was not rejected.'
    $doneWithQ = Complete-TestRun (Start-TestRun 'structured-done-q' 'TEST_DONE_WITH_QUESTIONS' @('-StructuredHandoff'))
    Assert-True ($doneWithQ.state -eq 'failed' -and $doneWithQ.errorKind -eq 'invalid_handoff') 'done with non-empty questions was not rejected.'
    $badHandoff = Complete-TestRun (Start-TestRun 'structured-bad' 'TEST_BAD_HANDOFF' @('-StructuredHandoff'))
    Assert-True ($badHandoff.state -eq 'failed' -and $badHandoff.errorKind -eq 'invalid_handoff') 'Empty questions needs_input was not rejected.'
    $badRoHandoff = Complete-TestRun (Start-TestRun 'structured-ro-bad' 'TEST_READONLY_CHANGED' @('-TaskKind', 'plan', '-StructuredHandoff'))
    Assert-True ($badRoHandoff.state -eq 'failed' -and $badRoHandoff.errorKind -eq 'invalid_handoff') 'Readonly changed_files was not rejected.'
    $results.Add(@{ name = 'task_kind_readonly_locks_and_strict_structured_handoff_validation'; passed = $true })

    # Reject exit 0 without turn.completed or with empty final report, plus active_writer classification
    $noComp = Complete-TestRun (Start-TestRun 'no-completed' 'TEST_NO_COMPLETED')
    Assert-True ($noComp.state -eq 'failed' -and $noComp.exitCode -ne 0) 'Exit 0 without turn.completed was accepted.'
    $emptyFinal = Complete-TestRun (Start-TestRun 'empty-final' 'TEST_EMPTY_FINAL')
    Assert-True ($emptyFinal.state -eq 'failed' -and $emptyFinal.exitCode -ne 0) 'Exit 0 with empty final report was accepted.'
    $aw = Complete-TestRun (Start-TestRun 'active-writer' 'TEST_ACTIVE_WRITER')
    Assert-True ($aw.state -eq 'failed' -and $aw.errorKind -eq 'active_writer') 'Active writer errorKind was not classified.'
    $results.Add(@{ name = 'incomplete_empty_report_and_active_writer_checks'; passed = $true })

    $run = Start-TestRun 'failure' 'TEST_FAIL TEST_CHILD'
    $failed = Complete-TestRun $run
    Assert-True ($failed.exitCode -eq 7 -and $failed.state -eq 'failed') 'CLI failure was not propagated.'
    Assert-ChildStopped (Wait-ForChild 'failure')
    $results.Add(@{ name = 'failure_exit_code_and_child_cleanup'; passed = $true })

    $run = Start-TestRun 'timeout' 'TEST_WAIT TEST_CHILD' @('-TimeoutSeconds', '8')
    $child = Wait-ForChild 'timeout'
    $timedOut = Complete-TestRun $run
    Assert-True ($timedOut.exitCode -eq 124 -and $timedOut.state -eq 'timed_out') 'Timeout was not propagated.'
    Assert-ChildStopped $child
    $results.Add(@{ name = 'timeout_and_child_cleanup'; passed = $true })

    $run = Start-TestRun 'forced-stop' 'TEST_WAIT TEST_CHILD'
    $child = Wait-ForChild 'forced-stop'
    $run.Process.Kill()
    $run.Process.WaitForExit(5000) | Out-Null
    Assert-ChildStopped $child
    Assert-True ($run.Output.Wait(5000) -and $run.Error.Wait(5000)) 'Forced stop left inherited pipes open.'
    $results.Add(@{ name = 'forced_dispatcher_stop_kills_job'; passed = $true })

    # First-round live session must hold resume mutex before publishing ID
    $liveFirst = Start-TestRun 'live-first' 'TEST_WAIT TEST_CHILD'
    $liveChild = Wait-ForChild 'live-first'
    $firstId = $null
    $tLock = [Diagnostics.Stopwatch]::StartNew()
    while ($tLock.Elapsed.TotalSeconds -lt 10 -and -not $firstId) {
        $sf = Get-ChildItem -LiteralPath (Join-Path $project 'work\alpha\logs\live-first') -Filter '*.status.json' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sf) {
            try { $st = Get-Content -LiteralPath $sf.FullName -Raw | ConvertFrom-Json; if ($st.sessionId) { $firstId = $st.sessionId } } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    Assert-True ([bool]$firstId) 'First-round sessionId was not published while running.'
    $firstContender = Start-TestRun 'live-first-contender' 'must not run' @('-SessionId', $firstId, '-Mode', 'yolo')
    Assert-True ($firstContender.Process.WaitForExit(15000) -and $firstContender.Process.ExitCode -ne 0) 'Concurrent resume during first round was allowed.'
    $liveFirst.Process.Kill()
    $liveFirst.Process.WaitForExit(5000) | Out-Null
    Assert-ChildStopped $liveChild

    $lockId = '12345678-1234-1234-1234-123456789abc'
    $run = Start-TestRun 'locked-owner' 'TEST_WAIT TEST_CHILD' @('-SessionId', $lockId, '-Mode', 'yolo')
    $child = Wait-ForChild 'locked-owner'
    $contender = Start-TestRun 'locked-contender' 'must not run' @('-SessionId', $lockId, '-Mode', 'yolo')
    Assert-True ($contender.Process.WaitForExit(15000)) 'Session lock contender hung.'
    Assert-True ($contender.Process.ExitCode -ne 0) 'Concurrent resume was allowed.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $project 'work\alpha\logs\locked-contender\fake-input.json'))) 'Concurrent session started Codex.'
    $run.Process.Kill()
    $run.Process.WaitForExit(5000) | Out-Null
    Assert-ChildStopped $child
    $results.Add(@{ name = 'first_round_and_explicit_concurrent_resume_rejected'; passed = $true })

    $dry = Start-TestRun 'dry-run' 'TEST_WAIT' @('-DryRun')
    Assert-True ($dry.Process.WaitForExit(15000)) 'Dry-run hung.'
    Assert-True ($dry.Process.ExitCode -eq 0) 'Dry-run failed.'
    $dryConfig = $dry.Output.GetAwaiter().GetResult() | ConvertFrom-Json
    Assert-True ($null -eq $dryConfig.model -and $dryConfig.modelSource -eq 'codex-config') 'Dry-run should inherit config.toml by default.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $project 'work\alpha\logs\dry-run'))) 'Dry-run created execution logs.'
    $results.Add(@{ name = 'dry_run_does_not_start_cli'; passed = $true })

    # Git single-repo worktree isolation, concurrent same-task worktree lock, in-place review seeing dirty file without mutating main tree
    $gitRepo = Join-Path $scratch 'single-git-repo'
    New-Item -ItemType Directory -Path $gitRepo -Force | Out-Null
    & git -C $gitRepo init -q
    & git -C $gitRepo config user.name 'test'
    & git -C $gitRepo config user.email 'test@example.com'
    Set-Content -LiteralPath (Join-Path $gitRepo 'README.md') -Value 'base' -NoNewline -Encoding utf8
    & git -C $gitRepo add README.md
    & git -C $gitRepo commit -q -m 'init'
    Set-Content -LiteralPath (Join-Path $gitRepo 'dirty-main.txt') -Value 'main-uncommitted' -NoNewline -Encoding utf8
    $wtPromptFile = Join-Path $scratch 'wt-prompt.md'
    Set-Content -LiteralPath $wtPromptFile -Value 'TEST_TOUCH_WORKTREE' -NoNewline -Encoding utf8
    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File $dispatcher -Task 'wt-feat' -Project $gitRepo -PromptFile $wtPromptFile -CodexPath $fixture | Out-Null
    $wtStatusFile = Get-ChildItem -LiteralPath (Join-Path $gitRepo 'work\alpha\logs\wt-feat') -Filter '*.status.json' | Select-Object -First 1
    $wtStatus = Get-Content -LiteralPath $wtStatusFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($wtStatus.worktree.used -eq $true -and $wtStatus.worktree.topology -eq 'single-repo') 'Single-repo worktree was not activated.'
    Assert-True ($wtStatus.cwd -ne $gitRepo) 'Worker ran in main repo instead of worktree.'
    Assert-True (Test-Path -LiteralPath (Join-Path $wtStatus.cwd 'worker-touched.txt')) 'Worker edit did not land in worktree.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $gitRepo 'worker-touched.txt'))) 'Worker edit leaked into main repo.'

    # Concurrent same-task worktree collision must be rejected cleanly
    $wtOwner = Start-TestRun 'wt-busy' 'TEST_WAIT TEST_CHILD' @() $gitRepo
    $wtBusyChild = Wait-ForChild 'wt-busy' $gitRepo
    $wtContender = Start-TestRun 'wt-busy' 'must not collide' @() $gitRepo
    Assert-True ($wtContender.Process.WaitForExit(15000) -and $wtContender.Process.ExitCode -ne 0) 'Concurrent same-task worktree collision was allowed.'
    $wtOwner.Process.Kill()
    $wtOwner.Process.WaitForExit(5000) | Out-Null
    Assert-ChildStopped $wtBusyChild
    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File (Join-Path $scriptRoot 'Remove-TaskWorktree.ps1') -Project $gitRepo -Task 'wt-busy' -DeleteBranch -Force | Out-Null

    # Resume with a different task label must still land back in the original session worktree
    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File $dispatcher -Task 'wt-feat-r2' -Project $gitRepo -PromptFile $wtPromptFile -CodexPath $fixture -SessionId $wtStatus.sessionId | Out-Null
    $r2StatusFile = Get-ChildItem -LiteralPath (Join-Path $gitRepo 'work\alpha\logs\wt-feat-r2') -Filter '*.status.json' | Select-Object -First 1
    $r2Status = Get-Content -LiteralPath $r2StatusFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($r2Status.cwd -eq $wtStatus.cwd) 'Session resume did not reuse original worktree.'

    # TaskKind review runs in-place, sees dirty-main.txt, and leaves main tree unmodified
    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File $dispatcher -Task 'ro-audit' -Project $gitRepo -PromptFile $wtPromptFile -CodexPath $fixture -TaskKind 'review' | Out-Null
    $roStatusFile = Get-ChildItem -LiteralPath (Join-Path $gitRepo 'work\alpha\logs\ro-audit') -Filter '*.status.json' | Select-Object -First 1
    $roStatus = Get-Content -LiteralPath $roStatusFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    $roFakeIn = Read-FakeInput 'ro-audit' $gitRepo
    Assert-True ($roStatus.worktree.used -eq $false -and $roStatus.cwd -eq $gitRepo -and $roStatus.requestedMode -eq 'read-only') 'Review task unexpectedly created worktree or lost read-only.'
    Assert-True ($roFakeIn.isReadOnly -eq $true -and $roFakeIn.dirtyMainSeen -eq $true) 'Review did not observe read-only flag or main tree uncommitted file.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $gitRepo 'worker-touched.txt'))) 'Main tree was mutated during read-only review.'

    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File (Join-Path $scriptRoot 'Remove-TaskWorktree.ps1') -Project $gitRepo -Task 'wt-feat' -DeleteBranch -Force | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $wtStatus.cwd)) 'Remove-TaskWorktree did not delete worktree.'
    $results.Add(@{ name = 'git_single_repo_worktree_isolation_lock_review_and_cleanup'; passed = $true })

    # Multi-repo umbrella workspace (like fms269 containing fms + fms-p269)
    $umbrella = Join-Path $scratch 'umbrella-ws'
    New-Item -ItemType Directory -Path $umbrella -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $umbrella 'AGENTS.md') -Value '# Umbrella rules' -NoNewline -Encoding utf8
    foreach ($subName in @('fms', 'fms-p269')) {
        $subDir = Join-Path $umbrella $subName
        New-Item -ItemType Directory -Path $subDir -Force | Out-Null
        & git -C $subDir init -q
        & git -C $subDir config user.name 'test'
        & git -C $subDir config user.email 'test@example.com'
        Set-Content -LiteralPath (Join-Path $subDir 'pom.xml') -Value "<project>$subName</project>" -NoNewline -Encoding utf8
        & git -C $subDir add pom.xml
        & git -C $subDir commit -q -m 'init'
    }
    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File $dispatcher -Task 'umb-task' -Project $umbrella -PromptFile $wtPromptFile -CodexPath $fixture -SkipGitRepoCheck | Out-Null
    $umbStatusFile = Get-ChildItem -LiteralPath (Join-Path $umbrella 'work\alpha\logs\umb-task') -Filter '*.status.json' | Select-Object -First 1
    $umbStatus = Get-Content -LiteralPath $umbStatusFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($umbStatus.worktree.used -eq $true -and $umbStatus.worktree.topology -eq 'umbrella-multi-repo') 'Umbrella worktree was not activated.'
    Assert-True ((Test-Path -LiteralPath (Join-Path $umbStatus.cwd 'AGENTS.md')) -and (Test-Path -LiteralPath (Join-Path $umbStatus.cwd 'fms\pom.xml')) -and (Test-Path -LiteralPath (Join-Path $umbStatus.cwd 'fms-p269\pom.xml'))) 'Umbrella child repos or AGENTS.md missing in worktree.'
    & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File (Join-Path $scriptRoot 'Remove-TaskWorktree.ps1') -Project $umbrella -Task 'umb-task' -DeleteBranch -Force | Out-Null
    $results.Add(@{ name = 'git_umbrella_multi_repo_worktree_isolation'; passed = $true })
} finally {
    foreach ($process in $ownedProcesses) {
        if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $scratch) {
        foreach ($marker in Get-ChildItem -LiteralPath $scratch -Filter fake-child.json -File -Recurse) {
            $child = Get-Content -LiteralPath $marker.FullName -Raw -Encoding utf8 | ConvertFrom-Json
            $process = Get-Process -Id $child.pid -ErrorAction SilentlyContinue
            if ($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $child.startedAt) {
                $process.Kill($true); $process.WaitForExit(5000) | Out-Null
            }
            Assert-ChildStopped $child
        }
        $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
        if (-not $resolvedScratch.StartsWith((Resolve-Path -LiteralPath $ScratchRoot).Path + '\.test-run-', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing cleanup outside the owned test directory.'
        }
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
    [ordered]@{ verifiedAt = (Get-Date).ToString('o'); liveModelCalled = $false
        tests = @($results.ToArray()); scratchRemoved = (-not (Test-Path -LiteralPath $scratch)) } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $scriptRoot '../references/offline-verification.json') -Encoding utf8
}
$results | ConvertTo-Json -Depth 4
