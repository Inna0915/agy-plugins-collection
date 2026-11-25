# Fast 和权限

> 历史基线注记：2026-10-24 在本机 Codex `0.163.0-alpha.10.2` 验证了新建与续接的 `-Fast` 参数顺序（当时以 `gpt-6.1-sol / max` 测试）。当前调度器默认不传 `-Model`/`-Effort` 以沿用 `~/.codex/config.toml`，下述参数位置与 `serviceTierVerified` 核验契约继续适用。

## 推荐入口

```powershell
& 'C:/Program Files/PowerShell/7/pwsh.exe' -NonInteractive -NoProfile -File `
  '<skill-dir>/scripts/Invoke-CodexTask.ps1' `
  -Project 'D:/repo' -Task 'example' -PromptFile '<交接文件绝对路径>' -Fast
```

- **续接继承规则**：
  - 续接**本调度器在同一项目创建的会话**（存在 `work/alpha/sessions/codex/<UUID>.json`）时，不传 `-ServiceTier`/`-Fast` 会自动继承上一轮 `requestedServiceTier`；需要显式切换回普通档位时传 `-ServiceTier default`。
  - 续接**无本地调度记录的外部会话**时，不会自动推断 Fast 档位，需按需显式传 `-Fast` 或 `-ServiceTier default`。
- 支持其他档位的参数不等于账号一定有权限；请求被拒绝时不得偷偷降档或换模型。

原生 CLI 等价结构（工作目录由 `-C` 指定，提示词通过 stdin）：

```powershell
# 新建
codex exec -C 'D:/repo' --dangerously-bypass-approvals-and-sandbox `
  -c 'features.fast_mode=true' -c 'service_tier="fast"' --json -

# 续接：把配置参数放到 resume 子命令之后
codex exec -C 'D:/repo' resume '精确UUID' `
  --dangerously-bypass-approvals-and-sandbox `
  -c 'features.fast_mode=true' -c 'service_tier="fast"' --json -
```

## 核实实际设置

调度器结束时只读检查本轮时间范围内的原生 rollout，将最新 `thread_settings_applied` 保存到 `status.appliedSettings`。`serviceTierVerified` 检查它是否符合请求；Fast 对应 `priority`。该事件缺失、老版本不支持或日志读取失败时，结果为未核实，不伪装成功。

运行中的 status 尚未填写这些结束后核对字段，不能把此时的 `false` 当作 Fast 失败；运行中需要核对时使用 `scripts/Read-CodexAppliedSettings.ps1 -SessionId UUID -Since <本轮 startedAt>`。

## 权限故障处理

本机此前失败在 elevated 沙箱设置 Windows ACL 的步骤；当前可写实现任务按用户授权默认 `yolo` + 自动 Git Worktree 隔离，`review`/`plan` 任务硬锁 `read-only` 并原位执行。详见 [原始诊断](windows-sandbox-issue-20261024.md)。
