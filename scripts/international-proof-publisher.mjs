import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parse } from "toml";
import {
  createInternationalProofGitHub,
  verifyInternationalProofArtifact,
  boundedProofBody,
} from "../app/services/internationalProofGitHub.server.js";
import {
  proofError,
  proofDate,
  shape,
  ID,
  SHA,
  PROOF_VERSION,
  PROOF_SCHEMA_MIGRATION_VERSION,
  proofHash,
  byteHash,
  signProofPayload,
  verifyProofSignature,
  INTERNATIONAL_PROOF_TRUST,
} from "../app/utils/internationalProofContract.js";

export function validatePublishApproval(a, now) {
  shape(
    a,
    [
      "v",
      "id",
      "purpose",
      "shopDomain",
      "appId",
      "artifactId",
      "headSha",
      "archiveDigest",
      "contentDigest",
      "versionTag",
      "versionId",
      "executeBefore",
      "allowedUseUntil",
      "webServiceId",
      "cronServiceId",
    ],
    32000,
  );
  if (
    a.v !== PROOF_VERSION ||
    ![a.id, a.appId, a.versionTag, a.webServiceId, a.cronServiceId].every((v) =>
      ID.test(v),
    ) ||
    !["STAGE", "RELEASE"].includes(a.purpose) ||
    !/^[a-z0-9-]+\.myshopify\.com$/.test(a.shopDomain) ||
    !SHA.test(a.headSha) ||
    !Number.isSafeInteger(a.artifactId) ||
    a.artifactId < 1 ||
    (a.purpose === "RELEASE" && !ID.test(a.versionId)) ||
    (a.purpose === "STAGE" && a.versionId !== null) ||
    proofDate(a.executeBefore) <= now ||
    proofDate(a.allowedUseUntil) <= now
  )
    throw proofError("international_publish_approval_invalid");
  return a;
}
export async function renderServices(a, env, fetchImpl = fetch) {
  if (
    !env.INTERNATIONAL_PROOF_RENDER_READ_TOKEN ||
    env.INTERNATIONAL_PROOF_WEB_SERVICE !== a.webServiceId ||
    env.INTERNATIONAL_PROOF_CRON_SERVICE !== a.cronServiceId
  )
    throw proofError("international_deployment_unverified");
  const read = async (serviceId) => {
    const response = await fetchImpl(
      `https://api.render.com/v1/services/${serviceId}/deploys?limit=1`,
      {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
        headers: {
          Authorization: `Bearer ${env.INTERNATIONAL_PROOF_RENDER_READ_TOKEN}`,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) throw proofError("international_deployment_unverified");
    const data = JSON.parse(
      (await boundedProofBody(response, 262144)).toString("utf8"),
    );
    const deploy = data?.[0]?.deploy;
    if (
      !deploy ||
      !ID.test(deploy.id) ||
      deploy.status !== "live" ||
      deploy.commit?.id !== a.headSha
    )
      throw proofError("international_deployment_unverified");
    return {
      serviceId,
      deployId: deploy.id,
      commit: deploy.commit.id,
      status: deploy.status,
    };
  };
  return { web: await read(a.webServiceId), cron: await read(a.cronServiceId) };
}
export async function publishInternationalProof(
  { approval, stageReceipt = null, env = process.env },
  {
    github = createInternationalProofGitHub({
      token: env.INTERNATIONAL_PROOF_GITHUB_READ_TOKEN,
    }),
    spawn = spawnSync,
    readServices = renderServices,
    trust = INTERNATIONAL_PROOF_TRUST,
  } = {},
) {
  const started = new Date();
  const a = validatePublishApproval(approval, started);
  if (
    env.SHOPIFY_API_KEY !== a.appId ||
    !env.INTERNATIONAL_PROOF_PUBLISHER_PRIVATE_KEY ||
    !env.INTERNATIONAL_PROOF_PUBLISHER_KEY_ID ||
    !env.SHOPIFY_CLI_PARTNERS_TOKEN
  )
    throw proofError("international_publisher_unconfigured");
  // Prove the configured signing key is an approved publisher key before any write.
  verifyProofSignature(
    signProofPayload(
      "publisher",
      { test: true },
      env.INTERNATIONAL_PROOF_PUBLISHER_KEY_ID,
      env.INTERNATIONAL_PROOF_PUBLISHER_PRIVATE_KEY,
    ),
    "publisher",
    started,
    trust,
  );
  const artifact = await verifyInternationalProofArtifact({
    artifactId: a.artifactId,
    now: started,
    github,
  });
  if (
    a.headSha !== artifact.manifest.headSha ||
    a.archiveDigest !== artifact.archiveHash ||
    a.contentDigest !== artifact.contentDigest
  )
    throw proofError();
  if (a.purpose === "RELEASE") {
    const stage = verifyProofSignature(
      stageReceipt,
      "publisher",
      started,
      trust,
    );
    if (
      stage.purpose !== "STAGE" ||
      stage.appId !== a.appId ||
      stage.shopDomain !== a.shopDomain ||
      stage.artifactId !== a.artifactId ||
      stage.contentDigest !== a.contentDigest ||
      stage.archiveDigest !== a.archiveDigest ||
      stage.versionId !== a.versionId ||
      stage.versionTag !== a.versionTag
    )
      throw proofError("international_stage_receipt_invalid");
  }
  const services = await readServices(a, env);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "international-publisher-"),
  );
  const cli = path.resolve("node_modules/@shopify/cli/bin/run.js");
  const execute = (command) => {
    const result = spawn(
      process.execPath,
      [
        cli,
        "app",
        ...command,
        "--config",
        "production",
        "--client-id",
        a.appId,
        "--path",
        directory,
        "--no-color",
      ],
      {
        cwd: directory,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 300000,
        maxBuffer: 262144,
        env: {
          PATH: env.PATH,
          SystemRoot: env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          CI: "true",
          SHOPIFY_CLI_PARTNERS_TOKEN: env.SHOPIFY_CLI_PARTNERS_TOKEN,
        },
      },
    );
    if (result.error || result.status !== 0)
      throw proofError("international_publish_outcome_unknown", 503);
    return result.stdout;
  };
  try {
    for (const [name, bytes] of artifact.files)
      if (name !== "manifest.json") {
        const target = path.join(directory, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { flag: "wx" });
      }
    const config = parse(
      artifact.files.get("shopify.app.production.toml").toString("utf8"),
    );
    if (config.client_id !== a.appId)
      throw proofError("international_app_mismatch");
    const checkFiles = () => {
      for (const f of artifact.manifest.files)
        if (
          byteHash(fs.readFileSync(path.join(directory, f.path))) !== f.sha256
        )
          throw proofError("international_publish_files_changed");
    };
    checkFiles();
    const previous = JSON.parse(execute(["versions", "list", "--json"]));
    if (
      !Array.isArray(previous) ||
      (a.purpose === "STAGE"
        ? previous.some((v) => v.versionTag === a.versionTag)
        : previous.filter(
            (v) => v.id === a.versionId && v.versionTag === a.versionTag,
          ).length !== 1)
    )
      throw proofError("international_publish_version_conflict");
    if (new Date() >= proofDate(a.executeBefore))
      throw proofError("international_publish_approval_expired");
    execute(
      a.purpose === "STAGE"
        ? ["deploy", "--no-build", "--no-release", "--version", a.versionTag]
        : ["release", "--version", a.versionTag],
    );
    checkFiles();
    const versions = JSON.parse(execute(["versions", "list", "--json"]));
    if (!Array.isArray(versions))
      throw proofError("international_publish_outcome_unknown");
    const selected = versions.filter((v) => v.versionTag === a.versionTag);
    if (
      selected.length !== 1 ||
      !ID.test(selected[0].id) ||
      (a.purpose === "RELEASE" &&
        (selected[0].id !== a.versionId ||
          selected[0].status !== "active" ||
          versions.filter((v) => v.status === "active").length !== 1))
    )
      throw proofError("international_publish_outcome_unknown");
    const currentServices = await readServices(a, env);
    if (proofHash(services) !== proofHash(currentServices))
      throw proofError("international_deployment_changed");
    const payload = {
      v: PROOF_VERSION,
      id: a.id,
      approvalId: a.id,
      purpose: a.purpose,
      shopDomain: a.shopDomain,
      appId: a.appId,
      headSha: a.headSha,
      runId: artifact.manifest.runId,
      runAttempt: artifact.manifest.runAttempt,
      artifactId: a.artifactId,
      contentDigest: a.contentDigest,
      archiveDigest: a.archiveDigest,
      deploymentDigest: artifact.manifest.deploymentDigest,
      versionId: selected[0].id,
      versionTag: a.versionTag,
      startedAt: started.toISOString(),
      completedAt: new Date().toISOString(),
      executeBefore: a.executeBefore,
      allowedUseUntil: a.allowedUseUntil,
      ...services,
      migrationVersion: PROOF_SCHEMA_MIGRATION_VERSION,
    };
    return signProofPayload(
      "publisher",
      payload,
      env.INTERNATIONAL_PROOF_PUBLISHER_KEY_ID,
      env.INTERNATIONAL_PROOF_PUBLISHER_PRIVATE_KEY,
    );
  } finally {
    const target = fs.realpathSync(directory);
    const parent = fs.realpathSync(os.tmpdir());
    if (
      path.dirname(target) !== parent ||
      !path.basename(target).startsWith("international-publisher-")
    )
      throw proofError("international_publisher_cleanup_unsafe");
    fs.rmSync(target, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--execute")
      throw proofError("explicit_publish_execution_required");
    const inputPath = process.argv[3];
    if (fs.statSync(inputPath).size > 32000) throw proofError();
    const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    shape(input, ["approval", "stageReceipt"], 32000);
    console.log(JSON.stringify(await publishInternationalProof(input)));
  } catch {
    console.error("international_publish_failed_or_unverified");
    process.exitCode = 1;
  }
}
