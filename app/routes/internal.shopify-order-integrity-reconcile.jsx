import crypto from "node:crypto";
import { json } from "@remix-run/node";

import { reconcileRecentShopifyOrderIntegrity } from "../services/shopifyOrderIntegrity.server.js";
import { resolveShopDomain } from "../utils/shopifyAdmin.server.js";

function tokensMatch(provided, expected) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function action({ request }) {
  const configuredToken = String(
    process.env.SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN || "",
  ).trim();
  const providedToken = String(
    request.headers.get("authorization") || "",
  ).replace(/^Bearer\s+/i, "");

  if (
    configuredToken.length < 32 ||
    !tokensMatch(providedToken, configuredToken)
  ) {
    return json(
      { ok: false, error: "unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const formData = await request.formData().catch(() => new FormData());
  const limit = Math.max(
    1,
    Math.min(Number(formData.get("limit") || 100), 250),
  );
  const lookbackHours = Math.max(
    1,
    Math.min(Number(formData.get("lookbackHours") || 48), 168),
  );

  try {
    const shopDomain = await resolveShopDomain(
      process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || null,
    );
    const result = await reconcileRecentShopifyOrderIntegrity({
      shopDomain,
      limit,
      lookbackHours,
    });
    return json(result, {
      status: result.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Shopify order integrity reconciliation failed:", {
      code: error?.code || error?.name || "error",
    });
    return json(
      {
        ok: false,
        error: "shopify_order_integrity_reconciliation_failed",
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

export async function loader() {
  return json(
    { ok: false, error: "method_not_allowed" },
    {
      status: 405,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
