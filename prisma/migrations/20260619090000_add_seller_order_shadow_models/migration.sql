CREATE TABLE IF NOT EXISTS "marketplace_orders" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "shopifyOrderId" TEXT NOT NULL,
  "shopifyOrderName" TEXT,
  "shopifyOrderNumber" TEXT,
  "buyerEmail" TEXT,
  "buyerName" TEXT,
  "totalAmount" INTEGER NOT NULL DEFAULT 0,
  "subtotalAmount" INTEGER NOT NULL DEFAULT 0,
  "shippingAmount" INTEGER NOT NULL DEFAULT 0,
  "discountAmount" INTEGER NOT NULL DEFAULT 0,
  "taxAmount" INTEGER NOT NULL DEFAULT 0,
  "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
  "financialStatus" TEXT,
  "fulfillmentStatus" TEXT,
  "processedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "seller_orders" (
  "id" TEXT NOT NULL,
  "marketplaceOrderId" TEXT NOT NULL,
  "shopifyOrderId" TEXT NOT NULL,
  "shopifyOrderName" TEXT,
  "sellerId" TEXT NOT NULL,
  "vendorStoreId" TEXT,
  "sellerSubtotalAmount" INTEGER NOT NULL DEFAULT 0,
  "sellerDiscountAmount" INTEGER NOT NULL DEFAULT 0,
  "sellerRefundAmount" INTEGER NOT NULL DEFAULT 0,
  "sellerNetAmount" INTEGER NOT NULL DEFAULT 0,
  "sellerPayableAmount" INTEGER NOT NULL DEFAULT 0,
  "shippingQuotedAmount" INTEGER NOT NULL DEFAULT 0,
  "shippingChargedAmount" INTEGER NOT NULL DEFAULT 0,
  "shippingAllocationMethod" TEXT NOT NULL DEFAULT 'not_allocated',
  "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
  "paymentStatus" TEXT NOT NULL DEFAULT 'paid',
  "fulfillmentStatus" TEXT NOT NULL DEFAULT 'unfulfilled',
  "settlementStatus" TEXT NOT NULL DEFAULT 'shadow',
  "riskStatus" TEXT NOT NULL DEFAULT 'normal',
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seller_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "seller_order_lines" (
  "id" TEXT NOT NULL,
  "sellerOrderId" TEXT NOT NULL,
  "shopifyLineItemId" TEXT NOT NULL,
  "shopifyProductId" TEXT,
  "shopifyVariantId" TEXT,
  "productId" TEXT,
  "title" TEXT,
  "sku" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "fulfilledQuantity" INTEGER NOT NULL DEFAULT 0,
  "refundedQuantity" INTEGER NOT NULL DEFAULT 0,
  "unitAmount" INTEGER NOT NULL DEFAULT 0,
  "lineSubtotalAmount" INTEGER NOT NULL DEFAULT 0,
  "discountAmount" INTEGER NOT NULL DEFAULT 0,
  "taxAmount" INTEGER NOT NULL DEFAULT 0,
  "netAmount" INTEGER NOT NULL DEFAULT 0,
  "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seller_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "seller_order_shadow_checks" (
  "id" TEXT NOT NULL,
  "marketplaceOrderId" TEXT,
  "shopDomain" TEXT NOT NULL,
  "shopifyOrderId" TEXT NOT NULL,
  "shopifyOrderName" TEXT,
  "status" TEXT NOT NULL,
  "legacyLedgerAmount" INTEGER,
  "sellerOrderCalculatedAmount" INTEGER,
  "legacySellerIdsJson" JSONB,
  "sellerOrderSellerIdsJson" JSONB,
  "differencesJson" JSONB,
  "errorMessage" TEXT,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seller_order_shadow_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_orders_shopDomain_shopifyOrderId_key"
ON "marketplace_orders"("shopDomain", "shopifyOrderId");

CREATE INDEX IF NOT EXISTS "marketplace_orders_shopifyOrderId_idx"
ON "marketplace_orders"("shopifyOrderId");

CREATE INDEX IF NOT EXISTS "marketplace_orders_shopDomain_createdAt_idx"
ON "marketplace_orders"("shopDomain", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "seller_orders_shopifyOrderId_sellerId_key"
ON "seller_orders"("shopifyOrderId", "sellerId");

CREATE INDEX IF NOT EXISTS "seller_orders_sellerId_createdAt_idx"
ON "seller_orders"("sellerId", "createdAt");

CREATE INDEX IF NOT EXISTS "seller_orders_vendorStoreId_createdAt_idx"
ON "seller_orders"("vendorStoreId", "createdAt");

CREATE INDEX IF NOT EXISTS "seller_orders_marketplaceOrderId_idx"
ON "seller_orders"("marketplaceOrderId");

CREATE UNIQUE INDEX IF NOT EXISTS "seller_order_lines_sellerOrderId_shopifyLineItemId_key"
ON "seller_order_lines"("sellerOrderId", "shopifyLineItemId");

CREATE INDEX IF NOT EXISTS "seller_order_lines_shopifyLineItemId_idx"
ON "seller_order_lines"("shopifyLineItemId");

CREATE INDEX IF NOT EXISTS "seller_order_lines_productId_idx"
ON "seller_order_lines"("productId");

CREATE INDEX IF NOT EXISTS "seller_order_shadow_checks_status_checkedAt_idx"
ON "seller_order_shadow_checks"("status", "checkedAt");

CREATE INDEX IF NOT EXISTS "seller_order_shadow_checks_shopifyOrderId_idx"
ON "seller_order_shadow_checks"("shopifyOrderId");

CREATE INDEX IF NOT EXISTS "seller_order_shadow_checks_marketplaceOrderId_idx"
ON "seller_order_shadow_checks"("marketplaceOrderId");

ALTER TABLE "seller_orders"
ADD CONSTRAINT "seller_orders_marketplaceOrderId_fkey"
FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "seller_order_lines"
ADD CONSTRAINT "seller_order_lines_sellerOrderId_fkey"
FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "seller_order_shadow_checks"
ADD CONSTRAINT "seller_order_shadow_checks_marketplaceOrderId_fkey"
FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
