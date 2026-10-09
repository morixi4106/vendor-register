const MARKER = "<!-- maintenance-render-runner -->";

export async function sendMaintenanceFallback({
  env = process.env,
  tasks = [],
  notificationTest = false,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (env.MAINTENANCE_ALERTS_ENABLED !== "true")
    return { sent: false, reason: "disabled" };
  const repository = env.GITHUB_REPOSITORY;
  const token = env.MAINTENANCE_GITHUB_ALERT_TOKEN;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") ||
    String(token || "").length < 32
  )
    throw new Error("maintenance_fallback_not_configured");
  const allowed = new Set([
    "shopify-product-catalog-sync-agent.mjs",
    "shopify-order-integrity-agent.mjs",
    "launch-monitor-agent.mjs",
    "launch-monitor-deadman.mjs",
  ]);
  if (!Array.isArray(tasks) || tasks.some((t) => !allowed.has(t)))
    throw new Error("maintenance_alert_tasks_invalid");
  async function request(endpoint, options = {}) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}${endpoint}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("maintenance_fallback_request_failed");
    return response.json();
  }
  const body = `${MARKER}\n@${repository.split("/")[0]}\n\n${notificationTest ? "Notification receipt test" : "Render maintenance failure"}\nTasks: ${tasks.join(", ") || "notification test"}\nChecked: ${now.toISOString()}\n\nAfter reading, comment /ack-maintenance. Response target: seven days after acknowledgement. This alert does not authorize sales restoration, payment, refund, or data repair.`;
  const issues = await request("/issues?state=open&per_page=100");
  const existing = issues.find(
    (issue) => !issue.pull_request && issue.body?.startsWith(MARKER),
  );
  if (!existing) {
    const created = await request("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: "[Maintenance] Render maintenance and notification receipt",
        body,
      }),
    });
    return { sent: true, issue: created.number };
  }
  if (now - new Date(existing.updated_at) < 86400_000 && !notificationTest)
    return { sent: false, reason: "deduplicated", issue: existing.number };
  await request(`/issues/${existing.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return { sent: true, issue: existing.number };
}
