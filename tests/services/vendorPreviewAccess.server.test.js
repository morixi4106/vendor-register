import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminVendorPreviewLoader,
  createDisabledVendorPreviewAction,
} from "../../app/services/vendorPreviewAccess.server.js";

test("vendor preview rejects anonymous access before loading store data", async () => {
  let loaded = false;
  const unauthorized = new Response("Unauthorized", { status: 401 });
  const loader = createAdminVendorPreviewLoader({
    authenticateAdminImpl: async () => {
      throw unauthorized;
    },
    loadPreviewImpl: async () => {
      loaded = true;
      return new Response("preview");
    },
  });

  await assert.rejects(
    () =>
      loader({
        request: new Request(
          "https://example.com/preview/vendors/amber-cellar",
        ),
        params: { handle: "amber-cellar" },
      }),
    (error) => error === unauthorized,
  );
  assert.equal(loaded, false);
});

test("vendor preview loads for an authenticated Shopify administrator", async () => {
  let authenticatedRequest = null;
  const response = new Response("preview");
  const loader = createAdminVendorPreviewLoader({
    authenticateAdminImpl: async (request) => {
      authenticatedRequest = request;
    },
    loadPreviewImpl: async ({ params }) => {
      assert.equal(params.handle, "amber-cellar");
      return response;
    },
  });
  const request = new Request(
    "https://example.com/preview/vendors/amber-cellar",
  );

  const result = await loader({
    request,
    params: { handle: "amber-cellar" },
  });

  assert.equal(authenticatedRequest, request);
  assert.equal(result, response);
});

test("vendor preview purchase action is always hidden", async () => {
  const action = createDisabledVendorPreviewAction();

  await assert.rejects(
    () =>
      action({
        request: new Request(
          "https://example.com/preview/vendors/amber-cellar",
          { method: "POST" },
        ),
        params: { handle: "amber-cellar" },
      }),
    (error) =>
      error instanceof Response &&
      error.status === 404 &&
      error.headers.get("Cache-Control") === "no-store" &&
      error.headers.get("X-Robots-Tag") === "noindex, nofollow",
  );
});
