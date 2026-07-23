-- AlterTable
ALTER TABLE "platform_operational_controls"
ADD COLUMN "orderEmailHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "legalEmailHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "securityEmailHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "checkoutControlState" TEXT NOT NULL DEFAULT 'IDLE',
ADD COLUMN "activeCheckoutControlId" TEXT;

-- CreateTable
CREATE TABLE "operational_controls" (
    "id" TEXT NOT NULL,
    "activeKey" TEXT,
    "shopDomain" TEXT NOT NULL,
    "controlType" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT 'PLATFORM',
    "scopeId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedByUserId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "recoveryRequestedByUserId" TEXT,
    "recoveryRequestedAt" TIMESTAMP(3),
    "recoveredByUserId" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "recoveryEvidenceJson" JSONB,
    "preControlSnapshotJson" JSONB,
    "recoveryPlanJson" JSONB,
    "operationalCaseId" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_control_executions" (
    "id" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "targetSystem" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "beforeStateJson" JSONB,
    "afterStateJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_control_executions_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "compliance_requirements"
ADD COLUMN "version" TEXT NOT NULL DEFAULT 'v1',
ADD COLUMN "subjectType" TEXT NOT NULL DEFAULT 'PRODUCT',
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "evidencePolicyJson" JSONB,
ADD COLUMN "sourceTitle" TEXT,
ADD COLUMN "reviewDueAt" TIMESTAMP(3);

DROP INDEX "compliance_requirements_code_key";

-- AlterTable
ALTER TABLE "product_compliance_evidence"
ADD COLUMN "fileSizeBytes" INTEGER,
ADD COLUMN "mimeType" TEXT,
ADD COLUMN "malwareScanStatus" TEXT;

-- CreateTable
CREATE TABLE "product_compliance_decision_evidence" (
    "decisionId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_compliance_decision_evidence_pkey" PRIMARY KEY ("decisionId","evidenceId")
);

-- CreateTable
CREATE TABLE "sale_eligibility_projections" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "vendorStoreId" TEXT,
    "destinationCountry" TEXT NOT NULL DEFAULT '',
    "salesChannel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "requirementVersions" JSONB NOT NULL,
    "decisionIds" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "projectionRevision" INTEGER NOT NULL DEFAULT 1,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_eligibility_projections_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "withdrawal_email_outbox"
ADD COLUMN "messageClass" TEXT NOT NULL DEFAULT 'LEGAL_TRANSACTIONAL',
ADD COLUMN "heldByControlId" TEXT,
ADD COLUMN "holdReason" TEXT,
ADD COLUMN "heldAt" TIMESTAMP(3),
ADD COLUMN "releasedAt" TIMESTAMP(3),
ADD COLUMN "releaseApprovedById" TEXT,
ADD COLUMN "cancelReasonCode" TEXT,
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancellationAuditJson" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "operational_controls_activeKey_key"
ON "operational_controls"("activeKey");

-- CreateIndex
CREATE INDEX "operational_controls_shopDomain_controlType_state_idx"
ON "operational_controls"("shopDomain", "controlType", "state");

-- CreateIndex
CREATE INDEX "operational_controls_state_updatedAt_idx"
ON "operational_controls"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "operational_control_executions_controlId_targetSystem_targetType_targetId_operation_key"
ON "operational_control_executions"("controlId", "targetSystem", "targetType", "targetId", "operation");

-- CreateIndex
CREATE INDEX "operational_control_executions_controlId_status_idx"
ON "operational_control_executions"("controlId", "status");

-- CreateIndex
CREATE INDEX "operational_control_executions_status_updatedAt_idx"
ON "operational_control_executions"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "compliance_requirements_jurisdiction_subjectType_status_idx"
ON "compliance_requirements"("jurisdiction", "subjectType", "status");

CREATE UNIQUE INDEX "compliance_requirements_code_version_jurisdiction_key"
ON "compliance_requirements"("code", "version", "jurisdiction");

-- CreateIndex
CREATE INDEX "product_compliance_decision_evidence_evidenceId_idx"
ON "product_compliance_decision_evidence"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_eligibility_projections_shopDomain_productId_destinationCountry_salesChannel_key"
ON "sale_eligibility_projections"("shopDomain", "productId", "destinationCountry", "salesChannel");

-- CreateIndex
CREATE INDEX "sale_eligibility_projections_status_expiresAt_idx"
ON "sale_eligibility_projections"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "sale_eligibility_projections_vendorStoreId_status_idx"
ON "sale_eligibility_projections"("vendorStoreId", "status");

-- CreateIndex
CREATE INDEX "withdrawal_email_outbox_messageClass_status_nextAttemptAt_idx"
ON "withdrawal_email_outbox"("messageClass", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "withdrawal_email_outbox_heldByControlId_status_idx"
ON "withdrawal_email_outbox"("heldByControlId", "status");

-- AddForeignKey
ALTER TABLE "operational_control_executions"
ADD CONSTRAINT "operational_control_executions_controlId_fkey"
FOREIGN KEY ("controlId") REFERENCES "operational_controls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_compliance_decision_evidence"
ADD CONSTRAINT "product_compliance_decision_evidence_decisionId_fkey"
FOREIGN KEY ("decisionId") REFERENCES "product_compliance_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_compliance_decision_evidence"
ADD CONSTRAINT "product_compliance_decision_evidence_evidenceId_fkey"
FOREIGN KEY ("evidenceId") REFERENCES "product_compliance_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_eligibility_projections"
ADD CONSTRAINT "sale_eligibility_projections_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_email_outbox"
ADD CONSTRAINT "withdrawal_email_outbox_heldByControlId_fkey"
FOREIGN KEY ("heldByControlId") REFERENCES "operational_controls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
