import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { internationalProofFixture } from "../helpers/internationalProofFixture.js";
import { publishInternationalProof } from "../../scripts/international-proof-publisher.mjs";
import { observeInternationalProof } from "../../scripts/international-proof-observer.mjs";
import {
  proofHash,
  validateReceipt,
  validateObservation,
} from "../../app/utils/internationalProofContract.js";

test("publisher stages exact bytes without building, releases only by separate approval, never passes signing key to CLI", async () => {
  const f = internationalProofFixture();
  const env = {
    ...f.env,
    SHOPIFY_CLI_PARTNERS_TOKEN: "fixture-cli-token",
    INTERNATIONAL_PROOF_PUBLISHER_KEY_ID: "pub1",
    INTERNATIONAL_PROOF_PUBLISHER_PRIVATE_KEY: f.publisher.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
  };
  const approval = {
    v: f.payload.v,
    id: "stage1",
    purpose: "STAGE",
    shopDomain: f.payload.shopDomain,
    appId: "app1",
    artifactId: 200,
    headSha: f.manifest.headSha,
    contentDigest: proofHash(f.manifest),
    archiveDigest: f.archiveHash,
    versionTag: "proof-v1",
    versionId: null,
    executeBefore: f.payload.executeBefore,
    allowedUseUntil: f.payload.allowedUseUntil,
    webServiceId: "web1",
    cronServiceId: "cron1",
  };
  const calls = [];
  let staged = false;
  let active = false;
  const dependencies = {
    github: f.github,
    trust: f.trust,
    readServices: async () => ({ web: f.payload.web, cron: f.payload.cron }),
    spawn: (_command, args, options) => {
      assert.equal(options.shell, false);
      assert.equal(
        options.env.INTERNATIONAL_PROOF_PUBLISHER_PRIVATE_KEY,
        undefined,
      );
      calls.push(args);
      if (args[2] === "deploy") {
        assert.ok(args.includes("--no-build"));
        assert.ok(args.includes("--no-release"));
        staged = true;
      }
      if (args[2] === "release") active = true;
      return {
        status: 0,
        stdout:
          args[2] === "versions"
            ? JSON.stringify(
                staged
                  ? [
                      {
                        id: "version1",
                        versionTag: "proof-v1",
                        status: active ? "active" : "inactive",
                      },
                    ]
                  : [],
              )
            : "not evidence",
      };
    },
  };
  const stageReceipt = await publishInternationalProof(
    { approval, env },
    dependencies,
  );
  assert.equal(stageReceipt.payload.purpose, "STAGE");
  assert.equal(active, false);
  const release = {
    ...approval,
    id: "release1",
    purpose: "RELEASE",
    versionId: "version1",
  };
  const receipt = await publishInternationalProof(
    { approval: release, stageReceipt, env },
    dependencies,
  );
  assert.equal(
    validateReceipt(receipt, {
      manifest: f.manifest,
      archiveHash: f.archiveHash,
      shopDomain: f.payload.shopDomain,
      now: new Date(),
      trust: f.trust,
    }).purpose,
    "RELEASE",
  );
  assert.equal(calls.filter((c) => c[2] === "deploy").length, 1);
  assert.equal(calls.filter((c) => c[2] === "release").length, 1);
  const before = calls.length;
  await assert.rejects(
    publishInternationalProof(
      { approval, env },
      { ...dependencies, trust: { publisher: [] } },
    ),
  );
  assert.equal(calls.length, before);
});
test("observer can only read versions and signs the bound request, not an input passed flag", async () => {
  const f = internationalProofFixture();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "proof-observer-test-"),
  );
  const configPath = path.join(directory, "shopify.app.production.toml");
  fs.writeFileSync(configPath, f.files.get("shopify.app.production.toml"));
  try {
    const nonce = "a".repeat(64);
    const input = { runId: "run1", receipt: f.receipt, nonce, sequence: 1 };
    const env = {
      ...f.env,
      INTERNATIONAL_PROOF_SHOPIFY_READ_TOKEN: "fixture-read-token",
      INTERNATIONAL_PROOF_OBSERVER_KEY_ID: "obs1",
      INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY: f.observer.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    };
    const dependencies = {
      env,
      configPath,
      trust: f.trust,
      readServices: async () => ({ web: f.payload.web, cron: f.payload.cron }),
      spawn: (_command, args, options) => {
        assert.deepEqual(args.slice(1, 5), [
          "app",
          "versions",
          "list",
          "--json",
        ]);
        assert.equal(
          options.env.INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY,
          undefined,
        );
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: "version1", versionTag: "proof-v1", status: "active" },
          ]),
        };
      },
    };
    const signed = await observeInternationalProof(input, dependencies);
    assert.equal(
      validateObservation(signed, {
        receipt: f.payload,
        runId: "run1",
        now: new Date(),
        trust: f.trust,
      }).sequence,
      1,
    );
    await assert.rejects(
      observeInternationalProof({ ...input, passed: true }, dependencies),
    );
    await assert.rejects(
      observeInternationalProof(input, {
        ...dependencies,
        spawn: () => ({ status: 0, stdout: "[]" }),
      }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
