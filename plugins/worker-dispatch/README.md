# Worker Dispatch（Antigravity & Claude Code 统一派单插件）

本目录是 `D:/dev/github/dsh-plugins-collection` 的 Antigravity 2.0 挂载模板；在启用企业透明加密驱动的 Windows 主机上采用「明文元数据 + 代码 Junction 真源」双层发布：

## 1. 脚本与配置 Junction（由 `Sync-Links.ps1` 自动同步）

以下 3 个目录通过 `pwsh -NoProfile -File scripts/Sync-Links.ps1 -Apply` 软链指向仓库真源（`pwsh.exe` / `node.exe` 在加密白名单内可透明执行）：
- `~/.gemini/config/plugins/worker-dispatch/skills/codex-worker/scripts` → `skills/codex-worker/scripts`
- `~/.gemini/config/plugins/worker-dispatch/skills/dsh-worker/scripts` → `skills/dsh-worker/scripts`
- `~/.gemini/config/plugins/worker-dispatch/skills/dsh-worker/config` → `skills/dsh-worker/config`

## 2. 明文元数据与文档清单（需经 AGY 原生 `write_file` 发布）

由于 Antigravity 语言服务不在加密白名单内，以下 11 份元数据/文档文件不能走 `Sync-Links.ps1` 或 PowerShell 复制，更新源仓库后须通过 AGY 原生 `write_file` 同步明文至 `~/.gemini/config/plugins/worker-dispatch/` 并按统一换行校验一致：
1. `plugins/worker-dispatch/plugin.json` → `plugin.json`
2. `plugins/worker-dispatch/README.md` → `README.md`
3. `plugins/worker-dispatch/assets/logo.svg` → `assets/logo.svg`
4. `skills/codex-worker/SKILL.md` → `skills/codex-worker/SKILL.md`
5. `skills/codex-worker/references/handoff.schema.json` → `skills/codex-worker/references/handoff.schema.json`
6. `skills/codex-worker/references/review-rubric.md` → `skills/codex-worker/references/review-rubric.md`
7. `skills/codex-worker/references/usage.md` → `skills/codex-worker/references/usage.md`
8. `skills/codex-worker/references/fast-and-permissions.md` → `skills/codex-worker/references/fast-and-permissions.md`
9. `skills/dsh-worker/SKILL.md` → `skills/dsh-worker/SKILL.md`
10. `skills/dsh-worker/references/usage.md` → `skills/dsh-worker/references/usage.md`
11. `skills/worker-orchestrator/SKILL.md` → `skills/worker-orchestrator/SKILL.md`
