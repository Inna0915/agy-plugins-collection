# Edit Integrity Guard (v2.0.0)

全局受控脚本单一通道与编码/行尾完整性守护插件（专为企业透明加密环境与 Windows `CRLF` 仓库打造）。

## 解决的核心痛点

1. **企业透明加密（+4096B 密文头）兼容**：Antigravity 内置 `read_file` / `edit_file` 宿主进程不在企业透明加密白名单内，遇到加密源码会报 `binary file` 或 `charset confidence` 错误；而 `node.exe` 在授信白名单内可透明加解密。
2. **杜绝 IDE 脏缓冲区与磁盘双写覆盖**：全程禁用工作区 `edit_file` / `write_file`，避免产生未同步的 IDE 脏缓冲区与物理磁盘分叉。
3. **杜绝裸 PowerShell 编码与行尾污染**：拦截 `Set-Content`、`Out-File`、`Add-Content`、`[IO.File]::Write*`、裸重定向 `>` 与 `sed -i`，统一收口到内置的 `scripts/agy-fs.mjs` 原子补丁器（内存全量预校验 + 100% 保留原文件 BOM 与 `CRLF`/`LF` 行尾）。

## 组件构成

- `scripts/agy-fs.mjs`：内置 UTF-8 无损原子文件工具，支持 `read`、`read-many`、`apply --stdin`、`apply --spec`。
- `hooks/guard.js` + `hooks.json`：无状态 `PreToolUse` 钩子：
  - **放行（`allow`）**：`agy-fs.mjs` 读写、只读检索/测试命令、以及写入 `.gemini/` / `scratch/` / 系统临时目录（含原生 Artifact 创建）；
  - **拦截（`deny`）**：对工作区文件调用 `edit_file` / `write_file` 等 IDE 编辑工具，或执行 `Set-Content` / `Out-File` / `>` / `sed -i` 等高危裸写盘命令；
  - **询问（`ask`）**：在 `agy-fs.mjs` 之外运行的自定义 Node/Python 批处理脚本或 `git apply`。
- `rules/AGENTS.md`：全局常驻规范，指导 Agent 默认使用 `agy-fs.mjs` 完成工作区源码读取与精确编辑。
