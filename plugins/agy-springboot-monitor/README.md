# AGY Spring Boot 服务监控（`agy-springboot-monitor` · v1.0）

适用于 Antigravity 的右侧边栏 Spring Boot 本地服务实时监控与启停控制台插件，零 `npm install`、零外部依赖，自适应亮色 / 暗色主题。

## 核心功能

1. **实时监控本机所有活跃 Spring Boot / Java 服务**（每 2.5s 非阻塞刷新）：
   - 自动融合 `sb 托管`、IntelliJ IDEA 启动及手动启动的 Java 进程；
   - 展示状态（`UP` / `编译中` / `启动中` / `停止中` / `启动失败`）、PID、真实监听端口与访问地址、内存占用、运行时长、Profile、本地源码模块数，以及独立分行的 `DB` / `ES` / `ESLog`。
2. **默认展开的全高自适应日志终端**：
   - 自动撑满侧边栏宽度与剩余高度，支持多服务标签切换、关键词实时过滤、`仅报错`（`ERROR / Exception / Caused by`）、自动换行切换、一键全屏日志与自动跟随亮/暗色主题。
3. **一键启动 / 重启 / 优雅停机**：
   - 右上角 `+ 启动` 抽屉支持自动扫描项目工作区、点击切换本地模块 POM（源码 vs `.m2`）、下拉选择 `application*.yml` 中当前生效或注释掉的数据库与独立的业务 ES / 日志 ES、自动顺延端口（`30030 -> 30031 -> 30032`）。
   - 支持两阶段优雅停机（先通过本地 JMX `SpringApplicationAdminMXBean.shutdown()` 优雅关停 Spring 上下文，超时再兜底清理进程树）。

## 安装方式

请使用发行包根目录的 `install.ps1` 一键安装（会同时安装依赖的 `springboot-ctl` Skill、全局 `sb` 命令及本 AGY 侧边栏插件）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装完成后，在 Antigravity 右侧边栏点击 `+` 号选择 **「Spring Boot 服务监控」**，右键标签 **Pin Tab** 即可常驻。
