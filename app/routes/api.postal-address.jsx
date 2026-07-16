import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
  const { requireVendorContext } =
    await import("../services/vendorManagement.server.js");
  const { lookupJapanesePostalAddress } =
    await import("../services/postalAddress.server.js");
  await requireVendorContext(request);

  const url = new URL(request.url);
  const countryCode = String(url.searchParams.get("countryCode") || "JP")
    .trim()
    .toUpperCase();
  if (countryCode !== "JP") {
    return json(
      { ok: false, found: false, error: "unsupported_country", candidates: [] },
      { status: 400 },
    );
  }

  const result = await lookupJapanesePostalAddress(
    url.searchParams.get("postalCode"),
  );
  return json(result, {
    status: result.error === "invalid_postal_code" ? 400 : 200,
    headers: { "Cache-Control": "private, max-age=3600" },
  });
};
