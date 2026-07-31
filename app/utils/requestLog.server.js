function stripControlCharacters(value) {
  return Array.from(String(value || ""))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
}

export function getSanitizedRequestPath(requestUrl) {
  const rawUrl = stripControlCharacters(requestUrl);

  try {
    const url = new URL(rawUrl || "/", "http://localhost");
    return stripControlCharacters(url.pathname) || "/";
  } catch {
    return stripControlCharacters(rawUrl.split("?")[0]) || "/";
  }
}

export function createSafeRequestLogger({ log = console.log } = {}) {
  return function safeRequestLogger(request, response, next) {
    const startedAt = process.hrtime.bigint();

    response.once("finish", () => {
      const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
      const elapsedMilliseconds = Number(elapsedNanoseconds) / 1_000_000;
      const contentLength = response.getHeader("content-length") || "-";
      const path = getSanitizedRequestPath(
        request.originalUrl || request.url || "/",
      );

      log(
        `${request.method} ${path} ${response.statusCode} ${contentLength} - ${elapsedMilliseconds.toFixed(3)} ms`,
      );
    });

    next();
  };
}
