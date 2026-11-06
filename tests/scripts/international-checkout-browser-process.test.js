import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createManagedCheckoutBrowserProcess } from "../../scripts/international-checkout-browser-process.mjs";
import { checkoutBrowserFixture } from "../helpers/internationalCheckoutBrowserFixture.js";

async function fixture({ reply, prepare, read } = {}) {
  const f = checkoutBrowserFixture(),
    messages = [];
  let options;
  const child = new EventEmitter();
  child.connected = true;
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.connected = false;
    child.emit("exit", 0);
    return true;
  };
  child.send = (message, callback) => {
    messages.push(message);
    callback?.(null);
    setImmediate(() => {
      if (message.intent === "close") {
        child.emit("message", { ok: true, closed: true });
        child.kill();
      } else if (message.intent === "init")
        child.emit("message", {
          ok: true,
          initialized: true,
          browserVersion: "fixture",
        });
      else
        child.emit(
          "message",
          reply || {
            ok: true,
            observation: {
              stage: "CHECKOUT_INTERACTION",
              outcome: "ALLOWED",
              evidenceHash: "a".repeat(64),
              sessionHash: "b".repeat(64),
            },
          },
        );
    });
  };
  const process = await createManagedCheckoutBrowserProcess({
    shopDomain: "browser.myshopify.com",
    environment: "ISOLATED_STORE",
    spawn: (_file, _args, opts) => {
      options = opts;
      return child;
    },
    prepare:
      prepare || (async () => ({ url: f.url, reference: "local-reference" })),
    read: read || (async () => f.facts),
  });
  const input = {
    runId: "process-test",
    shopDomain: "browser.myshopify.com",
    row: f.row,
    phase: "OPEN",
    generation: 2,
    challengeExpiresAt: new Date(Date.now() + 60000).toISOString(),
    signal: new AbortController().signal,
  };
  return { f, input, child, process, messages, options };
}
test("child process is credential-free, memory bounded, private-profile and IPC-only with no raw output", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.deepEqual(f.options.execArgv, ["--max-old-space-size=128"]);
    assert.equal(f.options.serialization, "json");
    assert.equal(f.options.windowsHide, true);
    assert.equal((await f.process.observe(f.input)).outcome, "ALLOWED");
    assert.equal(f.messages.at(-1).observation.signal, undefined);
    assert.equal(
      Object.keys(f.messages.at(-1).observation.session).sort().join(),
      "facts,url",
    );
    assert.equal(f.process.descriptor.qualification, "UNQUALIFIED");
  } finally {
    await f.process.close();
  }
  assert.equal(fs.existsSync(f.options.cwd), false);
});
test("unknown caller fields, foreign URLs and injected PII facts never reach the child", async () => {
  for (const mode of ["input", "url", "facts"]) {
    const f = await fixture({
      prepare:
        mode === "url"
          ? async () => ({
              url: "https://example.test/canary",
              reference: "reference",
            })
          : undefined,
      read:
        mode === "facts"
          ? async () => ({ customerEmail: "canary" })
          : undefined,
    });
    try {
      await assert.rejects(
        f.process.observe({
          ...f.input,
          ...(mode === "input" ? { privateKey: "canary" } : {}),
        }),
      );
      assert.equal(f.messages.length, 1);
    } finally {
      await f.process.close();
    }
  }
});
test("child response is schema-checked before signing and raw error content is not forwarded", async () => {
  const f = await fixture({
    reply: {
      ok: true,
      observation: {
        stage: "CHECKOUT_INTERACTION",
        outcome: "ALLOWED",
        evidenceHash: "a".repeat(64),
        sessionHash: "b".repeat(64),
        rawHtml: "canary",
      },
    },
  });
  try {
    await assert.rejects(
      f.process.observe(f.input),
      (e) => !e.message.includes("canary"),
    );
  } finally {
    await f.process.close();
  }
});
test("aborted observation, child exit and repeated close do not leak pending requests or profiles", async () => {
  const f = await fixture(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.process.observe({ ...f.input, signal: controller.signal }),
  );
  f.child.kill();
  await f.process.close();
  await f.process.close();
  assert.equal(fs.existsSync(f.options.cwd), false);
});
test("concurrent observations cannot provision a second session while the first provider read is pending", async () => {
  let release,
    calls = 0;
  const f = await fixture({
    prepare: async () => {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        url: "https://browser.myshopify.com/checkouts/cn/abcdefghijklmnop",
        reference: "reference",
      };
    },
  });
  try {
    const first = f.process.observe(f.input);
    await assert.rejects(f.process.observe(f.input));
    assert.equal(calls, 1);
    release();
    await first;
  } finally {
    await f.process.close();
  }
});
