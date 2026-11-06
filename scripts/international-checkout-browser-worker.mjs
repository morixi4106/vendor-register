import { readFileSync } from "node:fs";
import { createInternationalCheckoutBrowser } from "./international-checkout-browser.mjs";
import { shape } from "../app/utils/internationalProofContract.js";

// This process has no API/signing/DB credentials and does not load the application's environment.
let browser,
  observer,
  initialized = false,
  closing = false,
  running = false;
const send = (value) => process.send?.(value);
async function cleanup() {
  if (closing) return;
  closing = true;
  try {
    await observer?.close();
  } finally {
    await browser?.close();
  }
}
process.on("disconnect", () => {
  void cleanup().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0));
});
process.on("message", async (message) => {
  if (running || closing) {
    send({ ok: false, code: "international_checkout_browser_unavailable" });
    return;
  }
  running = true;
  try {
    if (!initialized) {
      shape(message, ["intent", "shopDomain", "environment"], 1024);
      if (message.intent !== "init") throw new Error();
      const pkg = JSON.parse(
        readFileSync(
          new URL(
            "../tools/international-checkout-browser/node_modules/playwright-core/package.json",
            import.meta.url,
          ),
        ),
      );
      if (pkg.version !== "1.64.1") throw new Error();
      const { chromium } =
        await import("../tools/international-checkout-browser/node_modules/playwright-core/index.mjs");
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        timeout: 20000,
      });
      observer = createInternationalCheckoutBrowser({
        browser,
        shopDomain: message.shopDomain,
        environment: message.environment,
      });
      initialized = true;
      send({ ok: true, initialized: true, browserVersion: browser.version() });
    } else if (message?.intent === "close") {
      shape(message, ["intent"]);
      await cleanup();
      send({ ok: true, closed: true });
      process.disconnect();
    } else {
      shape(message, ["intent", "observation"], 16000);
      if (message.intent !== "observe") throw new Error();
      const controller = new AbortController();
      const result = await observer.observe({
        ...message.observation,
        signal: controller.signal,
      });
      send({ ok: true, observation: result });
    }
  } catch {
    send({ ok: false, code: "international_checkout_not_observed" });
  } finally {
    running = false;
  }
});
