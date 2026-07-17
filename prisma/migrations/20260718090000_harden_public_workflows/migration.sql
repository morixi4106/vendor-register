ALTER TABLE "withdrawal_requests"
  ADD COLUMN "receiptTokenHash" TEXT,
  ADD COLUMN "receiptTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "receiptTokenRevokedAt" TIMESTAMP(3),
  ADD COLUMN "receiptTokenFirstUsedAt" TIMESTAMP(3),
  ADD COLUMN "receiptTokenLastUsedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "withdrawal_requests_receiptTokenHash_key"
  ON "withdrawal_requests"("receiptTokenHash");

CREATE INDEX "withdrawal_requests_receiptTokenExpiresAt_idx"
  ON "withdrawal_requests"("receiptTokenExpiresAt");

CREATE TABLE "public_endpoint_rate_limits" (
  "id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "public_endpoint_rate_limits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_endpoint_rate_limits_endpoint_keyHash_windowStart_key"
  ON "public_endpoint_rate_limits"("endpoint", "keyHash", "windowStart");

CREATE INDEX "public_endpoint_rate_limits_endpoint_expiresAt_idx"
  ON "public_endpoint_rate_limits"("endpoint", "expiresAt");
