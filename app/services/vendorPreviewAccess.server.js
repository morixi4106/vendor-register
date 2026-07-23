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

function buildPreviewAccessError(message, status) {
  return new Response(message, {
    status,
    headers: HIDDEN_PREVIEW_HEADERS,
  });
}

function normalizeShopDomain(value) {
  return String(value || "").trim().toLowerCase();
}

export function createVendorPreviewOperatorAuthorizer({
  requireOperatorImpl,
  primaryShopDomain,
}) {
  if (typeof requireOperatorImpl !== "function") {
    throw new TypeError("requireOperatorImpl must be a function");
  }

  const configuredShop = normalizeShopDomain(primaryShopDomain);

  return async function authorizeVendorPreviewOperator(request) {
    if (!configuredShop) {
      throw buildPreviewAccessError("Preview access is not configured.", 503);
    }

    const context = await requireOperatorImpl(request);
    const sessionShop = normalizeShopDomain(context?.session?.shop);

    if (!sessionShop || sessionShop !== configuredShop) {
      throw buildPreviewAccessError("Forbidden", 403);
    }

    return context;
  };
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
  parentHeaders,
  loaderHeaders,
  actionHeaders,
  errorHeaders,
} = {}) {
  const headers = new Headers(parentHeaders);

  for (const source of [loaderHeaders, actionHeaders, errorHeaders]) {
    source?.forEach((value, key) => headers.set(key, value));
  }

  for (const [key, value] of Object.entries(HIDDEN_PREVIEW_HEADERS)) {
    headers.set(key, value);
  }

  return headers;
}
