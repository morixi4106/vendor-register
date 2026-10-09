export async function inspectBackupAvailability({
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (env.MAINTENANCE_BACKUP_CHECK_ENABLED !== "true")
    return { enabled: false, ok: false, code: "backup_check_disabled" };
  if (
    !/^dpg-[a-z0-9-]+$/.test(env.RENDER_POSTGRES_ID || "") ||
    !env.RENDER_API_KEY
  )
    return { enabled: true, ok: false, code: "backup_check_not_configured" };
  try {
    const response = await fetchImpl(
      `https://api.render.com/v1/postgres/${env.RENDER_POSTGRES_ID}/recovery`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.RENDER_API_KEY}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    if (!response.ok)
      return { enabled: true, ok: false, code: "backup_check_unavailable" };
    const data = await response.json();
    const hours = (now - new Date(data.startsAt)) / 3_600_000;
    const ok =
      data.recoveryStatus === "AVAILABLE" &&
      Number.isFinite(hours) &&
      hours >= 24;
    return {
      enabled: true,
      ok,
      code: ok ? "recovery_window_available" : "recovery_window_insufficient",
      windowHours:
        Number.isFinite(hours) && hours >= 0 ? Math.floor(hours) : null,
      restorationTested: false,
    };
  } catch {
    return { enabled: true, ok: false, code: "backup_check_unavailable" };
  }
}
