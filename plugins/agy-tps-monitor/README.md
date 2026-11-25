# AGY 会话监控（TPS & 上下文 · v3.0）

适用于 Antigravity 2.0 的极简侧边栏监控插件，专注当前会话的核心可观测指标，零外部依赖、纯本地读取 `transcript.jsonl`，兼容浅色 / 深色主题自适应。

## 功能一览（三卡片结构）

1. **推理速率 · TPS**
   - 生成速度渐变仪表盘（230° 弧形刻度）、加权平均 TPS、峰值 TPS 及相对均速偏差，旁注最近有效步的首 token 等待与生成时长。
   - 近期推理速率波动折线图（含均速参考线）。
   - 遇到重试 / 卡顿 / 异常中断时按需弹出诊断警示条。
   - **口径**：与 Artificial Analysis 的 Output Speed、vLLM / GenAI-Perf 的 TPOT 一致，生成速度 = 输出 token ÷（完成 − 首个分块到达），首 token 等待（排队 + 处理上下文）单独显示，不摊进速度。输出 token 含思考 token。
     - 时间戳取自 agy 会话库 `conversations/<id>.db` 的步骤元数据（毫秒精度，只读打开、读完即关），需要运行环境带 `node:sqlite`（Node ≥ 22.13；侧栏与状态栏扩展跑在 Antigravity 自带的 Node 24 上）。
     - 只统计输出 ≥300 token 且生成 ≥3s 的步骤：短步骤往往一两个分块就全部到达，生成窗口测不准。平均值 = 这些步骤的总输出 ÷ 总生成时间。
     - 读不到会话库（如系统 Node 20）或库内 token 数与 `transcript.jsonl` 对不上时，回退为旧的端到端速率（请求开始 → 结束，含首 token 等待），界面标注“端到端”。
2. **Token 消耗**
   - 累计总消耗环形图（支持一键在 `K/M` 缩写与精确整数之间切换，悬停联动高亮）。
   - **缓存读取 / 新增输入 / 模型输出**三项拆解与累计缓存命中率，页脚展示对话轮次、推理步数、压缩消耗及会话历时。
3. **上下文信息（CLI `/context` 风格）**
   - 按模型实际窗口（如 Gemini 4 系列 `1M`、Claude `200K`）展示当前占比，配合 **10×10 比例点阵**与右侧分项明细（系统与工具定义、历史压缩摘要、用户输入、模型回复、工具调用与返回、可压缩前余量、压缩后预留）。
   - 内嵌**缓存保鲜倒计时条**（实时倒计时、进度条与过期重算统计）。
   - 内嵌**上下文水位趋势图**（含 `~512K` 参考压缩线与距压缩预估步数）。
   - 默认折叠的**大块占用 Top 3**（定位当前阶段最吃上下文的单步操作）与按需出现的**压缩记录**（解析 `CHECKPOINT` 前后对比与释放量）。

---

## 快速安装（分享给同事）

本插件无硬编码本机路径、无需 `npm install`，解压即用：

### 1. 解压到 Antigravity 插件目录

将压缩包内的 **`agy-tps-monitor`** 整个文件夹放到本机插件目录：

- **Windows**：`%USERPROFILE%\.gemini\config\plugins\agy-tps-monitor`
  （即 `C:\Users\<你的用户名>\.gemini\config\plugins\agy-tps-monitor`）
- **macOS / Linux**：`~/.gemini/config/plugins/agy-tps-monitor`

放好后目录结构应为：

```text
~/.gemini/config/plugins/agy-tps-monitor/
├── plugin.json
├── hooks.json
├── assets/
├── cli/
├── hooks/
├── lib/
├── sidecars/tps_panel/
└── tests/
```

### 2. 启用并打开侧边栏

1. 重启 Antigravity（或新开会话），在 **Plugins / Customizations** 中确认 `agy-tps-monitor` 处于启用状态。
2. 点击右侧辅助侧边栏（Side Panel）中的 **「会话监控 · TPS & 上下文」** 标签即可打开。
3. **小技巧**：右键侧边栏该插件的标签页选择 **Pin Tab（固定标签）**，之后切换或新建会话时可常驻右侧；用 `Ctrl+Shift+B` 可随时显隐侧边栏。

### 3. （可选）终端 CLI 状态栏集成

如果同时使用 `agy` CLI，可在 `~/.gemini/antigravity-cli/settings.json` 中配置 `statusLine` 指向 `cli/statusline.cjs` 以在终端底部同步显示当前会话统计。

---

## 开发与验证

- **回归测试**：在插件目录执行 `node tests/retries.test.cjs`（需 Node.js >= 18）。
- **解耦说明**：主对话中的输出风格优化（如结对搭档进度播报）由独立插件负责，不在本插件范围内。
