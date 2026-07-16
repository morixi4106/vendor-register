import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.server.js";
import { formatPublicCountryLabel } from "../utils/deliveryEligibility.js";

export const WITHDRAWAL_CONTRACT_MODES = Object.freeze({
  PLATFORM_SINGLE_CONTRACT: "PLATFORM_SINGLE_CONTRACT",
  SELLER_SEPARATE_CONTRACTS: "SELLER_SEPARATE_CONTRACTS",
  MIXED_BY_SELLER_ROLE: "MIXED_BY_SELLER_ROLE",
});

export const RETURN_ADDRESS_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
});

export const RETURN_DISPOSITIONS = Object.freeze({
  RETURN_REQUIRED: "RETURN_REQUIRED",
  RETURN_NOT_REQUIRED: "RETURN_NOT_REQUIRED",
  COLLECTION_REQUIRED: "COLLECTION_REQUIRED",
  NON_PHYSICAL: "NON_PHYSICAL",
  EXEMPTION_REVIEW: "EXEMPTION_REVIEW",
});

const TERMINAL_OUTCOMES = new Set([
  "FULL_REFUND",
  "PARTIAL_REFUND",
  "NO_REFUND",
  "CANCELLED",
  "MIXED",
]);
const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 45;
const MAX_TRANSACTION_RETRIES = 4;

function text(value) {
  return String(value ?? "").trim();
}

function normalizeCurrency(value) {
  return text(value || "JPY").toUpperCase();
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function addDays(value, days) {
  const date = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date;
}

function allocateIntegerByWeight(total, entries) {
  const amount = Math.max(0, Math.trunc(Number(total || 0)));
  const normalized = entries.map((entry, index) => ({
    ...entry,
    index,
    weight: Math.max(0, Number(entry.weight || 0)),
  }));
  const weightTotal = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  if (!amount || !weightTotal) {
    return new Map(normalized.map((entry) => [entry.key, 0]));
  }
  const allocated = normalized.map((entry) => {
    const exact = (amount * entry.weight) / weightTotal;
    return { ...entry, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = amount - allocated.reduce((sum, entry) => sum + entry.value, 0);
  allocated
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .forEach((entry) => {
      if (remaining > 0) {
        entry.value += 1;
        remaining -= 1;
      }
    });
  return new Map(allocated.map((entry) => [entry.key, entry.value]));
}

function getOutstandingInitialShippingAmount(request) {
  const planned = jsonArray(request?.contracts).reduce((sum, contract) => {
    const status = text(contract?.initialShippingRefundStatus).toUpperCase();
    if (["NOT_APPLICABLE", "NOT_REFUNDABLE"].includes(status)) return sum;
    return sum + Math.max(0, Number(contract?.initialShippingRefundAmount || 0));
  }, 0);
  const actual = jsonArray(request?.actualRefundEvents).reduce(
    (sum, event) => sum + Math.max(0, Number(event?.initialShippingAmount || 0)),
    0,
  );
  return Math.max(0, planned - actual);
}

function selectShippingRefundTargetRequest(requests, allocationsByRequest) {
  const ordered = Array.isArray(requests) ? requests : [];
  return (
    ordered.find(
      (request) =>
        (allocationsByRequest.get(request.id) || []).length > 0 &&
        getOutstandingInitialShippingAmount(request) > 0,
    ) ||
    ordered.find((request) => getOutstandingInitialShippingAmount(request) > 0) ||
    ordered[0] ||
    null
  );
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function getSelectedLineSelection(request) {
  const selected = jsonObject(request?.selectedLineItemsJson);
  const submitted = jsonObject(request?.submittedPayloadJson);
  const values = new Set(
    [...jsonArray(selected.selectedLineItems), ...jsonArray(submitted.selectedLineItems)]
      .map(text)
      .filter(Boolean),
  );
  const quantities = new Map();
  for (const source of [
    jsonObject(selected.selectedLineQuantities),
    jsonObject(submitted.selectedLineQuantities),
  ]) {
    for (const [key, value] of Object.entries(source)) {
      const id = text(key);
      const quantity = Number(value);
      if (id && Number.isInteger(quantity) && quantity > 0) {
        values.add(id);
        quantities.set(id, quantity);
      }
    }
  }
  return { values, quantities };
}

function lineMatchesSelection(line, selectedValues) {
  if (selectedValues.size === 0) return false;
  return [
    line.id,
    line.shopifyLineItemId,
    line.shopifyProductId,
    line.shopifyVariantId,
    line.productId,
    line.title,
    line.sku,
  ]
    .map(text)
    .filter(Boolean)
    .some((candidate) => selectedValues.has(candidate));
}

function getSelectedQuantity(line, selection, purchasedQuantity) {
  const candidates = [
    line.id,
    line.shopifyLineItemId,
    line.shopifyProductId,
    line.shopifyVariantId,
    line.productId,
    line.title,
    line.sku,
  ]
    .map(text)
    .filter(Boolean);
  for (const candidate of candidates) {
    if (selection.quantities.has(candidate)) {
      return Math.min(purchasedQuantity, selection.quantities.get(candidate));
    }
  }
  return purchasedQuantity;
}

function normalizePartialLineSelections(lineSelections) {
  const selections = new Map();
  for (const entry of Array.isArray(lineSelections) ? lineSelections : []) {
    const sellerOrderLineId = text(entry?.sellerOrderLineId || entry?.id);
    const quantity = Number(entry?.quantity);
    if (!sellerOrderLineId || !Number.isInteger(quantity) || quantity <= 0) continue;
    selections.set(sellerOrderLineId, quantity);
  }
  return selections;
}

function getPlatformPartyName() {
  return text(process.env.WITHDRAWAL_PLATFORM_PARTY_NAME) || "Oja Immanuel Bacchus";
}

function isSellerContractParty(seller, mode) {
  if (mode === WITHDRAWAL_CONTRACT_MODES.SELLER_SEPARATE_CONTRACTS) return true;
  if (mode === WITHDRAWAL_CONTRACT_MODES.PLATFORM_SINGLE_CONTRACT) return false;
  return text(seller?.sellerLegalRole).toUpperCase() === "MARKETPLACE_SELLER";
}

function contractKeyForSellerOrder(sellerOrder, seller, mode) {
  return isSellerContractParty(seller, mode)
    ? `seller:${seller?.id || sellerOrder.sellerId}`
    : "platform";
}

function addressSnapshot(address) {
  return {
    sourceAddressId: address.id,
    sourceVersion: address.version,
    recipientName: address.recipientName,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    countryLabel: address.countryLabel,
    region: address.region,
    city: address.city,
    address1: address.address1,
    address2: address.address2,
    phone: address.phone,
    instructions: address.instructions,
    internationalRecipientName: address.internationalRecipientName,
    internationalAddressLines: address.internationalAddressLines,
    phoneE164: address.phoneE164,
    localizedInstructions: Object.fromEntries(
      (Array.isArray(address.locales) ? address.locales : []).map((entry) => [
        entry.locale,
        {
          recipientDisplayName: entry.recipientDisplayName,
          returnInstructions: entry.returnInstructions,
        },
      ]),
    ),
    confirmedAt: address.confirmedAt?.toISOString?.() || null,
  };
}

function serializeRequestedLine(line) {
  return {
    requestedLineId: line.requestedLine.id,
    shopifyLineItemId: line.requestedLine.shopifyLineItemId,
    title: line.requestedLine.titleSnapshot,
    sku: line.requestedLine.skuSnapshot,
    quantity: line.instructedQuantity,
    returnDisposition: line.requestedLine.returnDisposition,
    currencyCode: line.requestedLine.currencyCode,
  };
}

function isGroupTerminal(group) {
  return TERMINAL_OUTCOMES.has(text(group.outcomeStatus).toUpperCase());
}

export function deriveReturnGroupState(group) {
  if (isGroupTerminal(group)) {
    return { progressStatus: "COMPLETED", outcomeStatus: group.outcomeStatus };
  }
  if (group.blockedReason || group.mappingStatus !== "CONFIRMED") {
    return { progressStatus: "REVIEW_REQUIRED", outcomeStatus: "UNDECIDED" };
  }
  if (
    group.routingStatus === "READY" &&
    ["NOT_READY", "READY", "DRAFT"].includes(group.instructionStatus)
  ) {
    return { progressStatus: "READY_FOR_INSTRUCTIONS", outcomeStatus: "UNDECIDED" };
  }
  if (
    group.instructionStatus === "SENT" ||
    group.evidenceStatus !== "NOT_SUBMITTED" ||
    group.receiptStatus !== "NOT_RECEIVED" ||
    group.inspectionStatus !== "NOT_INSPECTED" ||
    group.refundDecisionStatus !== "UNDECIDED"
  ) {
    return { progressStatus: "IN_PROGRESS", outcomeStatus: "UNDECIDED" };
  }
  return { progressStatus: "PENDING", outcomeStatus: "UNDECIDED" };
}

export function deriveWithdrawalAggregate(groups = []) {
  if (!groups.length) {
    return { progressStatus: "REVIEW_REQUIRED", outcomeStatus: "UNDECIDED" };
  }
  if (groups.some((group) => group.progressStatus === "REVIEW_REQUIRED")) {
    return { progressStatus: "REVIEW_REQUIRED", outcomeStatus: "UNDECIDED" };
  }
  if (groups.every((group) => group.progressStatus === "COMPLETED")) {
    const outcomes = new Set(groups.map((group) => group.outcomeStatus));
    return {
      progressStatus: "COMPLETED",
      outcomeStatus: outcomes.size === 1 ? [...outcomes][0] : "MIXED",
    };
  }
  if (groups.some((group) => group.progressStatus === "IN_PROGRESS")) {
    return { progressStatus: "IN_PROGRESS", outcomeStatus: "UNDECIDED" };
  }
  if (groups.every((group) => group.progressStatus === "READY_FOR_INSTRUCTIONS")) {
    return { progressStatus: "READY_FOR_INSTRUCTIONS", outcomeStatus: "UNDECIDED" };
  }
  return { progressStatus: "PENDING", outcomeStatus: "UNDECIDED" };
}

export async function recomputeWithdrawalV2State(
  withdrawalRequestId,
  prismaClient = prisma,
) {
  const groups = await prismaClient.withdrawalReturnGroup.findMany({
    where: { withdrawalRequestId },
    orderBy: { createdAt: "asc" },
  });

  for (const group of groups) {
    const state = deriveReturnGroupState(group);
    if (
      state.progressStatus !== group.progressStatus ||
      state.outcomeStatus !== group.outcomeStatus
    ) {
      await prismaClient.withdrawalReturnGroup.update({
        where: { id: group.id },
        data: state,
      });
      Object.assign(group, state);
    }
  }

  const aggregate = deriveWithdrawalAggregate(groups);
  const totals = groups.reduce(
    (sum, group) => ({
      item: sum.item + Number(group.itemRefundNetAmount || 0),
      deduction: sum.deduction + Number(group.deductionAmount || 0),
      planned: sum.planned + Number(group.plannedRefundAmount || 0),
    }),
    { item: 0, deduction: 0, planned: 0 },
  );

  const contracts = await prismaClient.withdrawalContract.findMany({
    where: { withdrawalRequestId },
    orderBy: { createdAt: "asc" },
  });
  for (const contract of contracts) {
    const contractGroups = groups.filter(
      (group) => group.withdrawalContractId === contract.id,
    );
    const itemBase = contractGroups.reduce(
      (sum, group) => sum + Number(group.itemRefundBaseAmount || 0),
      0,
    );
    const deduction = contractGroups.reduce(
      (sum, group) => sum + Number(group.deductionAmount || 0),
      0,
    );
    const itemNet = contractGroups.reduce(
      (sum, group) => sum + Number(group.itemRefundNetAmount || 0),
      0,
    );
    const contractState = deriveWithdrawalAggregate(contractGroups);
    await prismaClient.withdrawalContract.update({
      where: { id: contract.id },
      data: {
        ...contractState,
        itemRefundBaseAmount: itemBase,
        deductionAmount: deduction,
        itemRefundNetAmount: itemNet,
        plannedRefundAmount:
          itemNet + Number(contract.initialShippingRefundAmount || 0),
        completedAt:
          contractState.progressStatus === "COMPLETED"
            ? contract.completedAt || new Date()
            : null,
      },
    });
  }
  const shipping = contracts.reduce(
    (sum, contract) => sum + Number(contract.initialShippingRefundAmount || 0),
    0,
  );

  return prismaClient.withdrawalRequest.update({
    where: { id: withdrawalRequestId },
    data: {
      ...aggregate,
      refundItemAmount: totals.item,
      refundDeductionAmount: totals.deduction,
      refundInitialShippingAmount: shipping,
      refundTotalAmount: Math.max(0, totals.planned + shipping),
    },
  });
}

export async function getActiveWithdrawalWorkflowPolicy(prismaClient = prisma) {
  if (!prismaClient?.withdrawalWorkflowPolicy?.findFirst) return null;
  return prismaClient.withdrawalWorkflowPolicy.findFirst({
    where: {
      active: true,
      directReturnEnabled: true,
      OR: [{ effectiveAt: null }, { effectiveAt: { lte: new Date() } }],
    },
    orderBy: [{ version: "desc" }],
  });
}

export async function upsertWithdrawalWorkflowPolicy({
  version,
  contractMode,
  termsVersion,
  directReturnEnabled = false,
  notes = null,
  changedBy = "admin",
  prismaClient = prisma,
} = {}) {
  if (!Object.values(WITHDRAWAL_CONTRACT_MODES).includes(contractMode)) {
    return { ok: false, status: 400, error: "invalid_contract_mode" };
  }
  if (!Number.isInteger(Number(version)) || Number(version) < 2 || !text(termsVersion)) {
    return { ok: false, status: 400, error: "invalid_policy" };
  }
  const policy = await prismaClient.withdrawalWorkflowPolicy.upsert({
    where: { version: Number(version) },
    create: {
      version: Number(version),
      contractMode,
      termsVersion: text(termsVersion),
      directReturnEnabled: Boolean(directReturnEnabled),
      notes: text(notes) || null,
    },
    update: {
      contractMode,
      termsVersion: text(termsVersion),
      directReturnEnabled: Boolean(directReturnEnabled),
      notes: text(notes) || null,
      ...(directReturnEnabled ? {} : { active: false, deactivatedAt: new Date(), deactivatedBy: changedBy }),
    },
  });
  return { ok: true, policy };
}

export async function activateWithdrawalWorkflowPolicy({
  policyId,
  changedBy = "admin",
  prismaClient = prisma,
} = {}) {
  const policy = await prismaClient.withdrawalWorkflowPolicy.findUnique({
    where: { id: text(policyId) },
  });
  if (!policy || !policy.directReturnEnabled) {
    return { ok: false, status: 400, error: "policy_not_ready" };
  }
  const now = new Date();
  await prismaClient.$transaction([
    prismaClient.withdrawalWorkflowPolicy.updateMany({
      where: { active: true, id: { not: policy.id } },
      data: { active: false, deactivatedAt: now, deactivatedBy: changedBy },
    }),
    prismaClient.withdrawalWorkflowPolicy.update({
      where: { id: policy.id },
      data: {
        active: true,
        effectiveAt: policy.effectiveAt || now,
        activatedAt: now,
        activatedBy: changedBy,
        deactivatedAt: null,
        deactivatedBy: null,
      },
    }),
  ]);
  return { ok: true };
}

export async function getVendorReturnAddressState(vendorStoreId, prismaClient = prisma) {
  const addresses = await prismaClient.vendorReturnAddress.findMany({
    where: { vendorStoreId: text(vendorStoreId) },
    include: { locales: true },
    orderBy: [{ version: "desc" }],
  });
  return {
    active: addresses.find((address) => address.status === RETURN_ADDRESS_STATUSES.ACTIVE) || null,
    draft: addresses.find((address) => address.status === RETURN_ADDRESS_STATUSES.DRAFT) || null,
    history: addresses.filter((address) => address.status === RETURN_ADDRESS_STATUSES.INACTIVE),
  };
}

function normalizeReturnAddressInput(values = {}) {
  const countryCode = text(values.countryCode).toUpperCase();
  const publicCountryLabel = formatPublicCountryLabel(countryCode);
  const data = {
    recipientName: text(values.recipientName),
    postalCode: text(values.postalCode),
    countryCode,
    countryLabel:
      (publicCountryLabel && publicCountryLabel !== countryCode ? publicCountryLabel : null) ||
      text(values.countryLabel) ||
      countryCode ||
      null,
    region: text(values.region) || null,
    city: text(values.city) || null,
    address1: text(values.address1),
    address2: text(values.address2) || null,
    phone: text(values.phone) || null,
    instructions: text(values.instructions) || null,
    internationalRecipientName: text(values.internationalRecipientName) || null,
    internationalAddressLines: normalizeInternationalAddressLines(
      values.internationalAddressLines,
    ),
    phoneE164: text(values.phoneE164) || null,
    canReceiveReturnsConfirmed: Boolean(values.canReceiveReturnsConfirmed),
    buyerDisclosureConfirmed: Boolean(values.buyerDisclosureConfirmed),
    legalRecipientConfirmed: Boolean(values.legalRecipientConfirmed),
  };
  const errors = {};
  for (const key of ["recipientName", "postalCode", "countryCode", "city", "address1"]) {
    if (!data[key]) errors[key] = "required";
  }
  if (!/^[A-Z]{2}$/.test(data.countryCode)) errors.countryCode = "invalid";
  if (data.countryCode === "JP" && !data.region) errors.region = "required";
  if (data.phoneE164 && !/^\+[1-9][0-9]{6,14}$/.test(data.phoneE164)) {
    errors.phoneE164 = "invalid";
  }
  return { ok: Object.keys(errors).length === 0, data, errors };
}

export async function saveVendorReturnAddressDraft({
  vendorStoreId,
  values,
  changedBy = "vendor",
  prismaClient = prisma,
} = {}) {
  const normalized = normalizeReturnAddressInput(values);
  if (!normalized.ok) return { ok: false, status: 400, errors: normalized.errors };
  const state = await getVendorReturnAddressState(vendorStoreId, prismaClient);
  const maxVersion = [state.active, state.draft, ...state.history].reduce(
    (max, address) => Math.max(max, Number(address?.version || 0)),
    0,
  );
  const confirmationComplete =
    normalized.data.canReceiveReturnsConfirmed &&
    normalized.data.buyerDisclosureConfirmed &&
    normalized.data.legalRecipientConfirmed;
  const common = {
    ...normalized.data,
    confirmedAt: confirmationComplete ? new Date() : null,
    confirmedBy: confirmationComplete ? changedBy : null,
  };
  const draft = state.draft
    ? await prismaClient.vendorReturnAddress.update({ where: { id: state.draft.id }, data: common })
    : await prismaClient.vendorReturnAddress.create({
        data: { vendorStoreId, version: maxVersion + 1, status: "DRAFT", ...common },
      });
  if (prismaClient.vendorReturnAddressLocale?.upsert) {
    const localizedValues = [
      {
        locale: "ja-JP",
        returnInstructions: text(values.instructions) || null,
        recipientDisplayName: normalized.data.recipientName,
      },
      {
        locale: "en-GB",
        returnInstructions: text(values.instructionsEn) || null,
        recipientDisplayName:
          normalized.data.internationalRecipientName || normalized.data.recipientName,
      },
    ];
    for (const localized of localizedValues) {
      await prismaClient.vendorReturnAddressLocale.upsert({
        where: {
          returnAddressId_locale: {
            returnAddressId: draft.id,
            locale: localized.locale,
          },
        },
        create: { returnAddressId: draft.id, ...localized },
        update: localized,
      });
    }
  }
  return { ok: true, draft };
}

export async function activateVendorReturnAddress({
  vendorStoreId,
  draftId,
  changedBy = "vendor",
  prismaClient = prisma,
} = {}) {
  const draft = await prismaClient.vendorReturnAddress.findFirst({
    where: { id: text(draftId), vendorStoreId: text(vendorStoreId), status: "DRAFT" },
  });
  if (!draft) return { ok: false, status: 404, error: "draft_not_found" };
  if (
    draft.countryCode === "JP" &&
    (!draft.internationalRecipientName ||
      !Array.isArray(draft.internationalAddressLines) ||
      draft.internationalAddressLines.length === 0)
  ) {
    return { ok: false, status: 400, error: "international_address_required" };
  }
  if (
    !draft.canReceiveReturnsConfirmed ||
    !draft.buyerDisclosureConfirmed ||
    !draft.legalRecipientConfirmed ||
    !draft.confirmedAt
  ) {
    return { ok: false, status: 400, error: "confirmation_required" };
  }
  const now = new Date();
  const affectedRequestIds = await prismaClient.$transaction(async (tx) => {
    await tx.vendorReturnAddress.updateMany({
      where: { vendorStoreId, status: "ACTIVE" },
      data: { status: "INACTIVE", deactivatedAt: now, deactivatedBy: changedBy },
    });
    const activeAddress = await tx.vendorReturnAddress.update({
      where: { id: draft.id },
      data: { status: "ACTIVE", activatedAt: now, activatedBy: changedBy },
    });
    const affectedGroups = await tx.withdrawalReturnGroup.findMany({
      where: {
        vendorStoreId,
        instructionsSentAt: null,
      },
      select: { withdrawalRequestId: true },
    });
    await tx.withdrawalReturnGroup.updateMany({
      where: {
        vendorStoreId,
        instructionsSentAt: null,
      },
      data: {
        returnAddressId: activeAddress.id,
        routingStatus: "READY",
        instructionStatus: "READY",
        progressStatus: "READY_FOR_INSTRUCTIONS",
        blockedReason: null,
      },
    });
    return [...new Set(affectedGroups.map((group) => group.withdrawalRequestId))];
  });
  for (const requestId of affectedRequestIds) {
    await recomputeWithdrawalV2State(requestId, prismaClient);
  }
  return { ok: true };
}

function mapOrderLine(line, request, selection, isPartial) {
  if (isPartial && !lineMatchesSelection(line, selection.values)) return null;
  const quantity = Math.max(1, Number(line.quantity || 1));
  const requestedQuantity = isPartial
    ? getSelectedQuantity(line, selection, quantity)
    : quantity;
  const prorate = (value) =>
    Math.floor((Math.max(0, Number(value || 0)) * requestedQuantity) / quantity);
  const amount = prorate(line.netAmount);
  return {
    line,
    requestedQuantity,
    amount,
    subtotalAmount: prorate(line.lineSubtotalAmount),
    discountAmount: prorate(line.discountAmount),
    taxAmount: prorate(line.taxAmount),
    shopDomain: text(request.shopDomain || request.orderSnapshotJson?.shopDomain),
    shopifyOrderId: text(request.shopifyOrderId || request.orderSnapshotJson?.shopifyOrderId),
  };
}

async function reserveAndCreateRequestedLines({ request, mappedLines, tx }) {
  const created = [];
  for (const mapped of mappedLines) {
    const line = mapped.line;
    const position = await tx.withdrawalOrderLinePosition.upsert({
      where: {
        shopDomain_shopifyOrderId_shopifyLineItemId: {
          shopDomain: mapped.shopDomain,
          shopifyOrderId: mapped.shopifyOrderId,
          shopifyLineItemId: line.shopifyLineItemId,
        },
      },
      create: {
        marketplaceOrderId: request.marketplaceOrderId,
        shopDomain: mapped.shopDomain,
        shopifyOrderId: mapped.shopifyOrderId,
        shopifyLineItemId: line.shopifyLineItemId,
        purchasedQuantity: Math.max(1, Number(line.quantity || 1)),
        refundedQuantity: Math.max(0, Number(line.refundedQuantity || 0)),
        sourceSnapshotJson: { sellerOrderLineId: line.id },
      },
      update: {
        purchasedQuantity: Math.max(1, Number(line.quantity || 1)),
        refundedQuantity: Math.max(0, Number(line.refundedQuantity || 0)),
        observedAt: new Date(),
      },
    });
    const reservations = await tx.withdrawalRequestedLine.aggregate({
      where: {
        orderLinePositionId: position.id,
        withdrawalRequestId: { not: request.id },
        withdrawalRequest: { outcomeStatus: { notIn: ["CANCELLED", "NO_REFUND"] } },
      },
      _sum: { reservedQuantity: true, releasedQuantity: true },
    });
    const alreadyReserved =
      Number(reservations._sum.reservedQuantity || 0) -
      Number(reservations._sum.releasedQuantity || 0);
    const available = Math.max(
      0,
      position.purchasedQuantity -
        position.refundedQuantity -
        position.cancelledQuantity -
        alreadyReserved,
    );
    if (mapped.requestedQuantity > available) {
      throw new Error(`withdrawal_quantity_unavailable:${line.shopifyLineItemId}`);
    }
    const requestedLine = await tx.withdrawalRequestedLine.create({
      data: {
        withdrawalRequestId: request.id,
        orderLinePositionId: position.id,
        sellerOrderId: line.sellerOrderId,
        sellerOrderLineId: line.id,
        shopDomain: mapped.shopDomain,
        shopifyOrderId: mapped.shopifyOrderId,
        shopifyLineItemId: line.shopifyLineItemId,
        shopifyProductId: line.shopifyProductId,
        shopifyVariantId: line.shopifyVariantId,
        productId: line.productId,
        requestedQuantity: mapped.requestedQuantity,
        reservedQuantity: mapped.requestedQuantity,
        approvedQuantity: mapped.requestedQuantity,
        titleSnapshot: line.title || "商品",
        skuSnapshot: line.sku,
        unitAmountSnapshot: Number(line.unitAmount || 0),
        subtotalAmountSnapshot: mapped.subtotalAmount,
        discountAmountSnapshot: mapped.discountAmount,
        taxAmountSnapshot: mapped.taxAmount,
        paidAmountSnapshot: mapped.amount,
        currencyCode: normalizeCurrency(line.currencyCode),
        mappingStatus: "CONFIRMED",
        mappingMethod: "SELLER_ORDER_LINE_SNAPSHOT",
        candidateVendorStoreId: line.sellerOrder.vendorStoreId,
        confirmedVendorStoreId: line.sellerOrder.vendorStoreId,
        mappingConfirmedAt: new Date(),
        mappingConfirmedBy: "system",
        itemRefundBaseAmount: mapped.amount,
        itemRefundNetAmount: mapped.amount,
      },
    });
    created.push({ requestedLine, sellerOrder: line.sellerOrder, seller: line.sellerOrder.seller });
  }
  return created;
}

async function initializeV2Transaction({
  requestId,
  policy,
  lineSelections = null,
  changedBy = "system",
  prismaClient,
}) {
  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
    try {
      return await prismaClient.$transaction(
        async (tx) => {
          const request = await tx.withdrawalRequest.findUnique({
            where: { id: requestId },
            include: {
              contracts: { select: { id: true }, take: 1 },
              requestedLines: { select: { id: true }, take: 1 },
              marketplaceOrder: {
                include: {
                  sellerOrders: {
                    include: {
                      lines: true,
                    },
                  },
                },
              },
            },
          });
          if (!request) throw new Error("withdrawal_request_not_found");
          if (request.contracts?.length || request.requestedLines?.length) {
            if (lineSelections) throw new Error("withdrawal_line_mapping_locked");
            return request;
          }
          const isPartial = text(request.withdrawalScope).toUpperCase() === "PARTIAL";
          if (lineSelections && !isPartial) {
            throw new Error("withdrawal_partial_mapping_not_applicable");
          }
          if (isPartial && !lineSelections) {
            throw new Error("withdrawal_partial_line_mapping_required");
          }
          const sellerOrders = request.marketplaceOrder?.sellerOrders || [];
          if (!sellerOrders.length) throw new Error("seller_orders_not_found");
          if (lineSelections) {
            const normalizedSelections = normalizePartialLineSelections(lineSelections);
            if (!normalizedSelections.size) {
              throw new Error("withdrawal_partial_line_mapping_required");
            }
            const availableLines = sellerOrders.flatMap((order) => order.lines || []);
            const availableById = new Map(availableLines.map((line) => [line.id, line]));
            for (const [lineId, quantity] of normalizedSelections.entries()) {
              const line = availableById.get(lineId);
              if (!line) throw new Error("withdrawal_line_not_in_order");
              if (quantity > Math.max(1, Number(line.quantity || 1))) {
                throw new Error("withdrawal_line_quantity_exceeded");
              }
            }
            const selectedLineItemsJson = {
              ...jsonObject(request.selectedLineItemsJson),
              selectedLineItems: [...normalizedSelections.keys()],
              selectedLineQuantities: Object.fromEntries(normalizedSelections),
              mappingConfirmedAt: new Date().toISOString(),
              mappingConfirmedBy: text(changedBy) || "admin",
            };
            request.selectedLineItemsJson = selectedLineItemsJson;
            await tx.withdrawalRequest.update({
              where: { id: request.id },
              data: {
                selectedLineItemsJson,
                v2ReviewReason: null,
              },
            });
          }
          await tx.withdrawalRequest.update({
            where: { id: request.id },
            data: {
              workflowVersion: 2,
              returnMode: "DIRECT_TO_STORE",
              contractMode: policy.contractMode,
              contractPolicyVersion: policy.version,
              termsVersion: policy.termsVersion,
              v2ActivatedAt: new Date(),
              progressStatus: "REVIEW_REQUIRED",
              outcomeStatus: "UNDECIDED",
            },
          });
          const sellerIds = [...new Set(sellerOrders.map((order) => order.sellerId).filter(Boolean))];
          const sellers = await tx.seller.findMany({
            where: { id: { in: sellerIds } },
            include: { vendor: true, vendorStore: true },
          });
          const sellerById = new Map(sellers.map((seller) => [seller.id, seller]));
          const selection = isPartial
            ? getSelectedLineSelection(request)
            : { values: new Set(), quantities: new Map() };
          const mappedLines = sellerOrders.flatMap((sellerOrder) =>
            sellerOrder.lines
              .map((line) =>
                mapOrderLine(
                  { ...line, sellerOrder: { ...sellerOrder, seller: sellerById.get(sellerOrder.sellerId) } },
                  request,
                  selection,
                  isPartial,
                ),
              )
              .filter(Boolean),
          );
          if (!mappedLines.length) throw new Error("withdrawal_lines_not_mapped");
          const requested = await reserveAndCreateRequestedLines({ request, mappedLines, tx });
          const contractByKey = new Map();
          for (const item of requested) {
            const sellerOrder = item.sellerOrder;
            const seller = item.seller || sellerById.get(sellerOrder.sellerId);
            const key = contractKeyForSellerOrder(sellerOrder, seller, policy.contractMode);
            let contract = contractByKey.get(key);
            if (!contract) {
              const sellerParty = isSellerContractParty(seller, policy.contractMode);
              contract = await tx.withdrawalContract.create({
                data: {
                  withdrawalRequestId: request.id,
                  marketplaceOrderId: request.marketplaceOrderId,
                  sellerOrderId: sellerParty ? sellerOrder.id : null,
                  sellerId: sellerParty ? seller?.id : null,
                  vendorStoreId: sellerParty ? sellerOrder.vendorStoreId : null,
                  contractKey: key,
                  contractMode: policy.contractMode,
                  contractPartyRole: sellerParty ? "SELLER" : "PLATFORM",
                  contractPartyName: sellerParty
                    ? seller?.vendor?.storeName || seller?.vendorStore?.storeName || "販売店舗"
                    : getPlatformPartyName(),
                  contractPartyId: sellerParty ? seller?.id : null,
                  sellerLegalRoleSnapshot: seller?.sellerLegalRole || null,
                  refundResponsibilitySnapshot: sellerParty ? "SELLER" : "PLATFORM",
                  termsVersion: policy.termsVersion,
                  lastPhysicalPossessionAt: request.receivedDate,
                  withdrawalEligibilityDeadlineAt: request.deadlineAt,
                  withdrawalExercisedAt: request.createdAt,
                  statutoryReturnDeadlineAt: addDays(request.createdAt, 14),
                  currencyCode: normalizeCurrency(sellerOrder.currencyCode),
                },
              });
              contractByKey.set(key, contract);
            }
            await tx.withdrawalRequestedLine.update({
              where: { id: item.requestedLine.id },
              data: { withdrawalContractId: contract.id },
            });
            item.contract = contract;
          }
          const grouped = new Map();
          for (const item of requested) {
            const storeId = item.sellerOrder.vendorStoreId;
            if (!storeId) continue;
            const groupKey = `store:${storeId}`;
            const current = grouped.get(groupKey) || [];
            current.push(item);
            grouped.set(groupKey, current);
          }
          for (const [groupKey, items] of grouped.entries()) {
            const first = items[0];
            const storeId = first.sellerOrder.vendorStoreId;
            const address = await tx.vendorReturnAddress.findFirst({
              where: { vendorStoreId: storeId, status: "ACTIVE" },
              orderBy: { version: "desc" },
            });
            const store = first.seller?.vendorStore;
            const group = await tx.withdrawalReturnGroup.create({
              data: {
                withdrawalRequestId: request.id,
                withdrawalContractId: first.contract.id,
                vendorStoreId: storeId,
                sellerOrderId: first.sellerOrder.id,
                returnAddressId: address?.id || null,
                groupKey,
                mappingStatus: "CONFIRMED",
                routingStatus: address ? "READY" : "BLOCKED",
                instructionStatus: address ? "NOT_READY" : "NOT_READY",
                progressStatus: address ? "READY_FOR_INSTRUCTIONS" : "REVIEW_REQUIRED",
                storeNameSnapshot: store?.storeName || first.seller?.vendor?.storeName || "販売店舗",
                sellerLegalRoleSnapshot: first.seller?.sellerLegalRole || null,
                statutoryReturnDeadlineAt: first.contract.statutoryReturnDeadlineAt,
                blockedReason: address ? null : "RETURN_ADDRESS_MISSING",
                itemRefundBaseAmount: items.reduce(
                  (sum, item) => sum + Number(item.requestedLine.itemRefundBaseAmount || 0),
                  0,
                ),
                itemRefundNetAmount: items.reduce(
                  (sum, item) => sum + Number(item.requestedLine.itemRefundNetAmount || 0),
                  0,
                ),
                currencyCode: normalizeCurrency(first.requestedLine.currencyCode),
              },
            });
            for (const item of items) {
              await tx.withdrawalReturnGroupLine.create({
                data: {
                  returnGroupId: group.id,
                  requestedLineId: item.requestedLine.id,
                  instructedQuantity: item.requestedLine.requestedQuantity,
                },
              });
            }
          }
          const contractItems = [...contractByKey.values()].map((contract) => ({
            key: contract.id,
            weight: requested
              .filter((item) => item.contract.id === contract.id)
              .reduce(
                (sum, item) =>
                  sum + Number(item.requestedLine.itemRefundBaseAmount || 0),
                0,
              ),
          }));
          const existingShippingAllocation = await tx.withdrawalContract.aggregate({
            where: {
              marketplaceOrderId: request.marketplaceOrderId,
              withdrawalRequestId: { not: request.id },
              initialShippingRefundStatus: {
                notIn: ["NOT_APPLICABLE", "NOT_REFUNDABLE"],
              },
            },
            _sum: { initialShippingRefundAmount: true },
          });
          const remainingOrderShipping = Math.max(
            0,
            Number(request.marketplaceOrder?.shippingAmount || 0) -
              Number(existingShippingAllocation._sum.initialShippingRefundAmount || 0),
          );
          const shippingAllocations = allocateIntegerByWeight(
            remainingOrderShipping,
            contractItems,
          );
          for (const contract of contractByKey.values()) {
            const contractLines = requested.filter((item) => item.contract.id === contract.id);
            const itemRefundBaseAmount = contractLines.reduce(
              (sum, item) => sum + Number(item.requestedLine.itemRefundBaseAmount || 0),
              0,
            );
            const initialShippingRefundAmount = Number(
              shippingAllocations.get(contract.id) || 0,
            );
            await tx.withdrawalContract.update({
              where: { id: contract.id },
              data: {
                itemRefundBaseAmount,
                itemRefundNetAmount: itemRefundBaseAmount,
                initialShippingRefundStatus:
                  initialShippingRefundAmount > 0 ? "PLANNED" : "NOT_APPLICABLE",
                initialShippingRefundAmount,
                initialShippingRefundReason:
                  initialShippingRefundAmount > 0
                    ? "ORDER_STANDARD_SHIPPING_PROPORTIONAL_ALLOCATION"
                    : null,
                plannedRefundAmount:
                  itemRefundBaseAmount + initialShippingRefundAmount,
                progressStatus: "PENDING",
              },
            });
          }
          return request;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error?.code === "P2034" && attempt + 1 < MAX_TRANSACTION_RETRIES) continue;
      throw error;
    }
  }
  throw new Error("withdrawal_v2_transaction_retry_exhausted");
}

export async function initializeWithdrawalDirectReturnWorkflow({
  withdrawalRequestId,
  prismaClient = prisma,
} = {}) {
  const policy = await getActiveWithdrawalWorkflowPolicy(prismaClient);
  if (!policy) return { ok: true, skipped: true, reason: "v2_policy_inactive" };
  try {
    await initializeV2Transaction({ requestId: withdrawalRequestId, policy, prismaClient });
    await recomputeWithdrawalV2State(withdrawalRequestId, prismaClient);
    return { ok: true, workflowVersion: 2 };
  } catch (error) {
    await prismaClient.withdrawalRequest.update({
      where: { id: withdrawalRequestId },
      data: {
        workflowVersion: 2,
        returnMode: "DIRECT_TO_STORE",
        contractMode: policy.contractMode,
        contractPolicyVersion: policy.version,
        termsVersion: policy.termsVersion,
        progressStatus: "REVIEW_REQUIRED",
        v2ReviewReason: text(error?.message || error).slice(0, 240),
      },
    });
    return { ok: false, status: 409, error: "v2_initialization_failed" };
  }
}

export async function confirmWithdrawalPartialLineMapping({
  withdrawalRequestId,
  lineSelections,
  changedBy = "admin",
  prismaClient = prisma,
} = {}) {
  const request = await prismaClient.withdrawalRequest.findUnique({
    where: { id: text(withdrawalRequestId) },
    select: {
      id: true,
      withdrawalScope: true,
      contractPolicyVersion: true,
      contracts: { select: { id: true }, take: 1 },
      requestedLines: { select: { id: true }, take: 1 },
    },
  });
  if (!request) return { ok: false, status: 404, error: "withdrawal_request_not_found" };
  if (text(request.withdrawalScope).toUpperCase() !== "PARTIAL") {
    return { ok: false, status: 400, error: "withdrawal_partial_mapping_not_applicable" };
  }
  if (request.contracts?.length || request.requestedLines?.length) {
    return { ok: false, status: 409, error: "withdrawal_line_mapping_locked" };
  }
  if (!normalizePartialLineSelections(lineSelections).size) {
    return { ok: false, status: 400, error: "withdrawal_partial_line_mapping_required" };
  }
  const policy = request.contractPolicyVersion
    ? await prismaClient.withdrawalWorkflowPolicy.findUnique({
        where: { version: Number(request.contractPolicyVersion) },
      })
    : await getActiveWithdrawalWorkflowPolicy(prismaClient);
  if (!policy?.directReturnEnabled) {
    return { ok: false, status: 409, error: "withdrawal_policy_not_found" };
  }
  try {
    await initializeV2Transaction({
      requestId: request.id,
      policy,
      lineSelections,
      changedBy,
      prismaClient,
    });
    await recomputeWithdrawalV2State(request.id, prismaClient);
    return { ok: true, workflowVersion: 2 };
  } catch (error) {
    const reason = text(error?.message || error);
    if (reason !== "withdrawal_line_mapping_locked") {
      await prismaClient.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          progressStatus: "REVIEW_REQUIRED",
          v2ReviewReason: reason.slice(0, 240),
        },
      });
    }
    const publicError = reason.startsWith("withdrawal_quantity_unavailable:")
      ? "withdrawal_quantity_unavailable"
      : reason || "v2_initialization_failed";
    const knownStatus = [
      "withdrawal_line_not_in_order",
      "withdrawal_line_quantity_exceeded",
      "withdrawal_partial_line_mapping_required",
    ].includes(publicError)
      ? 400
      : 409;
    return { ok: false, status: knownStatus, error: publicError };
  }
}

export async function getWithdrawalV2Detail(id, prismaClient = prisma) {
  const detail = await prismaClient.withdrawalRequest.findUnique({
    where: { id: text(id) },
    include: {
      marketplaceOrder: {
        include: {
          sellerOrders: {
            include: { lines: { orderBy: { createdAt: "asc" } } },
            orderBy: { createdAt: "asc" },
          },
        },
      },
      contracts: { orderBy: { createdAt: "asc" } },
      requestedLines: { orderBy: { createdAt: "asc" } },
      withdrawalReturnGroups: {
        orderBy: { createdAt: "asc" },
        include: {
          returnAddress: true,
          lines: { include: { requestedLine: true }, orderBy: { createdAt: "asc" } },
          instructions: { orderBy: { version: "desc" } },
          shipments: {
            include: { lines: true },
            orderBy: { packageNumber: "asc" },
          },
        },
      },
      actualRefundEvents: {
        include: { allocations: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!detail) return null;
  const sellerOrders = detail.marketplaceOrder?.sellerOrders || [];
  const sellerIds = [...new Set(sellerOrders.map((order) => order.sellerId).filter(Boolean))];
  const sellers = sellerIds.length
    ? await prismaClient.seller.findMany({
        where: { id: { in: sellerIds } },
        include: { vendor: true, vendorStore: true },
      })
    : [];
  const sellerById = new Map(sellers.map((seller) => [seller.id, seller]));
  return {
    ...detail,
    availableOrderLines: sellerOrders.flatMap((sellerOrder) => {
      const seller = sellerById.get(sellerOrder.sellerId);
      return (sellerOrder.lines || []).map((line) => ({
        id: line.id,
        sellerOrderId: sellerOrder.id,
        vendorStoreId: sellerOrder.vendorStoreId,
        storeName:
          seller?.vendorStore?.storeName || seller?.vendor?.storeName || "販売店舗",
        title: line.title || "商品",
        sku: line.sku,
        quantity: Math.max(1, Number(line.quantity || 1)),
        refundedQuantity: Math.max(0, Number(line.refundedQuantity || 0)),
        availableQuantity: Math.max(
          0,
          Math.max(1, Number(line.quantity || 1)) -
            Math.max(0, Number(line.refundedQuantity || 0)),
        ),
        netAmount: Math.max(0, Number(line.netAmount || 0)),
        currencyCode: normalizeCurrency(line.currencyCode || sellerOrder.currencyCode),
      }));
    }),
  };
}

export async function createReturnInstruction({
  returnGroupId,
  operationalReturnDeadlineAt,
  notes = null,
  changedBy = "admin",
  send = false,
  request = null,
  sendEmailImpl = null,
  prismaClient = prisma,
} = {}) {
  const group = await prismaClient.withdrawalReturnGroup.findUnique({
    where: { id: text(returnGroupId) },
    include: {
      withdrawalRequest: true,
      vendorStore: { include: { vendorAuth: true } },
      returnAddress: { include: { locales: true } },
      lines: { include: { requestedLine: true } },
      instructions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!group) return { ok: false, status: 404, error: "return_group_not_found" };
  if (!['APPROVED', 'RETURN_REQUESTED'].includes(group.withdrawalRequest.status)) {
    return { ok: false, status: 409, error: "withdrawal_approval_required" };
  }
  if (!group.returnAddress || group.returnAddress.status !== "ACTIVE") {
    return { ok: false, status: 409, error: "active_return_address_required" };
  }
  if (group.mappingStatus !== "CONFIRMED" || !group.lines.length) {
    return { ok: false, status: 409, error: "line_mapping_required" };
  }
  if (group.instructionsSentAt && group.instructions[0]?.status === "SENT" && !send) {
    return { ok: false, status: 409, error: "instruction_already_sent" };
  }
  const deadline = operationalReturnDeadlineAt
    ? new Date(operationalReturnDeadlineAt)
    : addDays(new Date(), 14);
  const previous = group.instructions[0] || null;
  const instruction = await prismaClient.withdrawalReturnInstruction.create({
    data: {
      returnGroupId: group.id,
      version: Number(previous?.version || 0) + 1,
      status: "DRAFT",
      storeSnapshotJson: {
        vendorStoreId: group.vendorStoreId,
        storeName: group.storeNameSnapshot,
        sellerLegalRole: group.sellerLegalRoleSnapshot,
      },
      addressSnapshotJson: addressSnapshot(group.returnAddress),
      itemsSnapshotJson: group.lines.map(serializeRequestedLine),
      deadlineSnapshotJson: {
        statutoryReturnDeadlineAt: group.statutoryReturnDeadlineAt?.toISOString?.() || null,
        operationalReturnDeadlineAt: deadline.toISOString(),
      },
      returnCostSnapshotJson: { payer: group.returnShippingPayer },
      notesSnapshot: text(notes) || null,
      templateVersion: "direct-return-v2-1",
      sentAt: null,
      sentBy: null,
      supersedesInstructionId: previous?.status === "SENT" ? previous.id : null,
    },
  });
  if (send) {
    if (typeof sendEmailImpl !== "function") {
      return { ok: false, status: 500, error: "email_sender_required", instruction };
    }
    const issued = await issueWithdrawalGroupAccessToken({
      returnGroupId: group.id,
      purpose: "RETURN_PROOF",
      reason: "instruction_send_attempt",
      prismaClient,
    });
    const message = buildDirectReturnInstructionEmail({
      request,
      group,
      instruction,
      token: issued.token,
    });
    const emailResult = await sendEmailImpl({
      prismaClient,
      withdrawalRequest: group.withdrawalRequest,
      emailType: "direct_return_instruction",
      subject: message.subject,
      bodyText: message.text,
      bodyHtml: message.html,
      toEmail: group.withdrawalRequest.customerEmail,
      returnGroupId: group.id,
      instructionId: instruction.id,
    });
    if (!emailResult?.ok) {
      await prismaClient.withdrawalAccessToken.update({
        where: { id: issued.record.id },
        data: { revokedAt: new Date(), revokedReason: "instruction_email_failed" },
      });
      return {
        ok: false,
        status: 502,
        error: "instruction_email_failed",
        instruction,
        emailResult,
      };
    }
    const sentAt = emailResult.sentAt || new Date();
    await prismaClient.withdrawalReturnInstruction.update({
      where: { id: instruction.id },
      data: { status: "SENT", sentAt, sentBy: changedBy },
    });
    await prismaClient.withdrawalReturnGroup.update({
      where: { id: group.id },
      data: {
        instructionStatus: "SENT",
        instructionsSentAt: sentAt,
        operationalReturnDeadlineAt: deadline,
        returnAddressId: group.returnAddress.id,
        blockedReason: null,
      },
    });
    await recomputeWithdrawalV2State(group.withdrawalRequestId, prismaClient);
    const storeEmail = text(
      group.vendorStore?.vendorAuth?.managementEmail || group.vendorStore?.email,
    );
    let storeEmailResult = null;
    if (storeEmail) {
      const storeMessage = buildDirectReturnStoreNotificationEmail({
        group,
        instruction,
      });
      try {
        storeEmailResult = await sendEmailImpl({
          prismaClient,
          withdrawalRequest: group.withdrawalRequest,
          emailType: "direct_return_store_notice",
          subject: storeMessage.subject,
          bodyText: storeMessage.text,
          bodyHtml: storeMessage.html,
          toEmail: storeEmail,
          returnGroupId: group.id,
          instructionId: instruction.id,
        });
      } catch (error) {
        storeEmailResult = {
          ok: false,
          error: text(error?.message) || "store_notification_failed",
        };
      }
    }
    return {
      ok: true,
      instruction: { ...instruction, status: "SENT", sentAt, sentBy: changedBy },
      group,
      emailResult,
      storeEmailResult,
      warning: !storeEmail
        ? "store_notification_email_missing"
        : storeEmailResult && !storeEmailResult.ok
          ? "store_notification_failed"
          : null,
    };
  }
  return { ok: true, instruction, group };
}

export async function issueWithdrawalGroupAccessToken({
  returnGroupId,
  purpose = "RETURN_PROOF",
  reason = null,
  prismaClient = prisma,
} = {}) {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const token = await prismaClient.withdrawalAccessToken.create({
    data: {
      returnGroupId,
      purpose,
      tokenHash: hashToken(rawToken),
      expiresAt: addDays(new Date(), TOKEN_TTL_DAYS),
      issuedReason: reason,
    },
  });
  return { token: rawToken, record: token };
}

export async function findWithdrawalGroupByToken({
  returnGroupId,
  token,
  purpose = "RETURN_PROOF",
  prismaClient = prisma,
} = {}) {
  const tokenHash = hashToken(token);
  const accessToken = await prismaClient.withdrawalAccessToken.findFirst({
    where: {
      returnGroupId: text(returnGroupId),
      purpose,
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: {
      returnGroup: {
        include: {
          withdrawalRequest: true,
          lines: { include: { requestedLine: true } },
          shipments: { include: { lines: true }, orderBy: { packageNumber: "asc" } },
          instructions: { where: { status: "SENT" }, orderBy: { version: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!accessToken || isGroupTerminal(accessToken.returnGroup)) {
    return { ok: false, status: 404, error: "invalid_access_link" };
  }
  const now = new Date();
  await prismaClient.withdrawalAccessToken.update({
    where: { id: accessToken.id },
    data: { firstUsedAt: accessToken.firstUsedAt || now, lastUsedAt: now },
  });
  return { ok: true, accessToken, returnGroup: accessToken.returnGroup };
}

export async function submitWithdrawalGroupShipment({
  returnGroupId,
  token,
  values,
  prismaClient = prisma,
} = {}) {
  const lookup = await findWithdrawalGroupByToken({ returnGroupId, token, prismaClient });
  if (!lookup.ok) return lookup;
  const group = lookup.returnGroup;
  const trackingNumber = text(values.trackingNumber);
  const trackingUrl = text(values.trackingUrl);
  if (!trackingNumber && !trackingUrl) {
    return { ok: false, status: 400, error: "tracking_required" };
  }
  const quantities = jsonObject(values.quantities);
  const requestedByLine = new Map(group.lines.map((line) => [line.id, line]));
  const priorByLine = new Map();
  for (const shipment of group.shipments) {
    for (const line of shipment.lines) {
      priorByLine.set(
        line.returnGroupLineId,
        Number(priorByLine.get(line.returnGroupLineId) || 0) + Number(line.submittedQuantity || 0),
      );
    }
  }
  const shipmentLines = [];
  for (const [lineId, rawQuantity] of Object.entries(quantities)) {
    const groupLine = requestedByLine.get(lineId);
    const quantity = Number(rawQuantity || 0);
    if (!groupLine || !Number.isInteger(quantity) || quantity <= 0) continue;
    const available =
      Number(groupLine.instructedQuantity || 0) - Number(priorByLine.get(lineId) || 0);
    if (quantity > available) {
      return { ok: false, status: 409, error: "shipment_quantity_exceeded" };
    }
    shipmentLines.push({ groupLine, quantity });
  }
  if (!shipmentLines.length) return { ok: false, status: 400, error: "shipment_lines_required" };
  const shipment = await prismaClient.$transaction(async (tx) => {
    const packageCount = await tx.withdrawalReturnShipment.count({
      where: { returnGroupId: group.id },
    });
    const created = await tx.withdrawalReturnShipment.create({
      data: {
        returnGroupId: group.id,
        packageNumber: packageCount + 1,
        trackingCompany: text(values.trackingCompany) || null,
        trackingNumber: trackingNumber || null,
        trackingUrl: trackingUrl || null,
        customerMemo: text(values.customerMemo) || null,
        proofJson: jsonObject(values.proofJson),
        submittedAt: new Date(),
      },
    });
    for (const item of shipmentLines) {
      await tx.withdrawalReturnShipmentLine.create({
        data: {
          shipmentId: created.id,
          returnGroupLineId: item.groupLine.id,
          submittedQuantity: item.quantity,
        },
      });
      await tx.withdrawalReturnGroupLine.update({
        where: { id: item.groupLine.id },
        data: { submittedQuantity: { increment: item.quantity } },
      });
    }
    await tx.withdrawalReturnGroup.update({
      where: { id: group.id },
      data: { evidenceStatus: "SUBMITTED" },
    });
    return created;
  });
  await recomputeWithdrawalV2State(group.withdrawalRequestId, prismaClient);
  return { ok: true, shipment };
}

export async function updateWithdrawalGroupReview({
  returnGroupId,
  values,
  changedBy = "admin",
  vendorStoreId = null,
  allowFinancialDecision = true,
  prismaClient = prisma,
} = {}) {
  const group = await prismaClient.withdrawalReturnGroup.findFirst({
    where: {
      id: text(returnGroupId),
      ...(vendorStoreId ? { vendorStoreId: text(vendorStoreId) } : {}),
    },
    include: { lines: true },
  });
  if (!group) return { ok: false, status: 404, error: "return_group_not_found" };
  const allowed = {
    evidenceStatus: new Set(["NOT_SUBMITTED", "SUBMITTED", "ACCEPTED", "REJECTED"]),
    receiptStatus: new Set(["NOT_RECEIVED", "PARTIALLY_RECEIVED", "RECEIVED"]),
    inspectionStatus: new Set(["NOT_INSPECTED", "IN_PROGRESS", "INSPECTED", "VALUE_REDUCTION_REVIEW"]),
    ...(allowFinancialDecision
      ? {
          refundDecisionStatus: new Set(["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"]),
          outcomeStatus: new Set(["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND", "CANCELLED"]),
        }
      : {}),
  };
  const data = {};
  for (const [key, options] of Object.entries(allowed)) {
    const value = text(values[key]).toUpperCase();
    if (value && options.has(value)) data[key] = value;
  }
  if (allowFinancialDecision) {
    const itemRefundBaseAmount = Math.max(
      0,
      Number(values.itemRefundBaseAmount ?? group.itemRefundBaseAmount),
    );
    const deductionAmount = Math.max(
      0,
      Number(values.deductionAmount ?? group.deductionAmount),
    );
    if (deductionAmount > 0 && !text(values.deductionReason)) {
      return { ok: false, status: 400, error: "deduction_reason_required" };
    }
    data.itemRefundBaseAmount = itemRefundBaseAmount;
    data.deductionAmount = deductionAmount;
    data.itemRefundNetAmount = Math.max(0, itemRefundBaseAmount - deductionAmount);
    data.plannedRefundAmount = data.itemRefundNetAmount;
  }
  data.metadataJson = {
    ...jsonObject(group.metadataJson),
    deductionReason: text(values.deductionReason) || null,
    reviewNotes: text(values.reviewNotes) || null,
    reviewedBy: changedBy,
    reviewedAt: new Date().toISOString(),
  };
  if (TERMINAL_OUTCOMES.has(data.outcomeStatus)) data.completedAt = new Date();
  const lineReviews = Array.isArray(values.lineReviews) ? values.lineReviews : [];
  await prismaClient.$transaction(async (tx) => {
    await tx.withdrawalReturnGroup.update({ where: { id: group.id }, data });
    for (const review of lineReviews) {
      const line = group.lines.find((item) => item.id === text(review.id));
      if (!line) continue;
      const receivedQuantity = Math.max(
        0,
        Math.min(Number(line.instructedQuantity || 0), Number(review.receivedQuantity || 0)),
      );
      const missingQuantity = Math.max(
        0,
        Number(line.instructedQuantity || 0) - receivedQuantity,
      );
      const conditionStatus = text(review.conditionStatus).toUpperCase();
      const allowedConditions = new Set([
        "UNDECIDED",
        "UNUSED_OK",
        "OPENED_OK",
        "USED_REVIEW",
        "DIRTY_REVIEW",
        "DAMAGED_REVIEW",
        "EXEMPT_REVIEW",
      ]);
      await tx.withdrawalReturnGroupLine.update({
        where: { id: line.id },
        data: {
          receivedQuantity,
          missingQuantity,
          ...(allowedConditions.has(conditionStatus) ? { conditionStatus } : {}),
          conditionNotes: text(review.conditionNotes) || null,
        },
      });
    }
  });
  await recomputeWithdrawalV2State(group.withdrawalRequestId, prismaClient);
  return { ok: true };
}

export async function updateWithdrawalContractShippingDecision({
  withdrawalContractId,
  status,
  amount,
  reason = null,
  changedBy = "admin",
  prismaClient = prisma,
} = {}) {
  const contract = await prismaClient.withdrawalContract.findUnique({
    where: { id: text(withdrawalContractId) },
  });
  if (!contract) return { ok: false, status: 404, error: "withdrawal_contract_not_found" };
  const normalizedStatus = text(status).toUpperCase();
  if (!["UNDECIDED", "REFUND_STANDARD", "NOT_REFUNDABLE", "ALREADY_ALLOCATED"].includes(normalizedStatus)) {
    return { ok: false, status: 400, error: "invalid_shipping_refund_status" };
  }
  const shippingAmount = Math.max(0, Math.trunc(Number(amount || 0)));
  await prismaClient.withdrawalContract.update({
    where: { id: contract.id },
    data: {
      initialShippingRefundStatus: normalizedStatus,
      initialShippingRefundAmount: shippingAmount,
      initialShippingRefundReason: text(reason) || null,
      metadataJson: {
        ...jsonObject(contract.metadataJson),
        shippingDecisionBy: changedBy,
        shippingDecisionAt: new Date().toISOString(),
      },
    },
  });
  await recomputeWithdrawalV2State(contract.withdrawalRequestId, prismaClient);
  return { ok: true };
}

export async function releaseWithdrawalLineReservations({
  withdrawalRequestId,
  requestedLineIds = null,
  prismaClient = prisma,
} = {}) {
  const where = {
    withdrawalRequestId,
    ...(Array.isArray(requestedLineIds) && requestedLineIds.length
      ? { id: { in: requestedLineIds } }
      : {}),
  };
  const lines = await prismaClient.withdrawalRequestedLine.findMany({ where });
  await prismaClient.$transaction(
    lines.map((line) =>
      prismaClient.withdrawalRequestedLine.update({
        where: { id: line.id },
        data: { releasedQuantity: Math.max(line.releasedQuantity, line.reservedQuantity - line.approvedQuantity) },
      }),
    ),
  );
  return { ok: true, releasedLineCount: lines.length };
}

export async function recordWithdrawalActualRefundEvent({
  withdrawalRequestId,
  shopDomain,
  shopifyRefundId,
  shopifyOrderId = null,
  itemAmount = 0,
  initialShippingAmount = 0,
  otherAmount = 0,
  currencyCode = "JPY",
  allocations = [],
  metadataJson = null,
  prismaClient = prisma,
} = {}) {
  if (!withdrawalRequestId || !shopDomain || !shopifyRefundId) {
    return { ok: false, status: 400, error: "refund_event_identity_required" };
  }
  const event = await prismaClient.withdrawalActualRefundEvent.upsert({
    where: {
      withdrawalRequestId_shopDomain_shopifyRefundId: {
        withdrawalRequestId,
        shopDomain,
        shopifyRefundId,
      },
    },
    create: {
      withdrawalRequestId,
      shopDomain,
      shopifyRefundId,
      shopifyOrderId,
      itemAmount,
      initialShippingAmount,
      otherAmount,
      currencyCode: normalizeCurrency(currencyCode),
      webhookReceivedAt: new Date(),
      metadataJson,
      allocations: {
        create: allocations.map((allocation) => ({
          withdrawalContractId: allocation.withdrawalContractId || null,
          requestedLineId: allocation.requestedLineId || null,
          shopifyLineItemId: allocation.shopifyLineItemId || null,
          quantity: Number(allocation.quantity || 0),
          itemAmount: Number(allocation.itemAmount || 0),
          initialShippingAmount: Number(allocation.initialShippingAmount || 0),
        })),
      },
    },
    update: {
      itemAmount,
      initialShippingAmount,
      otherAmount,
      currencyCode: normalizeCurrency(currencyCode),
      webhookReceivedAt: new Date(),
      metadataJson,
    },
  });
  return { ok: true, event };
}

function normalizeShopifyGid(type, value) {
  const normalized = text(value);
  if (!normalized) return "";
  return normalized.startsWith("gid://shopify/")
    ? normalized
    : `gid://shopify/${type}/${normalized}`;
}

function shopifyIdMatches(stored, incoming) {
  const left = text(stored);
  const right = text(incoming);
  if (!left || !right) return false;
  return left === right || left.split("/").pop() === right.split("/").pop();
}

function moneyInteger(value, currencyCode) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(
    0,
    Math.round(numeric * (normalizeCurrency(currencyCode) === "JPY" ? 1 : 100)),
  );
}

function cumulativeRefundedQuantity(purchasedQuantity, previousQuantity, eventQuantity) {
  const purchased = Math.max(0, Math.trunc(Number(purchasedQuantity || 0)));
  const previous = Math.max(0, Math.trunc(Number(previousQuantity || 0)));
  const currentEvent = Math.max(0, Math.trunc(Number(eventQuantity || 0)));
  return Math.min(purchased || previous + currentEvent, previous + currentEvent);
}

async function recomputeRefundReconciliation(withdrawalRequestId, prismaClient) {
  const groups = await prismaClient.withdrawalReturnGroup.findMany({
    where: { withdrawalRequestId },
    include: {
      lines: {
        include: {
          requestedLine: {
            include: { actualRefundAllocations: true },
          },
        },
      },
    },
  });
  for (const group of groups) {
    const actual = group.lines.reduce(
      (sum, line) =>
        sum +
        line.requestedLine.actualRefundAllocations.reduce(
          (lineSum, allocation) => lineSum + Number(allocation.itemAmount || 0),
          0,
        ),
      0,
    );
    const planned = Math.max(0, Number(group.plannedRefundAmount || 0));
    const status =
      actual <= 0
        ? "NOT_RECONCILED"
        : planned > 0 && actual >= planned
          ? "RECONCILED"
          : "PARTIALLY_RECONCILED";
    await prismaClient.withdrawalReturnGroup.update({
      where: { id: group.id },
      data: { refundReconciliationStatus: status },
    });
  }
  await recomputeWithdrawalV2State(withdrawalRequestId, prismaClient);
}

/* Replaced with quantity-aware allocation below.
export async function reconcileWithdrawalRefundWebhook({
  payload,
  shop,
  prismaClient = prisma,
} = {}) {
  const shopDomain = text(shop || payload?.shop_domain || payload?.shop).toLowerCase();
  const shopifyRefundId = normalizeShopifyGid("Refund", payload?.id);
  const shopifyOrderId = normalizeShopifyGid("Order", payload?.order_id);
  if (!shopDomain || !shopifyRefundId || !shopifyOrderId) {
    return { ok: false, reason: "refund_identity_missing" };
  }
  const existing = await prismaClient.withdrawalActualRefundEvent.findUnique({
    where: { shopDomain_shopifyRefundId: { shopDomain, shopifyRefundId } },
  });
  if (existing) return { ok: true, duplicate: true, event: existing };

  const requests = await prismaClient.withdrawalRequest.findMany({
    where: { shopDomain, shopifyOrderId, workflowVersion: 2 },
    include: {
      requestedLines: { include: { orderLinePosition: true } },
    },
  });
  if (!requests.length) return { ok: true, skipped: true, reason: "no_v2_withdrawal" };

  const refundLines = Array.isArray(payload?.refund_line_items)
    ? payload.refund_line_items
    : [];
  const currencyCode = normalizeCurrency(
    payload?.currency || payload?.order?.currency || requests[0]?.refundCurrencyCode,
  );
  const results = [];
  for (const request of requests) {
    const allocations = [];
    let itemAmount = 0;
    for (const refundLine of refundLines) {
      const lineItemId = refundLine?.line_item_id || refundLine?.line_item?.id;
      const requestedLine = request.requestedLines.find((line) =>
        shopifyIdMatches(line.shopifyLineItemId, lineItemId),
      );
      if (!requestedLine) continue;
      const quantity = Math.max(0, Math.trunc(Number(refundLine?.quantity || 0)));
      const amount = moneyInteger(
        refundLine?.subtotal ?? refundLine?.line_item?.price * quantity,
        currencyCode,
      );
      itemAmount += amount;
      allocations.push({
        withdrawalContractId: requestedLine.withdrawalContractId,
        requestedLineId: requestedLine.id,
        shopifyLineItemId: requestedLine.shopifyLineItemId,
        quantity,
        itemAmount: amount,
        initialShippingAmount: 0,
      });
    }
    const initialShippingAmount = (Array.isArray(payload?.order_adjustments)
      ? payload.order_adjustments
      : []
    )
      .filter((adjustment) =>
        ["shipping_refund", "shipping"].includes(
          text(adjustment?.kind).toLowerCase(),
        ),
      )
      .reduce(
        (sum, adjustment) =>
          sum + moneyInteger(Math.abs(Number(adjustment?.amount || 0)), currencyCode),
        0,
      );
    const recorded = await recordWithdrawalActualRefundEvent({
      withdrawalRequestId: request.id,
      shopDomain,
      shopifyRefundId,
      shopifyOrderId,
      itemAmount,
      initialShippingAmount,
      currencyCode,
      allocations,
      metadataJson: {
        source: "refunds_create_webhook",
        refundLineCount: refundLines.length,
      },
      prismaClient,
    });
    if (recorded.ok) {
      for (const allocation of allocations) {
        const requestedLine = request.requestedLines.find(
          (line) => line.id === allocation.requestedLineId,
        );
        if (!requestedLine) continue;
        await prismaClient.withdrawalOrderLinePosition.update({
          where: { id: requestedLine.orderLinePositionId },
          data: { refundedQuantity: { increment: allocation.quantity } },
        });
      }
      await recomputeRefundReconciliation(request.id, prismaClient);
    }
    results.push(recorded);
  }
  return { ok: true, duplicate: false, results };
}

*/

export async function reconcileWithdrawalRefundWebhook({
  payload,
  shop,
  prismaClient = prisma,
} = {}) {
  const shopDomain = text(shop || payload?.shop_domain || payload?.shop).toLowerCase();
  const shopifyRefundId = normalizeShopifyGid("Refund", payload?.id);
  const shopifyOrderId = normalizeShopifyGid("Order", payload?.order_id);
  if (!shopDomain || !shopifyRefundId || !shopifyOrderId) {
    return { ok: false, reason: "refund_identity_missing" };
  }

  const requests = await prismaClient.withdrawalRequest.findMany({
    where: { shopDomain, shopifyOrderId, workflowVersion: 2 },
    orderBy: { createdAt: "asc" },
    include: {
      contracts: true,
      actualRefundEvents: true,
      requestedLines: {
        include: {
          orderLinePosition: true,
          actualRefundAllocations: true,
        },
      },
    },
  });
  if (!requests.length) return { ok: true, skipped: true, reason: "no_v2_withdrawal" };

  const alreadyRecorded = await prismaClient.withdrawalActualRefundEvent.findMany({
    where: {
      withdrawalRequestId: { in: requests.map((request) => request.id) },
      shopDomain,
      shopifyRefundId,
    },
  });
  const recordedRequestIds = new Set(
    alreadyRecorded.map((event) => event.withdrawalRequestId),
  );
  if (recordedRequestIds.size === requests.length) {
    return { ok: true, duplicate: true, events: alreadyRecorded };
  }

  const refundLines = Array.isArray(payload?.refund_line_items)
    ? payload.refund_line_items
    : [];
  const currencyCode = normalizeCurrency(
    payload?.currency || payload?.order?.currency || requests[0]?.refundCurrencyCode,
  );
  const allocationsByRequest = new Map(requests.map((request) => [request.id, []]));
  const positionUpdates = new Map();

  for (const refundLine of refundLines) {
    const incomingLineId = refundLine?.line_item_id || refundLine?.line_item?.id;
    let remainingQuantity = Math.max(0, Math.trunc(Number(refundLine?.quantity || 0)));
    const totalAmount = moneyInteger(
      refundLine?.subtotal ?? refundLine?.line_item?.price * remainingQuantity,
      currencyCode,
    );
    const candidates = requests.flatMap((request) =>
      request.requestedLines
        .filter((line) => shopifyIdMatches(line.shopifyLineItemId, incomingLineId))
        .map((line) => ({ request, line })),
    );
    let allocatedAmount = 0;
    candidates.forEach(({ request, line }, index) => {
      if (remainingQuantity <= 0) return;
      const previouslyAllocated = line.actualRefundAllocations.reduce(
        (sum, allocation) => sum + Number(allocation.quantity || 0),
        0,
      );
      const available = Math.max(
        0,
        Number(line.reservedQuantity || 0) -
          Number(line.releasedQuantity || 0) -
          previouslyAllocated,
      );
      const quantity = Math.min(remainingQuantity, available);
      if (!quantity) return;
      const isLast = index === candidates.length - 1 || quantity === remainingQuantity;
      const amount = isLast
        ? Math.max(0, totalAmount - allocatedAmount)
        : Math.floor((totalAmount * quantity) / Math.max(1, Number(refundLine?.quantity || 0)));
      allocatedAmount += amount;
      remainingQuantity -= quantity;
      allocationsByRequest.get(request.id).push({
        withdrawalContractId: line.withdrawalContractId,
        requestedLineId: line.id,
        shopifyLineItemId: line.shopifyLineItemId,
        quantity,
        itemAmount: amount,
        initialShippingAmount: 0,
      });
      positionUpdates.set(
        line.orderLinePositionId,
        Math.max(
          positionUpdates.get(line.orderLinePositionId) || 0,
          Math.max(0, Math.trunc(Number(refundLine?.quantity || 0))),
        ),
      );
    });
  }

  const shippingTotal = (Array.isArray(payload?.order_adjustments)
    ? payload.order_adjustments
    : []
  )
    .filter((adjustment) =>
      ["shipping_refund", "shipping"].includes(text(adjustment?.kind).toLowerCase()),
    )
    .reduce(
      (sum, adjustment) =>
        sum + moneyInteger(Math.abs(Number(adjustment?.amount || 0)), currencyCode),
      0,
    );
  const recordedShippingTotal = alreadyRecorded.reduce(
    (sum, event) => sum + Math.max(0, Number(event.initialShippingAmount || 0)),
    0,
  );
  const remainingShippingTotal = Math.max(0, shippingTotal - recordedShippingTotal);
  const unrecordedRequests = requests.filter(
    (request) => !recordedRequestIds.has(request.id),
  );
  const shippingTargetRequest = remainingShippingTotal > 0
    ? selectShippingRefundTargetRequest(unrecordedRequests, allocationsByRequest)
    : null;
  const results = [];
  for (const request of unrecordedRequests) {
    const allocations = allocationsByRequest.get(request.id) || [];
    if (!allocations.length && request.id !== shippingTargetRequest?.id) continue;
    const initialShippingAmount =
      request.id === shippingTargetRequest?.id ? remainingShippingTotal : 0;
    const itemAmount = allocations.reduce(
      (sum, allocation) => sum + allocation.itemAmount,
      0,
    );
    const recorded = await recordWithdrawalActualRefundEvent({
      withdrawalRequestId: request.id,
      shopDomain,
      shopifyRefundId,
      shopifyOrderId,
      itemAmount,
      initialShippingAmount,
      currencyCode,
      allocations,
      metadataJson: {
        source: "refunds_create_webhook",
        refundLineCount: refundLines.length,
        unallocatedLineQuantityExists: refundLines.some((refundLine) => {
          const incoming = refundLine?.line_item_id || refundLine?.line_item?.id;
          return !request.requestedLines.some((line) => shopifyIdMatches(line.shopifyLineItemId, incoming));
        }),
      },
      prismaClient,
    });
    if (recorded.ok) await recomputeRefundReconciliation(request.id, prismaClient);
    results.push(recorded);
  }

  for (const [positionId, refundedQuantity] of positionUpdates) {
    const position = requests
      .flatMap((request) => request.requestedLines)
      .find((line) => line.orderLinePositionId === positionId)?.orderLinePosition;
    if (!position) continue;
    await prismaClient.withdrawalOrderLinePosition.update({
      where: { id: positionId },
      data: {
        refundedQuantity: cumulativeRefundedQuantity(
          position.purchasedQuantity,
          position.refundedQuantity,
          refundedQuantity,
        ),
      },
    });
  }
  return { ok: true, duplicate: results.length === 0 && alreadyRecorded.length > 0, results };
}

export async function reconcileWithdrawalCancellationWebhook({
  payload,
  shop,
  prismaClient = prisma,
} = {}) {
  const shopDomain = text(shop || payload?.shop_domain || payload?.shop).toLowerCase();
  const shopifyOrderId = normalizeShopifyGid("Order", payload?.id || payload?.order_id);
  if (!shopDomain || !shopifyOrderId) {
    return { ok: false, reason: "cancellation_identity_missing" };
  }
  const requests = await prismaClient.withdrawalRequest.findMany({
    where: { shopDomain, shopifyOrderId, workflowVersion: 2 },
    include: {
      requestedLines: {
        include: { orderLinePosition: true },
      },
    },
  });
  for (const request of requests) {
    await prismaClient.$transaction(async (tx) => {
      for (const line of request.requestedLines) {
        await tx.withdrawalOrderLinePosition.update({
          where: { id: line.orderLinePositionId },
          data: {
            cancelledQuantity: Math.min(
              Number(line.orderLinePosition.purchasedQuantity || line.reservedQuantity),
              Math.max(
                Number(line.orderLinePosition.cancelledQuantity || 0),
                Number(line.reservedQuantity || 0),
              ),
            ),
          },
        });
      }
      await tx.withdrawalReturnGroup.updateMany({
        where: { withdrawalRequestId: request.id, instructionsSentAt: null },
        data: {
          progressStatus: "COMPLETED",
          outcomeStatus: "CANCELLED",
          completedAt: new Date(),
        },
      });
    });
    await recomputeWithdrawalV2State(request.id, prismaClient);
  }
  return { ok: true, requestCount: requests.length };
}

export function returnAddressFromFormData(formData) {
  const consolidatedConfirmation = formData.get("returnAddressConfirmed") === "on";
  return {
    recipientName: formData.get("recipientName"),
    postalCode: formData.get("postalCode"),
    countryCode: formData.get("countryCode"),
    countryLabel: formData.get("countryLabel"),
    region: formData.get("region"),
    city: formData.get("city"),
    address1: formData.get("address1"),
    address2: formData.get("address2"),
    phone: formData.get("phone"),
    instructions: formData.get("instructions"),
    internationalRecipientName: formData.get("internationalRecipientName"),
    internationalAddressLines: formData.get("internationalAddressLines"),
    phoneE164: formData.get("phoneE164"),
    instructionsEn: formData.get("instructionsEn"),
    canReceiveReturnsConfirmed:
      consolidatedConfirmation || formData.get("canReceiveReturnsConfirmed") === "on",
    buyerDisclosureConfirmed:
      consolidatedConfirmation || formData.get("buyerDisclosureConfirmed") === "on",
    legalRecipientConfirmed:
      consolidatedConfirmation || formData.get("legalRecipientConfirmed") === "on",
  };
}

function normalizeInternationalAddressLines(value) {
  const lines = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const normalized = lines.map((line) => text(line)).filter(Boolean).slice(0, 8);
  return normalized.length > 0 ? normalized : null;
}

export function getReturnProofPublicUrl({ request, groupId, token, locale = null }) {
  const configured = text(process.env.WITHDRAWAL_PUBLIC_BASE_URL);
  const origin = configured || (request ? new URL(request.url).origin : "");
  const url = new URL("/apps/vendors/withdrawal/return-proof", origin);
  url.searchParams.set("group", groupId);
  url.searchParams.set("token", token);
  if (locale) url.searchParams.set("lang", locale);
  return url.toString();
}

function buildDirectReturnInstructionEmailLegacy({ request, group, instruction, token }) {
  const address = jsonObject(instruction.addressSnapshotJson);
  const items = jsonArray(instruction.itemsSnapshotJson);
  const deadline = jsonObject(instruction.deadlineSnapshotJson);
  const proofUrl = getReturnProofPublicUrl({ request, groupId: group.id, token });
  const addressLines = [
    address.recipientName,
    address.postalCode,
    [address.countryLabel || address.countryCode, address.region, address.city].filter(Boolean).join(" "),
    address.address1,
    address.address2,
  ].filter(Boolean);
  const itemLines = items.map((item) => `- ${item.title} x ${item.quantity}`);
  const lines = [
    `${group.withdrawalRequest.customerName} 様`,
    "",
    `${group.storeNameSnapshot} への返送方法をご案内します。`,
    "複数店舗の商品がある場合は、店舗ごとに別の荷物で返送してください。",
    "",
    "返送する商品",
    ...itemLines,
    "",
    "返送先",
    ...addressLines,
    address.instructions ? `注意事項: ${address.instructions}` : "",
    `返送期限: ${deadline.operationalReturnDeadlineAt || "管理者案内を確認してください"}`,
    "返送送料: お客様負担（当店が別途負担すると案内した場合または法令上必要な場合を除く）",
    "",
    `返送証明の提出: ${proofUrl}`,
  ].filter((line) => line !== "");
  const textBody = lines.join("\n");
  return {
    subject: `【${group.storeNameSnapshot}】返送方法のご案内`,
    text: textBody,
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
    proofUrl,
  };
}

export function buildDirectReturnInstructionEmail({ request, group, instruction, token }) {
  const address = jsonObject(instruction.addressSnapshotJson);
  const items = jsonArray(instruction.itemsSnapshotJson);
  const deadline = jsonObject(instruction.deadlineSnapshotJson);
  const locale = group.withdrawalRequest.correspondenceLocale === "en-GB" ? "en-GB" : "ja-JP";
  const proofUrl = getReturnProofPublicUrl({ request, groupId: group.id, token, locale });
  const localized = jsonObject(address.localizedInstructions)[locale] || {};
  const internationalLines = jsonArray(address.internationalAddressLines);
  const addressLines = locale === "en-GB" && internationalLines.length > 0
    ? [address.internationalRecipientName || localized.recipientDisplayName, ...internationalLines]
        .filter(Boolean)
    : [
        address.recipientName,
        address.postalCode,
        [address.countryLabel || address.countryCode, address.region, address.city]
          .filter(Boolean)
          .join(" "),
        address.address1,
        address.address2,
      ].filter(Boolean);
  if (locale === "en-GB") {
    const lines = [
      `Dear ${group.withdrawalRequest.customerName || "customer"},`,
      "",
      `Return instructions for ${group.storeNameSnapshot || "the selling store"}.`,
      "If goods from more than one store are being returned, send a separate parcel to each store.",
      "",
      "Goods to return",
      ...items.map((item) => `- ${item.title || "Item"} x ${Number(item.quantity || 0)}`),
      "",
      "Return address",
      ...addressLines,
      address.phoneE164 ? `Telephone: ${address.phoneE164}` : "",
      localized.returnInstructions ? `Instructions: ${localized.returnInstructions}` : "",
      `Return by: ${deadline.operationalReturnDeadlineAt || "See the administrator's instructions"}`,
      group.returnShippingPayer === "SELLER"
        ? "The selling store will bear the direct return cost. Follow the method provided."
        : "You may have to bear the direct return cost unless the selling store agrees otherwise or applicable law requires the store to bear it.",
      "Where the withdrawal is accepted, the price and the least expensive standard outbound delivery cost are assessed for reimbursement. Extra delivery costs may be excluded.",
      "",
      `Submit the tracking number or tracking URL for this store here: ${proofUrl}`,
    ].filter((line) => line !== "");
    return {
      subject: `[${group.storeNameSnapshot || "Selling store"}] Return instructions`,
      text: lines.join("\n"),
      html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
      proofUrl,
    };
  }
  const returnShippingMessage =
    group.returnShippingPayer === "SELLER"
      ? "返送送料は販売店舗が負担します。案内された返送方法に従ってください。"
      : "返送送料は、販売店舗が別途負担すると案内した場合または法令上必要な場合を除き、お客様負担となる場合があります。";
  const lines = [
    `${group.withdrawalRequest.customerName || "お客様"} 様`,
    "",
    `${group.storeNameSnapshot || "販売店舗"}への返送方法をご案内します。`,
    "複数店舗の商品を撤回する場合は、店舗ごとに別の荷物で返送してください。",
    "",
    "返送する商品",
    ...items.map(
      (item) => `- ${item.title || "商品"} x ${Number(item.quantity || 0)}`,
    ),
    "",
    "返送先",
    ...addressLines,
    address.phone ? `電話番号: ${address.phone}` : "",
    address.instructions ? `注意事項: ${address.instructions}` : "",
    `返送期限: ${deadline.operationalReturnDeadlineAt || "管理者からの案内をご確認ください"}`,
    returnShippingMessage,
    "撤回が認められる場合、商品代金と通常配送方法に相当する初回送料を返金対象として確認します。通常配送より高い配送方法の追加費用は返金対象外となる場合があります。",
    "",
    `返送後、店舗ごとの追跡番号または追跡URLをこちらから提出してください: ${proofUrl}`,
  ].filter((line) => line !== "");
  const textBody = lines.join("\n");
  return {
    subject: `【${group.storeNameSnapshot || "販売店舗"}】返送方法のご案内`,
    text: textBody,
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
    proofUrl,
  };
}

export function buildDirectReturnStoreNotificationEmail({ group, instruction }) {
  const items = jsonArray(instruction.itemsSnapshotJson);
  const deadline = jsonObject(instruction.deadlineSnapshotJson);
  const orderReference =
    group.withdrawalRequest.shopifyOrderName ||
    group.withdrawalRequest.shopifyOrderNumber ||
    group.withdrawalRequest.id;
  const lines = [
    `${group.storeNameSnapshot || "販売店舗"} ご担当者様`,
    "",
    "購入者へ返送方法を案内しました。返送品の受領準備をお願いします。",
    `注文: ${orderReference}`,
    `撤回申請ID: ${group.withdrawalRequest.id}`,
    "",
    "返送予定の商品",
    ...items.map(
      (item) => `- ${item.title || "商品"} x ${Number(item.quantity || 0)}`,
    ),
    "",
    `返送期限: ${deadline.operationalReturnDeadlineAt || "管理画面をご確認ください"}`,
    "到着後、店舗管理画面で受領数量と商品状態を記録してください。返金判断は運営が行います。",
  ];
  const textBody = lines.join("\n");
  return {
    subject: `【返品予定】${orderReference} の返送案内を送信しました`,
    text: textBody,
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const __testables = {
  allocateIntegerByWeight,
  addressSnapshot,
  contractKeyForSellerOrder,
  cumulativeRefundedQuantity,
  deriveReturnGroupState,
  deriveWithdrawalAggregate,
  getOutstandingInitialShippingAmount,
  hashToken,
  getSelectedLineSelection,
  lineMatchesSelection,
  mapOrderLine,
  normalizePartialLineSelections,
  normalizeReturnAddressInput,
  selectShippingRefundTargetRequest,
};
