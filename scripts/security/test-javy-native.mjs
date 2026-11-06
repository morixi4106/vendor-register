import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import toml from "toml";
import { checkedNativeDirectory } from "./rebuild-esbuild.mjs";
import { downloadRustInput, checkRustSourceTree } from "./rust-toolchain.mjs";
import {
  prepareJavySource,
  checkPreparedJavySource,
} from "./test-javy-source.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const SDK_URL =
  "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz";
const PROVIDER_URL =
  "https://cdn.shopify.com/shopifycloud/shopify-functions-javy-plugin/shopify_functions_javy_v4.wasm";
const PLUGINS = ["plugin.wasm", "javy_profiler_lib.wasm"];
const exact = (p, names) =>
  p &&
  typeof p === "object" &&
  !Array.isArray(p) &&
  Object.keys(p).sort().join() === [...names].sort().join();

export function validateJavyNativePolicy(p) {
  if (
    !exact(p, [
      "schemaVersion",
      "role",
      "sourcePolicySha256",
      "rustStd",
      "wasiSdk",
      "shopifyProvider",
    ]) ||
    p.schemaVersion !== 1 ||
    p.role !== "javy-native-lab" ||
    p.sourcePolicySha256 !==
      "da7b84f7d69b985766b1256f0e56dce65e10a69c0e7198c94ece3a70cbe01de7" ||
    !exact(p.rustStd, ["version", "date", "target", "sha256"]) ||
    p.rustStd.version !== "1.99.1" ||
    p.rustStd.date !== "2026-10-15" ||
    p.rustStd.target !== "wasm32-wasip1" ||
    p.rustStd.sha256 !==
      "d498fbff3fd032f2f5fabc299e5cbf7bc9d64abac6e389fc1a315b69821b48c4" ||
    !exact(p.wasiSdk, ["version", "archive", "size", "sha256"]) ||
    p.wasiSdk.version !== "34.0" ||
    p.wasiSdk.archive !== "wasi-sdk-34.0-x86_64-linux.tar.gz" ||
    p.wasiSdk.size !== 192383077 ||
    p.wasiSdk.sha256 !==
      "b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4" ||
    !exact(p.shopifyProvider, [
      "version",
      "url",
      "size",
      "sha256",
      "namespace",
    ]) ||
    p.shopifyProvider.version !== 4 ||
    p.shopifyProvider.url !== PROVIDER_URL ||
    p.shopifyProvider.size !== 1233749 ||
    p.shopifyProvider.sha256 !==
      "b1b5f0d38cb5cd1692fa027db8186b73c3673cacd337bf3d6ee8cf16cac70087" ||
    p.shopifyProvider.namespace !== "shopify_functions_javy_v4"
  )
    throw new Error("javy_native_policy_invalid");
  return p;
}

export function javyNativeStage(
  args,
  env = process.env,
  platform = process.platform,
) {
  if (
    args.length !== 1 ||
    !["plugin", "native"].includes(args[0]) ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    !["linux", "win32"].includes(platform) ||
    (args[0] === "plugin" && platform !== "linux")
  )
    throw new Error("javy_native_ci_only");
  return args[0];
}

export function javyNativePlans(stage) {
  if (stage === "plugin")
    return [
      [
        "build",
        "--locked",
        "--release",
        "--target",
        "wasm32-wasip1",
        "--package",
        "javy-plugin",
        "--package",
        "javy-profiler-lib",
      ],
    ];
  if (stage === "native")
    return [
      [
        "build",
        "--locked",
        "--release",
        "--package",
        "javy-cli",
        "--features",
        "profiler",
      ],
    ];
  throw new Error("javy_native_stage_invalid");
}

export function observeJavyWasm(bytes, role) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 100 ||
    bytes.length > 16 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  )
    throw new Error("javy_native_wasm_invalid");
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module);
  const namespace = WebAssembly.Module.customSections(
    module,
    "import_namespace",
  ).map((s) => new TextDecoder("utf8", { fatal: true }).decode(s));
  const names = exports.map((e) => e.name);
  if (["plugin", "provider"].includes(role)) {
    if (
      namespace.length !== 1 ||
      namespace[0] !==
        (role === "plugin"
          ? "javy-default-plugin-v5"
          : "shopify_functions_javy_v4") ||
      ["memory", "initialize-runtime", "compile-src", "invoke"].some(
        (n) => !names.includes(n),
      )
    )
      throw new Error("javy_native_plugin_invalid");
  } else if (role === "profiler") {
    if (!["memory", "wizer.initialize"].every((n) => names.includes(n)))
      throw new Error("javy_native_profiler_invalid");
  } else if (
    !["static", "dynamic", "shopify"].includes(role) ||
    !names.includes("_start")
  )
    throw new Error("javy_native_module_invalid");
  const allowed =
    role === "dynamic"
      ? "javy-default-plugin-v5"
      : role === "shopify"
        ? "shopify_functions_javy_v4"
        : "wasi_snapshot_preview1";
  if (
    imports.some(
      (i) => i.module !== allowed && i.module !== "wasi_snapshot_preview1",
    ) ||
    (["dynamic", "shopify"].includes(role) &&
      !imports.some((i) => i.module === allowed)) ||
    (role === "provider" && imports.length)
  )
    throw new Error("javy_native_import_invalid");
  return {
    size: bytes.length,
    sha256: hash(bytes),
    imports,
    exports,
    namespace,
  };
}

export async function downloadJavyInput(url, file, expected, size) {
  if (
    ![SDK_URL, PROVIDER_URL].includes(url) ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !Number.isInteger(size) ||
    size <= 0 ||
    size > 200 * 1024 * 1024
  )
    throw new Error("javy_native_download_invalid");
  let current = url,
    response;
  for (let i = 0; i < 4; i++) {
    response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(180_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get("location"), current);
    if (
      url !== SDK_URL ||
      next.protocol !== "https:" ||
      next.username ||
      next.password ||
      next.port ||
      !["github.com", "release-assets.githubusercontent.com"].includes(
        next.hostname,
      )
    )
      throw new Error("javy_native_redirect_invalid");
    await response.body?.cancel();
    current = next.href;
  }
  if (!response.ok) throw new Error("javy_native_download_failed");
  const chunks = [];
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > size) throw new Error("javy_native_download_limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (count !== size || hash(bytes) !== expected)
    throw new Error("javy_native_download_digest_mismatch");
  fs.writeFileSync(file, bytes, { flag: "wx" });
}

// The SDK has relative executable aliases. Check destinations before extraction.
export function checkJavySdkListing(listing, prefix) {
  const safe = (name) =>
    name === prefix ||
    (name.startsWith(`${prefix}/`) &&
      !name.includes("\\") &&
      !name.includes(":") &&
      !name.split("/").includes(".."));
  const lines = listing.trim().split(/\r?\n/);
  if (!lines.length) throw new Error("javy_sdk_archive_invalid");
  for (const line of lines) {
    const m =
      /^([-dl])\S*\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/.exec(
        line,
      );
    if (!m) throw new Error("javy_sdk_archive_invalid");
    const [name, target, extra] = m[2].split(" -> ");
    if (
      !safe(name) ||
      extra ||
      (m[1] === "l"
        ? !target ||
          path.posix.isAbsolute(target) ||
          !safe(
            path.posix.normalize(
              path.posix.join(path.posix.dirname(name), target),
            ),
          )
        : target !== undefined)
    )
      throw new Error("javy_sdk_archive_invalid");
  }
  return true;
}

function regular(file, max = 16 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > max ||
    !stat.size ||
    fs.realpathSync(file) !== path.resolve(file)
  )
    throw new Error("javy_native_file_invalid");
  return fs.readFileSync(file);
}

export function verifyJavyPluginTransfer(directory, policy, sourceReport) {
  const receipt = JSON.parse(
    regular(path.join(directory, "plugins.json"), 64 * 1024),
  );
  if (
    !exact(receipt, [
      "schemaVersion",
      "sourcePolicySha256",
      "lockfileSha256",
      "nativePolicySha256",
      "compiler",
      "wasi",
      "plugins",
      "wholeCompilerVerified",
      "productionApproved",
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.sourcePolicySha256 !== policy.sourcePolicySha256 ||
    receipt.sourcePolicySha256 !== sourceReport.policySha256 ||
    receipt.lockfileSha256 !== sourceReport.lockfileSha256 ||
    receipt.nativePolicySha256 !== hash(Buffer.from(JSON.stringify(policy))) ||
    receipt.compiler?.version !== policy.rustStd.version ||
    receipt.compiler?.target !== "x86_64-unknown-linux-gnu" ||
    receipt.wasi?.stdSha256 !== policy.rustStd.sha256 ||
    receipt.wasi?.sdkSha256 !== policy.wasiSdk.sha256 ||
    receipt.wholeCompilerVerified !== false ||
    receipt.productionApproved !== false ||
    !Array.isArray(receipt.plugins) ||
    receipt.plugins.length !== 2
  )
    throw new Error("javy_plugin_transfer_invalid");
  for (const [i, name] of PLUGINS.entries()) {
    const actual = observeJavyWasm(
      regular(path.join(directory, name)),
      i === 0 ? "plugin" : "profiler",
    );
    if (
      receipt.plugins[i].name !== name ||
      JSON.stringify(receipt.plugins[i].wasm) !== JSON.stringify(actual)
    )
      throw new Error("javy_plugin_transfer_invalid");
  }
  return receipt;
}

async function buildPlugins(p, policy, transfer) {
  const { home, toolchain, env, execute, source, cargo, json } = p;
  const std = policy.rustStd;
  const stdName = `rust-std-${std.version}-${std.target}`;
  const archive = path.join(home, `${stdName}.tar.xz`);
  await downloadRustInput(
    `https://static.rust-lang.org/dist/${std.date}/${stdName}.tar.xz`,
    archive,
    std.sha256,
  );
  execute(
    "tar",
    ["-xf", archive, "-C", home, `${stdName}/rust-std-${std.target}`],
    home,
    "wasm-rust-std",
  );
  const input = path.join(home, stdName, `rust-std-${std.target}`);
  checkRustSourceTree(input);
  fs.cpSync(input, toolchain, { recursive: true, force: true });
  const sdkArchive = path.join(home, policy.wasiSdk.archive);
  await downloadJavyInput(
    SDK_URL,
    sdkArchive,
    policy.wasiSdk.sha256,
    policy.wasiSdk.size,
  );
  const sdkName = policy.wasiSdk.archive.replace(/\.tar\.gz$/, "");
  checkJavySdkListing(
    execute("tar", ["-tvf", sdkArchive], home, "sdk-listing"),
    sdkName,
  );
  execute("tar", ["-xf", sdkArchive, "-C", home], home, "sdk-extract");
  const sdk = path.join(home, sdkName);
  env.WASI_SDK = sdk;
  env.LIBCLANG_PATH = path.join(sdk, "lib");
  // Preserve upstream SIMD flags; do not trigger the dependency's SDK24 downloader.
  env.RUSTFLAGS = "-C target-feature=+simd128";
  const clang = execute(
    path.join(sdk, "bin/clang"),
    ["--version"],
    home,
    "wasi-clang-version",
  );
  const wasi = {
    stdSha256: std.sha256,
    sdkSha256: policy.wasiSdk.sha256,
    clang,
    clangSha256: hash(fs.readFileSync(path.join(sdk, "bin/clang"))),
    libclangSha256: hash(fs.readFileSync(path.join(sdk, "lib/libclang.so"))),
  };
  json("wasi.json", wasi);
  execute(
    cargo,
    javyNativePlans("plugin")[0],
    source,
    "build-plugins",
    5_400_000,
  );
  checkPreparedJavySource(p);
  const plugins = PLUGINS.map((name, i) => {
    const bytes = regular(
      path.join(env.CARGO_TARGET_DIR, "wasm32-wasip1/release", name),
    );
    const wasm = observeJavyWasm(bytes, i === 0 ? "plugin" : "profiler");
    fs.writeFileSync(path.join(transfer, name), bytes, { flag: "wx" });
    return { name, wasm };
  });
  const report = {
    schemaVersion: 1,
    sourcePolicySha256: p.report.policySha256,
    lockfileSha256: p.report.lockfileSha256,
    nativePolicySha256: hash(Buffer.from(JSON.stringify(policy))),
    compiler: p.receipt,
    wasi,
    plugins,
    wholeCompilerVerified: false,
    productionApproved: false,
  };
  fs.writeFileSync(
    path.join(transfer, "plugins.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  verifyJavyPluginTransfer(transfer, policy, p.report);
  return { ...p.report, stage: "plugin", wasi, plugins };
}

async function buildNative(p, policy, transfer, resultDirectory) {
  const { source, home, env, execute, cargo, json } = p;
  const plugins = verifyJavyPluginTransfer(transfer, policy, p.report);
  json("input-plugins.json", plugins);
  // Upstream build.rs expects these real cross-built inputs at a fixed path.
  const inputs = path.join(source, "target/wasm32-wasip1/release");
  fs.mkdirSync(inputs, { recursive: true });
  for (const name of PLUGINS)
    fs.copyFileSync(
      path.join(transfer, name),
      path.join(inputs, name),
      fs.constants.COPYFILE_EXCL,
    );
  env.RUSTFLAGS =
    process.platform === "win32" ? "-C target-feature=+crt-static" : "";
  execute(
    cargo,
    javyNativePlans("native")[0],
    source,
    "build-native",
    7_200_000,
  );
  const filename = process.platform === "win32" ? "javy.exe" : "javy";
  const executable = path.join(env.CARGO_TARGET_DIR, "release", filename);
  const bytes = regular(executable, 256 * 1024 * 1024);
  const identity = { filename, sha256: hash(bytes), size: bytes.length };
  fs.writeFileSync(path.join(resultDirectory, filename), bytes, {
    flag: "wx",
    mode: 0o755,
  });
  json("native-build.json", {
    ...p.report,
    stage: "compiled-not-probed",
    executable: identity,
    nativePolicySha256: hash(Buffer.from(JSON.stringify(policy))),
    pluginInputSha256: hash(Buffer.from(JSON.stringify(plugins))),
    probesComplete: false,
  });
  const version = execute(
    executable,
    ["--version"],
    home,
    "native-version",
    30_000,
  ).trim();
  if (
    version !== `Javy ${p.policy.version}` &&
    version !== `javy ${p.policy.version}`
  )
    throw new Error("javy_native_version_invalid");
  const help = execute(executable, ["--help"], home, "native-help", 30_000);
  if (!help.includes("profile") || !help.includes("emit-plugin"))
    throw new Error("javy_native_features_missing");
  const embedded = path.join(home, "embedded.wasm");
  execute(
    executable,
    ["emit-plugin", "-o", embedded],
    home,
    "emit-plugin",
    30_000,
  );
  const embeddedBytes = regular(embedded);
  const embeddedObservation = observeJavyWasm(embeddedBytes, "plugin");
  if (!embeddedBytes.equals(regular(path.join(inputs, "plugin_wizened.wasm"))))
    throw new Error("javy_native_embedded_plugin_mismatch");
  fs.writeFileSync(path.join(resultDirectory, "embedded.wasm"), embeddedBytes, {
    flag: "wx",
  });
  json("embedded-observation.json", embeddedObservation);
  const js = path.join(home, "smoke.js");
  fs.writeFileSync(js, "console.log('oja-javy-native-ok');\n", { flag: "wx" });
  const provider = path.join(home, "shopify-provider.wasm");
  await downloadJavyInput(
    PROVIDER_URL,
    provider,
    policy.shopifyProvider.sha256,
    policy.shopifyProvider.size,
  );
  const providerObservation = observeJavyWasm(regular(provider), "provider");
  const outputs = [];
  for (const [role, flags] of [
    ["static", []],
    ["dynamic", ["-C", "dynamic"]],
    ["shopify", ["-C", "dynamic", "-C", `plugin=${provider}`]],
  ]) {
    const output = path.join(home, `${role}.wasm`);
    execute(
      executable,
      ["build", ...flags, "-o", output, js],
      home,
      `compile-${role}`,
      180_000,
    );
    const result = regular(output);
    outputs.push({ role, wasm: observeJavyWasm(result, role) });
    fs.writeFileSync(path.join(resultDirectory, `${role}.wasm`), result, {
      flag: "wx",
    });
  }
  const profile = path.join(home, "profile.txt");
  const profileStdout = execute(
    executable,
    ["profile", path.join(home, "static.wasm"), "-o", profile],
    home,
    "profile-smoke",
    300_000,
  );
  const profileText = regular(profile, 1024 * 1024).toString("utf8");
  if (
    profileStdout.trim() !== "oja-javy-native-ok" ||
    !/addr\s+opcode\s+count\s+entries/.test(profileText) ||
    !/0x[0-9a-f]+\s+\d+\s+[1-9]\d*/.test(profileText)
  )
    throw new Error("javy_native_profile_incomplete");
  json("profile-observation.json", {
    text: profileText,
    stdout: profileStdout,
  });
  checkPreparedJavySource(p);
  for (const [i, name] of PLUGINS.entries())
    if (
      hash(regular(path.join(inputs, name))) !== plugins.plugins[i].wasm.sha256
    )
      throw new Error("javy_native_plugin_input_changed");
  return {
    ...p.report,
    stage: "native",
    version,
    executable: identity,
    embedded: embeddedObservation,
    provider: providerObservation,
    outputs,
    profileExecuted: true,
    fullFunctionVerified: false,
    providerSourceVerified: false,
  };
}

export async function testJavyNative(stage, root = ROOT) {
  javyNativeStage([stage]);
  const policy = validateJavyNativePolicy(
    JSON.parse(
      fs.readFileSync(path.join(root, "security/javy-native-contracts.json")),
    ),
  );
  const p = await prepareJavySource(root);
  p.json("native-policy.json", policy);
  if (
    p.report.policySha256 !== policy.sourcePolicySha256 ||
    p.receipt.version !== policy.rustStd.version
  )
    throw new Error("javy_native_source_binding_invalid");
  const profile = toml.parse(
    fs.readFileSync(path.join(p.source, "Cargo.toml"), "utf8"),
  ).profile.release;
  if (profile.lto !== true || profile["opt-level"] !== 3)
    throw new Error("javy_native_release_profile_changed");
  const transfer = checkedNativeDirectory(root, ".audit/javy-plugin-transfer");
  const results = checkedNativeDirectory(root, ".audit/javy-native-result");
  const report =
    stage === "plugin"
      ? await buildPlugins(p, policy, transfer)
      : await buildNative(p, policy, transfer, results);
  const completed = { ...report, observedAt: new Date().toISOString() };
  p.json("native-receipt.json", completed);
  return completed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        await testJavyNative(javyNativeStage(process.argv.slice(2))),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
