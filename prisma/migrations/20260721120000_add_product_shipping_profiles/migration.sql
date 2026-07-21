ALTER TABLE "Product"
ADD COLUMN "shippingWeightGrams" INTEGER,
ADD COLUMN "shippingLengthMm" INTEGER,
ADD COLUMN "shippingWidthMm" INTEGER,
ADD COLUMN "shippingHeightMm" INTEGER,
ADD COLUMN "internationalShippingMethod" TEXT NOT NULL DEFAULT 'UNCONFIGURED';

CREATE INDEX "Product_internationalShippingMethod_approvalStatus_idx"
ON "Product"("internationalShippingMethod", "approvalStatus");
