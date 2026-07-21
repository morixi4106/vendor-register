-- Preserve legacy raw columns for compatibility, but new application writes use keyed hashes.
ALTER TABLE "buyer_warning_acceptances"
  ADD COLUMN "ipHash" TEXT,
  ADD COLUMN "userAgentHash" TEXT;

ALTER TABLE "withdrawal_requests"
  ADD COLUMN "ipHash" TEXT,
  ADD COLUMN "userAgentHash" TEXT;

CREATE INDEX "buyer_warning_acceptances_ipHash_acceptedAt_idx"
  ON "buyer_warning_acceptances"("ipHash", "acceptedAt");

CREATE INDEX "withdrawal_requests_ipHash_createdAt_idx"
  ON "withdrawal_requests"("ipHash", "createdAt");
