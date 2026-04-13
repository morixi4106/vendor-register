ALTER TABLE "Product"
ADD COLUMN "priceSyncStatus" TEXT NOT NULL DEFAULT 'calculated_not_applied',
ADD COLUMN "priceSyncError" TEXT,
ADD COLUMN "priceAppliedAt" TIMESTAMP(3),
ADD COLUMN "lastPriceApplyAttemptAt" TIMESTAMP(3);

UPDATE "Product"
SET
  "priceSyncStatus" = 'applied',
  "priceAppliedAt" = COALESCE("priceAppliedAt", "calculatedAt")
WHERE "priceSnapshotJson" IS NOT NULL
   OR "calculatedAt" IS NOT NULL;
