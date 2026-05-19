# DataFail Monitor 自动化配置条件

| 配置项 | 当前值 | 说明 |
|--------|--------|------|
| **cron** | `0,5,10,15,20,25,30,35,40,45,50,55 * * * *` | 每 5 分钟触发一次查询 |
| **window_minutes** | `60` | 每次查询过去 60 分钟内的 DataFail 会话数 |
| **threshold** | `10` | DataFail 数量 ≥ 10 时触发告警 |

## 配置文件对应位置

| 配置项 | 文件 | 字段 |
|--------|------|------|
| cron | `.github/workflows/monitor.yml` | `on.schedule.cron` |
| window_minutes | `github-actions/config.yaml` | `monitor.window_minutes` |
| threshold | `github-actions/config.yaml` | `monitor.threshold` |

## 运行逻辑

每 5 分钟由 GitHub Actions 定时触发 → 查询 Intercom API 获取近 60 分钟内 DataFail 标签的会话数 → 数量 ≥ 10 时发送飞书告警 → 连续告警 3 次后进入 45 分钟冷却期
