import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateRuntimeOriginPolicy,
  providerSections,
  compareProviderSections,
  verifySdkStatement,
  verifyRegistrySignature,
  sdkMemberPath,
} from "../../scripts/security/function-runtime-origin.mjs";

const policy = () =>
  JSON.parse(
    fs.readFileSync(
      new URL("../../security/function-runtime-origin.json", import.meta.url),
    ),
  );
const uint = (n) => {
  const bytes = [];
  do {
    const b = n & 127;
    n = Math.floor(n / 128);
    bytes.push(b | (n ? 128 : 0));
  } while (n);
  return Buffer.from(bytes);
};
const custom = (name, text) => {
  const n = Buffer.from(name),
    b = Buffer.concat([uint(n.length), n, Buffer.from(text)]);
  return Buffer.concat([Buffer.from([0]), uint(b.length), b]);
};
const header = Buffer.from("0061736d01000000", "hex");
const wasm = (claim, extra = []) =>
  Buffer.concat([
    header,
    custom("git_hash", claim),
    custom("import_namespace", "test"),
    ...extra,
  ]);

test("runtime input policy retains separate SDK origin and unapproved provider/source scopes", () => {
  const p = policy();
  assert.equal(validateRuntimeOriginPolicy(p), p);
  for (const key of [
    "providerSourceProvenanceVerified",
    "providerSbomVerified",
    "wholeCompilerVerified",
    "fullFunctionVerified",
    "productionApproved",
  ]) {
    const q = policy();
    q[key] = true;
    assert.throws(() => validateRuntimeOriginPolicy(q));
  }
  for (const [key, value] of [
    ["name", "other"],
    ["version", "2.0.0"],
    ["commit", "a".repeat(40)],
    ["fileCount", 13],
    ["unpackedSize", 0],
  ]) {
    const q = policy();
    q.sdk[key] = value;
    assert.throws(() => validateRuntimeOriginPolicy(q));
  }
});

test("provider section envelope parsing rejects truncation, overflow and invalid UTF-8", () => {
  assert.equal(providerSections(wasm("a".repeat(40))).length, 2);
  assert.deepEqual(providerSections(header), []);
  for (const b of [
    Buffer.from("not wasm"),
    Buffer.alloc(2_000_001),
    Buffer.concat([header, Buffer.from([0, 255, 255, 255, 255, 255])]),
    Buffer.concat([header, Buffer.from([0, 2, 1, 255])]),
    wasm("a".repeat(40)).subarray(0, 20),
  ])
    assert.throws(() => providerSections(b));
  const large = custom("padding", "x".repeat(200));
  assert.equal(
    providerSections(Buffer.concat([header, large]))[0].name,
    "padding",
  );
});

test("only one git_hash claim may differ; code, data and other custom sections must remain identical", () => {
  const a = wasm("a".repeat(40)),
    b = wasm("b".repeat(40));
  const result = compareProviderSections(a, b);
  assert.equal(result.allOtherSectionsByteIdentical, true);
  assert.equal(result.sourceProvenanceVerified, false);
  assert.deepEqual(result.gitHashClaims, ["a".repeat(40), "b".repeat(40)]);
  assert.throws(() =>
    compareProviderSections(a, wasm("b".repeat(40), [custom("extra", "x")])),
  );
  assert.throws(() =>
    compareProviderSections(
      a,
      Buffer.concat([
        header,
        custom("git_hash", "b".repeat(40)),
        custom("import_namespace", "changed"),
      ]),
    ),
  );
  assert.throws(() => compareProviderSections(header, header));
  const duplicate = wasm("a".repeat(40), [custom("git_hash", "a".repeat(40))]);
  assert.throws(() => compareProviderSections(duplicate, duplicate));
  assert.throws(() =>
    compareProviderSections(wasm("invalid"), wasm("invalid")),
  );
  const core = Buffer.from([1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 4, 1, 2, 0, 11]);
  const changedCore = Buffer.from([
    1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 5, 1, 3, 0, 1, 11,
  ]);
  assert.throws(() =>
    compareProviderSections(
      wasm("a".repeat(40), [core]),
      wasm("b".repeat(40), [changedCore]),
    ),
  );
});

function statement() {
  const { sdk } = policy();
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: "pkg:npm/%40shopify/shopify_function@2.0.1",
        digest: {
          sha512: Buffer.from(sdk.integrity.slice(7), "base64").toString("hex"),
        },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType:
          "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: `https://github.com/${sdk.repository}`,
            path: ".github/workflows/release.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${sdk.repository}@refs/heads/main`,
            digest: { gitCommit: sdk.commit },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
      },
    },
  };
}

test("verified DSSE subject and release workflow must bind the exact archive and source commit", () => {
  const { sdk } = policy();
  assert.equal(verifySdkStatement(statement(), sdk), true);
  for (const mutate of [
    (s) => {
      s.subject[0].digest.sha512 = "00";
    },
    (s) => {
      s.subject.push(s.subject[0]);
    },
    (s) => {
      s.subject[0].name = "pkg:npm/other@2.0.1";
    },
    (s) => {
      s.predicateType = "publish";
    },
    (s) => {
      s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
        "a".repeat(40);
    },
    (s) => {
      s.predicate.buildDefinition.externalParameters.workflow.repository =
        "https://github.com/other/repo";
    },
    (s) => {
      s.predicate.buildDefinition.externalParameters.workflow.ref =
        "refs/heads/other";
    },
    (s) => {
      s.predicate.buildDefinition.externalParameters.workflow.path =
        "other.yml";
    },
    (s) => {
      s.predicate.runDetails.builder.id = "untrusted";
    },
  ]) {
    const s = statement();
    mutate(s);
    assert.throws(() => verifySdkStatement(s, sdk));
  }
});

test("registry signatures require correct bytes, identity, trusted key and nonexpired key lifetime", () => {
  const { sdk } = policy();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const meta = {
    name: sdk.name,
    version: sdk.version,
    gitHead: sdk.commit,
    dist: {
      integrity: sdk.integrity,
      fileCount: sdk.fileCount,
      unpackedSize: sdk.unpackedSize,
      signatures: [
        {
          keyid: "test-key",
          sig: crypto
            .sign(
              "sha256",
              Buffer.from(`${sdk.name}@${sdk.version}:${sdk.integrity}`),
              privateKey,
            )
            .toString("base64"),
        },
      ],
    },
  };
  const keys = {
    keys: [
      {
        keyid: "test-key",
        expires: null,
        key: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      },
    ],
  };
  assert.equal(verifyRegistrySignature(meta, keys, sdk), true);
  const expired = structuredClone(keys);
  expired.keys[0].expires = "2020-01-01T00:00:00Z";
  assert.throws(() => verifyRegistrySignature(meta, expired, sdk));
  assert.throws(() => verifyRegistrySignature(meta, { keys: [] }, sdk));
  for (const mutate of [
    (m) => {
      m.version = "2.0.0";
    },
    (m) => {
      m.gitHead = "a".repeat(40);
    },
    (m) => {
      m.dist.integrity += "x";
    },
    (m) => {
      m.dist.signatures = [];
    },
    (m) => {
      m.dist.signatures[0].sig = Buffer.from("invalid").toString("base64");
    },
  ]) {
    const m = structuredClone(meta);
    mutate(m);
    assert.throws(() => verifyRegistrySignature(m, keys, sdk));
  }
});

test("SDK archive paths permit actual nested dotfiles but reject escaping and ambiguous paths", () => {
  assert.equal(
    sdkMemberPath("package/.changeset/config.json"),
    ".changeset/config.json",
  );
  assert.equal(sdkMemberPath("package/run.ts"), "run.ts");
  for (const p of [
    "package/../x",
    "package/./x",
    "/package/x",
    "C:/x",
    "package\\x",
    "package/a//b",
    "package/x\n",
    "package/" + "x".repeat(251),
  ])
    assert.throws(() => sdkMemberPath(p));
});

test("origin workflow is read-only, scoped and cannot publish, install or execute provider guests", () => {
  const workflow = fs.readFileSync(
    new URL(
      "../../.github/workflows/function-runtime-origin.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /artifact-ids: 13504146003/);
  assert.match(workflow, /run-id: 42221077360/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(
    workflow,
    /schedule:|pull_request_target:|secrets\.|npm ci|shopify app deploy|docker run|npm publish/,
  );
});
