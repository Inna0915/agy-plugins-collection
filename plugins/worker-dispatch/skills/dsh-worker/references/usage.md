# DSH 执行助手参数与排错（Claude Code & Antigravity 通用）

本 Skill 源码真源位于 `D:/dev/github/dsh-plugins-collection/skills/dsh-worker`，脚本经由 `scripts/` Junction 共享：
- Claude Code：`C:/Users/OMEN/.claude/skills/dsh-worker`
- Antigravity：`C:/Users/OMEN/.gemini/config/plugins/worker-dispatch/skills/dsh-worker`

## 参数列表

| 参数 | 含义 |
| --- | --- |
| `-Project` | 必填，实际项目绝对目录（别名 `-Cwd`） |
| `-Task` | 必填，短任务名，不含路径分隔符；多引擎并行写同仓时必须使用不同任务名（如 `dsh-<task>` / `codex-<task>`） |
| `-PromptFile` | 必填，UTF-8 交接文件绝对路径（AGY 建议放 `<ArtifactDir>/scratch/`，Claude 建议放 `work/alpha/tmp/<Task>/`） |
| `-TaskKind` | `implement`（默认）、`review`、`plan`。`review`/`plan` 硬锁 `read-only`，拒绝可写 `-Mode`、`-WorktreeMode required` 以及用可写原会话续接审查，并原位执行 |
| `-Mode` | 默认 `danger-full-access`（`yolo` 别名）；可选 `read-only`、`workspace-write`。续接省略时自动继承原会话权限，最终权限与原会话不符则拒绝 |
| `-Provider` / `-Model` / `-Effort` | 默认读取 `config/defaults.json`（`magpie` / `workbuddy/deepseek-v4.1-flash` / `max`）；显式传入单次覆盖 |
| `-Caller` | 调用方标签；默认自动检测 `Antigravity` / `Claude Code` / `Agent` |
| `-ReportStartup` | 启动即在 stderr 输出 `WORKER_STARTUP {...}` |
| `-CaptureBaseline` | 原位执行（`-NoWorktree`）且可写模式下，将首轮 `HEAD`/`status`/`diff`/`cached` 四份文件完整拍基线到日志目录 |
| `-TimeoutSeconds` | 默认 1800，允许 1–86400 |
| `-SessionId` | 仅限续接本流程在当前项目创建的会话（通过 `work/alpha/sessions/dsh/` 归属记录与互斥锁校验） |
| `-Dir` | 可选，项目内子目录范围；Worktree 模式下自动映射 |
| `-WorktreeMode` / `-NoWorktree` | 默认 `auto`（可写模式对单仓及多子仓聚合目录自动隔离并持工作树独占锁，`read-only` 原位执行）；`-NoWorktree` 等同 `off` |
| `-DryRun` | 打印最终参数 JSON，不调用模型、不写日志 |

## 日志与清理

- 每次调用落盘在 `<Project>/work/alpha/logs/<Task>/`：`<runId>.status.json`（原子写入）、`events.jsonl`、`stderr.log`、`final.md`、`prompt.md`、`worker.json`。
- Windows Job Object（`WindowsJob.cs`）托管完整子进程树：正常退出、失败与超时均自动终止后代进程并移除临时 `.patch.json`（核验 `cleanupVerified=true` 与 `overlayRemoved=true`）；**强制结束父进程时**，Windows Job（`KILL_ON_JOB_CLOSE`）保证终止所有后代进程，但调度器 `finally` 不会执行，临时 `.patch.json` 可能残留，需在确认进程已退出后由调用方按对应 `runId` 手动删除。
- 离线回归测试（校验调度参数、权限校验、互斥锁与进程清理；真实 DSH 沙箱强制以实弹验证记录为准）：
  ```powershell
  pwsh -NoProfile -File "<skill-dir>/scripts/tests/Test-Dispatcher.ps1" -ScratchRoot "<临时目录>"
  ```
