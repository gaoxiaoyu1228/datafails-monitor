# DataFail 会话标签监控系统

## 概述

持续监控 Intercom 平台中 **DataFail** 标签的会话数量。每 5 分钟调用 Intercom Search API 统计近 1 小时内新增的该类会话数，一旦达到可配置阈值，通过飞书群聊机器人 Webhook 发送告警卡片消息。

## 业务背景

- **监控对象**：Intercom 平台上被标注为 `DataFail` 的会话
- **监控窗口**：近 60 分钟（可配置）
- **告警条件**：会话数 ≥ 阈值（默认 10，目前测试期设为 1）
- **通知渠道**：飞书群聊机器人 → 卡片消息
- **告警冷却**：5 分钟内不重复发送（防止同一波数据反复告警）

---

## 架构

```
┌─────────────────────────────────────────────────┐
│  GitHub Actions (每 5 分钟 / 手动触发)            │
│                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌────────┐  │
│  │ Secrets  │───▶│ monitor.py   │───▶│ 飞书群 │  │
│  │ Token    │    │              │    │ Webhook│  │
│  │ Webhook  │    │ 查询 Intercom │    │ 卡片   │  │
│  └──────────┘    └──────────────┘    └────────┘  │
│                        │                         │
│                  ┌─────┴─────┐                   │
│                  │ state.json │  ← 防重复告警     │
│                  └───────────┘                   │
└─────────────────────────────────────────────────┘
```

### 涉及的外部系统

| 系统 | 用途 | 凭据 |
|------|------|------|
| Intercom REST API | 查询会话数量 | Access Token |
| 飞书群聊机器人 | 接收告警消息 | Webhook URL |
| GitHub Actions | 定时运行脚本 | 无（私有仓库） |

### 安全模型

- 所有敏感凭证通过 **GitHub Secrets** 加密存储
- 运行时以环境变量注入，脚本内不做持久化
- 推荐使用**私有仓库**，避免工作流日志被外部访问

---

## 项目文件

```
datafails-monitor/
├── monitor.py          # 主脚本（支持 3 种运行模式）
├── config.yaml         # 可配置参数（非敏感）
├── requirements.txt    # Python 依赖
├── state.json          # 告警状态（自动管理，GitHub Actions 自动提交）
├── api.md              # API 参考 & Tag 信息
├── IMPLEMENTATION.md   # ← 本文件
└── .github/
    └── workflows/
        └── monitor.yml # GitHub Actions 工作流定义
```

---

## 配置参考（config.yaml）

```yaml
intercom:
  access_token: ""   # 留空即可，由 GitHub Secrets 注入

monitor:
  tag_id: "11659240"       # DataFail 标签 ID
  window_minutes: 60       # 统计时间窗口（分钟）
  threshold: 10            # 告警阈值（当前测试中设为 1）
  cooldown_minutes: 5      # 冷却期（分钟内不重复告警）

webhook:
  url: ""           # 留空即可，由 GitHub Secrets 注入
```

所有敏感值优先从环境变量读取：
- `INTERCOM_ACCESS_TOKEN` — 覆盖 `intercom.access_token`
- `FEISHU_WEBHOOK_URL` — 覆盖 `webhook.url`

---

## 运行模式

### 模式一：完整运行（定时 + 手动）

```bash
python3 monitor.py
```

- 查询 Intercom → 判断阈值 → 达到则发飞书 Webhook → 更新 state.json
- GitHub Actions 每 5 分钟自动执行一次

### 模式二：仅查询（自由态）

```bash
python3 monitor.py --check
```

- 仅查询近 1 小时的 DataFail 会话数量并打印
- **不发送** Webhook，**不更新** state.json
- 适用于手动排查、调试、日常查阅

### 模式三：测试 Webhook

```bash
python3 monitor.py --mock
```

- 向飞书群发送一条明显的橙色测试卡片（标注"MOCK 测试"）
- 用于验证 Webhook 链路是否畅通

---

## GitHub Actions

### 定时触发

```yaml
on:
  schedule:
    - cron: "*/5 * * * *"  # 每 5 分钟
```

注意：GitHub Actions 最小调度间隔为 5 分钟。如果需要更频繁（如 2 分钟），需改用其他方案（见文末备选方案）。

### 手动触发

在 GitHub 仓库页面 → **Actions** → **DataFail Monitor** → **Run workflow**，可选择：
- `run` — 完整运行
- `check` — 仅查询
- `mock` — 发送测试消息

### 所需 Secrets

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret 名称 | 值 |
|-------------|-----|
| `INTERCOM_ACCESS_TOKEN` | Intercom API Access Token |
| `FEISHU_WEBHOOK_URL` | 飞书群聊机器人 Webhook 地址 |

### state.json 持久化

当告警触发时，工作流会将更新后的 `state.json` 自动 commit 回仓库。不触发告警时不产生 commit，保持仓库干净。

---

## 首次部署步骤

### 1. 创建私有 GitHub 仓库

```bash
cd "/Users/bot-xiaoyu/Desktop/datafails 监控"
git init
git add monitor.py config.yaml requirements.txt state.json api.md .github/
git commit -m "init: DataFail monitor"
gh repo create datafails-monitor --private --source=. --push
```

### 2. 配置 Secrets

在 GitHub 仓库页面的 Settings → Secrets → Actions 中添加：
- `INTERCOM_ACCESS_TOKEN`
- `FEISHU_WEBHOOK_URL`

### 3. 触发首次运行

GitHub → Actions → DataFail Monitor → Run workflow → 选择 `mock` → 确认飞书群收到测试消息。

### 4. 验证定时运行

等待 5 分钟后，在 Actions 页面确认自动执行成功。

---

## 日常运维

### 查看当前数据

在 GitHub Actions 中手动触发 `check` 模式，或本地运行：

```bash
python3 monitor.py --check
```

### 修改阈值

编辑 `config.yaml` 中的 `monitor.threshold`，提交即可。下次定时执行自动生效。

### 修改时间窗口

编辑 `config.yaml` 中的 `monitor.window_minutes`（单位：分钟）。

### 更换监控的标签

1. 获取新标签的 ID：`GET https://api.intercom.io/tags`
2. 更新 `config.yaml` 中的 `monitor.tag_id`
3. 提交

### 查看告警历史

- `state.json` 中的 `last_alert_time` 记录了上次告警的 Unix 时间戳
- 仓库 commit 历史中的 `chore: update monitor state` 即为每次告警触发记录

---

## 故障排查

| 症状 | 可能原因 | 排查方式 |
|------|---------|---------|
| 工作流未执行 | GitHub Actions 被禁用 | 检查仓库 Actions 页面是否启用 |
| Intercom API 403 | Token 过期 | 检查 Secrets 中的 Token 是否有效 |
| 飞书群收不到消息 | Webhook URL 失效 | 用 `--mock` 模式测试 |
| 频繁重复告警 | 冷却期太短 | 增大 `cooldown_minutes` |
| 定时间隔不准 | GitHub Actions 排队 | 正常现象，间隔 5-8 分钟波动 |

### 本地调试

```bash
# 测试 Intercom 连接
python3 monitor.py --check

# 测试飞书 Webhook
python3 monitor.py --mock

# 完整运行（会真的发告警）
python3 monitor.py
```

本地运行时，需先在 `config.yaml` 中填入真实的 `access_token` 和 `webhook.url`，或通过环境变量传入。
