import path from "path";
import fs from "fs";
import { describe, beforeAll, test, expect } from "vitest";
import { buildFunction, getFunctionInfo, loadSchema, loadInputQuery, loadFixture, validateTestAssets, runFunction } from "@shopify/shopify-function-test-helpers";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run.js";

describe("Default Integration Test", () => {
  let schema;
  let functionDir;
  let functionInfo;
  let schemaPath;
  let targeting;
  let functionRunnerPath;
  let wasmPath;

  beforeAll(async () => {
    functionDir = path.dirname(__dirname);
    await buildFunction(functionDir);
    functionInfo = await getFunctionInfo(functionDir);
    ({ schemaPath, functionRunnerPath, wasmPath, targeting } = functionInfo);
    schema = await loadSchema(schemaPath);
  }, 45000);

  const fixturesDir = path.join(__dirname, "fixtures");
  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(fixturesDir, file));

  fixtureFiles.forEach((fixtureFile) => {
    test(`runs ${path.relative(fixturesDir, fixtureFile)}`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const targetInputQueryPath = targeting[fixture.target].inputQueryPath;
      const inputQueryAST = await loadInputQuery(targetInputQueryPath);

      const validationResult = await validateTestAssets({ schema, fixture, inputQueryAST });
      expect(validationResult.inputQuery.errors).toEqual([]);
      expect(validationResult.inputFixture.errors).toEqual([]);
      expect(validationResult.outputFixture.errors).toEqual([]);

      const runResult = await runFunction(fixture, functionRunnerPath, wasmPath, targetInputQueryPath, schemaPath);
      expect(runResult.error).toBeNull();
      expect(runResult.result.output).toEqual(fixture.expectedOutput);
    }, 10000);
  });
});

function buildDirectInput({
  operationalState = "ALLOWED",
  watchdogPurchaseStop = null,
  currentDate = "2026-07-24",
  evaluatedOn = "2026-07-24",
  expiresOnExclusive = "2026-07-25",
  lineCount = 1,
  projectionValue = null,
  limitedLaunchControl = {
    v: 2,
    s: "INACTIVE",
    r: 1,
    e: "9999-12-31",
    x: "9999-12-31T00:00:00.000Z",
    p: [],
    q: "",
    m: 0,
    o: 0,
    g: 0,
    l: 0,
    c: "JPY",
    h: "a".repeat(64),
  },
  cartAmount = "100.0",
  productId = "gid://shopify/Product/1",
} = {}) {
  const defaultProjection = JSON.stringify({
    v: 2,
    c: "PLATFORM_DIRECT",
    a: true,
    s: "ELIGIBLE",
    p: "sale-eligibility-2026-07-v1",
    h: "a".repeat(64),
    d: evaluatedOn,
    e: expiresOnExclusive,
    r: 1,
  });
  const line = {
    quantity: 1,
    merchandise: {
      id: "gid://shopify/ProductVariant/1",
      product: {
        id: productId,
        marketplaceCheckoutPolicy: { value: "PLATFORM_DIRECT" },
        saleEligibilityProjection: {
          value: projectionValue ?? defaultProjection,
        },
      },
    },
  };
  return {
    shop: {
      localTime: { date: currentDate },
      operationalPurchaseControl: { value: operationalState },
      komojuLimitedLaunchControl: limitedLaunchControl
        ? { value: JSON.stringify(limitedLaunchControl) }
        : null,
      watchdogPurchaseStop: watchdogPurchaseStop
        ? { value: watchdogPurchaseStop }
        : null,
    },
    cart: {
      cost: {
        totalAmount: { amount: cartAmount, currencyCode: "JPY" },
      },
      lines: Array.from({ length: lineCount }, () => line),
    },
  };
}

describe("fail-closed operational and calendar boundaries", () => {
  for (const state of [
    "",
    "REQUESTED",
    "ACTIVATING",
    "PARTIAL_FAILURE",
    "RECOVERY_REQUESTED",
    "RECOVERING",
    "RECOVERY_FAILED",
    "INACTIVE",
    "RECOVERED",
    "UNKNOWN",
  ]) {
    test(`blocks checkout for operational state ${state || "(missing)"}`, () => {
      const result = cartValidationsGenerateRun(
        buildDirectInput({ operationalState: state }),
      );
      expect(result.operations[0].validationAdd.errors).toHaveLength(1);
    });
  }

  test("allows only the explicit ALLOWED operational state", () => {
    const result = cartValidationsGenerateRun(buildDirectInput());
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  test("a shared watchdog veto can only block checkout", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ watchdogPurchaseStop: "BLOCKED" }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("a non-blocking shared value cannot grant checkout", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        operationalState: "PARTIAL_FAILURE",
        watchdogPurchaseStop: "ALLOWED",
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("expires exactly at the Shopify local calendar boundary", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-07-25",
        expiresOnExclusive: "2026-07-25",
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("allows a 200-line cart with compact projections", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ lineCount: 200 }),
    );
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  test("returns one cart-level error for 200 blocked lines", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        lineCount: 200,
        projectionValue: JSON.stringify({
          v: 2,
          c: "PLATFORM_DIRECT",
          a: false,
          s: "BLOCKED",
          p: "sale-eligibility-2026-07-v1",
          h: "b".repeat(64),
          d: "2026-07-24",
          e: "2026-07-25",
          r: 2,
        }),
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("rejects malformed near-limit projection without throwing", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ projectionValue: `{${"x".repeat(9_900)}` }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("rejects carts above the supported 200-line boundary", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ lineCount: 201 }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("blocks an expired limited launch without relying on the monitor", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-08-14",
        limitedLaunchControl: {
          v: 2,
          s: "ACTIVE",
          r: 2,
          e: "2026-08-14",
          x: "2026-08-14T00:00:00.000Z",
          p: ["gid://shopify/Product/1"],
          q: "gid://shopify/ProductVariant/1",
          m: 2000,
          o: 1,
          g: 2000,
          l: 2000,
          c: "JPY",
          h: "b".repeat(64),
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("fails closed when the limited-launch baseline is missing", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ limitedLaunchControl: null }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("fails closed for malformed, unknown and preparing controls", () => {
    for (const limitedLaunchControl of [
      { v: 99, s: "INACTIVE" },
      { v: 2, s: "PREPARING", r: 1, h: "c".repeat(64) },
      { v: 2, s: "UNKNOWN", r: 1, h: "c".repeat(64) },
      {
        v: 2,
        s: "INACTIVE",
        r: 0,
        e: "9999-12-31",
        x: "9999-12-31T00:00:00.000Z",
        p: [],
        q: "",
        m: 0,
        o: 0,
        g: 0,
        l: 0,
        c: "JPY",
        h: "c".repeat(64),
      },
    ]) {
      const result = cartValidationsGenerateRun(
        buildDirectInput({ limitedLaunchControl }),
      );
      expect(result.operations[0].validationAdd.errors).toHaveLength(1);
    }
  });

  test("allows the explicit inactive baseline", () => {
    const result = cartValidationsGenerateRun(buildDirectInput());
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  test("blocks the explicit limited-launch stop state", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        limitedLaunchControl: {
          v: 2,
          s: "BLOCKED",
          r: 3,
          e: "2026-08-14",
          x: "2026-08-14T00:00:00.000Z",
          p: ["gid://shopify/Product/1"],
          q: "gid://shopify/ProductVariant/1",
          m: 2000,
          o: 1,
          g: 2000,
          l: 2000,
          c: "JPY",
          h: "b".repeat(64),
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("allows only the selected one-quantity canary variant", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-08-10",
        evaluatedOn: "2026-08-10",
        expiresOnExclusive: "2026-08-11",
        limitedLaunchControl: {
          v: 2,
          s: "ACTIVE",
          r: 2,
          e: "2026-08-14",
          x: "2026-08-14T00:00:00.000Z",
          p: ["gid://shopify/Product/1"],
          q: "gid://shopify/ProductVariant/1",
          m: 2000,
          o: 1,
          g: 2000,
          l: 2000,
          c: "JPY",
          h: "b".repeat(64),
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  test("blocks products outside the limited launch allowlist", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-08-10",
        evaluatedOn: "2026-08-10",
        expiresOnExclusive: "2026-08-11",
        productId: "gid://shopify/Product/2",
        limitedLaunchControl: {
          v: 2,
          s: "ACTIVE",
          r: 2,
          e: "2026-08-14",
          x: "2026-08-14T00:00:00.000Z",
          p: ["gid://shopify/Product/1"],
          q: "gid://shopify/ProductVariant/1",
          m: 2000,
          o: 1,
          g: 2000,
          l: 2000,
          c: "JPY",
          h: "b".repeat(64),
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("blocks orders above the limited launch amount or liability cap", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-08-10",
        evaluatedOn: "2026-08-10",
        expiresOnExclusive: "2026-08-11",
        cartAmount: "1650.0",
        limitedLaunchControl: {
          v: 2,
          s: "ACTIVE",
          r: 2,
          e: "2026-08-14",
          x: "2026-08-14T00:00:00.000Z",
          p: ["gid://shopify/Product/1"],
          q: "gid://shopify/ProductVariant/1",
          m: 2000,
          o: 1,
          g: 2000,
          l: 1000,
          c: "JPY",
          h: "b".repeat(64),
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test.each([
    ["remaining order count", { o: 0, g: 2000, l: 2000 }],
    ["remaining gross amount", { o: 1, g: 0, l: 2000 }],
    ["remaining liability", { o: 1, g: 2000, l: 0 }],
  ])("blocks checkout when %s is exhausted", (_label, remaining) => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-08-10",
        evaluatedOn: "2026-08-10",
        expiresOnExclusive: "2026-08-11",
        limitedLaunchControl: {
          v: 2,
          s: "ACTIVE",
          r: 2,
          e: "2026-08-14",
          x: "2026-08-14T00:00:00.000Z",
          p: ["gid://shopify/Product/1"],
          q: "gid://shopify/ProductVariant/1",
          m: 2000,
          ...remaining,
          c: "JPY",
          h: "b".repeat(64),
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("blocks checkout after the limited-launch expiry date", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-08-15",
        limitedLaunchControl: {
          v: 2,
          s: "ACTIVE",
          r: 2,
          e: "2026-08-14",
          x: "2026-08-14T00:00:00.000Z",
          p: ["gid://shopify/Product/1"],
          q: "gid://shopify/ProductVariant/1",
          m: 2000,
          o: 1,
          g: 2000,
          l: 2000,
          c: "JPY",
          h: "b".repeat(64),
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });
});
