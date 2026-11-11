import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  PRISMA_RUNTIME_BASE,
  prismaRuntimeOptions,
  prismaRuntimeCreateArguments,
  verifyPrismaRuntimeRecipe,
  verifyPrismaRuntimeContainer,
  verifyPrismaRuntimeReport,
} from "../../scripts/security/prisma-runtime-compatibility.mjs";
import { DATABASE_NATIVE_INPUT } from "../../scripts/security/database-compatibility.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const policy = JSON.parse(read("security/node-runtime.json"));
const settings = {
  image: "sha256:" + "1".repeat(64),
  nonce: "2".repeat(24),
  uid: 1001,
  gid: 1001,
  inputs: "/tmp/oja/inputs",
  work: "/tmp/oja/work",
  modules: "/tmp/oja/node_modules",
};

test("Debian runtime probes accept only argument-free Linux CI, never production URLs or supplied containers", () => {
  const ci = { CI: "true", GITHUB_ACTIONS: "true" };
  assert.equal(prismaRuntimeOptions([], ci, "linux"), undefined);
  for (const args of [
    ["--skip"],
    ["--url", "production"],
    ["--container", "a".repeat(64)],
  ])
    assert.throws(
      () => prismaRuntimeOptions(args, ci, "linux"),
      /arguments_invalid/,
    );
  for (const [env, platform] of [
    [{}, "linux"],
    [ci, "win32"],
  ])
    assert.throws(
      () => prismaRuntimeOptions([], env, platform),
      /arguments_invalid/,
    );
});

test("runtime image uses the exact application base and system-package prefix, without application build or startup", () => {
  const recipe = read("tests/fixtures/prisma/runtime.Dockerfile");
  assert.match(
    PRISMA_RUNTIME_BASE,
    /^node:24\.22\.1-bookworm-slim@sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    verifyPrismaRuntimeRecipe(recipe, read("Dockerfile")),
    undefined,
  );
  assert.equal(
    verifyPrismaRuntimeRecipe(
      recipe.replace(/\r?\n/g, "\r\n"),
      read("Dockerfile"),
    ),
    undefined,
  );
  for (const changed of [
    recipe.replace("bookworm", "trixie"),
    recipe.replace("ca-certificates", "curl"),
    recipe + "\nCOPY . .\n",
    recipe + "\nCMD npm start\n",
  ])
    assert.throws(
      () => verifyPrismaRuntimeRecipe(changed, read("Dockerfile")),
      /recipe_invalid/,
    );
});

test("container creation has no network, root, capabilities, credentials, Docker socket or writable dependency mounts", () => {
  const args = prismaRuntimeCreateArguments(settings);
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "create");
  assert.equal(value("--network"), "none");
  assert.equal(value("--user"), "1001:1001");
  assert.equal(value("--cap-drop"), "ALL");
  assert.equal(value("--security-opt"), "no-new-privileges");
  assert.ok(args.includes("--read-only"));
  assert.equal(value("--tmpfs"), "/tmp:rw,noexec,nosuid,nodev,size=64m");
  assert.equal(args.filter((a) => a === "--mount").length, 3);
  assert.equal(args.filter((a) => a === "--env").length, 1);
  assert.equal(value("--env"), "HOME=/work/home");
  assert.ok(
    args.includes(
      `type=bind,source=${settings.modules},target=/work/node_modules,readonly`,
    ),
  );
  assert.ok(
    args.includes(
      `type=bind,source=${settings.inputs},target=/inputs,readonly`,
    ),
  );
  assert.ok(
    !args.some((a) =>
      /docker\.sock|\/var\/run|env-file|privileged|publish/.test(a),
    ),
  );
  for (const changed of [
    { uid: 0 },
    { gid: -1 },
    { image: "node:latest" },
    { nonce: "production" },
    { work: "/tmp/../etc" },
    { modules: "/tmp/m,readonly=false" },
    { inputs: "relative" },
  ])
    assert.throws(
      () => prismaRuntimeCreateArguments({ ...settings, ...changed }),
      /container_invalid/,
    );
});

function container() {
  return [
    {
      Id: "3".repeat(64),
      Image: settings.image,
      Name: `/oja-prisma-runtime-${settings.nonce}`,
      Config: {
        User: "1001:1001",
        Labels: { "oja.prisma-runtime": settings.nonce },
      },
      State: { ExitCode: 0, OOMKilled: false },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 128,
        Memory: 1073741824,
        NanoCpus: 2000000000,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
      },
      Mounts: [
        ["inputs", "/inputs", false],
        ["modules", "/work/node_modules", false],
        ["work", "/work", true],
      ].map(([key, destination, rw]) => ({
        Type: "bind",
        Source: settings[key],
        Destination: destination,
        RW: rw,
      })),
    },
  ];
}

test("actual container inspection rejects substituted IDs, network access, root, writes, privilege and missing resource limits", () => {
  const expected = { ...settings, container: "3".repeat(64) };
  assert.equal(
    verifyPrismaRuntimeContainer(container(), expected).Id,
    expected.container,
  );
  for (const mutate of [
    (r) => (r[0].Id = "4".repeat(64)),
    (r) => (r[0].Image = "sha256:" + "4".repeat(64)),
    (r) => (r[0].Config.Labels["oja.prisma-runtime"] = "other"),
    (r) => (r[0].Config.User = "0:0"),
    (r) => (r[0].State.ExitCode = 1),
    (r) => (r[0].State.OOMKilled = true),
    (r) => (r[0].HostConfig.NetworkMode = "host"),
    (r) => (r[0].HostConfig.ReadonlyRootfs = false),
    (r) => (r[0].HostConfig.Privileged = true),
    (r) => (r[0].HostConfig.CapDrop = []),
    (r) => (r[0].HostConfig.SecurityOpt = []),
    (r) => (r[0].HostConfig.PidsLimit = 0),
    (r) => (r[0].HostConfig.Memory = 0),
    (r) => (r[0].HostConfig.NanoCpus = 0),
    (r) => (r[0].HostConfig.Tmpfs["/tmp"] = "rw"),
    (r) => (r[0].Mounts[0].RW = true),
    (r) => (r[0].Mounts[1].Source = "/secret"),
    (r) => r[0].Mounts.pop(),
    (r) => r.push(r[0]),
  ]) {
    const value = container();
    mutate(value);
    assert.throws(
      () => verifyPrismaRuntimeContainer(value, expected),
      /evidence_invalid/,
    );
  }
});

const native = {
  sourceCommit: "c".repeat(40),
  librarySha256: "4".repeat(64),
  schemaSha256: "5".repeat(64),
};
function report() {
  return {
    schemaVersion: 1,
    node: {
      version: policy.version,
      platform: "linux",
      arch: "x64",
      sha256: policy.artifacts["linux-x64"].executableSha256,
    },
    os: { id: "debian", versionId: "12", codename: "bookworm", glibc: "2.36" },
    uid: 1001,
    nodeOpenSsl: "3.5.4",
    systemOpenSsl: "OpenSSL 3.0.17",
    systemPackages: [
      "ca-certificates",
      "libc6",
      "libgcc-s1",
      "libssl3",
      "openssl",
      "zlib1g",
    ].map((name) => ({
      name,
      version: "synthetic-version",
      architecture: "amd64",
    })),
    sharedLibraries: [
      "libssl.so.3",
      "libcrypto.so.3",
      "libz.so.1",
      "libgcc_s.so.1",
      "libm.so.6",
      "libc.so.6",
    ].map((name) => ({ name, sha256: "6".repeat(64) })),
    ca: { sha256: "7".repeat(64), bytes: 1000 },
    schemaCliVersion: "schema-engine-cli " + native.sourceCommit,
    native: {
      provider: "sqlite",
      sourceCommit: native.sourceCommit,
      librarySha256: native.librarySha256,
      schemaSha256: native.schemaSha256,
      loadedLibrarySha256: native.librarySha256,
      checks: [
        "native-identity",
        "generated-client-native-loader",
        "json-protocol-isolation",
        "graphql-depth-limit",
        "migration-history",
        "crud-and-cuid",
        "parameterized-query",
        "unique-error",
        "batch-transaction",
        "interactive-commit",
        "interactive-rollback",
        "reconnect",
        "cleanup",
      ],
      migrationsApplied: 2,
      rowsRemaining: 0,
      schemaEngineInvocations: 6,
      clientVersion: "6.19.3",
      jsonProtocol: {
        constructorProtocol: "json",
        roundTrips: 9,
        graphqlEnvelopeRejected: true,
        healthyControls: 2,
      },
      graphql: {
        maximumNesting: 50,
        rejected: 6,
        acceptedLexicalCases: 3,
        controlQueries: 26,
        unicodeCases: 4,
      },
      productionApproved: false,
    },
    wholeEngineVerified: false,
    productionApproved: false,
  };
}

test("runtime evidence requires exact Node bytes, Debian/glibc, loaded libraries, package inventory, CA and every actual native regression", () => {
  const verify = (r) => verifyPrismaRuntimeReport(r, native, policy);
  const good = report();
  assert.equal(verify(good), good);
  for (const mutate of [
    (r) => (r.productionApproved = true),
    (r) => (r.wholeEngineVerified = true),
    (r) => (r.node.sha256 = "0".repeat(64)),
    (r) => (r.os.versionId = "13"),
    (r) => (r.os.glibc = "2.41"),
    (r) => (r.uid = 0),
    (r) => (r.systemOpenSsl = "OpenSSL 1.1.1"),
    (r) => r.systemPackages.pop(),
    (r) => (r.systemPackages[0].version = ""),
    (r) => r.sharedLibraries.pop(),
    (r) => (r.sharedLibraries[0].sha256 = "invalid"),
    (r) => (r.ca.bytes = 0),
    (r) => (r.schemaCliVersion = "substituted"),
    (r) => r.native.checks.pop(),
    (r) => {
      delete r.native.jsonProtocol;
    },
    (r) => (r.native.jsonProtocol.constructorProtocol = "graphql"),
    (r) => (r.native.jsonProtocol.graphqlEnvelopeRejected = false),
    (r) => (r.native.jsonProtocol.roundTrips = 0),
    (r) => (r.native.graphql.controlQueries = 0),
    (r) => (r.native.loadedLibrarySha256 = "0".repeat(64)),
    (r) => (r.native.rowsRemaining = 1),
  ]) {
    const value = report();
    mutate(value);
    assert.throws(() => verify(value), /evidence_invalid/);
  }
});

test("runtime workflow downloads only fixed verified input and has no schedules, credentials, publish or promotion", () => {
  const w = yaml.load(
    read(".github/workflows/prisma-runtime-compatibility.yml"),
  );
  assert.deepEqual(w.permissions, { contents: "read", actions: "read" });
  assert.equal(w.on.schedule, undefined);
  assert.equal(w.on.workflow_run, undefined);
  const job = w.jobs["debian-runtime"],
    steps = job.steps;
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.services, undefined);
  assert.equal(job.environment, undefined);
  assert.equal(steps[0].with["persist-credentials"], false);
  const download = steps.find((s) => s.with?.["artifact-ids"]);
  assert.equal(
    String(download.with["artifact-ids"]),
    DATABASE_NATIVE_INPUT.artifactId,
  );
  assert.equal(String(download.with["run-id"]), DATABASE_NATIVE_INPUT.run);
  for (const step of steps.filter((s) => s.run)) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.ok(!/deploy|release|notify|migrate deploy/.test(step.run));
  }
  assert.ok(
    !read(".github/workflows/prisma-runtime-compatibility.yml").includes(
      "secrets.",
    ),
  );
  const upload = steps.find((s) => s.with?.["retention-days"]);
  assert.equal(upload.with.path, ".audit/prisma-runtime/");
  assert.equal(upload.with["retention-days"], 45);
});
