import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRELOAD = fileURLToPath(
  new URL("./braces-build-preload.mjs", import.meta.url),
);
const SYSTEM_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
];

export function createBuildEnvironment(home, source = process.env) {
  const env = Object.fromEntries(
    SYSTEM_KEYS.filter((key) => source[key]).map((key) => [key, source[key]]),
  );
  return {
    ...env,
    CI: "true",
    NODE_ENV: "production",
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    NPM_CONFIG_USERCONFIG: path.join(home, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(home, "npm-globalrc"),
    NODE_OPTIONS: `--max-old-space-size=1024 --import=${pathToFileURL(PRELOAD).href}`,
    DATABASE_URL:
      "postgresql://postgres:postgres@localhost:5432/vendor_register_ci?schema=public",
    SHOPIFY_API_KEY: "ci-api-key",
    SHOPIFY_API_SECRET: "ci-placeholder-secret-not-production",
    SHOPIFY_APP_URL: "https://example.test",
    SCOPES: "read_products",
    RESEND_API_KEY: "re_ci_placeholder",
    MAIL_FROM: "ci@example.test",
  };
}

export function assertBuildInputs(root = ROOT) {
  if (
    fs
      .readdirSync(root)
      .some(
        (name) =>
          /^\.env(?:$|\.)/.test(name) &&
          ![".env.example", ".env.template"].includes(name),
      )
  )
    throw new Error("build_dotenv_not_allowed");
  const config = JSON.parse(
    fs.readFileSync(
      path.join(root, "extensions/marketplace-purchase-control/package.json"),
      "utf8",
    ),
  ).codegen;
  if (
    config?.schema !== "schema.graphql" ||
    config.documents !== "src/*.graphql"
  )
    throw new Error("unreviewed_build_patterns");
  return true;
}

export function runSafeBuildCommand({
  args,
  cwd = ROOT,
  timeoutMs = 120_000,
  stdio = "inherit",
  sourceEnv = process.env,
  spawn = spawnSync,
}) {
  if (
    !Array.isArray(args) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  )
    throw new Error("invalid_build_command");
  const base = fs.realpathSync(os.tmpdir());
  const home = fs.mkdtempSync(path.join(base, "vendor-register-build-"));
  try {
    for (const name of ["config", "local", "cache"])
      fs.mkdirSync(path.join(home, name));
    for (const name of ["Roaming", "Local"])
      fs.mkdirSync(path.join(home, "AppData", name), { recursive: true });
    for (const name of ["npmrc", "npm-globalrc"])
      fs.writeFileSync(path.join(home, name), "", { mode: 0o600 });
    const result = spawn(process.execPath, args, {
      cwd,
      env: createBuildEnvironment(home, sourceEnv),
      stdio,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      shell: false,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        result.error?.code === "ETIMEDOUT"
          ? "build_timeout"
          : "guarded_build_failed",
      );
    return result;
  } finally {
    if (
      path.dirname(fs.realpathSync(home)) !== base ||
      !path.basename(home).startsWith("vendor-register-build-")
    )
      throw new Error("unsafe_build_cleanup");
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export function buildCommand(kind, root = ROOT) {
  const binary = (name) => {
    const directory = path.join(root, "node_modules", name);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    return path.join(
      directory,
      typeof metadata.bin === "string"
        ? metadata.bin
        : Object.values(metadata.bin)[0],
    );
  };
  const shopify = () => binary("@shopify/cli");
  if (kind === "app")
    return {
      args: [binary("@react-router/dev"), "build"],
      cwd: root,
      timeoutMs: 300_000,
    };
  if (kind === "extensions")
    return {
      args: [
        shopify(),
        "app",
        "build",
        "--config",
        "production",
        "--no-color",
        "--skip-dependencies-installation",
      ],
      cwd: root,
      timeoutMs: 300_000,
    };
  if (kind === "typegen")
    return {
      args: [shopify(), "app", "function", "typegen"],
      cwd: path.join(root, "extensions/marketplace-purchase-control"),
    };
  if (kind === "function-test")
    return {
      args: [binary("vitest"), "--run"],
      cwd: path.join(root, "extensions/marketplace-purchase-control"),
      timeoutMs: 180_000,
    };
  if (kind === "generate")
    return {
      args: [binary("prisma"), "generate", "--schema=prisma/schema.prisma"],
      cwd: root,
    };
  throw new Error("unknown_build_kind");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3)
      throw new Error("unexpected_build_arguments");
    assertBuildInputs();
    runSafeBuildCommand(buildCommand(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
