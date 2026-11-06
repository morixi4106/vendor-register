import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeRuntime } from "./security/node-runtime.mjs";
import { shape, ID } from "../app/utils/internationalProofContract.js";
import {
  browserError,
  checkoutSessionKey,
  checkoutSessionUrl,
  validateCheckoutBrowserFacts,
} from "./international-checkout-browser-policy.mjs";

export function checkoutBrowserChildEnvironment(home, source = process.env) {
  const system = [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
  ];
  return {
    ...Object.fromEntries(
      system.filter((key) => source[key]).map((key) => [key, source[key]]),
    ),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    // Only the separately installed browser cache location may cross this boundary.
    ...(source.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: source.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
  };
}

// prepare/read are reviewed parent-process adapters, never HTTP-supplied functions or URLs.
export async function createManagedCheckoutBrowserProcess({
  shopDomain,
  environment,
  prepare,
  read,
  spawn = fork,
}) {
  assertNodeRuntime();
  if (
    typeof prepare !== "function" ||
    typeof read !== "function" ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || "") ||
    !["ISOLATED_STORE", "LIVE_STORE"].includes(environment)
  )
    browserError();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oja-checkout-browser-"));
  const child = spawn(
    fileURLToPath(
      new URL("./international-checkout-browser-worker.mjs", import.meta.url),
    ),
    [],
    {
      cwd: home,
      env: checkoutBrowserChildEnvironment(home),
      execArgv: ["--max-old-space-size=128"],
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    },
  );
  const sessions = new Map();
  let pending = null,
    stopped = false,
    runId = null,
    observing = false;
  const rejectPending = () => {
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(new Error("international_checkout_not_observed"));
    }
  };
  child.on("error", rejectPending);
  child.on("exit", rejectPending);
  child.on("message", (value) => {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (Buffer.byteLength(JSON.stringify(value)) > 4096 || value?.ok !== true)
      p.reject(new Error("international_checkout_not_observed"));
    else p.resolve(value);
  });
  const rpc = (message, signal, timeout = 30000) =>
    new Promise((resolve, reject) => {
      if (stopped || pending || signal?.aborted || !child.connected) {
        reject(new Error("international_checkout_not_observed"));
        return;
      }
      const abort = () => {
        rejectPending();
        child.kill();
      };
      const timer = setTimeout(abort, timeout);
      const done = (fn) => (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      pending = { resolve: done(resolve), reject: done(reject) };
      signal?.addEventListener("abort", abort, { once: true });
      child.send(message, (error) => {
        if (error) rejectPending();
      });
    });
  const close = async () => {
    if (stopped) return;
    rejectPending();
    try {
      if (child.connected) await rpc({ intent: "close" }, null, 4000);
    } catch {
      child.kill();
    } finally {
      stopped = true;
      sessions.clear();
      if (child.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill();
            resolve();
          }, 1000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  try {
    await rpc({ intent: "init", shopDomain, environment }, null, 25000);
  } catch {
    await close();
    browserError();
  }
  return {
    close,
    async observe(input) {
      shape(
        input,
        [
          "runId",
          "shopDomain",
          "row",
          "phase",
          "generation",
          "challengeExpiresAt",
          "signal",
        ],
        8192,
      );
      if (
        stopped ||
        observing ||
        (runId && runId !== input.runId) ||
        input.shopDomain !== shopDomain ||
        !input.signal ||
        input.signal.aborted ||
        !ID.test(input.runId || "") ||
        input.phase !== input.row?.phase ||
        !Number.isInteger(input.generation) ||
        input.generation < 1 ||
        !Number.isFinite(Date.parse(input.challengeExpiresAt)) ||
        Date.parse(input.challengeExpiresAt) <= Date.now()
      )
        browserError();
      observing = true;
      try {
        runId = input.runId;
        const key = checkoutSessionKey(input.row);
        const old = input.row.scenario === "old-checkout-blocked";
        const session = old
          ? sessions.get(key)
          : await prepare({ row: input.row, signal: input.signal });
        shape(session, ["url", "reference"], 4096);
        checkoutSessionUrl(session.url, shopDomain);
        if (
          typeof session.reference !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(session.reference)
        )
          browserError();
        const facts = await read({
          reference: session.reference,
          row: input.row,
          signal: input.signal,
        });
        validateCheckoutBrowserFacts(facts, input.row);
        if (!old && input.row.scenario === "allowed-before-payment")
          sessions.set(key, session);
        const { signal, ...body } = input;
        const result = await rpc(
          {
            intent: "observe",
            observation: { ...body, session: { url: session.url, facts } },
          },
          signal,
        );
        shape(result, ["ok", "observation"], 4096);
        shape(
          result.observation,
          ["stage", "outcome", "evidenceHash", "sessionHash"],
          1024,
        );
        // Validate transport privacy before handing an observation to the signer.
        if (
          !/^[a-f0-9]{64}$/.test(result.observation.evidenceHash || "") ||
          !/^[a-f0-9]{64}$/.test(result.observation.sessionHash || "")
        )
          browserError();
        return result.observation;
      } finally {
        observing = false;
      }
    },
    descriptor: Object.freeze({
      environment,
      providerConfigured: true,
      qualification: "UNQUALIFIED",
    }),
  };
}
