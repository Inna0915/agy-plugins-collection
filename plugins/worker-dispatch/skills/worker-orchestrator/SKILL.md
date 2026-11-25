---
name: worker-orchestrator
description: >-
  Claude Code 与 Antigravity 通用的多引擎任务总控编排指南：按任务特性在 AGY 原生子代理、
  Codex（codex-worker）与 DSH（dsh-worker）之间合理分工，统一走隔离工作树、三态任务模式
  （implement/review/plan）、异构交叉复核与 2 轮熔断闭环。仅在用户要求多引擎协作、派单干活、
  交叉复核或双盲方案时启用。
---

# 多引擎总控编排（AGY / Claude Code → Subagent · Codex · DSH）

顶层主控（Antigravity 或 Claude Code）负责需求拆解、分工派单、对照真实 `git diff` 严审和最终交付；严禁在无需求时无故派单，也严禁允许任何执行端递归再派单。

## 一、什么时候用哪个执行端

| 执行端 | 适用场景 | 隔离与驱动方式 |
| :--- | :--- | :--- |
| **AGY 原生子代理**（仅 AGY 宿主） | 全仓只读调研（`research`）、前端样式/交互/文案、多文件并行扇出、轻量独立二次复核 | 直接用 `invoke_subagent` / `swarm` / `run_workflow`；**写代码必传 `Workspace: "share"`**，只读复核用 `inherit`；**严禁手写脚本拉外部 `agy` 进程** |
| **Codex**（`codex-worker`） | 复杂后端逻辑、难缠 Bug 根因排查、**主控改码后的只读反向审查**、**重大架构/公共接口双盲方案** | 调 `codex-worker` 的 `Invoke-CodexTask.ps1`；写码自动 Git Worktree 隔离；`review`/`plan` 硬锁 `read-only`，建议加 `-StructuredHandoff` |
| **DSH**（`dsh-worker`） | 高性价比大块业务代码、大批量单测/文档补全、或作为独立第三视角做 `review`/`plan` | 调 `dsh-worker` 的 `Invoke-DshTask.ps1`；同样自动 Git Worktree 隔离；`review`/`plan` 硬锁 `read-only` |

**分工底线**：
- 几十行小改、修零碎审查尾项、边看页面边调样式/文案 → 主控直接做，不绕路派单。
- 需要多引擎**并发写同一仓库**时（例如 Codex 改后端 + DSH 补测试 + AGY 子代理调前端），必须各走独立隔离工作树（Codex/DSH 默认 `WorktreeMode=auto`，AGY 子代理 `Workspace: "share"`），**并且为每个引擎分配不同 `-Task` 任务名（如 `codex-<task>`、`dsh-<task>`）**；调度器会对目标 Worktree 加独占锁防止同名撞车。

## 二、三种标准协作闭环

1. **实现闭环（`-TaskKind implement`）**
   - 写清目标/Why、允许范围、边界约束、必须执行的验证命令与停止条件（任务书首行写清晰标题）。
   - 派单后等待完成，直接在隔离 Worktree（`status.cwd`）核对真实 `git diff` 与验证输出。
   - 对照 `codex-worker/references/review-rubric.md` 严查两大红线：`[DELETE_OVERDEFENSE]`（无证据冗余判空/吞错/假想加固）与 `[MUST_FIX]`（只盖症状、同类漏改、半成品、推卸验证）。
   - 不通过则写逐条可执行的返工单，用原 `-SessionId` 续接打回；**默认最多打回 2 轮**，剩余尾项由主控直接收口。
   - 验收通过后按顺序合入/cherry-pick 回主工作树，再调 `Remove-TaskWorktree.ps1` 回收 Worktree。

2. **异构反向审查（`-TaskKind review`）**
   - 主控自己改完代码后，派 Codex（推荐带 `-StructuredHandoff`，日常审查可降思考档 `-Effort high`）或 DSH 原位只读审真实 Diff（切勿传 `-WorktreeMode required`，也不要把已有可写会话直接续接为 `review`）。
   - 要求发现按 `[BLOCKING]` / `[ADVISORY]` 分级，并给出 `文件:行号` 与可达触发路径。
   - 主控逐条核实真实代码：只修有实证的 `[BLOCKING]` 项，**无法复现或上游契约已保证的建议直接过滤，绝不为了迁就审查堆多余防御代码**。复审用原 `-SessionId`，最多 2 轮。

3. **双盲独立方案（`-TaskKind plan`）**
   - 仅用于公共接口变更、数据存储设计、跨模块架构取舍或复杂排障。
   - 任务书只放中性需求、代码基线与验收目标，**严禁夹带主控自己的草稿或倾向**；主控须在查看外部结果前先定下自己的独立初稿。
   - 两稿齐后以真实代码为准逐条合并，标出「一致项 / 采纳对方 / 保留主控 / 需用户拍板的分歧」。

## 三、Antigravity 侧必守避坑铁律

1. **交接文件落盘路径**：AGY 宿主统一用原生 `write_file` 将任务书写到当前会话 `<ArtifactDir>/scratch/<task>-rN.md`（豁免 `edit-integrity-guard`、零转义、不污染目标仓库）；Claude Code 宿主写到 `<项目>/work/alpha/tmp/<task>/roundN.md`。
2. **后台异步等待**：AGY 调 `run_command` 跑派单脚本时使用 `& "C:/Program Files/PowerShell/7/pwsh.exe" -NonInteractive -NoProfile -File ...`，设 `WaitMsBeforeAsync: 10000` + `NotificationTimeoutSeconds: 600` 并带 `-ReportStartup`。若 Codex 10 秒内转后台且需立即给用户发桌面直达链接，可短跑一次 `Wait-CodexDesktopLink.ps1`；随后**停止调用工具等待系统完成通知唤醒，严禁循环轮询 `status.json`**。
3. **防套娃递归**：所有派单脚本已在交接头注入“严禁递归派单”约束；下发给 AGY 原生 `subagent` 时也必须明确禁止其再调外部 worker 脚本。
4. **错误分级处置**：遇到 `active_writer`（桌面占用）不死磕原会话，沿用工作树新开会话；遇到 `capacity`（服务端满载）稍等后用原 `-SessionId` 重试，绝不擅自换模型；遇到 `worktree_busy` 则更换独立 `-Task` 名称。
