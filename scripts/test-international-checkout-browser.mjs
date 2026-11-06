import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkoutBrowserFixture } from "../tests/helpers/internationalCheckoutBrowserFixture.js";
import { checkoutBrowserHtml } from "../tests/fixtures/internationalCheckoutBrowserPage.js";
import { createInternationalCheckoutBrowser } from "./international-checkout-browser.mjs";
import { createManagedCheckoutBrowserProcess } from "./international-checkout-browser-process.mjs";
import {
  CHECKOUT_BROWSER_POLICY,
  CHECKOUT_BROWSER_SELECTORS,
} from "./international-checkout-browser-policy.mjs";

export async function testCheckoutBrowser({
  output = path.resolve(".audit/checkout-browser-probe"),
} = {}) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pkgRoot = path.join(
    root,
    "tools/international-checkout-browser/node_modules/playwright-core",
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json")));
  assert.equal(pkg.version, "1.64.1");
  const { chromium } = await import(
    pathToFileURL(path.join(pkgRoot, "index.mjs")).href
  );
  const server = await chromium.launchServer({
    headless: true,
    chromiumSandbox: true,
    timeout: 20000,
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const executable = server.process().spawnfile;
  const executableHash = createHash("sha256")
    .update(fs.readFileSync(executable))
    .digest("hex");
  const results = [],
    widths = [320, 375, 1440];
  fs.mkdirSync(output, { recursive: true });
  let rejected = false,
    pageOptions = {};
  const allContexts = new Set();
  const fixtureBrowser = {
    async newContext(options) {
      assert.equal(options.serviceWorkers, "block");
      assert.equal(options.acceptDownloads, false);
      const context = await browser.newContext(options);
      allContexts.add(context);
      const route = context.route.bind(context);
      context.route = (pattern, policy) =>
        route(pattern, async (actual) => {
          const fixtureRoute = new Proxy(actual, {
            get(target, key) {
              if (key === "continue")
                return async () => {
                  const request = actual.request();
                  // Every allowed network request is fulfilled in memory; there is no live store connection.
                  if (request.isNavigationRequest()) {
                    const facts =
                      pageOptions.facts || checkoutBrowserFixture().facts;
                    if (pageOptions.redirect)
                      return actual.fulfill({
                        status: 302,
                        headers: { location: "https://example.test/canary" },
                        body: "",
                      });
                    return actual.fulfill({
                      status: 200,
                      contentType: "text/html",
                      body: checkoutBrowserHtml(facts, {
                        ...pageOptions,
                        rejected,
                      }),
                    });
                  }
                  return actual.fulfill({
                    status: 200,
                    contentType: "text/javascript",
                    body: "",
                  });
                };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          await policy(fixtureRoute);
        });
      return context;
    },
  };
  const input = (f, changes = {}) => ({
    runId: "browser-probe",
    shopDomain: "browser.myshopify.com",
    row: f.row,
    phase: "OPEN",
    generation: 2,
    challengeExpiresAt: new Date(Date.now() + 60000).toISOString(),
    session: {
      url: f.url,
      facts: { ...f.facts, observedAt: new Date().toISOString() },
    },
    signal: new AbortController().signal,
    ...changes,
  });
  const make = (width) =>
    createInternationalCheckoutBrowser({
      browser: fixtureBrowser,
      shopDomain: "browser.myshopify.com",
      environment: "ISOLATED_STORE",
      viewport: { width, height: 900 },
    });
  try {
    for (const width of widths) {
      const f = checkoutBrowserFixture(),
        observer = make(width);
      rejected = false;
      pageOptions = { facts: f.facts };
      try {
        const open = await observer.observe(input(f));
        assert.equal(open.outcome, "ALLOWED");
        const context = [...allContexts].at(-1),
          page = context.pages()[0];
        assert.ok(
          await page.evaluate(
            () =>
              document.body.innerText.length > 40 &&
              document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: path.join(output, `synthetic-open-${width}.png`),
          fullPage: true,
        });
        rejected = true;
        const oldRow = f.plan.cases.find(
          (row) => row.scenario === "old-checkout-blocked",
        );
        const old = await observer.observe(
          input(f, { row: oldRow, phase: "CLOSED", generation: 3 }),
        );
        assert.equal(old.outcome, "REJECTED");
        assert.equal(old.sessionHash, open.sessionHash);
        const freshRow = f.plan.cases.find(
          (row) => row.scenario === "new-checkout-blocked",
        );
        const fresh = await observer.observe(
          input(f, {
            row: freshRow,
            phase: "CLOSED",
            generation: 3,
            session: {
              url: f.url + "new",
              facts: { ...f.facts, observedAt: new Date().toISOString() },
            },
          }),
        );
        assert.equal(fresh.outcome, "REJECTED");
        assert.notEqual(fresh.sessionHash, open.sessionHash);
        results.push({
          case: "open-old-new",
          width,
          observations: 3,
          matched: true,
        });
      } finally {
        await observer.close();
        assert.equal(observer.inspect().sessions, 0);
      }
    }
    for (const scenario of ["country-rejected", "domestic-regression"]) {
      const f = checkoutBrowserFixture(),
        row = f.plan.cases.find((row) => row.scenario === scenario),
        observer = make(375);
      f.row = row;
      f.facts.country = row.target.country;
      rejected = scenario === "country-rejected";
      pageOptions = { facts: f.facts };
      try {
        assert.equal(
          (await observer.observe(input(f))).outcome,
          rejected ? "REJECTED" : "ALLOWED",
        );
        results.push({ case: scenario, matched: true });
      } finally {
        await observer.close();
      }
    }
    const attacks = [
      [
        "post",
        'fetch(location.href,{method:"POST",body:"canary"}).catch(()=>{})',
      ],
      ["foreign-image", 'new Image().src="https://example.test/canary.png"'],
      [
        "iframe",
        'document.body.insertAdjacentHTML("beforeend",`<iframe src="${location.href}"></iframe>`)',
      ],
      ["websocket", 'new WebSocket("wss://example.test/canary")'],
      ["popup", 'window.open("https://example.test/canary")'],
      ["dialog", 'alert("canary")'],
      [
        "auto-submit",
        'document.body.insertAdjacentHTML("beforeend",`<form id="f" method="POST" action="/payments"></form>`);document.querySelector("#f").submit()',
      ],
    ];
    for (const [name, script] of attacks) {
      const f = checkoutBrowserFixture(),
        observer = make(375);
      rejected = false;
      pageOptions = { facts: f.facts, script };
      try {
        const result = await observer.observe(input(f));
        assert.equal(result.outcome, "NOT_OBSERVED", name);
        assert.equal(
          Object.keys(result).sort().join(),
          "evidenceHash,outcome,sessionHash,stage",
        );
        assert.ok(!JSON.stringify(result).includes("canary"));
        results.push({
          case: name,
          blocked: true,
          counters: observer.inspect(),
        });
      } finally {
        await observer.close();
      }
    }
    for (const [name, options] of [
      ["wrong-variant", { variantId: "gid://shopify/ProductVariant/99" }],
      ["wrong-total", { total: "71" }],
      ["hidden-title", { hidden: true }],
      ["redirect", { redirect: true }],
    ]) {
      const f = checkoutBrowserFixture(),
        observer = make(375);
      rejected = false;
      pageOptions = { facts: f.facts, ...options };
      try {
        assert.equal(
          (await observer.observe(input(f))).outcome,
          "NOT_OBSERVED",
          name,
        );
        results.push({ case: name, blocked: true });
      } finally {
        await observer.close();
      }
    }
    const f = checkoutBrowserFixture(),
      observer = make(375),
      controller = new AbortController();
    controller.abort();
    await assert.rejects(
      observer.observe(input(f, { signal: controller.signal })),
    );
    await observer.close();
    results.push({
      case: "aborted-before-navigation",
      blocked: true,
      observations: 0,
    });
    // Exercise the real sanitized subprocess without sending a checkout URL or opening any store.
    const child = await createManagedCheckoutBrowserProcess({
      shopDomain: "browser.myshopify.com",
      environment: "ISOLATED_STORE",
      prepare: async () => {
        throw new Error("not used");
      },
      read: async () => {
        throw new Error("not used");
      },
    });
    assert.equal(child.descriptor.qualification, "UNQUALIFIED");
    await child.close();
    results.push({
      case: "real-child-start-close",
      passed: true,
      observations: 0,
    });
    assert.equal(browser.contexts().length, 0);
    const inputs = [
      "scripts/international-checkout-browser.mjs",
      "scripts/international-checkout-browser-policy.mjs",
      "scripts/international-checkout-browser-process.mjs",
      "scripts/international-checkout-browser-worker.mjs",
      "scripts/test-international-checkout-browser.mjs",
      "tests/helpers/internationalCheckoutBrowserFixture.js",
      "tests/fixtures/internationalCheckoutBrowserPage.js",
      "tools/international-checkout-browser/package.json",
      "tools/international-checkout-browser/package-lock.json",
      "tests/scripts/international-checkout-browser-policy.test.js",
      "tests/scripts/international-checkout-browser-process.test.js",
      "app/utils/internationalProofContract.js",
      "app/utils/internationalCheckoutResults.js",
      "app/utils/internationalCheckoutCapacity.js",
      "tests/utils/internationalCheckoutCapacity.test.js",
      "app/utils/internationalCheckoutVerification.js",
      "app/utils/internationalCurrencyPolicy.js",
      "app/utils/japanPostAirPacket.js",
      "scripts/security/node-runtime.mjs",
      "security/node-runtime.json",
      ".github/workflows/international-checkout-browser.yml",
    ];
    const receipt = {
      v: "international-checkout-browser-probe-v1",
      policy: CHECKOUT_BROWSER_POLICY,
      selectorProfile: CHECKOUT_BROWSER_SELECTORS,
      fixtureOnly: true,
      liveStoreQualified: false,
      managedVerifierArtifactQualified: false,
      productionApproved: false,
      playwrightVersion: pkg.version,
      browserVersion: browser.version(),
      browserExecutableSha256: executableHash,
      browserSandboxEnabled: true,
      platform: process.platform,
      sourceInputs: inputs.map((file) => ({
        path: file,
        sha256: createHash("sha256")
          .update(fs.readFileSync(path.join(root, file)))
          .digest("hex"),
      })),
      observedAt: new Date().toISOString(),
      results,
      totalObservations: results.reduce((n, r) => n + (r.observations ?? 1), 0),
      requestMode: "fulfilled-in-memory-no-live-store-transport",
      contextsAfterClose: browser.contexts().length,
    };
    fs.writeFileSync(
      path.join(output, "receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    return receipt;
  } finally {
    await browser.close();
    await server.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await testCheckoutBrowser();
    console.log(
      JSON.stringify({
        fixtureOnly: true,
        cases: result.results.length,
        observations: result.totalObservations,
        sourceBindings: result.sourceInputs.length,
        browserVersion: result.browserVersion,
        liveStoreQualified: false,
      }),
    );
  } catch {
    console.error("international_checkout_browser_probe_failed");
    process.exitCode = 1;
  }
}
