-- Reconciled payout evidence is append-only. These unique constraints prevent
-- a payment, refund, or evidence file from being assigned to multiple batches.
DROP INDEX IF EXISTS "payment_settlement_lines_paymentAttemptId_idx";
DROP INDEX IF EXISTS "payment_settlement_lines_refundOperationId_idx";

CREATE UNIQUE INDEX "payment_settlement_batches_evidenceHash_key"
ON "payment_settlement_batches"("evidenceHash");

CREATE UNIQUE INDEX "payment_settlement_lines_paymentAttemptId_key"
ON "payment_settlement_lines"("paymentAttemptId");

CREATE UNIQUE INDEX "payment_settlement_lines_refundOperationId_key"
ON "payment_settlement_lines"("refundOperationId");
