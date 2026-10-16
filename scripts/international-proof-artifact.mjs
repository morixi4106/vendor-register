import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parse } from "toml";
import {
  runSafeBuildCommand,
  assertBuildInputs,
} from "./security/safe-build.mjs";
import {
  byteHash,
  proofHash,
  safeProofPath,
  validateManifest,
  PROOF_VERSION,
  PROOF_REPOSITORY,
  PROOF_WORKFLOW,
  FUNCTION_UID,
  CHECKOUT_CONTRACT_PATHS,
} from "../app/utils/internationalProofContract.js";
import { INTERNATIONAL_CURRENCY_POLICY, INTERNATIONAL_SHOP_PROJECTION_VERSION } from "../app/utils/internationalCurrencyPolicy.js";
import { INTERNATIONAL_CHECKOUT_SCENARIOS, INTERNATIONAL_CHECKOUT_VERIFIER } from "../app/utils/internationalCheckoutVerification.js";
import { createInternationalProofGitHub } from "../app/services/internationalProofGitHub.server.js";

export function collectProofDeploymentFiles(root) {
  const files = new Map();
  function add(relative) {
    safeProofPath(relative);
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("proof_symbolic_link");
    if (stat.isDirectory())
      for (const entry of fs.readdirSync(absolute).sort())
        add(`${relative}/${entry}`);
    else if (stat.isFile() && stat.nlink === 1) {
      if (stat.size > 64 * 1024 * 1024) throw new Error("proof_file_limit");
      files.set(relative, fs.readFileSync(absolute));
    } else throw new Error("proof_special_file");
  }
  add("shopify.app.production.toml");
  const expected = [
    "account-home-entry",
    "account-home-page",
    "marketplace-purchase-control",
  ];
  const actual = fs
    .readdirSync(path.join(root, "extensions"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (actual.join() !== expected.join())
    throw new Error("proof_extension_set_unreviewed");
  for (const name of expected) {
    const base = `extensions/${name}`;
    const config = parse(
      fs.readFileSync(path.join(root, base, "shopify.extension.toml"), "utf8"),
    );
    if (
      config.extensions?.length !== 1 ||
      !["function", "ui_extension"].includes(config.extensions[0].type)
    )
      throw new Error("proof_extension_unreviewed");
    if (
      name === "marketplace-purchase-control" &&
      config.extensions[0].uid !== FUNCTION_UID
    )
      throw new Error("proof_function_unreviewed");
    add(`${base}/shopify.extension.toml`);
    add(`${base}/dist`);
    add(`${base}/src`);
    add(`${base}/locales`);
    if (name === "marketplace-purchase-control") add(`${base}/schema.graphql`);
    else add(`${base}/manifest.json`);
  }
  return files;
}
const listFiles = (files) =>
  [...files].map(([name, bytes]) => ({
    path: name,
    size: bytes.length,
    sha256: byteHash(bytes),
  }));

export function collectCheckoutVerifier(root) {
  const files = CHECKOUT_CONTRACT_PATHS.map((relative) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 65536)
      throw new Error("proof_verifier_source_invalid");
    return { path: relative, size: stat.size, sha256: byteHash(fs.readFileSync(absolute)) };
  });
  return { v: "international-checkout-verifier-v1", level: "CONTRACT_ONLY",
    scenarioVersion: INTERNATIONAL_CHECKOUT_SCENARIOS, verifierVersion: INTERNATIONAL_CHECKOUT_VERIFIER,
    files, digest: proofHash(files) };
}

export async function exportInternationalProofArtifact({
  root = process.cwd(),
  env = process.env,
  github,
} = {}) {
  assertBuildInputs();
  const before = collectProofDeploymentFiles(root);
  fs.mkdirSync(path.join(root, ".audit"), { recursive: true });
  runSafeBuildCommand({
    args: [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "--run",
      "--config=vitest.prebuilt.config.js",
    ],
    cwd: path.join(root, "extensions/marketplace-purchase-control"),
    timeoutMs: 180000,
    sourceEnv: {
      ...process.env,
      PATH: [
        path.join(root, "node_modules/.bin"),
        process.env.PATH || process.env.Path || "",
      ].join(path.delimiter),
    },
  });
  const files = collectProofDeploymentFiles(root);
  if (proofHash(listFiles(before)) !== proofHash(listFiles(files)))
    throw new Error("proof_artifact_changed_during_test");
  const report = JSON.parse(
    fs.readFileSync(
      path.join(root, ".audit/international-prebuilt-results.json"),
      "utf8",
    ),
  );
  const assertions = report.testResults.flatMap((r) => r.assertionResults);
  if (
    report.success !== true ||
    !assertions.length ||
    assertions.some((r) => r.status !== "passed")
  )
    throw new Error("proof_prebuilt_tests_incomplete");
  const caseIds = assertions.map((r) => r.fullName).sort();
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const production =
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF === "refs/heads/main";
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== PROOF_REPOSITORY
  )
    throw new Error("proof_ci_required");
  const api =
    github || createInternationalProofGitHub({ token: env.GITHUB_TOKEN });
  const workflow = await api.json(`/actions/runs/${Number(env.GITHUB_RUN_ID)}`);
  const checks = {};
  for (const [name, workflowName] of [
    ["quality", "quality.yml"],
    ["postgres", "international-authorization-postgres.yml"],
  ]) {
    if (production) {
      const list = await api.json(
        `/actions/workflows/${workflowName}/runs?head_sha=${headSha}&event=push&per_page=100`,
      );
      const run = list.workflow_runs?.sort((a, b) => b.id - a.id)[0];
      if (!run || run.status !== "completed" || run.conclusion !== "success")
        throw new Error("proof_required_ci_incomplete");
      checks[name] = { runId: run.id, runAttempt: run.run_attempt };
    } else
      checks[name] = {
        runId: Number(env.GITHUB_RUN_ID),
        runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      };
  }
  const base = "extensions/marketplace-purchase-control";
  const manifest = validateManifest({
    v: PROOF_VERSION,
    repository: PROOF_REPOSITORY,
    repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    workflow: PROOF_WORKFLOW,
    workflowId: workflow.workflow_id,
    workflowDigest: byteHash(fs.readFileSync(path.join(root, PROOF_WORKFLOW))),
    headSha,
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    event: env.GITHUB_EVENT_NAME,
    channel: production ? "production" : "candidate",
    createdAt: new Date().toISOString(),
    lockDigest: byteHash(fs.readFileSync(path.join(root, "package-lock.json"))),
    nodeVersion: process.versions.node,
    cliVersion: "4.5.2",
    checks,
    caseIds,
    casesHash: proofHash(caseIds),
    testDigest: proofHash(
      assertions.map((r) => ({ id: r.fullName, status: r.status })),
    ),
    function: {
      handle: "marketplace-purchase-control",
      uid: FUNCTION_UID,
      apiVersion: "2026-04",
      target: "cart.validations.generate.run",
      export: "cart-validations-generate-run",
      wasm: `${base}/dist/function.wasm`,
      query: `${base}/src/cart_validations_generate_run.graphql`,
      schema: `${base}/schema.graphql`,
      policy: INTERNATIONAL_CURRENCY_POLICY,
      projectionVersion: INTERNATIONAL_SHOP_PROJECTION_VERSION,
    },
    checkoutVerifier: collectCheckoutVerifier(root),
    files: listFiles(files),
    deploymentDigest: proofHash(listFiles(files)),
  });
  const output = path.join(
    root,
    ".audit",
    `international-proof-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
  if (fs.existsSync(output)) throw new Error("proof_output_exists");
  fs.mkdirSync(output, { recursive: true });
  for (const [name, bytes] of files) {
    fs.mkdirSync(path.dirname(path.join(output, name)), { recursive: true });
    fs.writeFileSync(path.join(output, name), bytes, { flag: "wx" });
  }
  fs.writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest),
    { flag: "wx" },
  );
  return {
    output,
    contentDigest: proofHash(manifest),
    caseCount: caseIds.length,
    channel: manifest.channel,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await exportInternationalProofArtifact()));
  } catch (error) {
    const code = /^[a-z][a-z0-9_]{1,100}$/.test(error?.message || "")
      ? error.message
      : "international_proof_artifact_export_failed";
    console.error(code);
    const reportPath = path.resolve(
      ".audit/international-prebuilt-results.json",
    );
    if (fs.existsSync(reportPath) && fs.statSync(reportPath).size < 262144) {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      console.error(
        JSON.stringify({
          success: report.success,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          pending: report.numPendingTests,
          failedCases: report.testResults
            .flatMap((r) => r.assertionResults)
            .filter((r) => r.status !== "passed")
            .map((r) => r.fullName),
        }),
      );
    }
    process.exitCode = 1;
  }
}
