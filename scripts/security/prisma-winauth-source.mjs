import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { downloadRustInput, checkRustSourceTree } from "./rust-toolchain.mjs";

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const TIBERIUS =
  "git+https://github.com/prisma/tiberius?branch=main#35605c90adb38cc107d35c3432fd2643d9d6e1e6";
const FILES = [
  "Cargo.toml",
  "Cargo.toml.orig",
  "src/lib.rs",
  "src/windows.rs",
  "src/md4.rs",
  "src/hmac.rs",
  "src/rc4.rs",
  "src/http/mod.rs",
  "src/oja_security_contracts.rs",
  "src/oja_parser_contracts.rs",
];
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const hash = (value) => /^[a-f0-9]{64}$/.test(value || "");

export function validatePrismaWinauthSource(entry) {
  if (
    !exact(entry, [
      "name",
      "upstreamVersion",
      "version",
      "sha256",
      "patch",
      "sourceFiles",
      "randVersion",
    ]) ||
    entry.name !== "winauth" ||
    entry.upstreamVersion !== "0.0.5" ||
    entry.version !== "0.0.5+oja.2" ||
    entry.randVersion !== "0.8.8" ||
    entry.sha256 !==
      "0e03c9d0fde636447315ff38695b14c85c6ccc738ade05a400a3ce568a557021" ||
    !exact(entry.patch, ["path", "sha256"]) ||
    entry.patch.path !== "vendor/native/prisma/winauth.patch" ||
    !hash(entry.patch.sha256) ||
    !Array.isArray(entry.sourceFiles) ||
    entry.sourceFiles.length !== FILES.length ||
    entry.sourceFiles.some(
      (file, i) =>
        !exact(file, ["path", "sha256"]) ||
        file.path !== FILES[i] ||
        !hash(file.sha256),
    )
  )
    throw new Error("prisma_winauth_policy_invalid");
  return entry;
}

export async function preparePrismaWinauthSource(
  root,
  source,
  cache,
  entry,
  execute,
  input,
) {
  input(root, entry.patch);
  const name = `${entry.name}-${entry.upstreamVersion}`;
  const archive = path.join(cache, `${name}.crate`);
  await downloadRustInput(
    `https://static.crates.io/crates/winauth/${name}.crate`,
    archive,
    entry.sha256,
  );
  const vendor = path.join(source, "vendor");
  const unpacked = path.join(vendor, name);
  const target = path.join(vendor, entry.name);
  if (fs.existsSync(unpacked) || fs.existsSync(target))
    throw new Error("prisma_winauth_source_exists");
  execute("tar", ["-xf", archive, "-C", vendor], root, "winauth-extract");
  checkRustSourceTree(unpacked);
  // Both fixed paths belong to this run's fresh private extraction directory.
  fs.renameSync(unpacked, target);
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
      check ? "winauth-patch-check" : "winauth-patch",
    );
}

export function checkPrismaWinauthWiring(source, entry, input) {
  const vendor = path.join(source, "vendor/winauth");
  for (const file of entry.sourceFiles) input(vendor, file);
  const read = (file) =>
    toml.parse(fs.readFileSync(path.join(source, file), "utf8"));
  const workspace = read("Cargo.toml");
  const contract = read("security-contracts/Cargo.toml");
  const manifest = read("vendor/winauth/Cargo.toml");
  const quaint = read("quaint/Cargo.toml");
  if (
    workspace.patch?.["crates-io"]?.winauth?.path !== "vendor/winauth" ||
    !workspace.workspace.exclude?.includes("vendor/winauth") ||
    contract.dependencies.winauth?.path !== "../vendor/winauth" ||
    contract.dependencies.winauth?.features?.join() !==
      "oja-security-contracts" ||
    manifest.package.name !== entry.name ||
    manifest.package.version !== entry.version ||
    manifest.package.license !== "MIT/Apache-2.0" ||
    manifest.dependencies.rand?.version !== `=${entry.randVersion}` ||
    manifest.dependencies.rand["default-features"] === false ||
    !Array.isArray(manifest.features?.["oja-security-contracts"]) ||
    manifest.features["oja-security-contracts"].length ||
    manifest.features.default?.includes("oja-security-contracts") ||
    !["winerror", "sspi"].every((feature) =>
      manifest.target?.["cfg(windows)"].dependencies.winapi.features.includes(
        feature,
      ),
    ) ||
    !Object.values(quaint.target)
      .filter((target) => target.dependencies?.tiberius)
      .every((target) =>
        ["winauth", "bigdecimal", "tds73"].every((feature) =>
          target.dependencies.tiberius.features.includes(feature),
        ),
      ) ||
    Object.values(quaint.target).filter(
      (target) => target.dependencies?.tiberius,
    ).length !== 2 ||
    !fs
      .readFileSync(path.join(vendor, "src/lib.rs"), "utf8")
      .includes(
        '#[cfg(feature = "oja-security-contracts")]\npub mod oja_security_contracts;',
      ) ||
    !fs
      .readFileSync(path.join(vendor, "src/lib.rs"), "utf8")
      .includes(
        '#[cfg(feature = "oja-security-contracts")]\npub mod oja_parser_contracts;',
      ) ||
    !fs
      .readFileSync(path.join(source, "security-contracts/src/lib.rs"), "utf8")
      .includes("#[cfg(test)]\nmod winauth_contracts;") ||
    !fs
      .readFileSync(path.join(source, "security-contracts/src/lib.rs"), "utf8")
      .includes("#[cfg(test)]\nmod winauth_parser_contracts;")
  )
    throw new Error("prisma_winauth_wiring_invalid");
  return true;
}

export function checkPrismaWinauthMetadata(
  metadata,
  source,
  entry,
  { contracts = false, target = "x86_64-unknown-linux-gnu" } = {},
) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const matches = metadata.packages.filter((pkg) => pkg.name === "winauth");
  const windows = target.includes("windows");
  if (contracts || windows) {
    const pkg = matches[0];
    const node = nodes.get(pkg?.id);
    const rand = packages.get(
      node?.deps.find((dep) => dep.name === "rand")?.pkg,
    );
    if (
      matches.length !== 1 ||
      pkg.source ||
      pkg.version !== entry.version ||
      path.dirname(fs.realpathSync(pkg.manifest_path)) !==
        path.join(fs.realpathSync(source), "vendor/winauth") ||
      Boolean(node?.features?.includes("oja-security-contracts")) !==
        contracts ||
      rand?.name !== "rand" ||
      rand.version !== entry.randVersion ||
      rand.source !== REGISTRY ||
      !["std", "std_rng"].every((feature) =>
        nodes.get(rand.id)?.features?.includes(feature),
      )
    )
      throw new Error("prisma_winauth_resolution_invalid");
    if (windows) {
      const api = packages.get(
        node.deps.find((dep) => dep.name === "winapi")?.pkg,
      );
      if (
        api?.name !== "winapi" ||
        api.source !== REGISTRY ||
        !["sspi", "winerror"].every((f) =>
          nodes.get(api.id)?.features?.includes(f),
        )
      )
        throw new Error("prisma_winauth_windows_resolution_invalid");
    }
    if (
      contracts &&
      nodes
        .get(
          metadata.packages.find(
            (pkg) => pkg.name === "oja-prisma-source-contracts",
          )?.id,
        )
        ?.deps.find((dep) => dep.name === "winauth")?.pkg !== pkg.id
    )
      throw new Error("prisma_winauth_consumer_unbound");
  } else if (matches.length) {
    throw new Error("prisma_winauth_unexpected_target");
  }
  if (!contracts) {
    const drivers = metadata.packages.filter((pkg) => pkg.name === "tiberius");
    const driver = drivers[0];
    const node = nodes.get(driver?.id);
    if (
      drivers.length !== 1 ||
      driver.version !== "0.13.0" ||
      driver.source !== TIBERIUS ||
      !["winauth", "native-tls", "bigdecimal", "tds73"].every((f) =>
        node?.features?.includes(f),
      ) ||
      (windows &&
        node.deps.find((dep) => dep.name === "winauth")?.pkg !== matches[0]?.id)
    )
      throw new Error("prisma_winauth_consumer_unbound");
  }
  if (
    metadata.packages.some(
      (pkg) => pkg.name === "rand" && pkg.version.startsWith("0.7."),
    )
  )
    throw new Error("prisma_winauth_legacy_rand");
  return true;
}
