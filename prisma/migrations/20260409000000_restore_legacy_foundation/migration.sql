-- Missing foundation from schema 39f0aaf8953587baf03d5dcc83a0046d9928da3e,
-- immediately before the first Product ALTER migration. Never alter applied SQL.
-- Existing complete databases are a no-op; partial/later histories fail closed.
DO $legacy_foundation$
DECLARE
  existing_count INTEGER;
BEGIN
  SELECT count(*) INTO existing_count
  FROM unnest(ARRAY['Product', 'Vendor', 'VendorLoginCode', 'VendorAdminSession',
    'ContactInquiry', 'FixedReplyCandidate', 'FixedReplyRule', 'FxRate']) AS name
  WHERE to_regclass(format('%I.%I', current_schema(), name)) IS NOT NULL;
  IF existing_count = 8 THEN RETURN; END IF;
  IF existing_count <> 0 THEN
    RAISE EXCEPTION 'legacy_foundation_partial_schema';
  END IF;
  IF EXISTS (SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name > '20260409000000_restore_legacy_foundation'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'legacy_foundation_later_history_without_tables';
  END IF;

  CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "category" TEXT,
    "price" INTEGER NOT NULL,
    "costAmount" DECIMAL(12,2),
    "costCurrency" TEXT NOT NULL DEFAULT 'JPY',
    "url" TEXT,
    "vendorStoreId" TEXT NOT NULL,
    "approvalStatus" TEXT NOT NULL DEFAULT 'pending',
    "shopifyProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Product_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId")
      REFERENCES "VendorStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE
  );
  CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorStoreId" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "managementEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vendor_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId")
      REFERENCES "VendorStore"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE UNIQUE INDEX "Vendor_vendorStoreId_key" ON "Vendor"("vendorStoreId");
  CREATE UNIQUE INDEX "Vendor_handle_key" ON "Vendor"("handle");
  CREATE TABLE "VendorLoginCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorLoginCode_vendorId_fkey" FOREIGN KEY ("vendorId")
      REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE INDEX "VendorLoginCode_email_idx" ON "VendorLoginCode"("email");
  CREATE INDEX "VendorLoginCode_code_idx" ON "VendorLoginCode"("code");
  CREATE INDEX "VendorLoginCode_expiresAt_idx" ON "VendorLoginCode"("expiresAt");
  CREATE TABLE "VendorAdminSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorId" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorAdminSession_vendorId_fkey" FOREIGN KEY ("vendorId")
      REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE UNIQUE INDEX "VendorAdminSession_sessionToken_key" ON "VendorAdminSession"("sessionToken");
  CREATE INDEX "VendorAdminSession_vendorId_idx" ON "VendorAdminSession"("vendorId");
  CREATE INDEX "VendorAdminSession_expiresAt_idx" ON "VendorAdminSession"("expiresAt");
  CREATE TABLE "ContactInquiry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "message" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "replyType" TEXT NOT NULL,
    "matchedRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "FixedReplyCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "message" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "FixedReplyRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyword" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  );
  CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  );
  CREATE UNIQUE INDEX "FxRate_base_quote_key" ON "FxRate"("base", "quote");
END
$legacy_foundation$;
