const HIDDEN_PREVIEW_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

function buildHiddenPreviewResponse() {
  return new Response("Not Found", {
    status: 404,
    headers: HIDDEN_PREVIEW_HEADERS,
  });
}

export function createAdminVendorPreviewLoader({
  authenticateAdminImpl,
  loadPreviewImpl,
}) {
  if (typeof authenticateAdminImpl !== "function") {
    throw new TypeError("authenticateAdminImpl must be a function");
  }

  if (typeof loadPreviewImpl !== "function") {
    throw new TypeError("loadPreviewImpl must be a function");
  }

  return async function loader(args) {
    await authenticateAdminImpl(args.request);
    return loadPreviewImpl(args);
  };
}

export function createDisabledVendorPreviewAction() {
  return async function action() {
    return buildHiddenPreviewResponse();
  };
}
