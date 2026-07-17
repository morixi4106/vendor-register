await main().catch(async (error) => {
  await sendAlert(error).catch(() => {});
  console.error(`launch monitor deadman failed: ${safeError(error)}`);
  process.exitCode = 1;
});

async function main() {
  for (const key of [
    "LAUNCH_MONITOR_URL",
    "LAUNCH_MONITOR_DEADMAN_TOKEN",
    "RENDER_API_KEY",
    "RENDER_CRON_SERVICE_ID",
  ]) {
    if (!String(process.env[key] || "").trim()) {
      throw new Error(`${key}_required`);
    }
  }

  const endpoint = new URL(
    "/internal/launch-monitor-deadman",
    process.env.LAUNCH_MONITOR_URL,
  );
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LAUNCH_MONITOR_DEADMAN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !isDeadmanResponse(payload)) {
    throw new Error(`deadman_endpoint_${response.status}`);
  }

  if (payload.completed === true) {
    await suspendSelf();
    console.log(
      JSON.stringify({ ok: true, status: "completed", suspended: true }),
    );
    return;
  }
  if (payload.ok !== true || payload.status !== "healthy") {
    throw new Error(`github_monitor_${safeStatus(payload.status)}`);
  }
  console.log(
    JSON.stringify({
      ok: true,
      status: payload.status,
      ageMinutes: payload.ageMinutes,
    }),
  );
}

function isDeadmanResponse(payload) {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    payload.schemaVersion === 1 &&
    typeof payload.ok === "boolean" &&
    ["healthy", "stale", "not_started", "completed"].includes(payload.status) &&
    (payload.ageMinutes === null || Number.isInteger(payload.ageMinutes)),
  );
}

async function suspendSelf() {
  const serviceId = String(process.env.RENDER_CRON_SERVICE_ID || "").trim();
  if (!/^(crn|srv)-[a-z0-9]+$/i.test(serviceId)) {
    throw new Error("invalid_render_cron_service_id");
  }
  const response = await fetchWithTimeout(
    `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/suspend`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
        Accept: "application/json",
      },
    },
  );
  if (response.status !== 202) {
    throw new Error(`render_cron_suspend_${response.status}`);
  }
}

async function sendAlert(error) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.MAIL_FROM || "").trim();
  const to = String(process.env.ADMIN_EMAIL || "").trim();
  if (!apiKey || !from || !to) return;
  const response = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `launch-monitor-deadman-${Math.floor(Date.now() / 3_600_000)}`,
    },
    body: JSON.stringify({
      from,
      to,
      subject: "公開監視の定期実行が停止しています",
      text: [
        "GitHub Actionsによる公開監視が15分以上確認できません。",
        `確認時刻: ${new Date().toISOString()}`,
        `状態コード: ${safeError(error)}`,
        "GitHub ActionsとRender Webサービスを確認してください。",
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error(`deadman_email_${response.status}`);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeStatus(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 60);
}

function safeError(error) {
  return safeStatus(error?.name || error?.message || error);
}
