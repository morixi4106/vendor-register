await main().catch(async (error) => {
  await sendFallbackAlert(error).catch(() => {});
  console.error(`launch monitor agent failed: ${safeError(error)}`);
  process.exitCode = 1;
});

async function main() {
  const required = [
    "LAUNCH_MONITOR_URL",
    "LAUNCH_MONITOR_TOKEN",
    "RENDER_API_KEY",
    "RENDER_OWNER_ID",
    "RENDER_SERVICE_ID",
  ];

  for (const key of required) {
    if (!String(process.env[key] || "").trim()) {
      throw new Error(`${key}_required`);
    }
  }

  const now = new Date();
  const lookbackMinutes = boundedNumber(
    process.env.LAUNCH_MONITOR_LOOKBACK_MINUTES,
    12,
    5,
    60,
  );
  const windowStartedAt = new Date(now.getTime() - lookbackMinutes * 60 * 1000);
  const snapshot = {
    windowStartedAt: windowStartedAt.toISOString(),
    windowEndedAt: now.toISOString(),
    requests: {
      serverErrors: 0,
      unauthorized: 0,
      forbidden: 0,
      rateLimited: 0,
    },
    appErrors: 0,
    queryErrors: [],
    publicEndpoints: {
      appRoot: { ok: false, code: "not_checked" },
      storefront: { ok: false, code: "not_checked" },
    },
  };

  const queries = [
    ["serverErrors", { type: "request", statusCode: "5*" }],
    ["unauthorized", { type: "request", statusCode: "401" }],
    ["forbidden", { type: "request", statusCode: "403" }],
    ["rateLimited", { type: "request", statusCode: "429" }],
  ];

  for (const [key, filters] of queries) {
    try {
      const result = await listRenderLogs(filters, { windowStartedAt, now });
      snapshot.requests[key] = result.count;
      if (result.hasMore) snapshot.requests[`${key}Truncated`] = true;
    } catch (error) {
      snapshot.queryErrors.push(`${key}:${safeError(error)}`);
    }
  }

  try {
    const result = await listRenderLogs(
      { type: "app", level: "error" },
      { windowStartedAt, now },
    );
    snapshot.appErrors = result.count;
    if (result.hasMore) snapshot.appErrorsTruncated = true;
  } catch (error) {
    snapshot.queryErrors.push(`appErrors:${safeError(error)}`);
  }

  snapshot.publicEndpoints = await probePublicEndpoints();

  if (process.argv.includes("--dry-run")) {
    console.log(
      JSON.stringify({
        ok: true,
        dryRun: true,
        windowStartedAt: snapshot.windowStartedAt,
        windowEndedAt: snapshot.windowEndedAt,
        requests: snapshot.requests,
        appErrors: snapshot.appErrors,
        queryErrorCount: snapshot.queryErrors.length,
        publicEndpoints: snapshot.publicEndpoints,
      }),
    );
    return;
  }

  const monitorUrl = new URL(
    "/internal/launch-monitor",
    process.env.LAUNCH_MONITOR_URL,
  );
  const response = await fetchWithTimeout(monitorUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LAUNCH_MONITOR_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(snapshot),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !isMonitorResponse(payload)) {
    throw new Error(`launch_monitor_endpoint_failed:${response.status}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      active: payload.active,
      completed: payload.completed || false,
      status: payload.status,
      criticalCount: payload.checks.filter(
        (check) => check.status === "critical",
      ).length,
      warningCount: payload.checks.filter((check) => check.status === "warning")
        .length,
      notificationKind: payload.notificationKind || null,
    }),
  );

  if (payload.completed === true) {
    const schedulerStopped = await stopScheduler();
    console.log(
      JSON.stringify({
        ok: true,
        completed: true,
        schedulerStopped,
      }),
    );
    return;
  }

  if (payload.status === "critical") {
    process.exitCode = 2;
  }
}

function isMonitorResponse(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.ok !== true ||
    payload.schemaVersion !== 1
  ) {
    return false;
  }
  if (typeof payload.active !== "boolean") return false;
  if (payload.completed === true) return true;
  if (!["healthy", "warning", "critical"].includes(payload.status)) {
    return false;
  }
  return Array.isArray(payload.checks) && payload.checks.every(isMonitorCheck);
}

function isMonitorCheck(check) {
  return Boolean(
    check &&
    typeof check === "object" &&
    /^[a-z0-9_]{1,100}$/i.test(String(check.id || "")) &&
    ["healthy", "warning", "critical"].includes(check.status) &&
    typeof check.code === "string" &&
    Number.isInteger(check.count) &&
    check.count >= 0,
  );
}

async function probePublicEndpoints() {
  const appUrl = normalizeUrl(process.env.LAUNCH_MONITOR_URL);
  const expectedRoot = normalizeUrl(
    process.env.LAUNCH_MONITOR_EXPECTED_ROOT_LOCATION ||
      "https://oja-immanuel-bacchus.com/",
  );
  const storefrontUrl = normalizeUrl(
    process.env.LAUNCH_MONITOR_STOREFRONT_URL || expectedRoot,
  );
  const marker = String(
    process.env.LAUNCH_MONITOR_STOREFRONT_MARKER || "Oja Immanuel Bacchus",
  ).trim();
  const result = {
    appRoot: { ok: false, code: "root_probe_failed" },
    storefront: { ok: false, code: "storefront_probe_failed" },
  };

  if (appUrl && expectedRoot) {
    try {
      const response = await fetchWithTimeout(appUrl, { redirect: "manual" });
      const location = normalizeUrl(response.headers.get("location"));
      result.appRoot = {
        ok:
          [301, 302, 303, 307, 308].includes(response.status) &&
          location === expectedRoot,
        code:
          location === expectedRoot
            ? `http_${response.status}`
            : "unexpected_redirect",
      };
    } catch (error) {
      result.appRoot = { ok: false, code: networkErrorCode(error) };
    }
  }

  if (storefrontUrl && marker) {
    try {
      const response = await fetchWithTimeout(storefrontUrl, {
        redirect: "follow",
      });
      const finalUrl = new URL(response.url);
      const body = await readBodyWithLimit(response, 512_000);
      const passwordPage = /(^|\/)password(?:[/?#]|$)/i.test(finalUrl.pathname);
      result.storefront = {
        ok:
          response.status === 200 &&
          !passwordPage &&
          body.toLowerCase().includes(marker.toLowerCase()),
        code: passwordPage
          ? "password_page"
          : response.status !== 200
            ? `http_${response.status}`
            : body.toLowerCase().includes(marker.toLowerCase())
              ? "brand_marker_found"
              : "brand_marker_missing",
      };
    } catch (error) {
      result.storefront = { ok: false, code: networkErrorCode(error) };
    }
  }
  return result;
}

async function stopScheduler() {
  if (String(process.env.RENDER_CRON_SERVICE_ID || "").trim()) {
    await suspendMonitorCron();
    return "render_cron_suspended";
  }
  if (String(process.env.GITHUB_ACTIONS || "").toLowerCase() === "true") {
    await disableGithubWorkflow();
    return "github_workflow_disabled";
  }
  throw new Error("monitor_scheduler_not_configured");
}

async function suspendMonitorCron() {
  const serviceId = String(process.env.RENDER_CRON_SERVICE_ID || "").trim();
  if (!/^crn-[a-z0-9]+$/i.test(serviceId)) {
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

async function disableGithubWorkflow() {
  const repository = String(process.env.GITHUB_REPOSITORY || "").trim();
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  const workflow = String(
    process.env.LAUNCH_MONITOR_GITHUB_WORKFLOW || "launch-monitor.yml",
  ).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    throw new Error("github_workflow_credentials_missing");
  }
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/disable`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status !== 204) {
    throw new Error(`github_workflow_disable_${response.status}`);
  }
}

async function listRenderLogs(
  { type, statusCode = null, level = null },
  { windowStartedAt, now },
) {
  const url = new URL("https://api.render.com/v1/logs");
  url.searchParams.set("ownerId", process.env.RENDER_OWNER_ID);
  url.searchParams.set("startTime", windowStartedAt.toISOString());
  url.searchParams.set("endTime", now.toISOString());
  url.searchParams.set("direction", "backward");
  url.searchParams.set("limit", "100");
  url.searchParams.append("resource", process.env.RENDER_SERVICE_ID);
  url.searchParams.append("type", type);
  if (statusCode) url.searchParams.append("statusCode", statusCode);
  if (level) url.searchParams.append("level", level);
  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`render_logs_${response.status}`);
  const payload = await response.json();
  return {
    count: Array.isArray(payload.logs) ? payload.logs.length : 0,
    hasMore: payload.hasMore === true,
  };
}

async function sendFallbackAlert(error) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.MAIL_FROM || "").trim();
  const to = String(process.env.ADMIN_EMAIL || "").trim();
  if (!apiKey || !from || !to) return;
  const response = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `launch-monitor-cron-${Math.floor(Date.now() / 3_600_000)}`,
    },
    body: JSON.stringify({
      from,
      to,
      subject: "公開監視エージェント自体が停止しました",
      text: [
        "公開監視エージェントの実行に失敗しました。",
        `時刻: ${new Date().toISOString()}`,
        `エラー: ${safeError(error)}`,
        "RenderのCron JobとWebサービスを確認してください。",
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error(`fallback_email_${response.status}`);
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

async function readBodyWithLimit(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response_body_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function networkErrorCode(error) {
  if (error?.name === "AbortError") return "timeout";
  return "network_error";
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function safeError(error) {
  return String(error?.name || error?.message || error || "unknown_error")
    .replace(/[\r\n]/g, " ")
    .slice(0, 120);
}
