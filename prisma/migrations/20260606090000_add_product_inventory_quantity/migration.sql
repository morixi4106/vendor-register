ALTER TABLE "Product"
ADD COLUMN "inventoryQuantity" INTEGER;

ALTER TABLE "Product"
ADD CONSTRAINT "Product_inventoryQuantity_nonnegative"
CHECK ("inventoryQuantity" IS NULL OR "inventoryQuantity" >= 0);
