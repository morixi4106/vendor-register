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

const SHOP = 'b30ize-1a.myshopify.com';
const API_VERSION = '2026-01';
const prisma = new PrismaClient();

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

async function findDefinition(ownerType, namespace, key) {
  const query = `
    query FindDefinition($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
      metafieldDefinitions(first: 1, ownerType: $ownerType, namespace: $namespace, key: $key) {
        nodes {
          id
          name
          namespace
          key
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { ownerType, namespace, key });
  return data.metafieldDefinitions.nodes[0] || null;
}

async function createDefinition(definition) {
  const mutation = `
    mutation CreateDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition {
          id
          name
          namespace
          key
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const data = await shopifyGraphQL(mutation, { definition });
  const result = data.metafieldDefinitionCreate;

  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(JSON.stringify(result.userErrors));
  }

  return result.createdDefinition;
}

const definitions = [
  {
    name: 'Cost Amount',
    namespace: 'pricing',
    key: 'cost_amount',
    description: 'Product cost amount',
    type: 'number_decimal',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Cost Currency',
    namespace: 'pricing',
    key: 'cost_currency',
    description: 'Product cost currency',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Duty Category',
    namespace: 'pricing',
    key: 'duty_category',
    description: 'Duty category key',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Packaging Fee',
    namespace: 'pricing',
    key: 'packaging_fee',
    description: 'Packaging fee',
    type: 'number_decimal',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Weight (g)',
    namespace: 'shipping',
    key: 'weight_grams',
    description: 'Shipping weight in grams',
    type: 'number_integer',
    ownerType: 'PRODUCT',
  },
  {
    name: 'Shipping Profile',
    namespace: 'shipping',
    key: 'shipping_profile_key',
    description: 'Shipping profile key',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
  }
];

async function main() {
  for (const def of definitions) {
    const existing = await findDefinition(def.ownerType, def.namespace, def.key);

    if (existing) {
      console.log(`SKIP ${def.namespace}.${def.key} already exists`);
      continue;
    }

    const created = await createDefinition(def);
    console.log(`CREATED ${created.namespace}.${created.key}`);
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
