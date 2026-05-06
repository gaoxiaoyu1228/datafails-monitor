const INTERCOM_SEARCH_URL = "https://api.intercom.io/conversations/search";

function getConfig() {
  return {
    tagId: process.env.INTERCOM_TAG_ID || "11659240",
    windowMinutes: parseInt(process.env.WINDOW_MINUTES || "60", 10),
    threshold: parseInt(process.env.THRESHOLD || "10", 10),
  };
}

async function queryIntercom(accessToken: string, tagId: string, windowStart: number): Promise<number> {
  const body = {
    query: {
      operator: "AND",
      value: [
        { field: "tag_ids", operator: "=", value: tagId },
        { field: "created_at", operator: ">", value: windowStart },
      ],
    },
    pagination: { per_page: 1 },
  };

  const resp = await fetch(INTERCOM_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Intercom-Version": "2.14",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Intercom API returned ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  return data.total_count ?? (data.data?.length || 0);
}

async function sendFeishuAlert(webhookUrl: string, config: ReturnType<typeof getConfig>, count: number) {
  const nowStr = new Date().toISOString();

  const card = {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "⚠️ DataFail 告警" },
        template: "red",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: [
              `**标签 ID：**${config.tagId}`,
              `**近 ${config.windowMinutes} 分钟新增：**${count} 条`,
              `**告警阈值：**${config.threshold} 条`,
              `**触发时间：**${nowStr}`,
            ].join("\n"),
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "打开 Intercom 后台" },
              type: "default",
              url: "https://app.intercom.com/a/apps/_/conversations",
              multi_url: { pc_url: "https://app.intercom.com/a/apps/_/conversations" },
            },
          ],
        },
      ],
    },
  };

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!resp.ok) {
    throw new Error(`Feishu webhook returned ${resp.status}: ${await resp.text()}`);
  }

  const result = await resp.json();
  if (result.StatusCode !== 0) {
    throw new Error(`Feishu webhook error: ${JSON.stringify(result)}`);
  }
}

export async function GET(request: Request) {
  // Verify the request originates from Vercel Cron
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = process.env.INTERCOM_ACCESS_TOKEN;
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL;

  if (!accessToken || !webhookUrl) {
    console.error("Missing INTERCOM_ACCESS_TOKEN or FEISHU_WEBHOOK_URL");
    return Response.json({ error: "Missing configuration" }, { status: 500 });
  }

  const config = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - config.windowMinutes * 60;

  try {
    const count = await queryIntercom(accessToken, config.tagId, windowStart);
    console.log(
      `[${new Date().toISOString()}] tag=${config.tagId} ${config.windowMinutes}min=${count} threshold=${config.threshold}`,
    );

    if (count < config.threshold) {
      return Response.json({ status: "ok", count, alerted: false });
    }

    await sendFeishuAlert(webhookUrl, config, count);
    console.log(`Alert sent, count=${count}`);
    return Response.json({ status: "ok", count, alerted: true });
  } catch (error) {
    console.error(`Monitor failed:`, error);
    return Response.json({ error: "Monitor execution failed" }, { status: 500 });
  }
}
