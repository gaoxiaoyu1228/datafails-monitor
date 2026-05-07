import { kv } from "@vercel/kv";
import { NextResponse } from "next/server";

// ── config from env ──────────────────────────────────────────
const INTERCOM_TOKEN = process.env.INTERCOM_ACCESS_TOKEN!;
const TAG_ID = process.env.DATAFAIL_TAG_ID || "11659240";
const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES) || 60;
const THRESHOLD = Number(process.env.THRESHOLD) || 1;
const MAX_CONSECUTIVE = Number(process.env.MAX_CONSECUTIVE_ALERTS) || 3;
const EXTENDED_COOLDOWN_SEC =
  (Number(process.env.EXTENDED_COOLDOWN_MINUTES) || 45) * 60;
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK_URL!;
const REPORT_URL =
  "https://app.intercom.com/a/apps/bor1fk18/reports/custom-reports/report/16719521";

interface MonitorState {
  last_alert_time: number;
  consecutive_alerts: number;
  cooldown_until: number;
}

// ── helpers ──────────────────────────────────────────────────

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function queryIntercom(windowStart: number): Promise<number> {
  const body = {
    query: {
      operator: "AND",
      value: [
        { field: "tag_ids", operator: "=", value: TAG_ID },
        { field: "created_at", operator: ">", value: windowStart },
      ],
    },
    pagination: { per_page: 1 },
  };

  const res = await fetch("https://api.intercom.io/conversations/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INTERCOM_TOKEN}`,
      "Intercom-Version": "2.14",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Intercom API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.total_count ?? data.data?.length ?? 0;
}

async function sendAlert(
  count: number,
  consecutive: number,
  maxConsecutive: number,
) {
  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const bodyLines = [
    `**标签名称：**DataFail（ID: ${TAG_ID}）`,
    `**近 ${WINDOW_MINUTES} 分钟新增：**${count} 条`,
    `**告警阈值：**${THRESHOLD} 条`,
    `**触发时间：**${nowStr}`,
    "",
    `⏱️ 连续告警：**第 ${consecutive}/${maxConsecutive} 次**`,
  ];

  if (consecutive >= maxConsecutive) {
    bodyLines.push(
      "🛑 已触发连续告警上限，系统将进入 **45 分钟冷却期**，期间暂停推送。",
    );
  }

  const card = {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "⚠️ DataFail 告警" },
        template: "red" as const,
      },
      elements: [
        {
          tag: "div",
          text: { tag: "lark_md", content: bodyLines.join("\n") },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "打开 Intercom 后台" },
              type: "default",
              url: REPORT_URL,
              multi_url: { pc_url: REPORT_URL },
            },
          ],
        },
      ],
    },
  };

  const res = await fetch(FEISHU_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!res.ok) throw new Error(`Feishu webhook ${res.status}`);
  const result = await res.json();
  if ((result as any).StatusCode !== 0) {
    throw new Error(`Feishu webhook error: ${JSON.stringify(result)}`);
  }
}

// ── main handler ─────────────────────────────────────────────

export async function GET() {
  console.log(`[${ts()}] cron triggered`);

  if (!INTERCOM_TOKEN || !FEISHU_WEBHOOK) {
    console.error("Missing INTERCOM_ACCESS_TOKEN or FEISHU_WEBHOOK_URL");
    return NextResponse.json({ error: "missing env vars" }, { status: 500 });
  }

  // load state from KV
  let state: MonitorState = (await kv.get<MonitorState>("state")) || {
    last_alert_time: 0,
    consecutive_alerts: 0,
    cooldown_until: 0,
  };

  const current = now();
  const windowStart = current - WINDOW_MINUTES * 60;

  // query Intercom
  let count: number;
  try {
    count = await queryIntercom(windowStart);
  } catch (e: any) {
    console.error(`[${ts()}] Intercom error: ${e.message}`);
    return NextResponse.json({ error: "intercom fail" }, { status: 500 });
  }

  console.log(
    `[${ts()}] tag=${TAG_ID} ${WINDOW_MINUTES}min=${count} threshold=${THRESHOLD}`,
  );

  // extended cooldown check
  if (state.cooldown_until > 0 && current < state.cooldown_until) {
    const remaining = state.cooldown_until - current;
    console.log(`[${ts()}] cooldown active, ${remaining}s remaining → skip`);
    return NextResponse.json({
      ok: true,
      count,
      status: "cooldown",
      remaining_sec: remaining,
    });
  }

  if (state.cooldown_until > 0 && current >= state.cooldown_until) {
    console.log(`[${ts()}] cooldown expired, resetting counter`);
    state.consecutive_alerts = 0;
    state.cooldown_until = 0;
  }

  // below threshold → reset streak
  if (count < THRESHOLD) {
    if (state.consecutive_alerts > 0) {
      console.log(
        `[${ts()}] count dropped below threshold, reset streak (was ${state.consecutive_alerts})`,
      );
      state.consecutive_alerts = 0;
      await kv.set("state", state);
    }
    return NextResponse.json({ ok: true, count, status: "below_threshold" });
  }

  // alert
  const consecutive = state.consecutive_alerts + 1;
  console.log(`[${ts()}] ALERT #${consecutive}/${MAX_CONSECUTIVE}`);

  try {
    await sendAlert(count, consecutive, MAX_CONSECUTIVE);
  } catch (e: any) {
    console.error(`[${ts()}] Feishu error: ${e.message}`);
    return NextResponse.json({ error: "feishu fail" }, { status: 500 });
  }

  state.last_alert_time = current;
  state.consecutive_alerts = consecutive;

  if (consecutive >= MAX_CONSECUTIVE) {
    state.cooldown_until = current + EXTENDED_COOLDOWN_SEC;
    console.log(
      `[${ts()}] extended cooldown until ${new Date(state.cooldown_until * 1000).toISOString()}`,
    );
  }

  await kv.set("state", state);

  return NextResponse.json({
    ok: true,
    count,
    status: "alerted",
    consecutive,
  });
}

export const runtime = "edge";
