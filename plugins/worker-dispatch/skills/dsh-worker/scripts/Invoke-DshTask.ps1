#Requires -Version 7
<#
.SYNOPSIS
Delegate a task to DSH headless CLI (Claude Code & Antigravity universal dispatcher),
with automatic Git Worktree isolation, Windows Job Object lifecycle cleanup,
task-kind read-only locks, atomic status writes, and strict session ownership checks.
.EXAMPLE
pwsh -NoProfile -File Invoke-DshTask.ps1 -Task smoke -Project D:\repo -PromptFile D:\tmp\task.md -TaskKind review
.EXAMPLE
pwsh -NoProfile -File Invoke-DshTask.ps1 -Task fix -Project D:\repo -PromptFile D:\tmp\fix.md -SessionId <ID>
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$')][string]$Task,
    [Parameter(Mandatory)][Alias('Cwd')][string]$Project,
    [Parameter(Mandatory)][string]$PromptFile,
    [string]$Dir,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$')][string]$SessionId,
    [ValidateSet('implement', 'review', 'plan')][string]$TaskKind = 'implement',
    [ValidateSet('read-only', 'workspace-write', 'danger-full-access', 'yolo')][string]$Mode,
    [string]$Provider,
    [string]$Model,
    [string]$Effort,
    [string]$Caller,
    [ValidateRange(1, 86400)][int]$TimeoutSeconds = 1800,
    [ValidateSet('auto', 'required', 'off')][string]$WorktreeMode = 'auto',
    [switch]$NoWorktree,
    [switch]$CaptureBaseline,
    [switch]$ReportStartup,
    [string]$NodePath,
    [string]$DshPackage,
    [string]$SourceConfig,
    [string]$DshEntry,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This dispatcher requires Windows and PowerShell 7.' }
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$taskKindExplicit = $PSBoundParameters.ContainsKey('TaskKind')
$modeExplicit = $PSBoundParameters.ContainsKey('Mode')

if ($NoWorktree) {
    if ($PSBoundParameters.ContainsKey('WorktreeMode') -and $WorktreeMode -ne 'off') {
        throw '-NoWorktree cannot be combined with -WorktreeMode auto/required.'
    }
    $WorktreeMode = 'off'
}
if ([string]::IsNullOrWhiteSpace($Caller)) {
    if ($env:ANTIGRAVITY_CONVERSATION_ID -or $env:ANTIGRAVITY_APP_DATA_DIR) { $Caller = 'Antigravity' }
    elseif ($env:CLAUDECODE -or $env:CLAUDE_CODE_ENTRYPOINT) { $Caller = 'Claude Code' }
    else { $Caller = 'Agent' }
}

foreach ($path in @($Project, $PromptFile)) {
    if (-not [IO.Path]::IsPathFullyQualified($path)) { throw "须为绝对路径：$path" }
}
$Project = (Resolve-Path -LiteralPath $Project).Path
if (-not (Test-Path -LiteralPath $Project -PathType Container)) { throw 'Project must be a directory.' }
if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) { throw "找不到交接文件：$PromptFile" }
if ($Dir) {
    if (-not [IO.Path]::IsPathFullyQualified($Dir)) { $Dir = Join-Path $Project $Dir }
    $Dir = (Resolve-Path -LiteralPath $Dir).Path
    $projectPrefix = $Project.TrimEnd('\') + '\'
    if (-not (Test-Path -LiteralPath $Dir -PathType Container) -or
        -not ($Dir -eq $Project -or $Dir.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'Dir must be a directory inside Project.'
    }
}

function Write-FileAtomic([string]$Path, [string]$Content) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $tmp = "$Path.$PID.$([guid]::NewGuid().ToString('N').Substring(0, 6)).tmp"
    try {
        [IO.File]::WriteAllText($tmp, $Content, $utf8NoBom)
        for ($attempt = 0; $attempt -lt 6; $attempt++) {
            try {
                [IO.File]::Move($tmp, $Path, $true)
                return
            } catch [IO.IOException] {
                if ($attempt -eq 5) { throw }
                Start-Sleep -Milliseconds 25
            }
        }
    } finally {
        if (Test-Path -LiteralPath $tmp -PathType Leaf) {
            try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}

function Get-TextHashPrefix([string]$Text) {
    $bytes = $utf8NoBom.GetBytes($Text.ToLowerInvariant())
    return ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))).Substring(0, 16)
}

$defaults = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../config/defaults.json') -Raw | ConvertFrom-Json
if (-not $Provider) { $Provider = $defaults.provider }
if (-not $Model) { $Model = $defaults.model }
if (-not $Effort) { $Effort = $defaults.effort }
if ($Mode -eq 'yolo') { $Mode = 'danger-full-access' }
if (-not $NodePath) { $NodePath = $defaults.nodePath }
if (-not $DshPackage) { $DshPackage = $defaults.dshPackage }
if (-not $SourceConfig) { $SourceConfig = $defaults.sourceConfig }
foreach ($path in @($NodePath, $DshPackage, $SourceConfig)) {
    if (-not [IO.Path]::IsPathFullyQualified($path) -or -not (Test-Path -LiteralPath $path)) {
        throw "DSH dependency missing (use explicit parameters to override): $path"
    }
}
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
$executable = $NodePath
$prefixArguments = @((Join-Path $PSScriptRoot 'DshLauncher.mjs'))

. (Join-Path $PSScriptRoot 'TaskWorktree.ps1')

$runId = 'dsh-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$logDir = Join-Path $Project "work\alpha\logs\$Task"
$sessionDir = Join-Path $Project 'work\alpha\sessions\dsh'
$statusPath = Join-Path $logDir "$runId.status.json"
$eventsPath = Join-Path $logDir "$runId.events.jsonl"
$stderrPath = Join-Path $logDir "$runId.stderr.log"
$finalPath = Join-Path $logDir "$runId.final.md"
$savedPromptPath = Join-Path $logDir "$runId.prompt.md"
$workerStatusPath = Join-Path $logDir "$runId.worker.json"

$mutex = $null
$locked = $false
$wtMutex = $null
$wtLocked = $false

function Release-Locks {
    if ($script:wtLocked -and $script:wtMutex) { try { $script:wtMutex.ReleaseMutex() } catch { }; $script:wtLocked = $false }
    if ($script:wtMutex) { $script:wtMutex.Dispose(); $script:wtMutex = $null }
    if ($script:locked -and $script:mutex) { try { $script:mutex.ReleaseMutex() } catch { }; $script:locked = $false }
    if ($script:mutex) { $script:mutex.Dispose(); $script:mutex = $null }
}

function Exit-PreflightFailure([string]$ErrorKind, [string]$Message) {
    if (-not $DryRun) {
        $preflightStatus = [ordered]@{
            runId = $runId; task = $Task; taskKind = $TaskKind; caller = $Caller; cli = $DshPackage
            node = $NodePath; provider = $Provider; cwd = $Project; sourceProject = $Project; dir = $Dir
            requestedProvider = $Provider; requestedModel = $Model; requestedEffort = $Effort
            requestedMode = $Mode; approvalPolicy = 'never'
            requestedSessionId = $SessionId; sessionId = if ($SessionId) { $SessionId } else { $null }
            runnerPid = $PID; startedAt = (Get-Date).ToString('o'); finishedAt = (Get-Date).ToString('o')
            state = 'failed'; exitCode = 1; errorKind = $ErrorKind; error = $Message
            cleanupVerified = $true; cleanupRemainingPids = @(); overlayRemoved = $true
        }
        Write-FileAtomic $statusPath ($preflightStatus | ConvertTo-Json -Depth 6)
    }
    Release-Locks
    Write-Output "状态：$statusPath"
    Write-Output "错误：[$ErrorKind] $Message"
    Write-Output "结束：failed，exit=1；最终报告：$finalPath"
    exit 1
}

$previousSessionCwd = ''
if (-not $DryRun -and $SessionId) {
    $mutex = [Threading.Mutex]::new($false, "Local\DshDelegate-$SessionId")
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        $mutex.Dispose()
        $mutex = $null
        throw '此会话已有调度器正在执行，请等原调用结束后再续接。'
    }
}

$previous = $null
if ($SessionId) {
    $sessionRecord = Join-Path $sessionDir "$SessionId.json"
    if (-not (Test-Path -LiteralPath $sessionRecord -PathType Leaf)) {
        Release-Locks
        throw '找不到此流程在当前项目创建的会话记录，不能接管外部会话。请新建会话。'
    }
    $previous = [IO.File]::ReadAllText($sessionRecord, $utf8NoBom) | ConvertFrom-Json
    if (-not $taskKindExplicit -and $previous.taskKind) {
        $TaskKind = [string]$previous.taskKind
    }
}

# Validate TaskKind constraints and compute final effective Mode BEFORE comparing with previous session permissions.
if ($TaskKind -in @('review', 'plan')) {
    if ($modeExplicit -and $Mode -ne 'read-only') {
        Exit-PreflightFailure 'invalid_arguments' "TaskKind '$TaskKind' 硬锁只读模式，拒绝可写参数 -Mode '$Mode'；未启动 DSH。"
    }
    if ($WorktreeMode -eq 'required') {
        Exit-PreflightFailure 'invalid_arguments' "TaskKind '$TaskKind' 要求原位只读检查当前工作树，拒绝 -WorktreeMode required；未启动 DSH。"
    }
    $Mode = 'read-only'
} elseif ($SessionId) {
    if (-not $modeExplicit) {
        $Mode = [string]$previous.mode
        if ($Mode -eq 'yolo') { $Mode = 'danger-full-access' }
    }
} else {
    if (-not $modeExplicit) { $Mode = $defaults.mode }
    if ($Mode -eq 'yolo') { $Mode = 'danger-full-access' }
}

if ($SessionId) {
    $recordedSource = if ($previous.sourceProject) { [string]$previous.sourceProject } else { [string]$previous.cwd }
    $recordedMode = [string]$previous.mode
    if ($recordedMode -eq 'yolo') { $recordedMode = 'danger-full-access' }
    if ($recordedSource -ne $Project -or $recordedMode -ne $Mode) {
        Exit-PreflightFailure 'permission_mismatch' "DSH 续接保留原生会话首次权限；原权限为 $recordedMode，本次任务（TaskKind=$TaskKind）要求权限为 $Mode。请使用相同权限，或不传 SessionId 新建只读/可写会话。"
    }
    $previousSessionCwd = [string]$previous.cwd
}

try {
    $workspaceInfo = Resolve-WorkerWorkspace -Project $Project -Dir $Dir -Task $Task -Mode $Mode `
        -WorktreeMode $WorktreeMode -PreviousCwd $previousSessionCwd -DryRun:$DryRun
} catch {
    Release-Locks
    throw
}
$effectiveProject = $workspaceInfo.effectiveProject
$effectiveDir = $workspaceInfo.effectiveDir
$tmpDir = Join-Path $effectiveProject "work\alpha\tmp\$Task"

if (-not $DryRun -and $workspaceInfo.used) {
    $wtMutexName = 'Local\WorkerWtInUse-' + (Get-TextHashPrefix $effectiveProject)
    $wtMutex = [Threading.Mutex]::new($false, $wtMutexName)
    try { $wtLocked = $wtMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $wtLocked = $true }
    if (-not $wtLocked) {
        $wtMutex.Dispose()
        $wtMutex = $null
        Exit-PreflightFailure 'worktree_busy' "目标隔离工作树正被另一任务占用：$effectiveProject；并行派单请为不同引擎使用独立任务名（如 dsh-$Task / codex-$Task）。"
    }
}

$overlayPath = Join-Path $tmpDir "$runId.patch.json"
$cliArguments = @('--profile', 'headless', '--patch', $overlayPath, '--json')
if ($SessionId) { $cliArguments += @('--session-id', $SessionId) }
$cliArguments += '-'
$launchOptions = @{ provider = $Provider; model = $Model; effort = $Effort; mode = $Mode
    dshPackage = $DshPackage; sourceConfig = $SourceConfig; patch = $overlayPath; entry = $DshEntry }
$childEnvironment = @{
    DSH_PERMISSION_MODE = $Mode
    DSH_DELEGATE_LOG_DIR = $logDir
    DSH_DELEGATE_CONFIG = ($launchOptions | ConvertTo-Json -Compress)
    PATH = (Split-Path -Parent $NodePath) + ';' + (Split-Path -Parent $pwshPath) + ';' + $env:PATH
}

$rawPrompt = [IO.File]::ReadAllText($PromptFile, $utf8NoBom)
$scope = if ($effectiveDir) { $effectiveDir } else { $effectiveProject }
$worktreeNote = if ($workspaceInfo.used) {
    "`n隔离工作树：$effectiveProject（源项目：$Project；拓扑：$($workspaceInfo.topology)）`n重要约束：本次执行位于独立 Git Worktree，交接正文中若出现源项目路径 $Project\...，请一律映射到当前工作树 $effectiveProject\... 内读写，严禁跨目录直接修改源项目工作树！`n"
} else { '' }
$taskKindNote = switch ($TaskKind) {
    'review' { "任务类型：只读反向审查（review）。严禁修改仓库文件；发现按 [BLOCKING] / [ADVISORY] 分级并附文件:行号与可达触发路径。`n" }
    'plan'   { "任务类型：只读双盲方案（plan）。严禁修改仓库文件；基于真实代码独立输出推荐方案、代码证据、代价与验证方法。`n" }
    default  { "任务类型：实现（implement）。修改代码后实跑验证命令并如实报告结果，禁止无证据的过度防御判空与兜底。`n" }
}
$prompt = @"
【$Caller → Dsh 交接】任务：$Task
项目工作目录：$effectiveProject
本次处理范围：${scope}${worktreeNote}
${taskKindNote}先读取工作目录及涉及路径上适用的 AGENTS.md，遵守其中的代码、验证与清理规则。
角色约束：你是执行端，严禁递归调用 dsh-worker / codex-worker 或任何外部派单脚本。
临时脚本、草稿和中间文件仅放在：$tmpDir
本次调用总超时为 $TimeoutSeconds 秒；每个构建或测试也必须有明确超时。
正常完成、失败或中止都要停止本次测试的进程树并清理无用临时文件；不要结束其他任务的进程。
调度器结束时会清理本次启动的所有后代进程，不能依赖它保留后台服务。
完成后报告改动文件、实际验证命令和结果、未完成项；只读限制下无法执行的步骤明确报告。

"@ + $rawPrompt

if ($DryRun) {
    [ordered]@{ cli = $DshPackage; caller = $Caller; taskKind = $TaskKind; node = $NodePath; provider = $Provider
        cwd = $effectiveProject; sourceProject = $Project; worktree = $workspaceInfo
        model = $Model; effort = $Effort; mode = $Mode
        timeoutSeconds = $TimeoutSeconds; arguments = $cliArguments; promptFile = $PromptFile } | ConvertTo-Json -Depth 6
    exit 0
}

if (-not ('DshDelegate.WindowsJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'WindowsJob.cs') }
$job = $null
$runner = $null
$files = @()
$copies = @()
$eventsReader = $null
$pendingEvent = ''
$exitCode = 1
$baselineFiles = [ordered]@{ head = $null; status = $null; diff = $null; cached = $null; complete = $null }

$status = [ordered]@{
    runId = $runId; task = $Task; taskKind = $TaskKind; caller = $Caller
    cli = $DshPackage; node = $NodePath; provider = $Provider
    cwd = $effectiveProject; sourceProject = $Project; dir = $effectiveDir
    worktreeMode = $WorktreeMode; worktree = $workspaceInfo
    requestedProvider = $Provider; requestedModel = $Model; requestedEffort = $Effort; requestedMode = $Mode; approvalPolicy = 'never'
    requestedSessionId = $SessionId; sessionId = $null
    runnerPid = $PID; workerPid = $null; cliPid = $null
    timeoutSeconds = $TimeoutSeconds; startedAt = (Get-Date).ToString('o'); finishedAt = $null
    state = 'starting'; exitCode = $null; errorKind = $null; error = $null; turnCompleted = $false
    cleanupVerified = $false; cleanupRemainingPids = @(); overlayRemoved = $false; configuration = $null
    baseline = $baselineFiles
    arguments = $cliArguments; prompt = $savedPromptPath; events = $eventsPath; stderr = $stderrPath
    final = $finalPath; tmpDir = $tmpDir
}
function Save-Status {
    Write-FileAtomic $statusPath ($status | ConvertTo-Json -Depth 7)
}
function Acquire-SessionLockIfUnheld([string]$Id) {
    if ($script:locked -or [string]::IsNullOrWhiteSpace($Id)) { return }
    try {
        $m = [Threading.Mutex]::new($false, "Local\DshDelegate-$Id")
        $got = $false
        try { $got = $m.WaitOne(0) } catch [Threading.AbandonedMutexException] { $got = $true }
        if ($got) {
            $script:mutex = $m
            $script:locked = $true
        } else {
            $m.Dispose()
        }
    } catch { }
}
function Read-Progress {
    if (Test-Path -LiteralPath $workerStatusPath) {
        try {
            $workerState = [IO.File]::ReadAllText($workerStatusPath, $utf8NoBom) | ConvertFrom-Json
            if ($workerState.cliPid) { $status.cliPid = $workerState.cliPid }
        } catch { }
    }
    if ($eventsReader) {
        $script:pendingEvent += $eventsReader.ReadToEnd()
        while (($lineEnd = $script:pendingEvent.IndexOf("`n")) -ge 0) {
            $line = $script:pendingEvent.Substring(0, $lineEnd).TrimEnd("`r")
            $script:pendingEvent = $script:pendingEvent.Substring($lineEnd + 1)
            if (-not $line) { continue }
            try { $event = $line | ConvertFrom-Json } catch { continue }
            if ($event.type -eq 'session' -and $event.sessionId) {
                if ($event.sessionId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$') { throw 'DSH returned an invalid session ID.' }
                $firstSeen = -not $status.sessionId
                $status.sessionId = $event.sessionId
                if (-not $SessionId) {
                    Acquire-SessionLockIfUnheld $event.sessionId
                    $rec = [ordered]@{
                        sessionId = $event.sessionId; cwd = $effectiveProject; sourceProject = $Project
                        task = $Task; taskKind = $TaskKind; mode = $Mode; runId = $runId
                    }
                    Write-FileAtomic (Join-Path $sessionDir "$($event.sessionId).json") ($rec | ConvertTo-Json -Depth 5)
                }
                if ($firstSeen) { Write-Output "会话：$($event.sessionId)" }
            }
            if ($event.type -eq 'delegate_config') { $status.configuration = $event }
            if ($event.type -eq 'status' -and $event.phase -eq 'turn_end') {
                $status.turnCompleted = $event.reason.kind -eq 'completed'
                if (-not $status.turnCompleted) { $status.error = $event.reason | ConvertTo-Json -Depth 8 -Compress }
            }
            if ($event.type -eq 'error') { $status.error = $event.message }
            if ($event.type -eq 'final') {
                Write-FileAtomic $finalPath ([string]$event.text)
            }
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $logDir, $tmpDir | Out-Null

    if ($CaptureBaseline -and -not $workspaceInfo.used -and $Mode -ne 'read-only') {
        Push-Location -LiteralPath $effectiveProject
        try {
            $gitCheck = git rev-parse --is-inside-work-tree 2>$null
            if ($LASTEXITCODE -eq 0 -and "$gitCheck".Trim() -eq 'true') {
                $bHead = Join-Path $logDir 'baseline.head.txt'
                $bStatus = Join-Path $logDir 'baseline.status.txt'
                $bDiff = Join-Path $logDir 'baseline.diff.patch'
                $bCached = Join-Path $logDir 'baseline.cached.patch'
                $bDone = Join-Path $logDir 'baseline.complete.json'
                $isComplete = (Test-Path -LiteralPath $bDone -PathType Leaf) -and
                    (Test-Path -LiteralPath $bHead -PathType Leaf) -and
                    (Test-Path -LiteralPath $bStatus -PathType Leaf) -and
                    (Test-Path -LiteralPath $bDiff -PathType Leaf) -and
                    (Test-Path -LiteralPath $bCached -PathType Leaf)
                if (-not $isComplete) {
                    $h = git rev-parse HEAD 2>$null
                    Write-FileAtomic $bHead $(if ($LASTEXITCODE -eq 0 -and $h) { "$h".Trim() } else { '' })
                    Write-FileAtomic $bStatus ((@(git status --porcelain 2>$null)) -join "`n")
                    Write-FileAtomic $bDiff ((@(git diff 2>$null)) -join "`n")
                    Write-FileAtomic $bCached ((@(git diff --cached 2>$null)) -join "`n")
                    Write-FileAtomic $bDone (@{ capturedAt = (Get-Date).ToString('o'); runId = $runId } | ConvertTo-Json -Compress)
                }
                $baselineFiles.head = $bHead; $baselineFiles.status = $bStatus
                $baselineFiles.diff = $bDiff; $baselineFiles.cached = $bCached; $baselineFiles.complete = $bDone
            }
        } finally { Pop-Location }
    }

    Write-FileAtomic $savedPromptPath $prompt
    Save-Status
    if ($ReportStartup) {
        $startupPayload = [ordered]@{
            worker = 'dsh'; caller = $Caller; task = $Task; taskKind = $TaskKind
            runId = $runId; runnerPid = $PID; statusFile = $statusPath; eventsFile = $eventsPath
            cwd = $effectiveProject; worktreeUsed = [bool]$workspaceInfo.used
        }
        [Console]::Error.WriteLine('WORKER_STARTUP ' + ($startupPayload | ConvertTo-Json -Compress))
    }
    Write-Output "状态：$statusPath"
    Write-Output "进度：$eventsPath"
    if ($workspaceInfo.used) { Write-Output "隔离工作树：$effectiveProject ($($workspaceInfo.topology))" }
    Write-Output "任务类型：$TaskKind；模型：$Model / $Effort；权限：$Mode；超时：$TimeoutSeconds 秒"
    $job = [DshDelegate.WindowsJob]::new()
    $files = @(
        [IO.FileStream]::new($eventsPath, 'CreateNew', 'Write', 'ReadWrite', 1),
        [IO.FileStream]::new($stderrPath, 'CreateNew', 'Write', 'ReadWrite', 1)
    )
    $eventsReader = [IO.StreamReader]::new([IO.FileStream]::new($eventsPath, 'Open', 'Read', 'ReadWrite'), $utf8NoBom)
    $start = [Diagnostics.ProcessStartInfo]::new($pwshPath)
    $start.WorkingDirectory = $effectiveProject
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = $utf8NoBom
    foreach ($argument in @('-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'DshWorker.ps1'))) {
        $start.ArgumentList.Add($argument)
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $runner = [Diagnostics.Process]::Start($start)
    $status.workerPid = $runner.Id
    $job.Add($runner)
    $copies = @(
        $runner.StandardOutput.BaseStream.CopyToAsync($files[0]),
        $runner.StandardError.BaseStream.CopyToAsync($files[1])
    )
    $request = @{ executable = $executable; arguments = @($prefixArguments + $cliArguments)
        cwd = $effectiveProject; prompt = $prompt; workerStatus = $workerStatusPath; environment = $childEnvironment } | ConvertTo-Json -Depth 5 -Compress
    $sendRequest = $runner.StandardInput.WriteAsync($request)
    while (-not $sendRequest.Wait(100)) {
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw [TimeoutException]::new('发送交接内容超时。') }
    }
    $null = $sendRequest.GetAwaiter().GetResult()
    $runner.StandardInput.Close()
    $status.state = 'running'
    Save-Status
    while (-not $runner.WaitForExit(500)) {
        Read-Progress
        Save-Status
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw [TimeoutException]::new("Dsh 调用超过 $TimeoutSeconds 秒。") }
    }
    $exitCode = $runner.ExitCode
    $status.state = if ($exitCode -eq 0) { 'finished' } else { 'failed' }
} catch [TimeoutException] {
    $exitCode = 124
    $status.state = 'timed_out'
    $status.error = $_.Exception.Message
} catch {
    $status.state = 'failed'
    $status.error = $_.Exception.Message
} finally {
    if ($status.state -in @('starting', 'running')) { $status.state = 'stopped'; $exitCode = 130 }
    if ($job) {
        try {
            $job.Terminate()
            $cleanupTimer = [Diagnostics.Stopwatch]::StartNew()
            do {
                $status.cleanupRemainingPids = @($job.ProcessIds())
                if ($status.cleanupRemainingPids.Count) { Start-Sleep -Milliseconds 100 }
            } while ($status.cleanupRemainingPids.Count -and $cleanupTimer.Elapsed.TotalSeconds -lt 10)
            $status.cleanupVerified = $status.cleanupRemainingPids.Count -eq 0
        } catch {
            $status.error = "$($status.error) 清理失败：$($_.Exception.Message)".Trim()
        } finally { $job.Dispose() }
    }
    if ($runner) {
        try {
            if (-not $runner.HasExited) { $runner.Kill($true) }
            $runner.WaitForExit(5000) | Out-Null
        } catch { }
    }
    if ($copies.Count) {
        try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$copies, 5000) | Out-Null } catch { }
    }
    foreach ($file in $files) { $file.Dispose() }
    Read-Progress
    if ($eventsReader) { $eventsReader.Dispose() }
    if ($runner) { $runner.Dispose() }
    if (-not $status.cleanupVerified -and $exitCode -eq 0) { $exitCode = 1; $status.state = 'failed' }
    if ($exitCode -eq 0 -and ($status.error -or -not $status.turnCompleted -or -not (Test-Path -LiteralPath $finalPath) -or (Get-Item -LiteralPath $finalPath).Length -eq 0)) {
        $exitCode = 1
        $status.state = 'failed'
        if (-not $status.error) { $status.error = 'CLI 已退出，但缺少 completed 终止事件或非空最终报告。' }
    }
    if ($exitCode -ne 0 -and -not $status.error -and (Test-Path -LiteralPath $stderrPath)) {
        $status.error = (Get-Content -LiteralPath $stderrPath -Tail 12 -Encoding utf8) -join "`n"
    }
    try {
        if (Test-Path -LiteralPath $overlayPath) { Remove-Item -LiteralPath $overlayPath -Force }
        $status.overlayRemoved = -not (Test-Path -LiteralPath $overlayPath)
    } catch {
        $status.error = "$($status.error) 配置覆盖文件清理失败：$($_.Exception.Message)".Trim()
        $exitCode = 1
        $status.state = 'failed'
    }
    $status.exitCode = $exitCode
    $status.finishedAt = (Get-Date).ToString('o')
    if (Test-Path -LiteralPath $savedPromptPath) { Save-Status }
    Release-Locks
}
if ($status.error) { Write-Output "错误：$($status.error)" }
Write-Output "结束：$($status.state)，exit=$exitCode；最终报告：$finalPath"
exit $exitCode
