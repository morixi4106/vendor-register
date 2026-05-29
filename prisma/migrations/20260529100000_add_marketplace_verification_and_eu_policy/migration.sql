-- Add seller verification, EU sale controls, and buyer warning audit records.

ALTER TABLE "sellers"
ADD COLUMN IF NOT EXISTS "sellerLegalRole" TEXT NOT NULL DEFAULT 'MARKETPLACE_SELLER',
ADD COLUMN IF NOT EXISTS "sellerVerificationStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN IF NOT EXISTS "euSellerStatus" TEXT NOT NULL DEFAULT 'DISABLED',
ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "documentVerificationStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN IF NOT EXISTS "documentVerifiedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "documentVerifiedBy" TEXT,
ADD COLUMN IF NOT EXISTS "verificationNameMatched" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "payoutNameMatched" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "verificationReviewNotes" TEXT;

ALTER TABLE "Product"
ADD COLUMN IF NOT EXISTS "productEuStatus" TEXT NOT NULL DEFAULT 'DISABLED',
ADD COLUMN IF NOT EXISTS "euSaleRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "regulatorySelfCertificationJson" JSONB;

CREATE TABLE IF NOT EXISTS "seller_verification_records" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "verifiedBy" TEXT,
  "verificationMethod" TEXT,
  "documentType" TEXT,
  "documentCountry" TEXT,
  "documentLast4" TEXT,
  "nameMatched" BOOLEAN NOT NULL DEFAULT false,
  "payoutNameMatched" BOOLEAN NOT NULL DEFAULT false,
  "phoneVerifiedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "reviewNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "seller_verification_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "product_country_policies" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "allowedCountries" JSONB,
  "blockedCountries" JSONB,
  "requiresWarningCountries" JSONB,
  "euSaleStatus" TEXT NOT NULL DEFAULT 'DISABLED',
  "warningVersion" TEXT NOT NULL DEFAULT 'import-responsibility-v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_country_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "buyer_warning_acceptances" (
  "id" TEXT NOT NULL,
  "orderId" TEXT,
  "buyerId" TEXT,
  "selectedCountry" TEXT,
  "shippingCountry" TEXT NOT NULL,
  "productIds" JSONB NOT NULL,
  "warningVersion" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "importResponsibilityAccepted" BOOLEAN NOT NULL DEFAULT false,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "buyer_warning_acceptances_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "sellers_sellerVerificationStatus_updatedAt_idx" ON "sellers"("sellerVerificationStatus", "updatedAt");
CREATE INDEX IF NOT EXISTS "sellers_euSellerStatus_updatedAt_idx" ON "sellers"("euSellerStatus", "updatedAt");
CREATE INDEX IF NOT EXISTS "Product_productEuStatus_updatedAt_idx" ON "Product"("productEuStatus", "updatedAt");
CREATE INDEX IF NOT EXISTS "seller_verification_records_sellerId_createdAt_idx" ON "seller_verification_records"("sellerId", "createdAt");
CREATE INDEX IF NOT EXISTS "seller_verification_records_status_createdAt_idx" ON "seller_verification_records"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "product_country_policies_productId_key" ON "product_country_policies"("productId");
CREATE INDEX IF NOT EXISTS "product_country_policies_euSaleStatus_updatedAt_idx" ON "product_country_policies"("euSaleStatus", "updatedAt");
CREATE INDEX IF NOT EXISTS "buyer_warning_acceptances_orderId_idx" ON "buyer_warning_acceptances"("orderId");
CREATE INDEX IF NOT EXISTS "buyer_warning_acceptances_shippingCountry_acceptedAt_idx" ON "buyer_warning_acceptances"("shippingCountry", "acceptedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'seller_verification_records_sellerId_fkey'
  ) THEN
    ALTER TABLE "seller_verification_records"
    ADD CONSTRAINT "seller_verification_records_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_country_policies_productId_fkey'
  ) THEN
    ALTER TABLE "product_country_policies"
    ADD CONSTRAINT "product_country_policies_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
