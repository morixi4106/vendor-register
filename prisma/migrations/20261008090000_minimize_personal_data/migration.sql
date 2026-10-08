ALTER TABLE "VendorStore" ADD COLUMN "emailLookupHash" TEXT;
ALTER TABLE "VendorStore" ADD COLUMN "publicAddress" TEXT;
ALTER TABLE "VendorStore" ADD COLUMN "publicDescription" TEXT;
CREATE INDEX "VendorStore_emailLookupHash_idx" ON "VendorStore"("emailLookupHash");
ALTER TABLE "Vendor" ADD COLUMN "managementEmailLookupHash" TEXT;
CREATE INDEX "Vendor_managementEmailLookupHash_idx" ON "Vendor"("managementEmailLookupHash");
ALTER TABLE "VendorLoginCode" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ContactInquiry" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "ContactInquiry" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "ContactInquiry" ADD COLUMN "retentionHold" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "ContactInquiry_status_resolvedAt_idx" ON "ContactInquiry"("status", "resolvedAt");
ALTER TABLE "ContactInquiry" ADD COLUMN "emailLookupHash" TEXT;
CREATE INDEX "ContactInquiry_emailLookupHash_idx" ON "ContactInquiry"("emailLookupHash");
CREATE TABLE "privacy_rights_requests" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "customerEmailHash" TEXT,
  "shopifyCustomerId" TEXT,
  "externalRequestId" TEXT,
  "orderIdsJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "evidenceReference" TEXT,
  "evidenceHash" TEXT,
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "privacy_rights_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "privacy_rights_requests_requestKey_key" ON "privacy_rights_requests"("requestKey");
CREATE INDEX "privacy_rights_requests_shopDomain_status_deadlineAt_idx" ON "privacy_rights_requests"("shopDomain", "status", "deadlineAt");
