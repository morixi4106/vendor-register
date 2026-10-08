import {
  getVendorOrderShippingAddress,
  getVendorOrdersAccessState,
  requireVendorContext,
} from "../services/vendorManagement.server.js";
import {
  consumePublicEndpointRateLimit,
  getRequestClientIp,
} from "../services/publicEndpointRateLimit.server.js";
import { hashPrivateIdentifier } from "../utils/privacyHash.server.js";

export async function loader({ request }) {
  const { store, vendor } = await requireVendorContext(request);
  const access = await getVendorOrdersAccessState({ storeId: store.id });
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
  if (access.status !== "ready")
    return Response.json({ ok: false }, { status: 403, headers });
  try {
    const limit = await consumePublicEndpointRateLimit({
      endpoint: "vendor-address-access",
      key: hashPrivateIdentifier(
        `vendor:${vendor.id}:ip:${getRequestClientIp(request)}`,
      ),
      limit: 60,
      windowMs: 10 * 60_000,
    });
    if (!limit.ok)
      return Response.json(
        { ok: false },
        {
          status: 429,
          headers: {
            ...headers,
            "Retry-After": String(limit.retryAfterSeconds),
          },
        },
      );
    const result = await getVendorOrderShippingAddress({
      storeId: store.id,
      orderId: new URL(request.url).searchParams.get("orderId"),
      shopDomain: access.shopDomain,
    });
    return Response.json(result, {
      status: result.ok ? 200 : result.status,
      headers,
    });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
