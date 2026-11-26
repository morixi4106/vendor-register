import assert from "node:assert/strict";
import test from "node:test";
import {
  internationalProofFixture,
  proofZip,
} from "../helpers/internationalProofFixture.js";
import { readProofArchive } from "../../app/utils/internationalProofArchive.js";
import {
  proofHash,
  validateManifest,
  signProofPayload,
  verifyProofSignature,
  validateReceipt,
  validateObservation,
} from "../../app/utils/internationalProofContract.js";
import {
  verifyInternationalProofArtifact,
  createInternationalProofGitHub,
  isPublicProofAddress,
} from "../../app/services/internationalProofGitHub.server.js";
import { inspectInternationalProofRuntime } from "../../app/services/internationalProofRuntime.server.js";
import { inspectInternationalAuthorizationProof } from "../../app/services/internationalProofReader.server.js";
import { createInternationalProofCommands } from "../../app/services/internationalProofIssuance.server.js";
import { inspectInternationalAuthorizationCapability } from "../../app/services/internationalAuthorizationPolicy.server.js";
import { validatePublishApproval } from "../../scripts/international-proof-publisher.mjs";

test("manifest is exact, versioned, bounded and binds individual bytes separately from archive", async () => {
  const f = internationalProofFixture();
  assert.equal(validateManifest(f.manifest), f.manifest);
  const verified = await verifyInternationalProofArtifact({
    artifactId: 200,
    github: f.github,
    now: f.now,
  });
  assert.equal(verified.archiveHash, f.archiveHash);
  assert.notEqual(verified.contentDigest, f.archiveHash);
  for (const extra of [
    { repository: "attacker/repo" },
    { actor: "forged" },
    { casesHash: "0".repeat(64) },
    { function: { ...f.manifest.function, uid: "other" } },
    { files: [...f.manifest.files, f.manifest.files[0]] },
  ])
    assert.throws(() => validateManifest({ ...f.manifest, ...extra }));
});
test("archive rejects traversal, case collisions, special files, corrupt CRC, overlap, oversized and unknown formats", () => {
  assert.equal(
    readProofArchive(proofZip([["a/file", "ok"]]))
      .get("a/file")
      .toString(),
    "ok",
  );
  for (const rows of [
    [["../file", "x"]],
    [["/file", "x"]],
    [
      ["A", "x"],
      ["a", "y"],
    ],
    [
      ["a", "x"],
      ["a/file", "y"],
    ],
    [["con.txt", "x"]],
  ])
    assert.throws(() => readProofArchive(proofZip(rows)));
  const crc = proofZip([["a", "ok"]]);
  crc[31] ^= 1;
  assert.throws(() => readProofArchive(crc));
  const link = proofZip([["a", "ok"]]);
  const central = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  link.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => readProofArchive(link));
  assert.throws(() => readProofArchive(Buffer.alloc(10)));
  assert.throws(() => readProofArchive(Buffer.alloc(64 * 1024 * 1024 + 1)));
});
for (const [name, mutate] of [
  ["fork", (f) => (f.responses["/actions/runs/100"].head_repository.id = 99)],
  [
    "another head",
    (f) => (f.responses["/actions/runs/100"].head_sha = "c".repeat(40)),
  ],
  [
    "another attempt",
    (f) => (f.responses["/actions/runs/100"].run_attempt = 2),
  ],
  [
    "PR event",
    (f) => (f.responses["/actions/runs/100"].event = "pull_request"),
  ],
  [
    "failed run",
    (f) => (f.responses["/actions/runs/100"].conclusion = "failure"),
  ],
  ["wrong workflow", (f) => (f.responses["/actions/runs/100"].path = "other")],
  [
    "wrong digest",
    (f) =>
      (f.responses["/actions/artifacts/200"].digest =
        `sha256:${"d".repeat(64)}`),
  ],
  ["expired", (f) => (f.responses["/actions/artifacts/200"].expired = true)],
  [
    "deleted protection",
    (f) => (f.responses["/branches/main"].protected = false),
  ],
  ["unknown storage visibility", (f) => (f.responses[""].private = null)],
  [
    "failed quality",
    (f) => (f.responses["/actions/runs/101"].conclusion = "failure"),
  ],
])
  test(`artifact refuses ${name}`, async () => {
    const f = internationalProofFixture();
    mutate(f);
    await assert.rejects(
      verifyInternationalProofArtifact({
        artifactId: 200,
        github: f.github,
        now: f.now,
      }),
    );
  });
test("ZIP deflate and streamed descriptors are checked; bombs and truncated archives fail", () => {
  for (const descriptor of [true, false]) {
    const bytes = proofZip([["a/file", "known fixture bytes"]], {
      deflate: true,
      descriptor,
    });
    assert.equal(
      readProofArchive(bytes).get("a/file").toString(),
      "known fixture bytes",
    );
    for (let end = 0; end < bytes.length; end++)
      assert.throws(() => readProofArchive(bytes.subarray(0, end)));
  }
  assert.throws(() =>
    readProofArchive(
      proofZip([["bomb", "a".repeat(1000000)]], { deflate: true }),
    ),
  );
});

test("signatures are domain-separated, fixed-root, non-self-registering and revocable", () => {
  const f = internationalProofFixture();
  assert.equal(
    verifyProofSignature(f.receipt, "publisher", f.now, f.trust),
    f.payload,
  );
  assert.throws(() => verifyProofSignature(f.receipt, "publisher", f.now));
  assert.throws(() =>
    verifyProofSignature(f.receipt, "observer", f.now, f.trust),
  );
  assert.throws(() =>
    verifyProofSignature(
      { ...f.receipt, publicKey: "self" },
      "publisher",
      f.now,
      f.trust,
    ),
  );
  assert.throws(() =>
    verifyProofSignature(
      { ...f.receipt, payload: { ...f.payload, appId: "other" } },
      "publisher",
      f.now,
      f.trust,
    ),
  );
  f.trust.publisher[0].revokedAt = f.now;
  assert.throws(() =>
    verifyProofSignature(f.receipt, "publisher", f.now, f.trust),
  );
});
test("receipt requires release, exact app/shop/build, independent backend records and use deadline", () => {
  const f = internationalProofFixture();
  const options = {
    manifest: f.manifest,
    archiveHash: f.archiveHash,
    shopDomain: f.payload.shopDomain,
    now: f.now,
    trust: f.trust,
  };
  assert.equal(validateReceipt(f.receipt, options).id, "receipt1");
  for (const extra of [
    { purpose: "STAGE" },
    { shopDomain: "other.myshopify.com" },
    { web: { ...f.payload.web, status: "failed" } },
    { allowedUseUntil: "2020-01-01" },
    { executeBefore: "2020-01-01" },
    { contentDigest: "e".repeat(64) },
  ]) {
    const envelope = signProofPayload(
      "publisher",
      { ...f.payload, ...extra },
      "pub1",
      f.publisher.privateKey,
    );
    assert.throws(() => validateReceipt(envelope, options));
  }
});
test("observations cannot be made fresh by reading or resending them", () => {
  const f = internationalProofFixture();
  const nonceHash = "f".repeat(64);
  const options = {
    receipt: f.payload,
    runId: "run1",
    nonceHash,
    now: new Date(),
    trust: f.trust,
  };
  const signed = f.observation("run1", nonceHash);
  options.now = new Date();
  assert.equal(validateObservation(signed, options).sequence, 1);
  for (const extra of [
    { nonceHash: "a".repeat(64) },
    { versionId: "other" },
    { runId: "other" },
    { observedAt: new Date(Date.now() + 60000).toISOString() },
    { observedAt: new Date(Date.now() - 120000).toISOString() },
    { expiresAt: new Date(Date.now() + 3600000).toISOString() },
  ])
    assert.throws(() =>
      validateObservation(f.observation("run1", nonceHash, 1, extra), {
        ...options,
        now: new Date(),
      }),
    );
});
test("GitHub download strips credentials on approved redirect and bounds bodies", async () => {
  const calls = [];
  const github = createInternationalProofGitHub({
    token: "test-not-a-secret",
    resolve: async () => [{ address: "1.1.1.1" }],
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://proof.blob.core.windows.net/archive",
            },
          })
        : new Response("fixture");
    },
  });
  assert.equal((await github.archive(1)).toString(), "fixture");
  assert.ok(calls[0][1].headers.Authorization);
  assert.equal(calls[1][1].headers.Authorization, undefined);
  for (const destination of [
    "http://proof.blob.core.windows.net/a",
    "https://evil.test/a",
    "https://user@proof.blob.core.windows.net/a",
  ]) {
    const bad = createInternationalProofGitHub({
      resolve: async () => [{ address: "1.1.1.1" }],
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: destination } }),
    });
    await assert.rejects(bad.archive(1));
  }
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "169.254.169.254",
  ])
    assert.equal(isPublicProofAddress(address), false);
  const huge = createInternationalProofGitHub({
    resolve: async () => [{ address: "1.1.1.1" }],
    fetchImpl: async () =>
      new Response("{}", { headers: { "Content-Length": "300000" } }),
  });
  await assert.rejects(huge.json(""));
});
test("runtime checks actual Function query/validation and treats env as expectation only", async () => {
  const f = internationalProofFixture();
  const args = {
    shopDomain: f.payload.shopDomain,
    manifest: f.manifest,
    receipt: f.payload,
    graphQL: f.graphQL,
    env: f.env,
  };
  const runtime = await inspectInternationalProofRuntime(args);
  assert.equal(runtime.dto.enabled, true);
  await assert.rejects(
    inspectInternationalProofRuntime({
      ...args,
      env: { ...f.env, SHOPIFY_APP_VERSION: "other" },
    }),
  );
  await assert.rejects(
    inspectInternationalProofRuntime({
      ...args,
      graphQL: async () => ({ data: {} }),
    }),
  );
});
test("4C and unsigned/unconfigured proof paths remain closed without network or DB writes", async () => {
  assert.equal(inspectInternationalAuthorizationCapability().ready, false);
  assert.equal(
    (await inspectInternationalAuthorizationProof({ purpose: "SALE" })).ready,
    false,
  );
  assert.equal(
    (
      await inspectInternationalAuthorizationProof({
        purpose: "DEPLOYMENT",
        prismaClient: {},
      })
    ).ready,
    false,
  );
  const f = internationalProofFixture();
  const roles = [];
  const command = createInternationalProofCommands({
    requireOperator: async (_r, o) => {
      roles.push(o.role);
      return {
        session: { shop: f.payload.shopDomain },
        operator: { actorKey: "shopify_user:1" },
      };
    },
    github: {
      archive: async () => {
        throw new Error("must not fetch");
      },
    },
  });
  await assert.rejects(
    command.prepare(new Request("https://example.test", { method: "POST" }), {
      artifactId: 200,
      receipt: f.receipt,
    }),
    /artifact_untrusted/,
  );
  assert.deepEqual(roles, ["RELEASE_MANAGER"]);
  await assert.rejects(
    command.prepare(new Request("https://example.test"), {}),
    (e) => e.status === 405,
  );
  assert.throws(() => validatePublishApproval({ passed: true }, new Date()));
  assert.notEqual(proofHash(f.manifest), f.archiveHash);
});
