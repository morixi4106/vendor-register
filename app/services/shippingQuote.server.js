import { json } from '@remix-run/node';

import {
  createShippingDiagnosticId,
  recordShippingDiagnosticEvent,
} from './shippingDiagnostics.server.js';

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

function summarizeQuoteRequest(body) {
  const shippingAddress = getShippingAddress(body);
  const lines = getOrderLines(body);

  return {
    source: 'smoke_quote',
    shopDomain: normalizeText(body?.shopDomain),
    shippingAddress: {
      countryCode: normalizeCountryCode(shippingAddress.countryCode || shippingAddress.country),
      postalCode: normalizeText(shippingAddress.postalCode || shippingAddress.zip),
      province: normalizeText(shippingAddress.province || shippingAddress.prefecture),
      city: normalizeText(shippingAddress.city),
    },
    lineCount: lines.length,
    shippableLineCount: lines.filter(lineRequiresShipping).length,
  };
}

function summarizeQuoteResponse(payload) {
  return {
    ok: payload?.ok ?? null,
    enabled: payload?.enabled ?? null,
    reason: payload?.reason ?? null,
    isPendingAddress: payload?.result?.isPendingAddress ?? null,
    isDeliverable: payload?.result?.isDeliverable ?? null,
    totalShippingFee: payload?.result?.totalShippingFee ?? null,
    currencyCode: payload?.result?.currencyCode ?? null,
    debug: payload?.debug ?? null,
  };
}

function recordQuoteDiagnostic({ requestId, level = 'info', message, details }) {
  recordShippingDiagnosticEvent({
    requestId,
    source: 'quote',
    level,
    message,
    details,
  });
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
    const requestId =
      request.headers.get('x-shipping-diagnostic-request-id') ||
      createShippingDiagnosticId('quote');
    let body;

    try {
      body = await request.json();
    } catch {
      recordQuoteDiagnostic({
        requestId,
        level: 'warn',
        message: 'invalid_json',
        details: {
          method: request.method,
          url: request.url,
          contentType: request.headers.get('content-type') || '',
        },
      });
      return json(
        {
          ok: false,
          reason: 'invalid_json',
        },
        { status: 400 },
      );
    }

    const payload = buildShippingQuoteResponse(body);
    const responseSummary = summarizeQuoteResponse(payload);

    recordQuoteDiagnostic({
      requestId,
      level: responseSummary.reason ? 'warn' : 'info',
      message: responseSummary.reason ? 'quote_not_applied' : 'quote_returned',
      details: {
        request: summarizeQuoteRequest(body),
        response: responseSummary,
      },
    });

    return json(payload);
  };
}
