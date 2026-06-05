CREATE TABLE IF NOT EXISTS "sales_credit_offsets" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
  "status" TEXT NOT NULL DEFAULT 'authorized',
  "checkoutReference" TEXT,
  "idempotencyKey" TEXT,
  "expiresAt" TIMESTAMP(3),
  "capturedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releaseReason" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_credit_offsets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sales_credit_offsets_idempotencyKey_key"
ON "sales_credit_offsets"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "sales_credit_offsets_sellerId_status_expiresAt_idx"
ON "sales_credit_offsets"("sellerId", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "sales_credit_offsets_checkoutReference_idx"
ON "sales_credit_offsets"("checkoutReference");

ALTER TABLE "sales_credit_offsets"
ADD CONSTRAINT "sales_credit_offsets_sellerId_fkey"
FOREIGN KEY ("sellerId") REFERENCES "sellers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
