import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { internationalProofFixture } from "../helpers/internationalProofFixture.js";
import {
  validateManifest,
  validateCheckoutVerifier,
  proofHash,
  CHECKOUT_CONTRACT_PATHS,
} from "../../app/utils/internationalProofContract.js";
import {
  isInternationalPolicyPair,
  INTERNATIONAL_CURRENCY_POLICY,
} from "../../app/utils/internationalCurrencyPolicy.js";
import { inspectProofArtifactMetadata } from "../../app/services/internationalProofGitHub.server.js";
import { inspectInternationalProofRuntime } from "../../app/services/internationalProofRuntime.server.js";
import { inspectInternationalAuthorizationCapability } from "../../app/services/internationalAuthorizationPolicy.server.js";
import { collectCheckoutVerifier } from "../../scripts/international-proof-artifact.mjs";
import {
  closedInternationalGate,
  sealInternationalProjection,
} from "../../app/services/internationalGateProjection.server.js";

test("policy/version compatibility is exact; historical schema is not current runtime approval", async () => {
  assert.equal(
    isInternationalPolicyPair("international-sale-2026-10-v1", 2),
    true,
  );
  assert.equal(
    isInternationalPolicyPair(INTERNATIONAL_CURRENCY_POLICY, 3),
    true,
  );
  for (const [policy, version] of [
    [INTERNATIONAL_CURRENCY_POLICY, 2],
    ["international-sale-2026-10-v1", 3],
    ["unknown", 3],
  ]) {
    assert.equal(isInternationalPolicyPair(policy, version), false);
    const f = internationalProofFixture();
    f.manifest.function.policy = policy;
    f.manifest.function.projectionVersion = version;
    assert.throws(() => validateManifest(f.manifest));
  }
  const f = internationalProofFixture();
  f.manifest.function.policy = "international-sale-2026-10-v1";
  f.manifest.function.projectionVersion = 2;
  delete f.manifest.checkoutVerifier;
  assert.equal(validateManifest(f.manifest), f.manifest);
  let calls = 0;
  await assert.rejects(
    inspectInternationalProofRuntime({
      shopDomain: f.payload.shopDomain,
      manifest: f.manifest,
      receipt: f.payload,
      env: f.env,
      graphQL: async () => {
        calls++;
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(inspectInternationalAuthorizationCapability().ready, false);
});

test("contract descriptor binds the fixed implementation files without claiming a live verifier", () => {
  const value = collectCheckoutVerifier(process.cwd());
  assert.equal(validateCheckoutVerifier(value), value);
  assert.deepEqual(
    value.files.map((row) => row.path),
    CHECKOUT_CONTRACT_PATHS,
  );
  assert.equal(value.level, "CONTRACT_ONLY");
  assert.equal(value.files[0].size, readFileSync(value.files[0].path).length);
  for (const change of [
    { level: "LIVE_VERIFIED" },
    { digest: "0".repeat(64) },
    { verifierVersion: "arbitrary" },
    { files: [] },
  ])
    assert.throws(() => validateCheckoutVerifier({ ...value, ...change }));
  const bad = structuredClone(value);
  bad.files[0].path = ".env";
  bad.digest = proofHash(bad.files);
  assert.throws(() => validateCheckoutVerifier(bad));
});

test("artifact source binding independently checks exact commit files, rejects missing or changed code", async () => {
  for (const change of ["changed", "missing", "wrongEncoding"]) {
    const f = internationalProofFixture();
    const file = f.manifest.checkoutVerifier.files[0];
    const key = `/contents/${file.path}?ref=${f.manifest.headSha}`;
    if (change === "changed")
      f.responses[key].content = Buffer.from("altered").toString("base64");
    if (change === "missing") delete f.responses[key];
    if (change === "wrongEncoding") f.responses[key].encoding = "utf8";
    await assert.rejects(
      inspectProofArtifactMetadata({
        artifactId: 200,
        manifest: f.manifest,
        github: f.github,
        now: f.now,
      }),
    );
  }
});

test("new policy cannot omit the verifier contract; Function/backend policies stay aligned", () => {
  const f = internationalProofFixture();
  delete f.manifest.checkoutVerifier;
  assert.throws(() => validateManifest(f.manifest));
  const source = readFileSync(
    "extensions/marketplace-purchase-control/src/international_validation.js",
    "utf8",
  );
  assert.ok(
    source.includes(
      `INTERNATIONAL_POLICY_VERSION = "${INTERNATIONAL_CURRENCY_POLICY}"`,
    ),
  );
});

test("closed readback must contain exactly JPY, even with a recomputed valid hash", async () => {
  const f = internationalProofFixture();
  const closed = closedInternationalGate(1, f.now, "Asia/Tokyo");
  const check = (value) => {
    f.graph.values.set("gid://shopify/Shop/1", {
      value: JSON.stringify(value),
      compareDigest: "a",
    });
    return inspectInternationalProofRuntime({
      shopDomain: f.payload.shopDomain,
      manifest: f.manifest,
      receipt: f.payload,
      graphQL: f.graphQL,
      env: f.env,
      closed: true,
      generation: 1,
    });
  };
  await check(closed);
  for (const u of [undefined, [], ["USD"], ["JPY", "JPY"]]) {
    const { h: _h, ...base } = closed;
    const value = { ...base, u };
    if (u === undefined) delete value.u;
    await assert.rejects(
      check(sealInternationalProjection(value)),
      (e) => e.code === "international_stop_unverified",
    );
  }
});
