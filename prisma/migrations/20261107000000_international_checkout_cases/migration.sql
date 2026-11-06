ALTER TABLE "InternationalCheckoutVerificationRun" ADD COLUMN "planSummaryJson" JSONB;
ALTER TABLE "InternationalCheckoutVerificationRun" ADD CONSTRAINT "intl_plan_summary_bounds"
  CHECK ("planSummaryJson" IS NULL OR
    (jsonb_typeof("planSummaryJson") = 'object' AND octet_length("planSummaryJson"::text) <= 4096));

CREATE TABLE "InternationalCheckoutVerificationCase" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "caseKey" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "expectedJson" JSONB NOT NULL,
  "expectedHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "challengeSequence" INTEGER NOT NULL DEFAULT 0,
  "challengeHash" TEXT,
  "challengeIssuedAt" TIMESTAMP(3),
  "challengeExpiresAt" TIMESTAMP(3),
  "resultJson" JSONB,
  "resultHash" TEXT,
  "resultCode" TEXT,
  "recordedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternationalCheckoutVerificationCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intl_case_shape" CHECK (
    "ordinal" BETWEEN 0 AND 2047 AND "caseKey" ~ '^[a-f0-9]{64}$' AND
    "expectedHash" = "caseKey" AND "phase" IN ('OPEN', 'CLOSED') AND
    jsonb_typeof("expectedJson") = 'object' AND octet_length("expectedJson"::text) <= 2048 AND
    "status" IN ('PENDING', 'RECORDED') AND "challengeSequence" >= 0
  ),
  CONSTRAINT "intl_case_challenge" CHECK (
    ("challengeSequence" = 0 AND "challengeHash" IS NULL AND "challengeIssuedAt" IS NULL AND "challengeExpiresAt" IS NULL) OR
    ("challengeSequence" > 0 AND "challengeHash" IS NOT NULL AND "challengeHash" ~ '^[a-f0-9]{64}$' AND
      "challengeIssuedAt" IS NOT NULL AND "challengeExpiresAt" IS NOT NULL AND
      "challengeExpiresAt" > "challengeIssuedAt" AND "challengeExpiresAt" <= "challengeIssuedAt" + INTERVAL '60 seconds')
  ),
  CONSTRAINT "intl_case_result" CHECK (
    ("status" = 'PENDING' AND "resultJson" IS NULL AND "resultHash" IS NULL AND "resultCode" IS NULL AND "recordedAt" IS NULL) OR
    ("status" = 'RECORDED' AND "resultJson" IS NOT NULL AND jsonb_typeof("resultJson") = 'object' AND
      octet_length("resultJson"::text) <= 4096 AND "resultHash" IS NOT NULL AND "resultHash" ~ '^[a-f0-9]{64}$' AND
      "resultCode" IS NOT NULL AND "resultCode" IN ('MATCHED', 'UNEXPECTED_STAGE', 'UNEXPECTED_OUTCOME', 'NOT_OBSERVED') AND
      "recordedAt" IS NOT NULL AND "challengeHash" IS NOT NULL AND
      "recordedAt" >= "challengeIssuedAt" AND "recordedAt" < "challengeExpiresAt")
  )
);
CREATE UNIQUE INDEX "intl_case_key" ON "InternationalCheckoutVerificationCase"("shopDomain", "runId", "caseKey");
CREATE UNIQUE INDEX "intl_case_ordinal_key" ON "InternationalCheckoutVerificationCase"("shopDomain", "runId", "ordinal");
CREATE INDEX "intl_case_pending_idx" ON "InternationalCheckoutVerificationCase"("shopDomain", "runId", "status");
ALTER TABLE "InternationalCheckoutVerificationCase" ADD CONSTRAINT "intl_case_run_fkey"
  FOREIGN KEY ("shopDomain", "runId") REFERENCES "InternationalCheckoutVerificationRun"("shopDomain", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
