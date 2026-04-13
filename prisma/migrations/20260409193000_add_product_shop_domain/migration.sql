ALTER TABLE "Product"
ADD COLUMN "shopDomain" TEXT;

CREATE UNIQUE INDEX "Product_shopDomain_shopifyProductId_key"
ON "Product"("shopDomain", "shopifyProductId");

CREATE INDEX "Product_shopifyProductId_idx"
ON "Product"("shopifyProductId");
