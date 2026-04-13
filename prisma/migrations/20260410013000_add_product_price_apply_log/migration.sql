CREATE TABLE "ProductPriceApplyLog" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "shopifyProductId" TEXT,
    "shopDomain" TEXT,
    "attemptedPrice" INTEGER,
    "priceFormulaVersion" TEXT,
    "status" TEXT NOT NULL,
    "errorSummary" TEXT,
    "priceSnapshotJson" JSONB,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceApplyLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProductPriceApplyLog"
ADD CONSTRAINT "ProductPriceApplyLog_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

CREATE INDEX "ProductPriceApplyLog_productId_attemptedAt_idx"
ON "ProductPriceApplyLog"("productId", "attemptedAt");

CREATE INDEX "ProductPriceApplyLog_shopifyProductId_shopDomain_attemptedAt_idx"
ON "ProductPriceApplyLog"("shopifyProductId", "shopDomain", "attemptedAt");
