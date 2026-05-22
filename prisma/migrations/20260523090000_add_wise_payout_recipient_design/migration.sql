-- Add Wise payout recipient storage and Wise transfer tracking.
-- This is schema-only groundwork; no live Wise transfer execution is enabled by this migration.

CREATE TABLE "seller_payout_recipients" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'wise',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "countryCode" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "legalType" TEXT,
    "accountHolderName" TEXT,
    "wiseProfileId" TEXT,
    "wiseRecipientId" TEXT,
    "wiseRecipientHash" TEXT,
    "accountSummary" TEXT,
    "longAccountSummary" TEXT,
    "recipientPayloadJson" JSONB,
    "requirementsJson" JSONB,
    "verificationJson" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_payout_recipients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wise_transfer_events" (
    "id" TEXT NOT NULL,
    "wiseEventId" TEXT NOT NULL,
    "wiseTransferId" TEXT,
    "payoutRunId" TEXT,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wise_transfer_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payout_runs"
ADD COLUMN "sellerPayoutRecipientId" TEXT,
ADD COLUMN "wiseQuoteId" TEXT,
ADD COLUMN "wiseTransferId" TEXT,
ADD COLUMN "wiseTransferStatus" TEXT,
ADD COLUMN "wiseCustomerTransactionId" TEXT,
ADD COLUMN "wiseSourceCurrency" TEXT,
ADD COLUMN "wiseTargetCurrency" TEXT,
ADD COLUMN "wiseSourceAmount" DECIMAL(18,6),
ADD COLUMN "wiseTargetAmount" DECIMAL(18,6),
ADD COLUMN "wiseFeeAmount" DECIMAL(18,6),
ADD COLUMN "wiseRate" DECIMAL(18,10),
ADD COLUMN "wiseFailureCode" TEXT,
ADD COLUMN "wiseFailureMessage" TEXT,
ADD COLUMN "wisePayloadJson" JSONB;

ALTER TABLE "payout_runs"
DROP CONSTRAINT "payout_runs_sellerStripeAccountId_fkey";

ALTER TABLE "payout_runs"
ALTER COLUMN "sellerStripeAccountId" DROP NOT NULL,
ALTER COLUMN "stripeAccountId" DROP NOT NULL;

CREATE UNIQUE INDEX "seller_payout_recipients_sellerId_key" ON "seller_payout_recipients"("sellerId");
CREATE UNIQUE INDEX "seller_payout_recipients_wiseRecipientId_key" ON "seller_payout_recipients"("wiseRecipientId");
CREATE INDEX "seller_payout_recipients_provider_status_idx" ON "seller_payout_recipients"("provider", "status");
CREATE INDEX "seller_payout_recipients_wiseRecipientId_idx" ON "seller_payout_recipients"("wiseRecipientId");

CREATE UNIQUE INDEX "payout_runs_wiseTransferId_key" ON "payout_runs"("wiseTransferId");
CREATE UNIQUE INDEX "payout_runs_wiseCustomerTransactionId_key" ON "payout_runs"("wiseCustomerTransactionId");
CREATE INDEX "payout_runs_sellerPayoutRecipientId_createdAt_idx" ON "payout_runs"("sellerPayoutRecipientId", "createdAt");
CREATE INDEX "payout_runs_wiseTransferStatus_updatedAt_idx" ON "payout_runs"("wiseTransferStatus", "updatedAt");

CREATE UNIQUE INDEX "wise_transfer_events_wiseEventId_key" ON "wise_transfer_events"("wiseEventId");
CREATE INDEX "wise_transfer_events_wiseTransferId_createdAt_idx" ON "wise_transfer_events"("wiseTransferId", "createdAt");
CREATE INDEX "wise_transfer_events_payoutRunId_createdAt_idx" ON "wise_transfer_events"("payoutRunId", "createdAt");

ALTER TABLE "seller_payout_recipients"
ADD CONSTRAINT "seller_payout_recipients_sellerId_fkey"
FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payout_runs"
ADD CONSTRAINT "payout_runs_sellerStripeAccountId_fkey"
FOREIGN KEY ("sellerStripeAccountId") REFERENCES "seller_stripe_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payout_runs"
ADD CONSTRAINT "payout_runs_sellerPayoutRecipientId_fkey"
FOREIGN KEY ("sellerPayoutRecipientId") REFERENCES "seller_payout_recipients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wise_transfer_events"
ADD CONSTRAINT "wise_transfer_events_payoutRunId_fkey"
FOREIGN KEY ("payoutRunId") REFERENCES "payout_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
