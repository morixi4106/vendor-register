ALTER TABLE "seller_order_shadow_checks"
ADD COLUMN IF NOT EXISTS "currencyCode" TEXT NOT NULL DEFAULT 'jpy';

DROP INDEX IF EXISTS "seller_orders_shopifyOrderId_sellerId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "seller_orders_marketplaceOrderId_sellerId_key"
ON "seller_orders"("marketplaceOrderId", "sellerId");
