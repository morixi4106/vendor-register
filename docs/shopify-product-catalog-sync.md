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

Successful and failed runs are stored in `OperationalHeartbeat`. The launch
monitor warns after 30 minutes without a successful run and becomes critical
after 180 minutes. These defaults can be changed with:

```text
SHOPIFY_PRODUCT_CATALOG_SYNC_WARNING_MINUTES=30
SHOPIFY_PRODUCT_CATALOG_SYNC_CRITICAL_MINUTES=180
```

The production readiness and launch monitor checks also fail if the public Draft
Order endpoint is enabled, or if governed products remain attached to a Shopify
publication.
