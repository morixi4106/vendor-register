import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNodeRuntime } from "./node-runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const POLICY_URL = new URL(
  "../../security/esbuild-rebuild.json",
  import.meta.url,
);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function validateRebuildPolicy(policy) {
  if (
    !exactKeys(policy, [
      "schemaVersion",
      "version",
      "sourceCommit",
      "sourceSha256",
      "goVersion",
      "govulncheckVersion",
      "binarySha256",
      "archives",
    ]) ||
    policy.schemaVersion !== 1 ||
    policy.version !== "0.25.12" ||
    !/^[a-f0-9]{40}$/.test(policy.sourceCommit) ||
    !HASH.test(policy.sourceSha256) ||
    policy.goVersion !== "1.27.3" ||
    policy.govulncheckVersion !== "v1.9.0" ||
    !exactKeys(policy.archives, ["linux", "win32"]) ||
    !exactKeys(policy.binarySha256, ["linux", "win32"]) ||
    Object.values(policy.binarySha256).some((value) => !HASH.test(value))
  )
    throw new Error("esbuild_rebuild_policy_invalid");
  for (const platform of ["linux", "win32"]) {
    const archive = policy.archives[platform];
    if (
      !exactKeys(archive, ["sha256", "filename"]) ||
      !HASH.test(archive.sha256) ||
      archive.filename !==
        `go${policy.goVersion}.${platform === "linux" ? "linux-amd64.tar.gz" : "windows-amd64.zip"}`
    )
      throw new Error("esbuild_rebuild_policy_invalid");
  }
  return policy;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function checkedNativeDirectory(root, relative) {
  const base = fs.realpathSync(root);
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error("native_build_path_invalid");
  let directory = base;
  for (const part of relative.split("/")) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    if (
      fs.lstatSync(directory).isSymbolicLink() ||
      !fs.statSync(directory).isDirectory() ||
      !inside(base, fs.realpathSync(directory))
    )
      throw new Error("native_build_path_invalid");
  }
  return directory;
}

async function download(url, target, expected) {
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 128 * 1024 * 1024 ||
      sha(fs.readFileSync(target)) !== expected
    )
      throw new Error("native_download_digest_mismatch");
    return;
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(180_000),
    redirect: "error",
  });
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > 128 * 1024 * 1024
  )
    throw new Error("native_download_failed");
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 128 * 1024 * 1024) throw new Error("native_download_limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (sha(bytes) !== expected)
    throw new Error("native_download_digest_mismatch");
  fs.writeFileSync(target, bytes, { flag: "wx" });
}

export function nativeBuildEnvironment(home, source = process.env) {
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]
      .filter((key) => source[key])
      .map((key) => [key, source[key]]),
  );
  env.PATH ||= source.Path || "";
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TEMP: home,
    TMP: home,
    GOENV: "off",
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    GOWORK: "off",
    GOAMD64: "v1",
    GOEXPERIMENT: "",
    // This cache is disposable; writable module directories allow safe cleanup on Linux.
    GOFLAGS: "-modcacherw",
    GODEBUG: "",
    GOTELEMETRY: "off",
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GOPATH: path.join(home, "gopath"),
    GOMODCACHE: path.join(home, "gopath/pkg/mod"),
    GOCACHE: path.join(home, "gocache"),
    GOBIN: path.join(home, "tools"),
  };
}

export function validateGoBuildInfo(info, platform, policy) {
  const settings = new Map(
    (info.Settings || []).map(({ Key, Value }) => [Key, Value]),
  );
  if (
    info.GoVersion !== `go${policy.goVersion}` ||
    info.Path !== "github.com/evanw/esbuild/cmd/esbuild" ||
    info.Main?.Path !== "github.com/evanw/esbuild" ||
    info.Main.Version !== "(devel)" ||
    info.Main.Replace ||
    settings.get("GOOS") !== (platform === "win32" ? "windows" : "linux") ||
    settings.get("GOARCH") !== "amd64" ||
    settings.get("CGO_ENABLED") !== "0" ||
    settings.get("-trimpath") !== "true" ||
    (info.Deps || []).some((dep) => dep.Replace || !dep.Sum?.startsWith("h1:"))
  )
    throw new Error("native_go_build_info_invalid");
  return true;
}

export function validateGoSarif(report) {
  if (
    report.version !== "2.1.0" ||
    !Array.isArray(report.runs) ||
    report.runs.length !== 1 ||
    report.runs[0].tool?.driver?.name !== "govulncheck" ||
    !Array.isArray(report.runs[0].results)
  )
    throw new Error("native_go_scan_invalid");
  if (report.runs[0].results.length)
    throw new Error("native_go_advisories_unresolved");
  return true;
}

function run(command, args, cwd, env, timeout = 300_000) {
  return execFileSync(command, args, {
    cwd,
    env,
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function outputFile(directory, name, bytes) {
  const target = path.join(directory, name);
  if (
    fs.existsSync(target) &&
    (fs.lstatSync(target).isSymbolicLink() ||
      fs.lstatSync(target).nlink !== 1 ||
      !fs.lstatSync(target).isFile())
  )
    throw new Error("native_build_path_invalid");
  fs.writeFileSync(target, bytes);
}

export async function rebuildEsbuild(root = ROOT) {
  assertNodeRuntime();
  const policyBytes = fs.readFileSync(POLICY_URL);
  const policy = validateRebuildPolicy(JSON.parse(policyBytes));
  if (!policy.archives[process.platform] || process.arch !== "x64")
    throw new Error("native_build_platform_invalid");
  const cache = checkedNativeDirectory(root, ".audit/native-cache");
  const out = checkedNativeDirectory(root, ".audit/native-esbuild");
  const temp = fs.mkdtempSync(path.join(cache, "build-"));
  const env = nativeBuildEnvironment(temp);
  try {
    const archive = policy.archives[process.platform];
    const goArchive = path.join(cache, archive.filename);
    const sourceArchive = path.join(cache, "esbuild-source.tar.gz");
    await download(
      `https://dl.google.com/go/${archive.filename}`,
      goArchive,
      archive.sha256,
    );
    await download(
      `https://codeload.github.com/evanw/esbuild/tar.gz/${policy.sourceCommit}`,
      sourceArchive,
      policy.sourceSha256,
    );
    run("tar", ["-xf", goArchive, "-C", temp], root, env);
    const prefix = `esbuild-${policy.sourceCommit}`;
    run(
      "tar",
      [
        "-xf",
        sourceArchive,
        "-C",
        temp,
        ...["cmd", "internal", "pkg", "go.mod", "go.sum", "LICENSE.md"].map(
          (name) => `${prefix}/${name}`,
        ),
      ],
      root,
      env,
    );
    const source = path.join(temp, prefix);
    const go = path.join(
      temp,
      "go/bin",
      process.platform === "win32" ? "go.exe" : "go",
    );
    env.GOROOT = path.join(temp, "go");
    if (
      run(go, ["version"], root, env).trim() !==
      `go version go${policy.goVersion} ${process.platform === "win32" ? "windows" : "linux"}/amd64`
    )
      throw new Error("native_go_version_invalid");
    run(
      go,
      [
        "install",
        `golang.org/x/vuln/cmd/govulncheck@${policy.govulncheckVersion}`,
      ],
      root,
      env,
    );
    const scanner = path.join(
      env.GOBIN,
      process.platform === "win32" ? "govulncheck.exe" : "govulncheck",
    );
    const artifacts = [];
    for (const platform of ["win32", "linux"]) {
      const name = `esbuild-${platform}-x64${platform === "win32" ? ".exe" : ""}`;
      const binary = path.join(temp, name);
      const buildEnv = {
        ...env,
        GOOS: platform === "win32" ? "windows" : "linux",
        GOARCH: "amd64",
      };
      run(
        go,
        [
          "build",
          "-trimpath",
          "-buildvcs=false",
          "-ldflags=-s",
          "-o",
          binary,
          "./cmd/esbuild",
        ],
        source,
        buildEnv,
      );
      const info = JSON.parse(
        run(go, ["version", "-m", "-json", binary], root, env),
      );
      validateGoBuildInfo(info, platform, policy);
      const scanText = run(
        scanner,
        ["-mode=binary", "-format=sarif", "-db=https://vuln.go.dev", binary],
        root,
        env,
      );
      validateGoSarif(JSON.parse(scanText));
      const bytes = fs.readFileSync(binary);
      const binarySha256 = sha(bytes);
      if (binarySha256 !== policy.binarySha256[platform])
        throw new Error("native_go_rebuild_not_reproducible");
      const sbom = {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
          component: {
            type: "application",
            name: "esbuild",
            version: `${policy.version}-oja.go${policy.goVersion}`,
            hashes: [{ alg: "SHA-256", content: binarySha256 }],
            externalReferences: [
              {
                type: "vcs",
                url: `https://github.com/evanw/esbuild/commit/${policy.sourceCommit}`,
              },
            ],
          },
        },
        components: [
          {
            type: "library",
            name: "stdlib",
            version: `go${policy.goVersion}`,
            purl: `pkg:golang/stdlib@${policy.goVersion}`,
          },
          ...(info.Deps || []).map((dep) => ({
            type: "library",
            name: dep.Path,
            version: dep.Version,
            purl: `pkg:golang/${dep.Path}@${dep.Version}`,
            properties: [{ name: "go:sum", value: dep.Sum }],
          })),
        ],
      };
      const sbomText = JSON.stringify(sbom, null, 2) + "\n";
      const receipt = {
        schemaVersion: 1,
        role: "esbuild",
        platform,
        arch: "x64",
        sourceCommit: policy.sourceCommit,
        sourceSha256: policy.sourceSha256,
        goVersion: policy.goVersion,
        policySha256: sha(policyBytes),
        binarySha256,
        sbomSha256: sha(sbomText),
        sarifSha256: sha(scanText),
        observedAt: new Date().toISOString(),
        vulnerabilities: 0,
      };
      outputFile(out, name, bytes);
      fs.chmodSync(path.join(out, name), 0o755);
      outputFile(
        out,
        `${name}.buildinfo.json`,
        JSON.stringify(info, null, 2) + "\n",
      );
      outputFile(out, `${name}.cdx.json`, sbomText);
      outputFile(out, `${name}.sarif`, scanText);
      outputFile(
        out,
        `${name}.receipt.json`,
        JSON.stringify(receipt, null, 2) + "\n",
      );
      artifacts.push(receipt);
    }
    installRebuiltEsbuild(root);
    return { ok: true, artifacts };
  } finally {
    if (
      path.dirname(fs.realpathSync(temp)) !== cache ||
      !path.basename(temp).startsWith("build-")
    )
      throw new Error("native_build_cleanup_invalid");
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function evidenceFile(root, relative, limit = 20 * 1024 * 1024) {
  const base = fs.realpathSync(root);
  const target = path.join(base, relative);
  const stat = fs.lstatSync(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit ||
    !inside(base, fs.realpathSync(target))
  )
    throw new Error("native_build_evidence_invalid");
  return fs.readFileSync(target);
}

export function verifyRebuiltEsbuild(
  root,
  { now = new Date(), installed = true } = {},
) {
  const policyBytes = fs.readFileSync(POLICY_URL);
  const policy = validateRebuildPolicy(JSON.parse(policyBytes));
  const platform = process.platform;
  if (!policy.binarySha256[platform] || process.arch !== "x64")
    throw new Error("native_build_platform_invalid");
  const name = `esbuild-${platform}-x64${platform === "win32" ? ".exe" : ""}`;
  const prefix = `.audit/native-esbuild/${name}`;
  const receipt = JSON.parse(
    evidenceFile(root, `${prefix}.receipt.json`, 8192),
  );
  const age = now.getTime() - Date.parse(receipt.observedAt);
  if (
    !exactKeys(receipt, [
      "schemaVersion",
      "role",
      "platform",
      "arch",
      "sourceCommit",
      "sourceSha256",
      "goVersion",
      "policySha256",
      "binarySha256",
      "sbomSha256",
      "sarifSha256",
      "observedAt",
      "vulnerabilities",
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.role !== "esbuild" ||
    receipt.platform !== platform ||
    receipt.arch !== process.arch ||
    receipt.sourceCommit !== policy.sourceCommit ||
    receipt.sourceSha256 !== policy.sourceSha256 ||
    receipt.goVersion !== policy.goVersion ||
    receipt.policySha256 !== sha(policyBytes) ||
    receipt.binarySha256 !== policy.binarySha256[platform] ||
    receipt.vulnerabilities !== 0 ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 24 * 60 * 60 * 1000
  )
    throw new Error("native_go_receipt_invalid_or_stale");
  const sarif = evidenceFile(root, `${prefix}.sarif`);
  if (sha(sarif) !== receipt.sarifSha256)
    throw new Error("native_go_scan_digest_mismatch");
  validateGoSarif(JSON.parse(sarif));
  const sbom = evidenceFile(root, `${prefix}.cdx.json`);
  if (sha(sbom) !== receipt.sbomSha256)
    throw new Error("native_go_sbom_digest_mismatch");
  const binaryPath = installed
    ? `node_modules/@esbuild/${platform}-x64/${platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`
    : prefix;
  if (sha(evidenceFile(root, binaryPath)) !== receipt.binarySha256)
    throw new Error("native_go_binary_digest_mismatch");
  return { ok: true, ...receipt };
}

export function installRebuiltEsbuild(root) {
  assertNodeRuntime();
  const receipt = verifyRebuiltEsbuild(root, { installed: false });
  const platform = process.platform;
  const directory = checkedNativeDirectory(
    root,
    `node_modules/@esbuild/${platform}-x64`,
  );
  const metadata = JSON.parse(
    evidenceFile(
      root,
      `node_modules/@esbuild/${platform}-x64/package.json`,
      8192,
    ),
  );
  if (
    metadata.name !== `@esbuild/${platform}-x64` ||
    metadata.version !== "0.25.12"
  )
    throw new Error("native_go_consumer_mismatch");
  const name = `esbuild-${platform}-x64${platform === "win32" ? ".exe" : ""}`;
  const bytes = evidenceFile(root, `.audit/native-esbuild/${name}`);
  const destination =
    platform === "win32"
      ? directory
      : checkedNativeDirectory(
          root,
          `node_modules/@esbuild/${platform}-x64/bin`,
        );
  outputFile(
    destination,
    platform === "win32" ? "esbuild.exe" : "esbuild",
    bytes,
  );
  fs.chmodSync(
    path.join(destination, platform === "win32" ? "esbuild.exe" : "esbuild"),
    0o755,
  );
  outputFile(
    directory,
    "oja-rebuild-receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return verifyRebuiltEsbuild(root);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("unexpected_native_build_arguments");
    console.log(JSON.stringify(await rebuildEsbuild()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
