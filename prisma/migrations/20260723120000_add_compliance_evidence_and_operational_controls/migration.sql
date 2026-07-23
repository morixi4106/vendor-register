-- CreateTable
CREATE TABLE "platform_operational_controls" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "checkoutHold" BOOLEAN NOT NULL DEFAULT false,
    "automatedEmailHold" BOOLEAN NOT NULL DEFAULT false,
    "internationalShippingHold" BOOLEAN NOT NULL DEFAULT false,
    "holdReason" TEXT,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releaseEvidenceReference" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_operational_controls_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "operational_readiness_attestations" (
    "id" TEXT NOT NULL,
    "checkKey" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT 'PLATFORM',
    "scopeId" TEXT NOT NULL DEFAULT 'GLOBAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceReference" TEXT,
    "evidenceHash" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_readiness_attestations_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "product_compliance_profiles"
ADD COLUMN "applicabilityStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "verificationLevel" TEXT NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN "applicabilityReasonCode" TEXT,
ADD COLUMN "applicabilityReasonText" TEXT,
ADD COLUMN "applicabilitySourceUrl" TEXT,
ADD COLUMN "applicabilityDecidedAt" TIMESTAMP(3),
ADD COLUMN "applicabilityDecidedBy" TEXT,
ADD COLUMN "nextReviewAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "compliance_requirements" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'JP',
    "market" TEXT NOT NULL DEFAULT 'DOMESTIC',
    "productCategory" TEXT,
    "sellerType" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'BLOCKING',
    "requiredVerificationLevel" TEXT NOT NULL DEFAULT 'DOCUMENT_REVIEWED',
    "sourceUrl" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_compliance_evidence" (
    "id" TEXT NOT NULL,
    "evidenceKey" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "requirementId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "verificationLevel" TEXT NOT NULL DEFAULT 'SELF_ATTESTED',
    "evidenceType" TEXT NOT NULL,
    "issuerName" TEXT,
    "referenceNumber" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reviewDueAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "evidenceReference" TEXT,
    "fileHash" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verificationMethod" TEXT,
    "sourceCheckedAt" TIMESTAMP(3),
    "notes" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_compliance_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_compliance_decisions" (
    "id" TEXT NOT NULL,
    "decisionKey" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "requirementId" TEXT,
    "decision" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reasonText" TEXT NOT NULL,
    "verificationLevel" TEXT NOT NULL DEFAULT 'DOCUMENT_REVIEWED',
    "sourceUrl" TEXT,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewDueAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_compliance_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operational_readiness_attestations_checkKey_scopeType_scopeId_key"
ON "operational_readiness_attestations"("checkKey", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "operational_readiness_attestations_status_expiresAt_idx"
ON "operational_readiness_attestations"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_requirements_code_key"
ON "compliance_requirements"("code");

-- CreateIndex
CREATE INDEX "compliance_requirements_jurisdiction_market_isActive_idx"
ON "compliance_requirements"("jurisdiction", "market", "isActive");

-- CreateIndex
CREATE INDEX "compliance_requirements_productCategory_isActive_idx"
ON "compliance_requirements"("productCategory", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "product_compliance_evidence_evidenceKey_key"
ON "product_compliance_evidence"("evidenceKey");

-- CreateIndex
CREATE INDEX "product_compliance_evidence_productId_status_expiresAt_idx"
ON "product_compliance_evidence"("productId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "product_compliance_evidence_requirementId_status_idx"
ON "product_compliance_evidence"("requirementId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_compliance_decisions_decisionKey_key"
ON "product_compliance_decisions"("decisionKey");

-- CreateIndex
CREATE INDEX "product_compliance_decisions_productId_decidedAt_idx"
ON "product_compliance_decisions"("productId", "decidedAt");

-- CreateIndex
CREATE INDEX "product_compliance_decisions_requirementId_decision_idx"
ON "product_compliance_decisions"("requirementId", "decision");

-- AddForeignKey
ALTER TABLE "product_compliance_evidence"
ADD CONSTRAINT "product_compliance_evidence_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_compliance_evidence"
ADD CONSTRAINT "product_compliance_evidence_requirementId_fkey"
FOREIGN KEY ("requirementId") REFERENCES "compliance_requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_compliance_decisions"
ADD CONSTRAINT "product_compliance_decisions_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_compliance_decisions"
ADD CONSTRAINT "product_compliance_decisions_requirementId_fkey"
FOREIGN KEY ("requirementId") REFERENCES "compliance_requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
