const ZIPCLOUD_ENDPOINT = "https://zipcloud.ibsnet.co.jp/api/search";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const lookupCache = new Map();

export function normalizeJapanesePostalCode(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return digits.length === 7 ? digits : null;
}

export function formatJapanesePostalCode(value) {
  const postalCode = normalizeJapanesePostalCode(value);
  return postalCode
    ? `${postalCode.slice(0, 3)}-${postalCode.slice(3)}`
    : String(value || "").trim();
}

export function normalizeZipCloudCandidates(results, postalCode) {
  const seen = new Set();
  return (Array.isArray(results) ? results : [])
    .map((result) => ({
      postalCode: formatJapanesePostalCode(result?.zipcode || postalCode),
      region: String(result?.address1 || "").trim(),
      city: String(result?.address2 || "").trim(),
      address1: String(result?.address3 || "").trim(),
    }))
    .filter((candidate) => candidate.region && candidate.city)
    .filter((candidate) => {
      const key = [candidate.region, candidate.city, candidate.address1].join(
        "|",
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function lookupJapanesePostalAddress(
  value,
  { fetchImpl = fetch, timeoutMs = 4000 } = {},
) {
  const postalCode = normalizeJapanesePostalCode(value);
  if (!postalCode) {
    return {
      ok: false,
      found: false,
      error: "invalid_postal_code",
      candidates: [],
    };
  }

  const cached = lookupCache.get(postalCode);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(ZIPCLOUD_ENDPOINT);
    url.searchParams.set("zipcode", postalCode);
    url.searchParams.set("limit", "20");
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`postal_lookup_http_${response.status}`);

    const payload = await response.json();
    const candidates = normalizeZipCloudCandidates(
      payload?.results,
      postalCode,
    );
    const valueResult = {
      ok: true,
      found: candidates.length > 0,
      postalCode: formatJapanesePostalCode(postalCode),
      candidates,
    };
    if (lookupCache.size >= MAX_CACHE_ENTRIES) {
      lookupCache.delete(lookupCache.keys().next().value);
    }
    lookupCache.set(postalCode, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value: valueResult,
    });
    return valueResult;
  } catch (error) {
    return {
      ok: false,
      found: false,
      error: error?.name === "AbortError" ? "lookup_timeout" : "lookup_failed",
      candidates: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}
