CREATE TABLE "production_transaction_probes" (
    "id" TEXT NOT NULL,
    "activeKey" TEXT,
    "shopDomain" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "releaseFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_ORDER',
    "shopifyOrderId" TEXT,
    "marketplaceOrderId" TEXT,
    "startedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderAttachedAt" TIMESTAMP(3),
    "paidVerifiedAt" TIMESTAMP(3),
    "refundVerifiedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "evidenceHash" TEXT,
    "orderEvidenceJson" JSONB,
    "paidEvidenceJson" JSONB,
    "refundEvidenceJson" JSONB,
    "finalEvidenceJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_transaction_probes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_transaction_probes_activeKey_key"
ON "production_transaction_probes"("activeKey");

CREATE INDEX "production_transaction_probes_shopDomain_status_createdAt_idx"
ON "production_transaction_probes"("shopDomain", "status", "createdAt");

CREATE INDEX "production_transaction_probes_shopifyOrderId_idx"
ON "production_transaction_probes"("shopifyOrderId");

CREATE INDEX "production_transaction_probes_marketplaceOrderId_idx"
ON "production_transaction_probes"("marketplaceOrderId");
