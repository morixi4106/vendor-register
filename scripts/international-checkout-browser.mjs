import { randomBytes } from "node:crypto";
import {
  CHECKOUT_BROWSER_POLICY,
  CHECKOUT_BROWSER_SELECTORS,
  CHECKOUT_BROWSER_MAX_SESSIONS,
  browserError,
  checkoutSessionUrl,
  allowCheckoutBrowserRequest,
  checkoutSessionKey,
  checkoutSessionHasher,
  validateCheckoutBrowserFacts,
  classifyCheckoutBrowserView,
} from "./international-checkout-browser-policy.mjs";
import {
  proofHash,
  shape,
  ID,
} from "../app/utils/internationalProofContract.js";
import { checkoutCaseExpected } from "../app/utils/internationalCheckoutResults.js";

// Fixed DOM code only; no page-provided instructions, callbacks, selectors or scripts are executed.
export function readCheckoutDocument() {
  const visible = (node) =>
    node &&
    node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility === "visible";
  const nodes = (selector) =>
    [...document.querySelectorAll(selector)].filter(visible);
  const text = (node) =>
    (visible(node) ? node.innerText || "" : "").replace(/\s+/g, " ").trim();
  const uniqueText = (selector) => {
    const found = nodes(selector);
    return found.length === 1 ? text(found[0]) : null;
  };
  const money = (label) => {
    const rows = nodes('[role="row"],tr').filter((row) =>
      nodesFrom(row, '[role="rowheader"],th').some((cell) =>
        label.test(text(cell)),
      ),
    );
    if (rows.length !== 1) return null;
    const cells = nodesFrom(rows[0], '[role="cell"],td');
    if (cells.length !== 1) return null;
    const match = text(cells[0]).match(
      /^(?:JPY\s*|[\u00a5\uffe5]\s*)(0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)(?:\.00)?$/,
    );
    return match ? Number(match[1].replaceAll(",", "")) : null;
  };
  function nodesFrom(root, selector) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }
  const countries = nodes('select[name="countryCode"],select[name="country"]');
  const lines = nodes(
    '[role="row"][data-product-variant-id],tr[data-product-variant-id]',
  ).slice(0, 3);
  return {
    country: countries.length === 1 ? countries[0].value : null,
    visibleLines: lines.map((row) => ({
      productId: row.getAttribute("data-product-id"),
      variantId: row.getAttribute("data-product-variant-id"),
      productTitle: text(row.querySelector("[data-product-title]")),
      variantTitle: text(row.querySelector("[data-variant-title]")),
      seller: text(row.querySelector("[data-seller]")),
      quantity: /^1$/.test(text(row.querySelector("[data-quantity]")))
        ? 1
        : null,
    })),
    subtotal: money(/^(Subtotal|小計)$/),
    shipping: money(/^(Shipping|配送|送料)$/),
    tax: money(/^(Taxes|Estimated taxes|税金)$/),
    total: money(/^(Total|合計)$/),
    currency: uniqueText("[data-currency-code]"),
    deliveryLabel: uniqueText(
      'input[type="radio"][name="shippingMethod"]:checked + label',
    ),
    alerts: nodes('[role="alert"]')
      .slice(0, 21)
      .map((node) => text(node).slice(0, 301)),
    paymentControlVisible: nodes('button[type="submit"]').some((node) =>
      /^(Pay now|今すぐ支払う|注文を確定する)$/.test(text(node)),
    ),
    documentVisible:
      document.visibilityState === "visible" && nodes("main").length === 1,
  };
}

// The browser is disposable and receives neither API credentials nor signing keys.
export function createInternationalCheckoutBrowser({
  browser,
  shopDomain,
  environment,
  clock = () => new Date(),
  viewport = { width: 1280, height: 900 },
}) {
  if (
    !browser?.newContext ||
    !["ISOLATED_STORE", "LIVE_STORE"].includes(environment) ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || "")
  )
    browserError();
  let runId = null,
    disposed = false,
    busy = false;
  const sessions = new Map(),
    seen = new Set(),
    sessionHash = checkoutSessionHasher(randomBytes(32));
  const stats = {
    requestsAllowed: 0,
    requestsBlocked: 0,
    websocketsBlocked: 0,
    popupsBlocked: 0,
    dialogsDismissed: 0,
  };
  const shutdown = async () => {
    if (disposed) return;
    disposed = true;
    await Promise.allSettled(
      [...sessions.values()].map((session) => session.context.close()),
    );
    sessions.clear();
    seen.clear();
  };
  return {
    close: shutdown,
    inspect: () => ({
      ...stats,
      sessions: sessions.size,
      disposed,
      policy: CHECKOUT_BROWSER_POLICY,
      selectorProfile: CHECKOUT_BROWSER_SELECTORS,
      environment,
    }),
    async observe(input) {
      shape(
        input,
        [
          "runId",
          "shopDomain",
          "row",
          "phase",
          "generation",
          "challengeExpiresAt",
          "session",
          "signal",
        ],
        16000,
      );
      checkoutCaseExpected(input.row);
      if (
        disposed ||
        busy ||
        input.shopDomain !== shopDomain ||
        !ID.test(input.runId || "") ||
        (runId && runId !== input.runId) ||
        input.phase !== input.row.phase ||
        !Number.isInteger(input.generation) ||
        input.generation < 1 ||
        !Number.isFinite(Date.parse(input.challengeExpiresAt)) ||
        Date.parse(input.challengeExpiresAt) <= +clock() ||
        !input.signal ||
        input.signal.aborted
      )
        browserError();
      shape(input.session, ["url", "facts"], 8192);
      const parsedSessionUrl = checkoutSessionUrl(
        input.session.url,
        shopDomain,
      );
      const sessionIdentity = `${parsedSessionUrl.origin}${parsedSessionUrl.pathname}`;
      validateCheckoutBrowserFacts(input.session.facts, input.row);
      runId = input.runId;
      busy = true;
      let session, timer;
      const abort = () => {
        void shutdown();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        abort,
        Math.min(25000, Date.parse(input.challengeExpiresAt) - +clock()),
      );
      try {
        const old = input.row.scenario === "old-checkout-blocked";
        const key = checkoutSessionKey(input.row);
        if (old) {
          session = sessions.get(key);
          if (
            !session ||
            session.url !== input.session.url ||
            session.openGeneration + 1 !== input.generation
          )
            browserError();
        } else {
          if (
            sessions.size >= CHECKOUT_BROWSER_MAX_SESSIONS ||
            seen.has(sessionIdentity) ||
            sessions.has(
              input.row.scenario === "allowed-before-payment"
                ? key
                : input.row.caseKey,
            )
          )
            browserError();
          seen.add(sessionIdentity);
          const context = await browser.newContext({
            viewport,
            locale: "en-US",
            acceptDownloads: false,
            serviceWorkers: "block",
            javaScriptEnabled: true,
            permissions: [],
            bypassCSP: false,
            ignoreHTTPSErrors: false,
            extraHTTPHeaders: {},
            storageState: undefined,
          });
          if (disposed || input.signal.aborted) {
            await context.close();
            browserError();
          }
          session = {
            context,
            page: null,
            url: input.session.url,
            openGeneration: input.generation,
            denied: false,
          };
          sessions.set(
            old
              ? key
              : input.row.scenario === "allowed-before-payment"
                ? key
                : input.row.caseKey,
            session,
          );
          await context.route("**/*", async (route) => {
            const request = route.request();
            let mainFrame = false;
            try {
              mainFrame = request.frame() === session.page?.mainFrame();
            } catch {
              /* Worker requests are never navigation permissions. */
            }
            const allowed = allowCheckoutBrowserRequest(
              {
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                navigation: request.isNavigationRequest(),
                mainFrame,
              },
              session.url,
            );
            if (!allowed) {
              stats.requestsBlocked++;
              session.denied = true;
              await route.abort("blockedbyclient");
            } else {
              stats.requestsAllowed++;
              await route.continue();
            }
          });
          await context.routeWebSocket("**/*", (ws) => {
            stats.websocketsBlocked++;
            session.denied = true;
            ws.close();
          });
          context.on("page", (page) => {
            if (session.page && page !== session.page) {
              stats.popupsBlocked++;
              session.denied = true;
              void page.close().catch(() => {});
            }
          });
          session.page = await context.newPage();
          session.page.on("dialog", (dialog) => {
            stats.dialogsDismissed++;
            session.denied = true;
            void dialog.dismiss().catch(() => {});
          });
          session.page.on("download", (download) => {
            session.denied = true;
            void download.cancel().catch(() => {});
          });
          session.page.on("pageerror", () => {
            session.denied = true;
          });
          session.page.setDefaultTimeout(5000);
          session.page.setDefaultNavigationTimeout(15000);
        }
        if (disposed || input.signal.aborted) browserError();
        const response = await session.page.goto(session.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        if (
          !response ||
          response.status() !== 200 ||
          session.page.url() !== session.url
        )
          browserError();
        await session.page.waitForLoadState("networkidle", { timeout: 4000 });
        const view = await session.page.evaluate(readCheckoutDocument);
        let observation = classifyCheckoutBrowserView(
          view,
          input.session.facts,
          input.row,
          clock(),
        );
        if (
          session.denied ||
          disposed ||
          input.signal.aborted ||
          +clock() >= Date.parse(input.challengeExpiresAt)
        )
          observation = { stage: "NOT_OBSERVED", outcome: "NOT_OBSERVED" };
        return {
          ...observation,
          evidenceHash: proofHash({
            v: CHECKOUT_BROWSER_POLICY,
            selectorProfile: CHECKOUT_BROWSER_SELECTORS,
            environment,
            caseKey: input.row.caseKey,
            generation: input.generation,
            factsHash: proofHash(input.session.facts),
            viewHash: proofHash(view),
            ...observation,
          }),
          sessionHash: sessionHash(runId, session.url),
        };
      } catch {
        return {
          stage: "NOT_OBSERVED",
          outcome: "NOT_OBSERVED",
          evidenceHash: proofHash({
            v: CHECKOUT_BROWSER_POLICY,
            code: "not_observed",
            caseKey: input.row.caseKey,
          }),
          sessionHash: sessionHash(runId, input.session.url),
        };
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        busy = false;
      }
    },
  };
}
