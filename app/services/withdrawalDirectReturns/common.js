import crypto from "node:crypto";
import prisma from "../../db.server.js";
import { formatPublicCountryLabel } from "../../utils/deliveryEligibility.js";
export const WITHDRAWAL_CONTRACT_MODES = Object.freeze({
  PLATFORM_SINGLE_CONTRACT: "PLATFORM_SINGLE_CONTRACT",
  SELLER_SEPARATE_CONTRACTS: "SELLER_SEPARATE_CONTRACTS",
  MIXED_BY_SELLER_ROLE: "MIXED_BY_SELLER_ROLE"
});
export const TERMINAL_OUTCOMES = new Set(["FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND", "CANCELLED", "MIXED"]);
export const MAX_TRANSACTION_RETRIES = 4;
export function text(value) {
  return String(value ?? "").trim();
}
export function normalizeCurrency(value) {
  return text(value || "JPY").toUpperCase();
}
export function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}
export function addDays(value, days) {
  const date = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date;
}
export function allocateIntegerByWeight(total, entries) {
  const amount = Math.max(0, Math.trunc(Number(total || 0)));
  const normalized = entries.map((entry, index) => ({
    ...entry,
    index,
    weight: Math.max(0, Number(entry.weight || 0))
  }));
  const weightTotal = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  if (!amount || !weightTotal) {
    return new Map(normalized.map(entry => [entry.key, 0]));
  }
  const allocated = normalized.map(entry => {
    const exact = amount * entry.weight / weightTotal;
    return {
      ...entry,
      value: Math.floor(exact),
      remainder: exact - Math.floor(exact)
    };
  });
  let remaining = amount - allocated.reduce((sum, entry) => sum + entry.value, 0);
  allocated.sort((left, right) => right.remainder - left.remainder || left.index - right.index).forEach(entry => {
    if (remaining > 0) {
      entry.value += 1;
      remaining -= 1;
    }
  });
  return new Map(allocated.map(entry => [entry.key, entry.value]));
}
export function getOutstandingInitialShippingAmount(request) {
  const planned = jsonArray(request?.contracts).reduce((sum, contract) => {
    const status = text(contract?.initialShippingRefundStatus).toUpperCase();
    if (["NOT_APPLICABLE", "NOT_REFUNDABLE"].includes(status)) return sum;
    return sum + Math.max(0, Number(contract?.initialShippingRefundAmount || 0));
  }, 0);
  const actual = jsonArray(request?.actualRefundEvents).reduce((sum, event) => sum + Math.max(0, Number(event?.initialShippingAmount || 0)), 0);
  return Math.max(0, planned - actual);
}
export function selectShippingRefundTargetRequest(requests, allocationsByRequest) {
  const ordered = Array.isArray(requests) ? requests : [];
  return ordered.find(request => (allocationsByRequest.get(request.id) || []).length > 0 && getOutstandingInitialShippingAmount(request) > 0) || ordered.find(request => getOutstandingInitialShippingAmount(request) > 0) || ordered[0] || null;
}
export function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}
export function getSelectedLineSelection(request) {
  const selected = jsonObject(request?.selectedLineItemsJson);
  const submitted = jsonObject(request?.submittedPayloadJson);
  const values = new Set([...jsonArray(selected.selectedLineItems), ...jsonArray(submitted.selectedLineItems)].map(text).filter(Boolean));
  const quantities = new Map();
  for (const source of [jsonObject(selected.selectedLineQuantities), jsonObject(submitted.selectedLineQuantities)]) {
    for (const [key, value] of Object.entries(source)) {
      const id = text(key);
      const quantity = Number(value);
      if (id && Number.isInteger(quantity) && quantity > 0) {
        values.add(id);
        quantities.set(id, quantity);
      }
    }
  }
  return {
    values,
    quantities
  };
}
export function lineMatchesSelection(line, selectedValues) {
  if (selectedValues.size === 0) return false;
  return [line.id, line.shopifyLineItemId, line.shopifyProductId, line.shopifyVariantId, line.productId, line.title, line.sku].map(text).filter(Boolean).some(candidate => selectedValues.has(candidate));
}
export function getSelectedQuantity(line, selection, purchasedQuantity) {
  const candidates = [line.id, line.shopifyLineItemId, line.shopifyProductId, line.shopifyVariantId, line.productId, line.title, line.sku].map(text).filter(Boolean);
  for (const candidate of candidates) {
    if (selection.quantities.has(candidate)) {
      return Math.min(purchasedQuantity, selection.quantities.get(candidate));
    }
  }
  return purchasedQuantity;
}
export function normalizePartialLineSelections(lineSelections) {
  const selections = new Map();
  for (const entry of Array.isArray(lineSelections) ? lineSelections : []) {
    const sellerOrderLineId = text(entry?.sellerOrderLineId || entry?.id);
    const quantity = Number(entry?.quantity);
    if (!sellerOrderLineId || !Number.isInteger(quantity) || quantity <= 0) continue;
    selections.set(sellerOrderLineId, quantity);
  }
  return selections;
}
export function isSellerContractParty(seller, mode) {
  if (mode === WITHDRAWAL_CONTRACT_MODES.SELLER_SEPARATE_CONTRACTS) return true;
  if (mode === WITHDRAWAL_CONTRACT_MODES.PLATFORM_SINGLE_CONTRACT) return false;
  return text(seller?.sellerLegalRole).toUpperCase() === "MARKETPLACE_SELLER";
}
export function contractKeyForSellerOrder(sellerOrder, seller, mode) {
  return isSellerContractParty(seller, mode) ? `seller:${seller?.id || sellerOrder.sellerId}` : "platform";
}
export function addressSnapshot(address) {
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
    localizedInstructions: Object.fromEntries((Array.isArray(address.locales) ? address.locales : []).map(entry => [entry.locale, {
      recipientDisplayName: entry.recipientDisplayName,
      returnInstructions: entry.returnInstructions
    }])),
    confirmedAt: address.confirmedAt?.toISOString?.() || null
  };
}
export function isGroupTerminal(group) {
  return TERMINAL_OUTCOMES.has(text(group.outcomeStatus).toUpperCase());
}
export function deriveReturnGroupState(group) {
  if (isGroupTerminal(group)) {
    return {
      progressStatus: "COMPLETED",
      outcomeStatus: group.outcomeStatus
    };
  }
  if (group.blockedReason || group.mappingStatus !== "CONFIRMED") {
    return {
      progressStatus: "REVIEW_REQUIRED",
      outcomeStatus: "UNDECIDED"
    };
  }
  if (group.routingStatus === "READY" && ["NOT_READY", "READY", "DRAFT"].includes(group.instructionStatus)) {
    return {
      progressStatus: "READY_FOR_INSTRUCTIONS",
      outcomeStatus: "UNDECIDED"
    };
  }
  if (group.instructionStatus === "SENT" || group.evidenceStatus !== "NOT_SUBMITTED" || group.receiptStatus !== "NOT_RECEIVED" || group.inspectionStatus !== "NOT_INSPECTED" || group.refundDecisionStatus !== "UNDECIDED") {
    return {
      progressStatus: "IN_PROGRESS",
      outcomeStatus: "UNDECIDED"
    };
  }
  return {
    progressStatus: "PENDING",
    outcomeStatus: "UNDECIDED"
  };
}
export function deriveWithdrawalAggregate(groups = []) {
  if (!groups.length) {
    return {
      progressStatus: "REVIEW_REQUIRED",
      outcomeStatus: "UNDECIDED"
    };
  }
  if (groups.some(group => group.progressStatus === "REVIEW_REQUIRED")) {
    return {
      progressStatus: "REVIEW_REQUIRED",
      outcomeStatus: "UNDECIDED"
    };
  }
  if (groups.every(group => group.progressStatus === "COMPLETED")) {
    const outcomes = new Set(groups.map(group => group.outcomeStatus));
    return {
      progressStatus: "COMPLETED",
      outcomeStatus: outcomes.size === 1 ? [...outcomes][0] : "MIXED"
    };
  }
  if (groups.some(group => group.progressStatus === "IN_PROGRESS")) {
    return {
      progressStatus: "IN_PROGRESS",
      outcomeStatus: "UNDECIDED"
    };
  }
  if (groups.every(group => group.progressStatus === "READY_FOR_INSTRUCTIONS")) {
    return {
      progressStatus: "READY_FOR_INSTRUCTIONS",
      outcomeStatus: "UNDECIDED"
    };
  }
  return {
    progressStatus: "PENDING",
    outcomeStatus: "UNDECIDED"
  };
}
export async function recomputeWithdrawalV2State(withdrawalRequestId, prismaClient = prisma) {
  const groups = await prismaClient.withdrawalReturnGroup.findMany({
    where: {
      withdrawalRequestId
    },
    orderBy: {
      createdAt: "asc"
    }
  });
  for (const group of groups) {
    const state = deriveReturnGroupState(group);
    if (state.progressStatus !== group.progressStatus || state.outcomeStatus !== group.outcomeStatus) {
      await prismaClient.withdrawalReturnGroup.update({
        where: {
          id: group.id
        },
        data: state
      });
      Object.assign(group, state);
    }
  }
  const aggregate = deriveWithdrawalAggregate(groups);
  const totals = groups.reduce((sum, group) => ({
    item: sum.item + Number(group.itemRefundNetAmount || 0),
    deduction: sum.deduction + Number(group.deductionAmount || 0),
    planned: sum.planned + Number(group.plannedRefundAmount || 0)
  }), {
    item: 0,
    deduction: 0,
    planned: 0
  });
  const contracts = await prismaClient.withdrawalContract.findMany({
    where: {
      withdrawalRequestId
    },
    orderBy: {
      createdAt: "asc"
    }
  });
  for (const contract of contracts) {
    const contractGroups = groups.filter(group => group.withdrawalContractId === contract.id);
    const itemBase = contractGroups.reduce((sum, group) => sum + Number(group.itemRefundBaseAmount || 0), 0);
    const deduction = contractGroups.reduce((sum, group) => sum + Number(group.deductionAmount || 0), 0);
    const itemNet = contractGroups.reduce((sum, group) => sum + Number(group.itemRefundNetAmount || 0), 0);
    const contractState = deriveWithdrawalAggregate(contractGroups);
    await prismaClient.withdrawalContract.update({
      where: {
        id: contract.id
      },
      data: {
        ...contractState,
        itemRefundBaseAmount: itemBase,
        deductionAmount: deduction,
        itemRefundNetAmount: itemNet,
        plannedRefundAmount: itemNet + Number(contract.initialShippingRefundAmount || 0),
        completedAt: contractState.progressStatus === "COMPLETED" ? contract.completedAt || new Date() : null
      }
    });
  }
  const shipping = contracts.reduce((sum, contract) => sum + Number(contract.initialShippingRefundAmount || 0), 0);
  return prismaClient.withdrawalRequest.update({
    where: {
      id: withdrawalRequestId
    },
    data: {
      ...aggregate,
      refundItemAmount: totals.item,
      refundDeductionAmount: totals.deduction,
      refundInitialShippingAmount: shipping,
      refundTotalAmount: Math.max(0, totals.planned + shipping)
    }
  });
}
export async function getActiveWithdrawalWorkflowPolicy(prismaClient = prisma) {
  if (!prismaClient?.withdrawalWorkflowPolicy?.findFirst) return null;
  return prismaClient.withdrawalWorkflowPolicy.findFirst({
    where: {
      active: true,
      directReturnEnabled: true,
      OR: [{
        effectiveAt: null
      }, {
        effectiveAt: {
          lte: new Date()
        }
      }]
    },
    orderBy: [{
      version: "desc"
    }]
  });
}
export function normalizeReturnAddressInput(values = {}) {
  const countryCode = text(values.countryCode).toUpperCase();
  const publicCountryLabel = formatPublicCountryLabel(countryCode);
  const data = {
    recipientName: text(values.recipientName),
    postalCode: text(values.postalCode),
    countryCode,
    countryLabel: (publicCountryLabel && publicCountryLabel !== countryCode ? publicCountryLabel : null) || text(values.countryLabel) || countryCode || null,
    region: text(values.region) || null,
    city: text(values.city) || null,
    address1: text(values.address1),
    address2: text(values.address2) || null,
    phone: text(values.phone) || null,
    instructions: text(values.instructions) || null,
    internationalRecipientName: text(values.internationalRecipientName) || null,
    internationalAddressLines: normalizeInternationalAddressLines(values.internationalAddressLines),
    phoneE164: text(values.phoneE164) || null,
    canReceiveReturnsConfirmed: Boolean(values.canReceiveReturnsConfirmed),
    buyerDisclosureConfirmed: Boolean(values.buyerDisclosureConfirmed),
    legalRecipientConfirmed: Boolean(values.legalRecipientConfirmed)
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
  return {
    ok: Object.keys(errors).length === 0,
    data,
    errors
  };
}
export function mapOrderLine(line, request, selection, isPartial) {
  if (isPartial && !lineMatchesSelection(line, selection.values)) return null;
  const quantity = Math.max(1, Number(line.quantity || 1));
  const requestedQuantity = isPartial ? getSelectedQuantity(line, selection, quantity) : quantity;
  const prorate = value => Math.floor(Math.max(0, Number(value || 0)) * requestedQuantity / quantity);
  const amount = prorate(line.netAmount);
  return {
    line,
    requestedQuantity,
    amount,
    subtotalAmount: prorate(line.lineSubtotalAmount),
    discountAmount: prorate(line.discountAmount),
    taxAmount: prorate(line.taxAmount),
    shopDomain: text(request.shopDomain || request.orderSnapshotJson?.shopDomain),
    shopifyOrderId: text(request.shopifyOrderId || request.orderSnapshotJson?.shopifyOrderId)
  };
}
export function cumulativeRefundedQuantity(purchasedQuantity, previousQuantity, eventQuantity) {
  const purchased = Math.max(0, Math.trunc(Number(purchasedQuantity || 0)));
  const previous = Math.max(0, Math.trunc(Number(previousQuantity || 0)));
  const currentEvent = Math.max(0, Math.trunc(Number(eventQuantity || 0)));
  return Math.min(purchased || previous + currentEvent, previous + currentEvent);
}
export function normalizeInternationalAddressLines(value) {
  const lines = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const normalized = lines.map(line => text(line)).filter(Boolean).slice(0, 8);
  return normalized.length > 0 ? normalized : null;
}
