CREATE TABLE "shopify_payout_evidence" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "releaseFingerprint" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "payoutStatus" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "shopifyPayoutDate" TIMESTAMP(3) NOT NULL,
    "bankDepositedAt" TIMESTAMP(3) NOT NULL,
    "bankReferenceMasked" TEXT NOT NULL,
    "evidenceReference" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "submittedBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "singleOperatorWaiver" BOOLEAN NOT NULL DEFAULT false,
    "singleOperatorWaiverReason" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_payout_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopify_payout_evidence_shopDomain_payoutId_releaseId_key"
ON "shopify_payout_evidence"("shopDomain", "payoutId", "releaseId");

CREATE INDEX "shopify_payout_evidence_releaseId_status_submittedAt_idx"
ON "shopify_payout_evidence"("releaseId", "status", "submittedAt");

CREATE INDEX "shopify_payout_evidence_shopDomain_status_submittedAt_idx"
ON "shopify_payout_evidence"("shopDomain", "status", "submittedAt");
