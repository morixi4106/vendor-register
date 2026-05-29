-- Add seller verification, EU sale controls, and buyer warning audit records.

ALTER TABLE "sellers"
ADD COLUMN "sellerLegalRole" TEXT NOT NULL DEFAULT 'MARKETPLACE_SELLER',
ADD COLUMN "sellerVerificationStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN "euSellerStatus" TEXT NOT NULL DEFAULT 'DISABLED',
ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN "documentVerificationStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN "documentVerifiedAt" TIMESTAMP(3),
ADD COLUMN "documentVerifiedBy" TEXT,
ADD COLUMN "verificationNameMatched" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "payoutNameMatched" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "verificationReviewNotes" TEXT;

ALTER TABLE "products"
ADD COLUMN "productEuStatus" TEXT NOT NULL DEFAULT 'DISABLED',
ADD COLUMN "euSaleRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "regulatorySelfCertificationJson" JSONB;

CREATE TABLE "seller_verification_records" (
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

CREATE TABLE "product_country_policies" (
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

CREATE TABLE "buyer_warning_acceptances" (
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

CREATE INDEX "sellers_sellerVerificationStatus_updatedAt_idx" ON "sellers"("sellerVerificationStatus", "updatedAt");
CREATE INDEX "sellers_euSellerStatus_updatedAt_idx" ON "sellers"("euSellerStatus", "updatedAt");
CREATE INDEX "products_productEuStatus_updatedAt_idx" ON "products"("productEuStatus", "updatedAt");
CREATE INDEX "seller_verification_records_sellerId_createdAt_idx" ON "seller_verification_records"("sellerId", "createdAt");
CREATE INDEX "seller_verification_records_status_createdAt_idx" ON "seller_verification_records"("status", "createdAt");
CREATE UNIQUE INDEX "product_country_policies_productId_key" ON "product_country_policies"("productId");
CREATE INDEX "product_country_policies_euSaleStatus_updatedAt_idx" ON "product_country_policies"("euSaleStatus", "updatedAt");
CREATE INDEX "buyer_warning_acceptances_orderId_idx" ON "buyer_warning_acceptances"("orderId");
CREATE INDEX "buyer_warning_acceptances_shippingCountry_acceptedAt_idx" ON "buyer_warning_acceptances"("shippingCountry", "acceptedAt");

ALTER TABLE "seller_verification_records"
ADD CONSTRAINT "seller_verification_records_sellerId_fkey"
FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_country_policies"
ADD CONSTRAINT "product_country_policies_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
