ALTER TABLE "Product"
ADD COLUMN "shippingWeightConfirmedAt" TIMESTAMP(3),
ADD COLUMN "shippingWeightSource" TEXT NOT NULL DEFAULT 'UNSET',
ADD COLUMN "shopifyVariantCount" INTEGER,
ADD COLUMN "shopifyWeightSyncStatus" TEXT NOT NULL DEFAULT 'NOT_LINKED',
ADD COLUMN "shopifyWeightSyncedAt" TIMESTAMP(3),
ADD COLUMN "shopifyWeightSyncError" TEXT;

CREATE INDEX "Product_shopifyWeightSyncStatus_approvalStatus_idx"
ON "Product"("shopifyWeightSyncStatus", "approvalStatus");

CREATE TABLE "international_shipping_country_availabilities" (
  "id" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "service" TEXT NOT NULL DEFAULT 'JAPAN_POST_AIR_PACKET',
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "sourceUrl" TEXT,
  "note" TEXT,
  "checkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "international_shipping_country_availabilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "international_shipping_country_availabilities_countryCode_service_key"
ON "international_shipping_country_availabilities"("countryCode", "service");

CREATE INDEX "international_shipping_country_availabilities_service_status_checkedAt_idx"
ON "international_shipping_country_availabilities"("service", "status", "checkedAt");
