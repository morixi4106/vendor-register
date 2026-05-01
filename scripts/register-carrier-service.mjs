import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';

const DEFAULT_API_VERSION = '2025-01';
const CARRIER_SERVICE_NAME = 'Shipping V2';

const SHOP_AND_CARRIER_SERVICES_QUERY = `#graphql
  query ShopAndCarrierServices {
    shop {
      name
      myshopifyDomain
      primaryDomain {
        host
        url
      }
    }
    carrierServices(first: 20) {
      nodes {
        id
        name
        active
        callbackUrl
        supportsServiceDiscovery
      }
    }
  }
`;

const CARRIER_SERVICE_CREATE_MUTATION = `#graphql
  mutation ShippingV2CarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
    carrierServiceCreate(input: $input) {
      carrierService {
        id
        name
        active
        callbackUrl
        supportsServiceDiscovery
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CARRIER_SERVICE_UPDATE_MUTATION = `#graphql
  mutation ShippingV2CarrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
    carrierServiceUpdate(input: $input) {
      carrierService {
        id
        name
        active
        callbackUrl
        supportsServiceDiscovery
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, 'utf8');

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function normalizeShopDomain(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

function normalizeCallbackUrl(value) {
  const normalized = String(value || '').trim();

  if (!normalized || !/^https:\/\//i.test(normalized)) {
    throw new Error('callbackUrl must be an https URL');
  }

  return normalized;
}

function maskSession(session) {
  return {
    id: session.id,
    shop: session.shop,
    isOnline: session.isOnline,
    scope: session.scope || null,
    expires: session.expires || null,
    hasAccessToken: Boolean(session.accessToken),
  };
}

function summarizeCarrierService(service) {
  return {
    id: service.id,
    name: service.name,
    active: service.active,
    callbackUrl: service.callbackUrl,
    supportsServiceDiscovery: service.supportsServiceDiscovery,
  };
}

async function adminGraphQL({ shopDomain, accessToken, query, variables = {}, apiVersion }) {
  const response = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Admin GraphQL HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (payload?.errors?.length) {
    throw new Error(`Admin GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, '.env'));
  loadEnvFile(path.join(cwd, '.env.production'));

  const targetShop = normalizeShopDomain(process.argv[2]);
  const callbackUrl = normalizeCallbackUrl(process.argv[3]);
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || DEFAULT_API_VERSION;

  if (!targetShop) {
    throw new Error(
      'Usage: node scripts/register-carrier-service.mjs <shop.myshopify.com> <https callbackUrl>',
    );
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to read Shopify sessions');
  }

  const prisma = new PrismaClient();

  try {
    const sessions = await prisma.session.findMany({
      where: {
        shop: targetShop,
      },
      orderBy: [
        { isOnline: 'asc' },
        { expires: 'desc' },
      ],
    });
    const offlineSession = sessions.find((session) => session.isOnline === false && session.accessToken);

    console.log(JSON.stringify({
      step: 'session_lookup',
      targetShop,
      sessionFound: Boolean(offlineSession),
      sessions: sessions.map(maskSession),
    }, null, 2));

    if (!offlineSession) {
      console.log(JSON.stringify({
        ok: false,
        reason: 'missing_offline_session',
        message:
          'No offline Shopify session was found for the production shop. Install or re-authorize the app on this shop with read_shipping/write_shipping, then rerun this script.',
        nextAction:
          'Install or re-authorize the app on oja-immanuel-bacchus.myshopify.com so Prisma Session contains an offline token for that exact shop.',
      }, null, 2));
      process.exitCode = 2;
      return;
    }

    const initialData = await adminGraphQL({
      shopDomain: targetShop,
      accessToken: offlineSession.accessToken,
      query: SHOP_AND_CARRIER_SERVICES_QUERY,
      apiVersion,
    });
    const myshopifyDomain = normalizeShopDomain(initialData?.shop?.myshopifyDomain);
    const carrierServices = Array.isArray(initialData?.carrierServices?.nodes)
      ? initialData.carrierServices.nodes
      : [];

    console.log(JSON.stringify({
      step: 'shop_confirmed',
      requestedShop: targetShop,
      shopMyshopifyDomain: myshopifyDomain,
      shopName: initialData?.shop?.name || null,
      primaryDomain: initialData?.shop?.primaryDomain || null,
    }, null, 2));

    if (myshopifyDomain !== targetShop) {
      throw new Error(
        `Session token resolved to ${myshopifyDomain || 'unknown shop'}, not ${targetShop}`,
      );
    }

    console.log(JSON.stringify({
      step: 'carrier_services_before',
      carrierServices: carrierServices.map(summarizeCarrierService),
    }, null, 2));

    const existing = carrierServices.find((service) => service?.name === CARRIER_SERVICE_NAME);
    const variables = existing
      ? {
          input: {
            id: existing.id,
            name: CARRIER_SERVICE_NAME,
            callbackUrl,
            active: true,
            supportsServiceDiscovery: true,
          },
        }
      : {
          input: {
            name: CARRIER_SERVICE_NAME,
            callbackUrl,
            active: true,
            supportsServiceDiscovery: true,
          },
        };
    const mutationData = await adminGraphQL({
      shopDomain: targetShop,
      accessToken: offlineSession.accessToken,
      query: existing ? CARRIER_SERVICE_UPDATE_MUTATION : CARRIER_SERVICE_CREATE_MUTATION,
      variables,
      apiVersion,
    });
    const mutationKey = existing ? 'carrierServiceUpdate' : 'carrierServiceCreate';
    const mutationPayload = mutationData?.[mutationKey] || {};
    const userErrors = Array.isArray(mutationPayload.userErrors) ? mutationPayload.userErrors : [];

    console.log(JSON.stringify({
      step: 'carrier_service_upsert',
      operation: existing ? 'update' : 'create',
      userErrors,
      carrierService: mutationPayload.carrierService
        ? summarizeCarrierService(mutationPayload.carrierService)
        : null,
    }, null, 2));

    const finalData = await adminGraphQL({
      shopDomain: targetShop,
      accessToken: offlineSession.accessToken,
      query: SHOP_AND_CARRIER_SERVICES_QUERY,
      apiVersion,
    });
    const finalService = finalData?.carrierServices?.nodes?.find(
      (service) => service?.name === CARRIER_SERVICE_NAME,
    );

    console.log(JSON.stringify({
      ok: userErrors.length === 0,
      targetShop,
      shopMyshopifyDomain: finalData?.shop?.myshopifyDomain || null,
      operation: existing ? 'update' : 'create',
      callbackUrl,
      shippingV2: finalService ? summarizeCarrierService(finalService) : null,
    }, null, 2));

    if (userErrors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
