ALTER TABLE "Product"
ADD COLUMN IF NOT EXISTS "shopifyVariantId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Product_shopDomain_shopifyVariantId_key"
ON "Product"("shopDomain", "shopifyVariantId");

CREATE INDEX IF NOT EXISTS "Product_shopifyVariantId_idx"
ON "Product"("shopifyVariantId");
