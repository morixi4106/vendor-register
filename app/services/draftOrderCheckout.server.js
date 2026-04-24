import { json } from '@remix-run/node';

import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from '../utils/shopifyAdmin.server.js';
import { prepareShippingV2WriterPayload } from './shippingV2Writer.server.js';

const DEFAULT_ADMIN_API_VERSION = '2025-01';
const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';
const GENERIC_SHIPPING_ERROR_MESSAGE =
  '送料の計算に失敗しました。配送先を確認して、もう一度お試しください。';

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
        customAttributes {
          key
          value
        }
        shippingLine {
          title
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value == null) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPositiveInteger(value) {
  const numeric = Number(value);

  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function clonePlainObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function createMethodNotAllowedResponse() {
  return json(
    {
      ok: false,
      reason: 'method_not_allowed',
      errors: ['Method not allowed'],
    },
    {
      status: 405,
      headers: {
        Allow: 'POST',
      },
    },
  );
}

function createInvalidPayloadResponse(errors) {
  return json(
    {
      ok: false,
      reason: 'invalid_payload',
      errors,
    },
    { status: 400 },
  );
}

function createInternalErrorResponse() {
  return json(
    {
      ok: false,
      reason: 'internal_error',
    },
    { status: 500 },
  );
}

function createInvalidPayloadError(errors) {
  const error = new Error('Invalid draft order checkout payload');
  error.reason = 'invalid_payload';
  error.errors = errors;
  return error;
}

function createCheckoutProcessError(reason, publicMessage, details) {
  const error = new Error(publicMessage);
  error.reason = reason;
  error.publicMessage = publicMessage;

  if (details !== undefined) {
    error.details = details;
  }

  return error;
}

function isInvalidPayloadError(error) {
  return error?.reason === 'invalid_payload' && Array.isArray(error?.errors);
}

function isCheckoutProcessError(error) {
  return Boolean(error?.reason && error?.publicMessage);
}

function createCheckoutProcessErrorResponse(error) {
  return json(
    {
      ok: false,
      reason: error.reason,
      error: error.publicMessage,
    },
    {
      status: error.reason === 'shipping_quote_failed' ? 422 : 500,
    },
  );
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeCountryCode(value) {
  const normalized = normalizeText(value);

  if (!normalized || !/^[a-z]{2}$/i.test(normalized)) {
    return null;
  }

  return normalized.toUpperCase();
}

function normalizeCustomAttribute(attribute) {
  if (!isPlainObject(attribute)) {
    return null;
  }

  const key = normalizeText(attribute.key);

  if (!key || attribute.value == null) {
    return null;
  }

  return {
    key,
    value: String(attribute.value),
  };
}

function normalizeNoteAttribute(attribute) {
  if (!isPlainObject(attribute)) {
    return null;
  }

  const name = normalizeText(attribute.name);

  if (!name || attribute.value == null) {
    return null;
  }

  return {
    name,
    value: String(attribute.value),
  };
}

function normalizeCustomAttributes(attributes) {
  if (!Array.isArray(attributes)) {
    return null;
  }

  return attributes.map(normalizeCustomAttribute).filter(Boolean);
}

function normalizeNoteAttributes(attributes) {
  if (!Array.isArray(attributes)) {
    return null;
  }

  return attributes.map(normalizeNoteAttribute).filter(Boolean);
}

function normalizeAddress(address) {
  if (!isPlainObject(address)) {
    return null;
  }

  const normalized = { ...address };

  if (normalized.postalCode == null && normalized.zip != null) {
    normalized.postalCode = normalized.zip;
  }

  if (normalized.zip == null && normalized.postalCode != null) {
    normalized.zip = normalized.postalCode;
  }

  if (normalized.prefecture == null && normalized.province != null) {
    normalized.prefecture = normalized.province;
  }

  if (normalized.province == null && normalized.prefecture != null) {
    normalized.province = normalized.prefecture;
  }

  return normalized;
}

function buildMailingAddressInput(address) {
  const normalized = normalizeAddress(address);

  if (!normalized) {
    return null;
  }

  const input = {};
  const countryCode =
    normalizeCountryCode(normalized.countryCode) ||
    normalizeCountryCode(normalized.country);
  const provinceCode = normalizeText(normalized.provinceCode || normalized.prefectureCode);
  const country = normalizeText(normalized.country);
  const province = normalizeText(normalized.province || normalized.prefecture);
  const fieldMap = {
    address1: normalizeText(normalized.address1),
    address2: normalizeText(normalized.address2),
    city: normalizeText(normalized.city),
    company: normalizeText(normalized.company),
    firstName: normalizeText(normalized.firstName),
    lastName: normalizeText(normalized.lastName),
    phone: normalizeText(normalized.phone),
    zip: normalizeText(normalized.zip || normalized.postalCode),
  };

  for (const [key, value] of Object.entries(fieldMap)) {
    if (value) {
      input[key] = value;
    }
  }

  if (countryCode) {
    input.countryCode = countryCode;
  } else if (country) {
    input.country = country;
  }

  if (provinceCode) {
    input.provinceCode = provinceCode;
  } else if (province) {
    input.province = province;
  }

  return Object.keys(input).length > 0 ? input : null;
}

function normalizeDraftOrderCheckoutInput(body) {
  const payload = isPlainObject(body) ? body : null;
  const orderLike = isPlainObject(payload?.orderLike) ? payload.orderLike : null;
  const lines = Array.isArray(orderLike?.lines) ? orderLike.lines : null;
  const shippingAddress = isPlainObject(payload?.shippingAddress)
    ? payload.shippingAddress
    : isPlainObject(payload?.address)
      ? payload.address
      : null;
  const billingAddress = isPlainObject(payload?.billingAddress)
    ? payload.billingAddress
    : isPlainObject(payload?.billing_address)
      ? payload.billing_address
      : null;
  const legacyPayload = isPlainObject(payload?.legacyPayload) ? payload.legacyPayload : null;
  const legacyPayloadOverrides = isPlainObject(payload?.legacyPayloadOverrides)
    ? payload.legacyPayloadOverrides
    : null;
  const attributeType = payload?.attributeType === 'note' ? 'note' : 'custom';
  const shippingAmountField = normalizeText(payload?.shippingAmountField) || 'shippingAmount';
  const email =
    normalizeText(payload?.email) ||
    normalizeText(payload?.customerEmail) ||
    normalizeText(payload?.customer?.email) ||
    normalizeText(legacyPayload?.email);
  const customer = isPlainObject(payload?.customer) ? payload.customer : null;
  const customerId =
    normalizeText(payload?.customerId) ||
    normalizeText(payload?.customer?.id) ||
    normalizeText(legacyPayload?.customerId);
  const note =
    normalizeText(payload?.note) ||
    normalizeText(orderLike?.note) ||
    normalizeText(legacyPayload?.note);
  const presentmentCurrencyCode = normalizeText(
    payload?.presentmentCurrencyCode || payload?.currencyCode || orderLike?.currencyCode,
  );
  const requestedTags = normalizeStringArray(payload?.tags);
  const orderLikeTags = normalizeStringArray(orderLike?.tags);
  const legacyTags = normalizeStringArray(legacyPayload?.tags);
  const tags =
    requestedTags.length > 0 ? requestedTags : orderLikeTags.length > 0 ? orderLikeTags : legacyTags;
  const customAttributes =
    normalizeCustomAttributes(payload?.customAttributes) ||
    normalizeCustomAttributes(orderLike?.customAttributes) ||
    normalizeCustomAttributes(legacyPayload?.customAttributes);
  const noteAttributes =
    normalizeNoteAttributes(payload?.noteAttributes) ||
    normalizeNoteAttributes(orderLike?.noteAttributes) ||
    normalizeNoteAttributes(legacyPayload?.noteAttributes);
  const shippingAmount = toFiniteNumber(
    payload?.shippingAmount ??
      payload?.shippingLine?.price ??
      orderLike?.shippingAmount ??
      legacyPayload?.[shippingAmountField],
  );
  const taxExempt = normalizeBoolean(payload?.taxExempt ?? legacyPayload?.taxExempt);

  return {
    payload,
    lines,
    shippingAddress: normalizeAddress(shippingAddress),
    billingAddress: normalizeAddress(billingAddress),
    legacyPayload,
    legacyPayloadOverrides,
    attributeType,
    shippingAmountField,
    shopDomain: normalizeShopDomain(payload?.shopDomain || orderLike?.shopDomain),
    email,
    customer,
    customerId,
    note,
    tags,
    presentmentCurrencyCode: presentmentCurrencyCode
      ? presentmentCurrencyCode.toUpperCase()
      : null,
    customAttributes,
    noteAttributes,
    appliedDiscount: isPlainObject(payload?.appliedDiscount)
      ? payload.appliedDiscount
      : isPlainObject(legacyPayload?.appliedDiscount)
        ? legacyPayload.appliedDiscount
        : null,
    shippingLine: isPlainObject(payload?.shippingLine)
      ? payload.shippingLine
      : isPlainObject(legacyPayload?.shippingLine)
        ? legacyPayload.shippingLine
        : null,
    shippingAmount,
    taxExempt,
  };
}

function assertValidDraftOrderCheckoutInput(normalized) {
  const errors = [];

  if (!normalized.payload) {
    errors.push('Request body must be a JSON object');
  }

  if (!Array.isArray(normalized.lines) || normalized.lines.length === 0) {
    errors.push('orderLike.lines must be a non-empty array');
  }

  if (!normalized.shippingAddress) {
    errors.push('shippingAddress is required');
  }

  if (!normalized.shopDomain) {
    errors.push('shopDomain is required');
  }

  if (errors.length > 0) {
    throw createInvalidPayloadError(errors);
  }
}

function buildLegacyCheckoutPayload(normalized) {
  const legacyPayload = clonePlainObject(normalized.legacyPayload);

  if (normalized.email) {
    legacyPayload.email = normalized.email;
  }

  if (normalized.customerId) {
    legacyPayload.customerId = normalized.customerId;
  }

  if (normalized.customer && legacyPayload.customer == null) {
    legacyPayload.customer = { ...normalized.customer };
  }

  if (normalized.note) {
    legacyPayload.note = normalized.note;
  }

  if (normalized.tags.length > 0) {
    legacyPayload.tags = [...normalized.tags];
  }

  if (normalized.presentmentCurrencyCode) {
    legacyPayload.presentmentCurrencyCode = normalized.presentmentCurrencyCode;
  }

  if (normalized.shippingAddress) {
    legacyPayload.shippingAddress = { ...normalized.shippingAddress };
  }

  if (normalized.billingAddress) {
    legacyPayload.billingAddress = { ...normalized.billingAddress };
  }

  if (normalized.appliedDiscount) {
    legacyPayload.appliedDiscount = { ...normalized.appliedDiscount };
  }

  if (normalized.shippingLine) {
    legacyPayload.shippingLine = { ...normalized.shippingLine };
  }

  if (normalized.taxExempt != null) {
    legacyPayload.taxExempt = normalized.taxExempt;
  }

  if (normalized.attributeType === 'note') {
    if (normalized.noteAttributes) {
      legacyPayload.noteAttributes = [...normalized.noteAttributes];
    }
  } else if (normalized.customAttributes) {
    legacyPayload.customAttributes = [...normalized.customAttributes];
  }

  if (normalized.shippingAmount != null) {
    legacyPayload[normalized.shippingAmountField] = normalized.shippingAmount;
  }

  if (normalized.legacyPayloadOverrides) {
    Object.assign(legacyPayload, normalized.legacyPayloadOverrides);
  }

  return legacyPayload;
}

function normalizePrepareResult(result) {
  if (!isPlainObject(result) || !isPlainObject(result.payload) || typeof result.applied !== 'boolean') {
    throw new Error('Shipping V2 prepare must return { applied, payload, reason }');
  }

  return {
    applied: result.applied,
    reason: normalizeText(result.reason),
    payload: result.payload,
  };
}

function buildDraftOrderLineItem(line, index) {
  const quantity = toPositiveInteger(line?.quantity ?? line?.qty);

  if (quantity == null) {
    throw new Error(`orderLike.lines[${index}] quantity must be a positive integer`);
  }

  const variantId = normalizeText(line?.variantId || line?.merchandiseId);

  if (variantId) {
    return {
      variantId,
      quantity,
    };
  }

  const title = normalizeText(line?.title || line?.name);
  const originalUnitPrice = toFiniteNumber(
    line?.originalUnitPrice ?? line?.unitPrice ?? line?.price,
  );

  if (!title || originalUnitPrice == null) {
    throw new Error(
      `orderLike.lines[${index}] must include variantId or title/originalUnitPrice`,
    );
  }

  const customAttributes = normalizeCustomAttributes(line?.customAttributes);
  const lineItem = {
    title,
    originalUnitPrice,
    quantity,
  };

  if (customAttributes && customAttributes.length > 0) {
    lineItem.customAttributes = customAttributes;
  }

  return lineItem;
}

function buildDraftOrderLineItems(lines) {
  return lines.map(buildDraftOrderLineItem);
}

function buildDraftOrderShippingLine({
  preparedPayload,
  shippingAmountField,
  fallbackShippingLine,
}) {
  const shippingAmount = toFiniteNumber(preparedPayload?.[shippingAmountField]);

  if (shippingAmount == null) {
    throw new Error(`Prepared payload is missing ${shippingAmountField}`);
  }

  return {
    title:
      normalizeText(preparedPayload?.shippingLine?.title) ||
      normalizeText(fallbackShippingLine?.title) ||
      'Shipping',
    price: shippingAmount,
  };
}

function buildDraftOrderInput(normalized, preparedPayload) {
  const shippingAddress = buildMailingAddressInput(
    preparedPayload?.shippingAddress || normalized.shippingAddress,
  );

  if (!shippingAddress) {
    throw new Error('shippingAddress is required');
  }

  const billingAddress = buildMailingAddressInput(
    preparedPayload?.billingAddress || normalized.billingAddress,
  );
  const customAttributes = normalizeCustomAttributes(preparedPayload?.customAttributes);
  const email =
    normalizeText(preparedPayload?.email) ||
    normalized.email ||
    normalizeText(preparedPayload?.customer?.email);
  const note = normalizeText(preparedPayload?.note) || normalized.note;
  const tags = normalizeStringArray(preparedPayload?.tags);
  const presentmentCurrencyCode = normalizeText(preparedPayload?.presentmentCurrencyCode);
  const preparedTaxExempt = normalizeBoolean(preparedPayload?.taxExempt);
  const taxExempt = preparedTaxExempt != null ? preparedTaxExempt : normalized.taxExempt;
  const input = {
    lineItems: buildDraftOrderLineItems(normalized.lines),
    shippingAddress,
    shippingLine: buildDraftOrderShippingLine({
      preparedPayload,
      shippingAmountField: normalized.shippingAmountField,
      fallbackShippingLine: normalized.shippingLine,
    }),
  };

  if (email) {
    input.email = email;
  }

  if (note) {
    input.note = note;
  }

  if (billingAddress) {
    input.billingAddress = billingAddress;
  }

  if (customAttributes) {
    input.customAttributes = customAttributes;
  }

  if (tags.length > 0) {
    input.tags = tags;
  }

  if (normalized.appliedDiscount) {
    input.appliedDiscount = { ...normalized.appliedDiscount };
  } else if (isPlainObject(preparedPayload?.appliedDiscount)) {
    input.appliedDiscount = { ...preparedPayload.appliedDiscount };
  }

  if (presentmentCurrencyCode) {
    input.presentmentCurrencyCode = presentmentCurrencyCode.toUpperCase();
  }

  if (taxExempt != null) {
    input.taxExempt = taxExempt;
  }

  return input;
}

function buildDraftOrderCreateError(userErrors) {
  const error = createCheckoutProcessError(
    'checkout_failed',
    GENERIC_CHECKOUT_ERROR_MESSAGE,
    userErrors,
  );
  error.userErrors = userErrors;
  return error;
}

export function createDraftOrderCheckout({
  apiVersion = DEFAULT_ADMIN_API_VERSION,
  prepareShippingV2WriterPayloadImpl = prepareShippingV2WriterPayload,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
} = {}) {
  return async function draftOrderCheckout(input) {
    const normalized = normalizeDraftOrderCheckoutInput(input);
    assertValidDraftOrderCheckoutInput(normalized);

    const legacyPayload = buildLegacyCheckoutPayload(normalized);
    const prepareResult = normalizePrepareResult(
      await prepareShippingV2WriterPayloadImpl({
        payload: legacyPayload,
        lines: normalized.lines,
        shippingAddress: normalized.shippingAddress,
        shopDomain: normalized.shopDomain,
        legacyShippingAmount: toFiniteNumber(legacyPayload[normalized.shippingAmountField]),
        shippingAmountField: normalized.shippingAmountField,
        attributeType: normalized.attributeType,
      }),
    );

    if (!prepareResult.applied) {
      throw createCheckoutProcessError(
        'shipping_quote_failed',
        GENERIC_SHIPPING_ERROR_MESSAGE,
        prepareResult,
      );
    }

    if (toFiniteNumber(prepareResult.payload[normalized.shippingAmountField]) == null) {
      throw createCheckoutProcessError(
        'shipping_quote_failed',
        GENERIC_SHIPPING_ERROR_MESSAGE,
        prepareResult,
      );
    }

    const draftOrderInput = buildDraftOrderInput(normalized, prepareResult.payload);
    const { data } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain: normalized.shopDomain,
      apiVersion: String(apiVersion),
      query: DRAFT_ORDER_CREATE_MUTATION,
      variables: {
        input: draftOrderInput,
      },
    });
    const mutationPayload = data?.draftOrderCreate;
    const userErrors = Array.isArray(mutationPayload?.userErrors) ? mutationPayload.userErrors : [];

    if (userErrors.length > 0) {
      throw buildDraftOrderCreateError(userErrors);
    }

    const draftOrder = mutationPayload?.draftOrder;
    const draftOrderId = normalizeText(draftOrder?.id);
    const invoiceUrl = normalizeText(draftOrder?.invoiceUrl);

    if (!draftOrderId || !invoiceUrl) {
      throw new Error('draftOrderCreate did not return draftOrder.id and draftOrder.invoiceUrl');
    }

    return {
      ok: true,
      draftOrder: {
        id: draftOrderId,
        invoiceUrl,
      },
      invoiceUrl,
      applied: prepareResult.applied,
      reason: prepareResult.reason,
      shippingAmount: toFiniteNumber(prepareResult.payload[normalized.shippingAmountField]),
    };
  };
}

export const draftOrderCheckout = createDraftOrderCheckout();

export function createDraftOrderCheckoutLoader() {
  return async function loader() {
    return createMethodNotAllowedResponse();
  };
}

export function createDraftOrderCheckoutAction({
  draftOrderCheckoutImpl = draftOrderCheckout,
} = {}) {
  return async function action({ request }) {
    if (request.method !== 'POST') {
      return createMethodNotAllowedResponse();
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return createInvalidPayloadResponse(['Request body must be valid JSON']);
    }

    try {
      return json(await draftOrderCheckoutImpl(body));
    } catch (error) {
      if (isInvalidPayloadError(error)) {
        return createInvalidPayloadResponse(error.errors);
      }

      if (isCheckoutProcessError(error)) {
        return createCheckoutProcessErrorResponse(error);
      }

      console.error('draft order checkout error:', error);
      return createInternalErrorResponse();
    }
  };
}
