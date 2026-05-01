import { json } from '@remix-run/node';

const SMOKE_SHIPPING_RATES_JPY = {
  JP: 870,
  US: 2500,
};
const DEFAULT_INTERNATIONAL_SHIPPING_RATE_JPY = 3500;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeCountryCode(value) {
  const normalized = normalizeText(value);

  return normalized ? normalized.toUpperCase() : null;
}

function toPositiveNumber(value) {
  const numeric = Number(value);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getShippingAddress(body) {
  return isPlainObject(body?.shippingAddress) ? body.shippingAddress : {};
}

function getOrderLines(body) {
  return Array.isArray(body?.orderLike?.lines) ? body.orderLike.lines : [];
}

function lineRequiresShipping(line) {
  if (!isPlainObject(line)) {
    return false;
  }

  if (line.requiresShipping === false) {
    return false;
  }

  return (toPositiveNumber(line.quantity) || 1) > 0;
}

function getSmokeRateForCountry(countryCode) {
  return SMOKE_SHIPPING_RATES_JPY[countryCode] ?? DEFAULT_INTERNATIONAL_SHIPPING_RATE_JPY;
}

export function buildShippingQuoteResponse(body) {
  const shippingAddress = getShippingAddress(body);
  const countryCode = normalizeCountryCode(
    shippingAddress.countryCode || shippingAddress.country,
  );
  const postalCode = normalizeText(shippingAddress.postalCode || shippingAddress.zip);
  const shippableLines = getOrderLines(body).filter(lineRequiresShipping);

  if (!countryCode || !postalCode) {
    return {
      ok: true,
      enabled: true,
      reason: 'pending_address',
      result: {
        isPendingAddress: true,
        isDeliverable: false,
        totalShippingFee: null,
      },
      debug: {
        source: 'vendor-register-smoke-quote',
        countryCode,
        postalCode,
        shippableLineCount: shippableLines.length,
      },
    };
  }

  return {
    ok: true,
    enabled: true,
    reason: null,
    result: {
      isPendingAddress: false,
      isDeliverable: true,
      totalShippingFee: shippableLines.length > 0 ? getSmokeRateForCountry(countryCode) : 0,
      currencyCode: 'JPY',
    },
    debug: {
      source: 'vendor-register-smoke-quote',
      countryCode,
      postalCode,
      shippableLineCount: shippableLines.length,
    },
  };
}

export function createShippingQuoteLoader() {
  return async function loader() {
    return json(
      {
        ok: false,
        reason: 'method_not_allowed',
        message: 'Use POST with a Shipping V2 quote request JSON body.',
      },
      {
        status: 405,
        headers: {
          Allow: 'POST',
        },
      },
    );
  };
}

export function createShippingQuoteAction() {
  return async function action({ request }) {
    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          reason: 'invalid_json',
        },
        { status: 400 },
      );
    }

    return json(buildShippingQuoteResponse(body));
  };
}
