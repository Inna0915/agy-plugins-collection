# 调用细节（Claude Code & Antigravity 通用）

本 Skill 源码真源位于 `D:/dev/github/dsh-plugins-collection/skills/codex-worker`，脚本经由 `scripts/` Junction 共享：
- Claude Code：`C:/Users/OMEN/.claude/skills/codex-worker`
- Antigravity：`C:/Users/OMEN/.gemini/config/plugins/worker-dispatch/skills/codex-worker`

## 参数列表

| 参数 | 含义 |
| --- | --- |
| `-Project` | 必填，实际项目绝对目录（别名 `-Cwd`），不会自动切换到其他 Git 根 |
| `-Task` | 必填，短任务名，支持中文、字母、数字、下划线、连字符、点号；多引擎并行写同仓时必须使用不同任务名（如 `codex-<task>` / `dsh-<task>`） |
| `-PromptFile` | 必填，UTF-8 交接文件绝对路径（AGY 建议放 `<ArtifactDir>/scratch/`，Claude 建议放 `work/alpha/tmp/<Task>/`） |
| `-TaskKind` | `implement`（默认）、`review`、`plan`。`review`/`plan` 硬锁 `read-only`，拒绝可写 `-Mode`、权限覆写 `-ExtraConfig` 与 `-WorktreeMode required`，并原位执行 |
| `-Mode` | 默认 `yolo`（`danger-full-access` 别名）；可选 `read-only`、`workspace-write`、`auto`。续接未传时按本地会话记录与原生 rollout 一致性校验继承原权限，无法无损还原或发生漂移时直接报 `unknown_resume_mode`，绝不静默提权 |
| `-Model` / `-Effort` | 可选；默认不传以沿用 `~/.codex/config.toml` 当前配置；显式传入时本次与续接均生效 |
| `-Fast` / `-ServiceTier` | `-Fast` 等同 `-ServiceTier fast`；默认 `default`。续接**本调度器创建的会话**（存在本地会话记录）时默认继承上一轮 `requestedServiceTier`；续接无本地记录的外部会话时需显式传 `-Fast` |
| `-StructuredHandoff` | 启用内置 `references/handoff.schema.json` 11 字段强结构化回执，校验顶层为对象且三态互斥（`done` / `needs_input` / `needs_permission`） |
| `-OutputSchema` | 自定义 JSON Schema 路径（不传时配合 `-StructuredHandoff` 使用内置 Schema） |
| `-Caller` | 调用方标签；默认自动检测 `Antigravity` / `Claude Code` / `Agent` |
| `-ReportStartup` | 启动即在 stderr 输出 `WORKER_STARTUP {...}`，会话就绪后输出 `CODEX_DESKTOP_URL=codex://threads/<id>` |
| `-NoDesktopRegister` | 仅跳过 Codex Desktop「Codex 派单」分区登记，不影响 `desktopUrl` 生成与 `Wait-CodexDesktopLink.ps1` |
| `-CaptureBaseline` | 原位执行（`-NoWorktree`）且可写模式下，将首轮 `HEAD`/`status`/`diff`/`cached` 四份文件完整拍基线到日志目录 |
| `-TimeoutSeconds` | 默认 1800，允许 1–86400 |
| `-SessionId` | 明确的会话 UUID；续接前校验原生 rollout 存在性，不使用 `--last` |
| `-Dir` | 可选，项目内子目录范围；启用 Worktree 时自动映射 |
| `-WorktreeMode` / `-NoWorktree` | 默认 `auto`（可写模式对单仓及多子仓聚合目录建 Worktree 并持工作树独占锁，`read-only` 原位执行）；`-NoWorktree` 等同 `off` |
| `-CodexPath` | 可选，显式指定 `.exe` 或 `.ps1`；默认按 PATH `codex.exe` → npm `@openai/codex` vendor `codex.exe` → `%LOCALAPPDATA%\OpenAI\Codex\bin` 解析 |
| `-SkipGitRepoCheck` | 仅用于已确认的非 Git 目录 |
| `-DryRun` | 打印最终参数 JSON，不启动模型、不写日志 |

## 日志与状态

每次调用生成唯一 `codex-<时间>-<随机后缀>`，全部落盘在 `<Project>/work/alpha/logs/<Task>/`：
- `<runId>.status.json`（原子替换写入，含 `state`、`exitCode`、`errorKind`、`sessionId`、`desktopUrl`、`worktree`、`handoff`、`appliedSettings`、`cleanupVerified`）
- `<runId>.events.jsonl`（无缓冲实时事件流）
- `<runId>.stderr.log` / `<runId>.final.md` / `<runId>.prompt.md` / `<runId>.worker.json`

## 进程清理与离线回归测试

- 调度器及桌面侧栏登记进程均由 Windows Job Object（`WindowsJob.cs`）托管；正常退出、失败、超时（124）或强杀父进程均保证回收后代进程（`cleanupVerified=true`），普通回执同时要求 `turn.completed` 事件与非空报告。
- 修改脚本后执行离线回归测试（不调用真实模型，负责校验调度参数、互斥锁、结构化回执与进程清理；真实 CLI 沙箱强约束以实际实弹校验的 `appliedSettings` 为准）：
  ```powershell
  pwsh -NoProfile -File "<skill-dir>/scripts/tests/Test-Dispatcher.ps1" -ScratchRoot "<临时目录>"
  ```
