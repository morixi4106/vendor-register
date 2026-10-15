import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(
  script,
  {
    mode = "prelaunch",
    endpointFailure = false,
    extraCritical = false,
    at = "2026-10-15T01:00:00Z",
    args = [],
    to = "operator@example.test",
  } = {},
) {
  const fixture = { endpointFailure, extraCritical, at };
  const bootstrap = `
    const fixture = ${JSON.stringify(fixture)};
    const OriginalDate = Date;
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [fixture.at])); }
      static now() { return OriginalDate.parse(fixture.at); }
    };
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.hostname === "api.resend.com") {
        console.log("PROVIDER_REQUEST " + JSON.stringify({key:new Headers(options.headers).get("idempotency-key"),body:JSON.parse(options.body)}));
        return Response.json({id:"message-1"});
      }
      if (url.hostname === "api.render.com") return Response.json({logs:[],hasMore:false});
      if (url.pathname === "/internal/launch-monitor") {
        if (fixture.endpointFailure) return Response.json({ok:false},{status:500});
        const checks=[{id:"official_storefront",status:"critical",code:"password_page",count:1}];
        if (fixture.extraCritical) checks.push({id:"database_connection",status:"critical",code:"database_failed",count:1});
        return Response.json({ok:true,schemaVersion:1,active:true,status:"critical",checks,notificationKind:null});
      }
      if (url.pathname === "/internal/launch-monitor-deadman") {
        if (fixture.endpointFailure) return Response.json({ok:false},{status:500});
        return Response.json({ok:false,schemaVersion:1,status:"stale",ageMinutes:180});
      }
      if (url.hostname === "app.example.test") return new Response(null,{status:302,headers:{location:"https://store.example.test/"}});
      if (url.hostname === "store.example.test") {
        const response = new Response("Oja Example");
        Object.defineProperty(response,"url",{value:"https://store.example.test/password"});
        return response;
      }
      throw new Error("unexpected_mock_request");
    };
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript;base64,${Buffer.from(bootstrap).toString("base64")}`,
      `scripts/${script}`,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        LAUNCH_MONITOR_NOTIFICATION_MODE: mode,
        LAUNCH_MONITOR_URL: "https://app.example.test",
        LAUNCH_MONITOR_TOKEN: "test-token-".repeat(4),
        LAUNCH_MONITOR_DEADMAN_TOKEN: "test-deadman-".repeat(4),
        LAUNCH_MONITOR_EXPECTED_ROOT_LOCATION: "https://store.example.test/",
        LAUNCH_MONITOR_STOREFRONT_URL: "https://store.example.test/",
        LAUNCH_MONITOR_STOREFRONT_MARKER: "Oja Example",
        RENDER_API_KEY: "render-test",
        RENDER_OWNER_ID: "owner-test",
        RENDER_SERVICE_ID: "service-test",
        MAINTENANCE_BACKUP_CHECK_ENABLED: "false",
        RESEND_API_KEY: "re_test",
        MAIL_FROM: "monitor@example.test",
        ADMIN_EMAIL: to,
      },
    },
  );
  assert.equal(result.error, undefined);
  const messages = result.stdout
    .split(/\r?\n/)
    .filter((x) => x.startsWith("PROVIDER_REQUEST "))
    .map((x) => JSON.parse(x.slice("PROVIDER_REQUEST ".length)));
  const reports = result.stdout
    .split(/\r?\n/)
    .filter((x) => x.startsWith("{"))
    .map((x) => JSON.parse(x));
  return { ...result, messages, reports };
}

test("prelaunch password findings complete a job without claiming sales readiness or sending mail", () => {
  const result = run("launch-monitor-agent.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.messages.length, 0);
  assert.equal(result.reports[0].ok, false);
  assert.equal(result.reports[0].status, "critical");
  assert.equal(result.reports[0].prelaunchOnly, true);
  assert.equal(Object.hasOwn(result.reports[0], "salesReady"), false);
  assert.equal(result.reports[0].expectedPrelaunchFindings, true);
});

test("real critical findings and transport failures still fail but do not send prelaunch mail", () => {
  for (const config of [{ extraCritical: true }, { endpointFailure: true }]) {
    const result = run("launch-monitor-agent.mjs", config);
    assert.notEqual(result.status, 0);
    assert.equal(result.messages.length, 0);
  }
});

test("legacy explicit delivery-proof verification cannot pass without an actual alert", () => {
  const result = run("launch-monitor-agent.mjs", {
    args: ["--expect-password-critical"],
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.messages.length, 0);
});

test("live password protection remains a critical process result", () => {
  const result = run("launch-monitor-agent.mjs", { mode: "live" });
  assert.notEqual(result.status, 0);
  assert.equal(result.reports[0].status, "critical");
  assert.equal(result.reports[0].expectedPrelaunchFindings, false);
});

test("prelaunch external-monitor staleness is recorded, not turned into a failure-email loop", () => {
  const result = run("launch-monitor-deadman.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.messages.length, 0);
  assert.equal(result.reports[0].ok, false);
  assert.equal(result.reports[0].status, "stale");
  assert.equal(result.reports[0].mailSuppressed, true);
});

test("broken deadman transport still fails silently in prelaunch", () => {
  const result = run("launch-monitor-deadman.mjs", { endpointFailure: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.messages.length, 0);
});

for (const script of [
  "launch-monitor-agent.mjs",
  "launch-monitor-deadman.mjs",
]) {
  test(`${script} live fallbacks deduplicate the same daily payload without conflicting bodies`, () => {
    const options = { mode: "live", endpointFailure: true };
    const first = run(script, options).messages[0];
    const repeat = run(script, { ...options, at: "2026-10-15T13:00:00Z" })
      .messages[0];
    const tomorrow = run(script, { ...options, at: "2026-10-16T01:00:00Z" })
      .messages[0];
    const rerouted = run(script, { ...options, to: "backup@example.test" })
      .messages[0];
    assert.ok(first);
    assert.deepEqual(first, repeat);
    assert.notEqual(first.key, tomorrow.key);
    assert.notEqual(first.key, rerouted.key);
    assert.ok(first.key.length <= 256);
    assert.ok(!first.key.includes("example.test"));
  });
}
