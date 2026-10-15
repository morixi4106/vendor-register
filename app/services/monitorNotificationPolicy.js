export function resolveMonitorNotificationMode(env = {}) {
  const mode = env.LAUNCH_MONITOR_NOTIFICATION_MODE;
  if (!mode || mode === "prelaunch") return "prelaunch";
  return mode === "live" ? "live" : "paused";
}

export function automaticMonitorNotificationsEnabled(env = {}) {
  return resolveMonitorNotificationMode(env) === "live";
}
