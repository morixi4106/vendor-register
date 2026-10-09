export function privateDocumentHeaders({
  parentHeaders,
  loaderHeaders,
  actionHeaders,
  errorHeaders,
} = {}) {
  const headers = new Headers();
  for (const source of [
    parentHeaders,
    loaderHeaders,
    actionHeaders,
    errorHeaders,
  ]) {
    source?.forEach((value, key) => {
      if (key !== "set-cookie") headers.set(key, value);
    });
    for (const cookie of source?.getSetCookie?.() || [])
      headers.append("Set-Cookie", cookie);
  }
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

export function applyPrivateResponseHeaders(headers, requestUrl) {
  const pathname = new URL(requestUrl).pathname.replace(/\.data$/, "");
  const isPrivate =
    /^\/app(?:\/|$)/.test(pathname) ||
    /^\/vendor\/(?:verify|dashboard|inventory|products|orders|settings|reports|withdrawals)(?:\/|$)/.test(
      pathname,
    ) ||
    /^\/apps\/vendors\/(?:dashboard|verify)(?:\/|$)/.test(pathname);
  if (!isPrivate) return headers;
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}
