import { randomUUID } from "node:crypto";
import prisma from "../../db.server.js";
import { shopifyGraphQLWithOfflineSession } from "../../utils/shopifyAdmin.server.js";
import { summarizeVendorDeliveryPolicy } from "../../utils/productCountryPolicy.js";
import { getProductShippingMethodLabel } from "../../utils/productShippingProfile.js";
import { SHOPIFY_API_VERSION } from "../../utils/shopifyApiVersion.js";
import { formatDateTime, formatMoney, formatPublicResourceId, getFirstUserErrorMessage, isReconnectableShopifyError, mapApprovalLabel } from "./common.js";
const PRODUCT_INVENTORY_SYNC_TARGET_QUERY = `
  query ProductInventorySyncTarget($productId: ID!) {
    product(id: $productId) {
      id
      variants(first: 1) {
        nodes {
          id
          inventoryItem {
            id
            tracked
          }
        }
      }
    }
    locations(first: 1) {
      nodes {
        id
        name
      }
    }
  }
`;
const INVENTORY_ITEM_TRACKING_UPDATE_MUTATION = `
  mutation InventoryItemTrackingUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        tracked
      }
      userErrors {
        field
        message
      }
    }
  }
`;
const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        createdAt
        reason
      }
      userErrors {
        field
        message
      }
    }
  }
`;
export function mapVendorStatusLabel(value) {
  switch (value) {
    case "active":
      return "稼働中";
    case "applied":
      return "申請中";
    case "kyb_pending":
      return "審査中";
    case "restricted":
      return "制限あり";
    case "suspended":
      return "停止中";
    default:
      return value || "未設定";
  }
}
export function mapProductStatus(product) {
  if (product?.shopifyProductId) return "公開済み";
  if (product?.approvalStatus === "approved") return "公開準備中";
  if (product?.approvalStatus === "pending") return "審査中";
  if (product?.approvalStatus === "rejected") return "要確認";
  return "未公開";
}
function normalizeInventoryQuantity(value) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 0) {
    return null;
  }
  return numericValue;
}
export function parseInventoryQuantityInput(value) {
  const normalizedValue = String(value ?? "").trim();
  if (normalizedValue === "") {
    return {
      ok: true,
      quantity: null
    };
  }
  const numericValue = Number(normalizedValue);
  if (!Number.isInteger(numericValue) || numericValue < 0) {
    return {
      ok: false,
      error: "在庫数は0以上の整数で入力してください。"
    };
  }
  if (numericValue > 999999) {
    return {
      ok: false,
      error: "在庫数は999999以下で入力してください。"
    };
  }
  return {
    ok: true,
    quantity: numericValue
  };
}
export function buildInventoryDisplay(value) {
  const quantity = normalizeInventoryQuantity(value);
  if (quantity === null) {
    return {
      quantity: null,
      inputValue: "",
      stockLabel: "未設定",
      stockStatusLabel: "在庫入力待ち",
      stockStatusTone: "warning"
    };
  }
  if (quantity === 0) {
    return {
      quantity,
      inputValue: "0",
      stockLabel: "0点",
      stockStatusLabel: "在庫切れ",
      stockStatusTone: "danger"
    };
  }
  return {
    quantity,
    inputValue: String(quantity),
    stockLabel: `${quantity.toLocaleString("ja-JP")}点`,
    stockStatusLabel: "販売可能",
    stockStatusTone: "success"
  };
}
function buildInventorySyncDisplay(product) {
  if (!product?.shopifyProductId) {
    return {
      syncLabel: "公開後に同期",
      syncTone: "neutral",
      syncDetail: "商品公開後に在庫数が公開ストアへ反映されます。"
    };
  }
  if (product.inventorySyncError) {
    return {
      syncLabel: "同期要確認",
      syncTone: "warning",
      syncDetail: product.inventorySyncError
    };
  }
  if (product.inventorySyncedAt) {
    return {
      syncLabel: "同期済み",
      syncTone: "success",
      syncDetail: `最終同期: ${formatDateTime(product.inventorySyncedAt)}`
    };
  }
  return {
    syncLabel: "未同期",
    syncTone: "warning",
    syncDetail: "在庫数を保存すると公開ストアへ反映されます。"
  };
}
export function getBadgeTone(label) {
  if (["要確認", "差し戻し", "停止中", "制限あり"].includes(label)) {
    return "danger";
  }
  if (["審査中", "申請中", "公開準備中"].includes(label)) {
    return "warning";
  }
  if (["承認済み", "稼働中", "公開済み"].includes(label)) {
    return "success";
  }
  return "neutral";
}
export const PRODUCT_STATUS_FILTER_OPTIONS = [{
  value: "all",
  label: "すべて"
}, {
  value: "pending",
  label: "申請中"
}, {
  value: "review",
  label: "確認中"
}, {
  value: "approved",
  label: "承認済み・公開準備中"
}, {
  value: "linked",
  label: "公開済み"
}, {
  value: "rejected",
  label: "差し戻し"
}];
export function serializeVendorProduct(product) {
  const currencyCode = product.costCurrency || "JPY";
  const deliveryPolicy = summarizeVendorDeliveryPolicy(product);
  const statusLabel = mapProductStatus(product);
  const approvalLabel = mapApprovalLabel(product.approvalStatus);
  const inventoryDisplay = buildInventoryDisplay(product.inventoryQuantity);
  const inventorySyncDisplay = buildInventorySyncDisplay(product);
  return {
    id: product.id,
    name: product.name || "名称未設定",
    category: product.category || "未設定",
    sku: formatPublicResourceId(product.shopifyProductId),
    inventoryQuantity: inventoryDisplay.quantity,
    inventoryInputValue: inventoryDisplay.inputValue,
    stockLabel: inventoryDisplay.stockLabel,
    stockStatusLabel: inventoryDisplay.stockStatusLabel,
    stockStatusTone: inventoryDisplay.stockStatusTone,
    inventorySyncLabel: inventorySyncDisplay.syncLabel,
    inventorySyncTone: inventorySyncDisplay.syncTone,
    inventorySyncDetail: inventorySyncDisplay.syncDetail,
    trackingLabel: product.url || "-",
    salesLabel: "0",
    priceLabel: formatMoney(product.price || 0, currencyCode),
    currencyCode,
    statusLabel,
    statusTone: getBadgeTone(statusLabel),
    approvalLabel,
    approvalTone: getBadgeTone(approvalLabel),
    deliveryPolicyLabel: deliveryPolicy.label,
    deliveryPolicyTone: deliveryPolicy.tone,
    deliveryPolicyDetail: deliveryPolicy.detail,
    shippingMethodLabel: getProductShippingMethodLabel(product.internationalShippingMethod),
    shippingWeightLabel: product.shippingWeightGrams ? `${product.shippingWeightGrams}g` : "重量未設定",
    shippingSizeLabel: product.shippingLengthMm && product.shippingWidthMm && product.shippingHeightMm ? `${product.shippingLengthMm / 10} × ${product.shippingWidthMm / 10} × ${product.shippingHeightMm / 10}cm` : null,
    shopifyProductId: product.shopifyProductId || null,
    url: product.url || null,
    updatedAtLabel: formatDateTime(product.updatedAt)
  };
}
export function getVendorPublicContext(vendor, store) {
  return {
    vendor: {
      id: vendor.id,
      storeName: vendor.storeName,
      handle: vendor.handle,
      managementEmail: vendor.managementEmail,
      status: vendor.status,
      statusLabel: mapVendorStatusLabel(vendor.status)
    },
    store: {
      id: store.id,
      storeName: store.storeName,
      ownerName: store.ownerName,
      email: store.email,
      phone: store.phone,
      address: store.address,
      country: store.country,
      category: store.category
    }
  };
}
export async function listVendorProducts(storeId, filters = {}) {
  const name = String(filters.name || "").trim();
  const sku = String(filters.sku || "").trim();
  const tracking = String(filters.tracking || "").trim();
  const status = String(filters.status || "all").trim();
  const and = [{
    vendorStoreId: storeId
  }];
  if (name) {
    and.push({
      name: {
        contains: name,
        mode: "insensitive"
      }
    });
  }
  if (sku) {
    and.push({
      shopifyProductId: {
        contains: sku,
        mode: "insensitive"
      }
    });
  }
  if (tracking) {
    and.push({
      url: {
        contains: tracking,
        mode: "insensitive"
      }
    });
  }
  switch (status) {
    case "pending":
      and.push({
        approvalStatus: "pending"
      });
      break;
    case "review":
      and.push({
        approvalStatus: "review"
      });
      break;
    case "approved":
      and.push({
        approvalStatus: "approved"
      });
      and.push({
        shopifyProductId: null
      });
      break;
    case "linked":
      and.push({
        shopifyProductId: {
          not: null
        }
      });
      break;
    case "rejected":
      and.push({
        approvalStatus: "rejected"
      });
      break;
    default:
      break;
  }
  const where = {
    AND: and
  };
  const products = await prisma.product.findMany({
    where,
    include: {
      countryPolicy: true
    },
    orderBy: [{
      updatedAt: "desc"
    }, {
      createdAt: "desc"
    }]
  });
  return products.map(serializeVendorProduct);
}
function toPublicInventorySyncError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (isReconnectableShopifyError(message)) {
    return "公開ストアとの接続確認が必要です。管理者に連絡してください。";
  }
  if (message.includes("ACCESS_DENIED") || message.includes("access denied") || message.includes("read_inventory") || message.includes("write_inventory") || message.includes("read_locations")) {
    return "在庫同期に必要な権限が不足しています。管理者に連絡してください。";
  }
  return "公開ストアへの在庫反映に失敗しました。管理者に連絡してください。";
}
export async function syncShopifyInventoryQuantity({
  shopDomain,
  shopifyProductId,
  quantity,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
}) {
  const normalizedQuantity = Number(quantity);
  if (!shopDomain || !shopifyProductId) {
    throw new Error("SHOPIFY_INVENTORY_TARGET_MISSING");
  }
  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity < 0) {
    throw new Error("SHOPIFY_INVENTORY_QUANTITY_INVALID");
  }
  const {
    data: targetData
  } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PRODUCT_INVENTORY_SYNC_TARGET_QUERY,
    variables: {
      productId: shopifyProductId
    }
  });
  const product = targetData?.product;
  const variant = product?.variants?.nodes?.[0];
  const inventoryItem = variant?.inventoryItem;
  const location = targetData?.locations?.nodes?.[0];
  if (!product?.id || !variant?.id) {
    throw new Error("SHOPIFY_PRODUCT_VARIANT_NOT_FOUND");
  }
  if (!inventoryItem?.id) {
    throw new Error("SHOPIFY_INVENTORY_ITEM_NOT_FOUND");
  }
  if (!location?.id) {
    throw new Error("SHOPIFY_LOCATION_NOT_FOUND");
  }
  if (inventoryItem.tracked === false) {
    const {
      data: trackingData
    } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: INVENTORY_ITEM_TRACKING_UPDATE_MUTATION,
      variables: {
        id: inventoryItem.id,
        input: {
          tracked: true
        }
      }
    });
    const trackingPayload = trackingData?.inventoryItemUpdate;
    const trackingError = getFirstUserErrorMessage(trackingPayload?.userErrors, null);
    if (!trackingPayload || trackingError) {
      throw new Error(trackingError || "SHOPIFY_INVENTORY_TRACKING_UPDATE_FAILED");
    }
  }
  const {
    data: setData
  } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: INVENTORY_SET_QUANTITIES_MUTATION,
    variables: {
      idempotencyKey: `vendor-register-inventory-${randomUUID()}`,
      input: {
        ignoreCompareQuantity: true,
        name: "available",
        reason: "correction",
        referenceDocumentUri: `vendor-register://inventory/${encodeURIComponent(shopifyProductId)}`,
        quantities: [{
          inventoryItemId: inventoryItem.id,
          locationId: location.id,
          quantity: normalizedQuantity,
          compareQuantity: null
        }]
      }
    }
  });
  const setPayload = setData?.inventorySetQuantities;
  const setError = getFirstUserErrorMessage(setPayload?.userErrors, null);
  if (!setPayload || setError) {
    throw new Error(setError || "SHOPIFY_INVENTORY_SET_QUANTITIES_FAILED");
  }
  return {
    ok: true,
    inventoryItemId: inventoryItem.id,
    locationId: location.id,
    locationName: location.name || null,
    quantity: normalizedQuantity
  };
}
export async function updateVendorProductInventory({
  storeId,
  productId,
  inventoryQuantity,
  prismaClient = prisma,
  syncShopifyInventoryQuantityImpl = syncShopifyInventoryQuantity,
  now = () => new Date()
}) {
  const parsedQuantity = parseInventoryQuantityInput(inventoryQuantity);
  if (!parsedQuantity.ok) {
    return {
      ok: false,
      status: 400,
      error: parsedQuantity.error
    };
  }
  const product = await prismaClient.product.findFirst({
    where: {
      id: String(productId || ""),
      vendorStoreId: storeId
    },
    select: {
      id: true,
      shopDomain: true,
      shopifyProductId: true
    }
  });
  if (!product) {
    return {
      ok: false,
      status: 404,
      error: "商品が見つかりません。"
    };
  }
  let updatedProduct = await prismaClient.product.update({
    where: {
      id: product.id
    },
    data: {
      inventoryQuantity: parsedQuantity.quantity,
      inventorySyncedAt: null,
      inventorySyncError: null
    }
  });
  let warning = null;
  if (updatedProduct.shopifyProductId && updatedProduct.shopDomain) {
    try {
      await syncShopifyInventoryQuantityImpl({
        shopDomain: updatedProduct.shopDomain,
        shopifyProductId: updatedProduct.shopifyProductId,
        quantity: parsedQuantity.quantity ?? 0
      });
      updatedProduct = await prismaClient.product.update({
        where: {
          id: updatedProduct.id
        },
        data: {
          inventorySyncedAt: now(),
          inventorySyncError: null
        }
      });
    } catch (error) {
      const publicError = toPublicInventorySyncError(error);
      console.error("vendor inventory sync error:", error);
      updatedProduct = await prismaClient.product.update({
        where: {
          id: updatedProduct.id
        },
        data: {
          inventorySyncedAt: null,
          inventorySyncError: publicError
        }
      });
      warning = publicError;
    }
  }
  return {
    ok: true,
    product: serializeVendorProduct(updatedProduct),
    warning
  };
}
async function shopifyGraphQL(shopDomain, query, variables = {}) {
  return shopifyGraphQLWithOfflineSession({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query,
    variables
  });
}
async function deleteShopifyProduct(shopDomain, shopifyProductId) {
  const mutation = `
    mutation DeleteProduct($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }
  `;
  try {
    const {
      data
    } = await shopifyGraphQL(shopDomain, mutation, {
      input: {
        id: shopifyProductId
      }
    });
    const payload = data?.productDelete;
    const userErrors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
    if (userErrors.length > 0) {
      const message = userErrors[0]?.message || "公開ストアで商品の削除に失敗しました。";
      if (message.includes("does not exist") || message.includes("Product does not exist")) {
        return {
          ok: true,
          alreadyDeleted: true
        };
      }
      return {
        ok: false,
        error: message,
        needsReconnect: isReconnectableShopifyError(message)
      };
    }
    return {
      ok: true,
      deletedProductId: payload?.deletedProductId || null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "公開ストアで商品の削除に失敗しました。";
    return {
      ok: false,
      error: message,
      needsReconnect: isReconnectableShopifyError(message)
    };
  }
}
export async function deleteVendorProductForStore({
  storeId,
  productId
}) {
  const normalizedProductId = String(productId || "").trim();
  if (!normalizedProductId) {
    return {
      ok: false,
      status: 400,
      publicError: "商品IDがありません。",
      needsReconnect: false
    };
  }
  const product = await prisma.product.findUnique({
    where: {
      id: normalizedProductId
    }
  });
  if (!product || product.vendorStoreId !== storeId) {
    return {
      ok: false,
      status: 404,
      publicError: "商品が見つかりません。",
      needsReconnect: false
    };
  }
  if (product.shopifyProductId) {
    if (!product.shopDomain) {
      return {
        ok: false,
        status: 500,
        publicError: "公開ストアとの接続設定を確認してから、もう一度お試しください。",
        needsReconnect: true
      };
    }
    const shopifyDelete = await deleteShopifyProduct(product.shopDomain, product.shopifyProductId);
    if (!shopifyDelete.ok) {
      console.error("vendor product delete error:", shopifyDelete.error);
      return {
        ok: false,
        status: 500,
        publicError: shopifyDelete.needsReconnect ? "公開ストアとの接続を確認してから、もう一度お試しください。" : "商品の削除に失敗しました。時間を置いて再度お試しください。",
        needsReconnect: shopifyDelete.needsReconnect || false
      };
    }
  }
  await prisma.product.delete({
    where: {
      id: normalizedProductId
    }
  });
  return {
    ok: true
  };
}
