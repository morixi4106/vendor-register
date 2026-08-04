import prisma from "../../db.server.js";
import { updateWithdrawalReturnInfo } from "../withdrawals.server.js";
import { updateWithdrawalGroupReview } from "../withdrawalDirectReturns.server.js";
import { createVendorWithdrawalSummary, formatDate, formatDateTime, getSelectedLineItemValues, lineMatchesSelectedWithdrawalValues, listVendorWithdrawalRequestsForSellerOrders, sellerOrderTouchesWithdrawal, serializeVendorWithdrawalRequest } from "./common.js";
function filterSellerOrderLinesForWithdrawal(sellerOrder, withdrawalRequest) {
  if (String(withdrawalRequest?.withdrawalScope || "FULL").toUpperCase() !== "PARTIAL") {
    return sellerOrder;
  }
  const selectedValues = getSelectedLineItemValues(withdrawalRequest);
  if (selectedValues.size === 0) {
    return sellerOrder;
  }
  return {
    ...sellerOrder,
    lines: (Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []).filter(line => lineMatchesSelectedWithdrawalValues(line, selectedValues))
  };
}
function getVendorReturnGroupPresentation(group) {
  if (group.instructionStatus !== "SENT") {
    return {
      label: group.blockedReason === "RETURN_ADDRESS_MISSING" ? "返送先の設定が必要" : "返送案内待ち",
      tone: group.blockedReason ? "warning" : "neutral",
      action: group.blockedReason === "RETURN_ADDRESS_MISSING" ? "返送先を設定" : "運営の案内待ち",
      needsAction: group.blockedReason === "RETURN_ADDRESS_MISSING"
    };
  }
  if (group.evidenceStatus === "NOT_SUBMITTED") {
    return {
      label: "購入者の返送待ち",
      tone: "neutral",
      action: "返送待ち",
      needsAction: false
    };
  }
  if (group.receiptStatus !== "RECEIVED") {
    return {
      label: "返送中",
      tone: "warning",
      action: "到着を確認",
      needsAction: true
    };
  }
  if (!["INSPECTED", "VALUE_REDUCTION_REVIEW"].includes(group.inspectionStatus)) {
    return {
      label: "到着済み",
      tone: "warning",
      action: "商品状態を確認",
      needsAction: true
    };
  }
  if (group.refundDecisionStatus === "UNDECIDED") {
    return {
      label: "検品済み",
      tone: "success",
      action: "運営の返金判断待ち",
      needsAction: false
    };
  }
  return {
    label: group.progressStatus === "COMPLETED" ? "処理完了" : "返金処理中",
    tone: group.progressStatus === "COMPLETED" ? "success" : "neutral",
    action: group.progressStatus === "COMPLETED" ? "対応完了" : "運営処理中",
    needsAction: false
  };
}
function serializeVendorWithdrawalV2Group(group) {
  const presentation = getVendorReturnGroupPresentation(group);
  const base = serializeVendorWithdrawalRequest(group.withdrawalRequest);
  const receivedShipment = (group.shipments || []).find(shipment => shipment.receivedAt);
  return {
    ...base,
    returnGroupId: group.id,
    storeName: group.storeNameSnapshot || group.vendorStore?.storeName || "-",
    status: group.progressStatus,
    statusLabel: presentation.label,
    statusTone: presentation.tone,
    needsVendorAction: presentation.needsAction,
    vendorActionLabel: presentation.action,
    instructionStatus: group.instructionStatus,
    evidenceStatus: group.evidenceStatus,
    receiptStatus: group.receiptStatus,
    inspectionStatus: group.inspectionStatus,
    refundDecisionStatus: group.refundDecisionStatus,
    returnTrackingCompany: group.shipments?.[0]?.trackingCompany || "",
    returnTrackingNumber: group.shipments?.[0]?.trackingNumber || "",
    returnTrackingUrl: group.shipments?.[0]?.trackingUrl || "",
    returnReceivedAt: receivedShipment?.receivedAt || null,
    returnReceivedAtLabel: formatDate(receivedShipment?.receivedAt),
    lines: (group.lines || []).map(line => ({
      id: line.id,
      requestedLineId: line.requestedLineId,
      title: line.requestedLine?.titleSnapshot || "-",
      sku: line.requestedLine?.skuSnapshot || "",
      instructedQuantity: line.instructedQuantity,
      submittedQuantity: line.submittedQuantity,
      receivedQuantity: line.receivedQuantity,
      missingQuantity: line.missingQuantity,
      conditionStatus: line.conditionStatus,
      conditionNotes: line.conditionNotes || "",
      amount: line.requestedLine?.itemRefundBaseAmount || line.requestedLine?.paidAmountSnapshot || 0,
      currencyCode: line.requestedLine?.currencyCode || group.currencyCode || "JPY"
    })),
    shipments: group.shipments || [],
    instructions: group.instructions || []
  };
}
export async function listVendorWithdrawalRequests({
  storeId,
  first = 50
}, {
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.sellerOrder?.findMany) {
    return [];
  }
  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: {
      vendorStoreId: storeId
    },
    orderBy: [{
      createdAt: "desc"
    }],
    take: Math.max(first, 100),
    select: {
      id: true,
      marketplaceOrderId: true,
      shopifyOrderId: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          shopifyProductId: true,
          shopifyVariantId: true,
          productId: true,
          title: true,
          quantity: true
        }
      }
    }
  });
  const legacyRequests = await listVendorWithdrawalRequestsForSellerOrders({
    sellerOrders,
    first
  }, {
    prismaClient
  });
  if (!prismaClient?.withdrawalReturnGroup?.findMany) {
    return legacyRequests;
  }
  const v2Groups = await prismaClient.withdrawalReturnGroup.findMany({
    where: {
      vendorStoreId: storeId
    },
    orderBy: [{
      createdAt: "desc"
    }],
    take: first,
    include: {
      withdrawalRequest: true,
      vendorStore: {
        select: {
          storeName: true
        }
      },
      lines: {
        include: {
          requestedLine: true
        },
        orderBy: {
          createdAt: "asc"
        }
      },
      instructions: {
        orderBy: {
          version: "desc"
        },
        take: 1
      },
      shipments: {
        include: {
          lines: true
        },
        orderBy: {
          packageNumber: "asc"
        }
      }
    }
  });
  const v2Items = v2Groups.map(serializeVendorWithdrawalV2Group);
  const v2RequestIds = new Set(v2Items.map(item => item.id));
  return [...v2Items, ...legacyRequests.filter(item => !v2RequestIds.has(item.id))].sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()).slice(0, first);
}
export async function getVendorWithdrawalSummary({
  storeId
}, {
  prismaClient = prisma
} = {}) {
  const withdrawalRequests = await listVendorWithdrawalRequests({
    storeId,
    first: 100
  }, {
    prismaClient
  });
  return createVendorWithdrawalSummary(withdrawalRequests);
}
export async function getVendorWithdrawalRequestDetail({
  storeId,
  withdrawalRequestId
}, {
  prismaClient = prisma
} = {}) {
  const withdrawalRequestIdValue = String(withdrawalRequestId || "").trim();
  if (!withdrawalRequestIdValue) {
    return null;
  }
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequestIdValue
    },
    include: {
      statusHistory: {
        orderBy: {
          createdAt: "desc"
        },
        take: 20
      },
      emailLogs: {
        orderBy: {
          createdAt: "desc"
        },
        take: 10
      }
    }
  });
  if (!withdrawalRequest) {
    return null;
  }
  if (Number(withdrawalRequest.workflowVersion || 1) === 2 && prismaClient?.withdrawalReturnGroup?.findFirst) {
    const returnGroup = await prismaClient.withdrawalReturnGroup.findFirst({
      where: {
        withdrawalRequestId: withdrawalRequest.id,
        vendorStoreId: storeId
      },
      include: {
        vendorStore: {
          select: {
            storeName: true
          }
        },
        returnAddress: true,
        lines: {
          include: {
            requestedLine: true
          },
          orderBy: {
            createdAt: "asc"
          }
        },
        instructions: {
          orderBy: {
            version: "desc"
          }
        },
        shipments: {
          include: {
            lines: {
              include: {
                returnGroupLine: true
              }
            }
          },
          orderBy: {
            packageNumber: "asc"
          }
        }
      }
    });
    if (!returnGroup) return null;
    return {
      withdrawalRequest: {
        ...serializeVendorWithdrawalRequest(withdrawalRequest),
        statusHistory: withdrawalRequest.statusHistory.map(item => ({
          ...item,
          createdAtLabel: formatDateTime(item.createdAt)
        })),
        emailLogs: []
      },
      returnGroup: serializeVendorWithdrawalV2Group({
        ...returnGroup,
        withdrawalRequest
      }),
      sellerOrders: []
    };
  }
  const orderWhere = [...(withdrawalRequest.shopifyOrderId ? [{
    shopifyOrderId: withdrawalRequest.shopifyOrderId
  }] : []), ...(withdrawalRequest.marketplaceOrderId ? [{
    marketplaceOrderId: withdrawalRequest.marketplaceOrderId
  }] : [])];
  if (orderWhere.length === 0) {
    return null;
  }
  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: {
      vendorStoreId: storeId,
      OR: orderWhere
    },
    select: {
      id: true,
      marketplaceOrderId: true,
      shopifyOrderId: true,
      sellerPayableAmount: true,
      sellerRefundAmount: true,
      currencyCode: true,
      fulfillmentStatus: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          shopifyProductId: true,
          shopifyVariantId: true,
          productId: true,
          title: true,
          quantity: true,
          netAmount: true,
          currencyCode: true
        }
      }
    }
  });
  const matchingSellerOrders = sellerOrders.filter(sellerOrder => sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest)).map(sellerOrder => filterSellerOrderLinesForWithdrawal(sellerOrder, withdrawalRequest)).filter(sellerOrder => (sellerOrder.lines || []).length > 0);
  if (matchingSellerOrders.length === 0) {
    return null;
  }
  return {
    withdrawalRequest: {
      ...serializeVendorWithdrawalRequest(withdrawalRequest),
      statusHistory: withdrawalRequest.statusHistory.map(item => ({
        ...item,
        createdAtLabel: formatDateTime(item.createdAt)
      })),
      emailLogs: withdrawalRequest.emailLogs.map(item => ({
        ...item,
        sentAtLabel: formatDateTime(item.sentAt || item.createdAt)
      }))
    },
    sellerOrders: matchingSellerOrders
  };
}
export async function updateVendorWithdrawalReturnInfo({
  storeId,
  withdrawalRequestId,
  formData
}, {
  prismaClient = prisma
} = {}) {
  const access = await getVendorWithdrawalRequestDetail({
    storeId,
    withdrawalRequestId
  }, {
    prismaClient
  });
  if (!access) {
    return {
      ok: false,
      status: 404,
      error: "撤回申請が見つかりません。"
    };
  }
  if (Number(access.withdrawalRequest.workflowVersion || 1) === 2) {
    const group = access.returnGroup;
    if (!group) {
      return {
        ok: false,
        status: 404,
        error: "返送グループが見つかりません。"
      };
    }
    const lineReviews = (group.lines || []).map(line => ({
      id: line.id,
      receivedQuantity: formData.get(`receivedQuantity_${line.id}`),
      conditionStatus: formData.get(`conditionStatus_${line.id}`),
      conditionNotes: formData.get(`conditionNotes_${line.id}`)
    }));
    const result = await updateWithdrawalGroupReview({
      returnGroupId: group.returnGroupId,
      vendorStoreId: storeId,
      allowFinancialDecision: false,
      changedBy: `vendor:${storeId}`,
      values: {
        evidenceStatus: formData.get("evidenceStatus"),
        receiptStatus: formData.get("receiptStatus"),
        inspectionStatus: formData.get("inspectionStatus"),
        reviewNotes: formData.get("reviewNotes"),
        lineReviews
      },
      prismaClient
    });
    return result.ok ? {
      ok: true,
      message: "到着・検品情報を保存しました。"
    } : {
      ok: false,
      status: result.status || 400,
      error: "到着・検品情報を保存できませんでした。",
      errors: result.errors || {}
    };
  }
  const result = await updateWithdrawalReturnInfo({
    id: withdrawalRequestId,
    formData,
    changedBy: `vendor:${storeId}`,
    prismaClient
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status || 400,
      error: "返送情報を保存できませんでした。",
      errors: result.errors || {}
    };
  }
  return {
    ok: true,
    message: "返送・商品状態を保存しました。",
    withdrawalRequest: result.withdrawalRequest
  };
}
