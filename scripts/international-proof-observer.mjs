import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parse } from "toml";
import { renderServices } from "./international-proof-publisher.mjs";
import {
  proofError,
  shape,
  ID,
  HASH,
  byteHash,
  proofHash,
  proofDate,
  signProofPayload,
  verifyProofSignature,
  PROOF_VERSION,
  INTERNATIONAL_PROOF_TRUST,
} from "../app/utils/internationalProofContract.js";

export async function observeInternationalProof(
  input,
  {
    env = process.env,
    spawn = spawnSync,
    readServices = renderServices,
    trust = INTERNATIONAL_PROOF_TRUST,
    configPath = path.resolve("shopify.app.production.toml"),
  } = {},
) {
  shape(input, ["runId", "receipt", "nonce", "sequence"], 32000);
  if (
    !ID.test(input.runId) ||
    !HASH.test(input.nonce) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !env.INTERNATIONAL_PROOF_SHOPIFY_READ_TOKEN ||
    !env.INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY ||
    !env.INTERNATIONAL_PROOF_OBSERVER_KEY_ID
  )
    throw proofError("international_observer_unconfigured");
  const now = new Date();
  const receipt = verifyProofSignature(input.receipt, "publisher", now, trust);
  if (
    receipt.v !== PROOF_VERSION ||
    receipt.purpose !== "RELEASE" ||
    receipt.appId !== env.SHOPIFY_API_KEY ||
    proofDate(receipt.allowedUseUntil) <= now
  )
    throw proofError("international_receipt_untrusted");
  verifyProofSignature(
    signProofPayload(
      "observer",
      { test: true },
      env.INTERNATIONAL_PROOF_OBSERVER_KEY_ID,
      env.INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY,
    ),
    "observer",
    now,
    trust,
  );
  const config = fs.readFileSync(configPath);
  if (
    config.length > 262144 ||
    parse(config.toString("utf8")).client_id !== receipt.appId
  )
    throw proofError("international_app_mismatch");
  const serviceInput = {
    ...receipt,
    webServiceId: receipt.web.serviceId,
    cronServiceId: receipt.cron.serviceId,
  };
  const services = await readServices(serviceInput, env);
  if (
    proofHash(services.web) !== proofHash(receipt.web) ||
    proofHash(services.cron) !== proofHash(receipt.cron)
  )
    throw proofError("international_deployment_changed");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "international-observer-"),
  );
  try {
    fs.writeFileSync(
      path.join(directory, "shopify.app.production.toml"),
      config,
      { flag: "wx" },
    );
    const args = [
      path.resolve("node_modules/@shopify/cli/bin/run.js"),
      "app",
      "versions",
      "list",
      "--json",
      "--config",
      "production",
      "--client-id",
      receipt.appId,
      "--path",
      directory,
      "--no-color",
    ];
    const result = spawn(process.execPath, args, {
      cwd: directory,
      shell: false,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 262144,
      encoding: "utf8",
      env: {
        PATH: env.PATH,
        SystemRoot: env.SystemRoot,
        HOME: directory,
        USERPROFILE: directory,
        CI: "true",
        SHOPIFY_CLI_PARTNERS_TOKEN: env.INTERNATIONAL_PROOF_SHOPIFY_READ_TOKEN,
      },
    });
    if (result.error || result.status !== 0)
      throw proofError("international_deployment_unverified");
    const versions = JSON.parse(result.stdout);
    if (!Array.isArray(versions))
      throw proofError("international_deployment_unverified");
    const active = versions.filter((v) => v.status === "active");
    if (
      active.length !== 1 ||
      active[0].id !== receipt.versionId ||
      active[0].versionTag !== receipt.versionTag
    )
      throw proofError("international_deployment_changed");
    const observedAt = new Date();
    if (observedAt - now > 60000)
      throw proofError("international_deployment_unverified");
    return signProofPayload(
      "observer",
      {
        v: PROOF_VERSION,
        runId: input.runId,
        receiptId: receipt.id,
        shopDomain: receipt.shopDomain,
        appId: receipt.appId,
        versionId: receipt.versionId,
        versionTag: receipt.versionTag,
        ...services,
        sequence: input.sequence,
        nonceHash: byteHash(Buffer.from(input.nonce)),
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(+now + 900000).toISOString(),
      },
      env.INTERNATIONAL_PROOF_OBSERVER_KEY_ID,
      env.INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY,
    );
  } finally {
    const target = fs.realpathSync(directory);
    if (
      path.dirname(target) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(target).startsWith("international-observer-")
    )
      throw proofError("international_observer_cleanup_unsafe");
    fs.rmSync(target, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3 || fs.statSync(process.argv[2]).size > 32000)
      throw proofError();
    console.log(
      JSON.stringify(
        await observeInternationalProof(
          JSON.parse(fs.readFileSync(process.argv[2], "utf8")),
        ),
      ),
    );
  } catch {
    console.error("international_proof_observation_failed");
    process.exitCode = 1;
  }
}
