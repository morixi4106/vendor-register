import prisma from "../../db.server.js";
import { formatMoney, formatPublicResourceId, mapApprovalLabel } from "./common.js";
function createMonthlyReportRange(month) {
  const normalizedMonth = String(month || "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(normalizedMonth);
  if (!match) {
    throw new Error("INVALID_REPORT_MONTH");
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  if (monthIndex < 1 || monthIndex > 12) {
    throw new Error("INVALID_REPORT_MONTH");
  }
  return {
    start: new Date(year, monthIndex - 1, 1),
    end: new Date(year, monthIndex, 1)
  };
}
function serializeVendorMonthlyReportProduct(product) {
  const currencyCode = product.costCurrency || "JPY";
  return {
    id: product.id,
    name: product.name || "名称未設定",
    priceLabel: formatMoney(product.price || 0, currencyCode),
    currencyCode,
    approvalLabel: mapApprovalLabel(product.approvalStatus),
    shopifyStatusLabel: product.shopifyProductId ? "公開済み" : "未公開",
    url: product.url || null,
    shopifyProductId: product.shopifyProductId || null,
    publicProductIdLabel: formatPublicResourceId(product.shopifyProductId)
  };
}
export async function getVendorMonthlyReport({
  storeId,
  month
}) {
  const {
    start,
    end
  } = createMonthlyReportRange(month);
  const products = await prisma.product.findMany({
    where: {
      vendorStoreId: storeId,
      createdAt: {
        gte: start,
        lt: end
      }
    },
    orderBy: [{
      createdAt: "desc"
    }, {
      updatedAt: "desc"
    }],
    select: {
      id: true,
      name: true,
      price: true,
      costCurrency: true,
      approvalStatus: true,
      url: true,
      shopifyProductId: true
    }
  });
  const summary = {
    total: products.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    linked: 0
  };
  for (const product of products) {
    if (product.approvalStatus === "approved") {
      summary.approved += 1;
    }
    if (product.approvalStatus === "rejected") {
      summary.rejected += 1;
    }
    if (product.approvalStatus === "pending" || product.approvalStatus === "review") {
      summary.pending += 1;
    }
    if (product.shopifyProductId) {
      summary.linked += 1;
    }
  }
  return {
    summary,
    products: products.map(serializeVendorMonthlyReportProduct)
  };
}
