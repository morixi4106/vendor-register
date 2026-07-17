CREATE TABLE "shopify_product_sync_issues" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productTitle" TEXT,
    "vendorLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unresolved',
    "reason" TEXT NOT NULL,
    "candidateStoreIdsJson" JSONB,
    "payloadJson" JSONB NOT NULL,
    "resolvedVendorStoreId" TEXT,
    "localProductId" TEXT,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_product_sync_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopify_product_sync_issues_shopDomain_shopifyProductId_key"
ON "shopify_product_sync_issues"("shopDomain", "shopifyProductId");

CREATE INDEX "shopify_product_sync_issues_status_lastAttemptAt_idx"
ON "shopify_product_sync_issues"("status", "lastAttemptAt");

CREATE INDEX "shopify_product_sync_issues_resolvedVendorStoreId_idx"
ON "shopify_product_sync_issues"("resolvedVendorStoreId");
