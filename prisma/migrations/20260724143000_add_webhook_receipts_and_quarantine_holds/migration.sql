CREATE TABLE "shopify_webhook_receipts" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT,
    "topic" TEXT NOT NULL,
    "resourceId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'PROCESSING',
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "triggeredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_webhook_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shopify_order_quarantine_holds" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "fulfillmentOrderId" TEXT NOT NULL,
    "fulfillmentHoldId" TEXT,
    "holdHandle" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfillmentOrderStatus" TEXT,
    "operationalCaseId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_order_quarantine_holds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopify_webhook_receipts_shopDomain_webhookId_key"
ON "shopify_webhook_receipts"("shopDomain", "webhookId");

CREATE INDEX "shopify_webhook_receipts_eventId_idx"
ON "shopify_webhook_receipts"("eventId");

CREATE INDEX "shopify_webhook_receipts_topic_processingStatus_receivedAt_idx"
ON "shopify_webhook_receipts"("topic", "processingStatus", "receivedAt");

CREATE INDEX "shopify_webhook_receipts_shopDomain_resourceId_receivedAt_idx"
ON "shopify_webhook_receipts"("shopDomain", "resourceId", "receivedAt");

CREATE UNIQUE INDEX "shopify_order_quarantine_holds_shopDomain_fulfillmentOrderId_holdHandle_key"
ON "shopify_order_quarantine_holds"("shopDomain", "fulfillmentOrderId", "holdHandle");

CREATE INDEX "shopify_order_quarantine_holds_shopDomain_shopifyOrderId_status_idx"
ON "shopify_order_quarantine_holds"("shopDomain", "shopifyOrderId", "status");

CREATE INDEX "shopify_order_quarantine_holds_operationalCaseId_idx"
ON "shopify_order_quarantine_holds"("operationalCaseId");
