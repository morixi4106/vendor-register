import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { assertNodeRuntime } from "./scripts/security/node-runtime.mjs";

const input = JSON.parse(fs.readFileSync("/inputs/probe-input.json", "utf8"));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(process.cwd(), "/work/project");
assert.ok(process.getuid() > 0);
for (const key of Object.keys(process.env))
  assert.ok(!/^(DATABASE_URL|DIRECT_URL|SHOPIFY_|KOMOJU_|RESEND_|GITHUB_|GH_TOKEN|AWS_|AZURE_)/i.test(key));
for (const role of ["library", "schema"]) assert.equal(sha(input[role]), input[`${role}Sha256`]);
const { ok: verifiedNode, ...node } = assertNodeRuntime();
assert.equal(verifiedNode, true);
const release = parseEnv(fs.readFileSync("/etc/os-release", "utf8"));
assert.equal(release.ID, "debian");
assert.equal(release.VERSION_ID, "12");
assert.equal(release.VERSION_CODENAME, "bookworm");
const glibc = process.report.getReport().header.glibcVersionRuntime;
assert.equal(glibc, "2.36");
const require = createRequire(import.meta.url);
assert.equal(require(input.library).version().commit, input.sourceCommit);
const names = ["libssl.so.3", "libcrypto.so.3", "libz.so.1", "libgcc_s.so.1", "libm.so.6", "libc.so.6"];
const sharedLibraries = names.map((name) => {
  const matches = process.report.getReport().sharedObjects.filter((file) => path.basename(file) === name);
  assert.equal(matches.length, 1, name);
  return { name, sha256: sha(fs.realpathSync(matches[0])) };
});
function command(executable, args, label, timeout = 15000) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(`/work/${label}.stdout.log`, result.stdout || "");
  fs.writeFileSync(`/work/${label}.stderr.log`, result.stderr || "");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const schemaCliVersion = command(input.schema, ["--version"], "schema-version").trim();
assert.ok(schemaCliVersion.includes(input.sourceCommit));
const systemOpenSsl = command("/usr/bin/openssl", ["version"], "openssl-version").trim();
assert.match(systemOpenSsl, /^OpenSSL 3\./);
const packages = ["libc6", "libssl3", "libgcc-s1", "zlib1g", "ca-certificates", "openssl"];
const packageOutput = command("/usr/bin/dpkg-query", ["-W", "-f=${Package}\t${Version}\t${Architecture}\n", ...packages], "system-packages");
const systemPackages = packageOutput.trim().split("\n").map((line) => {
  const [name, version, architecture, extra] = line.split("\t");
  assert.equal(extra, undefined);
  assert.ok(packages.includes(name) && version && ["amd64", "all"].includes(architecture));
  return { name, version, architecture };
}).sort((a, b) => a.name.localeCompare(b.name));
assert.equal(new Set(systemPackages.map((entry) => entry.name)).size, packages.length);
const caFile = "/etc/ssl/certs/ca-certificates.crt";
const ca = { sha256: sha(caFile), bytes: fs.statSync(caFile).size };
assert.ok(ca.bytes > 0);
const native = JSON.parse(command(process.execPath, ["/inputs/native-probe.mjs", "/inputs/probe-input.json"], "native-probe", 180000));
for (const role of ["library", "schema"]) assert.equal(sha(input[role]), input[`${role}Sha256`]);
console.log(JSON.stringify({ schemaVersion: 1, node, os: { id: release.ID, versionId: release.VERSION_ID, codename: release.VERSION_CODENAME, glibc }, uid: process.getuid(), nodeOpenSsl: process.versions.openssl, systemOpenSsl, systemPackages, sharedLibraries, ca, schemaCliVersion, native, wholeEngineVerified: false, productionApproved: false }));
