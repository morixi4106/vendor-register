import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

if (!process.env.INTERNATIONAL_PLAYWRIGHT_MODULE)
  throw new Error(
    "Set the installed Playwright module path for local UI verification",
  );
const { chromium } = await import(
  pathToFileURL(process.env.INTERNATIONAL_PLAYWRIGHT_MODULE).href
);
const base = new URL(
  process.env.INTERNATIONAL_UI_PREVIEW_URL || "http://127.0.0.1:4179",
);
assert.ok(["127.0.0.1", "localhost"].includes(base.hostname));
const output = path.resolve(".audit/international-runner-preview");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.INTERNATIONAL_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.INTERNATIONAL_CHROMIUM_EXECUTABLE }
    : {}),
});
const results = [];
try {
  const canary = `blocked-${randomBytes(8).toString("hex")}.json`;
  const canaryPath = path.join(output, canary);
  writeFileSync(canaryPath, JSON.stringify({ fixtureOnly: true }), {
    flag: "wx",
  });
  try {
    const response = await fetch(
      `${base.origin}/.audit/international-runner-preview/${canary}`,
    );
    assert.equal(
      response.status,
      403,
      "Fixture server must not expose existing local evidence files",
    );
    assert.ok(!(await response.text()).includes('"fixtureOnly"'));
  } finally {
    unlinkSync(canaryPath);
  }
  for (const width of [320, 375, 1440]) {
    for (const [role, phase] of [
      ["admin", "EMPTY"],
      ["admin", "PASSED"],
      ["admin", "RUNNING"],
      ["admin", "REVOKED"],
      ["review", "PASSED"],
      ["release", "PASSED"],
      ["incident", "PASSED"],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      const mutations = [];
      page.on("pageerror", (error) => errors.push(error.message));
      if (process.env.INTERNATIONAL_UI_TRACE === "true") {
        page.on("request", (request) => console.log("request", request.url()));
        page.on("response", (response) =>
          console.log("response", response.status(), response.url()),
        );
        page.on("requestfailed", (request) =>
          console.log(
            "requestfailed",
            request.failure()?.errorText,
            request.url(),
          ),
        );
      }
      page.on("request", (request) => {
        if (request.method() === "POST") mutations.push(request);
      });
      await page.goto(`${base.origin}/?role=${role}&phase=${phase}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("heading", { name: "国際配送の受付状況" }).waitFor();
      assert.equal(errors.length, 0, errors.join("\n"));
      assert.equal(
        mutations.length,
        0,
        "GET must never create evidence or mutate",
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `Overflow: ${role}/${phase}/${width}`,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "承認内容を確認", exact: true })
          .isDisabled(),
        true,
      );
      if (role === "incident")
        assert.equal(
          await page
            .getByRole("button", { name: "閉鎖検査を開始", exact: true })
            .count(),
          0,
        );
      if (role === "release")
        assert.equal(
          await page
            .getByRole("button", { name: "配備記録を取消", exact: true })
            .count(),
          0,
        );
      if (width === 375 && role === "admin" && phase === "PASSED") {
        const response = page.waitForResponse((response) =>
          response.url().endsWith("/app/international-shipping-commands"),
        );
        await page
          .getByRole("button", { name: "観測を更新", exact: true })
          .click();
        assert.equal((await response).status(), 202);
        await page
          .getByText("要求を受け付けました。反映・保護確認は未完了です。", {
            exact: true,
          })
          .waitFor();
        assert.equal(
          mutations[0].headers().authorization,
          "Bearer fixture.header.token",
        );
        assert.ok(!mutations[0].url().includes("fixture.header.token"));
        assert.ok(!mutations[0].postData().includes("fixture.header.token"));
        const keys = [];
        page.on("dialog", (dialog) => dialog.accept());
        for (let i = 0; i < 2; i++) {
          const posted = page.waitForResponse((r) =>
            r.url().endsWith("/app/international-shipping-commands"),
          );
          await page
            .getByRole("button", { name: "閉鎖検査を開始", exact: true })
            .click();
          await posted;
          keys.push(
            new URLSearchParams(mutations.at(-1).postData()).get("requestKey"),
          );
        }
        assert.match(keys[0], /^[a-f0-9-]{36}$/);
        assert.equal(keys[0], keys[1]);
      }
      await page.screenshot({
        path: path.join(output, `${role}-${phase}-${width}.png`),
        fullPage: true,
      });
      results.push({
        role,
        phase,
        width,
        overflow: false,
        pageErrors: errors.length,
      });
      await page.close();
    }
  }
  for (const width of [320, 375, 1440]) {
    for (const mode of ["PLUS", "NON_PLUS", "UNAVAILABLE", "EXPIRED"]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [],
        posts = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.method() === "POST") posts.push(request);
      });
      try {
        await page.goto(
          `${base.origin}/?role=release&phase=EMPTY&diagnostic=${mode}`,
          { waitUntil: "domcontentloaded" },
        );
        await page
          .getByRole("heading", { name: "チェックアウト対応診断", exact: true })
          .waitFor();
        assert.equal(
          posts.length,
          0,
          "diagnosis must never run automatically on GET",
        );
        const response = page.waitForResponse((r) =>
          r.url().endsWith("/app/international-shipping-commands"),
        );
        await page
          .getByRole("button", { name: "対応状況を取得", exact: true })
          .click();
        assert.equal((await response).status(), 200);
        await page
          .getByText("対応状況を取得しました。販売開始の承認ではありません。", {
            exact: true,
          })
          .waitFor();
        const expected =
          mode === "PLUS"
            ? "店舗プラン: Shopify Plus"
            : mode === "NON_PLUS"
              ? "店舗プラン: Plus以外"
              : mode === "UNAVAILABLE"
                ? "店舗プラン: 未確認"
                : "診断結果は期限切れ、または未確認です。";
        await page.getByText(expected, { exact: true }).waitFor();
        if (mode === "PLUS")
          await page
            .getByText(
              "購入直前のUI拡張: プラン条件のみ確認、購入検証は未確認",
              { exact: true },
            )
            .waitFor();
        assert.equal(
          await page
            .getByText(
              "処理結果を記録しました。販売開始の承認ではありません。",
              { exact: true },
            )
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "承認内容を確認", exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(posts.length, 1);
        assert.deepEqual(
          [...new URLSearchParams(posts[0].postData()).keys()],
          ["intent"],
        );
        assert.equal(
          posts[0].headers().authorization,
          "Bearer fixture.header.token",
        );
        assert.equal(errors.length, 0, errors.join("\n"));
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: path.join(output, `compatibility-${mode}-${width}.png`),
          fullPage: true,
        });
        results.push({
          diagnostic: mode,
          width,
          overflow: false,
          pageErrors: errors.length,
          automaticallyStarted: false,
          saleReady: false,
        });
      } finally {
        await page.close();
      }
    }
  }
  writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify({ fixtureOnly: true, results }, null, 2),
  );
  console.log(
    `International runner UI: ${results.length} viewport/state cases passed; authenticated form transport and idempotent retry verified.`,
  );
} finally {
  await browser.close();
}
