import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import toml from "toml";
import { downloadRustInput, checkRustSourceTree } from "./rust-toolchain.mjs";
import { scanRustLockfile } from "./rust-source-audit.mjs";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const ARCHIVE =
  "2e99fb7a497b1e3339bc746195567ed8d3e24945ecd636e3619d20b9de9e9149";
const ADVISORY = "RUSTSEC-2026-0459";
const HASH = /^[a-f0-9]{64}$/;
const canonicalJson = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function validatePrismaSqliteSource(entry) {
  if (
    !exact(entry, [
      "name",
      "version",
      "sha256",
      "patch",
      "advisory",
      "sourceFiles",
      "harness",
      "buildScript",
      "contractLock",
    ]) ||
    entry.name !== "libsqlite3-sys" ||
    entry.version !== "0.30.1" ||
    entry.sha256 !== ARCHIVE ||
    !exact(entry.advisory, ["id", "modified", "sha256"]) ||
    entry.advisory.id !== ADVISORY ||
    entry.advisory.modified !== "2026-11-09T10:00:02.337112Z" ||
    entry.advisory.sha256 !==
      "6047853b50b8b7aecca35c309372acb2f44a462f59c5818e046e9088a3e1ab6e" ||
    !Array.isArray(entry.sourceFiles) ||
    entry.sourceFiles.length !== 27 ||
    new Set(entry.sourceFiles.map((f) => f.path)).size !== 27
  )
    throw new Error("prisma_sqlite_policy_invalid");
  for (const [key, file] of [
    ["patch", "vendor/native/prisma/sqlite-wal.candidate.patch"],
    ["harness", "tests/fixtures/prisma/sqlite-wal.c"],
    ["buildScript", "tests/fixtures/prisma/sqlite-wal-build.rs"],
    ["contractLock", "vendor/native/prisma/sqlite-contracts.Cargo.lock"],
  ])
    if (
      !exact(entry[key], ["path", "sha256"]) ||
      entry[key].path !== file ||
      !HASH.test(entry[key].sha256 || "")
    )
      throw new Error("prisma_sqlite_policy_invalid");
  for (const file of entry.sourceFiles) {
    if (
      !exact(file, ["path", "originalSha256", "sha256"]) ||
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file.path) ||
      file.path.split("/").some((p) => p === "." || p === "..") ||
      !HASH.test(file.originalSha256 || "") ||
      !HASH.test(file.sha256 || "") ||
      (file.path !== "sqlite3/sqlite3.c" && file.sha256 !== file.originalSha256)
    )
      throw new Error("prisma_sqlite_policy_invalid");
  }
  const c = entry.sourceFiles.find((f) => f.path === "sqlite3/sqlite3.c");
  if (
    c?.originalSha256 !==
      "c01235302fe80da901fb70c7622c39147e29d9f29b7f6eb746b23517f320c90d" ||
    c.sha256 === c.originalSha256
  )
    throw new Error("prisma_sqlite_policy_invalid");
  return entry;
}

function read(file, expected, limit = 12 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit ||
    fs.realpathSync(file) !== file
  )
    throw new Error("prisma_sqlite_source_invalid");
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== expected) throw new Error("prisma_sqlite_source_changed");
  return bytes;
}

export function sqliteWalFunction(source) {
  const signature = "SQLITE_PRIVATE int sqlite3WalReadFrame(";
  const positions = [
    ...source.matchAll(/SQLITE_PRIVATE int sqlite3WalReadFrame\(/g),
  ].map((m) => m.index);
  if (positions.length !== 2) throw new Error("prisma_sqlite_function_changed");
  const start = positions[1],
    end = source.indexOf("\n}", start);
  if (end < 0 || end - start > 2000)
    throw new Error("prisma_sqlite_function_changed");
  const text = source.slice(start, end + 2) + "\n";
  if (!text.startsWith(signature))
    throw new Error("prisma_sqlite_function_changed");
  return text;
}

function inventory(base) {
  checkRustSourceTree(base);
  const files = [];
  const walk = (dir, prefix = "") => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isDirectory()) walk(path.join(dir, item.name), relative + "/");
      else files.push(relative);
    }
  };
  walk(base);
  return files.sort();
}

export function checkPrismaSqliteWiring(source, entry) {
  validatePrismaSqliteSource(entry);
  const base = path.join(source, "vendor/libsqlite3-sys");
  if (
    inventory(base).join() !==
    entry.sourceFiles
      .map((f) => f.path)
      .sort()
      .join()
  )
    throw new Error("prisma_sqlite_inventory_changed");
  for (const file of entry.sourceFiles)
    read(path.join(base, file.path), file.sha256);
  const manifest = toml.parse(
    fs.readFileSync(path.join(source, "Cargo.toml"), "utf8"),
  );
  const crate = toml.parse(
    fs.readFileSync(path.join(base, "Cargo.toml"), "utf8"),
  );
  if (
    manifest.patch?.["crates-io"]?.[entry.name]?.path !==
      "vendor/libsqlite3-sys" ||
    !manifest.workspace.exclude?.includes("vendor/libsqlite3-sys") ||
    crate.package.name !== entry.name ||
    crate.package.version !== entry.version
  )
    throw new Error("prisma_sqlite_wiring_invalid");
  return true;
}

export function checkPrismaSqliteMetadata(
  metadata,
  source,
  entry,
  { contracts = false } = {},
) {
  const packages = metadata.packages.filter((p) => p.name === entry.name);
  if (contracts && packages.length === 0) return true;
  const pkg = packages[0],
    node = metadata.resolve.nodes.find((n) => n.id === pkg?.id);
  if (
    packages.length !== 1 ||
    pkg.source ||
    pkg.version !== entry.version ||
    fs.realpathSync(pkg.manifest_path) !==
      path.join(source, "vendor/libsqlite3-sys/Cargo.toml") ||
    !node?.features?.includes("bundled") ||
    node.features.some((f) => /sqlcipher|loadable_extension|in_gecko/.test(f))
  )
    throw new Error("prisma_sqlite_resolution_invalid");
  return true;
}

export async function assessPrismaSqliteIdentity(
  entry,
  { fetchImpl = fetch } = {},
) {
  validatePrismaSqliteSource(entry);
  const lock = `[[package]]\nname = "${entry.name}"\nversion = "${entry.version}"\nsource = "${REGISTRY}"\nchecksum = "${entry.sha256}"\n`;
  const report = await scanRustLockfile(lock, { fetchImpl });
  if (
    report.findings.length !== 1 ||
    report.findings[0].advisory !== ADVISORY ||
    report.findings[0].modified !== entry.advisory.modified
  )
    throw new Error("prisma_sqlite_advisory_changed");
  const response = await fetchImpl(`https://api.osv.dev/v1/vulns/${ADVISORY}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("prisma_sqlite_advisory_unavailable");
  const bytes = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("prisma_sqlite_advisory_limit");
    bytes.push(chunk);
  }
  const advisory = JSON.parse(Buffer.concat(bytes).toString("utf8"));
  if (
    advisory.id !== ADVISORY ||
    advisory.modified !== "2026-11-09T10:00:02.337112425Z" ||
    sha(canonicalJson(advisory)) !==
      "775268f2214d68fbda497ec20183114be74804b2a0f58475705743ec0c47fc58"
  )
    throw new Error("prisma_sqlite_advisory_changed");
  return {
    ...report,
    advisory,
    parsedAdvisorySha256: sha(JSON.stringify(advisory)),
    canonicalAdvisorySha256: sha(canonicalJson(advisory)),
    disposition: "EXACT_C_BACKPORT_REQUIRES_COMPILED_REGRESSION",
    sourceAuditOk: false,
    productionApproved: false,
  };
}

export async function preparePrismaSqliteSource(
  root,
  source,
  cache,
  entry,
  execute,
) {
  validatePrismaSqliteSource(entry);
  const archive = path.join(cache, "libsqlite3-sys-0.30.1.crate");
  await downloadRustInput(
    "https://static.crates.io/crates/libsqlite3-sys/libsqlite3-sys-0.30.1.crate",
    archive,
    entry.sha256,
  );
  const vendor = path.join(source, "vendor"),
    prefix = "libsqlite3-sys-0.30.1";
  const names = execute("tar", ["-tf", archive], root, "sqlite-archive-names")
    .trim()
    .split(/\r?\n/);
  const types = execute("tar", ["-tvf", archive], root, "sqlite-archive-types")
    .trim()
    .split(/\r?\n/);
  if (
    names.length !== 27 ||
    new Set(names.map((n) => n.toLowerCase())).size !== 27 ||
    names.some(
      (n) =>
        !n.startsWith(prefix + "/") ||
        n.includes("\\") ||
        n.includes(":") ||
        n.split("/").some((p) => p === ".." || p === "."),
    ) ||
    types.length !== names.length ||
    types.some((line) => !line.startsWith("-"))
  )
    throw new Error("prisma_sqlite_archive_invalid");
  const target = path.join(vendor, entry.name);
  if (fs.existsSync(target) || fs.existsSync(path.join(vendor, prefix)))
    throw new Error("prisma_sqlite_source_exists");
  execute("tar", ["-xf", archive, "-C", vendor], root, "sqlite-extract");
  fs.renameSync(path.join(vendor, prefix), target);
  if (
    inventory(target).join() !==
    entry.sourceFiles
      .map((f) => f.path)
      .sort()
      .join()
  )
    throw new Error("prisma_sqlite_inventory_changed");
  for (const file of entry.sourceFiles)
    read(path.join(target, file.path), file.originalSha256);
  const original = sqliteWalFunction(
    fs.readFileSync(path.join(target, "sqlite3/sqlite3.c"), "utf8"),
  );
  read(path.join(root, entry.patch.path), entry.patch.sha256);
  for (const check of [true, false])
    execute(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "apply",
        ...(check ? ["--check"] : []),
        path.join(root, entry.patch.path),
      ],
      target,
      `sqlite-patch-${check}`,
    );
  for (const file of entry.sourceFiles)
    read(path.join(target, file.path), file.sha256);
  const fixed = sqliteWalFunction(
    fs.readFileSync(path.join(target, "sqlite3/sqlite3.c"), "utf8"),
  );
  return { original, fixed };
}

export function runPrismaSqliteContracts(
  root,
  run,
  entry,
  functions,
  cargo,
  execute,
) {
  const directory = path.join(run, "sqlite-wal-contracts");
  fs.mkdirSync(directory);
  const template = read(
    path.join(root, entry.harness.path),
    entry.harness.sha256,
  ).toString("utf8");
  for (const marker of ["@ORIGINAL_FUNCTION@", "@FIXED_FUNCTION@"])
    if (template.split(marker).length !== 2)
      throw new Error("prisma_sqlite_harness_invalid");
  const harness = template
    .replace(
      "@ORIGINAL_FUNCTION@",
      functions.original.replace(
        "sqlite3WalReadFrame(",
        "originalWalReadFrame(",
      ),
    )
    .replace(
      "@FIXED_FUNCTION@",
      functions.fixed.replace("sqlite3WalReadFrame(", "fixedWalReadFrame("),
    );
  fs.writeFileSync(path.join(directory, "wal-contract.c"), harness, {
    flag: "wx",
  });
  fs.writeFileSync(
    path.join(directory, "build.rs"),
    read(path.join(root, entry.buildScript.path), entry.buildScript.sha256),
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(directory, "Cargo.lock"),
    read(path.join(root, entry.contractLock.path), entry.contractLock.sha256),
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(directory, "Cargo.toml"),
    '[package]\nname = "oja-sqlite-wal-contracts"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[build-dependencies]\ncc = { version = "=1.10.0", default-features = false }\n',
    { flag: "wx" },
  );
  fs.mkdirSync(path.join(directory, "src"));
  fs.writeFileSync(
    path.join(directory, "src/main.rs"),
    'fn main() { println!("{}", env!("WAL_CONTRACT_OUTPUT")); }\n',
    { flag: "wx" },
  );
  const output = execute(
    cargo,
    ["run", "--locked", "--manifest-path", path.join(directory, "Cargo.toml")],
    directory,
    "sqlite-wal-contracts",
    600000,
  ).replace(/\r\n/g, "\n");
  if (
    output !== "sqlite-wal-cases 72 baseline-stale-tail 24 fixed-zero-tail 24\n"
  )
    throw new Error("prisma_sqlite_contracts_incomplete");
  const binary = path.join(
    directory,
    process.platform === "win32" ? "wal-contract.exe" : "wal-contract",
  );
  const actual = execute(
    binary,
    [],
    directory,
    "sqlite-wal-c-execution",
  ).replace(/\r\n/g, "\n");
  if (
    actual !== output ||
    sha(fs.readFileSync(path.join(directory, "Cargo.lock"))) !==
      entry.contractLock.sha256
  )
    throw new Error("prisma_sqlite_contracts_incomplete");
  const compiler = fs.readFileSync(
    path.join(directory, "compiler-path.txt"),
    "utf8",
  );
  return {
    cases: 72,
    actualFunctionInvocationsPerExecution: 144,
    baselineStaleTail: 24,
    fixedZeroTail: 24,
    originalFunctionSha256: sha(functions.original),
    fixedFunctionSha256: sha(functions.fixed),
    generatedHarnessSha256: sha(harness),
    binarySha256: sha(fs.readFileSync(binary)),
    compilerPath: compiler,
    compilerCommandSha256: sha(
      fs.readFileSync(path.join(directory, "compiler-command.txt")),
    ),
    scope:
      "actual source functions with bounded mocked IO; not a whole SQLite or production security approval",
  };
}
