ALTER TABLE "seller_orders"
ADD COLUMN "governanceSnapshotVersion" TEXT,
ADD COLUMN "legalSellerSnapshotJson" JSONB,
ADD COLUMN "sellerAgreementSnapshotJson" JSONB,
ADD COLUMN "buyerTermsVersion" TEXT;

ALTER TABLE "seller_order_lines"
ADD COLUMN "legalSellerSnapshotJson" JSONB,
ADD COLUMN "complianceSnapshotJson" JSONB,
ADD COLUMN "sellerAgreementVersion" TEXT;

CREATE TABLE "seller_compliance_profiles" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL DEFAULT 'UNSET',
  "legalName" TEXT,
  "representativeName" TEXT,
  "postalCode" TEXT,
  "countryCode" TEXT,
  "region" TEXT,
  "city" TEXT,
  "address1" TEXT,
  "address2" TEXT,
  "phone" TEXT,
  "invoiceRegistrationNumber" TEXT,
  "permitsJson" JSONB,
  "antisocialDeclarationAt" TIMESTAMP(3),
  "shipFromConfirmedAt" TIMESTAMP(3),
  "privacyNoticeAcceptedAt" TIMESTAMP(3),
  "reviewStatus" TEXT NOT NULL DEFAULT 'DRAFT',
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "reviewNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seller_compliance_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "seller_agreement_acceptances" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "agreementType" TEXT NOT NULL DEFAULT 'SELLER_MASTER',
  "version" TEXT NOT NULL,
  "documentHash" TEXT NOT NULL,
  "acceptedBy" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'ADMIN_RECORDED',
  "ipHash" TEXT,
  "userAgentHash" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "revocationReason" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seller_agreement_acceptances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "seller_settlement_controls" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "salesHold" BOOLEAN NOT NULL DEFAULT false,
  "payoutHold" BOOLEAN NOT NULL DEFAULT false,
  "holdReason" TEXT,
  "reserveAmount" INTEGER NOT NULL DEFAULT 0,
  "futureSetoffEnabled" BOOLEAN NOT NULL DEFAULT false,
  "directInvoiceBalance" INTEGER NOT NULL DEFAULT 0,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seller_settlement_controls_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_compliance_profiles" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "legalSellerType" TEXT NOT NULL DEFAULT 'VENDOR',
  "conditionStatus" TEXT NOT NULL DEFAULT 'UNSET',
  "countryOfOriginCode" TEXT,
  "hsCode" TEXT,
  "customsDescriptionEn" TEXT,
  "regulatoryCategory" TEXT,
  "regulatoryMarksJson" JSONB,
  "ageRestriction" TEXT,
  "authenticityConfirmedAt" TIMESTAMP(3),
  "ipRightsConfirmedAt" TIMESTAMP(3),
  "approvalStatus" TEXT NOT NULL DEFAULT 'DRAFT',
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "reviewNotes" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_compliance_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketplace_operational_cases" (
  "id" TEXT NOT NULL,
  "caseNumber" TEXT NOT NULL,
  "caseType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  "marketplaceOrderId" TEXT,
  "sellerOrderId" TEXT,
  "sellerId" TEXT,
  "responsibilitySellerId" TEXT,
  "vendorStoreId" TEXT,
  "productId" TEXT,
  "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
  "claimedAmount" INTEGER NOT NULL DEFAULT 0,
  "confirmedSellerLiabilityAmount" INTEGER NOT NULL DEFAULT 0,
  "platformLiabilityAmount" INTEGER NOT NULL DEFAULT 0,
  "responsibilityStatus" TEXT NOT NULL DEFAULT 'UNDETERMINED',
  "summary" TEXT NOT NULL,
  "detailsJson" JSONB,
  "evidenceJson" JSONB,
  "resolutionType" TEXT,
  "resolutionNotes" TEXT,
  "dueAt" TIMESTAMP(3),
  "assignedTo" TEXT,
  "openedBy" TEXT NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_operational_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketplace_operational_case_events" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "actor" TEXT NOT NULL,
  "note" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketplace_operational_case_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "seller_settlement_adjustments" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "caseId" TEXT,
  "adjustmentType" TEXT NOT NULL,
  "direction" TEXT NOT NULL DEFAULT 'debit',
  "amount" INTEGER NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "approvedBy" TEXT,
  "appliedAt" TIMESTAMP(3),
  "appliedBy" TEXT,
  "ledgerEntryId" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seller_settlement_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seller_compliance_profiles_sellerId_key" ON "seller_compliance_profiles"("sellerId");
CREATE INDEX "seller_compliance_profiles_reviewStatus_updatedAt_idx" ON "seller_compliance_profiles"("reviewStatus", "updatedAt");
CREATE UNIQUE INDEX "seller_agreement_acceptances_sellerId_agreementType_version_key" ON "seller_agreement_acceptances"("sellerId", "agreementType", "version");
CREATE INDEX "seller_agreement_acceptances_agreementType_version_acceptedAt_idx" ON "seller_agreement_acceptances"("agreementType", "version", "acceptedAt");
CREATE UNIQUE INDEX "seller_settlement_controls_sellerId_key" ON "seller_settlement_controls"("sellerId");
CREATE INDEX "seller_settlement_controls_payoutHold_salesHold_updatedAt_idx" ON "seller_settlement_controls"("payoutHold", "salesHold", "updatedAt");
CREATE UNIQUE INDEX "product_compliance_profiles_productId_key" ON "product_compliance_profiles"("productId");
CREATE INDEX "product_compliance_profiles_approvalStatus_updatedAt_idx" ON "product_compliance_profiles"("approvalStatus", "updatedAt");
CREATE INDEX "product_compliance_profiles_countryOfOriginCode_hsCode_idx" ON "product_compliance_profiles"("countryOfOriginCode", "hsCode");
CREATE UNIQUE INDEX "marketplace_operational_cases_caseNumber_key" ON "marketplace_operational_cases"("caseNumber");
CREATE INDEX "marketplace_operational_cases_status_priority_updatedAt_idx" ON "marketplace_operational_cases"("status", "priority", "updatedAt");
CREATE INDEX "marketplace_operational_cases_sellerId_status_createdAt_idx" ON "marketplace_operational_cases"("sellerId", "status", "createdAt");
CREATE INDEX "marketplace_operational_cases_marketplaceOrderId_createdAt_idx" ON "marketplace_operational_cases"("marketplaceOrderId", "createdAt");
CREATE INDEX "marketplace_operational_cases_sellerOrderId_createdAt_idx" ON "marketplace_operational_cases"("sellerOrderId", "createdAt");
CREATE INDEX "marketplace_operational_case_events_caseId_createdAt_idx" ON "marketplace_operational_case_events"("caseId", "createdAt");
CREATE UNIQUE INDEX "seller_settlement_adjustments_ledgerEntryId_key" ON "seller_settlement_adjustments"("ledgerEntryId");
CREATE INDEX "seller_settlement_adjustments_sellerId_status_createdAt_idx" ON "seller_settlement_adjustments"("sellerId", "status", "createdAt");
CREATE INDEX "seller_settlement_adjustments_caseId_createdAt_idx" ON "seller_settlement_adjustments"("caseId", "createdAt");

ALTER TABLE "seller_compliance_profiles" ADD CONSTRAINT "seller_compliance_profiles_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seller_agreement_acceptances" ADD CONSTRAINT "seller_agreement_acceptances_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seller_settlement_controls" ADD CONSTRAINT "seller_settlement_controls_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_compliance_profiles" ADD CONSTRAINT "product_compliance_profiles_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_operational_cases" ADD CONSTRAINT "marketplace_operational_cases_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_operational_cases" ADD CONSTRAINT "marketplace_operational_cases_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_operational_cases" ADD CONSTRAINT "marketplace_operational_cases_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_operational_cases" ADD CONSTRAINT "marketplace_operational_cases_responsibilitySellerId_fkey" FOREIGN KEY ("responsibilitySellerId") REFERENCES "sellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_operational_cases" ADD CONSTRAINT "marketplace_operational_cases_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId") REFERENCES "VendorStore"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_operational_cases" ADD CONSTRAINT "marketplace_operational_cases_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_operational_case_events" ADD CONSTRAINT "marketplace_operational_case_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "marketplace_operational_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seller_settlement_adjustments" ADD CONSTRAINT "seller_settlement_adjustments_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seller_settlement_adjustments" ADD CONSTRAINT "seller_settlement_adjustments_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "marketplace_operational_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
