-- AlterTable
ALTER TABLE "InternationalGateSyncState" ADD COLUMN     "authorizationPurpose" TEXT,
ADD COLUMN     "authorizationRequestId" TEXT,
ADD COLUMN     "stopReasonCode" TEXT,
ADD COLUMN     "stoppedAt" TIMESTAMP(3),
ADD COLUMN     "verificationRunId" TEXT;

-- AlterTable
ALTER TABLE "InternationalGateSyncJob" ADD COLUMN     "authorizationRequestId" TEXT;

-- CreateTable
CREATE TABLE "InternationalGateAuthorizationRequest" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "resumePurpose" TEXT,
    "verificationKind" TEXT,
    "operatorJson" JSONB NOT NULL,
    "scopeJson" JSONB NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "currenciesJson" JSONB NOT NULL,
    "requestedExpiresAt" TIMESTAMP(3) NOT NULL,
    "effectiveExpiresAt" TIMESTAMP(3) NOT NULL,
    "expectedGeneration" INTEGER NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "proofReferencesJson" JSONB NOT NULL,
    "nativeConfigHash" TEXT NOT NULL,
    "releaseBinding" TEXT NOT NULL,
    "shopTimezone" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "previewExpiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedGeneration" INTEGER,
    "resultCode" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revocationReasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternationalGateAuthorizationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternationalCheckoutVerificationRun" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "authorizationRequestId" TEXT,
    "initiatedBy" TEXT NOT NULL,
    "executorId" TEXT,
    "scenarioVersion" TEXT NOT NULL,
    "verifierVersion" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "releaseBinding" TEXT NOT NULL,
    "nativeConfigHash" TEXT NOT NULL,
    "proofReferencesJson" JSONB NOT NULL,
    "requiredCasesHash" TEXT NOT NULL,
    "startGeneration" INTEGER NOT NULL,
    "closureGeneration" INTEGER,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "closureStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "leaseTokenHash" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "stopRequestedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "outcomeCode" TEXT,
    "failureCode" TEXT,
    "resultsJson" JSONB,
    "artifactReference" TEXT,
    "artifactHash" TEXT,
    "artifactExpiresAt" TIMESTAMP(3),
    "financialProbeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternationalCheckoutVerificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternationalGateAuthorizationRequest_nonceHash_key" ON "InternationalGateAuthorizationRequest"("nonceHash");

-- CreateIndex
CREATE INDEX "InternationalGateAuthorizationRequest_shopDomain_previewExp_idx" ON "InternationalGateAuthorizationRequest"("shopDomain", "previewExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InternationalGateAuthorizationRequest_shopDomain_id_key" ON "InternationalGateAuthorizationRequest"("shopDomain", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InternationalCheckoutVerificationRun_activeKey_key" ON "InternationalCheckoutVerificationRun"("activeKey");

-- CreateIndex
CREATE INDEX "InternationalCheckoutVerificationRun_shopDomain_status_expi_idx" ON "InternationalCheckoutVerificationRun"("shopDomain", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InternationalCheckoutVerificationRun_shopDomain_id_key" ON "InternationalCheckoutVerificationRun"("shopDomain", "id");

-- AddForeignKey
ALTER TABLE "InternationalGateSyncState" ADD CONSTRAINT "InternationalGateSyncState_shopDomain_authorizationRequest_fkey" FOREIGN KEY ("shopDomain", "authorizationRequestId") REFERENCES "InternationalGateAuthorizationRequest"("shopDomain", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternationalGateSyncState" ADD CONSTRAINT "InternationalGateSyncState_shopDomain_verificationRunId_fkey" FOREIGN KEY ("shopDomain", "verificationRunId") REFERENCES "InternationalCheckoutVerificationRun"("shopDomain", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternationalGateSyncJob" ADD CONSTRAINT "InternationalGateSyncJob_shopDomain_authorizationRequestId_fkey" FOREIGN KEY ("shopDomain", "authorizationRequestId") REFERENCES "InternationalGateAuthorizationRequest"("shopDomain", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternationalCheckoutVerificationRun" ADD CONSTRAINT "InternationalCheckoutVerificationRun_shopDomain_authorizat_fkey" FOREIGN KEY ("shopDomain", "authorizationRequestId") REFERENCES "InternationalGateAuthorizationRequest"("shopDomain", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InternationalGateAuthorizationRequest" ADD CONSTRAINT "international_authorization_shape" CHECK (COALESCE((
    "purpose" IN ('VERIFY', 'SALE', 'RESUME')
    AND (("purpose" = 'RESUME' AND "resumePurpose" IN ('VERIFY', 'SALE')) OR ("purpose" <> 'RESUME' AND "resumePurpose" IS NULL))
    AND ((COALESCE("resumePurpose", "purpose") = 'VERIFY' AND "verificationKind" IN ('NON_FINANCIAL', 'FINANCIAL')) OR (COALESCE("resumePurpose", "purpose") = 'SALE' AND "verificationKind" IS NULL))
    AND "expectedGeneration" >= 0
    AND "effectiveExpiresAt" <= "requestedExpiresAt"
    AND "currenciesJson" = '["JPY"]'::jsonb
    AND "nonceHash" ~ '^[a-f0-9]{64}$'
    AND (("consumedAt" IS NULL AND "consumedGeneration" IS NULL AND "resultCode" IS NULL) OR ("consumedAt" IS NOT NULL AND "consumedGeneration" > "expectedGeneration" AND "resultCode" = 'ACCEPTED'))
), false));

ALTER TABLE "InternationalCheckoutVerificationRun" ADD CONSTRAINT "international_verification_shape" CHECK (COALESCE((
    "kind" IN ('DEPLOYMENT', 'NON_FINANCIAL', 'FINANCIAL')
    AND ("kind" = 'DEPLOYMENT' OR "authorizationRequestId" IS NOT NULL)
    AND "status" IN ('QUEUED', 'RUNNING', 'CLOSING', 'PASSED', 'FAILED', 'EXPIRED')
    AND "closureStatus" IN ('PENDING', 'CONFIRMED', 'UNVERIFIED')
    AND ("status" <> 'RUNNING' OR ("leaseTokenHash" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "startedAt" IS NOT NULL AND "executorId" IS NOT NULL))
    AND ("activeKey" IS NOT NULL OR ("closureStatus" = 'CONFIRMED' AND "status" IN ('PASSED', 'FAILED', 'EXPIRED')))
    AND ("activeKey" IS NULL OR "activeKey" = "shopDomain" || CASE WHEN "kind" = 'DEPLOYMENT' THEN ':DEPLOYMENT' ELSE ':VERIFY' END)
    AND ("status" <> 'PASSED' OR ("closureStatus" = 'CONFIRMED' AND "artifactHash" IS NOT NULL AND "completedAt" IS NOT NULL))
), false));
