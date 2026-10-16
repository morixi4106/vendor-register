ALTER TABLE "operational_readiness_attestations" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "international_shipping_country_availabilities" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "InternationalGateSyncState" (
    "shopDomain" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'DISABLED',
    "desiredGeneration" INTEGER NOT NULL DEFAULT 0,
    "appliedGeneration" INTEGER NOT NULL DEFAULT 0,
    "phase" TEXT NOT NULL DEFAULT 'UNCONFIGURED',
    "authorizedScopeJson" JSONB NOT NULL DEFAULT '[]',
    "authorizedScopeHash" TEXT,
    "releaseBinding" TEXT,
    "authorizationExpiresAt" TIMESTAMP(3),
    "nativeConfigHash" TEXT,
    "shopTimezone" TEXT,
    "snapshotComplete" BOOLEAN NOT NULL DEFAULT false,
    "sourceHash" TEXT,
    "expectedShopJson" JSONB,
    "expectedShopHash" TEXT,
    "observedShopHash" TEXT,
    "expectedProductCount" INTEGER NOT NULL DEFAULT 0,
    "verifiedProductCount" INTEGER NOT NULL DEFAULT 0,
    "protectedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "nextExpiryAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InternationalGateSyncState_pkey" PRIMARY KEY ("shopDomain")
);

CREATE TABLE "InternationalGateSyncJob" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payloadJson" JSONB,
    "expectedHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InternationalGateSyncJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InternationalGateSyncState_mode_nextExpiryAt_idx" ON "InternationalGateSyncState"("mode", "nextExpiryAt");
CREATE UNIQUE INDEX "InternationalGateSyncJob_target_key" ON "InternationalGateSyncJob"("shopDomain", "generation", "targetType", "targetId");
CREATE INDEX "InternationalGateSyncJob_pending_idx" ON "InternationalGateSyncJob"("shopDomain", "generation", "status", "nextAttemptAt");
ALTER TABLE "InternationalGateSyncJob" ADD CONSTRAINT "InternationalGateSyncJob_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "InternationalGateSyncState"("shopDomain") ON DELETE CASCADE ON UPDATE CASCADE;
