import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNodeRuntime } from "./node-runtime.mjs";
import { checkedNativeDirectory } from "./rebuild-esbuild.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const POLICY = new URL("../../security/rust-toolchain.json", import.meta.url);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const TARGETS = ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"];
const COMPONENTS = ["cargo", "rustc", "rust-std"];

export function validateRustToolchainPolicy(policy) {
  if (
    policy?.schemaVersion !== 1 ||
    policy.version !== "1.99.1" ||
    policy.date !== "2026-10-15" ||
    Object.keys(policy).sort().join() !==
      "date,schemaVersion,targets,version" ||
    Object.keys(policy.targets || {})
      .sort()
      .join() !== [...TARGETS].sort().join()
  )
    throw new Error("rust_toolchain_policy_invalid");
  for (const target of TARGETS) {
    if (
      Object.keys(policy.targets[target] || {})
        .sort()
        .join() !== [...COMPONENTS].sort().join() ||
      COMPONENTS.some(
        (name) => !/^[a-f0-9]{64}$/.test(policy.targets[target][name] || ""),
      )
    )
      throw new Error("rust_toolchain_policy_invalid");
  }
  return policy;
}

export function rustBuildEnvironment(home, toolchain, source = process.env) {
  const system = Object.fromEntries(
    [
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "LIB",
      "INCLUDE",
    ]
      .filter((key) => source[key])
      .map((key) => [key, source[key]]),
  );
  return {
    ...system,
    PATH: `${path.join(toolchain, "bin")}${path.delimiter}${source.PATH || source.Path || ""}`,
    HOME: home,
    USERPROFILE: home,
    TEMP: home,
    TMP: home,
    APPDATA: path.join(home, "roaming"),
    LOCALAPPDATA: path.join(home, "local"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    CARGO_HOME: path.join(home, "cargo-home"),
    RUSTUP_HOME: path.join(home, "rustup-home"),
    RUSTC: path.join(
      toolchain,
      "bin",
      process.platform === "win32" ? "rustc.exe" : "rustc",
    ),
    CARGO_TARGET_DIR: path.join(home, "target"),
    CARGO_BUILD_JOBS: "2",
    CARGO_NET_GIT_FETCH_WITH_CLI: "false",
    CARGO_HTTP_SSL_VERIFY: "true",
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",
    CARGO_TERM_COLOR: "never",
    CARGO_INCREMENTAL: "0",
    RUSTFLAGS: "",
    RUSTDOCFLAGS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CEILING_DIRECTORIES: home,
    GIT_TERMINAL_PROMPT: "0",
    SOURCE_DATE_EPOCH: "1792022400",
  };
}

export async function downloadRustInput(url, file, expected) {
  if (
    !/^https:\/\/(static\.rust-lang\.org|codeload\.github\.com|static\.crates\.io)\//.test(
      url,
    ) ||
    !/^[a-f0-9]{64}$/.test(expected)
  )
    throw new Error("rust_download_policy_invalid");
  const check = () => {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 256 * 1024 * 1024 ||
      hash(fs.readFileSync(file)) !== expected
    )
      throw new Error("rust_download_digest_mismatch");
  };
  if (fs.existsSync(file)) {
    check();
    return;
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error("rust_download_failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024 * 1024) throw new Error("rust_download_limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== expected)
    throw new Error("rust_download_digest_mismatch");
  fs.writeFileSync(file, bytes, { flag: "wx" });
  check();
}

export function checkRustSourceTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("rust_archive_link_not_allowed");
    if (entry.isDirectory()) checkRustSourceTree(file);
    else if (!entry.isFile() || fs.lstatSync(file).nlink !== 1)
      throw new Error("rust_archive_file_invalid");
  }
}

export async function prepareRustToolchain(root = ROOT) {
  assertNodeRuntime();
  const bytes = fs.readFileSync(POLICY);
  const policy = validateRustToolchainPolicy(JSON.parse(bytes));
  const target = process.platform === "win32" ? TARGETS[0] : TARGETS[1];
  if (!["win32", "linux"].includes(process.platform) || process.arch !== "x64")
    throw new Error("rust_toolchain_platform_invalid");
  const cache = checkedNativeDirectory(root, ".audit/rust-cache");
  const home = fs.mkdtempSync(path.join(cache, "build-"));
  const toolchain = path.join(home, "toolchain");
  fs.mkdirSync(toolchain);
  const env = rustBuildEnvironment(home, toolchain);
  for (const component of COMPONENTS) {
    const name = `${component}-${policy.version}-${target}`;
    const archive = path.join(cache, `${name}.tar.xz`);
    await downloadRustInput(
      `https://static.rust-lang.org/dist/${policy.date}/${name}.tar.xz`,
      archive,
      policy.targets[target][component],
    );
    const inner =
      component === "rust-std" ? `${component}-${target}` : component;
    execFileSync("tar", ["-xf", archive, "-C", home, `${name}/${inner}`], {
      env,
      timeout: 180_000,
      windowsHide: true,
      stdio: "pipe",
    });
    const input = path.join(home, name, inner);
    checkRustSourceTree(input);
    fs.cpSync(input, toolchain, { recursive: true, force: true });
  }
  const executable = (name) =>
    path.join(
      toolchain,
      "bin",
      `${name}${process.platform === "win32" ? ".exe" : ""}`,
    );
  const compiler = execFileSync(
    executable("rustc"),
    ["--version", "--verbose"],
    { env, encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  if (
    !compiler.includes(`release: ${policy.version}\n`) ||
    !compiler.includes(`host: ${target}\n`)
  )
    throw new Error("rust_toolchain_identity_invalid");
  const cargoVersion = execFileSync(executable("cargo"), ["--version"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  }).trim();
  if (!cargoVersion.startsWith(`cargo ${policy.version} `))
    throw new Error("rust_toolchain_identity_invalid");
  return {
    home,
    toolchain,
    env,
    cargo: executable("cargo"),
    rustc: executable("rustc"),
    receipt: {
      version: policy.version,
      target,
      policySha256: hash(bytes),
      archives: policy.targets[target],
      compilerSha256: hash(fs.readFileSync(executable("rustc"))),
      cargoSha256: hash(fs.readFileSync(executable("cargo"))),
      compiler,
      cargoVersion,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("unexpected_rust_toolchain_arguments");
    const result = await prepareRustToolchain();
    console.log(
      JSON.stringify({
        home: result.home,
        toolchain: result.toolchain,
        receipt: result.receipt,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
