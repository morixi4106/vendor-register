CREATE TABLE "domestic_marketplace_pilots" (
    "id" TEXT NOT NULL,
    "vendorStoreId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "countryCode" TEXT NOT NULL DEFAULT 'JP',
    "maxQuantityPerOrder" INTEGER NOT NULL DEFAULT 1,
    "maxOrderSubtotalAmount" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "approvalReference" TEXT,
    "approvalEvidenceHash" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "checkoutClaimReference" TEXT,
    "checkoutClaimedAt" TIMESTAMP(3),
    "draftOrderId" TEXT,
    "draftOrderCreatedAt" TIMESTAMP(3),
    "shopifyOrderId" TEXT,
    "paidAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedBy" TEXT,
    "blockReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domestic_marketplace_pilots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domestic_marketplace_pilots_vendorStoreId_key" ON "domestic_marketplace_pilots"("vendorStoreId");
CREATE UNIQUE INDEX "domestic_marketplace_pilots_productId_key" ON "domestic_marketplace_pilots"("productId");
CREATE UNIQUE INDEX "domestic_marketplace_pilots_checkoutClaimReference_key" ON "domestic_marketplace_pilots"("checkoutClaimReference");
CREATE UNIQUE INDEX "domestic_marketplace_pilots_shopifyOrderId_key" ON "domestic_marketplace_pilots"("shopifyOrderId");

-- Close concurrent activation races while retaining completed pilots as history.
CREATE UNIQUE INDEX "domestic_marketplace_pilots_single_live_slot_key"
ON "domestic_marketplace_pilots" ((1))
WHERE "status" IN ('ACTIVE', 'RESERVED', 'ORDER_CREATED');

CREATE INDEX "domestic_marketplace_pilots_status_startsAt_expiresAt_idx" ON "domestic_marketplace_pilots"("status", "startsAt", "expiresAt");

ALTER TABLE "domestic_marketplace_pilots"
ADD CONSTRAINT "domestic_marketplace_pilots_country_jp_check"
CHECK ("countryCode" = 'JP');

ALTER TABLE "domestic_marketplace_pilots"
ADD CONSTRAINT "domestic_marketplace_pilots_quantity_one_check"
CHECK ("maxQuantityPerOrder" = 1);

ALTER TABLE "domestic_marketplace_pilots"
ADD CONSTRAINT "domestic_marketplace_pilots_positive_amount_check"
CHECK ("maxOrderSubtotalAmount" > 0);

ALTER TABLE "domestic_marketplace_pilots"
ADD CONSTRAINT "domestic_marketplace_pilots_status_check"
CHECK ("status" IN ('DRAFT', 'PREPARED', 'ACTIVE', 'RESERVED', 'ORDER_CREATED', 'BLOCKED', 'COMPLETED'));

ALTER TABLE "domestic_marketplace_pilots"
ADD CONSTRAINT "domestic_marketplace_pilots_period_check"
CHECK (
    "startsAt" IS NULL OR
    "expiresAt" IS NULL OR
    ("expiresAt" > "startsAt" AND "expiresAt" <= "startsAt" + INTERVAL '7 days')
);

ALTER TABLE "domestic_marketplace_pilots" ADD CONSTRAINT "domestic_marketplace_pilots_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId") REFERENCES "VendorStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "domestic_marketplace_pilots" ADD CONSTRAINT "domestic_marketplace_pilots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
