import prisma from "../../db.server.js";
import { cumulativeRefundedQuantity, normalizeCurrency, recomputeWithdrawalV2State, selectShippingRefundTargetRequest, text } from "./common.js";
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
  prismaClient = prisma
} = {}) {
  if (!withdrawalRequestId || !shopDomain || !shopifyRefundId) {
    return {
      ok: false,
      status: 400,
      error: "refund_event_identity_required"
    };
  }
  const event = await prismaClient.withdrawalActualRefundEvent.upsert({
    where: {
      withdrawalRequestId_shopDomain_shopifyRefundId: {
        withdrawalRequestId,
        shopDomain,
        shopifyRefundId
      }
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
        create: allocations.map(allocation => ({
          withdrawalContractId: allocation.withdrawalContractId || null,
          requestedLineId: allocation.requestedLineId || null,
          shopifyLineItemId: allocation.shopifyLineItemId || null,
          quantity: Number(allocation.quantity || 0),
          itemAmount: Number(allocation.itemAmount || 0),
          initialShippingAmount: Number(allocation.initialShippingAmount || 0)
        }))
      }
    },
    update: {
      itemAmount,
      initialShippingAmount,
      otherAmount,
      currencyCode: normalizeCurrency(currencyCode),
      webhookReceivedAt: new Date(),
      metadataJson
    }
  });
  return {
    ok: true,
    event
  };
}
function normalizeShopifyGid(type, value) {
  const normalized = text(value);
  if (!normalized) return "";
  return normalized.startsWith("gid://shopify/") ? normalized : `gid://shopify/${type}/${normalized}`;
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
  return Math.max(0, Math.round(numeric * (normalizeCurrency(currencyCode) === "JPY" ? 1 : 100)));
}
async function recomputeRefundReconciliation(withdrawalRequestId, prismaClient) {
  const groups = await prismaClient.withdrawalReturnGroup.findMany({
    where: {
      withdrawalRequestId
    },
    include: {
      lines: {
        include: {
          requestedLine: {
            include: {
              actualRefundAllocations: true
            }
          }
        }
      }
    }
  });
  for (const group of groups) {
    const actual = group.lines.reduce((sum, line) => sum + line.requestedLine.actualRefundAllocations.reduce((lineSum, allocation) => lineSum + Number(allocation.itemAmount || 0), 0), 0);
    const planned = Math.max(0, Number(group.plannedRefundAmount || 0));
    const status = actual <= 0 ? "NOT_RECONCILED" : planned > 0 && actual >= planned ? "RECONCILED" : "PARTIALLY_RECONCILED";
    await prismaClient.withdrawalReturnGroup.update({
      where: {
        id: group.id
      },
      data: {
        refundReconciliationStatus: status
      }
    });
  }
  await recomputeWithdrawalV2State(withdrawalRequestId, prismaClient);
}
export async function reconcileWithdrawalRefundWebhook({
  payload,
  shop,
  prismaClient = prisma
} = {}) {
  const shopDomain = text(shop || payload?.shop_domain || payload?.shop).toLowerCase();
  const shopifyRefundId = normalizeShopifyGid("Refund", payload?.id);
  const shopifyOrderId = normalizeShopifyGid("Order", payload?.order_id);
  if (!shopDomain || !shopifyRefundId || !shopifyOrderId) {
    return {
      ok: false,
      reason: "refund_identity_missing"
    };
  }
  const requests = await prismaClient.withdrawalRequest.findMany({
    where: {
      shopDomain,
      shopifyOrderId,
      workflowVersion: 2
    },
    orderBy: {
      createdAt: "asc"
    },
    include: {
      contracts: true,
      actualRefundEvents: true,
      requestedLines: {
        include: {
          orderLinePosition: true,
          actualRefundAllocations: true
        }
      }
    }
  });
  if (!requests.length) return {
    ok: true,
    skipped: true,
    reason: "no_v2_withdrawal"
  };
  const alreadyRecorded = await prismaClient.withdrawalActualRefundEvent.findMany({
    where: {
      withdrawalRequestId: {
        in: requests.map(request => request.id)
      },
      shopDomain,
      shopifyRefundId
    }
  });
  const recordedRequestIds = new Set(alreadyRecorded.map(event => event.withdrawalRequestId));
  if (recordedRequestIds.size === requests.length) {
    return {
      ok: true,
      duplicate: true,
      events: alreadyRecorded
    };
  }
  const refundLines = Array.isArray(payload?.refund_line_items) ? payload.refund_line_items : [];
  const currencyCode = normalizeCurrency(payload?.currency || payload?.order?.currency || requests[0]?.refundCurrencyCode);
  const allocationsByRequest = new Map(requests.map(request => [request.id, []]));
  const positionUpdates = new Map();
  for (const refundLine of refundLines) {
    const incomingLineId = refundLine?.line_item_id || refundLine?.line_item?.id;
    let remainingQuantity = Math.max(0, Math.trunc(Number(refundLine?.quantity || 0)));
    const totalAmount = moneyInteger(refundLine?.subtotal ?? refundLine?.line_item?.price * remainingQuantity, currencyCode);
    const candidates = requests.flatMap(request => request.requestedLines.filter(line => shopifyIdMatches(line.shopifyLineItemId, incomingLineId)).map(line => ({
      request,
      line
    })));
    let allocatedAmount = 0;
    candidates.forEach(({
      request,
      line
    }, index) => {
      if (remainingQuantity <= 0) return;
      const previouslyAllocated = line.actualRefundAllocations.reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0);
      const available = Math.max(0, Number(line.reservedQuantity || 0) - Number(line.releasedQuantity || 0) - previouslyAllocated);
      const quantity = Math.min(remainingQuantity, available);
      if (!quantity) return;
      const isLast = index === candidates.length - 1 || quantity === remainingQuantity;
      const amount = isLast ? Math.max(0, totalAmount - allocatedAmount) : Math.floor(totalAmount * quantity / Math.max(1, Number(refundLine?.quantity || 0)));
      allocatedAmount += amount;
      remainingQuantity -= quantity;
      allocationsByRequest.get(request.id).push({
        withdrawalContractId: line.withdrawalContractId,
        requestedLineId: line.id,
        shopifyLineItemId: line.shopifyLineItemId,
        quantity,
        itemAmount: amount,
        initialShippingAmount: 0
      });
      positionUpdates.set(line.orderLinePositionId, Math.max(positionUpdates.get(line.orderLinePositionId) || 0, Math.max(0, Math.trunc(Number(refundLine?.quantity || 0)))));
    });
  }
  const shippingTotal = (Array.isArray(payload?.order_adjustments) ? payload.order_adjustments : []).filter(adjustment => ["shipping_refund", "shipping"].includes(text(adjustment?.kind).toLowerCase())).reduce((sum, adjustment) => sum + moneyInteger(Math.abs(Number(adjustment?.amount || 0)), currencyCode), 0);
  const recordedShippingTotal = alreadyRecorded.reduce((sum, event) => sum + Math.max(0, Number(event.initialShippingAmount || 0)), 0);
  const remainingShippingTotal = Math.max(0, shippingTotal - recordedShippingTotal);
  const unrecordedRequests = requests.filter(request => !recordedRequestIds.has(request.id));
  const shippingTargetRequest = remainingShippingTotal > 0 ? selectShippingRefundTargetRequest(unrecordedRequests, allocationsByRequest) : null;
  const results = [];
  for (const request of unrecordedRequests) {
    const allocations = allocationsByRequest.get(request.id) || [];
    if (!allocations.length && request.id !== shippingTargetRequest?.id) continue;
    const initialShippingAmount = request.id === shippingTargetRequest?.id ? remainingShippingTotal : 0;
    const itemAmount = allocations.reduce((sum, allocation) => sum + allocation.itemAmount, 0);
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
        unallocatedLineQuantityExists: refundLines.some(refundLine => {
          const incoming = refundLine?.line_item_id || refundLine?.line_item?.id;
          return !request.requestedLines.some(line => shopifyIdMatches(line.shopifyLineItemId, incoming));
        })
      },
      prismaClient
    });
    if (recorded.ok) await recomputeRefundReconciliation(request.id, prismaClient);
    results.push(recorded);
  }
  for (const [positionId, refundedQuantity] of positionUpdates) {
    const position = requests.flatMap(request => request.requestedLines).find(line => line.orderLinePositionId === positionId)?.orderLinePosition;
    if (!position) continue;
    await prismaClient.withdrawalOrderLinePosition.update({
      where: {
        id: positionId
      },
      data: {
        refundedQuantity: cumulativeRefundedQuantity(position.purchasedQuantity, position.refundedQuantity, refundedQuantity)
      }
    });
  }
  return {
    ok: true,
    duplicate: results.length === 0 && alreadyRecorded.length > 0,
    results
  };
}
export async function reconcileWithdrawalCancellationWebhook({
  payload,
  shop,
  prismaClient = prisma
} = {}) {
  const shopDomain = text(shop || payload?.shop_domain || payload?.shop).toLowerCase();
  const shopifyOrderId = normalizeShopifyGid("Order", payload?.id || payload?.order_id);
  if (!shopDomain || !shopifyOrderId) {
    return {
      ok: false,
      reason: "cancellation_identity_missing"
    };
  }
  const requests = await prismaClient.withdrawalRequest.findMany({
    where: {
      shopDomain,
      shopifyOrderId,
      workflowVersion: 2
    },
    include: {
      requestedLines: {
        include: {
          orderLinePosition: true
        }
      }
    }
  });
  for (const request of requests) {
    await prismaClient.$transaction(async tx => {
      for (const line of request.requestedLines) {
        await tx.withdrawalOrderLinePosition.update({
          where: {
            id: line.orderLinePositionId
          },
          data: {
            cancelledQuantity: Math.min(Number(line.orderLinePosition.purchasedQuantity || line.reservedQuantity), Math.max(Number(line.orderLinePosition.cancelledQuantity || 0), Number(line.reservedQuantity || 0)))
          }
        });
      }
      await tx.withdrawalReturnGroup.updateMany({
        where: {
          withdrawalRequestId: request.id,
          instructionsSentAt: null
        },
        data: {
          progressStatus: "COMPLETED",
          outcomeStatus: "CANCELLED",
          completedAt: new Date()
        }
      });
    });
    await recomputeWithdrawalV2State(request.id, prismaClient);
  }
  return {
    ok: true,
    requestCount: requests.length
  };
}
