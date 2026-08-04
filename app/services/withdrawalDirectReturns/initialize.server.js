import { Prisma } from "@prisma/client";
import prisma from "../../db.server.js";
import { MAX_TRANSACTION_RETRIES, addDays, allocateIntegerByWeight, contractKeyForSellerOrder, getActiveWithdrawalWorkflowPolicy, getSelectedLineSelection, isSellerContractParty, jsonObject, mapOrderLine, normalizeCurrency, normalizePartialLineSelections, recomputeWithdrawalV2State, text } from "./common.js";
function getPlatformPartyName() {
  return text(process.env.WITHDRAWAL_PLATFORM_PARTY_NAME) || "Oja Immanuel Bacchus";
}
async function reserveAndCreateRequestedLines({
  request,
  mappedLines,
  tx
}) {
  const created = [];
  for (const mapped of mappedLines) {
    const line = mapped.line;
    const position = await tx.withdrawalOrderLinePosition.upsert({
      where: {
        shopDomain_shopifyOrderId_shopifyLineItemId: {
          shopDomain: mapped.shopDomain,
          shopifyOrderId: mapped.shopifyOrderId,
          shopifyLineItemId: line.shopifyLineItemId
        }
      },
      create: {
        marketplaceOrderId: request.marketplaceOrderId,
        shopDomain: mapped.shopDomain,
        shopifyOrderId: mapped.shopifyOrderId,
        shopifyLineItemId: line.shopifyLineItemId,
        purchasedQuantity: Math.max(1, Number(line.quantity || 1)),
        refundedQuantity: Math.max(0, Number(line.refundedQuantity || 0)),
        sourceSnapshotJson: {
          sellerOrderLineId: line.id
        }
      },
      update: {
        purchasedQuantity: Math.max(1, Number(line.quantity || 1)),
        refundedQuantity: Math.max(0, Number(line.refundedQuantity || 0)),
        observedAt: new Date()
      }
    });
    const reservations = await tx.withdrawalRequestedLine.aggregate({
      where: {
        orderLinePositionId: position.id,
        withdrawalRequestId: {
          not: request.id
        },
        withdrawalRequest: {
          outcomeStatus: {
            notIn: ["CANCELLED", "NO_REFUND"]
          }
        }
      },
      _sum: {
        reservedQuantity: true,
        releasedQuantity: true
      }
    });
    const alreadyReserved = Number(reservations._sum.reservedQuantity || 0) - Number(reservations._sum.releasedQuantity || 0);
    const available = Math.max(0, position.purchasedQuantity - position.refundedQuantity - position.cancelledQuantity - alreadyReserved);
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
        itemRefundNetAmount: mapped.amount
      }
    });
    created.push({
      requestedLine,
      sellerOrder: line.sellerOrder,
      seller: line.sellerOrder.seller
    });
  }
  return created;
}
async function initializeV2Transaction({
  requestId,
  policy,
  lineSelections = null,
  changedBy = "system",
  prismaClient
}) {
  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
    try {
      return await prismaClient.$transaction(async tx => {
        const request = await tx.withdrawalRequest.findUnique({
          where: {
            id: requestId
          },
          include: {
            contracts: {
              select: {
                id: true
              },
              take: 1
            },
            requestedLines: {
              select: {
                id: true
              },
              take: 1
            },
            marketplaceOrder: {
              include: {
                sellerOrders: {
                  include: {
                    lines: true
                  }
                }
              }
            }
          }
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
          const availableLines = sellerOrders.flatMap(order => order.lines || []);
          const availableById = new Map(availableLines.map(line => [line.id, line]));
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
            mappingConfirmedBy: text(changedBy) || "admin"
          };
          request.selectedLineItemsJson = selectedLineItemsJson;
          await tx.withdrawalRequest.update({
            where: {
              id: request.id
            },
            data: {
              selectedLineItemsJson,
              v2ReviewReason: null
            }
          });
        }
        await tx.withdrawalRequest.update({
          where: {
            id: request.id
          },
          data: {
            workflowVersion: 2,
            returnMode: "DIRECT_TO_STORE",
            contractMode: policy.contractMode,
            contractPolicyVersion: policy.version,
            termsVersion: policy.termsVersion,
            v2ActivatedAt: new Date(),
            progressStatus: "REVIEW_REQUIRED",
            outcomeStatus: "UNDECIDED"
          }
        });
        const sellerIds = [...new Set(sellerOrders.map(order => order.sellerId).filter(Boolean))];
        const sellers = await tx.seller.findMany({
          where: {
            id: {
              in: sellerIds
            }
          },
          include: {
            vendor: true,
            vendorStore: true
          }
        });
        const sellerById = new Map(sellers.map(seller => [seller.id, seller]));
        const selection = isPartial ? getSelectedLineSelection(request) : {
          values: new Set(),
          quantities: new Map()
        };
        const mappedLines = sellerOrders.flatMap(sellerOrder => sellerOrder.lines.map(line => mapOrderLine({
          ...line,
          sellerOrder: {
            ...sellerOrder,
            seller: sellerById.get(sellerOrder.sellerId)
          }
        }, request, selection, isPartial)).filter(Boolean));
        if (!mappedLines.length) throw new Error("withdrawal_lines_not_mapped");
        const requested = await reserveAndCreateRequestedLines({
          request,
          mappedLines,
          tx
        });
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
                contractPartyName: sellerParty ? seller?.vendor?.storeName || seller?.vendorStore?.storeName || "販売店舗" : getPlatformPartyName(),
                contractPartyId: sellerParty ? seller?.id : null,
                sellerLegalRoleSnapshot: seller?.sellerLegalRole || null,
                refundResponsibilitySnapshot: sellerParty ? "SELLER" : "PLATFORM",
                termsVersion: policy.termsVersion,
                lastPhysicalPossessionAt: request.receivedDate,
                withdrawalEligibilityDeadlineAt: request.deadlineAt,
                withdrawalExercisedAt: request.createdAt,
                statutoryReturnDeadlineAt: addDays(request.createdAt, 14),
                currencyCode: normalizeCurrency(sellerOrder.currencyCode)
              }
            });
            contractByKey.set(key, contract);
          }
          await tx.withdrawalRequestedLine.update({
            where: {
              id: item.requestedLine.id
            },
            data: {
              withdrawalContractId: contract.id
            }
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
            where: {
              vendorStoreId: storeId,
              status: "ACTIVE"
            },
            orderBy: {
              version: "desc"
            }
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
              itemRefundBaseAmount: items.reduce((sum, item) => sum + Number(item.requestedLine.itemRefundBaseAmount || 0), 0),
              itemRefundNetAmount: items.reduce((sum, item) => sum + Number(item.requestedLine.itemRefundNetAmount || 0), 0),
              currencyCode: normalizeCurrency(first.requestedLine.currencyCode)
            }
          });
          for (const item of items) {
            await tx.withdrawalReturnGroupLine.create({
              data: {
                returnGroupId: group.id,
                requestedLineId: item.requestedLine.id,
                instructedQuantity: item.requestedLine.requestedQuantity
              }
            });
          }
        }
        const contractItems = [...contractByKey.values()].map(contract => ({
          key: contract.id,
          weight: requested.filter(item => item.contract.id === contract.id).reduce((sum, item) => sum + Number(item.requestedLine.itemRefundBaseAmount || 0), 0)
        }));
        const existingShippingAllocation = await tx.withdrawalContract.aggregate({
          where: {
            marketplaceOrderId: request.marketplaceOrderId,
            withdrawalRequestId: {
              not: request.id
            },
            initialShippingRefundStatus: {
              notIn: ["NOT_APPLICABLE", "NOT_REFUNDABLE"]
            }
          },
          _sum: {
            initialShippingRefundAmount: true
          }
        });
        const remainingOrderShipping = Math.max(0, Number(request.marketplaceOrder?.shippingAmount || 0) - Number(existingShippingAllocation._sum.initialShippingRefundAmount || 0));
        const shippingAllocations = allocateIntegerByWeight(remainingOrderShipping, contractItems);
        for (const contract of contractByKey.values()) {
          const contractLines = requested.filter(item => item.contract.id === contract.id);
          const itemRefundBaseAmount = contractLines.reduce((sum, item) => sum + Number(item.requestedLine.itemRefundBaseAmount || 0), 0);
          const initialShippingRefundAmount = Number(shippingAllocations.get(contract.id) || 0);
          await tx.withdrawalContract.update({
            where: {
              id: contract.id
            },
            data: {
              itemRefundBaseAmount,
              itemRefundNetAmount: itemRefundBaseAmount,
              initialShippingRefundStatus: initialShippingRefundAmount > 0 ? "PLANNED" : "NOT_APPLICABLE",
              initialShippingRefundAmount,
              initialShippingRefundReason: initialShippingRefundAmount > 0 ? "ORDER_STANDARD_SHIPPING_PROPORTIONAL_ALLOCATION" : null,
              plannedRefundAmount: itemRefundBaseAmount + initialShippingRefundAmount,
              progressStatus: "PENDING"
            }
          });
        }
        return request;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      if (error?.code === "P2034" && attempt + 1 < MAX_TRANSACTION_RETRIES) continue;
      throw error;
    }
  }
  throw new Error("withdrawal_v2_transaction_retry_exhausted");
}
export async function initializeWithdrawalDirectReturnWorkflow({
  withdrawalRequestId,
  prismaClient = prisma
} = {}) {
  const policy = await getActiveWithdrawalWorkflowPolicy(prismaClient);
  if (!policy) return {
    ok: true,
    skipped: true,
    reason: "v2_policy_inactive"
  };
  try {
    await initializeV2Transaction({
      requestId: withdrawalRequestId,
      policy,
      prismaClient
    });
    await recomputeWithdrawalV2State(withdrawalRequestId, prismaClient);
    return {
      ok: true,
      workflowVersion: 2
    };
  } catch (error) {
    await prismaClient.withdrawalRequest.update({
      where: {
        id: withdrawalRequestId
      },
      data: {
        workflowVersion: 2,
        returnMode: "DIRECT_TO_STORE",
        contractMode: policy.contractMode,
        contractPolicyVersion: policy.version,
        termsVersion: policy.termsVersion,
        progressStatus: "REVIEW_REQUIRED",
        v2ReviewReason: text(error?.message || error).slice(0, 240)
      }
    });
    return {
      ok: false,
      status: 409,
      error: "v2_initialization_failed"
    };
  }
}
export async function confirmWithdrawalPartialLineMapping({
  withdrawalRequestId,
  lineSelections,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  const request = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: text(withdrawalRequestId)
    },
    select: {
      id: true,
      withdrawalScope: true,
      contractPolicyVersion: true,
      contracts: {
        select: {
          id: true
        },
        take: 1
      },
      requestedLines: {
        select: {
          id: true
        },
        take: 1
      }
    }
  });
  if (!request) return {
    ok: false,
    status: 404,
    error: "withdrawal_request_not_found"
  };
  if (text(request.withdrawalScope).toUpperCase() !== "PARTIAL") {
    return {
      ok: false,
      status: 400,
      error: "withdrawal_partial_mapping_not_applicable"
    };
  }
  if (request.contracts?.length || request.requestedLines?.length) {
    return {
      ok: false,
      status: 409,
      error: "withdrawal_line_mapping_locked"
    };
  }
  if (!normalizePartialLineSelections(lineSelections).size) {
    return {
      ok: false,
      status: 400,
      error: "withdrawal_partial_line_mapping_required"
    };
  }
  const policy = request.contractPolicyVersion ? await prismaClient.withdrawalWorkflowPolicy.findUnique({
    where: {
      version: Number(request.contractPolicyVersion)
    }
  }) : await getActiveWithdrawalWorkflowPolicy(prismaClient);
  if (!policy?.directReturnEnabled) {
    return {
      ok: false,
      status: 409,
      error: "withdrawal_policy_not_found"
    };
  }
  try {
    await initializeV2Transaction({
      requestId: request.id,
      policy,
      lineSelections,
      changedBy,
      prismaClient
    });
    await recomputeWithdrawalV2State(request.id, prismaClient);
    return {
      ok: true,
      workflowVersion: 2
    };
  } catch (error) {
    const reason = text(error?.message || error);
    if (reason !== "withdrawal_line_mapping_locked") {
      await prismaClient.withdrawalRequest.update({
        where: {
          id: request.id
        },
        data: {
          progressStatus: "REVIEW_REQUIRED",
          v2ReviewReason: reason.slice(0, 240)
        }
      });
    }
    const publicError = reason.startsWith("withdrawal_quantity_unavailable:") ? "withdrawal_quantity_unavailable" : reason || "v2_initialization_failed";
    const knownStatus = ["withdrawal_line_not_in_order", "withdrawal_line_quantity_exceeded", "withdrawal_partial_line_mapping_required"].includes(publicError) ? 400 : 409;
    return {
      ok: false,
      status: knownStatus,
      error: publicError
    };
  }
}
export async function getWithdrawalV2Detail(id, prismaClient = prisma) {
  const detail = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: text(id)
    },
    include: {
      marketplaceOrder: {
        include: {
          sellerOrders: {
            include: {
              lines: {
                orderBy: {
                  createdAt: "asc"
                }
              }
            },
            orderBy: {
              createdAt: "asc"
            }
          }
        }
      },
      contracts: {
        orderBy: {
          createdAt: "asc"
        }
      },
      requestedLines: {
        orderBy: {
          createdAt: "asc"
        }
      },
      withdrawalReturnGroups: {
        orderBy: {
          createdAt: "asc"
        },
        include: {
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
              lines: true
            },
            orderBy: {
              packageNumber: "asc"
            }
          }
        }
      },
      actualRefundEvents: {
        include: {
          allocations: true
        },
        orderBy: {
          createdAt: "asc"
        }
      }
    }
  });
  if (!detail) return null;
  const sellerOrders = detail.marketplaceOrder?.sellerOrders || [];
  const sellerIds = [...new Set(sellerOrders.map(order => order.sellerId).filter(Boolean))];
  const sellers = sellerIds.length ? await prismaClient.seller.findMany({
    where: {
      id: {
        in: sellerIds
      }
    },
    include: {
      vendor: true,
      vendorStore: true
    }
  }) : [];
  const sellerById = new Map(sellers.map(seller => [seller.id, seller]));
  return {
    ...detail,
    availableOrderLines: sellerOrders.flatMap(sellerOrder => {
      const seller = sellerById.get(sellerOrder.sellerId);
      return (sellerOrder.lines || []).map(line => ({
        id: line.id,
        sellerOrderId: sellerOrder.id,
        vendorStoreId: sellerOrder.vendorStoreId,
        storeName: seller?.vendorStore?.storeName || seller?.vendor?.storeName || "販売店舗",
        title: line.title || "商品",
        sku: line.sku,
        quantity: Math.max(1, Number(line.quantity || 1)),
        refundedQuantity: Math.max(0, Number(line.refundedQuantity || 0)),
        availableQuantity: Math.max(0, Math.max(1, Number(line.quantity || 1)) - Math.max(0, Number(line.refundedQuantity || 0))),
        netAmount: Math.max(0, Number(line.netAmount || 0)),
        currencyCode: normalizeCurrency(line.currencyCode || sellerOrder.currencyCode)
      }));
    })
  };
}
