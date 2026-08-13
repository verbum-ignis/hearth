# Hearth now recorder

通用的短期状态记录器。它读取 Claude Code `Stop` / `PreCompact` hook 提供的
`transcript_path` 与 `session_id`，由 DeepSeek 把新增完整轮次写成第一人称 now 段。

## 生命周期

- 每天一个段桶，同一天只追加，不覆盖旧段。
- 默认读取最近 5 段：今天优先，不足时用昨天最新段补位。
- 前天退出热层；派生 now 段桶在第三天清理。原 transcript 与 Hearth 日记不受影响。
- 触发条件：50 个新完整轮次、持续活跃 3 小时、跨日后的第一批新轮次、
  `PreCompact`，任一先到。
- DeepSeek 成功且段文件原子落盘后才推进会话游标。
- `now/当前.md` 是动态投影视图；可选地自动 `meta_set(now)` 发布到 Hearth。

## 边界

- 仅在配置中显式设置 `"external_export": true` 才允许调用外部模型。
- API key 不写入源码或配置，只从环境变量或明确指定的本机 env 文件读取。
- 自动化只更新短期 `now`。日记、长期记忆、touch、anchor 均不由本程序执行。
- 首次接入一个已有长窗口时，只读取最近 50 轮，避免从窗口出生重放整份上下文。

## Hook

```json
{
  "type": "command",
  "command": "node \"...\\hearth-now\\src\\index.mjs\" hook --config \"...\\now-recorder.config.json\"",
  "timeout": 65
}
```

测试：

```powershell
node --test test/*.test.mjs
```

## 外部导出授权

默认不把任何 session 的对话发送给 DeepSeek。只有主体明确标记为 `allow` 的 session 才会生成 now：

```powershell
node "...\\hearth-now\\src\\index.mjs" policy --config "...\\now-recorder.config.json" `
  --session-id <session-id> --external-export allow
```

撤销时将末尾改为 `off`。授权记录保存在本地 `data_dir/policy.json`；它与逐字稿、段桶一样不得提交到 git。

## 发布重试

Hearth 暂时不可达时，最新 now 投影会留在本地 `publish-outbox.json`，不会重新调用 DeepSeek。网络恢复后可显式补发：

```powershell
node "...\\hearth-now\\src\\index.mjs" retry-publish --config "...\\now-recorder.config.json"
```

补发成功后才更新 `published_hash` 并清除 outbox；失败时 outbox 原样保留。

## 私用 now 抽屉提醒

提醒是可选的本地能力，配置中显式启用后才生效：

```json
{
  "reminder": {
    "enabled": true,
    "repeat_turns": 50
  }
}
```

它不自动注入 now 正文，只告知“抽屉里有未读段”。新段生成后不会立刻打断；
新窗口/压缩后提醒一次，继续经过约 50 个完整轮次仍未读时再轻提醒一次，
未读段即将被最近五段视图挤出时也会提醒。

```powershell
# Claude Code 的 SessionStart / UserPromptSubmit hook（hook JSON 从 stdin 传入）
node "...\\hearth-now\\src\\index.mjs" reminder --config "...\\now-recorder.config.json" --event session-start
node "...\\hearth-now\\src\\index.mjs" reminder --config "...\\now-recorder.config.json" --event turn

# 主体自行打开正文后
node "...\\hearth-now\\src\\index.mjs" mark-read --config "...\\now-recorder.config.json"

# 暂缓 50 个完整轮次，或今天不再提醒
node "...\\hearth-now\\src\\index.mjs" snooze --config "...\\now-recorder.config.json"
node "...\\hearth-now\\src\\index.mjs" mute-today --config "...\\now-recorder.config.json"
```

提醒只提供知情条件；打开、稍后或今日静音仍由主体决定。该能力属于私人 Hearth，
不进入黑客松演示范围。
