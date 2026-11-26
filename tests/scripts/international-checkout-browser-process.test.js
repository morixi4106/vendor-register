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
      assert.equal(
        f.messages.filter((message) => message.intent === "init").length,
        1,
      );
      assert.ok(
        f.messages.every((message) =>
          ["init", "close"].includes(message.intent),
        ),
      );
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
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(f.process.observe(f.input));
    assert.equal(calls, 1);
    release();
    await first;
  } finally {
    await f.process.close();
  }
});

for (const mode of ["prepare", "read", "close", "exit"]) {
  test(`pending provider ${mode} is cancelled; late resolution cannot create another operation`, async () => {
    let release,
      providerSignal,
      reads = 0;
    const hold = async ({ signal }) => {
      providerSignal = signal;
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        url: "https://browser.myshopify.com/checkouts/cn/abcdefghijklmnop",
        reference: "reference",
      };
    };
    const f = await fixture({
      prepare: mode === "read" ? undefined : hold,
      read: async (input) => {
        reads++;
        if (mode === "read") await hold(input);
        return checkoutBrowserFixture().facts;
      },
    });
    const controller = new AbortController();
    const pending = f.process.observe({
      ...f.input,
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      pending,
      (e) => e.message === "international_checkout_not_observed",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(release);
    if (mode === "close") await f.process.close();
    else if (mode === "exit") f.child.kill();
    else controller.abort();
    await rejected;
    assert.equal(providerSignal.aborted, true);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, mode === "read" ? 1 : 0);
    assert.ok(!f.messages.some((message) => message.intent === "observe"));
    await assert.rejects(f.process.observe(f.input));
    await f.process.close();
    assert.equal(fs.existsSync(f.options.cwd), false);
  });
}

test("provider errors are sanitized and retire the process rather than allowing uncertain retries", async () => {
  const f = await fixture({
    prepare: async () => {
      throw new Error("private URL token canary");
    },
  });
  await assert.rejects(
    f.process.observe(f.input),
    (e) => e.message === "international_checkout_not_observed",
  );
  await assert.rejects(f.process.observe(f.input));
  await f.process.close();
  assert.equal(fs.existsSync(f.options.cwd), false);
});

test("duplicate cases are refused before provisioning and duplicate URL identities before provider read", async () => {
  for (const mode of ["case", "identity"]) {
    let prepares = 0,
      reads = 0;
    const f = await fixture({
      prepare: async () => {
        prepares++;
        return {
          url: "https://browser.myshopify.com/checkouts/cn/abcdefghijklmnop?locale=ja",
          reference: "ref",
        };
      },
      read: async () => {
        reads++;
        return checkoutBrowserFixture().facts;
      },
    });
    assert.equal((await f.process.observe(f.input)).outcome, "ALLOWED");
    const row =
      mode === "case"
        ? f.input.row
        : f.f.plan.cases.find((row) => row.scenario === "new-checkout-blocked");
    await assert.rejects(
      f.process.observe({
        ...f.input,
        row,
        phase: row.phase,
        generation: mode === "case" ? 2 : 3,
      }),
    );
    assert.equal(prepares, mode === "case" ? 1 : 2);
    assert.equal(reads, 1);
    await f.process.close();
  }
});

test("the 257th session is refused before invoking the provider, independent of child behavior", async () => {
  const { proofHash } =
    await import("../../app/utils/internationalProofContract.js");
  let prepares = 0;
  const f = await fixture({
    prepare: async () => ({
      url: `https://browser.myshopify.com/checkouts/cn/sessionnumber${String(++prepares).padStart(8, "0")}`,
      reference: "ref",
    }),
  });
  for (let index = 0; index < 256; index++) {
    const { caseKey: _key, ...body } = f.input.row;
    body.target = { ...body.target, methodId: `method-${index}` };
    const row = { ...body, caseKey: proofHash(body) };
    await f.process.observe({ ...f.input, row });
  }
  const { caseKey: _key, ...body } = f.input.row;
  body.target = { ...body.target, methodId: "overflow" };
  await assert.rejects(
    f.process.observe({
      ...f.input,
      row: { ...body, caseKey: proofHash(body) },
    }),
  );
  assert.equal(prepares, 256);
  await f.process.close();
});

test("simultaneous close calls share cleanup and an exited child cannot trigger provider work", async () => {
  let prepares = 0;
  const f = await fixture({
    prepare: async () => {
      prepares++;
      throw new Error("must not prepare");
    },
  });
  f.child.kill();
  await assert.rejects(f.process.observe(f.input));
  assert.equal(prepares, 0);
  const first = f.process.close(),
    second = f.process.close();
  assert.equal(first, second);
  await first;
  assert.equal(fs.existsSync(f.options.cwd), false);
});

for (const mode of ["prepare", "read"]) {
  test(`challenge deadline bounds a ${mode} provider that ignores cancellation`, async () => {
    let signal;
    const hold = async (input) => {
      signal = input.signal;
      return new Promise(() => {});
    };
    const f = await fixture({ [mode]: hold });
    await assert.rejects(
      f.process.observe({
        ...f.input,
        challengeExpiresAt: new Date(Date.now() + 250).toISOString(),
      }),
      (e) => e.message === "international_checkout_not_observed",
    );
    assert.equal(signal.aborted, true);
    assert.ok(!f.messages.some((message) => message.intent === "observe"));
    await f.process.close();
    assert.equal(fs.existsSync(f.options.cwd), false);
  });
}

test("synchronous spawn failure removes its private home and sanitizes the exception", async () => {
  let home;
  await assert.rejects(
    createManagedCheckoutBrowserProcess({
      shopDomain: "browser.myshopify.com",
      environment: "ISOLATED_STORE",
      prepare: async () => {},
      read: async () => {},
      spawn: (_file, _args, options) => {
        home = options.cwd;
        throw new Error("private canary");
      },
    }),
    (e) => e.message === "international_checkout_not_observed",
  );
  assert.equal(fs.existsSync(home), false);
});

test("old-checkout generation mismatch is rejected before independent facts are read", async () => {
  let reads = 0;
  const f = await fixture({
    read: async () => {
      reads++;
      return checkoutBrowserFixture().facts;
    },
  });
  await f.process.observe(f.input);
  const row = f.f.plan.cases.find(
    (row) => row.scenario === "old-checkout-blocked",
  );
  await assert.rejects(
    f.process.observe({ ...f.input, row, phase: "CLOSED", generation: 4 }),
  );
  assert.equal(reads, 1);
  await f.process.close();
});

test("a channel error retires and kills a child but is not mistaken for an exit event", async () => {
  const f = await fixture();
  let kills = 0;
  f.child.kill = () => {
    kills++;
    if (kills === 1) return true;
    setImmediate(() => {
      assert.equal(fs.existsSync(f.options.cwd), true);
      f.child.exitCode = 0;
      f.child.connected = false;
      f.child.emit("exit", 0);
    });
    return true;
  };
  f.child.emit("error", new Error("private canary"));
  await assert.rejects(f.process.observe(f.input));
  await f.process.close();
  assert.equal(kills, 2);
  assert.equal(fs.existsSync(f.options.cwd), false);
});
