import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  rustBuildEnvironment,
  checkRustSourceTree,
} from "./rust-toolchain.mjs";
import { readPrismaTlsLab } from "./prisma-tls-lab.mjs";
import {
  DATABASE_NATIVE_INPUT,
  POOLER_SOURCE,
  sha,
  databaseCompatibilityOptions,
  applicationDatabaseInputs,
  selectDatabaseNativeInput,
  prepareApplicationProject,
  poolerConfiguration,
  verifyDatabaseCompatibilityReport,
} from "./database-compatibility.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function listening(port, process) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null)
      throw new Error("database_pooler_exited_before_probe");
    const ready = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(100);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("database_pooler_unavailable");
}

export async function testDatabaseCompatibility(root, postgresPort) {
  databaseCompatibilityOptions(["--postgres-port", String(postgresPort)]);
  const native = selectDatabaseNativeInput(
    root,
    path.join(root, ".audit/database-native-input"),
  );
  const tls = readPrismaTlsLab(root);
  const output = path.join(root, ".audit/database-compatibility");
  fs.mkdirSync(output);
  const work = fs.mkdtempSync(path.join(output, "run-"));
  fs.mkdirSync(path.join(work, "certificates"));
  for (const role of ["ca", "server", "untrustedCa"]) {
    const file = path.join(work, "certificates", `${role}.crt`);
    fs.copyFileSync(tls[`${role}File`], file, fs.constants.COPYFILE_EXCL);
    if (sha(fs.readFileSync(file)) !== tls[`${role}Sha256`])
      throw new Error("database_tls_copy_invalid");
    tls[`${role}File`] = file;
  }
  const env = rustBuildEnvironment(work, path.join(work, "no-rust-toolchain"));
  const execute = (command, args, cwd, label, timeout = 120000) => {
    const r = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    fs.writeFileSync(path.join(work, `${label}.stdout.log`), r.stdout || "");
    fs.writeFileSync(path.join(work, `${label}.stderr.log`), r.stderr || "");
    if (r.error || r.status !== 0)
      throw new Error(`database_compatibility_command_failed:${label}`);
    return r.stdout;
  };
  const inputs = applicationDatabaseInputs(root);
  fs.writeFileSync(
    path.join(work, "application-inputs.json"),
    JSON.stringify(inputs, null, 2),
  );
  for (const [role, name] of [
    ["library", "query_engine.node"],
    ["schema", "schema-engine"],
  ]) {
    const file = path.join(work, name);
    fs.copyFileSync(native[role], file, fs.constants.COPYFILE_EXCL);
    if (sha(fs.readFileSync(file)) !== native[`${role}Sha256`])
      throw new Error("database_native_copy_invalid");
    native[role] = file;
  }
  fs.chmodSync(native.schema, 0o755);
  const lab = path.join(root, ".audit/database-pooler-build");
  fs.mkdirSync(lab);
  const response = await fetch(POOLER_SOURCE.url, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error("database_pooler_download_failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024)
      throw new Error("database_pooler_download_limit");
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  if (sha(archive) !== POOLER_SOURCE.sha256)
    throw new Error("database_pooler_archive_invalid");
  fs.writeFileSync(path.join(lab, "source.tar.gz"), archive, { flag: "wx" });
  const listing = execute(
    "tar",
    ["-tzf", path.join(lab, "source.tar.gz")],
    lab,
    "pooler-archive-list",
  )
    .trim()
    .split(/\r?\n/);
  if (
    !listing.every(
      (name) =>
        name.startsWith(`pgbouncer-${POOLER_SOURCE.version}/`) &&
        !name.split("/").includes("..") &&
        !name.includes("\\"),
    )
  )
    throw new Error("database_pooler_archive_path_invalid");
  execute(
    "tar",
    ["-xzf", path.join(lab, "source.tar.gz"), "-C", lab],
    lab,
    "pooler-extract",
  );
  const source = path.join(lab, `pgbouncer-${POOLER_SOURCE.version}`);
  checkRustSourceTree(source);
  execute(
    path.join(source, "configure"),
    ["--with-openssl", "--without-cares"],
    source,
    "pooler-configure",
  );
  execute("make", ["-j2", "pgbouncer"], source, "pooler-build");
  const binary = path.join(work, "pgbouncer");
  fs.copyFileSync(
    path.join(source, "pgbouncer"),
    binary,
    fs.constants.COPYFILE_EXCL,
  );
  fs.chmodSync(binary, 0o755);
  const version = execute(binary, ["--version"], work, "pooler-version");
  if (
    !version.startsWith(`PgBouncer ${POOLER_SOURCE.version}\n`) ||
    !version.includes("OpenSSL")
  )
    throw new Error("database_pooler_version_invalid");
  fs.writeFileSync(
    path.join(work, "pooler-build-input.json"),
    JSON.stringify({
      ...POOLER_SOURCE,
      binarySha256: sha(fs.readFileSync(binary)),
      version,
    }),
  );
  prepareApplicationProject(root, path.join(work, "application"), inputs);
  prepareApplicationProject(root, path.join(work, "old-history"), inputs, true);
  fs.writeFileSync(
    path.join(root, ".audit/prisma-tls-lab/pooler-users.txt"),
    '"oja_probe" "oja-ephemeral-test-only"\n',
    { flag: "wx", mode: 0o600 },
  );
  const children = [],
    poolers = [];
  try {
    for (const prepared of [false, true]) {
      const directory = path.join(
        work,
        prepared ? "prepared" : "compatibility",
      );
      fs.mkdirSync(directory);
      const port = await availablePort(),
        config = poolerConfiguration({
          directory,
          tlsDirectory: path.join(root, ".audit/prisma-tls-lab"),
          postgresPort,
          port,
          prepared,
        });
      const file = path.join(directory, "pgbouncer.ini");
      fs.writeFileSync(file, config);
      const log = fs.openSync(path.join(directory, "process.log"), "w");
      const child = spawn(binary, [file], {
        cwd: directory,
        env,
        stdio: ["ignore", log, log],
      });
      fs.closeSync(log);
      children.push(child);
      await listening(port, child);
      poolers.push({
        mode: prepared ? "prepared" : "compatibility",
        port,
        prepared,
        configSha256: sha(Buffer.from(config)),
      });
    }
    const input = {
      ...native,
      root,
      project: path.join(work, "application"),
      historyProject: path.join(work, "old-history"),
      inputs,
      postgresPort,
      tls,
      poolers,
      cli: path.join(root, "node_modules/prisma/build/index.js"),
      cliHook: path.join(root, "tests/fixtures/prisma/probe-cli-hook.cjs"),
    };
    const file = path.join(work, "probe-input.json");
    fs.writeFileSync(file, JSON.stringify(input));
    const script = path.join(
      root,
      "tests/fixtures/database/compatibility-probe.mjs",
    );
    const report = JSON.parse(
      execute(
        process.execPath,
        [script, file],
        input.project,
        "database-probe",
        240000,
      ),
    );
    verifyDatabaseCompatibilityReport(report, inputs, native);
    if (
      JSON.stringify(applicationDatabaseInputs(root)) !== JSON.stringify(inputs)
    )
      throw new Error("application_database_input_changed");
    const receipt = {
      nativeInput: DATABASE_NATIVE_INPUT,
      native,
      applicationInputs: inputs,
      pooler: { ...POOLER_SOURCE, binarySha256: sha(fs.readFileSync(binary)) },
      poolers,
      report,
      scriptSha256: sha(fs.readFileSync(script)),
      orchestratorSha256: sha(fs.readFileSync(new URL(import.meta.url))),
      contractSha256: sha(
        fs.readFileSync(
          path.join(root, "scripts/security/database-compatibility.mjs"),
        ),
      ),
      workflowSha256: sha(
        fs.readFileSync(
          path.join(root, ".github/workflows/database-compatibility.yml"),
        ),
      ),
      productionApproved: false,
      wholeEngineVerified: false,
      scope:
        "CI loopback/synthetic current-branch schema/migrations and PgBouncer only; not production migration or application/provider approval",
    };
    fs.writeFileSync(
      path.join(work, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    return { work, report, productionApproved: false };
  } finally {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("database_pooler_cleanup_timeout"));
        }, 10000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        await testDatabaseCompatibility(
          ROOT,
          databaseCompatibilityOptions(process.argv.slice(2)),
        ),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
