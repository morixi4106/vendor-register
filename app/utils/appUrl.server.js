export function getAppBaseUrl(request, env = process.env) {
  const configuredUrl = String(env.APP_URL || "").trim();

  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, "");
  }

  return new URL(request.url).origin;
}
