import prisma from "../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "./constants.js";
import { clampInteger, isPlainObject, normalizeLowercase, normalizeText, toPositiveInteger } from "./values.js";
import { getStripeClient, getStripePublishableKey } from "./shared.server.js";
const DEFAULT_PLATFORM_FEE_BPS = 1000;
function toDisplayPrice(product) {
  const calculatedPrice = Number(product?.calculatedPrice);
  if (Number.isFinite(calculatedPrice) && calculatedPrice > 0) {
    return Math.round(calculatedPrice);
  }
  const basePrice = Number(product?.price);
  if (Number.isFinite(basePrice) && basePrice > 0) {
    return Math.round(basePrice);
  }
  return 0;
}
function calculatePlatformFeeAmount(totalAmount, feeBps = DEFAULT_PLATFORM_FEE_BPS) {
  const normalizedTotal = clampInteger(totalAmount, 0);
  const normalizedBps = Number.isFinite(Number(feeBps)) ? Math.max(0, Math.round(Number(feeBps))) : DEFAULT_PLATFORM_FEE_BPS;
  return Math.min(normalizedTotal, Math.floor(normalizedTotal * normalizedBps / 10000));
}
export function getPlatformFeeBps() {
  return Number(process.env.STRIPE_PLATFORM_FEE_BPS || DEFAULT_PLATFORM_FEE_BPS);
}
function normalizeCheckoutItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map(item => {
    const productId = normalizeText(item?.productId || item?.id || item?.localProductId);
    const quantity = toPositiveInteger(item?.quantity || item?.qty);
    if (!productId || quantity == null) {
      return null;
    }
    return {
      productId,
      quantity
    };
  }).filter(Boolean);
}
function normalizeShippingAddress(address) {
  if (!isPlainObject(address)) {
    return null;
  }
  const normalized = {
    firstName: normalizeText(address.firstName),
    lastName: normalizeText(address.lastName),
    address1: normalizeText(address.address1),
    address2: normalizeText(address.address2),
    city: normalizeText(address.city),
    province: normalizeText(address.province),
    postalCode: normalizeText(address.postalCode),
    country: normalizeText(address.country),
    phone: normalizeText(address.phone)
  };
  return normalized.address1 && normalized.city && normalized.postalCode && normalized.country ? normalized : null;
}
function normalizeCheckoutCustomer(customer) {
  if (!isPlainObject(customer)) {
    return null;
  }
  const normalized = {
    firstName: normalizeText(customer.firstName),
    lastName: normalizeText(customer.lastName),
    email: normalizeLowercase(customer.email),
    phone: normalizeText(customer.phone)
  };
  return normalized.email ? normalized : null;
}
function serializeOrderLineItems(productsById, items) {
  return items.map(item => {
    const product = productsById.get(item.productId);
    const unitAmount = toDisplayPrice(product);
    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitAmount,
      totalAmount: unitAmount * item.quantity
    };
  });
}
async function loadVendorForCheckout(handle, prismaClient = prisma) {
  const normalizedHandle = normalizeText(handle);
  if (!normalizedHandle) {
    return null;
  }
  return prismaClient.vendor.findUnique({
    where: {
      handle: normalizedHandle
    },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true
        }
      }
    }
  });
}
export async function createCheckoutOrder(payload, {
  prismaClient = prisma
} = {}) {
  const vendorHandle = normalizeText(payload?.vendorHandle || payload?.handle);
  const items = normalizeCheckoutItems(payload?.items);
  const customer = normalizeCheckoutCustomer(payload?.customer);
  const shippingAddress = normalizeShippingAddress(payload?.shippingAddress);
  if (!vendorHandle || items.length === 0 || !customer || !shippingAddress) {
    return {
      ok: false,
      reason: "invalid_payload"
    };
  }
  const vendor = await loadVendorForCheckout(vendorHandle, prismaClient);
  if (!vendor?.vendorStore?.id || !vendor?.seller) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  if (vendor.seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active"
    };
  }
  if (!vendor.seller.stripeAccount?.stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing"
    };
  }
  const uniqueProductIds = Array.from(new Set(items.map(item => item.productId)));
  const products = await prismaClient.product.findMany({
    where: {
      id: {
        in: uniqueProductIds
      },
      vendorStoreId: vendor.vendorStore.id,
      approvalStatus: "approved"
    },
    select: {
      id: true,
      name: true,
      price: true,
      calculatedPrice: true
    }
  });
  if (products.length !== uniqueProductIds.length) {
    return {
      ok: false,
      reason: "invalid_items"
    };
  }
  const productsById = new Map(products.map(product => [product.id, product]));
  const lineItems = serializeOrderLineItems(productsById, items);
  const subtotalAmount = lineItems.reduce((sum, lineItem) => sum + lineItem.totalAmount, 0);
  const applicationFeeAmount = calculatePlatformFeeAmount(subtotalAmount, getPlatformFeeBps());
  const order = await prismaClient.order.create({
    data: {
      sellerId: vendor.seller.id,
      sellerStripeAccountId: vendor.seller.stripeAccount.id,
      stripeAccountId: vendor.seller.stripeAccount.stripeAccountId,
      status: "draft",
      currencyCode: DEFAULT_ORDER_CURRENCY,
      subtotalAmount,
      applicationFeeAmount,
      totalAmount: subtotalAmount,
      customerEmail: customer.email,
      customerFirstName: customer.firstName,
      customerLastName: customer.lastName,
      customerPhone: customer.phone,
      shippingAddressJson: shippingAddress,
      lineItemsJson: lineItems
    }
  });
  return {
    ok: true,
    order: {
      id: order.id,
      status: order.status,
      currencyCode: order.currencyCode,
      subtotalAmount: order.subtotalAmount,
      applicationFeeAmount: order.applicationFeeAmount,
      totalAmount: order.totalAmount,
      lineItems
    }
  };
}
async function loadCheckoutOrder(orderId, prismaClient = prisma) {
  return prismaClient.order.findUnique({
    where: {
      id: orderId
    },
    include: {
      seller: {
        include: {
          vendor: true,
          stripeAccount: true
        }
      },
      sellerStripeAccount: true
    }
  });
}
export async function createCheckoutOrderPaymentIntent({
  orderId
}, {
  prismaClient = prisma,
  stripeClient = getStripeClient()
} = {}) {
  const order = await loadCheckoutOrder(orderId, prismaClient);
  if (!order?.seller) {
    return {
      ok: false,
      reason: "order_not_found"
    };
  }
  if (order.seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active"
    };
  }
  const stripeAccountId = order.sellerStripeAccount?.stripeAccountId || order.stripeAccountId;
  if (!stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing"
    };
  }
  if (order.stripePaymentIntentId) {
    try {
      const existingIntent = await stripeClient.paymentIntents.retrieve(order.stripePaymentIntentId, {}, {
        stripeAccount: stripeAccountId
      });
      return {
        ok: true,
        created: false,
        paymentIntentId: existingIntent.id,
        clientSecret: existingIntent.client_secret,
        status: existingIntent.status,
        publishableKey: getStripePublishableKey()
      };
    } catch (error) {
      const code = normalizeText(error?.code);
      if (code !== "resource_missing") {
        throw error;
      }
    }
  }
  const paymentIntent = await stripeClient.paymentIntents.create({
    amount: order.totalAmount,
    currency: normalizeLowercase(order.currencyCode) || DEFAULT_ORDER_CURRENCY,
    application_fee_amount: order.applicationFeeAmount,
    automatic_payment_methods: {
      enabled: true
    },
    receipt_email: order.customerEmail,
    metadata: {
      orderId: order.id,
      sellerId: order.sellerId,
      vendorId: order.seller.vendorId
    }
  }, {
    stripeAccount: stripeAccountId
  });
  await prismaClient.order.update({
    where: {
      id: order.id
    },
    data: {
      status: "payment_intent_created",
      stripePaymentIntentId: paymentIntent.id
    }
  });
  return {
    ok: true,
    created: true,
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    status: paymentIntent.status,
    publishableKey: getStripePublishableKey()
  };
}
export async function createOrderRefund({
  orderId,
  amount = null,
  refundApplicationFee
}, {
  prismaClient = prisma,
  stripeClient = getStripeClient()
} = {}) {
  if (typeof refundApplicationFee !== "boolean") {
    return {
      ok: false,
      reason: "refund_application_fee_required"
    };
  }
  const order = await loadCheckoutOrder(orderId, prismaClient);
  if (!order) {
    return {
      ok: false,
      reason: "order_not_found"
    };
  }
  const stripeAccountId = order.sellerStripeAccount?.stripeAccountId || order.stripeAccountId;
  if (!stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing"
    };
  }
  if (!order.stripeChargeId) {
    return {
      ok: false,
      reason: "charge_missing"
    };
  }
  const refundParams = {
    charge: order.stripeChargeId,
    refund_application_fee: refundApplicationFee,
    metadata: {
      orderId: order.id,
      sellerId: order.sellerId
    }
  };
  const refundAmount = toPositiveInteger(amount);
  if (refundAmount != null) {
    refundParams.amount = refundAmount;
  }
  const refund = await stripeClient.refunds.create(refundParams, {
    stripeAccount: stripeAccountId
  });
  return {
    ok: true,
    refund
  };
}
