#!/usr/bin/env python3
"""
DATAFAILS tag monitor — polls Intercom Search API and alerts via Feishu webhook.

Usage:
    python3 monitor.py              # Full run: query + alert if threshold met
    python3 monitor.py --check      # Check only: print count, no webhook, no state update
    python3 monitor.py --mock       # Send a test webhook message to verify the Feishu link
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests
import yaml

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.yaml")
STATE_PATH = os.path.join(SCRIPT_DIR, "state.json")

INTERCOM_SEARCH_URL = "https://api.intercom.io/conversations/search"


def load_config():
    with open(CONFIG_PATH, "r") as f:
        cfg = yaml.safe_load(f)

    # env vars override config.yaml values (for GitHub Secrets workflow)
    cfg.setdefault("intercom", {})
    cfg.setdefault("webhook", {})
    cfg["intercom"]["access_token"] = os.environ.get(
        "INTERCOM_ACCESS_TOKEN", cfg["intercom"].get("access_token", "")
    )
    cfg["webhook"]["url"] = os.environ.get(
        "FEISHU_WEBHOOK_URL", cfg["webhook"].get("url", "")
    )

    required = {
        "intercom.access_token": cfg["intercom"].get("access_token"),
        "monitor.tag_id": cfg.get("monitor", {}).get("tag_id"),
        "webhook.url": cfg["webhook"].get("url"),
    }
    missing = [k for k, v in required.items() if not v or "your_" in str(v) or "xxxxxxxxx" in str(v)]
    if missing:
        print(f"[ERROR] 缺少有效值: {', '.join(missing)}")
        print("  可通过环境变量 INTERCOM_ACCESS_TOKEN / FEISHU_WEBHOOK_URL 传入，或写在 config.yaml")
        sys.exit(1)

    cfg.setdefault("monitor", {})
    cfg["monitor"].setdefault("window_minutes", 60)
    cfg["monitor"].setdefault("threshold", 10)
    cfg["monitor"].setdefault("cooldown_minutes", 5)
    return cfg


def load_state():
    try:
        with open(STATE_PATH, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"last_alert_time": 0}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def query_intercom(access_token, tag_id, window_start):
    body = {
        "query": {
            "operator": "AND",
            "value": [
                {"field": "tag_ids", "operator": "=", "value": tag_id},
                {"field": "created_at", "operator": ">", "value": window_start},
            ],
        },
        "pagination": {"per_page": 1},
    }

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Intercom-Version": "2.14",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    resp = requests.post(INTERCOM_SEARCH_URL, headers=headers, json=body, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    total = data.get("total_count")
    if total is None:
        total = len(data.get("data", []))

    return total


def send_alert(webhook_url, tag_id, count, threshold, window_minutes,
               consecutive=0, max_consecutive=0, is_mock=False):
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    if is_mock:
        header_title = "🧪 MOCK 测试 - DataFail 监控"
        header_color = "orange"
        body_lines = [
            "⚠️ 这是一条 **Mock 测试消息**，并非真实告警。",
            "",
            f"**标签 ID：**{tag_id}（DataFail）",
            f"**近 {window_minutes} 分钟新增：**{count} 条（模拟数据）",
            f"**告警阈值：**1 条",
            f"**触发时间：**{now_str}",
            "",
            "✅ 如果你收到了这条消息，说明 Webhook 链路已打通。",
        ]
    else:
        header_title = "⚠️ DataFail 告警"
        header_color = "red"
        body_lines = [
            f"**标签名称：**DataFail（ID: {tag_id}）",
            f"**近 {window_minutes} 分钟新增：**{count} 条",
            f"**告警阈值：**{threshold} 条",
            f"**触发时间：**{now_str}",
        ]
        if max_consecutive > 0:
            body_lines.append("")
            body_lines.append(f"⏱️ 连续告警：**第 {consecutive}/{max_consecutive} 次**")
        if consecutive >= max_consecutive and max_consecutive > 0:
            body_lines.append("🛑 已触发连续告警上限，系统将进入 **45 分钟冷却期**，期间暂停推送。")

    card = {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": header_title},
                "template": header_color,
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {"tag": "lark_md", "content": "\n".join(body_lines)},
                },
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "打开 Intercom 后台"},
                            "type": "default",
                            "url": "https://app.intercom.com/a/apps/bor1fk18/reports/custom-reports/report/16719521",
                            "multi_url": {"pc_url": "https://app.intercom.com/a/apps/bor1fk18/reports/custom-reports/report/16719521"},
                        }
                    ],
                },
            ],
        },
    }

    resp = requests.post(webhook_url, json=card, timeout=15)
    resp.raise_for_status()
    result = resp.json()
    if result.get("StatusCode") != 0:
        print(f"[ERROR] 飞书 Webhook 返回异常: {resp.text}")


def cmd_check(cfg):
    """Print current count without sending any webhook or updating state."""
    now = int(time.time())
    window_start = now - cfg["monitor"]["window_minutes"] * 60

    try:
        count = query_intercom(cfg["intercom"]["access_token"], cfg["monitor"]["tag_id"], window_start)
    except requests.exceptions.RequestException as e:
        print(f"[ERROR] Intercom API 请求失败: {e}")
        sys.exit(1)

    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    min_label = cfg["monitor"]["window_minutes"]
    print(f"[{ts}] DataFail(tag={cfg['monitor']['tag_id']}) 近{min_label}分钟={count}条 阈值={cfg['monitor']['threshold']}")

    if count >= cfg["monitor"]["threshold"]:
        print(f"  → 已达告警阈值（本模式不会发送通知，使用无参数运行以触发告警）")
    else:
        print(f"  → 未达阈值")


def cmd_mock(cfg):
    """Send a test webhook to verify the Feishu link."""
    print("发送 Mock Webhook...")
    try:
        send_alert(
            cfg["webhook"]["url"],
            cfg["monitor"]["tag_id"],
            12,  # fake count
            cfg["monitor"]["threshold"],
            cfg["monitor"]["window_minutes"],
            is_mock=True,
        )
        print("Mock 消息已发送，请检查飞书群聊。")
    except requests.exceptions.RequestException as e:
        print(f"[ERROR] 飞书 Webhook 发送失败: {e}")
        sys.exit(1)


def cmd_run(cfg):
    """Full monitoring run: query, check threshold, manage consecutive alert cooldown."""
    state = load_state()
    now = int(time.time())
    window_start = now - cfg["monitor"]["window_minutes"] * 60
    threshold = cfg["monitor"]["threshold"]
    tag_id = cfg["monitor"]["tag_id"]
    max_consecutive = cfg["monitor"].get("max_consecutive_alerts", 3)
    extended_cooldown_sec = cfg["monitor"].get("extended_cooldown_minutes", 45) * 60

    # init state fields if not present (backward compat with old state.json)
    state.setdefault("consecutive_alerts", 0)
    state.setdefault("cooldown_until", 0)

    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 查询中...")

    try:
        count = query_intercom(cfg["intercom"]["access_token"], tag_id, window_start)
    except requests.exceptions.RequestException as e:
        print(f"[ERROR] Intercom API 请求失败: {e}")
        sys.exit(1)

    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] "
          f"tag={tag_id} 近{cfg['monitor']['window_minutes']}分钟={count}条 阈值={threshold}")

    # check extended cooldown
    cooldown_until = state["cooldown_until"]
    if cooldown_until > 0 and now < cooldown_until:
        remaining = cooldown_until - now
        print(f"  → 延长冷却中（{int(remaining)}秒后解除，连续告警已达上限），跳过本次告警")
        return

    if cooldown_until > 0 and now >= cooldown_until:
        print(f"  → 延长冷却已过期，重置连续告警计数")
        state["consecutive_alerts"] = 0
        state["cooldown_until"] = 0

    # if volume dropped below threshold, reset the streak
    if count < threshold:
        if state["consecutive_alerts"] > 0:
            print(f"  → 数据回落至阈值以下，重置连续告警计数（之前: {state['consecutive_alerts']}次）")
            state["consecutive_alerts"] = 0
            save_state(state)
        else:
            print(f"  → 未达阈值，无需告警")
        return

    # count >= threshold: alert
    consecutive = state["consecutive_alerts"] + 1
    print(f"  → 触发告警！（第 {consecutive}/{max_consecutive} 次连续）正在发送 Webhook...")

    try:
        send_alert(
            cfg["webhook"]["url"], tag_id, count, threshold,
            cfg["monitor"]["window_minutes"],
            consecutive=consecutive, max_consecutive=max_consecutive,
        )
        state["last_alert_time"] = now
        state["consecutive_alerts"] = consecutive

        if consecutive >= max_consecutive:
            state["cooldown_until"] = now + extended_cooldown_sec
            cooldown_min = extended_cooldown_sec // 60
            print(f"  → 已连续告警 {consecutive} 次，进入 {cooldown_min} 分钟延长冷却")

        save_state(state)
        print(f"  → 告警已发送")
    except requests.exceptions.RequestException as e:
        print(f"[ERROR] 飞书 Webhook 发送失败: {e}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="DataFail tag monitor")
    parser.add_argument("--check", action="store_true",
                        help="仅查询数量并打印，不发送 Webhook，不更新状态")
    parser.add_argument("--mock", action="store_true",
                        help="发送一条测试 Webhook 消息到飞书群聊")
    args = parser.parse_args()

    cfg = load_config()

    if args.check:
        cmd_check(cfg)
    elif args.mock:
        cmd_mock(cfg)
    else:
        cmd_run(cfg)


if __name__ == "__main__":
    main()
