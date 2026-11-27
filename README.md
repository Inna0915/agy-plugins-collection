# AGY 插件合集（agy-plugins-collection）

Antigravity（AGY 2.0）本机自研与定制插件的源码集合，目录结构与 `dsh-plugins-collection` 对齐。

## 已收录插件（来自 `~/.gemini/config/plugins/`）

| 目录 | 版本 | 类型 | 说明 | 外部依赖 / 关联 |
| --- | --- | --- | --- | --- |
| `plugins/agy-springboot-monitor` | 1.0.0 | Sidecar Web UI | 右侧栏 Spring Boot 本地服务实时监控、日志终端与一键启停/切库控制台 | 配合 `~/.agents/skills/springboot-ctl` 与全局 `sb` 命令 |
| `plugins/agy-tps-monitor` | 3.0.0 | Sidecar Web UI + Hooks + CLI | 右侧栏当前会话 TPS 速率、Token 消耗、1M 上下文点阵与缓存保鲜监控 | 本地读取 `~/.gemini/antigravity/` 会话与 transcript |
| `plugins/edit-integrity-guard` | 2.0.0 | PreToolUse Hook + Rules + Script | 兼容企业透明加密（+4096B 密文头）与 BOM/CRLF 保护的 `agy-fs.mjs` 单一写盘通道 | `hooks/guard.js` 内白名单引用了 `dsh-plugins-collection/skills/*` 派单脚本 |
| `plugins/jira-confluence-flow` | 1.0.0 | Skills (12) + MCP | 聚合 9 个 Jira Skill、3 个 Confluence Skill 与 `jira_flow` / `confluence_flow` MCP | `mcp_config.json` 指向 `D:/dev/vscode/{jira-flow,confluence-flow}/dist/cli.js`（软链到 `dsh-plugins-collection`） |
| `plugins/project-threads` | 1.0.3 | Sidecar Web UI + MCP + Hooks + Skill + Rules | 基于 `ShawnJim/antigravity-project-threads`（MIT）定制增强：常驻 `/coord` 总控 + 并发子线程看板；新增总控模型精确继承与 27 模型动态下拉框（默认 `Gemini 4 Neon (XHigh)`）、总控/线程卡片 Token(M)/压缩线/压缩次数遥测、内联预览默认折叠思考轨迹、`agy-fs.mjs` 对齐、Git 轮询缓存降频与主仓记忆自动 exclude | 配套 `edit-integrity-guard`（`.worktrees/` 拦截）与本机 `ConversationService` / `agentapi` |
| `plugins/task-progress-brief` | 2.2.0 | Rules | 全局结对搭档叙事与按需 Generative UI 规范 | 纯 `rules/AGENTS.md`，无运行时依赖 |
| `plugins/worker-dispatch` | 1.0.0 | Skills (3) | `codex-worker`、`dsh-worker` 与 `worker-orchestrator` 多引擎派单与严审闭环 | 本机线上安装目录中 3 个 `scripts`/`config` 目录当前以 junction 指向 `dsh-plugins-collection/skills/`，本仓已按实体文件完整收录 |

## 未收录的官方 Marketplace 插件

本机 `~/.gemini/config/plugins/` 中另有 4 个官方 Marketplace 安装的插件（带 `installed_version.json`），均由上游仓库维护，未重复纳入本自研源码库：

- `chrome-devtools-plugin`（v1.10.1）
- `google-antigravity-sdk`（v0.0.9）
- `google-developer-knowledge`（v1.0.3）
- `modern-web-guidance-plugin`（v1.0.6）

## 同步与明文发布注意事项

> 本机启用了企业透明文件加密驱动：`node.exe` / `pwsh.exe` 在加密授信白名单内，但 Antigravity 语言服务不在白名单内。
> - 本仓库源码文件正常走受控脚本（`agy-fs.mjs`）维护，可安全纳入 Git 版本控制；
> - 后续如需将本仓库改动反向发布回 `~/.gemini/config/plugins/`，其中的元数据/Markdown（`plugin.json`、`SKILL.md`、`AGENTS.md`、`hooks.json`、`mcp_config.json` 等）必须以明文方式（例如经 AGY 原生 `write_file`）落盘，避免被加密驱动附加密文头导致 AGY 无法解析。
