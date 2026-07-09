ALTER TABLE "withdrawal_requests"
  ADD COLUMN "returnProofTokenHash" TEXT,
  ADD COLUMN "returnProofTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "returnProofSubmittedAt" TIMESTAMP(3);

CREATE INDEX "withdrawal_requests_returnProofTokenHash_idx"
  ON "withdrawal_requests"("returnProofTokenHash");
