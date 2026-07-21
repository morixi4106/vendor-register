ALTER TABLE "payout_runs"
ADD COLUMN "approvedTransferMethod" TEXT,
ADD COLUMN "approvedPayoutRecipientId" TEXT,
ADD COLUMN "approvedRecipientHash" TEXT,
ADD COLUMN "approvedRecipientSnapshotJson" JSONB,
ADD COLUMN "approvedCurrencyCode" TEXT,
ADD COLUMN "reconciliationRequiredAt" TIMESTAMP(3),
ADD COLUMN "reconciliationReason" TEXT,
ADD COLUMN "returnedAt" TIMESTAMP(3);

CREATE INDEX "payout_runs_status_reconciliationRequiredAt_idx"
ON "payout_runs"("status", "reconciliationRequiredAt");

CREATE UNIQUE INDEX "payout_runs_transferMethod_externalTransferId_key"
ON "payout_runs"("transferMethod", "externalTransferId")
WHERE "externalTransferId" IS NOT NULL;

CREATE UNIQUE INDEX "ledger_entries_payoutRunId_entryType_lifecycle_key"
ON "ledger_entries"("payoutRunId", "entryType")
WHERE "payoutRunId" IS NOT NULL
  AND "entryType" IN ('payout_paid', 'payout_returned');
