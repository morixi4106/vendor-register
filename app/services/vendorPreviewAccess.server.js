const HIDDEN_PREVIEW_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
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

export function buildVendorPreviewDocumentHeaders({
  loaderHeaders,
  actionHeaders,
} = {}) {
  const headers = new Headers();

  for (const source of [loaderHeaders, actionHeaders]) {
    source?.forEach((value, key) => headers.set(key, value));
  }

  for (const [key, value] of Object.entries(HIDDEN_PREVIEW_HEADERS)) {
    headers.set(key, value);
  }

  return headers;
}
