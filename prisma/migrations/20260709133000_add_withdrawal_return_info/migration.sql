ALTER TABLE "withdrawal_requests"
  ADD COLUMN "returnRequirementStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
  ADD COLUMN "returnTrackingCompany" TEXT,
  ADD COLUMN "returnTrackingNumber" TEXT,
  ADD COLUMN "returnTrackingUrl" TEXT,
  ADD COLUMN "returnReceivedAt" TIMESTAMP(3),
  ADD COLUMN "returnConditionStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
  ADD COLUMN "returnConditionNotes" TEXT,
  ADD COLUMN "returnProofJson" JSONB,
  ADD COLUMN "returnInfoUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "returnInfoUpdatedBy" TEXT;

CREATE INDEX "withdrawal_requests_returnRequirementStatus_createdAt_idx"
  ON "withdrawal_requests"("returnRequirementStatus", "createdAt");
