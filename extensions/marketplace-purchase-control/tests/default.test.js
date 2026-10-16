import path from "path";
import fs from "fs";
import { describe, beforeAll, test, expect } from "vitest";
import { buildFunction, getFunctionInfo, loadSchema, loadInputQuery, loadFixture, validateTestAssets, runFunction } from "@shopify/shopify-function-test-helpers";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run.js";

let wasmContext;

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
    wasmContext = { schema, schemaPath, targeting, functionRunnerPath, wasmPath };
  }, 90000);

  const fixturesDir = path.join(__dirname, "fixtures");
  test("input query stays within Shopify's byte and cost limits", async () => {
    const queryPath = targeting["cart.validations.generate.run"].inputQueryPath;
    const document = await loadInputQuery(queryPath);
    const cost = (set) => set.selections.reduce((sum, node) => {
      if (node.kind === "InlineFragment") return sum + cost(node.selectionSet);
      if (node.name.value === "metafield") return sum + 3;
      return sum + (node.selectionSet ? cost(node.selectionSet) : node.name.value === "__typename" ? 0 : 1);
    }, 0);
    expect(cost(document.definitions[0].selectionSet)).toBeLessThanOrEqual(30);
    expect(Buffer.byteLength(fs.readFileSync(queryPath, "utf8"))).toBeLessThanOrEqual(3000);
  });
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
  destinationCountry = "JP",
  postalCode = null,
  deliveryAddresses = null,
  internationalSaleGate = null,
  internationalSaleEligibility = undefined,
  journeyStep = "CHECKOUT_COMPLETION",
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
      requiresShipping: true,
      product: {
        id: productId,
        internationalSaleEligibility: internationalSaleEligibility === null ? null : {
          value: JSON.stringify(internationalSaleEligibility ?? {
            v: 1, p: "international-sale-2026-10-v1", g: 1, r: 1, i: productId,
            d: evaluatedOn, e: expiresOnExclusive, c: ["FR"], h: "c".repeat(64),
          }),
        },
        saleEligibilityProjection: {
          value: projectionValue ?? defaultProjection,
        },
      },
    },
  };
  const addresses = Array.isArray(deliveryAddresses)
    ? deliveryAddresses
    : destinationCountry
      ? [
          {
            countryCode: destinationCountry,
            zip: postalCode,
          },
        ]
      : [];
  return {
    buyerJourney: { step: journeyStep },
    shop: {
      localTime: { date: currentDate },
      operationalPurchaseControl: { value: operationalState },
      komojuLimitedLaunchControl: limitedLaunchControl
        ? { value: JSON.stringify(limitedLaunchControl) }
        : null,
      watchdogPurchaseStop: watchdogPurchaseStop
        ? { value: watchdogPurchaseStop }
        : null,
      internationalSaleGate: internationalSaleGate
        ? { value: JSON.stringify(internationalSaleGate) }
        : null,
    },
    cart: {
      cost: {
        totalAmount: { amount: cartAmount, currencyCode: "JPY" },
      },
      deliveryGroups: addresses.map((deliveryAddress) => ({
        deliveryAddress,
        cartLines: Array.from({ length: lineCount }, (_, index) => ({ id: `gid://shopify/CartLine/${index}` })),
      })),
      lines: Array.from({ length: lineCount }, (_, index) => ({ ...line, id: `gid://shopify/CartLine/${index}` })),
    },
  };
}

describe("international destination gate", () => {
  beforeAll(async () => {
    if (wasmContext) return;
    const functionDir = path.dirname(__dirname);
    await buildFunction(functionDir);
    const info = await getFunctionInfo(functionDir);
    wasmContext = { ...info, schema: await loadSchema(info.schemaPath) };
  }, 90000);
  const validFranceGate = {
    v: 2,
    p: "international-sale-2026-10-v1",
    g: 1,
    s: "ACTIVE",
    d: "2026-07-24",
    e: "2026-07-25",
    c: ["FR"],
    h: "b".repeat(64),
  };

  test("does not require an international gate for a domestic destination", () => {
    const result = cartValidationsGenerateRun(buildDirectInput());
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  test("fails closed for an international destination without a gate", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ destinationCountry: "FR" }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("allows an international destination covered by a current gate", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        destinationCountry: "FR",
        internationalSaleGate: validFranceGate,
      }),
    );
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  test("blocks an expired international gate", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        currentDate: "2026-07-25",
        destinationCountry: "FR",
        internationalSaleGate: validFranceGate,
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("blocks a country that is absent from the gate", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        destinationCountry: "US",
        internationalSaleGate: validFranceGate,
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test.each([
    [{ countryCode: "GB", provinceCode: "NIR", zip: "BT1 1AA" }],
    [{ countryCode: "GB", provinceCode: null, zip: "BT48 6DQ" }],
  ])("blocks Northern Ireland even when GB is covered", (address) => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        deliveryAddresses: [address],
        internationalSaleGate: {
          ...validFranceGate,
          c: ["GB"],
        },
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("blocks when any delivery group has an uncovered destination", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({
        deliveryAddresses: [
          { countryCode: "FR", provinceCode: null, zip: "75001" },
          { countryCode: "US", provinceCode: "CA", zip: "94105" },
        ],
        internationalSaleGate: validFranceGate,
      }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("does not block before a delivery address is available", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ destinationCountry: null, journeyStep: "CART_INTERACTION" }),
    );
    expect(result.operations[0].validationAdd.errors).toEqual([]);
  });

  test("requires product-specific permission even with a valid shop gate", () => {
    const input = buildDirectInput({ destinationCountry: "FR", internationalSaleGate: validFranceGate, internationalSaleEligibility: null });
    expect(cartValidationsGenerateRun(input).operations[0].validationAdd.errors).toHaveLength(1);
  });

  test.each(["g", "i", "p", "v", "e", "c"])("rejects mismatched product %s", (field) => {
    const input = buildDirectInput({ destinationCountry: "FR", internationalSaleGate: validFranceGate });
    const projection = JSON.parse(input.cart.lines[0].merchandise.product.internationalSaleEligibility.value);
    projection[field] = { g: 2, i: "gid://shopify/Product/999", p: "future", v: 9, e: "2026-07-24", c: ["US"] }[field];
    input.cart.lines[0].merchandise.product.internationalSaleEligibility.value = JSON.stringify(projection);
    expect(cartValidationsGenerateRun(input).operations[0].validationAdd.errors).toHaveLength(1);
  });

  test("rejects a mixed cart when only one product has permission", () => {
    const input = buildDirectInput({ destinationCountry: "FR", internationalSaleGate: validFranceGate, lineCount: 2 });
    input.cart.lines[1] = { ...input.cart.lines[1], merchandise: { ...input.cart.lines[1].merchandise, product: {
      ...input.cart.lines[1].merchandise.product, id: "gid://shopify/Product/2", internationalSaleEligibility: null,
    } } };
    expect(cartValidationsGenerateRun(input).operations[0].validationAdd.errors).toHaveLength(1);
  });

  test.each(["CHECKOUT_COMPLETION", "UNKNOWN", null])("rejects absent destination at %s", (journeyStep) => {
    const input = buildDirectInput({ destinationCountry: null, journeyStep });
    expect(cartValidationsGenerateRun(input).operations[0].validationAdd.errors).toHaveLength(1);
  });

  test.each(["missingGroup", "unknownLine", "partialAddress", "duplicateLine", "legacyGate", "ambiguousGb"])("fails closed for %s", (scenario) => {
    const input = buildDirectInput({ destinationCountry: "FR", internationalSaleGate: validFranceGate });
    if (scenario === "missingGroup") input.cart.deliveryGroups = [];
    if (scenario === "unknownLine") input.cart.deliveryGroups[0].cartLines = [{ id: "unknown" }];
    if (scenario === "partialAddress") input.cart.deliveryGroups.push({ cartLines: [{ id: input.cart.lines[0].id }], deliveryAddress: null });
    if (scenario === "duplicateLine") input.cart.lines.push(input.cart.lines[0]);
    if (scenario === "legacyGate") input.shop.internationalSaleGate.value = JSON.stringify({ ...validFranceGate, v: 1 });
    if (scenario === "ambiguousGb") input.cart.deliveryGroups[0].deliveryAddress.countryCode = "GB";
    expect(cartValidationsGenerateRun(input).operations[0].validationAdd.errors).toHaveLength(1);
  });

  for (const scenario of ["allowed", "mixed", "twoCountries", "missingGroup", "generationMismatch", "largestCart", "largestDomestic", "distinctProducts"]) {
    test(`WASM international ${scenario}`, async () => {
      const { schema, schemaPath, targeting, functionRunnerPath, wasmPath } = wasmContext;
      const gate = { v: 2, p: "international-sale-2026-10-v1", g: 1, s: "ACTIVE", d: "2026-07-24", e: "2026-07-25", c: ["FR", "US"], h: "b".repeat(64) };
      const input = buildDirectInput({ destinationCountry: scenario === "largestDomestic" ? "JP" : "FR", internationalSaleGate: gate,
        internationalSaleEligibility: scenario === "largestDomestic" ? null : undefined,
        lineCount: scenario === "largestCart" ? 100 : scenario === "largestDomestic" ? 200 : scenario === "distinctProducts" ? 12 : 2 });
      if (scenario === "distinctProducts") {
        input.cart.lines = input.cart.lines.map((line, index) => {
          const item = structuredClone(line);
          item.merchandise.product.id = `gid://shopify/Product/${index + 100}`;
          item.merchandise.product.internationalSaleEligibility.value = JSON.stringify({
            ...JSON.parse(item.merchandise.product.internationalSaleEligibility.value), i: item.merchandise.product.id,
          });
          item.merchandise.product.saleEligibilityProjection.value = JSON.stringify({
            ...JSON.parse(item.merchandise.product.saleEligibilityProjection.value), h: index.toString(16).padStart(64, "0"),
          });
          return item;
        });
      }
      for (const group of input.cart.deliveryGroups) delete group.deliveryAddress.provinceCode;
      if (scenario === "mixed") input.cart.lines[1].merchandise = { ...input.cart.lines[1].merchandise, product: { ...input.cart.lines[1].merchandise.product, internationalSaleEligibility: null } };
      if (scenario === "twoCountries") {
        const second = structuredClone(input.cart.deliveryGroups[0]);
        second.deliveryAddress.countryCode = "US";
        input.cart.deliveryGroups.push(second);
        for (const line of input.cart.lines) {
          line.merchandise.product.internationalSaleEligibility.value = JSON.stringify({ ...JSON.parse(line.merchandise.product.internationalSaleEligibility.value), c: ["FR", "US"] });
        }
      }
      if (scenario === "missingGroup") input.cart.deliveryGroups = [];
      if (scenario === "generationMismatch") input.shop.internationalSaleGate.value = JSON.stringify({ ...gate, g: 2 });
      const fixture = { export: "cart-validations-generate-run", target: "cart.validations.generate.run", input,
        expectedOutput: cartValidationsGenerateRun(input) };
      expect(fixture.expectedOutput.operations[0].validationAdd.errors).toHaveLength(["allowed", "twoCountries", "distinctProducts"].includes(scenario) ? 0 : 1);
      const query = targeting[fixture.target].inputQueryPath;
      const validation = await validateTestAssets({ schema, fixture, inputQueryAST: await loadInputQuery(query) });
      expect(validation.inputFixture.errors).toEqual([]);
      const result = await runFunction(fixture, functionRunnerPath, wasmPath, query, schemaPath);
      expect(result.error).toBeNull();
      expect(result.result.output).toEqual(fixture.expectedOutput);
      expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(128000);
      expect(result.metadata.instructionCount).toBeLessThanOrEqual(11000000);
      expect(result.metadata.memoryUsageKiB).toBeLessThanOrEqual(10000);
      if (scenario.startsWith("largest")) console.info(scenario, { inputBytes: Buffer.byteLength(JSON.stringify(input)), ...result.metadata });
    }, 20000);
  }
});

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

  test("rejects a 200-line cart above the projection work budget", () => {
    const result = cartValidationsGenerateRun(
      buildDirectInput({ lineCount: 200 }),
    );
    expect(result.operations[0].validationAdd.errors).toHaveLength(1);
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
