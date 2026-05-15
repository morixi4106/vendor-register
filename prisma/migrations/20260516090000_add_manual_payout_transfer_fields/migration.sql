ALTER TABLE "payout_runs"
ADD COLUMN "transferMethod" TEXT NOT NULL DEFAULT 'manual_bank_transfer',
ADD COLUMN "externalTransferId" TEXT,
ADD COLUMN "transferMemo" TEXT;

UPDATE "payout_runs"
SET "transferMethod" = 'stripe_connect_payout'
WHERE "stripePayoutId" IS NOT NULL;
