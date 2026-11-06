import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertNodeRuntime } from "./node-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const hash = (b, algorithm = "sha256") =>
  crypto.createHash(algorithm).update(b).digest("hex");
const blob = (b) =>
  crypto
    .createHash("sha1")
    .update(`blob ${b.length}\0`)
    .update(b)
    .digest("hex");
const read = (file, limit = 100_000_000) => {
  const s = fs.lstatSync(file);
  assert.ok(
    s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= limit,
  );
  return fs.readFileSync(file);
};

export function validateRuntimeOriginPolicy(p) {
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.sdk.name, "@shopify/shopify_function");
  assert.equal(p.sdk.version, "2.0.1");
  assert.equal(p.sdk.repository, "Shopify/shopify-function-javascript");
  assert.equal(p.sdk.commit, "40e8dc49ff5b29b6add4babe89e538c3d19df30d");
  assert.equal(p.sdk.fileCount, 14);
  assert.equal(p.sdk.unpackedSize, 9864);
  assert.deepEqual(
    p.sdk.runtimeFiles.map((x) => x.path),
    ["index.ts", "run.ts"],
  );
  for (const value of [
    p.sdk.archiveSha256,
    p.input.optimizerReceiptSha256,
    p.input.finalReceiptSha256,
    p.input.runnerSha256,
    p.provider.compilerSha256,
    p.provider.runnerSha256,
  ])
    assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(p.provider.namespace, "shopify_functions_javy_v4");
  assert.equal(p.provider.size, 1233749);
  assert.equal(p.artifactStatus, "NOT_VERIFIED");
  for (const key of [
    "providerSourceProvenanceVerified",
    "providerSbomVerified",
    "wholeCompilerVerified",
    "fullFunctionVerified",
    "productionApproved",
  ])
    assert.equal(p[key], false);
  return p;
}

// Parse only the bounded section envelope; V8 validates the core WASM grammar.
export function providerSections(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 2_000_000);
  assert.ok(WebAssembly.validate(bytes));
  let position = 8;
  const uint = (end = bytes.length) => {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      assert.ok(position < end);
      const b = bytes[position++];
      n += (b & 127) * 2 ** shift;
      assert.ok(n <= 0xffffffff);
      if (!(b & 128)) return n;
    }
    throw new Error("provider_section_length_invalid");
  };
  const sections = [];
  while (position < bytes.length) {
    const start = position,
      id = bytes[position++],
      end = uint() + position;
    assert.ok(end <= bytes.length);
    let name = null;
    if (id === 0) {
      const length = uint(end);
      assert.ok(position + length <= end);
      name = new TextDecoder("utf8", { fatal: true }).decode(
        bytes.subarray(position, position + length),
      );
      position += length;
    }
    sections.push({
      id,
      name,
      bytes: end - start,
      sha256: hash(bytes.subarray(start, end)),
      value:
        id === 0 && name === "git_hash"
          ? bytes.subarray(position, end).toString("utf8")
          : null,
    });
    position = end;
  }
  return sections;
}

export function compareProviderSections(compiler, runner) {
  const a = providerSections(compiler),
    b = providerSections(runner);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].id, b[i].id);
    assert.equal(a[i].name, b[i].name);
    if (a[i].name !== "git_hash") assert.equal(a[i].sha256, b[i].sha256);
  }
  const claims = [a, b].map((sections) => {
    const matches = sections.filter((s) => s.id === 0 && s.name === "git_hash");
    assert.equal(matches.length, 1);
    assert.match(matches[0].value, /^[a-f0-9]{40}$/);
    return matches[0].value;
  });
  return {
    compilerSections: a,
    runnerSections: b,
    gitHashClaims: claims,
    allOtherSectionsByteIdentical: true,
    sourceProvenanceVerified: false,
  };
}

export function verifySdkStatement(statement, sdk) {
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  assert.deepEqual(statement.subject, [
    {
      name: "pkg:npm/%40shopify/shopify_function@2.0.1",
      digest: {
        sha512: Buffer.from(sdk.integrity.slice(7), "base64").toString("hex"),
      },
    },
  ]);
  const definition = statement.predicate.buildDefinition;
  assert.equal(
    definition.buildType,
    "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
  );
  assert.equal(
    statement.predicate.runDetails.builder.id,
    "https://github.com/actions/runner/github-hosted",
  );
  assert.deepEqual(definition.externalParameters.workflow, {
    ref: "refs/heads/main",
    repository: `https://github.com/${sdk.repository}`,
    path: ".github/workflows/release.yml",
  });
  assert.deepEqual(definition.resolvedDependencies, [
    {
      uri: `git+https://github.com/${sdk.repository}@refs/heads/main`,
      digest: { gitCommit: sdk.commit },
    },
  ]);
  return true;
}

export function verifyRegistrySignature(metadata, keys, sdk, now = Date.now()) {
  assert.equal(metadata.name, sdk.name);
  assert.equal(metadata.version, sdk.version);
  assert.equal(metadata.gitHead, sdk.commit);
  assert.equal(metadata.dist.integrity, sdk.integrity);
  assert.equal(metadata.dist.fileCount, sdk.fileCount);
  assert.equal(metadata.dist.unpackedSize, sdk.unpackedSize);
  assert.ok(metadata.dist.signatures.length > 0);
  assert.ok(
    metadata.dist.signatures.some((signature) => {
      const key = keys.keys.find((k) => k.keyid === signature.keyid);
      return (
        key &&
        (key.expires === null || Date.parse(key.expires) > now) &&
        crypto.verify(
          "sha256",
          Buffer.from(`${sdk.name}@${sdk.version}:${sdk.integrity}`),
          {
            key: Buffer.from(key.key, "base64"),
            format: "der",
            type: "spki",
          },
          Buffer.from(signature.sig, "base64"),
        )
      );
    }),
  );
  return true;
}

export function sdkMemberPath(name) {
  assert.match(name, /^package\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/);
  assert.ok(
    name.length < 250 && name.split("/").every((s) => s !== "." && s !== ".."),
  );
  return name.slice(8);
}

export async function reviewRuntimeOrigin(input, root = ROOT) {
  assertNodeRuntime();
  const pBytes = read(path.join(root, "security/function-runtime-origin.json"));
  const p = validateRuntimeOriginPolicy(JSON.parse(pBytes));
  const base = path.join(root, ".audit");
  fs.mkdirSync(base, { recursive: true });
  assert.ok(!fs.lstatSync(base).isSymbolicLink());
  const home = fs.mkdtempSync(path.join(base, "function-runtime-origin-"));
  const npmPath =
    process.platform === "win32"
      ? path.join(
          path.dirname(process.execPath),
          "node_modules/npm/package.json",
        )
      : path.resolve(
          path.dirname(process.execPath),
          "../lib/node_modules/npm/package.json",
        );
  const npmRequire = createRequire(npmPath);
  assert.equal(npmRequire("./package.json").version, "11.19.1");
  assert.equal(npmRequire("sigstore/package.json").version, "4.1.1");
  assert.equal(npmRequire("tar/package.json").version, "7.5.22");
  const sigstore = npmRequire("sigstore"),
    tar = npmRequire("tar");
  const requests = [];
  const save = (name, bytes) =>
    fs.writeFileSync(path.join(home, name), bytes, { flag: "wx" });
  const get = async (url, name, max = 2_000_000) => {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `download failed: ${name}/${response.status}`);
    let size = 0;
    const chunks = [];
    for await (const b of response.body) {
      size += b.length;
      assert.ok(size <= max);
      chunks.push(b);
    }
    const bytes = Buffer.concat(chunks);
    save(name, bytes);
    requests.push({
      url,
      file: name,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    return bytes;
  };
  save("policy.json", pBytes);
  const meta = JSON.parse(
    await get(
      "https://registry.npmjs.org/@shopify/shopify_function/2.0.1",
      "sdk-metadata.json",
    ),
  );
  const archive = await get(
    "https://registry.npmjs.org/@shopify/shopify_function/-/shopify_function-2.0.1.tgz",
    "sdk.tgz",
  );
  assert.equal(hash(archive), p.sdk.archiveSha256);
  assert.equal(
    "sha512-" + crypto.createHash("sha512").update(archive).digest("base64"),
    p.sdk.integrity,
  );
  assert.equal(hash(archive, "sha1"), meta.dist.shasum);
  const keys = JSON.parse(
    await get("https://registry.npmjs.org/-/npm/v1/keys", "npm-keys.json"),
  );
  verifyRegistrySignature(meta, keys, p.sdk);
  const attestations = JSON.parse(
    await get(
      "https://registry.npmjs.org/-/npm/v1/attestations/@shopify%2fshopify_function@2.0.1",
      "sdk-attestations.json",
    ),
  );
  const provenance = attestations.attestations.filter(
    (a) => a.predicateType === "https://slsa.dev/provenance/v1",
  );
  assert.equal(provenance.length, 1);
  const bundle = provenance[0].bundle;
  await sigstore.verify(bundle, {
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: `https://github.com/${p.sdk.repository}/.github/workflows/release.yml@refs/heads/main`,
    tufCachePath: path.join(home, "tuf"),
    timeout: 30000,
    retry: 1,
    tlogThreshold: 1,
    ctLogThreshold: 1,
  });
  verifySdkStatement(
    JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64")),
    p.sdk,
  );
  const members = new Map();
  let unpacked = 0;
  await new Promise((resolve, reject) => {
    const parser = new tar.Parser({
      onReadEntry(entry) {
        try {
          assert.equal(entry.type, "File");
          const name = sdkMemberPath(entry.path);
          assert.ok(!members.has(name) && entry.size <= 100000);
          const chunks = [];
          let size = 0;
          members.set(name, null);
          entry.on("data", (c) => {
            size += c.length;
            if (size > 100000) reject(new Error("sdk_member_oversize"));
            else chunks.push(c);
          });
          entry.on("end", () => {
            members.set(name, Buffer.concat(chunks));
            unpacked += size;
          });
        } catch (error) {
          reject(error);
        }
      },
    });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(archive);
  });
  assert.equal(members.size, p.sdk.fileCount);
  assert.equal(unpacked, p.sdk.unpackedSize);
  const sdkBindings = [];
  for (const [name, bytes] of members) {
    const source = await get(
      `https://raw.githubusercontent.com/${p.sdk.repository}/${p.sdk.commit}/${name}`,
      "sdk-" + name.replaceAll("/", "__"),
    );
    assert.ok(bytes.equals(source), name);
    sdkBindings.push({
      path: name,
      bytes: bytes.length,
      sha256: hash(bytes),
      gitBlob: blob(bytes),
    });
  }
  for (const runtime of p.sdk.runtimeFiles)
    assert.deepEqual(
      sdkBindings.find((b) => b.path === runtime.path),
      runtime,
    );
  const compiler = await get(
    "https://cdn.shopify.com/shopifycloud/shopify-functions-javy-plugin/shopify_functions_javy_v4.wasm",
    "compiler-provider.wasm",
  );
  const runner = await get(
    `https://raw.githubusercontent.com/Shopify/function-runner/${p.provider.runnerSourceCommit}/providers/shopify_functions_javy_v4.wasm`,
    "runner-provider.wasm",
  );
  assert.equal(compiler.length, p.provider.size);
  assert.equal(runner.length, p.provider.size);
  assert.equal(hash(compiler), p.provider.compilerSha256);
  assert.equal(hash(runner), p.provider.runnerSha256);
  assert.equal(blob(runner), p.provider.runnerGitBlob);
  const comparison = compareProviderSections(compiler, runner);
  assert.deepEqual(comparison.gitHashClaims, [
    p.provider.compilerGitHashClaim,
    p.provider.runnerGitHashClaim,
  ]);
  const post = path.join(input, "function-postprocess/run-xYmKNl");
  const final = path.join(input, "function-final-tests/run-t7Nub7");
  const postReceipt = read(path.join(post, "receipt.json")),
    finalReceipt = read(path.join(final, "receipt.json"));
  assert.equal(hash(postReceipt), p.input.optimizerReceiptSha256);
  assert.equal(hash(finalReceipt), p.input.finalReceiptSha256);
  assert.ok(read(path.join(post, "provider.wasm")).equals(compiler));
  const runnerBytes = read(path.join(final, "inputs/function-runner"));
  assert.equal(hash(runnerBytes), p.input.runnerSha256);
  const offset = runnerBytes.indexOf(runner);
  assert.ok(offset >= 0);
  assert.equal(runnerBytes.indexOf(compiler), -1);
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(git.status, 0);
  assert.match(git.stdout.trim(), /^[a-f0-9]{40}$/);
  const report = {
    observedAt: new Date().toISOString(),
    head: git.stdout.trim(),
    policySha256: hash(pBytes),
    input: p.input,
    verifier: {
      node: process.version,
      nodeSha256: hash(read(process.execPath)),
      npm: "11.19.1",
      sigstore: "4.1.1",
      tar: "7.5.22",
    },
    sdk: {
      ...p.sdk,
      registrySignatureVerified: true,
      sigstoreCertificateTlogAndCtVerified: true,
      githubWorkflowSourceAndSubjectVerified: true,
      allPackageFilesGitMatched: true,
      bindings: sdkBindings,
    },
    provider: {
      ...p.provider,
      ...comparison,
      embeddedRunnerOffset: offset,
      metadata: Object.fromEntries(
        ["producers", "target_features", "import_namespace", "git_hash"].map(
          (name) => [
            name,
            WebAssembly.Module.customSections(
              new WebAssembly.Module(compiler),
              name,
            ).map((b) => Buffer.from(b).toString("utf8")),
          ],
        ),
      ),
    },
    requests,
    providerSourceProvenanceVerified: false,
    providerSbomVerified: false,
    wholeCompilerVerified: false,
    fullFunctionVerified: false,
    productionApproved: false,
    artifactStatus: "NOT_VERIFIED",
    scope:
      "signed SDK release/source and provider section/embedded-byte origin only; producer labels and git_hash claims are not a source provenance or SBOM; no guest execution, installation or production approval",
  };
  save("report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      home,
      sdkFiles: sdkBindings.length,
      allSdkOriginContractsVerified: true,
      allProviderByteOriginContractsVerified: true,
      providerSourceProvenanceVerified: false,
      productionApproved: false,
    }),
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(process.argv.length, 3);
  await reviewRuntimeOrigin(path.resolve(process.argv[2]));
}
