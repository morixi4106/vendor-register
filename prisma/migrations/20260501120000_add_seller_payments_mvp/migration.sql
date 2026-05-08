-- CreateTable
CREATE TABLE "sellers" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorStoreId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_stripe_accounts" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "countryCode" TEXT,
    "defaultCurrency" TEXT,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutSchedule" TEXT NOT NULL DEFAULT 'manual',
    "dashboardType" TEXT NOT NULL DEFAULT 'none',
    "onboardingCompletedAt" TIMESTAMP(3),
    "requirementsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_stripe_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_status_history" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seller_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sellerStripeAccountId" TEXT,
    "stripeAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "subtotalAmount" INTEGER NOT NULL,
    "applicationFeeAmount" INTEGER NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerFirstName" TEXT,
    "customerLastName" TEXT,
    "customerPhone" TEXT,
    "shippingAddressJson" JSONB,
    "lineItemsJson" JSONB NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "stripeAccountId" TEXT,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "payloadJson" JSONB NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT,
    "sellerStripeAccountId" TEXT,
    "orderId" TEXT,
    "stripeEventId" TEXT,
    "payoutRunId" TEXT,
    "stripeAccountId" TEXT,
    "entryType" TEXT NOT NULL,
    "stripeObjectId" TEXT,
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "direction" TEXT NOT NULL,
    "description" TEXT,
    "metadataJson" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_runs" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sellerStripeAccountId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'jpy',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "stripePayoutId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "executedAt" TIMESTAMP(3),
    "executedBy" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sellers_vendorId_key" ON "sellers"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "sellers_vendorStoreId_key" ON "sellers"("vendorStoreId");

-- CreateIndex
CREATE INDEX "sellers_status_createdAt_idx" ON "sellers"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "seller_stripe_accounts_sellerId_key" ON "seller_stripe_accounts"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "seller_stripe_accounts_stripeAccountId_key" ON "seller_stripe_accounts"("stripeAccountId");

-- CreateIndex
CREATE INDEX "seller_status_history_sellerId_createdAt_idx" ON "seller_status_history"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_stripePaymentIntentId_key" ON "orders"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_stripeChargeId_key" ON "orders"("stripeChargeId");

-- CreateIndex
CREATE INDEX "orders_sellerId_createdAt_idx" ON "orders"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_events_stripeEventId_key" ON "stripe_events"("stripeEventId");

-- CreateIndex
CREATE INDEX "stripe_events_type_createdAt_idx" ON "stripe_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "stripe_events_stripeAccountId_createdAt_idx" ON "stripe_events"("stripeAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_sellerId_occurredAt_idx" ON "ledger_entries"("sellerId", "occurredAt");

-- CreateIndex
CREATE INDEX "ledger_entries_orderId_occurredAt_idx" ON "ledger_entries"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "ledger_entries_stripeAccountId_occurredAt_idx" ON "ledger_entries"("stripeAccountId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "payout_runs_stripePayoutId_key" ON "payout_runs"("stripePayoutId");

-- CreateIndex
CREATE INDEX "payout_runs_sellerId_createdAt_idx" ON "payout_runs"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "payout_runs_status_createdAt_idx" ON "payout_runs"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId") REFERENCES "VendorStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_stripe_accounts" ADD CONSTRAINT "seller_stripe_accounts_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_status_history" ADD CONSTRAINT "seller_status_history_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_sellerStripeAccountId_fkey" FOREIGN KEY ("sellerStripeAccountId") REFERENCES "seller_stripe_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_sellerStripeAccountId_fkey" FOREIGN KEY ("sellerStripeAccountId") REFERENCES "seller_stripe_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_stripeEventId_fkey" FOREIGN KEY ("stripeEventId") REFERENCES "stripe_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payoutRunId_fkey" FOREIGN KEY ("payoutRunId") REFERENCES "payout_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_runs" ADD CONSTRAINT "payout_runs_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_runs" ADD CONSTRAINT "payout_runs_sellerStripeAccountId_fkey" FOREIGN KEY ("sellerStripeAccountId") REFERENCES "seller_stripe_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
