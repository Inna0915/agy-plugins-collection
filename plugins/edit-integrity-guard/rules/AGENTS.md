# 全局代码读写与单一脚本通道强制规范（Edit Integrity Guard v2）

> **生效范围**：全局所有工作区与所有会话（由 `edit-integrity-guard` 规则与 `PreToolUse` Hook 共同强制执行）。

## 1. 核心原则：工作区全面启用 `agy-fs.mjs` 受控脚本单一通道

本机启用了企业透明文件加密驱动（约七成源码底层带 `+4096B` 密文头）：`node.exe` / `powershell.exe` 位于加密授信白名单内可透明加解密，而内置 `read_file` / `edit_file` / `write_file` 不在白名单内，读密文文件会报 `binary file` 或 `charset confidence` 错误，且混用 IDE 缓冲区与磁盘写入会导致旧内容静默回写覆盖。

因此对**工作区（Workspace）内的所有文本源码文件**，强制执行以下单一通道铁律：

1. **禁止对工作区调用 IDE 编辑工具**：严禁对工作区路径调用 `edit_file`、`write_file`、`replace_file_content`、`multi_replace_file_content`（Hook 直接 `deny`）。
2. **禁止高危裸写盘命令**：严禁使用 `Set-Content`、`Add-Content`、`Out-File`、`[IO.File]::Write*`、shell 重定向 `>` / `>>`、`sed -i`、`perl -i`、`tee` 直接写工作区文件（Hook 直接 `deny`，防止引入 UTF-8 BOM、UTF-16LE 或将 Windows `CRLF` 污染为 `LF`）。
3. **统一通过 `run_command` 调用内置 `agy-fs.mjs` 工具**（Hook 免弹窗自动放行）：
   - 固定路径：`C:/Users/OMEN/.gemini/config/plugins/edit-integrity-guard/scripts/agy-fs.mjs`

---

## 2. `agy-fs.mjs` 标准调用规范

### 2.1 读取工作区源码（优先使用，通吃密文与明文）

```powershell
# 单文件按行读取（1-based 闭区间）
node "C:/Users/OMEN/.gemini/config/plugins/edit-integrity-guard/scripts/agy-fs.mjs" read "fms/path/to/File.java" 1 200

# 多文件/多区间一次批量读取（大幅减少工具轮次）
node "C:/Users/OMEN/.gemini/config/plugins/edit-integrity-guard/scripts/agy-fs.mjs" read-many "fms/path/A.java:1-120" "fms/path/B.java:60-140"
```

### 2.2 修改 / 新建 / 删除工作区文件（全量内存预校验 + 自动保留原 BOM 与 CRLF/LF）

- **首选方式（单轮直通、零转义损耗）**：使用 PowerShell **单引号 Here-String `@' ... '@`** 管道传入 `--stdin`（单引号 `@' ... '@` 原样传递 `$`、`"`、`` ` ``、`\`，不做任何变量展开）：

```powershell
@'
{
  "ops": [
    {
      "op": "edit",
      "path": "fms/src/main/java/com/example/Demo.java",
      "edits": [
        {
          "target": "old exact lines",
          "replacement": "new exact lines"
        }
      ]
    },
    {
      "op": "write",
      "path": "fms/src/test/java/com/example/DemoTest.java",
      "overwrite": true,
      "content": "package com.example;\n..."
    }
  ]
}
'@ | node "C:/Users/OMEN/.gemini/config/plugins/edit-integrity-guard/scripts/agy-fs.mjs" apply --stdin
```

- **备选方式（超大补丁或代码内恰好含独立行 `'@` 时）**：先用原生 `write_file` 将 JSON 写入 `<ArtifactDir>/scratch/ops.json`，再执行：

```powershell
node "C:/Users/OMEN/.gemini/config/plugins/edit-integrity-guard/scripts/agy-fs.mjs" apply --spec "<ArtifactDir>/scratch/ops.json" --cleanup
```

- `edit` 默认要求 `target` 在文件中**唯一命中**；确实需要替换同一文件内所有完全相同片段时，显式传 `"allowMultiple": true`。

---

## 3. 非工作区豁免与并行隔离

1. **Artifact 与全局配置豁免**：`<appDataDir>/brain/<conversation-id>/`（含 `.md` 报告、内嵌 `.html` 微视图、`scratch/` 临时目录）及 `~/.gemini/` 不属于工作区文件——创建/更新会话 Artifact **必须继续使用原生 `write_file` / `edit_file` 并提供 `ArtifactMetadata`**；读取图片、PDF 或 `~/.gemini/` 下的 `SKILL.md` 正常使用 `read_file`。
2. **自定义全库批处理脚本**：全库百余处同构 AST/正则机械替换如确需在 `scratch/` 编写自定义 Node/Python 脚本，必须逐文件探测并保留原始 BOM 与 `CRLF`/`LF` 行尾（Hook 会触发 `ask` 由用户确认后放行）。
3. **并发子代理隔离**：需要多个可写子代理（`TypeName: "self"`）并行修改代码时，显式设置 `Workspace: "share"` 或 `"branch"`，避免并发写同一文件。
