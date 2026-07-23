import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVendorPreviewDocumentHeaders,
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

  const response = await action({
    request: new Request(
      "https://example.com/preview/vendors/amber-cellar",
      { method: "POST" },
    ),
    params: { handle: "amber-cellar" },
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("vendor preview document responses remain private after Remix header merging", () => {
  const headers = buildVendorPreviewDocumentHeaders({
    loaderHeaders: new Headers({
      "Content-Language": "ja",
      "Cache-Control": "public, max-age=3600",
    }),
    actionHeaders: new Headers({
      "X-Action-Result": "hidden",
    }),
  });

  assert.equal(headers.get("Content-Language"), "ja");
  assert.equal(headers.get("X-Action-Result"), "hidden");
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headers.get("X-Robots-Tag"), "noindex, nofollow");
});
