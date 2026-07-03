CREATE TABLE "withdrawal_requests" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT,
  "marketplaceOrderId" TEXT,
  "shopifyOrderId" TEXT,
  "shopifyOrderName" TEXT,
  "shopifyOrderNumber" TEXT,
  "customerName" TEXT NOT NULL,
  "customerEmail" TEXT NOT NULL,
  "customerPhone" TEXT,
  "countryCode" TEXT,
  "countryLabel" TEXT,
  "receivedDate" TIMESTAMP(3),
  "withdrawalScope" TEXT NOT NULL DEFAULT 'FULL',
  "itemCondition" TEXT,
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "eligibilityStatus" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  "deadlineAt" TIMESTAMP(3),
  "deadlineSource" TEXT,
  "selectedLineItemsJson" JSONB,
  "submittedPayloadJson" JSONB NOT NULL,
  "orderSnapshotJson" JSONB,
  "eligibilityJson" JSONB,
  "durableMediumEmailJson" JSONB,
  "confirmationSentAt" TIMESTAMP(3),
  "confirmationEmailMessageId" TEXT,
  "decisionSentAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "adminNotes" TEXT,
  "source" TEXT NOT NULL DEFAULT 'app_proxy',
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "withdrawal_request_status_history" (
  "id" TEXT NOT NULL,
  "withdrawalRequestId" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "changedBy" TEXT,
  "reason" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "withdrawal_request_status_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "withdrawal_email_logs" (
  "id" TEXT NOT NULL,
  "withdrawalRequestId" TEXT NOT NULL,
  "emailType" TEXT NOT NULL,
  "toEmail" TEXT NOT NULL,
  "fromEmail" TEXT,
  "subject" TEXT NOT NULL,
  "bodyText" TEXT,
  "bodyHtml" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'resend',
  "providerMessageId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'sent',
  "errorMessage" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "withdrawal_email_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "withdrawal_requests_idempotencyKey_key"
  ON "withdrawal_requests"("idempotencyKey");

CREATE INDEX "withdrawal_requests_shopDomain_shopifyOrderId_idx"
  ON "withdrawal_requests"("shopDomain", "shopifyOrderId");

CREATE INDEX "withdrawal_requests_shopDomain_shopifyOrderName_idx"
  ON "withdrawal_requests"("shopDomain", "shopifyOrderName");

CREATE INDEX "withdrawal_requests_customerEmail_createdAt_idx"
  ON "withdrawal_requests"("customerEmail", "createdAt");

CREATE INDEX "withdrawal_requests_status_createdAt_idx"
  ON "withdrawal_requests"("status", "createdAt");

CREATE INDEX "withdrawal_requests_eligibilityStatus_createdAt_idx"
  ON "withdrawal_requests"("eligibilityStatus", "createdAt");

CREATE INDEX "withdrawal_request_status_history_withdrawalRequestId_createdAt_idx"
  ON "withdrawal_request_status_history"("withdrawalRequestId", "createdAt");

CREATE INDEX "withdrawal_request_status_history_toStatus_createdAt_idx"
  ON "withdrawal_request_status_history"("toStatus", "createdAt");

CREATE INDEX "withdrawal_email_logs_withdrawalRequestId_createdAt_idx"
  ON "withdrawal_email_logs"("withdrawalRequestId", "createdAt");

CREATE INDEX "withdrawal_email_logs_emailType_createdAt_idx"
  ON "withdrawal_email_logs"("emailType", "createdAt");

ALTER TABLE "withdrawal_request_status_history"
  ADD CONSTRAINT "withdrawal_request_status_history_withdrawalRequestId_fkey"
  FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "withdrawal_email_logs"
  ADD CONSTRAINT "withdrawal_email_logs_withdrawalRequestId_fkey"
  FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
