-- AlterTable
ALTER TABLE "withdrawal_email_logs" ADD COLUMN     "instructionId" TEXT,
ADD COLUMN     "returnGroupId" TEXT;

-- AlterTable
ALTER TABLE "withdrawal_requests" ADD COLUMN     "contractMode" TEXT,
ADD COLUMN     "contractPolicyVersion" INTEGER,
ADD COLUMN     "outcomeStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
ADD COLUMN     "progressStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "returnMode" TEXT NOT NULL DEFAULT 'LEGACY_SINGLE',
ADD COLUMN     "termsVersion" TEXT,
ADD COLUMN     "v2ActivatedAt" TIMESTAMP(3),
ADD COLUMN     "v2ReviewReason" TEXT,
ADD COLUMN     "workflowVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "withdrawal_workflow_policies" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contractMode" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "directReturnEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effectiveAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_workflow_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_return_addresses" (
    "id" TEXT NOT NULL,
    "vendorStoreId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "recipientName" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "countryLabel" TEXT,
    "region" TEXT,
    "city" TEXT,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "phone" TEXT,
    "instructions" TEXT,
    "canReceiveReturnsConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "buyerDisclosureConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "legalRecipientConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_return_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_contracts" (
    "id" TEXT NOT NULL,
    "withdrawalRequestId" TEXT NOT NULL,
    "marketplaceOrderId" TEXT,
    "sellerOrderId" TEXT,
    "sellerId" TEXT,
    "vendorStoreId" TEXT,
    "contractKey" TEXT NOT NULL,
    "contractMode" TEXT NOT NULL,
    "contractPartyRole" TEXT NOT NULL,
    "contractPartyName" TEXT NOT NULL,
    "contractPartyId" TEXT,
    "sellerLegalRoleSnapshot" TEXT,
    "refundResponsibilitySnapshot" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "progressStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "outcomeStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "lastPhysicalPossessionAt" TIMESTAMP(3),
    "withdrawalEligibilityDeadlineAt" TIMESTAMP(3),
    "withdrawalExercisedAt" TIMESTAMP(3),
    "statutoryReturnDeadlineAt" TIMESTAMP(3),
    "initialShippingRefundStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "initialShippingRefundAmount" INTEGER NOT NULL DEFAULT 0,
    "initialShippingRefundReason" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'JPY',
    "itemRefundBaseAmount" INTEGER NOT NULL DEFAULT 0,
    "deductionAmount" INTEGER NOT NULL DEFAULT 0,
    "itemRefundNetAmount" INTEGER NOT NULL DEFAULT 0,
    "plannedRefundAmount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_order_line_positions" (
    "id" TEXT NOT NULL,
    "marketplaceOrderId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "purchasedQuantity" INTEGER NOT NULL DEFAULT 0,
    "refundedQuantity" INTEGER NOT NULL DEFAULT 0,
    "cancelledQuantity" INTEGER NOT NULL DEFAULT 0,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceSnapshotJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_order_line_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requested_lines" (
    "id" TEXT NOT NULL,
    "withdrawalRequestId" TEXT NOT NULL,
    "withdrawalContractId" TEXT,
    "orderLinePositionId" TEXT NOT NULL,
    "sellerOrderId" TEXT,
    "sellerOrderLineId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "productId" TEXT,
    "requestedQuantity" INTEGER NOT NULL,
    "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
    "approvedQuantity" INTEGER NOT NULL DEFAULT 0,
    "releasedQuantity" INTEGER NOT NULL DEFAULT 0,
    "titleSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT,
    "unitAmountSnapshot" INTEGER NOT NULL DEFAULT 0,
    "subtotalAmountSnapshot" INTEGER NOT NULL DEFAULT 0,
    "discountAmountSnapshot" INTEGER NOT NULL DEFAULT 0,
    "taxAmountSnapshot" INTEGER NOT NULL DEFAULT 0,
    "paidAmountSnapshot" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'JPY',
    "mappingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "mappingMethod" TEXT,
    "candidateVendorStoreId" TEXT,
    "confirmedVendorStoreId" TEXT,
    "mappingConfirmedAt" TIMESTAMP(3),
    "mappingConfirmedBy" TEXT,
    "returnDisposition" TEXT NOT NULL DEFAULT 'RETURN_REQUIRED',
    "itemRefundBaseAmount" INTEGER NOT NULL DEFAULT 0,
    "deductionAmount" INTEGER NOT NULL DEFAULT 0,
    "deductionReason" TEXT,
    "itemRefundNetAmount" INTEGER NOT NULL DEFAULT 0,
    "allocationRemainderRank" INTEGER,
    "freeTextNote" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_requested_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_return_groups" (
    "id" TEXT NOT NULL,
    "withdrawalRequestId" TEXT NOT NULL,
    "withdrawalContractId" TEXT NOT NULL,
    "vendorStoreId" TEXT,
    "sellerOrderId" TEXT,
    "returnAddressId" TEXT,
    "groupKey" TEXT NOT NULL,
    "mappingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "routingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "instructionStatus" TEXT NOT NULL DEFAULT 'NOT_READY',
    "evidenceStatus" TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
    "receiptStatus" TEXT NOT NULL DEFAULT 'NOT_RECEIVED',
    "inspectionStatus" TEXT NOT NULL DEFAULT 'NOT_INSPECTED',
    "refundDecisionStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "refundReconciliationStatus" TEXT NOT NULL DEFAULT 'NOT_RECONCILED',
    "progressStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "outcomeStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "storeNameSnapshot" TEXT,
    "sellerLegalRoleSnapshot" TEXT,
    "instructionsSentAt" TIMESTAMP(3),
    "operationalReturnDeadlineAt" TIMESTAMP(3),
    "statutoryReturnDeadlineAt" TIMESTAMP(3),
    "returnShippingPayer" TEXT NOT NULL DEFAULT 'BUYER',
    "itemRefundBaseAmount" INTEGER NOT NULL DEFAULT 0,
    "deductionAmount" INTEGER NOT NULL DEFAULT 0,
    "itemRefundNetAmount" INTEGER NOT NULL DEFAULT 0,
    "plannedRefundAmount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'JPY',
    "blockedReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_return_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_return_group_lines" (
    "id" TEXT NOT NULL,
    "returnGroupId" TEXT NOT NULL,
    "requestedLineId" TEXT NOT NULL,
    "instructedQuantity" INTEGER NOT NULL DEFAULT 0,
    "submittedQuantity" INTEGER NOT NULL DEFAULT 0,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "missingQuantity" INTEGER NOT NULL DEFAULT 0,
    "conditionStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "conditionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_return_group_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_return_instructions" (
    "id" TEXT NOT NULL,
    "returnGroupId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "storeSnapshotJson" JSONB NOT NULL,
    "addressSnapshotJson" JSONB NOT NULL,
    "itemsSnapshotJson" JSONB NOT NULL,
    "deadlineSnapshotJson" JSONB NOT NULL,
    "returnCostSnapshotJson" JSONB NOT NULL,
    "notesSnapshot" TEXT,
    "templateVersion" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "supersedesInstructionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_return_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_return_shipments" (
    "id" TEXT NOT NULL,
    "returnGroupId" TEXT NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "trackingCompany" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "customerMemo" TEXT,
    "proofJson" JSONB,
    "submittedAt" TIMESTAMP(3),
    "evidenceAcceptedAt" TIMESTAMP(3),
    "evidenceAcceptedBy" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_return_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_return_shipment_lines" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "returnGroupLineId" TEXT NOT NULL,
    "submittedQuantity" INTEGER NOT NULL DEFAULT 0,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "missingQuantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_return_shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_access_tokens" (
    "id" TEXT NOT NULL,
    "returnGroupId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "firstUsedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "issuedReason" TEXT,
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_actual_refund_events" (
    "id" TEXT NOT NULL,
    "withdrawalRequestId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyRefundId" TEXT NOT NULL,
    "shopifyOrderId" TEXT,
    "itemAmount" INTEGER NOT NULL DEFAULT 0,
    "initialShippingAmount" INTEGER NOT NULL DEFAULT 0,
    "otherAmount" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'JPY',
    "webhookReceivedAt" TIMESTAMP(3),
    "ledgerReconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "ledgerAmount" INTEGER,
    "reconciliationJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_actual_refund_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_actual_refund_allocations" (
    "id" TEXT NOT NULL,
    "actualRefundEventId" TEXT NOT NULL,
    "withdrawalContractId" TEXT,
    "requestedLineId" TEXT,
    "shopifyLineItemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "itemAmount" INTEGER NOT NULL DEFAULT 0,
    "initialShippingAmount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_actual_refund_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_workflow_policies_version_key" ON "withdrawal_workflow_policies"("version");

-- CreateIndex
CREATE INDEX "withdrawal_workflow_policies_active_effectiveAt_idx" ON "withdrawal_workflow_policies"("active", "effectiveAt");

-- CreateIndex
CREATE INDEX "vendor_return_addresses_vendorStoreId_status_idx" ON "vendor_return_addresses"("vendorStoreId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_return_addresses_vendorStoreId_version_key" ON "vendor_return_addresses"("vendorStoreId", "version");

-- A store may have at most one editable draft and one active destination.
CREATE UNIQUE INDEX "vendor_return_addresses_one_draft_per_store"
ON "vendor_return_addresses"("vendorStoreId")
WHERE "status" = 'DRAFT';

CREATE UNIQUE INDEX "vendor_return_addresses_one_active_per_store"
ON "vendor_return_addresses"("vendorStoreId")
WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "withdrawal_contracts_marketplaceOrderId_idx" ON "withdrawal_contracts"("marketplaceOrderId");

-- CreateIndex
CREATE INDEX "withdrawal_contracts_vendorStoreId_progressStatus_idx" ON "withdrawal_contracts"("vendorStoreId", "progressStatus");

-- CreateIndex
CREATE INDEX "withdrawal_contracts_sellerId_progressStatus_idx" ON "withdrawal_contracts"("sellerId", "progressStatus");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_contracts_withdrawalRequestId_contractKey_key" ON "withdrawal_contracts"("withdrawalRequestId", "contractKey");

-- CreateIndex
CREATE INDEX "withdrawal_order_line_positions_marketplaceOrderId_idx" ON "withdrawal_order_line_positions"("marketplaceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_order_line_positions_shopDomain_shopifyOrderId_s_key" ON "withdrawal_order_line_positions"("shopDomain", "shopifyOrderId", "shopifyLineItemId");

-- CreateIndex
CREATE INDEX "withdrawal_requested_lines_orderLinePositionId_reservedQuan_idx" ON "withdrawal_requested_lines"("orderLinePositionId", "reservedQuantity");

-- CreateIndex
CREATE INDEX "withdrawal_requested_lines_confirmedVendorStoreId_mappingSt_idx" ON "withdrawal_requested_lines"("confirmedVendorStoreId", "mappingStatus");

-- CreateIndex
CREATE INDEX "withdrawal_requested_lines_withdrawalContractId_idx" ON "withdrawal_requested_lines"("withdrawalContractId");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_requested_lines_withdrawalRequestId_shopDomain_s_key" ON "withdrawal_requested_lines"("withdrawalRequestId", "shopDomain", "shopifyOrderId", "shopifyLineItemId");

-- CreateIndex
CREATE INDEX "withdrawal_return_groups_vendorStoreId_progressStatus_idx" ON "withdrawal_return_groups"("vendorStoreId", "progressStatus");

-- CreateIndex
CREATE INDEX "withdrawal_return_groups_withdrawalContractId_idx" ON "withdrawal_return_groups"("withdrawalContractId");

-- CreateIndex
CREATE INDEX "withdrawal_return_groups_instructionStatus_blockedReason_idx" ON "withdrawal_return_groups"("instructionStatus", "blockedReason");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_return_groups_withdrawalRequestId_groupKey_key" ON "withdrawal_return_groups"("withdrawalRequestId", "groupKey");

-- CreateIndex
CREATE INDEX "withdrawal_return_group_lines_requestedLineId_idx" ON "withdrawal_return_group_lines"("requestedLineId");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_return_group_lines_returnGroupId_requestedLineId_key" ON "withdrawal_return_group_lines"("returnGroupId", "requestedLineId");

-- CreateIndex
CREATE INDEX "withdrawal_return_instructions_returnGroupId_status_idx" ON "withdrawal_return_instructions"("returnGroupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_return_instructions_returnGroupId_version_key" ON "withdrawal_return_instructions"("returnGroupId", "version");

-- CreateIndex
CREATE INDEX "withdrawal_return_shipments_trackingNumber_idx" ON "withdrawal_return_shipments"("trackingNumber");

-- CreateIndex
CREATE INDEX "withdrawal_return_shipments_returnGroupId_status_idx" ON "withdrawal_return_shipments"("returnGroupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_return_shipments_returnGroupId_packageNumber_key" ON "withdrawal_return_shipments"("returnGroupId", "packageNumber");

-- CreateIndex
CREATE INDEX "withdrawal_return_shipment_lines_returnGroupLineId_idx" ON "withdrawal_return_shipment_lines"("returnGroupLineId");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_return_shipment_lines_shipmentId_returnGroupLine_key" ON "withdrawal_return_shipment_lines"("shipmentId", "returnGroupLineId");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_access_tokens_tokenHash_key" ON "withdrawal_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "withdrawal_access_tokens_returnGroupId_purpose_expiresAt_idx" ON "withdrawal_access_tokens"("returnGroupId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "withdrawal_actual_refund_events_withdrawalRequestId_created_idx" ON "withdrawal_actual_refund_events"("withdrawalRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_actual_refund_events_withdrawalRequestId_shopDomain_shopifyRefundId_key" ON "withdrawal_actual_refund_events"("withdrawalRequestId", "shopDomain", "shopifyRefundId");

-- CreateIndex
CREATE INDEX "withdrawal_actual_refund_allocations_actualRefundEventId_idx" ON "withdrawal_actual_refund_allocations"("actualRefundEventId");

-- CreateIndex
CREATE INDEX "withdrawal_actual_refund_allocations_withdrawalContractId_idx" ON "withdrawal_actual_refund_allocations"("withdrawalContractId");

-- CreateIndex
CREATE INDEX "withdrawal_actual_refund_allocations_requestedLineId_idx" ON "withdrawal_actual_refund_allocations"("requestedLineId");

-- CreateIndex
CREATE INDEX "withdrawal_email_logs_returnGroupId_createdAt_idx" ON "withdrawal_email_logs"("returnGroupId", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawal_email_logs_instructionId_idx" ON "withdrawal_email_logs"("instructionId");

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_email_logs" ADD CONSTRAINT "withdrawal_email_logs_returnGroupId_fkey" FOREIGN KEY ("returnGroupId") REFERENCES "withdrawal_return_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_email_logs" ADD CONSTRAINT "withdrawal_email_logs_instructionId_fkey" FOREIGN KEY ("instructionId") REFERENCES "withdrawal_return_instructions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_return_addresses" ADD CONSTRAINT "vendor_return_addresses_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId") REFERENCES "VendorStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_contracts" ADD CONSTRAINT "withdrawal_contracts_withdrawalRequestId_fkey" FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_contracts" ADD CONSTRAINT "withdrawal_contracts_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_contracts" ADD CONSTRAINT "withdrawal_contracts_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_contracts" ADD CONSTRAINT "withdrawal_contracts_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "sellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_contracts" ADD CONSTRAINT "withdrawal_contracts_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId") REFERENCES "VendorStore"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_order_line_positions" ADD CONSTRAINT "withdrawal_order_line_positions_marketplaceOrderId_fkey" FOREIGN KEY ("marketplaceOrderId") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requested_lines" ADD CONSTRAINT "withdrawal_requested_lines_withdrawalRequestId_fkey" FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requested_lines" ADD CONSTRAINT "withdrawal_requested_lines_withdrawalContractId_fkey" FOREIGN KEY ("withdrawalContractId") REFERENCES "withdrawal_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requested_lines" ADD CONSTRAINT "withdrawal_requested_lines_orderLinePositionId_fkey" FOREIGN KEY ("orderLinePositionId") REFERENCES "withdrawal_order_line_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requested_lines" ADD CONSTRAINT "withdrawal_requested_lines_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requested_lines" ADD CONSTRAINT "withdrawal_requested_lines_sellerOrderLineId_fkey" FOREIGN KEY ("sellerOrderLineId") REFERENCES "seller_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_groups" ADD CONSTRAINT "withdrawal_return_groups_withdrawalRequestId_fkey" FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_groups" ADD CONSTRAINT "withdrawal_return_groups_withdrawalContractId_fkey" FOREIGN KEY ("withdrawalContractId") REFERENCES "withdrawal_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_groups" ADD CONSTRAINT "withdrawal_return_groups_vendorStoreId_fkey" FOREIGN KEY ("vendorStoreId") REFERENCES "VendorStore"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_groups" ADD CONSTRAINT "withdrawal_return_groups_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "seller_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_groups" ADD CONSTRAINT "withdrawal_return_groups_returnAddressId_fkey" FOREIGN KEY ("returnAddressId") REFERENCES "vendor_return_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_group_lines" ADD CONSTRAINT "withdrawal_return_group_lines_returnGroupId_fkey" FOREIGN KEY ("returnGroupId") REFERENCES "withdrawal_return_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_group_lines" ADD CONSTRAINT "withdrawal_return_group_lines_requestedLineId_fkey" FOREIGN KEY ("requestedLineId") REFERENCES "withdrawal_requested_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_instructions" ADD CONSTRAINT "withdrawal_return_instructions_returnGroupId_fkey" FOREIGN KEY ("returnGroupId") REFERENCES "withdrawal_return_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_instructions" ADD CONSTRAINT "withdrawal_return_instructions_supersedesInstructionId_fkey" FOREIGN KEY ("supersedesInstructionId") REFERENCES "withdrawal_return_instructions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_shipments" ADD CONSTRAINT "withdrawal_return_shipments_returnGroupId_fkey" FOREIGN KEY ("returnGroupId") REFERENCES "withdrawal_return_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_shipment_lines" ADD CONSTRAINT "withdrawal_return_shipment_lines_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "withdrawal_return_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_return_shipment_lines" ADD CONSTRAINT "withdrawal_return_shipment_lines_returnGroupLineId_fkey" FOREIGN KEY ("returnGroupLineId") REFERENCES "withdrawal_return_group_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_access_tokens" ADD CONSTRAINT "withdrawal_access_tokens_returnGroupId_fkey" FOREIGN KEY ("returnGroupId") REFERENCES "withdrawal_return_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_actual_refund_events" ADD CONSTRAINT "withdrawal_actual_refund_events_withdrawalRequestId_fkey" FOREIGN KEY ("withdrawalRequestId") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_actual_refund_allocations" ADD CONSTRAINT "withdrawal_actual_refund_allocations_actualRefundEventId_fkey" FOREIGN KEY ("actualRefundEventId") REFERENCES "withdrawal_actual_refund_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_actual_refund_allocations" ADD CONSTRAINT "withdrawal_actual_refund_allocations_withdrawalContractId_fkey" FOREIGN KEY ("withdrawalContractId") REFERENCES "withdrawal_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_actual_refund_allocations" ADD CONSTRAINT "withdrawal_actual_refund_allocations_requestedLineId_fkey" FOREIGN KEY ("requestedLineId") REFERENCES "withdrawal_requested_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
