import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDraftOrderCheckoutLoader,
} from '../../app/services/draftOrderCheckout.server.js';
import { SALES_CREDIT_PAYMENT_RISK_CLASSES } from '../../app/services/sellerPayments.server.js';
import { vendorAdminSessionCookie } from '../../app/services/vendorManagement.server.js';
import { createPublicVendorDraftOrderCheckoutAction } from '../../app/services/vendorStorefront.server.js';

process.env.PRIVACY_HASH_SECRET = 'test-privacy-hash-secret-with-at-least-32-chars';
process.env.PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED = 'true';

const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';
const OUT_OF_STOCK_MESSAGE =
  '選択した商品の在庫数を確認してください。数量を変更して、もう一度お試しください。';
const UNAVAILABLE_PRODUCT_MESSAGE =
  '選択した商品は購入できません。内容を確認して、もう一度お試しください。';

const TRUSTED_SALES_CREDIT_METADATA = {
  salesCreditPaymentRiskClass:
    SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
  salesCreditPaymentRiskRateBps: 10000,
};

const MULTI_SELLER_CHECKOUT_ENV = {
  PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED: 'true',
  MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: 'true',
  MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED: 'true',
  MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED: 'true',
  MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED: 'true',
  MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED: 'true',
  VENDOR_ORDERS_USE_SELLER_ORDERS: 'true',
};

function createVendorStoreRelation({
  id,
  handle,
  storeName,
  sellerId,
  country = 'JP',
  category = 'Wine',
}) {
  return {
    id,
    isTestStore: false,
    isPlatformStore: true,
    storeName,
    ownerName: `${storeName} Owner`,
    country,
    category,
    note: null,
    vendorAuth: {
      id: `vendor_${id}`,
      handle,
      storeName,
      managementEmail: `${handle}@example.com`,
      status: 'active',
      seller: {
        id: sellerId,
        status: 'active',
        euSellerStatus: 'DISABLED',
      },
    },
    seller: {
      id: sellerId,
      status: 'active',
      euSellerStatus: 'DISABLED',
    },
  };
}

function createMultiSellerProducts() {
  const [first, pending, other] = createProducts();

  return [
    {
      ...first,
      vendorStore: createVendorStoreRelation({
        id: 'store_1',
        handle: 'amber-cellar',
        storeName: 'Amber Cellar',
        sellerId: 'seller_target',
      }),
    },
    pending,
    {
      ...other,
      shopDomain: 'shop-a.myshopify.com',
      vendorStore: createVendorStoreRelation({
        id: 'store_2',
        handle: 'blue-cellar',
        storeName: 'Blue Cellar',
        sellerId: 'seller_other',
      }),
    },
  ];
}

function createProducts() {
  return [
    {
      id: 'prod_1',
      name: 'Amber Wine',
      description: 'Skin contact white',
      imageUrl: null,
      price: 4200,
      category: '雑貨・小物',
      calculatedPrice: 4200,
      inventoryQuantity: 10,
      url: 'https://example.com/products/amber-wine',
      shopDomain: 'shop-a.myshopify.com',
      shopifyProductId: 'gid://shopify/Product/1',
      approvalStatus: 'approved',
      vendorStoreId: 'store_1',
      productEuStatus: 'DISABLED',
      countryPolicy: null,
      vendorStore: {
        isTestStore: false,
        isPlatformStore: true,
      },
    },
    {
      id: 'prod_pending',
      name: 'Pending Bottle',
      description: 'Pending review',
      imageUrl: null,
      price: 3800,
      category: '雑貨・小物',
      calculatedPrice: 3800,
      inventoryQuantity: 10,
      url: 'https://example.com/products/pending-bottle',
      shopDomain: 'shop-a.myshopify.com',
      shopifyProductId: 'gid://shopify/Product/2',
      approvalStatus: 'pending',
      vendorStoreId: 'store_1',
      productEuStatus: 'DISABLED',
      countryPolicy: null,
      vendorStore: {
        isTestStore: false,
        isPlatformStore: true,
      },
    },
    {
      id: 'prod_other',
      name: 'Other Store Bottle',
      description: 'Other vendor item',
      imageUrl: null,
      price: 5000,
      category: '雑貨・小物',
      calculatedPrice: 5000,
      inventoryQuantity: 10,
      url: 'https://example.com/products/other-store-bottle',
      shopDomain: 'shop-b.myshopify.com',
      shopifyProductId: 'gid://shopify/Product/3',
      approvalStatus: 'approved',
      vendorStoreId: 'store_2',
      productEuStatus: 'DISABLED',
      countryPolicy: null,
      vendorStore: {
        isTestStore: false,
        isPlatformStore: true,
      },
    },
  ];
}

function projectProduct(product, select) {
  if (!select) {
    return { ...product };
  }

  const projected = {};

  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) {
      projected[key] = product[key];
    }
  }

  return projected;
}

function createVerifiedSeller(overrides = {}) {
  return {
    id: 'seller_buyer',
    status: 'active',
    phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    documentVerificationStatus: 'VERIFIED',
    verificationNameMatched: true,
    payoutNameMatched: true,
    payoutRecipient: {
      status: 'active',
      provider: 'manual',
      accountHolderName: 'Buyer Seller',
      accountSummary: 'Manual settlement',
    },
    ...overrides,
  };
}

function createFakePrisma({
  products = createProducts(),
  seller = null,
  sessionToken = 'seller-session',
  sessionVendor = null,
  sellers = [],
  ledgerEntries = [],
  salesCreditOffsets = [],
  payoutRuns = [],
  buyerWarningRecords = [],
} = {}) {
  const sellerRecords = new Map();

  for (const sellerRecord of [seller, sessionVendor?.seller, ...sellers].filter(Boolean)) {
    sellerRecords.set(sellerRecord.id, sellerRecord);
  }

  return {
    vendor: {
      async findUnique({ where }) {
        if (where.handle !== 'amber-cellar') {
          return null;
        }

        return {
          id: 'vendor_1',
          handle: 'amber-cellar',
          storeName: 'Amber Cellar',
          managementEmail: 'owner@example.com',
          status: 'active',
          seller,
          vendorStore: {
            id: 'store_1',
            storeName: 'Amber Cellar',
            ownerName: 'Owner',
            country: 'JP',
            category: 'Wine',
            note: 'Natural wine selection',
          },
        };
      },
    },
    vendorAdminSession: {
      async findUnique({ where }) {
        if (!sessionVendor || where.sessionToken !== sessionToken) {
          return null;
        }

        return {
          id: 'session_1',
          sessionToken,
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          vendor: sessionVendor,
        };
      },
    },
    seller: {
      async findUnique({ where }) {
        return sellerRecords.get(where.id) || null;
      },
    },
    ledgerEntry: {
      async findMany({ where }) {
        return ledgerEntries.filter((entry) => {
          if (where?.sellerId && entry.sellerId !== where.sellerId) {
            return false;
          }

          if (where?.currencyCode && entry.currencyCode !== where.currencyCode) {
            return false;
          }

          if (where?.entryType?.in && !where.entryType.in.includes(entry.entryType)) {
            return false;
          }

          return true;
        });
      },
    },
    salesCreditOffset: {
      async findUnique({ where }) {
        if (where.idempotencyKey) {
          return (
            salesCreditOffsets.find(
              (offset) => offset.idempotencyKey === where.idempotencyKey,
            ) || null
          );
        }

        return salesCreditOffsets.find((offset) => offset.id === where.id) || null;
      },
      async findMany({ where }) {
        return salesCreditOffsets.filter((offset) => {
          if (where?.sellerId && offset.sellerId !== where.sellerId) {
            return false;
          }

          if (where?.currencyCode && offset.currencyCode !== where.currencyCode) {
            return false;
          }

          if (where?.status?.in && !where.status.in.includes(offset.status)) {
            return false;
          }

          return true;
        });
      },
      async create({ data }) {
        const offset = {
          id: `sco_${salesCreditOffsets.length + 1}`,
          createdAt: new Date('2026-06-01T00:00:00Z'),
          updatedAt: new Date('2026-06-01T00:00:00Z'),
          ...data,
        };
        salesCreditOffsets.push(offset);
        return offset;
      },
      async update({ where, data }) {
        const index = salesCreditOffsets.findIndex(
          (offset) => offset.id === where.id,
        );

        if (index === -1) {
          return null;
        }

        salesCreditOffsets[index] = {
          ...salesCreditOffsets[index],
          ...data,
          updatedAt: new Date('2026-06-01T00:00:00Z'),
        };
        return salesCreditOffsets[index];
      },
    },
    payoutRun: {
      async findMany({ where }) {
        return payoutRuns.filter((payoutRun) => {
          if (where?.sellerId && payoutRun.sellerId !== where.sellerId) {
            return false;
          }

          if (where?.currencyCode && payoutRun.currencyCode !== where.currencyCode) {
            return false;
          }

          if (where?.status?.in && !where.status.in.includes(payoutRun.status)) {
            return false;
          }

          return true;
        });
      },
    },
    product: {
      async findMany({ where, select }) {
        return products
          .filter((product) => {
            if (where?.vendorStoreId && product.vendorStoreId !== where.vendorStoreId) {
              return false;
            }

            if (where?.approvalStatus && product.approvalStatus !== where.approvalStatus) {
              return false;
            }

            if (where?.id?.in && !where.id.in.includes(product.id)) {
              return false;
            }

            return true;
          })
          .map((product) => projectProduct(product, select));
      },
    },
    buyerWarningAcceptance: {
      async create({ data }) {
        const record = {
          id: `bwa_${buyerWarningRecords.length + 1}`,
          ...data,
        };
        buyerWarningRecords.push(record);
        return record;
      },
    },
  };
}

function createValidBody(overrides = {}) {
  return {
    vendorHandle: 'amber-cellar',
    items: [
      {
        productId: 'prod_1',
        quantity: 2,
      },
    ],
    customer: {
      firstName: 'Taro',
      lastName: 'Yamada',
      email: 'taro@example.com',
      phone: '09012345678',
    },
    shippingAddress: {
      address1: '1-2-3 Jingumae',
      city: 'Shibuya',
      province: 'Tokyo',
      postalCode: '150-0001',
      country: 'JP',
    },
    ...overrides,
  };
}

function createShopifyFallbackBody(overrides = {}) {
  return createValidBody({
    items: [
      {
        shopifyProductId: 'gid://shopify/Product/999',
        quantity: 1,
        price: 1,
      },
    ],
    shopDomain: 'evil-shop.myshopify.com',
    ...overrides,
  });
}

function createShopifyGraphQLStub({ productVariants, variant } = {}) {
  return async ({ shopDomain, query, variables }) => {
    assert.equal(shopDomain, 'shop-a.myshopify.com');
    assert.equal(query.includes('requiresShipping'), true);
    assert.equal(query.includes('inventoryItem'), true);

    if (query.includes('productVariant')) {
      return {
        data: {
          productVariant:
            variant ?? {
              id: variables.id,
              title: 'Default Title',
              price: '1234',
              inventoryItem: {
                requiresShipping: true,
              },
              product: {
                id: 'gid://shopify/Product/999',
                title: 'Shopify Only Bottle',
              },
            },
        },
      };
    }

    return {
      data: {
        product: {
          id: variables.id,
          title: 'Shopify Only Bottle',
          variants: {
            nodes:
              productVariants ?? [
                {
                  id: 'gid://shopify/ProductVariant/9991',
                  title: 'Default Title',
                  price: '1234',
                  inventoryItem: {
                    requiresShipping: true,
                  },
                },
              ],
          },
        },
      },
    };
  };
}

test('api.draft-order.checkout returns 405 for non-POST loader requests', async () => {
  const loader = createDraftOrderCheckoutLoader();
  const request = new Request('http://localhost/api/draft-order/checkout');

  const response = await loader({ request });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'POST');
});

test('api.draft-order.checkout is hidden unless the public checkout flag is explicitly enabled', async () => {
  const action = createPublicVendorDraftOrderCheckoutAction({ env: {} });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createValidBody()),
  });

  await assert.rejects(
    () => action({ request }),
    (error) =>
      error instanceof Response &&
      error.status === 404 &&
      error.headers.get('Cache-Control') === 'no-store' &&
      error.headers.get('X-Robots-Tag') === 'noindex, nofollow',
  );
});

test('api.draft-order.checkout creates a server-trusted payload and ignores shopDomain tampering', async () => {
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        ok: true,
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        applied: true,
        reason: null,
        shippingAmount: 420,
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        shopDomain: 'evil-shop.myshopify.com',
        price: 1,
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.shopDomain, 'shop-a.myshopify.com');
  assert.deepEqual(receivedPayload.tags, [
    'vendor-storefront',
    'vendor:amber-cellar',
  ]);
  assert.deepEqual(receivedPayload.customAttributes, [
    { key: 'seller_name', value: 'Amber Cellar' },
    { key: 'seller_country', value: 'JP' },
    { key: 'seller_of_record', value: 'marketplace_seller' },
  ]);
  assert.equal(JSON.stringify(receivedPayload).includes('vendorId'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('vendorStoreId'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('localProductId'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('productUrl'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('shopifyProductId'), false);
  assert.deepEqual(await response.json(), {
    ok: true,
    draftOrder: {
      id: 'gid://shopify/DraftOrder/1',
      invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
    },
    invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
    applied: true,
    reason: null,
    shippingAmount: 420,
  });
});

test('api.draft-order.checkout applies authenticated seller sales credit as a settlement offset', async () => {
  const salesCreditOffsets = [];
  const buyerSeller = createVerifiedSeller();
  const targetSeller = {
    id: 'seller_target',
    euSellerStatus: 'DISABLED',
  };
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: targetSeller,
      sessionVendor: {
        id: 'vendor_buyer',
        managementEmail: 'buyer@example.com',
        seller: buyerSeller,
      },
      sellers: [buyerSeller],
      ledgerEntries: [
        {
          sellerId: buyerSeller.id,
          entryType: 'shopify_order_paid',
          amount: 10000,
          currencyCode: 'jpy',
          occurredAt: new Date('2025-01-01T00:00:00Z'),
          metadataJson: TRUSTED_SALES_CREDIT_METADATA,
        },
      ],
      salesCreditOffsets,
    }),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        ok: true,
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
      };
    },
  });
  const cookie = await vendorAdminSessionCookie.serialize('seller-session');
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        customer: {
          ...createValidBody().customer,
          email: 'buyer@example.com',
        },
        useSalesCredit: true,
        salesCreditAmount: 1000,
        salesCreditIdempotencyKey: 'checkout_sales_credit_1',
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.appliedDiscount.value, 1000);
  assert.equal(receivedPayload.appliedDiscount.valueType, 'FIXED_AMOUNT');
  assert.deepEqual(receivedPayload.customAttributes.slice(-4), [
    { key: 'sales_credit_offset_id', value: 'sco_1' },
    { key: 'sales_credit_offset_amount', value: '1000' },
    { key: 'sales_credit_buyer_seller_id', value: 'seller_buyer' },
    { key: 'sales_credit_mode', value: 'monthly_settlement_offset' },
  ]);
  assert.equal(salesCreditOffsets.length, 1);
  assert.equal(salesCreditOffsets[0].sellerId, 'seller_buyer');
  assert.equal(salesCreditOffsets[0].amount, 1000);
  assert.equal(salesCreditOffsets[0].status, 'authorized');
  assert.ok(salesCreditOffsets[0].expiresAt instanceof Date);
  assert.ok(salesCreditOffsets[0].expiresAt.getTime() > Date.now());
  assert.equal(
    salesCreditOffsets[0].metadataJson.draftOrderId,
    'gid://shopify/DraftOrder/1',
  );
  assert.equal(
    salesCreditOffsets[0].metadataJson.invoiceUrl,
    'https://shop-a.myshopify.com/invoices/1',
  );
  assert.equal(
    salesCreditOffsets[0].metadataJson.salesCreditMode,
    'monthly_settlement_offset',
  );
  assert.equal(salesCreditOffsets[0].metadataJson.checkoutLockMinutes, 30);
  assert.equal(salesCreditOffsets[0].metadataJson.currencyCode, 'jpy');
  assert.equal(salesCreditOffsets[0].metadataJson.itemSubtotalAmount, 8400);
  assert.deepEqual(salesCreditOffsets[0].metadataJson.lineItems, [
    {
      productId: 'prod_1',
      name: 'Amber Wine',
      category: '雑貨・小物',
      quantity: 2,
      subtotalAmount: 8400,
    },
  ]);
  assert.deepEqual(payload.salesCredit, {
    offsetId: 'sco_1',
    amount: 1000,
  });
});

test('api.draft-order.checkout rejects sales credit idempotency reuse with a different amount', async () => {
  const salesCreditOffsets = [
    {
      id: 'sco_existing',
      sellerId: 'seller_buyer',
      amount: 500,
      currencyCode: 'jpy',
      status: 'authorized',
      checkoutReference: 'draft-order:existing',
      idempotencyKey: 'checkout_sales_credit_1',
      expiresAt: null,
      metadataJson: {
        targetSellerId: 'seller_target',
      },
    },
  ];
  const buyerSeller = createVerifiedSeller();
  const targetSeller = {
    id: 'seller_target',
    euSellerStatus: 'DISABLED',
  };
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: targetSeller,
      sessionVendor: {
        id: 'vendor_buyer',
        managementEmail: 'buyer@example.com',
        seller: buyerSeller,
      },
      sellers: [buyerSeller],
      ledgerEntries: [
        {
          sellerId: buyerSeller.id,
          entryType: 'shopify_order_paid',
          amount: 10000,
          currencyCode: 'jpy',
          occurredAt: new Date('2025-01-01T00:00:00Z'),
          metadataJson: TRUSTED_SALES_CREDIT_METADATA,
        },
      ],
      salesCreditOffsets,
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const cookie = await vendorAdminSessionCookie.serialize('seller-session');
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        customer: {
          ...createValidBody().customer,
          email: 'buyer@example.com',
        },
        useSalesCredit: true,
        salesCreditAmount: 1000,
        salesCreditIdempotencyKey: 'checkout_sales_credit_1',
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.equal(salesCreditOffsets.length, 1);
  assert.equal(salesCreditOffsets[0].amount, 500);
});

test('api.draft-order.checkout rejects sales credit on restricted product categories', async () => {
  const buyerSeller = createVerifiedSeller();
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      products: createProducts().map((product) =>
        product.id === 'prod_1'
          ? { ...product, category: 'カード・フィギュア' }
          : product,
      ),
      seller: {
        id: 'seller_target',
        euSellerStatus: 'DISABLED',
      },
      sessionVendor: {
        id: 'vendor_buyer',
        managementEmail: 'buyer@example.com',
        seller: buyerSeller,
      },
      sellers: [buyerSeller],
      ledgerEntries: [
        {
          sellerId: buyerSeller.id,
          entryType: 'shopify_order_paid',
          amount: 10000,
          currencyCode: 'jpy',
          occurredAt: new Date('2025-01-01T00:00:00Z'),
          metadataJson: TRUSTED_SALES_CREDIT_METADATA,
        },
      ],
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const cookie = await vendorAdminSessionCookie.serialize('seller-session');
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        customer: {
          ...createValidBody().customer,
          email: 'buyer@example.com',
        },
        useSalesCredit: true,
        salesCreditAmount: 1000,
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.equal(payload.errors.length, 1);
  assert.match(payload.errors[0], /売上金/);
});

test('api.draft-order.checkout rejects Shopify-only products before sales-credit processing', async () => {
  const buyerSeller = createVerifiedSeller();
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: {
        id: 'seller_target',
        euSellerStatus: 'DISABLED',
      },
      sessionVendor: {
        id: 'vendor_buyer',
        managementEmail: 'buyer@example.com',
        seller: buyerSeller,
      },
      sellers: [buyerSeller],
      ledgerEntries: [
        {
          sellerId: buyerSeller.id,
          entryType: 'shopify_order_paid',
          amount: 10000,
          currencyCode: 'jpy',
          occurredAt: new Date('2025-01-01T00:00:00Z'),
          metadataJson: TRUSTED_SALES_CREDIT_METADATA,
        },
      ],
    }),
    shopifyGraphQLWithOfflineSessionImpl: createShopifyGraphQLStub(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const cookie = await vendorAdminSessionCookie.serialize('seller-session');
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createShopifyFallbackBody({
        customer: {
          ...createValidBody().customer,
          email: 'buyer@example.com',
        },
        useSalesCredit: true,
        salesCreditAmount: 1000,
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.equal(payload.errors.length, 1);
  assert.equal(
    payload.errors[0],
    '選択した商品は購入できません。内容を確認して、もう一度お試しください。',
  );
});

test('api.draft-order.checkout rejects sales credit on the seller own products', async () => {
  let callCount = 0;
  const sameSeller = createVerifiedSeller({
    id: 'seller_target',
    euSellerStatus: 'DISABLED',
  });
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: sameSeller,
      sessionVendor: {
        id: 'vendor_buyer',
        managementEmail: 'buyer@example.com',
        seller: sameSeller,
      },
      sellers: [sameSeller],
      ledgerEntries: [
        {
          sellerId: sameSeller.id,
          entryType: 'shopify_order_paid',
          amount: 10000,
          currencyCode: 'jpy',
          occurredAt: new Date('2025-01-01T00:00:00Z'),
          metadataJson: TRUSTED_SALES_CREDIT_METADATA,
        },
      ],
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const cookie = await vendorAdminSessionCookie.serialize('seller-session');
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        customer: {
          ...createValidBody().customer,
          email: 'buyer@example.com',
        },
        useSalesCredit: true,
        salesCreditAmount: 1000,
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.equal(payload.errors.length, 1);
  assert.equal(typeof payload.errors[0], 'string');
  assert.ok(payload.errors[0].length > 0);
});

test('api.draft-order.checkout rejects EU checkout before product EU approval', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: {
        id: 'seller_1',
        euSellerStatus: 'FULL_KYBC_APPROVED',
      },
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        shippingAddress: {
          ...createValidBody().shippingAddress,
          country: 'DE',
        },
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.deepEqual(payload.errors, [
    'この配送先には販売できません。',
  ]);
});

test('api.draft-order.checkout rejects mixed EU carts when any item is not eligible', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: {
        id: 'seller_1',
        euSellerStatus: 'FULL_KYBC_APPROVED',
      },
      products: [
        {
          ...createProducts()[0],
          productEuStatus: 'APPROVED_LOW_RISK',
        },
        {
          ...createProducts()[0],
          id: 'prod_eu_blocked',
          name: 'Blocked EU Bottle',
          shopifyProductId: 'gid://shopify/Product/4',
          productEuStatus: 'DISABLED',
        },
      ],
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [
          { productId: 'prod_1', quantity: 1 },
          { productId: 'prod_eu_blocked', quantity: 1 },
        ],
        shippingAddress: {
          ...createValidBody().shippingAddress,
          country: 'FR',
        },
        importResponsibilityAccepted: true,
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.deepEqual(payload.errors, [
    'この配送先には販売できません。',
  ]);
});

test('api.draft-order.checkout requires EU import warning acceptance', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: {
        id: 'seller_1',
        euSellerStatus: 'FULL_KYBC_APPROVED',
      },
      products: createProducts().map((product) =>
        product.id === 'prod_1'
          ? { ...product, productEuStatus: 'APPROVED_LOW_RISK' }
          : product,
      ),
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        shippingAddress: {
          ...createValidBody().shippingAddress,
          country: 'DE',
        },
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, ['配送先国と輸入条件の確認に同意してください。']);
});

test('api.draft-order.checkout records EU import warning acceptance after checkout', async () => {
  const buyerWarningRecords = [];
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      buyerWarningRecords,
      seller: {
        id: 'seller_1',
        euSellerStatus: 'FULL_KYBC_APPROVED',
      },
      products: createProducts().map((product) =>
        product.id === 'prod_1'
          ? { ...product, productEuStatus: 'APPROVED_LOW_RISK' }
          : product,
      ),
    }),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        ok: true,
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        importResponsibilityAccepted: true,
        shippingAddress: {
          ...createValidBody().shippingAddress,
          country: 'DE',
        },
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'node-test',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.buyerWarningAcceptance.shippingCountry, 'DE');
  assert.deepEqual(receivedPayload.customAttributes, [
    { key: 'seller_name', value: 'Amber Cellar' },
    { key: 'seller_country', value: 'JP' },
    { key: 'seller_of_record', value: 'marketplace_seller' },
    { key: 'buyer_import_warning_version', value: 'import-responsibility-v1' },
    { key: 'buyer_import_responsibility_accepted', value: 'true' },
  ]);
  assert.equal(buyerWarningRecords.length, 1);
  assert.equal(buyerWarningRecords[0].orderId, 'gid://shopify/DraftOrder/1');
  assert.equal(buyerWarningRecords[0].shippingCountry, 'DE');
  assert.equal(buyerWarningRecords[0].importResponsibilityAccepted, true);
});

test('api.draft-order.checkout rejects items from another vendor store', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [
          { productId: 'prod_1', quantity: 1 },
          { productId: 'prod_other', quantity: 1 },
        ],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.deepEqual(payload.errors, [UNAVAILABLE_PRODUCT_MESSAGE]);
});

test('api.draft-order.checkout allows multi-seller products when all storefront flags are enabled', async () => {
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    env: MULTI_SELLER_CHECKOUT_ENV,
    prismaClient: createFakePrisma({
      products: createMultiSellerProducts(),
    }),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        ok: true,
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [
          { productId: 'prod_1', quantity: 1 },
          { productId: 'prod_other', quantity: 1 },
        ],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.invoiceUrl, 'https://shop-a.myshopify.com/invoices/1');
  assert.deepEqual(receivedPayload.tags, ['vendor-storefront', 'multi-seller']);
  assert.deepEqual(receivedPayload.customAttributes, [
    { key: 'seller_of_record', value: 'marketplace_seller' },
    { key: 'marketplace_order_mode', value: 'multi_seller' },
    { key: 'seller_count', value: '2' },
  ]);
  assert.deepEqual(
    receivedPayload.orderLike.lines.map((line) => ({
      lineId: line.lineId,
      vendor: line.vendor,
      directShipGroup: line.directShipGroup,
    })),
    [
      {
        lineId: 'prod_1',
        vendor: 'Amber Cellar',
        directShipGroup: 'store_1',
      },
      {
        lineId: 'prod_other',
        vendor: 'Blue Cellar',
        directShipGroup: 'store_2',
      },
    ],
  );
});

test('api.draft-order.checkout rejects multi-seller products without SellerOrder vendor reads', async () => {
  let callCount = 0;
  const {
    VENDOR_ORDERS_USE_SELLER_ORDERS: _sellerOrderReads,
    ...envWithoutSellerOrderReads
  } = MULTI_SELLER_CHECKOUT_ENV;
  const action = createPublicVendorDraftOrderCheckoutAction({
    env: envWithoutSellerOrderReads,
    prismaClient: createFakePrisma({
      products: createMultiSellerProducts(),
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [
          { productId: 'prod_1', quantity: 1 },
          { productId: 'prod_other', quantity: 1 },
        ],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
});

test('api.draft-order.checkout rejects sales credit on multi-seller checkout', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    env: MULTI_SELLER_CHECKOUT_ENV,
    prismaClient: createFakePrisma({
      products: createMultiSellerProducts(),
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [
          { productId: 'prod_1', quantity: 1 },
          { productId: 'prod_other', quantity: 1 },
        ],
        useSalesCredit: true,
        salesCreditAmount: 1000,
        salesCreditIdempotencyKey: 'multi_seller_sales_credit_1',
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.equal(payload.errors.length, 1);
});

test('api.draft-order.checkout rejects unapproved products', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [{ productId: 'prod_pending', quantity: 1 }],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, [UNAVAILABLE_PRODUCT_MESSAGE]);
});

test('api.draft-order.checkout rejects quantities above local inventory', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      products: createProducts().map((product) =>
        product.id === 'prod_1'
          ? { ...product, inventoryQuantity: 1 }
          : product,
      ),
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [{ productId: 'prod_1', quantity: 2 }],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, [OUT_OF_STOCK_MESSAGE]);
});

test('api.draft-order.checkout rejects Shopify-only products that are absent locally', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    shopifyGraphQLWithOfflineSessionImpl: createShopifyGraphQLStub(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(createShopifyFallbackBody()),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, [
    '選択した商品は購入できません。内容を確認して、もう一度お試しください。',
  ]);
});

test('api.draft-order.checkout rejects a Shopify variant that does not match the local product', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createShopifyFallbackBody({
        items: [
          {
            productId: 'prod_1',
            shopifyProductId: 'gid://shopify/Product/1',
            shopifyVariantId: 'gid://shopify/ProductVariant/tampered',
            quantity: 1,
          },
        ],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, [
    '選択した商品は購入できません。内容を確認して、もう一度お試しください。',
  ]);
});

test('api.draft-order.checkout rejects test-store products even when they are approved', async () => {
  let callCount = 0;
  const products = createProducts();
  products[0] = {
    ...products[0],
    vendorStore: {
      ...products[0].vendorStore,
      isTestStore: true,
      isPlatformStore: false,
    },
  };
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({ products }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createShopifyFallbackBody({
        items: [{ productId: 'prod_1', quantity: 1 }],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, [
    '選択した商品は購入できません。内容を確認して、もう一度お試しください。',
  ]);
});

test('api.draft-order.checkout sanitizes service failures', async () => {
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      const error = new Error('draftOrderCreate failed');
      error.userErrors = [{ field: ['input', 'lineItems'], message: 'Variant is invalid' }];
      throw error;
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(createValidBody()),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(payload, {
    ok: false,
    reason: 'internal_error',
    error: GENERIC_CHECKOUT_ERROR_MESSAGE,
  });
});
