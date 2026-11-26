const TLS_PARAMETERS = new Set([
  "sslmode",
  "sslaccept",
  "sslcert",
  "sslidentity",
  "sslpassword",
  "host",
]);

// This checks the selected native Prisma URL dialect, not a live TLS handshake.
export function inspectPostgresTlsConfiguration(value) {
  const result = (reason, ready = false) => ({
    ready,
    reason,
    configurationOnly: true,
    connectionVerified: false,
  });
  if (value === undefined || value === null || value === "")
    return result("missing");
  if (
    typeof value !== "string" ||
    value.length > 16384 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    /%(?![a-f0-9]{2})/i.test(value)
  )
    return result("invalid_url");

  let url;
  try {
    url = new URL(value);
  } catch {
    return result("invalid_url");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    return result("unsupported_protocol");
  if (!url.hostname || /[%\\]/.test(url.hostname) || url.hash)
    return result("ambiguous_endpoint");

  const seen = new Set();
  for (const [key] of url.searchParams) {
    const normalized = key.toLowerCase();
    if (!TLS_PARAMETERS.has(normalized)) continue;
    if (key !== normalized || seen.has(normalized))
      return result("ambiguous_tls_parameters");
    seen.add(normalized);
  }
  if (seen.has("host")) return result("host_override_unverified");
  if (url.searchParams.get("sslmode") !== "require")
    return result("tls_not_required");
  if (url.searchParams.get("sslaccept") !== "strict")
    return result("certificate_validation_not_required");
  if (seen.has("sslcert") && !url.searchParams.get("sslcert"))
    return result("empty_certificate_path");
  return result("explicit_required_verified_tls_configuration", true);
}
