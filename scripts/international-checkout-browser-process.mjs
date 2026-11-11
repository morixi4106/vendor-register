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
  CHECKOUT_BROWSER_MAX_SESSIONS,
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
  let child;
  try {
    child = spawn(
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
  } catch {
    fs.rmSync(home, { recursive: true, force: true });
    browserError();
  }
  const sessions = new Map();
  const provisionedCases = new Set(),
    identities = new Set();
  let pending = null,
    stopped = false,
    exited = false,
    broken = false,
    closing,
    active,
    runId = null,
    observing = false;
  const rejectPending = () => {
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(new Error("international_checkout_not_observed"));
    }
  };
  const childEnded = () => {
    exited = true;
    active?.abort();
    rejectPending();
  };
  child.on("error", () => {
    broken = true;
    active?.abort();
    rejectPending();
    // A channel error is not proof that the process exited.
    child.kill();
  });
  child.on("exit", childEnded);
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
      if (
        (stopped && message.intent !== "close") ||
        broken ||
        exited ||
        pending ||
        signal?.aborted ||
        !child.connected
      ) {
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
  const close = () => {
    if (closing) return closing;
    stopped = true;
    active?.abort();
    rejectPending();
    closing = (async () => {
      try {
        if (broken && !exited) child.kill();
        else if (child.connected && !exited)
          await rpc({ intent: "close" }, null, 3000);
      } catch {
        child.kill();
      } finally {
        sessions.clear();
        provisionedCases.clear();
        identities.clear();
        if (!exited && child.exitCode === null) {
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
    })();
    return closing;
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
        broken ||
        exited ||
        observing ||
        (runId && runId !== input.runId) ||
        input.shopDomain !== shopDomain ||
        !(input.signal instanceof AbortSignal) ||
        input.signal.aborted ||
        !ID.test(input.runId || "") ||
        input.phase !== input.row?.phase ||
        !Number.isSafeInteger(input.generation) ||
        input.generation < 1 ||
        !Number.isFinite(Date.parse(input.challengeExpiresAt)) ||
        Date.parse(input.challengeExpiresAt) <= Date.now()
      )
        browserError();
      observing = true;
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        abort,
        Math.min(25000, Date.parse(input.challengeExpiresAt) - Date.now()),
      );
      // Provider code must honor this signal. The race also rejects providers that ignore it;
      // a late result cannot be forwarded to read(), the browser, or the signer.
      const bounded = async (operation) => {
        if (stopped || exited || controller.signal.aborted) browserError();
        let rejectAbort;
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => {
              if (stopped || exited || controller.signal.aborted)
                browserError();
              return operation(controller.signal);
            }),
            new Promise((_, reject) => {
              rejectAbort = () =>
                reject(new Error("international_checkout_not_observed"));
              controller.signal.addEventListener("abort", rejectAbort, {
                once: true,
              });
            }),
          ]);
          if (stopped || exited || controller.signal.aborted) browserError();
          return result;
        } finally {
          controller.signal.removeEventListener("abort", rejectAbort);
        }
      };
      try {
        runId = input.runId;
        const key = checkoutSessionKey(input.row);
        const old = input.row.scenario === "old-checkout-blocked";
        if (input.row.target.country === "GB") browserError();
        if (!old) {
          if (
            provisionedCases.size >= CHECKOUT_BROWSER_MAX_SESSIONS ||
            provisionedCases.has(input.row.caseKey)
          )
            browserError();
          provisionedCases.add(input.row.caseKey);
        }
        const retained = old ? sessions.get(key) : null;
        if (old && (!retained || retained.generation + 1 !== input.generation))
          browserError();
        const session = old
          ? retained.session
          : await bounded((signal) => prepare({ row: input.row, signal }));
        shape(session, ["url", "reference"], 4096);
        const parsed = checkoutSessionUrl(session.url, shopDomain);
        const identity = `${parsed.origin}${parsed.pathname}`;
        if (!old) {
          if (identities.has(identity)) browserError();
          identities.add(identity);
        }
        if (
          typeof session.reference !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(session.reference)
        )
          browserError();
        const facts = await bounded((signal) =>
          read({
            reference: session.reference,
            row: input.row,
            signal,
          }),
        );
        validateCheckoutBrowserFacts(facts, input.row);
        if (!old && input.row.scenario === "allowed-before-payment")
          sessions.set(key, { session, generation: input.generation });
        const { signal: _callerSignal, ...body } = input;
        const result = await rpc(
          {
            intent: "observe",
            observation: { ...body, session: { url: session.url, facts } },
          },
          controller.signal,
        );
        shape(result, ["ok", "observation"], 4096);
        shape(
          result.observation,
          ["stage", "outcome", "evidenceHash", "sessionHash"],
          1024,
        );
        // Validate transport privacy before handing an observation to the signer.
        if (
          !["CHECKOUT_INTERACTION", "NOT_OBSERVED"].includes(
            result.observation.stage,
          ) ||
          !["ALLOWED", "REJECTED", "NOT_OBSERVED"].includes(
            result.observation.outcome,
          ) ||
          (result.observation.stage === "NOT_OBSERVED") !==
            (result.observation.outcome === "NOT_OBSERVED") ||
          !/^[a-f0-9]{64}$/.test(result.observation.evidenceHash || "") ||
          !/^[a-f0-9]{64}$/.test(result.observation.sessionHash || "")
        )
          browserError();
        if (controller.signal.aborted || stopped || exited) browserError();
        return result.observation;
      } catch {
        await close();
        browserError();
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        controller.abort();
        active = null;
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
