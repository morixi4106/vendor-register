import { generateKeyPairSync } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import {
  byteHash,
  proofHash,
  PROOF_VERSION,
  PROOF_WORKFLOW,
  PROOF_REPOSITORY,
  FUNCTION_UID,
  signProofPayload,
  PROOF_SCHEMA_MIGRATION_VERSION,
  CHECKOUT_CONTRACT_PATHS,
} from "../../app/utils/internationalProofContract.js";
import { internationalGraphMemory } from "./internationalGateMemory.js";

export function proofZip(
  entries,
  { deflate = false, descriptor = false } = {},
) {
  const bodies = [];
  const directory = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const fileName = Buffer.from(name);
    const bytes = Buffer.from(value);
    const packed = deflate ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt16LE(descriptor ? 8 : 0, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt16LE(descriptor ? 8 : 0, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(crc32(bytes), 4);
      trailer.writeUInt32LE(packed.length, 8);
      trailer.writeUInt32LE(bytes.length, 12);
    }
    bodies.push(local, fileName, packed, trailer);
    directory.push(central, fileName);
    offset += local.length + fileName.length + packed.length + trailer.length;
  }
  const table = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, table, end]);
}
export function internationalProofFixture(
  shopDomain = "example.myshopify.com",
) {
  const now = new Date();
  const future = new Date(+now + 5 * 86400000).toISOString();
  const publisher = generateKeyPairSync("ed25519");
  const observer = generateKeyPairSync("ed25519");
  const key = (keys, id) => ({
    id,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    notBefore: new Date(+now - 86400000).toISOString(),
    notAfter: future,
  });
  const trust = {
    publisher: [key(publisher, "pub1")],
    observer: [key(observer, "obs1")],
  };
  const root = "extensions/marketplace-purchase-control";
  const files = new Map([
    ["shopify.app.production.toml", Buffer.from('client_id = "app1"\n')],
    [`${root}/dist/function.wasm`, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    [
      `${root}/src/cart_validations_generate_run.graphql`,
      Buffer.from("query Input { cart { id } }"),
    ],
    [`${root}/schema.graphql`, Buffer.from("type Query { id: ID }")],
  ]);
  const rows = [...files].map(([path, bytes]) => ({
    path,
    size: bytes.length,
    sha256: byteHash(bytes),
  }));
  const manifest = {
    v: PROOF_VERSION,
    repository: PROOF_REPOSITORY,
    repositoryId: 1,
    workflow: PROOF_WORKFLOW,
    workflowId: 2,
    workflowDigest: byteHash(Buffer.from("workflow")),
    headSha: "a".repeat(40),
    runId: 100,
    runAttempt: 1,
    event: "workflow_dispatch",
    channel: "production",
    createdAt: now.toISOString(),
    lockDigest: "b".repeat(64),
    nodeVersion: "24.1.0",
    cliVersion: "4.5.2",
    checks: {
      quality: { runId: 101, runAttempt: 1 },
      postgres: { runId: 102, runAttempt: 1 },
    },
    caseIds: ["fixture:test"],
    casesHash: proofHash(["fixture:test"]),
    testDigest: "c".repeat(64),
    function: {
      handle: "marketplace-purchase-control",
      uid: FUNCTION_UID,
      apiVersion: "2026-04",
      target: "cart.validations.generate.run",
      export: "cart-validations-generate-run",
      wasm: `${root}/dist/function.wasm`,
      query: `${root}/src/cart_validations_generate_run.graphql`,
      schema: `${root}/schema.graphql`,
      policy: "international-sale-2026-10-v2",
      projectionVersion: 3,
    },
    files: rows,
    deploymentDigest: proofHash(rows),
  };
  const verifierFiles = CHECKOUT_CONTRACT_PATHS.map((path) => ({ path, size: 7, sha256: byteHash(Buffer.from("fixture")) }));
  manifest.checkoutVerifier = { v: "international-checkout-verifier-v1", level: "CONTRACT_ONLY",
    scenarioVersion: "international-checkout-cases-v1", verifierVersion: "international-checkout-contract-v1",
    files: verifierFiles, digest: proofHash(verifierFiles) };
  const archive = proofZip([
    ["manifest.json", Buffer.from(JSON.stringify(manifest))],
    ...files,
  ]);
  const archiveHash = byteHash(archive);
  const service = (id) => ({
    serviceId: id,
    deployId: `${id}-deploy`,
    commit: manifest.headSha,
    status: "live",
  });
  const payload = {
    v: PROOF_VERSION,
    id: "receipt1",
    approvalId: "approval1",
    purpose: "RELEASE",
    shopDomain,
    appId: "app1",
    headSha: manifest.headSha,
    runId: 100,
    runAttempt: 1,
    artifactId: 200,
    contentDigest: proofHash(manifest),
    archiveDigest: archiveHash,
    deploymentDigest: manifest.deploymentDigest,
    versionId: "version1",
    versionTag: "proof-v1",
    startedAt: new Date(+now - 2000).toISOString(),
    completedAt: new Date(+now - 1000).toISOString(),
    executeBefore: future,
    allowedUseUntil: future,
    web: service("web1"),
    cron: service("cron1"),
    migrationVersion: PROOF_SCHEMA_MIGRATION_VERSION,
  };
  const receipt = signProofPayload(
    "publisher",
    payload,
    "pub1",
    publisher.privateKey,
  );
  const run = {
    id: 100,
    repository: { id: 1 },
    head_repository: { id: 1 },
    head_sha: manifest.headSha,
    run_attempt: 1,
    head_branch: "main",
    path: PROOF_WORKFLOW,
    workflow_id: 2,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_started_at: new Date(+now - 10000).toISOString(),
    updated_at: new Date(+now + 1000).toISOString(),
  };
  const responses = {
    "": { id: 1, full_name: PROOF_REPOSITORY, private: true },
    "/branches/main": { protected: true },
    "/actions/workflows/international-proof-artifact.yml": {
      id: 2,
      path: PROOF_WORKFLOW,
      state: "active",
    },
    "/actions/runs/100": run,
    "/actions/runs/101": {
      ...run,
      id: 101,
      path: ".github/workflows/quality.yml",
      event: "push",
    },
    "/actions/runs/102": {
      ...run,
      id: 102,
      path: ".github/workflows/international-authorization-postgres.yml",
      event: "push",
    },
    "/actions/artifacts/200": {
      id: 200,
      workflow_run: { id: 100, head_sha: manifest.headSha },
      name: "international-proof-100-1",
      expired: false,
      digest: `sha256:${archiveHash}`,
      size_in_bytes: archive.length,
      expires_at: future,
      created_at: now.toISOString(),
    },
    [`/contents/${PROOF_WORKFLOW}?ref=${manifest.headSha}`]: {
      encoding: "base64",
      content: Buffer.from("workflow").toString("base64"),
    },
  };
  const github = {
    json: async (p) => {
      if (!(p in responses)) throw new Error(`unexpected fixture path ${p}`);
      return structuredClone(responses[p]);
    },
    archive: async () => archive,
  };
  for (const row of verifierFiles) responses[`/contents/${row.path}?ref=${manifest.headSha}`] = {
    encoding: "base64", content: Buffer.from("fixture").toString("base64"),
  };
  const graph = internationalGraphMemory();
  const graphQL = async (args) => {
    if (args.query.includes("MarketplacePurchaseControlValidations"))
      return {
        data: {
          validations: {
            nodes: [
              {
                id: "validation1",
                enabled: true,
                blockOnFailure: true,
                errorHistory: null,
                shopifyFunction: {
                  id: "function1",
                  handle: "marketplace-purchase-control",
                  apiVersion: "2026-04",
                },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      };
    if (args.query.includes("InternationalProofFunction"))
      return {
        data: {
          shopifyFunction: {
            id: "function1",
            appKey: "app1",
            handle: "marketplace-purchase-control",
            apiVersion: "2026-04",
            inputQuery: files.get(manifest.function.query).toString(),
          },
        },
      };
    return graph.graphQL(args);
  };
  const observation = (runId, nonceHash, sequence = 1, extra = {}) =>
    signProofPayload(
      "observer",
      {
        v: PROOF_VERSION,
        runId,
        receiptId: payload.id,
        shopDomain,
        appId: payload.appId,
        versionId: payload.versionId,
        versionTag: payload.versionTag,
        web: payload.web,
        cron: payload.cron,
        sequence,
        nonceHash,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        ...extra,
      },
      "obs1",
      observer.privateKey,
    );
  return {
    now,
    manifest,
    files,
    archive,
    archiveHash,
    trust,
    publisher,
    observer,
    payload,
    receipt,
    responses,
    github,
    graph,
    graphQL,
    observation,
    env: {
      SHOPIFY_API_KEY: "app1",
      RENDER_GIT_COMMIT: manifest.headSha,
      SHOPIFY_APP_VERSION: payload.versionTag,
    },
  };
}
