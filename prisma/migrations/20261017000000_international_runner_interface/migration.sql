CREATE TABLE "InternationalProofDelivery" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "receiptJson" JSONB NOT NULL,
  "receiptDigest" TEXT NOT NULL,
  "artifactId" INTEGER NOT NULL,
  "headSha" TEXT NOT NULL,
  "versionTag" TEXT NOT NULL,
  "allowedUseUntil" TIMESTAMP(3) NOT NULL,
  "receivedBy" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternationalProofDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "international_delivery_payload_bounds" CHECK (
    octet_length("receiptJson"::text) <= 32000 AND
    "receiptDigest" ~ '^[a-f0-9]{64}$' AND
    "headSha" ~ '^[a-f0-9]{40}$' AND "artifactId" > 0
  )
);
CREATE UNIQUE INDEX "InternationalProofDelivery_shopDomain_id_key" ON "InternationalProofDelivery"("shopDomain", "id");
CREATE UNIQUE INDEX "InternationalProofDelivery_shopDomain_receiptId_key" ON "InternationalProofDelivery"("shopDomain", "receiptId");
CREATE INDEX "InternationalProofDelivery_shopDomain_createdAt_id_idx" ON "InternationalProofDelivery"("shopDomain", "createdAt", "id");
ALTER TABLE "InternationalCheckoutVerificationRun"
  ADD COLUMN "proofDeliveryId" TEXT,
  ADD COLUMN "preparationRequestKey" TEXT,
  ADD COLUMN "observationRefreshRequestedAt" TIMESTAMP(3),
  ADD COLUMN "observationRetryAt" TIMESTAMP(3),
  ADD COLUMN "observationFailureCode" TEXT;
CREATE UNIQUE INDEX "intl_run_preparation_key" ON "InternationalCheckoutVerificationRun"("shopDomain", "preparationRequestKey");
CREATE INDEX "intl_run_delivery_idx" ON "InternationalCheckoutVerificationRun"("shopDomain", "proofDeliveryId");
ALTER TABLE "InternationalCheckoutVerificationRun" ADD CONSTRAINT "intl_run_delivery_fkey"
  FOREIGN KEY ("shopDomain", "proofDeliveryId") REFERENCES "InternationalProofDelivery"("shopDomain", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InternationalCheckoutVerificationRun" ADD CONSTRAINT "international_preparation_binding" CHECK (
  ("proofDeliveryId" IS NULL AND "preparationRequestKey" IS NULL) OR
  ("kind" = 'DEPLOYMENT' AND "proofDeliveryId" IS NOT NULL AND "preparationRequestKey" IS NOT NULL AND "preparationRequestKey" ~ '^[a-f0-9-]{36}$')
);
