-- Limited launch exposure is persisted separately from the immutable readiness attestation.
CREATE TABLE "komoju_limited_launch_controls" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "attestationId" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxOrderCount" INTEGER NOT NULL,
    "maxGrossAmount" INTEGER NOT NULL,
    "maxOutstandingLiability" INTEGER NOT NULL,
    "maxSingleOrderAmount" INTEGER NOT NULL,
    "companyRefundReserveAmount" INTEGER NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "grossAmount" INTEGER NOT NULL DEFAULT 0,
    "outstandingLiabilityAmount" INTEGER NOT NULL DEFAULT 0,
    "allowedProductIdsJson" JSONB NOT NULL,
    "allowedShopifyProductIdsJson" JSONB NOT NULL,
    "projectionVersion" INTEGER NOT NULL DEFAULT 1,
    "projectionSyncedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockReason" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "komoju_limited_launch_controls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "komoju_limited_launch_controls_shopDomain_key" ON "komoju_limited_launch_controls"("shopDomain");
CREATE UNIQUE INDEX "komoju_limited_launch_controls_attestationId_key" ON "komoju_limited_launch_controls"("attestationId");
CREATE UNIQUE INDEX "komoju_limited_launch_controls_probeId_key" ON "komoju_limited_launch_controls"("probeId");
CREATE INDEX "komoju_limited_launch_controls_status_expiresAt_idx" ON "komoju_limited_launch_controls"("status", "expiresAt");

CREATE TABLE "order_refund_guards" (
    "id" TEXT NOT NULL,
    "marketplaceOrderId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "operationReference" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_refund_guards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_refund_guards_marketplaceOrderId_key" ON "order_refund_guards"("marketplaceOrderId");
CREATE UNIQUE INDEX "order_refund_guards_shopDomain_shopifyOrderId_key" ON "order_refund_guards"("shopDomain", "shopifyOrderId");
CREATE INDEX "order_refund_guards_channel_status_updatedAt_idx" ON "order_refund_guards"("channel", "status", "updatedAt");

CREATE TABLE "direct_customer_refunds" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "marketplaceOrderId" TEXT NOT NULL,
    "paymentAttemptId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "recipientConsentReference" TEXT NOT NULL,
    "recipientConsentHash" TEXT NOT NULL,
    "transferEvidenceReference" TEXT NOT NULL,
    "transferEvidenceHash" TEXT NOT NULL,
    "transferReferenceMasked" TEXT,
    "completedBy" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "ledgerEntryIdsJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "direct_customer_refunds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "direct_customer_refunds_operationKey_key" ON "direct_customer_refunds"("operationKey");
CREATE UNIQUE INDEX "direct_customer_refunds_marketplaceOrderId_key" ON "direct_customer_refunds"("marketplaceOrderId");
CREATE UNIQUE INDEX "direct_customer_refunds_paymentAttemptId_key" ON "direct_customer_refunds"("paymentAttemptId");
CREATE UNIQUE INDEX "direct_customer_refunds_transferEvidenceHash_key" ON "direct_customer_refunds"("transferEvidenceHash");
CREATE INDEX "direct_customer_refunds_shopDomain_shopifyOrderId_idx" ON "direct_customer_refunds"("shopDomain", "shopifyOrderId");
CREATE INDEX "direct_customer_refunds_status_completedAt_idx" ON "direct_customer_refunds"("status", "completedAt");

ALTER TABLE "order_refund_guards" ADD CONSTRAINT "order_refund_guards_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "direct_customer_refunds" ADD CONSTRAINT "direct_customer_refunds_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "direct_customer_refunds" ADD CONSTRAINT "direct_customer_refunds_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "marketplace_payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
