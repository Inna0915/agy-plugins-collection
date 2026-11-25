---
name: codex-worker
description: >-
  在 Windows 上让 Claude Code 或 Antigravity 统一委派任务给本机 Codex CLI，支持自动 Git Worktree 隔离、
  任务类型锁权（implement/review/plan）、可选结构化 JSON 回执、精确会话续接、Codex Desktop 分区登记与严审验收。
  仅在用户明确要求“交给 Codex”“用 Codex 干活”“让 Codex 审一下/出双盲方案”或调用 /codex-worker 时启用。
---

# Codex 执行助手（Claude Code & Antigravity 通用）

当前宿主（Antigravity 或 Claude Code）负责理解需求、起草交接、核对真实 Diff 并严审收口；通过本 Skill 自带调度脚本驱动本机 Codex CLI 执行。严禁手拼 `codex exec` 或使用 `--last`。

下文 `<skill-dir>` 指本 `SKILL.md` 所在目录：
- **Antigravity**：`C:/Users/OMEN/.gemini/config/plugins/worker-dispatch/skills/codex-worker`
- **Claude Code**：`C:/Users/OMEN/.claude/skills/codex-worker`
- **源码真源**：`D:/dev/github/dsh-plugins-collection/skills/codex-worker`

## 核心约定与调用入口

- **入口脚本**：`<skill-dir>/scripts/Invoke-CodexTask.ps1`（使用 PowerShell 7：`C:/Program Files/PowerShell/7/pwsh.exe` 或 `pwsh`）。
- **模型与思考档位**：**默认不传 `-Model` / `-Effort`，直接沿用 `~/.codex/config.toml` 当前配置**；仅在需要单次覆盖（如日常审查降档 `-Effort high`）时显式传入，续接自动继承上一轮覆盖项，不修改全局配置。
- **三种任务类型（`-TaskKind`）与权限**：
  - `implement`（默认）：可写模式，默认 `-Mode yolo`（避开 Windows elevated 沙箱 ACL 故障）+ **自动 Git Worktree 隔离**（单仓隔离至 `<父目录>/.worktrees/<仓库名>/<Task>`，多子仓聚合目录如 `fms269`/`fms-p275` 隔离至 `<项目>/work/alpha/worktrees/<Task>/`，不碰主工作树未提交改动）；多引擎并发写同仓须使用不同任务名（如 `codex-<task>`）。确需原位直改主工作树时传 `-NoWorktree`（建议同时加 `-CaptureBaseline` 拍首轮 4 文件 Git 基线）。
  - `review`：**硬锁 `read-only`** 且原位执行不建 Worktree，拒绝可写 `-Mode`、权限覆写 `-ExtraConfig` 与 `-WorktreeMode required`；建议配合 `-StructuredHandoff` 要求按 `[BLOCKING]` / `[ADVISORY]` 输出。
  - `plan`：**硬锁 `read-only`** 双盲方案，禁止在任务书里夹带主控草稿或倾向；建议配合 `-StructuredHandoff`。
- **Fast 档位**：仅用户明确要求加速时加 `-Fast`（等同 `-ServiceTier fast`）；续接本调度器会话自动继承，无本地记录的外部续接需显式传入；结束后核对 `status.serviceTierVerified=true` 且 `appliedSettings.serviceTier=priority`。
- **结构化回执**：传入 `-StructuredHandoff` 时自动启用 [handoff.schema.json](references/handoff.schema.json) 并做顶层对象校验与三态互斥校验（`done` / `needs_input` / `needs_permission` 及只读任务 `changed_files=[]`）；不传时兼容普通 Markdown `final.md`（仍要求 `turn.completed` 与非空报告）。
- **自动避坑加固**：脚本已内置 `-c notify=[]`、`--disable default_mode_request_user_input`、原子写 `status.json`、续接 rollout 存在性与权限漂移预检（绝不静默提权）、工作树独占锁与首轮会话锁，以及受 Windows Job Object 托管的 Codex Desktop「Codex 派单」分区登记。详见 [调用细节](references/usage.md)。

## 交接与执行流程

1. **确定工作目录与基线**：确定项目绝对路径，核对已有未提交改动与并发任务；任务书首行写清晰标题（如 `# 修复导出报表占位符`），脚本会用它命名 Codex Desktop 会话。
2. **写 UTF-8 交接文件（按宿主避坑）**：
   - **Antigravity 宿主**：用原生 `write_file` 写到当前会话 `<ArtifactDir>/scratch/<task>-r1.md`（豁免 `edit-integrity-guard`、零转义、不污染项目工作树）。
   - **Claude Code 宿主**：写到 `<项目>/work/alpha/tmp/<task>/round1.md`。
   - 交接正文应包含：目标/Why、允许范围、约束与验收标准、必须执行的验证命令及停止条件；不复制整段聊天历史。
3. **启动调度脚本**（建议带 `-ReportStartup` 立即输出启动元数据与 `codex://threads/<id>` 链接）：

```powershell
& "C:/Program Files/PowerShell/7/pwsh.exe" -NonInteractive -NoProfile -File "<skill-dir>/scripts/Invoke-CodexTask.ps1" `
  -Project "D:/projects/current-project" `
  -Task "codex-fix-receipt" `
  -TaskKind implement `
  -PromptFile "<交接文件绝对路径>" `
  -ReportStartup
```

4. **异步等待纪律（Antigravity 必守）**：
   - 调用 `run_command` 时设置 `WaitMsBeforeAsync: 10000` 与合理的 `NotificationTimeoutSeconds`（如 `600`）。
   - 若命令 10 秒内转入后台且用户需要桌面直达链接，可从 stderr 的 `WORKER_STARTUP` 取 `statusFile` 与 `runnerPid`，短跑一次 `<skill-dir>/scripts/Wait-CodexDesktopLink.ps1 -StatusFile "<statusFile>" -RunnerPid <runnerPid>` 拿到 `codex://threads/<id>` 发给用户。
   - **随后停止调用工具，等待系统完成通知自动唤醒**；严禁循环轮询 `status.json` 或重复下发。

## 严审验收、续接与收口

1. **先查运行态与错误分类**：读最终 `status.json`，确认 `state=finished`、`exitCode=0`、`cleanupVerified=true`（以及可选 `handoff` / `serviceTierVerified`）。
   - `errorKind == "active_writer"`：会话正被桌面端占用，不要死磕原会话；若仍由主控推进，沿用同一 Worktree/上下文**新开会话**。
   - `errorKind == "capacity"`：服务端满载，稍等后用原 `-SessionId` 重试，禁止擅自换模型。
   - `errorKind == "invalid_handoff"`：回执字段与状态矛盾，原 `-SessionId` 要求补齐。
2. **按红线验真实 Diff**：参考 [严审清单](references/review-rubric.md)，直接在 `status.cwd`（隔离 Worktree）核对 `git diff` 与验证输出——重点查 `[DELETE_OVERDEFENSE]`（无证据冗余判空/吞错/假想加固）与 `[MUST_FIX]`（半成品/同类漏改/未实测），并剔除免责套话。
3. **原会话精准打回**：将带 `文件:行号 + 问题 + 改法` 的返工单写入新交接文件，传 `-SessionId "<本轮UUID>"` 原会话续接（自动回到原 Worktree 并继承权限/模型覆盖）；默认最多打回 **2 轮**，尾项由主控收口。
4. **合入与清理**：在隔离 Worktree 验收完毕、合入/cherry-pick 到主工作树后，执行 `<skill-dir>/scripts/Remove-TaskWorktree.ps1 -Project "<项目>" -Task "<任务名>" [-DeleteBranch]` 回收工作树。若 `status.desktopUrl` 存在，交付时可附上 `codex://threads/<id>` 方便用户继续聊。
