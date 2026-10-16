import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  canonicalProof,
  proofError,
  byteHash,
} from "../app/utils/internationalProofContract.js";
import { boundedProofBody } from "../app/services/internationalProofGitHub.server.js";

const CONFIG = {
  deployment: [
    "/internal/international-deployment-runner",
    "INTERNATIONAL_PROOF_DEPLOYMENT_RUNNER_TOKEN",
  ],
  observer: [
    "/internal/international-proof-observer",
    "INTERNATIONAL_PROOF_OBSERVER_TOKEN",
  ],
  publisher: [
    "/internal/international-proof-receipts",
    "INTERNATIONAL_PROOF_PUBLISHER_INGEST_TOKEN",
  ],
};
export function createInternationalAgentTransport(
  purpose,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const config = CONFIG[purpose];
  let base;
  try {
    base = new URL(env.INTERNATIONAL_PROOF_APP_ORIGIN);
  } catch {
    throw proofError("international_agent_unconfigured");
  }
  if (
    !config ||
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    !/^[a-f0-9]{64}$/.test(env[config[1]] || "")
  )
    throw proofError("international_agent_unconfigured");
  return async (body, leaseToken) => {
    const bytes = canonicalProof(body);
    if (Buffer.byteLength(bytes) > 32000)
      throw proofError("international_input_limit");
    const response = await fetchImpl(new URL(config[0], base), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env[config[1]]}`,
        ...(leaseToken ? { "X-International-Lease": leaseToken } : {}),
      },
      body: bytes,
    });
    const value = JSON.parse(
      (await boundedProofBody(response, 32000)).toString("utf8"),
    );
    if (!response.ok || value.ok !== true)
      throw proofError("international_agent_request_failed");
    return value;
  };
}
export function signInternationalAgentObservation(
  input,
  { env = process.env, spawn = spawnSync } = {},
) {
  const keys = [
    "PATH",
    "SystemRoot",
    "SHOPIFY_API_KEY",
    "INTERNATIONAL_PROOF_RENDER_READ_TOKEN",
    "INTERNATIONAL_PROOF_WEB_SERVICE",
    "INTERNATIONAL_PROOF_CRON_SERVICE",
    "INTERNATIONAL_PROOF_SHOPIFY_READ_TOKEN",
    "INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY",
    "INTERNATIONAL_PROOF_OBSERVER_KEY_ID",
  ];
  const result = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("./international-proof-observer.mjs", import.meta.url),
      ),
      "--stdin",
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 32000,
      timeout: 55000,
      shell: false,
      windowsHide: true,
      env: Object.fromEntries(
        keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
      ),
    },
  );
  if (result.error || result.status !== 0)
    throw proofError(
      result.stderr?.trim() === "international_deployment_changed"
        ? "international_deployment_changed"
        : "international_observation_unavailable",
    );
  return JSON.parse(result.stdout);
}
export async function runInternationalProofAgentOnce(
  purpose,
  {
    transport = createInternationalAgentTransport(purpose),
    observe = signInternationalAgentObservation,
  } = {},
) {
  if (!["deployment", "observer"].includes(purpose))
    throw proofError("international_intent_invalid");
  const next = await transport({ intent: "next" });
  if (!next.task) return { processed: 0 };
  const runId = next.task.runId;
  const task = await transport({
    intent: purpose === "deployment" ? "claim" : "challenge",
    runId,
  });
  const nonce = purpose === "deployment" ? task.observationNonce : task.nonce;
  let observation;
  try {
    observation = await observe({
      runId,
      receipt: task.receipt,
      nonce,
      sequence: task.sequence,
    });
  } catch (error) {
    const code =
      error?.code === "international_deployment_changed"
        ? error.code
        : "international_observation_unavailable";
    const failure =
      purpose === "deployment"
        ? {
            intent: "fail",
            runId,
            code,
          }
        : {
            intent: "reportFailure",
            runId,
            nonceHash: byteHash(Buffer.from(nonce)),
            sequence: task.sequence,
            code,
          };
    await transport(failure, task.leaseToken);
    return { processed: 0, failed: 1 };
  }
  const body = {
    intent: purpose === "deployment" ? "complete" : "record",
    runId,
    observation,
  };
  // Retry only the same signed result after a lost response, never a fresh claim.
  let result;
  try {
    result = await transport(body, task.leaseToken);
  } catch {
    result = await transport(body, task.leaseToken);
  }
  return { processed: result.ok ? 1 : 0 };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [purpose, mode, file] = process.argv.slice(2);
    if (
      purpose === "publisher" &&
      mode === "--deliver" &&
      file &&
      process.argv.length === 5
    ) {
      if (statSync(file).size > 24000)
        throw proofError("international_input_limit");
      await createInternationalAgentTransport(purpose)(
        JSON.parse(readFileSync(file, "utf8")),
      );
      console.log(
        "International receipt delivery accepted; sale readiness unchanged.",
      );
    } else {
      if (
        !["deployment", "observer"].includes(purpose) ||
        !["--once", "--loop"].includes(mode) ||
        process.argv.length !== 4
      )
        throw proofError("international_intent_invalid");
      const deadline = Date.now() + (mode === "--loop" ? 600000 : 0);
      let processed = 0;
      do {
        const result = await runInternationalProofAgentOnce(purpose);
        processed += result.processed;
        if (mode === "--once" || Date.now() + 240000 >= deadline) break;
        await sleep(15000);
      } while (Date.now() + 240000 < deadline);
      console.log(
        `International proof agent completed: processed=${processed}`,
      );
    }
  } catch {
    console.error("international_proof_agent_failed");
    process.exitCode = 1;
  }
}
