-- Existing payout evidence remains available for audit, but it will not satisfy
-- release readiness until it has a Shopify API verification timestamp.
ALTER TABLE "shopify_payout_evidence"
  ADD COLUMN "shopifyPayoutGid" TEXT,
  ADD COLUMN "shopifyLegacyResourceId" TEXT,
  ADD COLUMN "shopifyVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "shopifyExternalTraceIdHash" TEXT,
  ADD COLUMN "shopifyVerificationJson" JSONB;

-- PostgreSQL permits multiple NULL values in a unique index. Existing
-- operator-entered evidence remains untouched, while every new API-verified
-- Shopify payout GID can be used only once across releases.
CREATE UNIQUE INDEX "shopify_payout_evidence_shopDomain_shopifyPayoutGid_key"
  ON "shopify_payout_evidence"("shopDomain", "shopifyPayoutGid");
