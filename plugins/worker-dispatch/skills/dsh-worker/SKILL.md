---
name: dsh-worker
description: >-
  在 Windows 上让 Claude Code 或 Antigravity 统一委派任务给本机 DSH（DeepSeek Harness）headless CLI，
  支持自动 Git Worktree 隔离、任务类型锁权（implement/review/plan）、精确会话续接与严审验收。
  仅在用户明确要求“让 DSH 干活”“交给 DeepSeek Harness”或调用 /dsh-worker 时启用。
---

# DSH 执行助手（Claude Code & Antigravity 通用）

当前宿主（Antigravity 或 Claude Code）负责理解需求、起草交接与严审收口；DSH headless CLI 负责执行。

下文 `<skill-dir>` 指本 `SKILL.md` 所在目录：
- **Antigravity**：`C:/Users/OMEN/.gemini/config/plugins/worker-dispatch/skills/dsh-worker`
- **Claude Code**：`C:/Users/OMEN/.claude/skills/dsh-worker`
- **源码真源**：`D:/dev/github/dsh-plugins-collection/skills/dsh-worker`

## 核心约定与调用入口

- **入口脚本**：`<skill-dir>/scripts/Invoke-DshTask.ps1`（使用 PowerShell 7：`pwsh` 或 `C:/Program Files/PowerShell/7/pwsh.exe`；脚本已指定本机 Node 24，勿直接调系统 Node 20 shim）。
- **默认值**：来自 `config/defaults.json`（`magpie / workbuddy/deepseek-v4.1-flash / max`）；通过 `-Provider`、`-Model`、`-Effort` 单次覆盖，不修改全局配置。
- **三种任务类型（`-TaskKind`）与权限**：
  - `implement`（默认）：默认 `danger-full-access`、审批 `never` + **自动 Git Worktree 隔离**（单仓隔离至 `<父目录>/.worktrees/<仓库名>/<Task>`，多子仓聚合目录如 `fms269`/`fms-p275` 隔离至 `<项目>/work/alpha/worktrees/<Task>/`）；多引擎并发写同仓须使用不同任务名（如 `dsh-<task>`）。确需原位直改主工作树时传 `-NoWorktree`（建议加 `-CaptureBaseline`）。
  - `review`：**硬锁 `read-only`** 且原位执行不建 Worktree，拒绝可写 `-Mode`、`-WorktreeMode required` 以及用可写原会话续接审查；要求按 `[BLOCKING]` / `[ADVISORY]` 输出。
  - `plan`：**硬锁 `read-only`** 独立方案，禁止在任务书中夹带主控草稿或倾向。
- **自动避坑加固**：脚本已支持自动识别宿主 `Caller`、原子写 `status.json`、首行 `WORKER_STARTUP` 输出、归属记录与权限锁定（续接省略 `-Mode` 自动继承原权限，目标权限与原会话不符则拒绝）、工作树独占锁与首轮会话锁，以及 Windows Job Object 全树进程回收。

## 交接与执行流程

1. **确定工作目录与基线**：确定项目绝对路径，检查已有未提交修改；不要接管正在运行的桌面会话，避免并发修改同一文件。
2. **写 UTF-8 交接文件（按宿主避坑）**：
   - **Antigravity 宿主**：用原生 `write_file` 写到当前会话 `<ArtifactDir>/scratch/<task>-r1.md`（豁免 `edit-integrity-guard`、不污染项目目录）。
   - **Claude Code 宿主**：写到 `<项目>/work/alpha/tmp/<task>/round1.md`。
   - 正文包含目标、允许范围、验收标准、必须执行的验证命令及停止条件。
3. **启动调度脚本**：

```powershell
& "C:/Program Files/PowerShell/7/pwsh.exe" -NonInteractive -NoProfile -File "<skill-dir>/scripts/Invoke-DshTask.ps1" `
  -Project "D:/projects/current-project" `
  -Task "dsh-fix-receipt" `
  -TaskKind implement `
  -PromptFile "<交接文件绝对路径>" `
  -ReportStartup
```

4. **异步等待纪律（Antigravity 必守）**：
   - 调用 `run_command` 时设置 `WaitMsBeforeAsync: 10000` 与 `NotificationTimeoutSeconds`（如 `600`）。
   - 转后台后直接停止调用工具等待系统完成通知自动唤醒，**严禁循环轮询 `status.json` 或重复下发**。

## 验收、续接与清理

- 检查 `status.json` 中 `state=finished`、`exitCode=0`、`turnCompleted=true`、`cleanupVerified=true`、`overlayRemoved=true` 和非空 `final.md`。
- 在隔离工作树（`status.cwd`）核对真实 `git diff` 与测试输出（严审红线同 `codex-worker/references/review-rubric.md`）；需要返工时写新交接文件，传入本轮精确 `-SessionId` 续接（自动回到原 Worktree 并继承权限，最多打回 2 轮）。
- 验收完毕并合入/cherry-pick 回主工作树后，执行 `<skill-dir>/scripts/Remove-TaskWorktree.ps1 -Project "<项目>" -Task "<任务名>" [-DeleteBranch]` 清理工作树。强杀父进程时 Windows Job 保证终止全部后代进程，但临时 `.patch.json` 可能残留，确认进程退出后按 `runId` 清理即可。详见 [参数、日志与排错](references/usage.md)。
