import assert from "node:assert/strict";
import test from "node:test";
import { redirect } from "react-router";
import {
  MARKETPLACE_OPERATOR_ROLES,
  resolveInternationalShippingOperatorRole,
} from "../../app/utils/marketplaceOperatorRoles.js";
import { readBoundedFormData } from "../../app/utils/requestBody.server.js";
import { requirePostRequest } from "../../app/utils/internalRouteSecurity.server.js";
import {
  getInternationalMarketRequirements,
  INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
} from "../../app/utils/internationalMarketReadiness.js";
import { loadRouteHandler } from "../helpers/loadRouteHandler.js";
import { internationalEvidenceVersion } from "../../app/services/internationalGateQueue.server.js";

const route = new URL(
  "../../app/routes/app.international-shipping.jsx",
  import.meta.url,
);
const roles = MARKETPLACE_OPERATOR_ROLES;

function fixture(assignedRole = roles.ADMIN) {
  const calls = [];
  const dependencies = {
    MARKETPLACE_OPERATOR_ROLES,
    resolveInternationalShippingOperatorRole,
    readBoundedFormData,
    requirePostRequest,
    getInternationalMarketRequirements,
    INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
    redirect,
    internationalEvidenceVersion,
    requireMarketplaceOperator: async (_request, options) => {
      calls.push(["authorize", options]);
      const allowed = options.roles || [options.role];
      if (assignedRole !== roles.ADMIN && !allowed.includes(assignedRole))
        throw new Response("Forbidden", { status: 403 });
      return {
        session: { shop: "example.myshopify.com" },
        operator: { actorKey: "shopify_user:123" },
      };
    },
    saveInternationalShippingCountryAvailability: async (data) =>
      calls.push(["saveShipping", data]),
    saveInternationalMarketEvidence: async (data) =>
      calls.push(["saveMarketEvidence", data]),
    syncInternationalSaleGate: async (data) => {
      calls.push(["sync", data]);
      return { ok: true, pending: true, protected: false };
    },
    stopInternationalGateSync: async (data) => { calls.push(["stop", data]); return { ok: true, protected: false }; },
    revokeInternationalMarketEvidence: async (data) => calls.push(["revoke", data]),
    prisma: {
      internationalGateSyncState: { findUnique: async () => { calls.push(["gateRead"]); return null; } },
      internationalShippingCountryAvailability: {
        findMany: async () => {
          calls.push(["shippingRead"]);
          return [];
        },
      },
      operationalReadinessAttestation: {
        findMany: async () => {
          calls.push(["evidenceRead"]);
          return [];
        },
      },
    },
  };
  return {
    calls,
    dependencies,
    action: () => loadRouteHandler(route, "action", dependencies),
    loader: () => loadRouteHandler(route, "loader", dependencies),
  };
}

function request(intent, extra = {}) {
  return new Request("https://example.test/app/international-shipping", {
    method: "POST",
    body: new URLSearchParams({ intent, countryCode: "US", expectedVersion: "absent", ...extra }),
  });
}

test("international evidence writes use the authenticated compliance actor, never submitted identity", async () => {
  for (const intent of ["saveShipping", "saveMarketEvidence"]) {
    const f = fixture(roles.COMPLIANCE_REVIEWER);
    const response = await f.action()({
      request: request(intent, { confirmedBy: "forged" }),
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(f.calls[0][1].role, roles.COMPLIANCE_REVIEWER);
    assert.equal(f.calls[1][1].confirmedBy, "shopify_user:123");
    assert.equal(f.calls.length, 2);
  }
});

test("release managers sync but cannot attest, compliance reviewers attest but cannot sync", async () => {
  const permitted = fixture(roles.RELEASE_MANAGER);
  const response = await permitted.action()({
    request: request("syncInternationalSaleGate"),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(permitted.calls[0][1].role, roles.RELEASE_MANAGER);
  for (const [role, intent] of [
    [roles.RELEASE_MANAGER, "saveShipping"],
    [roles.RELEASE_MANAGER, "saveMarketEvidence"],
    [roles.COMPLIANCE_REVIEWER, "syncInternationalSaleGate"],
    [roles.FINANCE_EXECUTOR, "saveShipping"],
  ]) {
    const f = fixture(role);
    await assert.rejects(
      f.action()({ request: request(intent) }),
      (error) => error.status === 403,
    );
    assert.equal(f.calls.length, 1);
  }
});

test("unknown intents, non-POST and oversized input do not reach a service", async () => {
  for (const intent of ["", "deleteEverything", " saveShipping "]) {
    const f = fixture();
    const response = await f.action()({ request: request(intent) });
    // Whitespace cannot authorize one intent and silently execute another.
    assert.equal(response.status, 400);
    assert.ok(!f.calls.some(([name]) => name !== "authorize"));
  }
  for (const [req, status] of [
    [new Request("https://example.test"), 405],
    [request("saveShipping", { note: "a".repeat(32001) }), 413],
  ]) {
    const f = fixture();
    await assert.rejects(
      f.action()({ request: req }),
      (error) => error.status === status,
    );
    assert.deepEqual(f.calls, []);
  }
});

test("service failures do not expose database details", async () => {
  const f = fixture();
  f.dependencies.saveInternationalShippingCountryAvailability = async () => {
    throw new Error("postgres://private-secret SQL table");
  };
  const response = await f.action()({ request: request("saveShipping") });
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.ok(!body.includes("private-secret"));
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("sync rejection is not reported as success", async () => {
  const f = fixture();
  f.dependencies.syncInternationalSaleGate = async () => ({ ok: false, reason: "international_sync_not_armed" });
  const response = await f.action()({ request: request("syncInternationalSaleGate") });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).ok, false);
});

test("stale evidence returns 409 without exposing source details", async () => {
  const f = fixture();
  f.dependencies.saveInternationalMarketEvidence = async () => { const error = new Error("private database value"); error.code = "INTERNATIONAL_EVIDENCE_CONFLICT"; throw error; };
  const response = await f.action()({ request: request("saveMarketEvidence") });
  assert.equal(response.status, 409);
  assert.ok(!(await response.text()).includes("private database"));
});

test("revoke and stop retain separate operator roles", async () => {
  const f = fixture(roles.COMPLIANCE_REVIEWER);
  assert.equal((await f.action()({ request: request("revokeMarketEvidence") })).status, 302);
  assert.equal(f.calls[1][0], "revoke");
  await assert.rejects(f.action()({ request: request("stopInternationalSaleGate") }), (error) => error.status === 403);
  const incident = fixture(roles.INCIDENT_COMMANDER);
  assert.equal((await incident.action()({ request: request("stopInternationalSaleGate") })).status, 200);
});

test("loader is authorized, non-cached and read-only", async () => {
  for (const role of [
    roles.ADMIN,
    roles.COMPLIANCE_REVIEWER,
    roles.RELEASE_MANAGER,
  ]) {
    const f = fixture(role);
    const response = await f.loader()({
      request: new Request("https://example.test"),
    });
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(
      f.calls.map(([name]) => name),
      ["authorize", "shippingRead", "evidenceRead", "gateRead"],
    );
  }
  const f = fixture(roles.FINANCE_EXECUTOR);
  await assert.rejects(
    f.loader()({ request: new Request("https://example.test") }),
    (error) => error.status === 403,
  );
  assert.equal(f.calls.length, 1);
});
