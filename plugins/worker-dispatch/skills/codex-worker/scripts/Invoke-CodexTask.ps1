#Requires -Version 7
<#
.SYNOPSIS
Delegate a task to Codex CLI (Claude Code & Antigravity universal dispatcher),
with automatic Git Worktree isolation, Windows Job Object lifecycle cleanup,
task-kind read-only locks, optional structured JSON handoff validation, and
Codex Desktop sidebar registration.
.EXAMPLE
pwsh -NoProfile -File Invoke-CodexTask.ps1 -Task smoke -Project D:\repo -PromptFile D:\tmp\task.md -TaskKind review
.EXAMPLE
pwsh -NoProfile -File Invoke-CodexTask.ps1 -Task fix -Project D:\repo -PromptFile D:\tmp\fix.md -SessionId <UUID>
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$')][string]$Task,
    [Parameter(Mandatory)][Alias('Cwd')][string]$Project,
    [Parameter(Mandatory)][string]$PromptFile,
    [string]$Dir,
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')][string]$SessionId,
    [ValidateSet('implement', 'review', 'plan')][string]$TaskKind = 'implement',
    [ValidateSet('read-only', 'workspace-write', 'auto', 'yolo', 'danger-full-access')][string]$Mode = 'yolo',
    [string]$Model,
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max', 'ultra')][string]$Effort,
    [ValidateSet('default', 'fast', 'flex', 'ultrafast')][string]$ServiceTier = 'default',
    # Extra Codex -c overrides (key=value, TOML value), e.g. 'windows.sandbox="mxc"'; appended after mode settings.
    [ValidatePattern('^[A-Za-z0-9_.]+=.+$')][string[]]$ExtraConfig,
    [switch]$Fast,
    [switch]$StructuredHandoff,
    [string]$OutputSchema,
    [string]$Caller,
    [ValidateRange(1, 86400)][int]$TimeoutSeconds = 1800,
    [ValidateSet('auto', 'required', 'off')][string]$WorktreeMode = 'auto',
    [switch]$NoWorktree,
    [switch]$CaptureBaseline,
    [switch]$ReportStartup,
    [switch]$NoDesktopRegister,
    [string]$CodexPath,
    [switch]$SkipGitRepoCheck,
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
$modelExplicit = $PSBoundParameters.ContainsKey('Model')
$effortExplicit = $PSBoundParameters.ContainsKey('Effort')
$tierExplicit = $PSBoundParameters.ContainsKey('ServiceTier') -or $Fast.IsPresent
$schemaExplicit = $PSBoundParameters.ContainsKey('StructuredHandoff') -or $PSBoundParameters.ContainsKey('OutputSchema')

if ($Mode -eq 'danger-full-access') { $Mode = 'yolo' }
if ($NoWorktree) {
    if ($PSBoundParameters.ContainsKey('WorktreeMode') -and $WorktreeMode -ne 'off') {
        throw '-NoWorktree cannot be combined with -WorktreeMode auto/required.'
    }
    $WorktreeMode = 'off'
}
if ($Fast) {
    if ($PSBoundParameters.ContainsKey('ServiceTier') -and $ServiceTier -ne 'fast') {
        throw '-Fast cannot be combined with a different -ServiceTier.'
    }
    $ServiceTier = 'fast'
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

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$skillRoot = Split-Path -Parent $PSScriptRoot

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

function Find-CodexSessionFile([string]$Id) {
    if ($Id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        return $null
    }
    foreach ($sub in 'sessions', 'archived_sessions') {
        $root = Join-Path $codexHome $sub
        if (Test-Path -LiteralPath $root -PathType Container) {
            $file = Get-ChildItem -LiteralPath $root -Recurse -File -Filter "rollout-*-$Id.jsonl*" -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($file) { return $file }
        }
    }
    return $null
}

function Read-ModeFromRollout([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $sandbox = $null
    $approval = $null
    $reviewer = $null
    $permProfile = $null
    $reader = [IO.StreamReader]::new([IO.FileStream]::new($Path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)), $utf8NoBom)
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            if ($line.Contains('"type":"turn_context"')) {
                try {
                    $p = ($line | ConvertFrom-Json -ErrorAction Stop).payload
                    if ($p.approval_policy) { $approval = [string]$p.approval_policy }
                    if ($p.approvals_reviewer) { $reviewer = [string]$p.approvals_reviewer }
                    if ($p.sandbox_policy -and $p.sandbox_policy.type) { $sandbox = [string]$p.sandbox_policy.type; $permProfile = $null }
                    if ($p.permission_profile) { $permProfile = $p.permission_profile; $sandbox = $null }
                } catch { }
            } elseif ($line.Contains('"type":"thread_settings_applied"')) {
                try {
                    $ts = ($line | ConvertFrom-Json -ErrorAction Stop).payload.thread_settings
                    if ($ts.approval_policy) { $approval = [string]$ts.approval_policy }
                    if ($ts.approvals_reviewer) { $reviewer = [string]$ts.approvals_reviewer }
                    if ($ts.permission_profile) { $permProfile = $ts.permission_profile; $sandbox = $null }
                } catch { }
            }
        }
    } finally {
        $reader.Dispose()
    }

    if ($permProfile) {
        $ptype = [string]$permProfile.type
        if ($ptype -eq 'disabled') {
            if ($approval -eq 'never') { return 'yolo' }
            return $null
        }
        if ($ptype -eq 'managed') {
            $entries = @()
            if ($permProfile.file_system -and $permProfile.file_system.entries) {
                $entries = @($permProfile.file_system.entries)
            }
            $hasWrite = $false
            foreach ($e in $entries) {
                if ([string]$e.access -in @('write', 'read_write', 'full')) { $hasWrite = $true; break }
            }
            if (-not $hasWrite -and $entries.Count -gt 0) {
                if ($approval -eq 'never') { return 'read-only' }
                return $null
            }
            if ($hasWrite) {
                if ($approval -eq 'never') { return 'workspace-write' }
                if ($approval -eq 'on-request' -and $reviewer -eq 'auto_review') { return 'auto' }
            }
            return $null
        }
        return $null
    }

    if ($sandbox -eq 'read-only' -and $approval -eq 'never') { return 'read-only' }
    if ($sandbox -eq 'workspace-write' -and $approval -eq 'on-request' -and $reviewer -eq 'auto_review') { return 'auto' }
    if ($sandbox -eq 'workspace-write' -and $approval -eq 'never') { return 'workspace-write' }
    if ($sandbox -eq 'danger-full-access' -and $approval -eq 'never') { return 'yolo' }
    return $null
}

function Resolve-NativeCodexPath {
    $direct = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($direct) { return $direct.Source }

    # Prefer the npm @openai/codex vendor native binary alongside PATH's codex.ps1/codex.cmd shim.
    $shim = Get-Command codex -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -like '*.ps1' -or $_.Source -like '*.cmd' } |
        Select-Object -First 1
    if ($shim) {
        $baseDir = Split-Path -Parent $shim.Source
        $archInfo = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') {
            @{ pkg = 'codex-win32-arm64'; triple = 'aarch64-pc-windows-msvc' }
        } else {
            @{ pkg = 'codex-win32-x64'; triple = 'x86_64-pc-windows-msvc' }
        }
        $vendorExe = Join-Path $baseDir "node_modules\@openai\codex\node_modules\@openai\$($archInfo.pkg)\vendor\$($archInfo.triple)\bin\codex.exe"
        if (Test-Path -LiteralPath $vendorExe -PathType Leaf) { return $vendorExe }
    }

    $desktopBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $desktopBin -PathType Container) {
        $candidates = @(Get-ChildItem -LiteralPath $desktopBin -Filter codex.exe -File -Recurse |
            Sort-Object LastWriteTime -Descending)
        $subCandidate = $candidates | Where-Object { $_.DirectoryName -ne $desktopBin } | Select-Object -First 1
        if ($subCandidate) { return $subCandidate.FullName }
        if ($candidates.Count -gt 0) { return $candidates[0].FullName }
    }
    return $null
}

if (-not $CodexPath) {
    $CodexPath = Resolve-NativeCodexPath
    if (-not $CodexPath) { throw '找不到 codex.exe。请安装 @openai/codex 或通过 -CodexPath 指定 Codex 入口。' }
}
$CodexPath = (Resolve-Path -LiteralPath $CodexPath).Path
$extension = [IO.Path]::GetExtension($CodexPath)
if ($extension -notin @('.exe', '.ps1')) { throw 'CodexPath supports native .exe or PowerShell .ps1 launchers.' }
$isNativeExe = $extension -eq '.exe'
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
$executable = $CodexPath
$prefixArguments = @()
if ($extension -eq '.ps1') {
    $executable = $pwshPath
    $prefixArguments = @('-NoLogo', '-NoProfile', '-File', $CodexPath)
}

. (Join-Path $PSScriptRoot 'TaskWorktree.ps1')

$runId = 'codex-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$logDir = Join-Path $Project "work\alpha\logs\$Task"
$sessionDir = Join-Path $Project 'work\alpha\sessions\codex'
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
            runId = $runId; task = $Task; taskKind = $TaskKind; caller = $Caller; cli = $CodexPath
            cwd = $Project; sourceProject = $Project; dir = $Dir
            requestedModel = if ($Model) { $Model } else { $null }
            requestedEffort = if ($Effort) { $Effort } else { $null }
            requestedMode = $Mode; requestedServiceTier = $ServiceTier
            requestedSessionId = $SessionId; sessionId = if ($SessionId) { $SessionId } else { $null }
            runnerPid = $PID; startedAt = (Get-Date).ToString('o'); finishedAt = (Get-Date).ToString('o')
            state = 'failed'; exitCode = 1; errorKind = $ErrorKind; error = $Message
            cleanupVerified = $true; cleanupRemainingPids = @()
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
$prevRec = $null
$rolloutFile = $null
$prevSidebarRegistered = $false
$prevSidebarTitle = $null

if (-not $DryRun -and $SessionId) {
    $mutex = [Threading.Mutex]::new($false, "Local\CodexDelegate-$SessionId")
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        $mutex.Dispose()
        $mutex = $null
        throw '此会话已有调度器正在执行，请等原调用结束后再续接。'
    }
}

if ($SessionId) {
    $sessionRecordPath = Join-Path $sessionDir "$SessionId.json"
    if (Test-Path -LiteralPath $sessionRecordPath -PathType Leaf) {
        try {
            $prevRec = [IO.File]::ReadAllText($sessionRecordPath, $utf8NoBom) | ConvertFrom-Json -ErrorAction Stop
            if ($prevRec.cwd) { $previousSessionCwd = [string]$prevRec.cwd }
            if ($prevRec.sidebarRegistered) { $prevSidebarRegistered = [bool]$prevRec.sidebarRegistered }
            if ($prevRec.sidebarTitle) { $prevSidebarTitle = [string]$prevRec.sidebarTitle }
        } catch { $prevRec = $null }
    }

    if ($isNativeExe -and -not $DryRun) {
        $rolloutFile = Find-CodexSessionFile $SessionId
        if (-not $rolloutFile) {
            Exit-PreflightFailure 'invalid_session' "找不到 Codex 原生会话 rollout（$SessionId），已检查 $codexHome\sessions 与 archived_sessions；未启动 Codex。"
        }
    }

    if (-not $taskKindExplicit -and $prevRec -and $prevRec.taskKind) {
        $TaskKind = [string]$prevRec.taskKind
    }
    if (-not $modeExplicit) {
        if ($TaskKind -in @('review', 'plan')) {
            $Mode = 'read-only'
        } elseif ($prevRec -and $prevRec.mode) {
            $cachedMode = [string]$prevRec.mode
            if ($cachedMode -eq 'danger-full-access') { $cachedMode = 'yolo' }
            if ($rolloutFile) {
                $rolloutMode = Read-ModeFromRollout $rolloutFile.FullName
                if (-not $rolloutMode) {
                    Exit-PreflightFailure 'unknown_resume_mode' "原生 rollout 权限策略无法无损映射到已知 -Mode（可能包含额外审批限制），拒绝沿用缓存 '$cachedMode'；请显式传入 -Mode。"
                }
                if ($rolloutMode -ne $cachedMode) {
                    Exit-PreflightFailure 'unknown_resume_mode' "原生 rollout 实际权限（$rolloutMode）与本地缓存（$cachedMode）不一致，拒绝自动放宽或覆盖权限；请显式传入 -Mode。"
                }
            }
            $Mode = $cachedMode
        } elseif ($rolloutFile) {
            $inferredMode = Read-ModeFromRollout $rolloutFile.FullName
            if ($inferredMode) {
                $Mode = $inferredMode
            } else {
                Exit-PreflightFailure 'unknown_resume_mode' "无法从历史会话记录或 rollout 无损推断原权限模式（$SessionId），请显式传入 -Mode，禁止静默降级为 yolo。"
            }
        } else {
            Exit-PreflightFailure 'unknown_resume_mode' "续接会话 $SessionId 缺少本地权限记录与原生 rollout，无法推断原权限模式；请显式传入 -Mode，禁止静默沿用 yolo。"
        }
    }
    if (-not $modelExplicit -and $prevRec -and $prevRec.requestedModel) {
        $Model = [string]$prevRec.requestedModel
    }
    if (-not $effortExplicit -and $prevRec -and $prevRec.requestedEffort) {
        $Effort = [string]$prevRec.requestedEffort
    }
    if (-not $tierExplicit -and $prevRec -and $prevRec.requestedServiceTier) {
        $ServiceTier = [string]$prevRec.requestedServiceTier
    }
    if (-not $schemaExplicit -and $prevRec -and $prevRec.outputSchema) {
        $OutputSchema = [string]$prevRec.outputSchema
        if ($prevRec.structuredHandoff) { $StructuredHandoff = $true }
    }
}

if ($TaskKind -in @('review', 'plan')) {
    if ($modeExplicit -and $Mode -ne 'read-only') {
        Exit-PreflightFailure 'invalid_arguments' "TaskKind '$TaskKind' 硬锁只读模式，拒绝可写参数 -Mode '$Mode'；未启动 Codex。"
    }
    if ($WorktreeMode -eq 'required') {
        Exit-PreflightFailure 'invalid_arguments' "TaskKind '$TaskKind' 要求原位只读检查当前工作树，拒绝 -WorktreeMode required；未启动 Codex。"
    }
    foreach ($override in $ExtraConfig) {
        $key = ($override -split '=', 2)[0].Trim().Trim('"', "'").ToLowerInvariant()
        if ($key -in @('sandbox_mode', 'approval_policy', 'approvals_reviewer', 'profile') -or
            $key.StartsWith('sandbox_workspace_write.') -or
            $key.StartsWith('permission_profile.') -or
            $key.StartsWith('permissions.') -or
            $key.StartsWith('profiles.')) {
            Exit-PreflightFailure 'invalid_arguments' "TaskKind '$TaskKind' 硬锁只读模式，拒绝权限覆写参数 -ExtraConfig '$override'；未启动 Codex。"
        }
    }
    $Mode = 'read-only'
}

$resolvedSchemaPath = $null
if ($StructuredHandoff -and [string]::IsNullOrWhiteSpace($OutputSchema)) {
    $OutputSchema = Join-Path $skillRoot 'references\handoff.schema.json'
}
if (-not [string]::IsNullOrWhiteSpace($OutputSchema)) {
    if (-not (Test-Path -LiteralPath $OutputSchema -PathType Leaf)) {
        Exit-PreflightFailure 'invalid_arguments' "找不到结构化回执 Schema 文件：$OutputSchema"
    }
    $resolvedSchemaPath = (Resolve-Path -LiteralPath $OutputSchema).Path
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
        Exit-PreflightFailure 'worktree_busy' "目标隔离工作树正被另一任务占用：$effectiveProject；并行派单请为不同引擎使用独立任务名（如 codex-$Task / dsh-$Task）。"
    }
}

$cliArguments = @('exec', '-C', $effectiveProject)
if ($SkipGitRepoCheck) { $cliArguments += '--skip-git-repo-check' }
if ($SessionId) { $cliArguments += @('resume', $SessionId) }
$cliArguments += @('-c', "service_tier=`"$ServiceTier`"")
if ($ServiceTier -eq 'fast') { $cliArguments += @('-c', 'features.fast_mode=true') }
switch ($Mode) {
    'yolo' { $cliArguments += '--dangerously-bypass-approvals-and-sandbox' }
    'auto' {
        $cliArguments += @('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"')
    }
    default {
        $cliArguments += @('-c', "sandbox_mode=`"$Mode`"", '-c', 'approval_policy="never"')
    }
}
$cliArguments += @('-c', 'notify=[]', '--disable', 'default_mode_request_user_input')
foreach ($override in $ExtraConfig) { $cliArguments += @('-c', $override) }
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $cliArguments += @('--model', $Model)
}
if (-not [string]::IsNullOrWhiteSpace($Effort)) {
    $cliArguments += @('-c', "model_reasoning_effort=`"$Effort`"")
}
if ($resolvedSchemaPath) {
    $cliArguments += @('--output-schema', $resolvedSchemaPath)
}
$cliArguments += @('--json', '-o', $finalPath, '-')

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
$schemaNote = if ($resolvedSchemaPath) {
    "输出格式：严格按 --output-schema 约束的 JSON Schema 返回最终回执，不要输出多余包裹文本。`n"
} else { '' }

$prompt = @"
【$Caller → Codex 交接】任务：$Task
项目工作目录：$effectiveProject
本次处理范围：${scope}${worktreeNote}
${taskKindNote}${schemaNote}先读取工作目录及涉及路径上适用的 AGENTS.md，遵守其中的代码、验证与清理规则。
角色约束：你是执行端，严禁递归调用 codex-worker / dsh-worker 或任何外部派单脚本。
临时脚本、草稿和中间文件仅放在：$tmpDir
本次调用总超时为 $TimeoutSeconds 秒；每个构建或测试也必须有明确超时。
正常完成、失败或中止都要停止本次测试的进程树并清理无用临时文件；不要结束其他任务的进程。
调度器结束时会清理本次启动的所有后代进程，不能依赖它保留后台服务。
完成后报告改动文件、实际验证命令和结果、未完成项；只读限制下无法执行的步骤明确报告。

"@ + $rawPrompt

if ($DryRun) {
    [ordered]@{
        cli = $CodexPath; caller = $Caller; taskKind = $TaskKind
        cwd = $effectiveProject; sourceProject = $Project; worktree = $workspaceInfo
        model = if ($Model) { $Model } else { $null }
        effort = if ($Effort) { $Effort } else { $null }
        modelSource = if ($Model) { 'explicit' } else { 'codex-config' }
        mode = $Mode; serviceTier = $ServiceTier
        structuredHandoff = [bool]$StructuredHandoff
        outputSchema = $resolvedSchemaPath
        timeoutSeconds = $TimeoutSeconds; arguments = $cliArguments; promptFile = $PromptFile
    } | ConvertTo-Json -Depth 6
    exit 0
}

if (-not ('CodexDelegate.WindowsJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'WindowsJob.cs') }
$job = $null
$runner = $null
$files = @()
$copies = @()
$eventsReader = $null
$pendingEvent = ''
$exitCode = 1
$desktopUrlPrinted = $false
$desktopRegisterDone = $false
$baselineFiles = [ordered]@{ head = $null; status = $null; diff = $null; cached = $null; complete = $null }
$timer = $null

$status = [ordered]@{
    runId = $runId; task = $Task; taskKind = $TaskKind; caller = $Caller; cli = $CodexPath
    cwd = $effectiveProject; sourceProject = $Project; dir = $effectiveDir
    worktreeMode = $WorktreeMode; worktree = $workspaceInfo
    requestedModel = if ($Model) { $Model } else { $null }
    requestedEffort = if ($Effort) { $Effort } else { $null }
    requestedMode = $Mode; requestedServiceTier = $ServiceTier
    structuredHandoff = [bool]$StructuredHandoff; outputSchema = $resolvedSchemaPath
    appliedSettings = $null; serviceTierVerified = $false; settingsVerificationError = $null
    requestedSessionId = $SessionId; sessionId = if ($SessionId) { $SessionId } else { $null }
    nativeSession = if ($rolloutFile) { $rolloutFile.FullName } else { $null }
    desktopUrl = $null; sidebarRegistered = $prevSidebarRegistered; sidebarTitle = $prevSidebarTitle; sidebarError = $null
    runnerPid = $PID; workerPid = $null; cliPid = $null
    timeoutSeconds = $TimeoutSeconds; startedAt = (Get-Date).ToString('o'); finishedAt = $null
    state = 'starting'; exitCode = $null; errorKind = $null; error = $null; turnCompleted = $false
    handoff = $null; handoffRawPreview = $null
    cleanupVerified = $false; cleanupRemainingPids = @()
    baseline = $baselineFiles
    arguments = $cliArguments; prompt = $savedPromptPath; events = $eventsPath; stderr = $stderrPath
    final = $finalPath; tmpDir = $tmpDir
}

function Save-Status {
    Write-FileAtomic $statusPath ($status | ConvertTo-Json -Depth 10)
}

function Acquire-SessionLockIfUnheld([string]$Id) {
    if ($script:locked -or [string]::IsNullOrWhiteSpace($Id)) { return }
    try {
        $m = [Threading.Mutex]::new($false, "Local\CodexDelegate-$Id")
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

function Save-SessionRecord {
    if (-not $status.sessionId -or $status.sessionId -notmatch '^[0-9a-fA-F-]{36}$') { return }
    Acquire-SessionLockIfUnheld $status.sessionId
    $rec = [ordered]@{
        sessionId = $status.sessionId
        cwd = $effectiveProject
        sourceProject = $Project
        task = $Task
        taskKind = $TaskKind
        mode = $Mode
        requestedModel = if ($Model) { $Model } else { $null }
        requestedEffort = if ($Effort) { $Effort } else { $null }
        requestedServiceTier = $ServiceTier
        structuredHandoff = [bool]$StructuredHandoff
        outputSchema = $resolvedSchemaPath
        sidebarRegistered = [bool]$status.sidebarRegistered
        sidebarTitle = $status.sidebarTitle
        runId = $runId
    }
    Write-FileAtomic (Join-Path $sessionDir "$($status.sessionId).json") ($rec | ConvertTo-Json -Depth 6)
}

function Try-PublishDesktopLink([bool]$RegisterSidebar = $true, [bool]$AllowPostRun = $false) {
    if (-not $isNativeExe -or -not $status.sessionId) { return }
    if (-not $status.nativeSession) {
        $script:rolloutFile ??= Find-CodexSessionFile $status.sessionId
        if ($script:rolloutFile) {
            $script:rolloutFile.Refresh()
            if ($script:rolloutFile.Exists -and $script:rolloutFile.Length -gt 0) {
                $status.nativeSession = $script:rolloutFile.FullName
            }
        }
    }
    if (-not $status.nativeSession) { return }
    if (-not $status.desktopUrl) {
        $status.desktopUrl = "codex://threads/$($status.sessionId)"
        Save-Status
        if ($ReportStartup -and -not $script:desktopUrlPrinted) {
            $script:desktopUrlPrinted = $true
            [Console]::Error.WriteLine("CODEX_DESKTOP_URL=$($status.desktopUrl)")
        }
    }
    if ($NoDesktopRegister -or -not $RegisterSidebar -or $script:desktopRegisterDone) { return }
    if ($status.sidebarRegistered -and $status.sidebarTitle) {
        $script:desktopRegisterDone = $true
        return
    }
    $sidebarTimeout = 20
    if ($script:timer -and -not $AllowPostRun) {
        $remaining = [int][Math]::Floor($TimeoutSeconds - $script:timer.Elapsed.TotalSeconds)
        if ($remaining -lt 3) {
            $status.sidebarError = 'Skipped sidebar registration due to low remaining timeout.'
            $script:desktopRegisterDone = $true
            Save-Status
            return
        }
        $sidebarTimeout = [Math]::Min(20, [Math]::Max(2, $remaining - 1))
    } elseif ($AllowPostRun) {
        $sidebarTimeout = 10
    }
    try {
        $initPrompt = if (-not $SessionId) { $rawPrompt } else { $null }
        $entry = & (Join-Path $PSScriptRoot 'Add-CodexSidebarThread.ps1') `
            -CodexPath $CodexPath -WorkDir $effectiveProject `
            -SessionId $status.sessionId -InitialPrompt $initPrompt `
            -KeepSection:$status.sidebarRegistered -TimeoutSeconds $sidebarTimeout
        if ($null -eq $entry) {
            $status.sidebarError = 'Codex App Server cannot read the new rollout yet.'
            return
        }
        $status.sidebarRegistered = $true
        $status.sidebarTitle = $entry.Title
        $status.sidebarError = $entry.TitleError
        $script:desktopRegisterDone = $true
        Save-SessionRecord
        Save-Status
    } catch {
        $status.sidebarError = $_.Exception.Message
        $script:desktopRegisterDone = $true
        Save-Status
    }
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
            if ($event.type -eq 'thread.started' -and $event.thread_id) {
                $firstSeen = (-not $status.sessionId) -or ($SessionId -and -not $script:threadStarted)
                $script:threadStarted = $true
                $status.sessionId = $event.thread_id
                Save-SessionRecord
                if ($firstSeen) { Write-Output "会话：$($event.thread_id)" }
            }
            if ($event.type -eq 'turn.completed') { $status.turnCompleted = $true }
            if ($event.type -eq 'turn.failed') { $status.error = $event.error.message }
        }
    }
}

$threadStarted = $false

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
            worker = 'codex'; caller = $Caller; task = $Task; taskKind = $TaskKind
            runId = $runId; runnerPid = $PID; statusFile = $statusPath; eventsFile = $eventsPath
            cwd = $effectiveProject; worktreeUsed = [bool]$workspaceInfo.used
        }
        [Console]::Error.WriteLine('WORKER_STARTUP ' + ($startupPayload | ConvertTo-Json -Compress))
    }
    Write-Output "状态：$statusPath"
    Write-Output "进度：$eventsPath"
    if ($workspaceInfo.used) { Write-Output "隔离工作树：$effectiveProject ($($workspaceInfo.topology))" }
    $modelDesc = if ($Model) { $Model } else { '<codex-config>' }
    $effortDesc = if ($Effort) { $Effort } else { '<codex-config>' }
    Write-Output "任务类型：$TaskKind；模型：$modelDesc / $effortDesc；服务档位：$ServiceTier；权限：$Mode；超时：$TimeoutSeconds 秒"

    $job = [CodexDelegate.WindowsJob]::new()
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
    foreach ($argument in @('-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'CodexWorker.ps1'))) {
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
        cwd = $effectiveProject; prompt = $prompt; workerStatus = $workerStatusPath } | ConvertTo-Json -Depth 5 -Compress
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
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw [TimeoutException]::new("Codex 调用超过 $TimeoutSeconds 秒。") }
        if ($threadStarted) { Try-PublishDesktopLink -RegisterSidebar $true }
        Save-Status
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
    if ($exitCode -eq 0 -and ($status.error -or -not $status.turnCompleted -or -not (Test-Path -LiteralPath $finalPath -PathType Leaf) -or (Get-Item -LiteralPath $finalPath).Length -eq 0)) {
        $exitCode = 1
        $status.state = 'failed'
        if (-not $status.error) { $status.error = 'CLI 已退出，但缺少 turn.completed 事件或非空最终报告。' }
    }
    $stderrTail = ''
    if (Test-Path -LiteralPath $stderrPath) {
        $stderrTail = (Get-Content -LiteralPath $stderrPath -Tail 20 -Encoding utf8) -join "`n"
    }
    if ($exitCode -ne 0 -and -not $status.error -and $stderrTail) {
        $status.error = $stderrTail
    }

    $combinedErr = "$($status.error)`n$stderrTail"
    if ($combinedErr -match 'already has an active writer') {
        $status.errorKind = 'active_writer'
    } elseif ($combinedErr -match 'at capacity') {
        $status.errorKind = 'capacity'
    }

    if ($exitCode -eq 0 -and $resolvedSchemaPath -and (Test-Path -LiteralPath $finalPath -PathType Leaf)) {
        $handoffRaw = [IO.File]::ReadAllText($finalPath, $utf8NoBom)
        if (-not [string]::IsNullOrWhiteSpace($handoffRaw)) {
            try {
                $parsedHandoff = $handoffRaw | ConvertFrom-Json -ErrorAction Stop
                if ($null -eq $parsedHandoff -or -not ($parsedHandoff -is [pscustomobject])) {
                    $status.handoffRawPreview = if ($handoffRaw.Length -gt 800) { $handoffRaw.Substring(0, 800) } else { $handoffRaw }
                    $status.errorKind = 'invalid_handoff'
                    $status.error = '结构化回执顶层必须是 JSON 对象（不能为 null 或非对象字面量）。'
                    $status.state = 'failed'
                    $exitCode = 1
                } else {
                    $status.handoff = $parsedHandoff
                }
            } catch {
                $status.handoffRawPreview = if ($handoffRaw.Length -gt 800) { $handoffRaw.Substring(0, 800) } else { $handoffRaw }
                $status.errorKind = 'invalid_handoff'
                $status.error = "结构化回执 JSON 解析失败：$($_.Exception.Message)"
                $status.state = 'failed'
                $exitCode = 1
            }
        } else {
            $status.errorKind = 'invalid_handoff'
            $status.error = '结构化回执为空。'
            $status.state = 'failed'
            $exitCode = 1
        }
        if ($exitCode -eq 0 -and $null -ne $status.handoff -and $StructuredHandoff) {
            $h = $status.handoff
            $issues = [Collections.Generic.List[string]]::new()
            $qCount = if ($null -ne $h.questions) { @($h.questions).Count } else { 0 }
            $hasPerm = $null -ne $h.permission_request
            if ($h.status -notin @('done', 'needs_input', 'needs_permission')) {
                $issues.Add("未知 status：$($h.status)。")
            } elseif ($h.status -eq 'done') {
                if ($qCount -gt 0) { $issues.Add('status 为 done 时 questions 必须为空。') }
                if ($hasPerm) { $issues.Add('status 为 done 时 permission_request 必须为 null。') }
            } elseif ($h.status -eq 'needs_input') {
                if ($qCount -eq 0) { $issues.Add('status 为 needs_input 时 questions 不能为空。') }
                if ($hasPerm) { $issues.Add('status 为 needs_input 时 permission_request 必须为 null。') }
            } elseif ($h.status -eq 'needs_permission') {
                if (-not $hasPerm) { $issues.Add('status 为 needs_permission 时 permission_request 不能为 null。') }
                if ($qCount -gt 0) { $issues.Add('status 为 needs_permission 时 questions 必须为空。') }
            }
            if ($TaskKind -in @('plan', 'review') -and $null -ne $h.changed_files -and @($h.changed_files).Count -gt 0) {
                $issues.Add("只读任务 $TaskKind 的 changed_files 必须为空。")
            }
            if ($issues.Count -gt 0) {
                $status.errorKind = 'invalid_handoff'
                $status.error = '结构化回执三态校验未通过：' + ($issues -join ' ')
                $status.state = 'failed'
                $exitCode = 1
            }
        }
    }

    $status.exitCode = $exitCode
    if ($status.sessionId -and $isNativeExe) {
        try {
            $status.appliedSettings = & (Join-Path $PSScriptRoot 'Read-CodexAppliedSettings.ps1') -SessionId $status.sessionId -Since ([datetimeoffset]$status.startedAt)
            $expectedTier = if ($ServiceTier -eq 'fast') { 'priority' } else { $ServiceTier }
            $status.serviceTierVerified = $null -ne $status.appliedSettings -and $status.appliedSettings.serviceTier -eq $expectedTier
        } catch { $status.settingsVerificationError = $_.Exception.Message }
        if ($status.state -eq 'finished' -and -not $desktopRegisterDone) {
            Try-PublishDesktopLink -RegisterSidebar $true -AllowPostRun $true
        }
    }
    $status.finishedAt = (Get-Date).ToString('o')
    if (Test-Path -LiteralPath $savedPromptPath) { Save-Status }
    Release-Locks
}
if ($status.desktopUrl) { Write-Output "桌面直达：$($status.desktopUrl)" }
if ($status.error) { Write-Output "错误：$($status.error)" }
Write-Output "结束：$($status.state)，exit=$exitCode；最终报告：$finalPath"
exit $exitCode
