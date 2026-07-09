ALTER TABLE "withdrawal_requests"
  ADD COLUMN "completionStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
  ADD COLUMN "completionAction" TEXT,
  ADD COLUMN "completionShopifyRefundId" TEXT,
  ADD COLUMN "completionShopifyCancelId" TEXT,
  ADD COLUMN "completionRefundedAmount" INTEGER,
  ADD COLUMN "completionRefundedShipping" INTEGER,
  ADD COLUMN "completionCurrencyCode" TEXT,
  ADD COLUMN "completionNotes" TEXT,
  ADD COLUMN "completionRecordedAt" TIMESTAMP(3),
  ADD COLUMN "completionRecordedBy" TEXT,
  ADD COLUMN "completionNotifiedAt" TIMESTAMP(3),
  ADD COLUMN "completionEmailMessageId" TEXT;

CREATE INDEX "withdrawal_requests_completionStatus_createdAt_idx"
  ON "withdrawal_requests"("completionStatus", "createdAt");
