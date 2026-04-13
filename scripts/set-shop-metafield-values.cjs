const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function loadEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const SHOP = String(process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
const API_VERSION = '2026-01';
const prisma = new PrismaClient();

if (!SHOP) {
  throw new Error('SHOPIFY_SHOP_DOMAIN is required');
}

async function getOfflineAccessToken() {
  const sessionId = `offline_${SHOP}`;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });

  if (!session || !session.accessToken) {
    throw new Error(`Offline session not found: ${sessionId}`);
  }

  return session.accessToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getOfflineAccessToken();

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${JSON.stringify(data)}`);
  }

  if (data.errors && data.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

async function getShopId() {
  const query = `
    query {
      shop {
        id
        name
      }
    }
  `;

  const data = await shopifyGraphQL(query);
  return data.shop.id;
}

async function setMetafields(ownerId, metafields) {
  const mutation = `
    mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const payload = metafields.map((m) => ({
    ownerId,
    namespace: m.namespace,
    key: m.key,
    type: m.type,
    value: m.value,
  }));

  const data = await shopifyGraphQL(mutation, { metafields: payload });
  const result = data.metafieldsSet;

  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(JSON.stringify(result.userErrors));
  }

  return result.metafields;
}

async function main() {
  const shopId = await getShopId();

  const metafields = [
    {
      namespace: 'global_pricing',
      key: 'default_margin_rate',
      type: 'number_decimal',
      value: '0.10',
    },
    {
      namespace: 'global_pricing',
      key: 'payment_fee_rate',
      type: 'number_decimal',
      value: '0.04',
    },
    {
      namespace: 'global_pricing',
      key: 'payment_fee_fixed',
      type: 'number_decimal',
      value: '50',
    },
    {
      namespace: 'global_pricing',
      key: 'buffer_rate',
      type: 'number_decimal',
      value: '0.10',
    },
  ];

  const result = await setMetafields(shopId, metafields);

  for (const item of result) {
    console.log(`SET ${item.namespace}.${item.key} = ${item.value}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
