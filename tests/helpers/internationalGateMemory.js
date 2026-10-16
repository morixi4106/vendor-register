import { sealInternationalProjection } from "../../app/services/internationalGateProjection.server.js";

export function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return value.some((part) => matches(row, part));
    if (key === "AND") return value.every((part) => matches(row, part));
    const actual = row[key];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]) => {
        if (operator === "in") return expected.includes(actual);
        if (operator === "not") return actual !== expected;
        if (operator === "lt") return actual < expected;
        if (operator === "lte") return actual <= expected;
        if (operator === "gt") return actual > expected;
        throw new Error(`unsupported predicate ${operator}`);
      });
    }
    return value === null ? actual == null : actual === value;
  });
}

function apply(row, data) {
  for (const [key, value] of Object.entries(data))
    row[key] =
      value && typeof value === "object" && "increment" in value
        ? row[key] + value.increment
        : structuredClone(value);
  return row;
}

export function internationalMemory(initialStates = []) {
  const storage = { states: structuredClone(initialStates), jobs: [] };
  let sequence = 0;
  const delegate = (key) => ({
    findUnique: async ({ where }) =>
      structuredClone(storage[key].find((row) => matches(row, where)) || null),
    findMany: async ({ where, take } = {}) =>
      structuredClone(
        storage[key].filter((row) => matches(row, where)).slice(0, take),
      ),
    count: async ({ where }) =>
      storage[key].filter((row) => matches(row, where)).length,
    create: async ({ data }) => {
      const row = {
        id: `row-${++sequence}`,
        mode: "DISABLED",
        desiredGeneration: 0,
        appliedGeneration: 0,
        authorizedScopeJson: [],
        phase: "UNCONFIGURED",
        snapshotComplete: false,
        expectedProductCount: 0,
        verifiedProductCount: 0,
        attempts: 0,
        status: "PENDING",
        nextAttemptAt: new Date(0),
        leaseToken: null,
        leaseUntil: null,
        createdAt: new Date(),
        ...structuredClone(data),
      };
      if (
        key === "jobs" &&
        storage.jobs.some((job) =>
          ["shopDomain", "generation", "targetType", "targetId"].every(
            (k) => job[k] === row[k],
          ),
        )
      ) {
        throw new Error("unique job constraint");
      }
      storage[key].push(row);
      return structuredClone(row);
    },
    update: async ({ where, data }) => {
      const row = storage[key].find((row) => matches(row, where));
      if (!row) throw new Error("row missing");
      return structuredClone(apply(row, data));
    },
    updateMany: async ({ where, data }) => {
      const rows = storage[key].filter((row) => matches(row, where));
      rows.forEach((row) => apply(row, data));
      return { count: rows.length };
    },
  });
  const db = {
    internationalGateSyncState: delegate("states"),
    internationalGateSyncJob: delegate("jobs"),
  };
  db.internationalGateSyncState.upsert = async ({ where, create, update }) =>
    storage.states.some((row) => matches(row, where))
      ? db.internationalGateSyncState.update({ where, data: update })
      : db.internationalGateSyncState.create({ data: create });
  const client = {
    ...db,
    $transaction: async (callback) => {
      const before = structuredClone(storage);
      try {
        return await callback(db);
      } catch (error) {
        Object.assign(storage, before);
        throw error;
      }
    },
  };
  return { db: client, tx: db, storage };
}

export function internationalGraphMemory() {
  const values = new Map();
  const writes = [];
  let digest = 0;
  let beforeCall = async () => {};
  const graphQL = async (args) => {
    await beforeCall(args);
    const { query, variables } = args;
    if (query.includes("mutation InternationalGateSet")) {
      const row = variables.metafields[0];
      const existing = values.get(row.ownerId);
      if (row.compareDigest !== (existing?.compareDigest ?? null))
        return {
          data: {
            metafieldsSet: { userErrors: [{ code: "INVALID_COMPARE_DIGEST" }] },
          },
        };
      writes.push(structuredClone(row));
      values.set(row.ownerId, {
        value: row.value,
        compareDigest: `digest-${++digest}`,
      });
      return { data: { metafieldsSet: { userErrors: [] } } };
    }
    if (query.includes("InternationalGateReadbacks"))
      return {
        data: {
          nodes: variables.ids.map((id) => ({ id, gate: values.get(id) })),
        },
      };
    if (query.includes("InternationalGateShop"))
      return {
        data: {
          shop: {
            id: "gid://shopify/Shop/1",
            ianaTimezone: "Asia/Tokyo",
            gate: values.get("gid://shopify/Shop/1") || null,
          },
        },
      };
    if (query.includes("InternationalGateProduct"))
      return {
        data: {
          node: { id: variables.id, gate: values.get(variables.id) || null },
        },
      };
    throw new Error("unexpected GraphQL request");
  };
  return {
    values,
    writes,
    graphQL,
    beforeCall: (callback) => {
      beforeCall = callback;
    },
  };
}

export function syncFixture() {
  const now = new Date();
  const d = now.toISOString().slice(0, 10);
  const e = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const state = {
    shopDomain: "example.myshopify.com",
    mode: "ENFORCE",
    phase: "PENDING",
    desiredGeneration: 1,
    appliedGeneration: 0,
    snapshotComplete: false,
    authorizedScopeJson: [
      {
        productId: "p1",
        shopifyProductId: "gid://shopify/Product/1",
        countries: ["US"],
      },
    ],
    releaseBinding: "release",
    nativeConfigHash: "native",
    shopTimezone: "Asia/Tokyo",
    authorizationExpiresAt: new Date(now.getTime() + 7 * 86400000),
  };
  const memory = internationalMemory([state]);
  memory.storage.jobs.push({
    id: "reconcile",
    shopDomain: state.shopDomain,
    generation: 1,
    targetType: "RECONCILE",
    targetId: state.shopDomain,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: new Date(0),
    leaseUntil: null,
    leaseToken: null,
    createdAt: now,
  });
  memory.db.operationalReadinessAttestation =
    memory.tx.operationalReadinessAttestation = { findMany: async () => [] };
  const graph = internationalGraphMemory();
  const buildSnapshot = async ({ state }) => ({
    sourceHash: "source",
    targets: [
      {
        targetId: "gid://shopify/Product/1",
        projection: sealInternationalProjection({
          v: 1,
          p: "international-sale-2026-10-v1",
          i: "gid://shopify/Product/1",
          g: state.desiredGeneration,
          r: 1,
          d,
          e,
          c: ["US"],
        }),
      },
    ],
    shop: sealInternationalProjection({
      v: 2,
      p: "international-sale-2026-10-v1",
      g: state.desiredGeneration,
      s: "ACTIVE",
      d,
      e,
      c: ["US"],
    }),
    nextExpiryAt: new Date(now.getTime() + 86400000),
  });
  const dependencies = {
    graphQL: graph.graphQL,
    buildSnapshot,
    inspectStopProtection: async () => ({ ready: true }),
    inspectNative: async () => ({
      available: true,
      validationReady: true,
      configHash: "native",
    }),
    inspectRelease: async () => ({ ready: true, binding: "release" }),
    inspectAuthorization: async () => ({ ready: true, purpose: "SALE" }),
  };
  return { ...memory, graph, dependencies, state, now };
}
