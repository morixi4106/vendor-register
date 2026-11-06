import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  DATABASE_NATIVE_INPUT,
  selectDatabaseNativeInput,
  sha,
} from "./database-compatibility.mjs";
import {
  prismaNativeFixture,
  verifyPrismaNativeProbeReport,
} from "./prisma-native-probe.mjs";
import { assertNodeRuntime, evaluateNodeRuntime } from "./node-runtime.mjs";
import { rustBuildEnvironment } from "./rust-toolchain.mjs";

export const PRISMA_RUNTIME_BASE =
  "node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c";
const LIBRARIES = [
  "libssl.so.3",
  "libcrypto.so.3",
  "libz.so.1",
  "libgcc_s.so.1",
  "libm.so.6",
  "libc.so.6",
];
const PACKAGES = [
  "ca-certificates",
  "libc6",
  "libgcc-s1",
  "libssl3",
  "openssl",
  "zlib1g",
];
const ROOT = path.resolve(import.meta.dirname, "../..");

export function prismaRuntimeOptions(
  args,
  env = process.env,
  platform = process.platform,
) {
  if (
    args.length ||
    platform !== "linux" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true"
  )
    throw new Error("prisma_runtime_arguments_invalid");
}

export function verifyPrismaRuntimeRecipe(recipe, applicationRecipe) {
  const normalized = recipe.replace(/\r\n/g, "\n").trim();
  if (
    !normalized.startsWith(`FROM ${PRISMA_RUNTIME_BASE}\n`) ||
    !applicationRecipe.replace(/\r\n/g, "\n").startsWith(normalized) ||
    normalized.split("\n").length !== 3 ||
    normalized.split("\n")[1] !==
      "RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \\" ||
    normalized.split("\n")[2] !== "    && rm -rf /var/lib/apt/lists/*"
  )
    throw new Error("prisma_runtime_docker_recipe_invalid");
}

export function prismaRuntimeCreateArguments({
  image,
  nonce,
  uid,
  gid,
  inputs,
  work,
  modules,
}) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image) ||
    !/^[a-f0-9]{24}$/.test(nonce) ||
    ![uid, gid].every((n) => Number.isInteger(n) && n > 0 && n < 2147483647) ||
    ![inputs, work, modules].every(
      (p) =>
        typeof p === "string" &&
        p.startsWith("/") &&
        p.length > 1 &&
        !/[\r\n,]/.test(p) &&
        !p.split("/").includes(".."),
    )
  )
    throw new Error("prisma_runtime_container_invalid");
  return [
    "create",
    "--name",
    `oja-prisma-runtime-${nonce}`,
    "--label",
    `oja.prisma-runtime=${nonce}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--user",
    `${uid}:${gid}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--env",
    "HOME=/work/home",
    "--mount",
    `type=bind,source=${inputs},target=/inputs,readonly`,
    "--mount",
    `type=bind,source=${modules},target=/work/node_modules,readonly`,
    "--mount",
    `type=bind,source=${work},target=/work`,
    "--workdir",
    "/work/project",
    "--entrypoint",
    "/usr/local/bin/node",
    image,
    "/inputs/runtime-probe.mjs",
  ];
}

export function verifyPrismaRuntimeContainer(inspect, expected) {
  const actual = inspect[0],
    host = actual?.HostConfig;
  if (
    inspect.length !== 1 ||
    actual.Id !== expected.container ||
    actual.Image !== expected.image ||
    actual.Name !== `/oja-prisma-runtime-${expected.nonce}` ||
    actual.Config?.Labels?.["oja.prisma-runtime"] !== expected.nonce ||
    actual.State?.ExitCode !== 0 ||
    actual.State.OOMKilled !== false ||
    host?.NetworkMode !== "none" ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    actual.Config.User !== `${expected.uid}:${expected.gid}` ||
    JSON.stringify(host.CapDrop) !== '["ALL"]' ||
    !host.SecurityOpt?.includes("no-new-privileges") ||
    host.PidsLimit !== 128 ||
    host.Memory !== 1073741824 ||
    host.NanoCpus !== 2000000000 ||
    host.Tmpfs?.["/tmp"] !== "rw,noexec,nosuid,nodev,size=64m" ||
    actual.Mounts?.length !== 3 ||
    ![
      ["inputs", "/inputs", false],
      ["modules", "/work/node_modules", false],
      ["work", "/work", true],
    ].every(
      ([key, destination, writable]) =>
        actual.Mounts.filter(
          (m) =>
            m.Type === "bind" &&
            m.Source === expected[key] &&
            m.Destination === destination &&
            m.RW === writable,
        ).length === 1,
    )
  )
    throw new Error("prisma_runtime_container_evidence_invalid");
  return actual;
}

export function verifyPrismaRuntimeReport(report, native, nodePolicy) {
  const keys = [
    "schemaVersion",
    "node",
    "os",
    "uid",
    "nodeOpenSsl",
    "systemOpenSsl",
    "systemPackages",
    "sharedLibraries",
    "ca",
    "schemaCliVersion",
    "native",
    "wholeEngineVerified",
    "productionApproved",
  ];
  if (
    !report ||
    Object.keys(report).sort().join() !== keys.sort().join() ||
    report.schemaVersion !== 1 ||
    report.wholeEngineVerified !== false ||
    report.productionApproved !== false ||
    !evaluateNodeRuntime(report.node, nodePolicy).ok ||
    report.node.platform !== "linux" ||
    report.node.arch !== "x64" ||
    JSON.stringify(report.os) !==
      JSON.stringify({
        id: "debian",
        versionId: "12",
        codename: "bookworm",
        glibc: "2.36",
      }) ||
    !Number.isInteger(report.uid) ||
    report.uid < 1 ||
    !/^3\./.test(report.nodeOpenSsl) ||
    !/^OpenSSL 3\./.test(report.systemOpenSsl) ||
    !/^[a-f0-9]{64}$/.test(report.ca?.sha256) ||
    !Number.isInteger(report.ca.bytes) ||
    report.ca.bytes < 1 ||
    !Array.isArray(report.sharedLibraries) ||
    report.sharedLibraries.length !== LIBRARIES.length ||
    !LIBRARIES.every(
      (name) =>
        report.sharedLibraries.filter(
          (l) => l.name === name && /^[a-f0-9]{64}$/.test(l.sha256),
        ).length === 1,
    ) ||
    !Array.isArray(report.systemPackages) ||
    report.systemPackages.length !== PACKAGES.length ||
    !PACKAGES.every(
      (name) =>
        report.systemPackages.filter(
          (p) =>
            p.name === name &&
            typeof p.version === "string" &&
            p.version.length > 0 &&
            ["amd64", "all"].includes(p.architecture),
        ).length === 1,
    ) ||
    typeof report.schemaCliVersion !== "string" ||
    !report.schemaCliVersion.includes(native.sourceCommit)
  )
    throw new Error("prisma_runtime_evidence_invalid");
  verifyPrismaNativeProbeReport(
    report.native,
    "sqlite",
    {
      library: { sha256: native.librarySha256 },
      schema: { sha256: native.schemaSha256 },
    },
    native.sourceCommit,
  );
  return report;
}

export async function testPrismaRuntime(root) {
  prismaRuntimeOptions([]);
  assertNodeRuntime();
  const native = selectDatabaseNativeInput(
    root,
    path.join(root, ".audit/database-native-input"),
  );
  const output = path.join(root, ".audit/prisma-runtime");
  fs.mkdirSync(output);
  const run = fs.mkdtempSync(path.join(output, "run-"));
  const privateRoot = path.join(root, ".audit/prisma-runtime-work");
  fs.mkdirSync(privateRoot);
  const work = fs.mkdtempSync(path.join(privateRoot, "run-"));
  const inputs = path.join(run, "inputs");
  fs.mkdirSync(inputs);
  for (const folder of ["home", "context", "project"])
    fs.mkdirSync(path.join(work, folder));
  const env = rustBuildEnvironment(work, path.join(work, "no-rust-toolchain"));
  const execute = (command, args, label, timeout = 60000) => {
    const result = spawnSync(command, args, {
      cwd: work,
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    fs.writeFileSync(
      path.join(run, `${label}.stdout.log`),
      result.stdout || "",
    );
    fs.writeFileSync(
      path.join(run, `${label}.stderr.log`),
      result.stderr || "",
    );
    if (result.error || result.status !== 0)
      throw new Error(`prisma_runtime_command_failed:${label}`);
    return result.stdout;
  };
  const bindings = [];
  for (const [source, destination] of [
    ["tests/fixtures/prisma/runtime-probe.mjs", "runtime-probe.mjs"],
    ["tests/fixtures/prisma/native-probe.mjs", "native-probe.mjs"],
    ["tests/fixtures/prisma/probe-cli-hook.cjs", "probe-cli-hook.cjs"],
    ["scripts/security/node-runtime.mjs", "scripts/security/node-runtime.mjs"],
    ["security/node-runtime.json", "security/node-runtime.json"],
  ]) {
    const original = path.join(root, source),
      target = path.join(inputs, destination);
    const stat = fs.lstatSync(original);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 256 * 1024
    )
      throw new Error("prisma_runtime_input_invalid");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL);
    bindings.push({
      path: source,
      destination,
      sha256: sha(fs.readFileSync(target)),
    });
  }
  for (const [role, name] of [
    ["library", "query_engine.node"],
    ["schema", "schema-engine"],
  ]) {
    const target = path.join(inputs, name);
    fs.copyFileSync(native[role], target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o755);
    if (sha(fs.readFileSync(target)) !== native[`${role}Sha256`])
      throw new Error("prisma_runtime_native_copy_invalid");
  }
  const fixture = prismaNativeFixture("sqlite"),
    project = path.join(work, "project");
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "oja-ephemeral-native-probe", private: true }),
  );
  fs.writeFileSync(
    path.join(project, "prisma.config.ts"),
    'export default { schema: "./schema.prisma" };\n',
  );
  fs.writeFileSync(path.join(project, ".env"), "");
  fs.writeFileSync(path.join(project, "schema.prisma"), fixture.schema);
  fs.mkdirSync(path.join(project, "migrations"));
  fs.writeFileSync(
    path.join(project, "migrations/migration_lock.toml"),
    'provider = "sqlite"\n',
  );
  for (const [name, sql] of fixture.migrations) {
    fs.mkdirSync(path.join(project, "migrations", name));
    fs.writeFileSync(
      path.join(project, "migrations", name, "migration.sql"),
      sql,
    );
  }
  const input = {
    provider: "sqlite",
    sourceCommit: native.sourceCommit,
    library: "/inputs/query_engine.node",
    schema: "/inputs/schema-engine",
    librarySha256: native.librarySha256,
    schemaSha256: native.schemaSha256,
    cli: "/work/node_modules/prisma/build/index.js",
    cliHook: "/inputs/probe-cli-hook.cjs",
    project: "/work/project",
  };
  fs.writeFileSync(
    path.join(inputs, "probe-input.json"),
    JSON.stringify(input),
  );
  const dockerfile = path.join(
      root,
      "tests/fixtures/prisma/runtime.Dockerfile",
    ),
    recipe = fs.readFileSync(dockerfile, "utf8");
  verifyPrismaRuntimeRecipe(
    recipe,
    fs.readFileSync(path.join(root, "Dockerfile"), "utf8"),
  );
  const nonce = crypto.randomBytes(12).toString("hex"),
    tag = `oja-prisma-runtime:${nonce}`;
  execute(
    "docker",
    [
      "build",
      "--pull",
      "--no-cache",
      "--file",
      dockerfile,
      "--tag",
      tag,
      path.join(work, "context"),
    ],
    "image-build",
    600000,
  );
  const image = JSON.parse(
    execute("docker", ["image", "inspect", tag], "image-inspect"),
  );
  if (
    image.length !== 1 ||
    image[0].Os !== "linux" ||
    image[0].Architecture !== "amd64" ||
    !/^sha256:[a-f0-9]{64}$/.test(image[0].Id)
  )
    throw new Error("prisma_runtime_image_invalid");
  const settings = {
    image: image[0].Id,
    nonce,
    uid: process.getuid(),
    gid: process.getgid(),
    inputs,
    work,
    modules: path.join(root, "node_modules"),
  };
  const arguments_ = prismaRuntimeCreateArguments(settings);
  const container = execute("docker", arguments_, "container-create").trim();
  if (!/^[a-f0-9]{64}$/.test(container))
    throw new Error("prisma_runtime_container_invalid");
  let report;
  try {
    const raw = execute(
      "docker",
      ["start", "--attach", container],
      "runtime",
      240000,
    );
    const inspect = JSON.parse(
      execute("docker", ["inspect", container], "container-inspect"),
    );
    verifyPrismaRuntimeContainer(inspect, { ...settings, container });
    report = JSON.parse(raw);
    verifyPrismaRuntimeReport(
      report,
      native,
      JSON.parse(
        fs.readFileSync(path.join(root, "security/node-runtime.json")),
      ),
    );
  } finally {
    try {
      execute("docker", ["rm", "--force", container], "container-remove");
    } finally {
      const files = [
        ...[
          "native-probe",
          "schema-version",
          "openssl-version",
          "system-packages",
        ].flatMap((name) =>
          ["stdout.log", "stderr.log"].map((suffix) => [
            path.join(work, `${name}.${suffix}`),
            `${name}.${suffix}`,
          ]),
        ),
        ...[
          "schema.prisma",
          "generate.log",
          "migrate-deploy.log",
          "schema-engine-invocations.jsonl",
        ].map((name) => [path.join(project, name), name]),
      ];
      // Preserve only known synthetic logs on failure, never generated clients or DB files.
      for (const [source, name] of files) {
        if (!fs.existsSync(source)) continue;
        const stat = fs.lstatSync(source);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 16 * 1024 * 1024
        )
          throw new Error("prisma_runtime_log_invalid");
        fs.copyFileSync(
          source,
          path.join(run, name),
          fs.constants.COPYFILE_EXCL,
        );
      }
    }
  }
  for (const name of [
    "native-probe",
    "schema-version",
    "openssl-version",
    "system-packages",
  ])
    for (const suffix of ["stdout.log", "stderr.log"])
      if (!fs.existsSync(path.join(run, `${name}.${suffix}`)))
        throw new Error("prisma_runtime_log_missing");
  for (const name of [
    "schema.prisma",
    "generate.log",
    "migrate-deploy.log",
    "schema-engine-invocations.jsonl",
  ])
    if (!fs.existsSync(path.join(run, name)))
      throw new Error("prisma_runtime_log_missing");
  for (const binding of bindings)
    if (sha(fs.readFileSync(path.join(root, binding.path))) !== binding.sha256)
      throw new Error("prisma_runtime_input_changed");
  const receipt = {
    nativeInput: DATABASE_NATIVE_INPUT,
    native,
    baseImage: PRISMA_RUNTIME_BASE,
    builtImage: image[0].Id,
    container,
    bindings,
    dockerfileSha256: sha(Buffer.from(recipe)),
    orchestratorSha256: sha(fs.readFileSync(new URL(import.meta.url))),
    workflowSha256: sha(
      fs.readFileSync(
        path.join(root, ".github/workflows/prisma-runtime-compatibility.yml"),
      ),
    ),
    report,
    wholeEngineVerified: false,
    productionApproved: false,
    scope:
      "isolated Debian12 runtime ABI/client/SQLite only; not Render process, live TLS/PG, system security review, production image or whole-source approval",
  };
  fs.writeFileSync(
    path.join(run, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  return { run, report, wholeEngineVerified: false, productionApproved: false };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    prismaRuntimeOptions(process.argv.slice(2));
    console.log(JSON.stringify(await testPrismaRuntime(ROOT)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
