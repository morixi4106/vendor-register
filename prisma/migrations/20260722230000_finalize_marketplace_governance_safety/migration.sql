ALTER TABLE "marketplace_operational_cases"
  ADD COLUMN "decisionReasonCode" TEXT,
  ADD COLUMN "responsibilityConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "responsibilityConfirmedBy" TEXT;

ALTER TABLE "seller_settlement_adjustments"
  ADD COLUMN "originalAdjustmentId" TEXT;

ALTER TABLE "payout_runs"
  ADD COLUMN "createdBy" TEXT,
  ADD COLUMN "createdByJson" JSONB,
  ADD COLUMN "approvedByJson" JSONB,
  ADD COLUMN "processingAt" TIMESTAMP(3),
  ADD COLUMN "processingBy" TEXT,
  ADD COLUMN "processingByJson" JSONB,
  ADD COLUMN "executedByJson" JSONB;

CREATE INDEX "seller_settlement_adjustments_originalAdjustmentId_idx"
  ON "seller_settlement_adjustments"("originalAdjustmentId");

ALTER TABLE "seller_settlement_adjustments"
  ADD CONSTRAINT "seller_settlement_adjustments_originalAdjustmentId_fkey"
  FOREIGN KEY ("originalAdjustmentId") REFERENCES "seller_settlement_adjustments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "seller_compliance_profiles" DROP CONSTRAINT IF EXISTS "seller_compliance_profiles_sellerId_fkey";
ALTER TABLE "seller_compliance_profiles" ADD CONSTRAINT "seller_compliance_profiles_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "seller_agreement_acceptances" DROP CONSTRAINT IF EXISTS "seller_agreement_acceptances_sellerId_fkey";
ALTER TABLE "seller_agreement_acceptances" ADD CONSTRAINT "seller_agreement_acceptances_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "seller_settlement_controls" DROP CONSTRAINT IF EXISTS "seller_settlement_controls_sellerId_fkey";
ALTER TABLE "seller_settlement_controls" ADD CONSTRAINT "seller_settlement_controls_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "seller_settlement_adjustments" DROP CONSTRAINT IF EXISTS "seller_settlement_adjustments_sellerId_fkey";
ALTER TABLE "seller_settlement_adjustments" ADD CONSTRAINT "seller_settlement_adjustments_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payout_runs" DROP CONSTRAINT IF EXISTS "payout_runs_sellerId_fkey";
ALTER TABLE "payout_runs" ADD CONSTRAINT "payout_runs_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
