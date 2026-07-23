# Shopify product catalog sync

Shopify admin may be used to create or edit platform-operated products. The app
maps those products to its internal platform store before settlement and carrier
shipping calculations can use them safely.

## Environment

Set a random token with at least 32 bytes of entropy:

```text
SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN=<random secret>
```

Do not reuse a Shopify, database, or email API credential.

Keep the public Draft Order checkout disabled for the current Shopify standard
checkout release:

```text
PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED=false
```

## Run a catalog reconciliation

Send an authenticated POST request to:

```text
POST /internal/shopify-product-catalog-sync
Authorization: Bearer <SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN>
Content-Type: application/x-www-form-urlencoded

limit=250
```

The operation is idempotent. It creates missing product mappings, refreshes
existing snapshots, and records products whose Shopify vendor label cannot be
resolved. A physical product without a resolved owner does not receive a carrier
shipping rate, so checkout fails closed instead of creating an unsettled order.

The Shopify admin page `/app/shopify-product-sync` remains available for visual
review and manual assignment of unresolved products.

## Scheduled reconciliation and monitoring

`.github/workflows/shopify-product-catalog-sync.yml` runs the same authenticated
reconciliation every 15 minutes. Add the Render token to the GitHub repository
secret `SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN`. The workflow uses the existing
`LAUNCH_MONITOR_URL` repository variable as the application base URL.

The scheduled agent requests up to 10,000 products and only records a
successful heartbeat after Shopify pagination reaches the final page. Reaching
the safety limit returns an incomplete result and must never be treated as a
successful full-catalog reconciliation.

Successful and failed runs are stored in `OperationalHeartbeat`. The launch
monitor warns after 30 minutes without a successful run and becomes critical
after 180 minutes. These defaults can be changed with:

```text
SHOPIFY_PRODUCT_CATALOG_SYNC_WARNING_MINUTES=30
SHOPIFY_PRODUCT_CATALOG_SYNC_CRITICAL_MINUTES=180
```

The values must preserve this fail-closed ordering:

```text
sync interval (15) < warning < critical < projection TTL (1560)
```

The application reports a critical monitoring configuration error instead of
silently accepting values that violate this ordering.

Both scheduled GitHub workflows also call:

```text
POST /internal/sale-eligibility-watchdog
Authorization: Bearer <SALE_ELIGIBILITY_WATCHDOG_TOKEN>
```

`SALE_ELIGIBILITY_WATCHDOG_TOKEN` is dedicated to this endpoint and must not be
reused as the catalog synchronization token.

The watchdog first requests the normal application-side emergency stop. It also
has a direct Shopify fallback that does not depend on Render or PostgreSQL. The
fallback enumerates every product and its `APP`, `MARKET`,
`COMPANY_LOCATION`, and `NONE` publications, unpublishes every published or
scheduled product, and verifies that no publication remains.

Configure the fallback in the GitHub `production` environment:

```text
SALE_ELIGIBILITY_WATCHDOG_TOKEN=<same 32+ character secret configured on Render>
SHOPIFY_WATCHDOG_SHOP_DOMAIN=<production-shop.myshopify.com>
SHOPIFY_WATCHDOG_ADMIN_ACCESS_TOKEN=<token owned by the independent watchdog app>
```

The independent Shopify custom app must be restricted to:

```text
read_products,read_publications,write_publications
```

Do not reuse the main application access token. The direct fallback is an
emergency all-sales stop, so recovery requires an operator to verify the cause
and deliberately restore the intended publications.

Successful synchronization does not release a watchdog stop. A different
authorized operator must verify recovery evidence and explicitly restore sales.
The Function's embedded date is only a day-level final backstop; it is not
described as a minute-level lease.

Before go-live and every 90 days, perform a controlled drill with Render and DB
access intentionally unavailable. Preserve the workflow run, affected
publication count, final zero-publication verification, operator, timestamps,
and recovery approval as the evidence for
`INDEPENDENT_SALES_STOP_DRILL_COMPLETED`.

The production readiness and launch monitor checks also fail if the public Draft
Order endpoint is enabled, or if governed products remain attached to a Shopify
publication.
