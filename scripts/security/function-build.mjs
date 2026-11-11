import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import toml from "toml";
import { pathToFileURL } from "node:url";
import { assertNodeRuntime } from "./node-runtime.mjs";
import { observeFunctionWasm } from "./function-postprocess.mjs";
import { validateFinalTestsPolicy } from "./function-final-tests.mjs";
import { auditIncident, writeIncidentEvidence } from "./incident-audit.mjs";
import { assertProductionBuildAdmission } from "./production-build.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const FUNCTION_BUILD_INPUT = Object.freeze({
  run: 42221077360,
  artifact: 13504146003,
  head: "0a248d50318f63e36379f45ca1ab8a32c9469b4f",
  receiptSha256:
    "25ddd0dc6f425957fb6a9d81e22a2f4ed60df6b366773edfb0512142c6d30b76",
});
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
function directory(file) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(file) !== path.resolve(file)
  )
    throw new Error("function_build_directory_invalid");
  return file;
}
function read(file, limit = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit ||
    fs.realpathSync(file) !== path.resolve(file)
  )
    throw new Error("function_build_file_invalid");
  return fs.readFileSync(file);
}
function files(dir, prefix = "") {
  directory(dir);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      if (!/^[a-zA-Z0-9_.-]+$/.test(e.name))
        throw new Error("function_build_path_invalid");
      const name = prefix + e.name,
        file = path.join(dir, e.name);
      if (e.isDirectory()) return files(file, name + "/");
      read(file);
      return [name];
    })
    .sort();
}

export function verifyFunctionBuildConfig(bytes) {
  const config = toml.parse(bytes.toString("utf8"));
  const expected = {
    api_version: "2026-04",
    extensions: [
      {
        name: "t:name",
        handle: "marketplace-purchase-control",
        type: "function",
        uid: "078e786b-ef41-b43e-c173-b38649de9b2fc2d4c1d1",
        description: "t:description",
        targeting: [
          {
            target: "cart.validations.generate.run",
            input_query: "src/cart_validations_generate_run.graphql",
            export: "cart-validations-generate-run",
          },
        ],
        build: {
          command: "node ../../scripts/security/function-build.mjs",
          path: "dist/function.wasm",
          wasm_opt: false,
        },
      },
    ],
  };
  // TOML object key order does not affect the configuration contract.
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  if (JSON.stringify(canonical(config)) !== JSON.stringify(canonical(expected)))
    throw new Error("function_build_config_changed");
  return config;
}

export function verifyFunctionBuildSources(extension, candidate) {
  verifyFunctionBuildConfig(
    read(path.join(extension, "shopify.extension.toml")),
  );
  const bindings = candidate.bindings.filter(
    (e) => e.path !== "shopify.extension.toml",
  );
  if (
    bindings.length < 17 ||
    bindings.some(
      (e) =>
        !/^(src\/[a-z_]+\.(js|graphql)|schema\.graphql|tests\/default\.test\.js|tests\/fixtures\/[a-z-]+\.json)$/.test(
          e.path,
        ) || !/^[a-f0-9]{64}$/.test(e.sha256),
    )
  )
    throw new Error("function_build_bindings_invalid");
  if (new Set(bindings.map((e) => e.path)).size !== bindings.length)
    throw new Error("function_build_bindings_invalid");
  const actual = [
    ...files(path.join(extension, "src"), "src/"),
    ...files(path.join(extension, "tests/fixtures"), "tests/fixtures/"),
    "tests/default.test.js",
    "schema.graphql",
  ].sort();
  if (
    actual.join() !==
    bindings
      .map((e) => e.path)
      .sort()
      .join()
  )
    throw new Error("function_build_source_inventory_changed");
  for (const entry of bindings) {
    const bytes = read(path.join(extension, entry.path));
    if (sha(bytes.toString("utf8").replaceAll("\r\n", "\n")) !== entry.sha256)
      throw new Error("function_build_source_changed");
  }
  return bindings.length;
}

export function inspectFinalFunction(
  root = ROOT,
  input = path.join(root, ".audit/function-release-input"),
) {
  const base = directory(path.join(input, "function-final-tests")),
    entries = fs.readdirSync(base);
  if (entries.length !== 1 || !/^run-[a-zA-Z0-9]+$/.test(entries[0]))
    throw new Error("function_build_input_invalid");
  const run = directory(path.join(base, entries[0])),
    receiptBytes = read(path.join(run, "receipt.json"));
  if (sha(receiptBytes) !== FUNCTION_BUILD_INPUT.receiptSha256)
    throw new Error("function_build_receipt_changed");
  const receipt = JSON.parse(receiptBytes);
  validateFinalTestsPolicy(receipt.policy);
  if (
    receipt.policySha256 !==
      sha(read(path.join(root, "security/function-final-tests.json"))) ||
    receipt.existingFinalByteTestsPassed !== true ||
    receipt.report?.success !== true ||
    receipt.artifactStatus !== "NOT_VERIFIED" ||
    [
      receipt.productionApproved,
      receipt.fullFunctionVerified,
      receipt.wholeCompilerVerified,
    ].some((v) => v !== false)
  )
    throw new Error("function_build_evidence_invalid");
  const extension = directory(
    path.join(root, "extensions/marketplace-purchase-control"),
  );
  const matches = receipt.candidates.filter((candidate) => {
    try {
      verifyFunctionBuildSources(extension, candidate);
      return true;
    } catch (error) {
      if (/^function_build_(source|bindings)/.test(error.message)) return false;
      throw error;
    }
  });
  if (matches.length !== 1)
    throw new Error("function_build_current_source_not_tested");
  const candidate = matches[0],
    bytes = read(path.join(run, "inputs", `${candidate.name}.wasm`), 262144),
    observed = observeFunctionWasm(bytes);
  if (
    observed.sha256 !== candidate.wasmSha256 ||
    observed.size !== candidate.wasmBytes ||
    observed.requiresCliTrampoline !== false
  )
    throw new Error("function_build_wasm_changed");
  return {
    bytes,
    evidence: {
      input: FUNCTION_BUILD_INPUT,
      candidate: candidate.name,
      sourceHead: candidate.head,
      sourceBindings: verifyFunctionBuildSources(extension, candidate),
      wasmSha256: observed.sha256,
      wasmBytes: bytes.length,
      compilerExecuted: false,
      optimizerExecuted: false,
      productionApproved: false,
    },
  };
}

export function stageFinalFunction(extension, bytes) {
  directory(extension);
  const dist = path.join(extension, "dist");
  if (!fs.existsSync(dist)) fs.mkdirSync(dist);
  directory(dist);
  const destination = path.join(dist, "function.wasm");
  if (fs.existsSync(destination)) read(destination, 262144);
  const temporary = path.join(
    dist,
    `function-${crypto.randomBytes(12).toString("hex")}.wasm`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    if (sha(read(temporary, 262144)) !== sha(bytes))
      throw new Error("function_build_output_changed");
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function buildFinalFunction(root = ROOT) {
  assertNodeRuntime();
  const candidate = inspectFinalFunction(root);
  // Candidate test evidence is not production authorization. Keep both existing gates.
  const incident = auditIncident(root);
  writeIncidentEvidence(root, incident);
  if (!incident.ok) throw new Error("function_build_incident_unresolved");
  assertProductionBuildAdmission(root);
  stageFinalFunction(
    path.join(root, "extensions/marketplace-purchase-control"),
    candidate.bytes,
  );
  return candidate.evidence;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("function_build_arguments_invalid");
    console.log(JSON.stringify(buildFinalFunction()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
