import { json } from "@remix-run/node";
import crypto from "node:crypto";

import { reconcileShopifyProductCatalog } from "../services/shopifyProductSync.server.js";
import { resolveShopDomain } from "../utils/shopifyAdmin.server.js";

export async function action({ request }) {
  const configuredToken = String(
    process.env.SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN || "",
  ).trim();
  const providedToken = String(
    request.headers.get("authorization") || "",
  ).replace(/^Bearer\s+/i, "");

  if (!configuredToken || !tokensMatch(providedToken, configuredToken)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => new FormData());
  const requestedLimit = Number(formData.get("limit") || 250);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 250, 1000),
  );

  try {
    const shopDomain = await resolveShopDomain(
      process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || null,
    );
    const result = await reconcileShopifyProductCatalog(shopDomain, { limit });

    return json({
      ok: true,
      shopDomain,
      scanned: result.scanned,
      created: result.created,
      updated: result.updated,
      unresolved: result.unresolved,
    });
  } catch (error) {
    console.error("Internal Shopify product catalog sync failed:", error);
    return json(
      { ok: false, error: "shopify_product_catalog_sync_failed" },
      { status: 500 },
    );
  }
}

function tokensMatch(provided, expected) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function loader() {
  return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
