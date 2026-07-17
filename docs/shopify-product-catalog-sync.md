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
