CREATE TABLE "marketplace_payment_attempts" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT,
    "marketplaceOrderId" TEXT,
    "attemptKey" TEXT NOT NULL,
    "shopifyTransactionId" TEXT,
    "parentTransactionId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "paymentMethod" TEXT NOT NULL DEFAULT 'OTHER',
    "gatewayName" TEXT,
    "formattedGateway" TEXT,
    "transactionKind" TEXT,
    "transactionStatus" TEXT,
    "financialStatus" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "test" BOOLEAN NOT NULL DEFAULT false,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "marketplace_payment_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_refund_operations" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "marketplaceOrderId" TEXT,
    "paymentAttemptId" TEXT,
    "shopifyRefundId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "paymentMethod" TEXT NOT NULL DEFAULT 'OTHER',
    "refundMode" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "status" TEXT NOT NULL DEFAULT 'OBSERVED',
    "amount" INTEGER NOT NULL DEFAULT 0,
    "refundFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "providerReference" TEXT,
    "evidenceReference" TEXT,
    "evidenceHash" TEXT,
    "failureCode" TEXT,
    "shopifyRefundSnapshotJson" JSONB,
    "ledgerEntryIdsJson" JSONB,
    "providerConfirmedAt" TIMESTAMP(3),
    "shopifyRecordedAt" TIMESTAMP(3),
    "ledgerAppliedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_refund_operations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_settlement_batches" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalBatchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "grossAmount" INTEGER NOT NULL DEFAULT 0,
    "refundAmount" INTEGER NOT NULL DEFAULT 0,
    "feeAmount" INTEGER NOT NULL DEFAULT 0,
    "netAmount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "payoutDate" TIMESTAMP(3),
    "bankDepositedAt" TIMESTAMP(3),
    "evidenceReference" TEXT,
    "evidenceHash" TEXT,
    "submittedBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_settlement_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_settlement_lines" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "externalLineId" TEXT NOT NULL,
    "lineType" TEXT NOT NULL,
    "paymentAttemptId" TEXT,
    "refundOperationId" TEXT,
    "marketplaceOrderId" TEXT,
    "providerReference" TEXT,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "feeAmount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "occurredAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_settlement_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketplace_payment_attempts_shopDomain_attemptKey_key" ON "marketplace_payment_attempts"("shopDomain", "attemptKey");
CREATE INDEX "marketplace_payment_attempts_shopDomain_shopifyOrderId_status_idx" ON "marketplace_payment_attempts"("shopDomain", "shopifyOrderId", "status");
CREATE INDEX "marketplace_payment_attempts_provider_paymentMethod_status_updatedAt_idx" ON "marketplace_payment_attempts"("provider", "paymentMethod", "status", "updatedAt");
CREATE INDEX "marketplace_payment_attempts_requiresReview_updatedAt_idx" ON "marketplace_payment_attempts"("requiresReview", "updatedAt");
CREATE UNIQUE INDEX "payment_refund_operations_operationKey_key" ON "payment_refund_operations"("operationKey");
CREATE INDEX "payment_refund_operations_shopDomain_shopifyOrderId_status_idx" ON "payment_refund_operations"("shopDomain", "shopifyOrderId", "status");
CREATE INDEX "payment_refund_operations_provider_refundMode_status_updatedAt_idx" ON "payment_refund_operations"("provider", "refundMode", "status", "updatedAt");
CREATE INDEX "payment_refund_operations_shopifyRefundId_idx" ON "payment_refund_operations"("shopifyRefundId");
CREATE UNIQUE INDEX "payment_settlement_batches_provider_externalBatchId_key" ON "payment_settlement_batches"("provider", "externalBatchId");
CREATE INDEX "payment_settlement_batches_provider_status_payoutDate_idx" ON "payment_settlement_batches"("provider", "status", "payoutDate");
CREATE UNIQUE INDEX "payment_settlement_lines_batchId_externalLineId_key" ON "payment_settlement_lines"("batchId", "externalLineId");
CREATE INDEX "payment_settlement_lines_matchStatus_createdAt_idx" ON "payment_settlement_lines"("matchStatus", "createdAt");
CREATE INDEX "payment_settlement_lines_paymentAttemptId_idx" ON "payment_settlement_lines"("paymentAttemptId");
CREATE INDEX "payment_settlement_lines_refundOperationId_idx" ON "payment_settlement_lines"("refundOperationId");

ALTER TABLE "marketplace_payment_attempts" ADD CONSTRAINT "marketplace_payment_attempts_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_refund_operations" ADD CONSTRAINT "payment_refund_operations_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_refund_operations" ADD CONSTRAINT "payment_refund_operations_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "marketplace_payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "payment_settlement_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "marketplace_payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_refundOperationId_fkey" FOREIGN KEY ("refundOperationId") REFERENCES "payment_refund_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_settlement_lines" ADD CONSTRAINT "payment_settlement_lines_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
