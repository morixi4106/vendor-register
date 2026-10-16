ALTER TABLE "InternationalCheckoutVerificationRun"
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedBy" TEXT,
  ADD COLUMN "revocationReason" TEXT,
  ADD COLUMN "observationJson" JSONB,
  ADD COLUMN "observedAt" TIMESTAMP(3),
  ADD COLUMN "observationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "observationNonceHash" TEXT,
  ADD COLUMN "observationRequestedAt" TIMESTAMP(3);

ALTER TABLE "InternationalCheckoutVerificationRun" ADD CONSTRAINT "international_proof_shape" CHECK (COALESCE((
  ("revokedAt" IS NULL AND "revokedBy" IS NULL AND "revocationReason" IS NULL OR
   "revokedAt" IS NOT NULL AND "revokedBy" IS NOT NULL AND "revocationReason" IS NOT NULL)
  AND ("observationJson" IS NULL AND "observedAt" IS NULL AND "observationExpiresAt" IS NULL OR
   "kind" = 'DEPLOYMENT' AND "observationJson" IS NOT NULL AND "observedAt" IS NOT NULL AND
   "observationExpiresAt" IS NOT NULL AND "observationExpiresAt" > "observedAt")
  AND ("observationNonceHash" IS NULL AND "observationRequestedAt" IS NULL OR
   "observationNonceHash" ~ '^[a-f0-9]{64}$' AND "observationRequestedAt" IS NOT NULL)
), false));
