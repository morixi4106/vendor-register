-- Preserve checkout-time buyer terms evidence on the order snapshots.
ALTER TABLE "marketplace_orders"
  ADD COLUMN "buyerTermsVersion" TEXT,
  ADD COLUMN "buyerTermsHash" TEXT,
  ADD COLUMN "buyerTermsUrl" TEXT,
  ADD COLUMN "buyerTermsLocale" TEXT,
  ADD COLUMN "buyerTermsPresentedAt" TIMESTAMP(3),
  ADD COLUMN "checkoutReference" TEXT;

ALTER TABLE "seller_orders"
  ADD COLUMN "buyerTermsHash" TEXT,
  ADD COLUMN "buyerTermsUrl" TEXT,
  ADD COLUMN "buyerTermsLocale" TEXT,
  ADD COLUMN "buyerTermsPresentedAt" TIMESTAMP(3),
  ADD COLUMN "checkoutReference" TEXT;

-- Agreement acceptances are evidence events. They must be append-only rather
-- than overwritten when the same document version is acknowledged again.
ALTER TABLE "seller_agreement_acceptances"
  ADD COLUMN "acceptanceKey" TEXT,
  ADD COLUMN "acceptedByUserId" TEXT,
  ADD COLUMN "acceptedByEmail" TEXT,
  ADD COLUMN "evidenceUrl" TEXT,
  ADD COLUMN "evidenceHash" TEXT;

UPDATE "seller_agreement_acceptances"
SET "acceptanceKey" = "id"
WHERE "acceptanceKey" IS NULL;

ALTER TABLE "seller_agreement_acceptances"
  ALTER COLUMN "acceptanceKey" SET NOT NULL;

DROP INDEX IF EXISTS "seller_agreement_acceptances_sellerId_agreementType_version_key";

CREATE UNIQUE INDEX "seller_agreement_acceptances_acceptanceKey_key"
  ON "seller_agreement_acceptances"("acceptanceKey");

CREATE INDEX "seller_agreement_acceptances_sellerId_agreementType_version_acceptedAt_idx"
ON "seller_agreement_acceptances"("sellerId", "agreementType", "version", "acceptedAt");

CREATE TABLE "marketplace_checkout_evidence" (
  "id" TEXT NOT NULL,
  "checkoutReference" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARED',
  "sellerAgreementVersion" TEXT,
  "sellerAgreementHash" TEXT,
  "sellerAgreementUrl" TEXT,
  "buyerTermsVersion" TEXT,
  "buyerTermsHash" TEXT,
  "buyerTermsUrl" TEXT,
  "buyerTermsLocale" TEXT,
  "presentedAt" TIMESTAMP(3) NOT NULL,
  "sellerSnapshotsJson" JSONB NOT NULL,
  "productSnapshotsJson" JSONB NOT NULL,
  "shopifyOrderId" TEXT,
  "orderCapturedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_checkout_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketplace_checkout_evidence_checkoutReference_key"
ON "marketplace_checkout_evidence"("checkoutReference");

CREATE INDEX "marketplace_checkout_evidence_shopDomain_createdAt_idx"
ON "marketplace_checkout_evidence"("shopDomain", "createdAt");

CREATE INDEX "marketplace_checkout_evidence_status_createdAt_idx"
ON "marketplace_checkout_evidence"("status", "createdAt");

CREATE INDEX "marketplace_checkout_evidence_shopifyOrderId_idx"
ON "marketplace_checkout_evidence"("shopifyOrderId");
