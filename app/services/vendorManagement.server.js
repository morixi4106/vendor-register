import { createCookie, redirect } from "@remix-run/node";
import prisma from "../db.server";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server";

const SHOPIFY_API_VERSION = "2026-01";

export const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export function formatMoney(amount, currencyCode = "JPY") {
  const numericAmount = Number(amount || 0);

  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(numericAmount);
  } catch {
    return `${Math.round(numericAmount).toLocaleString("ja-JP")} ${currencyCode}`;
  }
}

export function formatDateTime(value) {
  if (!value) return "未設定";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未設定";

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function mapApprovalLabel(value) {
  switch (value) {
    case "approved":
      return "承認済み";
    case "pending":
      return "申請中";
    case "rejected":
      return "差し戻し";
    case "review":
      return "確認中";
    default:
      return "未設定";
  }
}

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
  if (product?.shopifyProductId) return "Shopify連携済み";
  if (product?.approvalStatus === "approved") return "公開準備中";
  if (product?.approvalStatus === "pending") return "審査中";
  if (product?.approvalStatus === "rejected") return "要確認";
  return "未連携";
}

export function getBadgeTone(label) {
  if (["要確認", "差し戻し", "停止中", "制限あり"].includes(label)) {
    return "danger";
  }

  if (["審査中", "申請中", "公開準備中"].includes(label)) {
    return "warning";
  }

  if (["承認済み", "稼働中", "Shopify連携済み"].includes(label)) {
    return "success";
  }

  return "neutral";
}

export const PRODUCT_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "全て" },
  { value: "pending", label: "申請中" },
  { value: "review", label: "確認中" },
  { value: "approved", label: "承認済み（未連携）" },
  { value: "linked", label: "Shopify連携済み" },
  { value: "rejected", label: "差し戻し" },
];

export function serializeVendorProduct(product) {
  return {
    id: product.id,
    name: product.name || "名称未設定",
    category: product.category || "未設定",
    sku: product.shopifyProductId || "-",
    stockLabel: "未連携",
    trackingLabel: product.url || "-",
    salesLabel: "0",
    priceLabel: formatMoney(product.price || 0, "JPY"),
    statusLabel: mapProductStatus(product),
    approvalLabel: mapApprovalLabel(product.approvalStatus),
    shopifyProductId: product.shopifyProductId || null,
    url: product.url || null,
    updatedAtLabel: formatDateTime(product.updatedAt),
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
      statusLabel: mapVendorStatusLabel(vendor.status),
    },
    store: {
      id: store.id,
      storeName: store.storeName,
      ownerName: store.ownerName,
      email: store.email,
      phone: store.phone,
      address: store.address,
      country: store.country,
      category: store.category,
    },
  };
}

export async function updateVendorSettings({
  vendorId,
  storeId,
  storeName,
  managementEmail,
}) {
  const normalizedStoreName = String(storeName || "").trim();
  const normalizedManagementEmail = String(managementEmail || "").trim();

  try {
    await prisma.$transaction(async (tx) => {
      const vendorResult = await tx.vendor.updateMany({
        where: {
          id: vendorId,
          vendorStoreId: storeId,
        },
        data: {
          storeName: normalizedStoreName,
          managementEmail: normalizedManagementEmail,
        },
      });

      if (vendorResult.count !== 1) {
        throw new Error("VENDOR_SETTINGS_NOT_FOUND");
      }

      const storeResult = await tx.vendorStore.updateMany({
        where: {
          id: storeId,
        },
        data: {
          storeName: normalizedStoreName,
        },
      });

      if (storeResult.count !== 1) {
        throw new Error("VENDOR_SETTINGS_NOT_FOUND");
      }
    });

    return { ok: true };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "VENDOR_SETTINGS_NOT_FOUND"
    ) {
      return {
        ok: false,
        status: 404,
        publicError: "店舗情報が見つかりません。",
      };
    }

    console.error("vendor settings update error:", error);

    return {
      ok: false,
      status: 500,
      publicError: "設定の保存に失敗しました。時間を置いて再度お試しください。",
    };
  }
}

export async function requireVendorSession(request, { includeProducts = false } = {}) {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("/vendor/verify");
  }

  const vendorSession = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          vendorStore: includeProducts
            ? {
                include: {
                  products: {
                    orderBy: {
                      updatedAt: "desc",
                    },
                  },
                },
              }
            : true,
        },
      },
    },
  });

  if (!vendorSession || vendorSession.expiresAt < new Date()) {
    throw redirect("/vendor/verify", {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  return vendorSession;
}

export async function requireVendorContext(request, options = {}) {
  const vendorSession = await requireVendorSession(request, options);
  const vendor = vendorSession.vendor;
  const store = vendor?.vendorStore;

  if (!vendor || !store) {
    throw new Response("店舗情報が見つかりません。", { status: 404 });
  }

  return { vendorSession, vendor, store };
}

export async function listVendorProducts(storeId, filters = {}) {
  const name = String(filters.name || "").trim();
  const sku = String(filters.sku || "").trim();
  const tracking = String(filters.tracking || "").trim();
  const status = String(filters.status || "all").trim();
  const and = [{ vendorStoreId: storeId }];

  if (name) {
    and.push({
      name: {
        contains: name,
        mode: "insensitive",
      },
    });
  }

  if (sku) {
    and.push({
      shopifyProductId: {
        contains: sku,
        mode: "insensitive",
      },
    });
  }

  if (tracking) {
    and.push({
      url: {
        contains: tracking,
        mode: "insensitive",
      },
    });
  }

  switch (status) {
    case "pending":
      and.push({ approvalStatus: "pending" });
      break;
    case "review":
      and.push({ approvalStatus: "review" });
      break;
    case "approved":
      and.push({ approvalStatus: "approved" });
      and.push({ shopifyProductId: null });
      break;
    case "linked":
      and.push({
        shopifyProductId: {
          not: null,
        },
      });
      break;
    case "rejected":
      and.push({ approvalStatus: "rejected" });
      break;
    default:
      break;
  }

  const where = {
    AND: and,
  };

  const products = await prisma.product.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });

  return products.map(serializeVendorProduct);
}

function isReconnectableShopifyError(message = "") {
  return (
    message.includes("Shopify authentication is required") ||
    message.includes("Invalid API key or access token") ||
    message.includes("401") ||
    message.includes("Offline session not found")
  );
}

async function shopifyGraphQL(shopDomain, query, variables = {}) {
  return shopifyGraphQLWithOfflineSession({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query,
    variables,
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
    const { data } = await shopifyGraphQL(shopDomain, mutation, {
      input: { id: shopifyProductId },
    });

    const payload = data?.productDelete;
    const userErrors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];

    if (userErrors.length > 0) {
      const message = userErrors[0]?.message || "Shopifyで商品の削除に失敗しました。";

      if (
        message.includes("does not exist") ||
        message.includes("Product does not exist")
      ) {
        return { ok: true, alreadyDeleted: true };
      }

      return {
        ok: false,
        error: message,
        needsReconnect: isReconnectableShopifyError(message),
      };
    }

    return {
      ok: true,
      deletedProductId: payload?.deletedProductId || null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Shopifyで商品の削除に失敗しました。";

    return {
      ok: false,
      error: message,
      needsReconnect: isReconnectableShopifyError(message),
    };
  }
}

export async function deleteVendorProductForStore({ storeId, productId }) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    return {
      ok: false,
      status: 400,
      publicError: "商品IDがありません。",
      needsReconnect: false,
    };
  }

  const product = await prisma.product.findUnique({
    where: { id: normalizedProductId },
  });

  if (!product || product.vendorStoreId !== storeId) {
    return {
      ok: false,
      status: 404,
      publicError: "商品が見つかりません。",
      needsReconnect: false,
    };
  }

  if (product.shopifyProductId) {
    if (!product.shopDomain) {
      return {
        ok: false,
        status: 500,
        publicError:
          "Shopifyとの接続設定を確認してから、もう一度お試しください。",
        needsReconnect: true,
      };
    }

    const shopifyDelete = await deleteShopifyProduct(
      product.shopDomain,
      product.shopifyProductId
    );

    if (!shopifyDelete.ok) {
      console.error("vendor product delete error:", shopifyDelete.error);
      return {
        ok: false,
        status: 500,
        publicError: shopifyDelete.needsReconnect
          ? "Shopifyとの接続を確認してから、もう一度お試しください。"
          : "商品の削除に失敗しました。時間を置いて再度お試しください。",
        needsReconnect: shopifyDelete.needsReconnect || false,
      };
    }
  }

  await prisma.product.delete({
    where: { id: normalizedProductId },
  });

  return { ok: true };
}
