import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const POLICY = new URL("../../security/node-runtime.json", import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/;
let verified;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

export function readNodePolicy() {
  const info = fs.lstatSync(POLICY);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192)
    throw new Error("node_runtime_policy_invalid");
  return JSON.parse(fs.readFileSync(POLICY, "utf8"));
}

export function evaluateNodeRuntime(observation, policy = readNodePolicy()) {
  if (
    !exactKeys(policy, [
      "schemaVersion",
      "version",
      "signingKey",
      "releaseUrl",
      "artifacts",
    ]) ||
    policy.schemaVersion !== 1 ||
    !/^24\.[0-9]+\.[0-9]+$/.test(policy.version) ||
    !/^[A-F0-9]{40}$/.test(policy.signingKey) ||
    policy.releaseUrl !==
      `https://nodejs.org/en/blog/release/v${policy.version}` ||
    !exactKeys(policy.artifacts, ["linux-x64", "win32-x64"]) ||
    Object.entries(policy.artifacts).some(
      ([platform, a]) =>
        !exactKeys(a, ["executableSha256", "archive", "archiveSha256"]) ||
        !SHA256.test(a.executableSha256) ||
        !SHA256.test(a.archiveSha256) ||
        a.archive !==
          `node-v${policy.version}-${platform === "win32-x64" ? "win-x64.zip" : "linux-x64.tar.xz"}`,
    )
  )
    return { ok: false, code: "node_runtime_policy_invalid" };
  if (
    !exactKeys(observation, ["version", "platform", "arch", "sha256"]) ||
    observation.version !== policy.version
  )
    return { ok: false, code: "node_runtime_version_not_approved" };
  const artifact =
    policy.artifacts[`${observation.platform}-${observation.arch}`];
  if (!artifact)
    return { ok: false, code: "node_runtime_platform_not_approved" };
  if (
    !SHA256.test(observation.sha256) ||
    observation.sha256 !== artifact.executableSha256
  )
    return { ok: false, code: "node_runtime_executable_not_verified" };
  return { ok: true, ...observation };
}

export function assertNodeRuntime() {
  if (verified) return verified;
  const stat = fs.statSync(process.execPath);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
    throw new Error("node_runtime_executable_invalid");
  const result = evaluateNodeRuntime({
    version: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(process.execPath))
      .digest("hex"),
  });
  if (!result.ok) throw new Error(result.code);
  verified = Object.freeze(result);
  return verified;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(assertNodeRuntime()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
