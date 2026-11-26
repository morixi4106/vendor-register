import { createHmac, randomBytes } from "node:crypto";
import {
  proofError,
  shape,
  proofHash,
} from "../app/utils/internationalProofContract.js";
import { checkoutCaseExpected } from "../app/utils/internationalCheckoutResults.js";

export const CHECKOUT_BROWSER_POLICY =
  "international-checkout-browser-readonly-v1";
export { CHECKOUT_BROWSER_MAX_SESSIONS } from "../app/utils/internationalCheckoutCapacity.js";
export const CHECKOUT_BROWSER_SELECTORS = "shopify-checkout-semantic-v1";
export const CHECKOUT_REJECTION =
  "海外販売条件を確認できないため、この配送先への注文を受け付けられません。";
export const CHECKOUT_NI_REJECTION =
  "現在、北アイルランドへの配送は受け付けていません。";
export function browserError() {
  throw proofError("international_checkout_not_observed");
}

export function checkoutSessionUrl(value, shopDomain) {
  let url;
  try {
    url = new URL(value);
  } catch {
    browserError();
  }
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || "") ||
    typeof value !== "string" ||
    value.length > 2048 ||
    url.href !== value ||
    url.protocol !== "https:" ||
    url.hostname !== shopDomain ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/checkouts\/(?:cn\/)?[A-Za-z0-9_-]{16,200}$/.test(url.pathname) ||
    [...url.searchParams.keys()].some(
      (key) => !["key", "locale"].includes(key),
    ) ||
    new Set(url.searchParams.keys()).size !==
      [...url.searchParams.keys()].length ||
    [...url.searchParams].some(([key, v]) =>
      key === "locale"
        ? !/^(en|ja)(?:-[A-Z]{2})?$/.test(v)
        : !/^[A-Za-z0-9_-]{16,256}$/.test(v),
    )
  )
    browserError();
  return url;
}

// Read-only is intentionally restrictive: unsupported checkout network activity is not a pass.
export function allowCheckoutBrowserRequest(
  { url: raw, method, resourceType, navigation, mainFrame },
  sessionUrl,
) {
  if (method !== "GET") return false;
  let url, session;
  try {
    url = new URL(raw);
    session = new URL(sessionUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return false;
  if (navigation) return mainFrame === true && raw === sessionUrl;
  if (!["image", "stylesheet", "font", "script"].includes(resourceType))
    return false;
  if (!(url.origin === session.origin || url.hostname === "cdn.shopify.com"))
    return false;
  if (
    !/^\/cdn\/(?:shop|shopifycloud)\/[A-Za-z0-9_./-]+\.(?:js|css|png|jpg|jpeg|webp|avif|gif|svg|woff2?)$/.test(
      url.pathname,
    ) ||
    url.pathname.includes("..") ||
    [...url.searchParams].some(
      ([key, value]) =>
        !["v", "width", "height"].includes(key) || !/^\d{1,20}$/.test(value),
    )
  )
    return false;
  return true;
}

export function checkoutSessionKey(row) {
  checkoutCaseExpected(row);
  return proofHash(row.target);
}
export function checkoutSessionHasher(secret = randomBytes(32)) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) browserError();
  return (runId, url) =>
    createHmac("sha256", secret)
      .update(
        `${CHECKOUT_BROWSER_POLICY}:session\n${runId}\n${new URL(url).origin}${new URL(url).pathname}`,
      )
      .digest("hex");
}

function amount(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,9})(?:\.0{1,8})?$/.test(value)
  )
    browserError();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > 2147483647) browserError();
  return result;
}
export function validateCheckoutBrowserFacts(facts, row) {
  checkoutCaseExpected(row);
  shape(
    facts,
    [
      "v",
      "country",
      "productId",
      "variantId",
      "quantity",
      "currency",
      "subtotal",
      "shipping",
      "tax",
      "total",
      "productTitle",
      "variantTitle",
      "seller",
      "deliveryLabel",
      "routeHash",
      "observedAt",
    ],
    4096,
  );
  if (
    facts.v !== "international-checkout-browser-facts-v1" ||
    facts.country !== row.target.country ||
    facts.country === "GB" ||
    facts.productId !== row.target.shopifyProductId ||
    facts.variantId !== row.target.variantId ||
    facts.quantity !== 1 ||
    facts.currency !== "JPY" ||
    !["productTitle", "variantTitle", "seller", "deliveryLabel"].every(
      (key) =>
        typeof facts[key] === "string" &&
        facts[key].length >= 1 &&
        facts[key].length <= 160 &&
        !/[\x00-\x1f\x7f]/.test(facts[key]),
    ) ||
    !/^[a-f0-9]{64}$/.test(facts.routeHash || "") ||
    (row.target.routeHash && row.target.routeHash !== facts.routeHash) ||
    typeof facts.observedAt !== "string" ||
    !Number.isFinite(Date.parse(facts.observedAt)) ||
    new Date(facts.observedAt).toISOString() !== facts.observedAt
  )
    browserError();
  const values = Object.fromEntries(
    ["subtotal", "shipping", "tax", "total"].map((key) => [
      key,
      amount(facts[key]),
    ]),
  );
  // The observer supports only tax-exclusive, undiscounted snapshots. Other arithmetic needs another reviewed contract.
  if (values.subtotal + values.shipping + values.tax !== values.total)
    browserError();
  return facts;
}

export function classifyCheckoutBrowserView(
  view,
  facts,
  row,
  now = new Date(),
) {
  validateCheckoutBrowserFacts(facts, row);
  shape(
    view,
    [
      "country",
      "visibleLines",
      "subtotal",
      "shipping",
      "tax",
      "total",
      "currency",
      "deliveryLabel",
      "alerts",
      "paymentControlVisible",
      "documentVisible",
    ],
    8192,
  );
  const unobserved = { stage: "NOT_OBSERVED", outcome: "NOT_OBSERVED" };
  if (
    !view.documentVisible ||
    view.country !== facts.country ||
    new Date(facts.observedAt) > now ||
    now - new Date(facts.observedAt) >= 30000 ||
    !Array.isArray(view.alerts) ||
    view.alerts.length > 20 ||
    view.alerts.some((text) => typeof text !== "string" || text.length > 300)
  )
    return unobserved;
  if (
    !Array.isArray(view.visibleLines) ||
    view.visibleLines.length !== 1 ||
    proofHash(view.visibleLines[0]) !==
      proofHash({
        productId: facts.productId,
        variantId: facts.variantId,
        productTitle: facts.productTitle,
        variantTitle: facts.variantTitle,
        seller: facts.seller,
        quantity: 1,
      })
  )
    return unobserved;
  if (view.alerts.includes(CHECKOUT_REJECTION))
    return { stage: "CHECKOUT_INTERACTION", outcome: "REJECTED" };
  if (
    view.alerts.length ||
    view.paymentControlVisible !== true ||
    view.currency !== "JPY" ||
    view.deliveryLabel !== facts.deliveryLabel ||
    ["subtotal", "shipping", "tax", "total"].some(
      (key) => view[key] !== amount(facts[key]),
    )
  )
    return unobserved;
  return { stage: "CHECKOUT_INTERACTION", outcome: "ALLOWED" };
}
