import {
  internationalGateError,
  internationalGraphQL,
} from "./internationalGateTransport.server.js";
import {
  internationalHash,
  serializeInternationalProjection,
} from "./internationalGateProjection.server.js";

export const NATIVE_MARKETS_QUERY = `query InternationalNativeMarkets($after: String) {
  markets(first: 1, after: $after) { nodes { id status
    conditions { conditionTypes regionsCondition { applicationLevel regions(first: 250) {
      nodes { __typename ... on MarketRegionCountry { code } } pageInfo { hasNextPage }
    } } }
    currencySettings { baseCurrency { currencyCode } localCurrencies }
  } pageInfo { hasNextPage endCursor } }
}`;

export const NATIVE_ACCESS_QUERY = `query InternationalNativeAccess {
  currentAppInstallation { accessScopes { handle } }
}`;

// A reader belongs to one inspection, never a process-wide success cache.
export function createNativeReadSession({
  graphQL = internationalGraphQL,
  budgetMs = 15000,
} = {}) {
  const budget = Math.min(15000, Math.max(1, Number(budgetMs) || 15000));
  const deadline = performance.now() + budget;
  const responses = new Map();
  return async (args) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0)
      throw internationalGateError("international_native_timeout");
    if (!/^\s*(?:#graphql\s+)?query\s/.test(args.query || ""))
      throw internationalGateError("international_native_read_only");
    const key = serializeInternationalProjection({
      shopDomain: args.shopDomain,
      query: args.query,
      variables: args.variables || {},
    });
    if (!responses.has(key)) {
      responses.set(
        key,
        (async () => {
          const timeoutMs = Math.max(1, Math.min(remaining, args.timeoutMs || 10000, 10000));
          const controller = new AbortController();
          let timer;
          try {
            return await Promise.race([
              graphQL({
                ...args,
                timeoutMs,
                signal: controller.signal,
              }),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(
                    internationalGateError("international_native_timeout"),
                  );
                }, timeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        })(),
      );
    }
    return responses.get(key);
  };
}

export async function inspectNativeReadAccess({ shopDomain, graphQL }) {
  const result = await graphQL({ shopDomain, query: NATIVE_ACCESS_QUERY });
  const scopes = result?.data?.currentAppInstallation?.accessScopes;
  if (result?.errors?.length || !Array.isArray(scopes)) return false;
  const handles = scopes.map((scope) => scope?.handle);
  return (
    handles.includes("read_markets") &&
    handles.some((handle) =>
      ["read_shipping", "write_shipping"].includes(handle),
    )
  );
}

export async function readNativeInventory({
  shopDomain,
  query,
  field,
  graphQL,
  onPage = () => {},
}) {
  const rows = [];
  const seenCursors = new Set();
  const seenIds = new Set();
  let after = null;
  for (let page = 0; page < 10; page++) {
    const response = await graphQL({ shopDomain, query, variables: { after } });
    const connection = response?.data?.[field];
    if (Array.isArray(connection?.nodes)) onPage(connection.nodes);
    if (
      response?.errors?.length ||
      !Array.isArray(connection?.nodes) ||
      connection.nodes.length > 1 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      connection.nodes.some((row) => !row?.id || seenIds.has(row.id))
    )
      throw internationalGateError("international_inventory_incomplete");
    for (const row of connection.nodes) seenIds.add(row.id);
    rows.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return rows;
    after = connection.pageInfo.endCursor;
    if (!connection.nodes.length || !after || seenCursors.has(after)) break;
    seenCursors.add(after);
  }
  throw internationalGateError("international_inventory_incomplete");
}

export function nativeConnectionComplete(connection) {
  return (
    Array.isArray(connection?.nodes) &&
    connection.pageInfo?.hasNextPage === false
  );
}

// Queried native collections are sets; their API ordering is not configuration.
export function hashNativeConfiguration(value) {
  function normalize(entry) {
    if (Array.isArray(entry))
      return entry.map(normalize).sort((a, b) => {
        const left = serializeInternationalProjection(a);
        const right = serializeInternationalProjection(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    if (entry && typeof entry === "object")
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [key, normalize(child)]),
      );
    return entry;
  }
  return internationalHash(normalize(value));
}
