import { json } from '@remix-run/node';
import prisma from '../db.server.js';
import { upsertFxRate } from '../utils/fxRates.server.js';
import { applyProductPrice } from '../utils/applyProductPrice.server.js';
import { normalizeShopDomain } from '../utils/shopifyAdmin.server.js';

const TARGET_CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY', 'KRW'];
const AUTO_PRICE_REFRESH_LOG_PREFIX = '[fx-refresh:auto-price]';

let activeAutoPriceRefreshPromise = null;

function normalizeBooleanFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function createErrorResponse(error, status = 500) {
  return json(
    {
      ok: false,
      error,
    },
    { status },
  );
}

function createAutoPriceRefreshSummary() {
  return {
    targeted: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    failedProducts: [],
    skippedMissingShopDomainProducts: [],
  };
}

async function readExchangeRates({ apiKey, fetchImpl }) {
  const response = await fetchImpl(`https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`, {
    method: 'GET',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.['error-type']
        ? `Exchange rate API error: ${data['error-type']}`
        : 'Failed to refresh exchange rates',
    );
  }

  const rates = data?.conversion_rates;

  if (!rates || typeof rates !== 'object') {
    throw new Error('conversion_rates was not returned from the exchange rate API');
  }

  const usdToJpy = Number(rates.JPY);

  if (!Number.isFinite(usdToJpy) || usdToJpy <= 0) {
    throw new Error('USD/JPY rate was invalid');
  }

  return {
    rates,
    usdToJpy,
  };
}

async function saveTargetFxRates({ rates, usdToJpy, upsertFxRateImpl }) {
  const savedRates = [];

  for (const currency of TARGET_CURRENCIES) {
    let rateToJpy;

    if (currency === 'USD') {
      rateToJpy = usdToJpy;
    } else if (currency === 'JPY') {
      rateToJpy = 1;
    } else {
      const usdToCurrency = Number(rates[currency]);

      if (!Number.isFinite(usdToCurrency) || usdToCurrency <= 0) {
        throw new Error(`USD/${currency} rate was invalid`);
      }

      rateToJpy = usdToJpy / usdToCurrency;
    }

    if (!Number.isFinite(rateToJpy) || rateToJpy <= 0) {
      throw new Error(`${currency}/JPY rate was invalid`);
    }

    savedRates.push(
      await upsertFxRateImpl({
        base: currency,
        quote: 'JPY',
        rate: rateToJpy,
      }),
    );
  }

  return savedRates;
}

export function createRunAutoPriceRefresh({
  prismaClient = prisma,
  applyProductPriceImpl = applyProductPrice,
  normalizeShopDomainImpl = normalizeShopDomain,
  logInfo = console.info,
  logError = console.error,
} = {}) {
  return async function runAutoPriceRefresh() {
    const summary = createAutoPriceRefreshSummary();
    const products = await prismaClient.product.findMany({
      where: {
        shopifyProductId: {
          not: null,
        },
      },
      select: {
        id: true,
        shopifyProductId: true,
        shopDomain: true,
      },
    });
    const seenTargets = new Set();

    summary.targeted = products.length;

    for (const product of products) {
      const localProductId = product?.id || null;
      const shopifyProductId = product?.shopifyProductId || null;
      const shopDomain = normalizeShopDomainImpl(product?.shopDomain);
      const targetIdentifier = localProductId || shopifyProductId || 'unknown_product';

      if (!shopifyProductId || !shopDomain) {
        summary.skipped += 1;
        if (!shopDomain) {
          summary.skippedMissingShopDomainProducts.push(targetIdentifier);
        }
        continue;
      }

      const dedupeKey = `${shopDomain}::${shopifyProductId}`;

      if (seenTargets.has(dedupeKey)) {
        summary.skipped += 1;
        continue;
      }

      seenTargets.add(dedupeKey);
      summary.processed += 1;

      try {
        const result = await applyProductPriceImpl(shopifyProductId, {
          shopDomain,
          localProductId,
        });

        if (result?.skipped) {
          summary.skipped += 1;
        } else {
          summary.updated += 1;
        }
      } catch (error) {
        summary.failed += 1;
        summary.failedProducts.push(targetIdentifier);
        logError(`${AUTO_PRICE_REFRESH_LOG_PREFIX} failed`, {
          productId: localProductId,
          shopifyProductId,
          shopDomain,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logInfo(`${AUTO_PRICE_REFRESH_LOG_PREFIX} summary`, summary);

    return summary;
  };
}

function runAutoPriceRefreshWithLock(runAutoPriceRefreshImpl, logInfo = console.info) {
  if (activeAutoPriceRefreshPromise) {
    logInfo(`${AUTO_PRICE_REFRESH_LOG_PREFIX} reusing in-flight refresh run`);
    return activeAutoPriceRefreshPromise;
  }

  activeAutoPriceRefreshPromise = (async () => {
    try {
      return await runAutoPriceRefreshImpl();
    } finally {
      activeAutoPriceRefreshPromise = null;
    }
  })();

  return activeAutoPriceRefreshPromise;
}

const runAutoPriceRefresh = createRunAutoPriceRefresh();

export function createRefreshFxAction({
  apiKey = process.env.EXCHANGE_RATE_API_KEY,
  fetchImpl = fetch,
  upsertFxRateImpl = upsertFxRate,
  runAutoPriceRefreshImpl = runAutoPriceRefresh,
} = {}) {
  return async function action({ request }) {
    try {
      if (!apiKey) {
        return createErrorResponse('EXCHANGE_RATE_API_KEY is not configured');
      }

      const requestUrl = new URL(request.url);
      const autoApplyPrices = normalizeBooleanFlag(requestUrl.searchParams.get('autoApplyPrices'));
      const { rates, usdToJpy } = await readExchangeRates({
        apiKey,
        fetchImpl,
      });
      const savedRates = await saveTargetFxRates({
        rates,
        usdToJpy,
        upsertFxRateImpl,
      });
      const priceRefresh = autoApplyPrices
        ? await runAutoPriceRefreshWithLock(runAutoPriceRefreshImpl)
        : null;

      return json({
        ok: true,
        message: `Updated ${savedRates.length} FX rates`,
        fxRates: savedRates,
        priceRefresh,
      });
    } catch (error) {
      return createErrorResponse(
        error instanceof Error ? error.message : 'Unknown error while refreshing FX rates',
      );
    }
  };
}
