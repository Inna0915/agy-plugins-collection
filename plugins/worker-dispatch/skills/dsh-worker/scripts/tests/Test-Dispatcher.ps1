#Requires -Version 7
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path (Resolve-Path -LiteralPath $ScratchRoot).Path ('offline-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $scratch '中文 项目'
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[object]]::new()
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Step([string]$Name) { [Console]::Error.WriteLine("$(Get-Date -Format 'HH:mm:ss') [DSH-TEST] $Name") }
function Start-Run([string]$Name, [string]$Prompt, [string[]]$Extra = @(), [string]$TargetProject = '') {
    $proj = if ($TargetProject) { $TargetProject } else { $project }
    $file = Join-Path $scratch "$Name-$([guid]::NewGuid().ToString('N').Substring(0,6)).md"
    Set-Content -LiteralPath $file -Value $Prompt -NoNewline -Encoding utf8
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($arg in (@('-NoProfile', '-File', (Join-Path $scripts 'Invoke-DshTask.ps1'),
        '-Task', $Name, '-Project', $proj, '-PromptFile', $file,
        '-DshEntry', (Join-Path $PSScriptRoot 'Fake-Dsh.mjs'), '-TimeoutSeconds', '20') + $Extra)) {
        $start.ArgumentList.Add($arg)
    }
    $process = [Diagnostics.Process]::Start($start)
    $owned.Add($process)
    return @{ Process = $process; Output = $process.StandardOutput.ReadToEndAsync(); Error = $process.StandardError.ReadToEndAsync(); Name = $Name; Project = $proj }
}
function Complete($Run) {
    Assert ($Run.Process.WaitForExit(30000)) "Test timeout: $($Run.Name)"
    Assert ($Run.Output.Wait(5000) -and $Run.Error.Wait(5000)) 'Output pipes still open'
    $file = Get-ChildItem -LiteralPath (Join-Path $Run.Project "work/alpha/logs/$($Run.Name)") -Filter '*.status.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Assert ($null -ne $file) "Missing status: $($Run.Error.Result)"
    $status = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    Assert ($status.exitCode -eq $Run.Process.ExitCode) 'Wrong exit code'
    Assert $status.cleanupVerified 'Process cleanup failed'
    Assert $status.overlayRemoved 'Overlay cleanup failed'
    return $status
}
function Input-For([string]$Name, [string]$TargetProject = '') {
    $proj = if ($TargetProject) { $TargetProject } else { $project }
    Get-Content -LiteralPath (Join-Path $proj "work/alpha/logs/$Name/fake-input.json") -Raw | ConvertFrom-Json
}
function Child-For([string]$Name, [string]$TargetProject = '') {
    $proj = if ($TargetProject) { $TargetProject } else { $project }
    $marker = Join-Path $proj "work/alpha/logs/$Name/fake-child.json"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 25) {
        if (Test-Path -LiteralPath $marker) { return (Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).pid }
        Start-Sleep -Milliseconds 100
    }
    throw "Missing child: $Name"
}
function Assert-Stopped([int]$ChildPid) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (Get-Process -Id $ChildPid -ErrorAction SilentlyContinue) {
        Assert ($timer.Elapsed.TotalSeconds -lt 5) "Owned child still running: $ChildPid"
        Start-Sleep -Milliseconds 100
    }
}
try {
    Step '0/9 entering try'
    New-Item -ItemType Directory -Path $project -Force | Out-Null
    $prompt = ('中文内容 $literal `markdown` ' * 1800) + ' TEST_CHILD'
    $runObj = Start-Run 'success' $prompt @('-ReportStartup', '-Caller', 'Antigravity')
    $status = Complete $runObj
    $errOut = $runObj.Error.GetAwaiter().GetResult()
    $input = Input-For 'success'
    Assert ($status.state -eq 'finished' -and $status.turnCompleted) 'Success not recognized'
    Assert ($status.caller -eq 'Antigravity') 'Caller not recorded'
    Assert ($errOut -match 'WORKER_STARTUP\s+\{') 'WORKER_STARTUP not emitted'
    Assert ($input.prompt.StartsWith('【Antigravity → Dsh 交接】')) 'Caller header not applied'
    Assert ($input.prompt.Contains('任务类型：实现（implement）。')) 'TaskKind note was truncated or missing'
    Assert ($input.prompt.Contains('先读取工作目录及涉及路径上适用的 AGENTS.md')) 'AGENTS.md instruction was truncated by interpolation'
    Assert ($input.prompt.EndsWith($prompt)) 'Unicode stdin corrupted'
    Assert ($input.mode -eq 'danger-full-access') 'Wrong default permission'
    Assert (($input.patch | Where-Object id -eq 'approval').config.policy -eq 'never') 'Approval not disabled'
    Assert (($input.patch | Where-Object id -eq 'agent-default-model').config.reasoningEffort -eq 'max') 'Wrong default effort'
    Assert-Stopped (Child-For 'success')
    $results.Add(@{ name='unicode_defaults_caller_startup_and_success_cleanup'; passed=$true }); Step '1/9 success OK'

    $initialSession = $status.sessionId
    $resumed = Complete (Start-Run 'resume' '续接' @('-SessionId',$initialSession,'-Effort','high','-Model','deepseek/deepseek-flash'))
    $input = Input-For 'resume'
    Assert ($resumed.sessionId -eq $status.sessionId) 'Resume ID changed'
    $selection = ($input.patch | Where-Object id -eq 'agent-default-model').config
    Assert ($selection.model -eq 'deepseek/deepseek-flash' -and $selection.reasoningEffort -eq 'high') 'Override lost'
    $mismatch = Complete (Start-Run 'mode-mismatch' 'must not run' @('-SessionId',$initialSession,'-Mode','read-only'))
    Assert ($mismatch.exitCode -ne 0 -and $mismatch.errorKind -eq 'permission_mismatch') 'Permission mismatch was accepted'
    # Writable session resumed with -TaskKind review (omitting -Mode) must also be rejected before starting DSH
    $writableToReview = Complete (Start-Run 'writable-to-review' 'must reject' @('-SessionId',$initialSession,'-TaskKind','review'))
    Assert ($writableToReview.exitCode -ne 0 -and $writableToReview.errorKind -eq 'permission_mismatch') 'Writable session resumed as review was allowed'
    Assert (-not (Test-Path -LiteralPath (Join-Path $project 'work/alpha/logs/writable-to-review/fake-input.json'))) 'Writable-to-review still started DSH'
    $results.Add(@{ name='resume_model_effort_override_and_permission_mismatch_rejection'; passed=$true }); Step '2/9 resume OK'

    $status = Complete (Start-Run 'failure' 'TEST_FAIL TEST_CHILD')
    Assert ($status.exitCode -eq 7 -and $status.state -eq 'failed') 'Failure masked'
    Assert-Stopped (Child-For 'failure')
    $results.Add(@{ name='failure_exit_and_cleanup'; passed=$true }); Step '3/9 failure OK'

    $status = Complete (Start-Run 'incomplete' 'TEST_NO_COMPLETED')
    Assert ($status.exitCode -ne 0) 'Accepted false success'
    $results.Add(@{ name='reject_exit_zero_without_completed'; passed=$true }); Step '4/9 incomplete OK'

    $status = Complete (Start-Run 'timeout' 'TEST_WAIT TEST_CHILD')
    Assert ($status.exitCode -eq 124) 'Timeout not enforced'
    Assert-Stopped (Child-For 'timeout')
    $results.Add(@{ name='timeout_tree_and_overlay_cleanup'; passed=$true }); Step '5/9 timeout OK'

    # First-round live session must hold resume mutex before publishing ID
    $liveFirst = Start-Run 'live-first' 'TEST_WAIT TEST_CHILD'
    $liveChild = Child-For 'live-first'
    $firstId = $null
    $tLock = [Diagnostics.Stopwatch]::StartNew()
    while ($tLock.Elapsed.TotalSeconds -lt 10 -and -not $firstId) {
        $sf = Get-ChildItem -LiteralPath (Join-Path $project 'work/alpha/logs/live-first') -Filter '*.status.json' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sf) {
            try { $st = Get-Content -LiteralPath $sf.FullName -Raw | ConvertFrom-Json; if ($st.sessionId) { $firstId = $st.sessionId } } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    Assert ([bool]$firstId) 'First-round DSH sessionId was not published while running'
    $firstContender = Start-Run 'live-first-contender' 'must not run' @('-SessionId',$firstId)
    Assert ($firstContender.Process.WaitForExit(10000) -and $firstContender.Process.ExitCode -ne 0) 'Concurrent resume during first DSH round was allowed'
    $liveFirst.Process.Kill()
    Assert ($liveFirst.Process.WaitForExit(5000)) 'Cancelled first-round dispatcher still running'
    Assert-Stopped $liveChild

    $run = Start-Run 'cancel' 'TEST_WAIT TEST_CHILD' @('-SessionId',$initialSession)
    $child = Child-For 'cancel'
    $duplicate = Start-Run 'duplicate' 'must not run' @('-SessionId',$initialSession)
    Assert ($duplicate.Process.WaitForExit(10000)) 'Lock contention did not fail promptly'
    Assert ($duplicate.Process.ExitCode -ne 0) 'Concurrent session was allowed'
    $run.Process.Kill()
    Assert ($run.Process.WaitForExit(5000)) 'Cancelled dispatcher still running'
    Assert-Stopped $child
    $results.Add(@{ name='same_session_mutex_and_forced_parent_exit_cleanup'; passed=$true }); Step '6/9 cancel OK'

    $status = Complete (Start-Run 'bad-model' 'must not run' @('-Model','not-configured'))
    Assert ($status.exitCode -ne 0 -and -not $status.sessionId) 'Invalid model silently replaced'
    $results.Add(@{ name='invalid_model_fails_before_execution'; passed=$true }); Step '7/9 bad-model OK'

    # TaskKind review/plan hard-locks read-only, rejects writable mode & WorktreeMode required, and inherits read-only on resume
    $badReview = Complete (Start-Run 'review-bad' 'must reject' @('-TaskKind','review','-Mode','danger-full-access'))
    Assert ($badReview.exitCode -ne 0 -and $badReview.errorKind -eq 'invalid_arguments') 'Review with writable mode not rejected'
    $badWtReq = Complete (Start-Run 'plan-bad-wt' 'must reject' @('-TaskKind','plan','-WorktreeMode','required'))
    Assert ($badWtReq.exitCode -ne 0 -and $badWtReq.errorKind -eq 'invalid_arguments') 'Plan with WorktreeMode required not rejected'
    $roReview = Complete (Start-Run 'review-ok' 'readonly review' @('-TaskKind','review'))
    Assert ($roReview.state -eq 'finished' -and $roReview.requestedMode -eq 'read-only' -and $roReview.taskKind -eq 'review') 'Review did not lock read-only'
    $roResume = Complete (Start-Run 'review-resume' 'readonly follow-up' @('-SessionId',$roReview.sessionId))
    Assert ($roResume.state -eq 'finished' -and $roResume.requestedMode -eq 'read-only' -and $roResume.taskKind -eq 'review') 'Review resume did not inherit read-only'
    $results.Add(@{ name='task_kind_readonly_lock_and_resume_inheritance'; passed=$true }); Step '8/9 review OK'

    # Git single-repo worktree isolation, concurrent same-task worktree lock, in-place review seeing dirty file without mutating main tree
    $gitRepo = Join-Path $scratch 'dsh-git-repo'
    New-Item -ItemType Directory -Path $gitRepo -Force | Out-Null
    & git -C $gitRepo init -q
    & git -C $gitRepo config user.name 'test'
    & git -C $gitRepo config user.email 'test@example.com'
    Set-Content -LiteralPath (Join-Path $gitRepo 'README.md') -Value 'base' -NoNewline -Encoding utf8
    & git -C $gitRepo add README.md
    & git -C $gitRepo commit -q -m 'init'
    Set-Content -LiteralPath (Join-Path $gitRepo 'dirty-main.txt') -Value 'main-uncommitted' -NoNewline -Encoding utf8
    $wtPrompt = Join-Path $scratch 'dsh-wt.md'
    Set-Content -LiteralPath $wtPrompt -Value 'TEST_TOUCH_WORKTREE' -NoNewline -Encoding utf8
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $scripts 'Invoke-DshTask.ps1') -Task 'dsh-wt1' -Project $gitRepo -PromptFile $wtPrompt -DshEntry (Join-Path $PSScriptRoot 'Fake-Dsh.mjs') -Model 'deepseek/deepseek-flash' -TimeoutSeconds 20 | Out-Null
    $wtStFile = Get-ChildItem -LiteralPath (Join-Path $gitRepo 'work/alpha/logs/dsh-wt1') -Filter '*.status.json' | Select-Object -First 1
    $wtSt = Get-Content -LiteralPath $wtStFile.FullName -Raw | ConvertFrom-Json
    Assert ($wtSt.worktree.used -eq $true -and $wtSt.cwd -ne $gitRepo) 'DSH worktree was not used'
    Assert ((Test-Path -LiteralPath (Join-Path $wtSt.cwd 'worker-touched.txt')) -and -not (Test-Path -LiteralPath (Join-Path $gitRepo 'worker-touched.txt'))) 'DSH worktree isolation leaked'

    # Concurrent same-task worktree collision must be rejected cleanly
    $wtOwner = Start-Run 'dsh-wt-busy' 'TEST_WAIT TEST_CHILD' @('-Model','deepseek/deepseek-flash') $gitRepo
    $wtBusyChild = Child-For 'dsh-wt-busy' $gitRepo
    $wtContender = Start-Run 'dsh-wt-busy' 'must not collide' @('-Model','deepseek/deepseek-flash') $gitRepo
    Assert ($wtContender.Process.WaitForExit(15000) -and $wtContender.Process.ExitCode -ne 0) 'Concurrent same-task DSH worktree collision was allowed'
    $wtOwner.Process.Kill()
    Assert ($wtOwner.Process.WaitForExit(5000)) 'Cancelled worktree owner still running'
    Assert-Stopped $wtBusyChild
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $scripts 'Remove-TaskWorktree.ps1') -Project $gitRepo -Task 'dsh-wt-busy' -DeleteBranch -Force | Out-Null

    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $scripts 'Invoke-DshTask.ps1') -Task 'dsh-wt1-r2' -Project $gitRepo -PromptFile $wtPrompt -DshEntry (Join-Path $PSScriptRoot 'Fake-Dsh.mjs') -SessionId $wtSt.sessionId -Model 'deepseek/deepseek-flash' -TimeoutSeconds 20 | Out-Null
    $r2StFile = Get-ChildItem -LiteralPath (Join-Path $gitRepo 'work/alpha/logs/dsh-wt1-r2') -Filter '*.status.json' | Select-Object -First 1
    $r2St = Get-Content -LiteralPath $r2StFile.FullName -Raw | ConvertFrom-Json
    Assert ($r2St.state -eq 'finished' -and $r2St.cwd -eq $wtSt.cwd) 'DSH worktree resume failed'

    # Review TaskKind runs in-place, sees dirty-main.txt, and leaves main tree unmodified
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $scripts 'Invoke-DshTask.ps1') -Task 'dsh-ro-review' -Project $gitRepo -PromptFile $wtPrompt -DshEntry (Join-Path $PSScriptRoot 'Fake-Dsh.mjs') -TaskKind 'review' -Model 'deepseek/deepseek-flash' -TimeoutSeconds 20 | Out-Null
    $roStFile = Get-ChildItem -LiteralPath (Join-Path $gitRepo 'work/alpha/logs/dsh-ro-review') -Filter '*.status.json' | Select-Object -First 1
    $roSt = Get-Content -LiteralPath $roStFile.FullName -Raw | ConvertFrom-Json
    $roIn = Input-For 'dsh-ro-review' $gitRepo
    Assert ($roSt.worktree.used -eq $false -and $roSt.cwd -eq $gitRepo -and $roSt.requestedMode -eq 'read-only') 'DSH review unexpectedly created worktree'
    Assert ($roIn.isReadOnly -eq $true -and $roIn.dirtyMainSeen -eq $true) 'DSH review did not observe read-only mode or main tree dirty file'
    Assert (-not (Test-Path -LiteralPath (Join-Path $gitRepo 'worker-touched.txt'))) 'DSH review mutated main tree'

    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $scripts 'Remove-TaskWorktree.ps1') -Project $gitRepo -Task 'dsh-wt1' -DeleteBranch -Force | Out-Null
    Assert (-not (Test-Path -LiteralPath $wtSt.cwd)) 'DSH Remove-TaskWorktree failed'
    $results.Add(@{ name='git_worktree_isolation_lock_review_and_cleanup'; passed=$true }); Step '9/9 worktree OK'
    $results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $scripts '../references/offline-verification.json') -Encoding utf8
    $results | ConvertTo-Json
} finally {
    foreach ($process in $owned) {
        if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }
        $process.Dispose()
    }
    $resolved = [IO.Path]::GetFullPath($scratch)
    $prefix = (Resolve-Path -LiteralPath $ScratchRoot).Path.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
