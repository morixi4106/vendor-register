ALTER TABLE "withdrawal_requests"
  ADD COLUMN "refundDecisionStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
  ADD COLUMN "refundItemAmount" INTEGER,
  ADD COLUMN "refundInitialShippingAmount" INTEGER,
  ADD COLUMN "refundDeductionAmount" INTEGER,
  ADD COLUMN "refundTotalAmount" INTEGER,
  ADD COLUMN "refundCurrencyCode" TEXT,
  ADD COLUMN "returnShippingPayer" TEXT,
  ADD COLUMN "refundDecisionReason" TEXT,
  ADD COLUMN "refundDecisionNotes" TEXT,
  ADD COLUMN "refundDecisionUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "refundDecisionUpdatedBy" TEXT;

CREATE INDEX "withdrawal_requests_refundDecisionStatus_createdAt_idx"
  ON "withdrawal_requests"("refundDecisionStatus", "createdAt");
