import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(sha(input.library), input.librarySha256);
assert.equal(sha(input.schema), input.schemaSha256);
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(input.project));
assert.ok(["sqlite", "postgresql"].includes(input.provider));
const url = input.provider === "sqlite" ? `file:${path.join(input.project, "probe.sqlite").replaceAll("\\", "/")}` : (() => {
  assert.equal(process.platform, "linux");
  assert.ok(Number.isInteger(input.postgresPort) && input.postgresPort > 0 && input.postgresPort <= 65535);
  const value = new URL("postgresql://127.0.0.1/oja_probe");
  value.port = String(input.postgresPort);
  value.username = "oja_probe";
  value.password = "oja-ephemeral-test-only";
  value.search = "schema=public&sslmode=disable&connection_limit=1&connect_timeout=5";
  if (input.tls) {
    value.hostname = "localhost";
    value.searchParams.set("sslmode", "require");
    value.searchParams.set("sslaccept", "strict");
    value.searchParams.set("sslcert", input.tls.caFile);
    for (const role of ["ca", "server", "untrustedCa"]) assert.equal(sha(input.tls[`${role}File`]), input.tls[`${role}Sha256`]);
  }
  return value.href;
})();
const env = {
  ...process.env,
  OJA_PRISMA_PROBE_DATABASE_URL: url,
  PRISMA_QUERY_ENGINE_LIBRARY: input.library,
  PRISMA_SCHEMA_ENGINE_BINARY: input.schema,
  PRISMA_CLIENT_ENGINE_TYPE: "library",
  PRISMA_CLI_QUERY_ENGINE_TYPE: "library",
  PRISMA_GENERATE_SKIP_AUTOINSTALL: "1",
  CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", DO_NOT_TRACK: "1",
  OJA_PRISMA_PROBE_INPUT: process.argv[2],
};
for (const name of Object.keys(process.env)) {
  assert.ok(!/^(DATABASE_URL|DIRECT_URL|SHOPIFY_|KOMOJU_|RESEND_|GITHUB_TOKEN|GH_TOKEN)/i.test(name));
}
Object.assign(process.env, env);
const command = (args) => {
  const ledger = path.join(input.project, "schema-engine-invocations.jsonl");
  const before = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").trim().split("\n").length : 0;
  const result = spawnSync(process.execPath, ["--require", input.cliHook, input.cli, ...args, "--config", path.join(input.project, "prisma.config.ts")],
    { cwd: input.project, env, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  // Only synthetic fixture output; never inherit a production URL or dotenv file.
  fs.writeFileSync(path.join(input.project, `${args.join("-")}.log`), (result.stdout || "") + (result.stderr || ""));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  assert.ok(!result.stderr.includes("Environment variables loaded from"));
  if (args[0] === "migrate") {
    const after = fs.readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(after.length > before);
    assert.ok(after.every(item => item.sha256 === input.schemaSha256));
  }
};
const checks = [];
const record = async (name, action) => { await action(); checks.push(name); };
const require = createRequire(import.meta.url);
const loaded = new Set();
const dlopen = process.dlopen;
process.dlopen = function(module, filename, ...args) {
  assert.equal(path.toNamespacedPath(fs.realpathSync(filename)), path.toNamespacedPath(fs.realpathSync(input.library)));
  assert.equal(sha(filename), input.librarySha256);
  loaded.add(input.librarySha256);
  return Reflect.apply(dlopen, this, [module, filename, ...args]);
};
await record("native-identity", () => {
  const native = require(input.library);
  assert.equal(native.version().commit, input.sourceCommit);
  assert.equal(typeof native.QueryEngine, "function");
  const version = spawnSync(input.schema, ["--version"], { env, encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(version.status, 0);
  assert.ok(version.stdout.includes(input.sourceCommit));
});
command(["generate"]);
command(["migrate", "deploy"]);
command(["migrate", "deploy"]);
const { PrismaClient, Prisma } = require(path.join(input.project, "client/index.js"));
assert.equal(Prisma.prismaVersion.client, "6.19.3");
const client = new PrismaClient({ datasourceUrl: url, log: [] });
let scram;
let tls;
let graphql;
try {
  await record("generated-client-native-loader", async () => {
    await client.$connect();
    assert.deepEqual([...loaded], [input.librarySha256]);
    assert.equal(client._engine.versionInfo.commit, input.sourceCommit);
  });
  await record("graphql-depth-limit", async () => {
    const engine = new (require(input.library).QueryEngine)({
      datamodel: fs.readFileSync(path.join(input.project, "schema.prisma"), "utf8"),
      logLevel: "error", logQueries: false, enableTracing: false,
      datasourceOverrides: {}, configDir: input.project,
      env: { OJA_PRISMA_PROBE_DATABASE_URL: url }, ignoreEnvVarErrors: false, engineProtocol: "graphql",
    }, () => {});
    const raw = (sql, block = false) => `mutation {queryRaw(query:${block ? '"""' + sql + '"""' : JSON.stringify(sql)},parameters:"[]")}`;
    const controlQuery = raw("SELECT 1 AS probe");
    const single = query => ({ query, variables: {} });
    let controls = 0;
    const request = async body => JSON.parse(await engine.query(JSON.stringify(body), "{}", undefined, String(1000 + controls)));
    const healthy = result => {
      assert.equal(result.errors, undefined);
      assert.deepEqual(result.data.queryRaw.columns, ["probe"]);
      assert.equal(Number(result.data.queryRaw.rows[0][0]), 1);
    };
    const control = async () => { healthy(await request(single(controlQuery))); controls++; };
    const selection = "{a ".repeat(5000) + "id" + "}".repeat(5000);
    const rejected = [single(selection),
      single("{... on Q ".repeat(5000) + "a" + "}".repeat(5000)),
      single(`{a(v:${"[".repeat(5000)}1${"]".repeat(5000)})}`),
      single(`{a(v:${"{v:".repeat(5000)}1${"}".repeat(5000)})}`),
      single(`query Q($v:${"[".repeat(5000)}Int${"]".repeat(5000)}){a}`),
      { batch: [single(selection)], transaction: false },
    ];
    const delimiters = "{}[]()".repeat(1000);
    const accepted = [raw(`SELECT 1 AS probe /* ${delimiters} */`),
      raw(`SELECT 1 AS probe /* ${delimiters} */`, true), `# ${delimiters}\n${controlQuery}`];
    try {
      await engine.connect("{}", "999");
      for (const body of rejected) {
        await control();
        const result = await request(body);
        assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
        assert.ok(JSON.stringify(result.errors).includes("Recursion limit exceeded"));
        assert.ok(!result.errors.some(error => error.user_facing_error?.is_panic));
        await control();
      }
      for (const query of accepted) { await control(); healthy(await request(single(query))); await control(); }
      const unicode = [
        ["\n   SELECT 'A\n \u2003B' AS probe\n", "A\n\u2003B"],
        ["\n  SELECT 'A\n \u00a0B' AS probe\n", "A\n\u00a0B"],
        ["\r  SELECT 'A\r  B' AS probe\r", "A\nB"],
        ["\n  SELECT 'A\n \u3000\n  B' AS probe\n", "A\n\u3000\n B"],
      ];
      for (const [sql, expected] of unicode) {
        await control();
        const result = await request(single(raw(sql, true)));
        assert.equal(result.errors, undefined);
        assert.deepEqual(result.data.queryRaw.columns, ["probe"]);
        assert.deepEqual(result.data.queryRaw.rows, [[expected]]);
        await control();
      }
      graphql = { maximumNesting: 50, rejected: 6, acceptedLexicalCases: 3, unicodeCases: unicode.length, controlQueries: controls };
      assert.equal(controls, 26);
    } finally { await engine.disconnect("{}", "2000"); }
  });
  await record("migration-history", async () => {
    const rows = await client.$queryRawUnsafe('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name');
    assert.deepEqual(rows.map(row => row.migration_name), ["202611050001_initial", "202611050002_label"]);
    assert.equal(await client.probeRecord.count(), 0);
  });
  await record("crud-and-cuid", async () => {
    const value = await client.probeRecord.create({ data: { key: "native-probe", amount: 2, label: "synthetic" } });
    assert.match(value.id, /^c[a-z0-9]{24}$/);
    assert.equal((await client.probeRecord.update({ where: { id: value.id }, data: { amount: { increment: 3 } } })).amount, 5);
    assert.equal((await client.probeRecord.findUnique({ where: { id: value.id } })).label, "synthetic");
  });
  await record("parameterized-query", async () => {
    const key = "' OR 1=1; --";
    await client.probeRecord.create({ data: { key, amount: 7 } });
    const rows = await client.$queryRaw`SELECT "amount" FROM "ProbeRecord" WHERE "key" = ${key}`;
    assert.equal(rows.length, 1); assert.equal(rows[0].amount, 7);
    assert.equal(await client.probeRecord.count(), 2);
  });
  await record("unique-error", async () => {
    await assert.rejects(client.probeRecord.create({ data: { key: "native-probe" } }), error => error.code === "P2002");
    assert.equal(await client.probeRecord.count(), 2);
  });
  await record("batch-transaction", async () => {
    await client.$transaction([
      client.probeRecord.create({ data: { key: "batch-a" } }),
      client.probeRecord.create({ data: { key: "batch-b" } }),
    ]);
    await assert.rejects(client.$transaction([
      client.probeRecord.create({ data: { key: "batch-rolled-back" } }),
      client.probeRecord.create({ data: { key: "batch-a" } }),
    ]), error => error.code === "P2002");
    assert.equal(await client.probeRecord.findUnique({ where: { key: "batch-rolled-back" } }), null);
  });
  await record("interactive-commit", async () => {
    await client.$transaction(async tx => {
      await tx.probeRecord.create({ data: { key: "interactive" } });
      assert.equal(await tx.probeRecord.count(), 5);
    });
    assert.ok(await client.probeRecord.findUnique({ where: { key: "interactive" } }));
  });
  await record("interactive-rollback", async () => {
    await assert.rejects(client.$transaction(async tx => {
      await tx.probeRecord.create({ data: { key: "interactive-rolled-back" } });
      throw new Error("synthetic_rollback");
    }), /synthetic_rollback/);
    assert.equal(await client.probeRecord.findUnique({ where: { key: "interactive-rolled-back" } }), null);
  });
  await record("reconnect", async () => {
    await client.$disconnect(); await client.$connect();
    assert.equal(await client.probeRecord.count(), 5);
  });
  await record("cleanup", async () => {
    assert.equal((await client.probeRecord.deleteMany()).count, 5);
    assert.equal(await client.probeRecord.count(), 0);
  });
  if (input.provider === "postgresql") {
    await record("scram-authentication", async () => {
      const [row] = await client.$queryRawUnsafe("SELECT split_part(rolpassword, '$', 1) AS method, split_part(split_part(rolpassword, '$', 2), ':', 1)::int AS iterations FROM pg_authid WHERE rolname = current_user");
      assert.equal(row.method, "SCRAM-SHA-256");
      assert.ok(Number.isInteger(row.iterations) && row.iterations > 0 && row.iterations <= 100000);
      scram = { method: row.method, iterations: row.iterations };
    });
    await record("scram-over-budget-rejected", async () => {
      const overBudgetUrl = new URL(url); overBudgetUrl.username = "oja_probe_over_budget";
      const password = async (iterations, create = false) => {
        assert.ok(iterations === 4096 || iterations === 100001);
        await client.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL scram_iterations = ${iterations}`);
          await tx.$executeRawUnsafe(create
            ? "CREATE ROLE oja_probe_over_budget LOGIN PASSWORD 'oja-ephemeral-test-only'"
            : "ALTER ROLE oja_probe_over_budget PASSWORD 'oja-ephemeral-test-only'");
        });
        const [row] = await client.$queryRawUnsafe("SELECT split_part(rolpassword, '$', 1) AS method, split_part(split_part(rolpassword, '$', 2), ':', 1)::int AS iterations FROM pg_authid WHERE rolname = 'oja_probe_over_budget'");
        assert.equal(row.method, "SCRAM-SHA-256");
        assert.equal(row.iterations, iterations);
      };
      const connect = async (reject = false) => {
        const probe = new PrismaClient({ datasourceUrl: overBudgetUrl.href, log: [] });
        try {
          if (reject) {
            // The Client maps this IO-boundary rejection to P1001, hiding the Rust message.
            await assert.rejects(probe.$connect(), error => error.name === "PrismaClientInitializationError" && error.errorCode === "P1001");
          } else await probe.$connect();
        } finally { await probe.$disconnect(); }
      };
      await password(4096, true);
      try {
        await connect();
        await password(100001);
        await connect(true);
        assert.equal(await client.probeRecord.count(), 0);
        await password(4096);
        await connect();
      } finally {
        await client.$executeRawUnsafe("DROP ROLE oja_probe_over_budget");
      }
      scram.rejectedIterations = 100001;
      scram.controlIterations = 4096;
      scram.controlConnections = 2;
      scram.rejectionCode = "P1001";
      assert.equal(await client.probeRecord.count(), 0);
    });
    if (input.tls) {
      const encrypted = async (probe) => {
        await probe.$connect();
        const [row] = await probe.$queryRawUnsafe("SELECT ssl, version, cipher, bits FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
        assert.equal(row.ssl, true);
        assert.ok(["TLSv1.2", "TLSv1.3"].includes(row.version));
        assert.ok(typeof row.cipher === "string" && row.cipher.length > 0 && row.bits >= 128);
        assert.equal(await probe.probeRecord.count(), 0);
        return row;
      };
      const control = async () => {
        const probe = new PrismaClient({ datasourceUrl: url, log: [] });
        try { return await encrypted(probe); } finally { await probe.$disconnect(); }
      };
      await record("tls-encrypted", async () => {
        const row = await encrypted(client);
        tls = { encrypted: true, strict: true, version: row.version,
          caSha256: input.tls.caSha256, serverSha256: input.tls.serverSha256,
          untrustedCaSha256: input.tls.untrustedCaSha256, controlConnections: 1 };
        await control();
      });
      for (const [check, key, code, change] of [
        ["tls-untrusted-ca-rejected", "untrustedCaRejectionCode", "P1011", value => value.searchParams.set("sslcert", input.tls.untrustedCaFile)],
        ["tls-hostname-rejected", "hostnameRejectionCode", "P1011", value => { value.hostname = "127.0.0.1"; }],
        ["tls-plaintext-rejected", "plaintextRejectionCode", "P1010", value => value.searchParams.set("sslmode", "disable")],
      ]) await record(check, async () => {
        const invalid = new URL(url); change(invalid);
        const probe = new PrismaClient({ datasourceUrl: invalid.href, log: [] });
        try {
          await assert.rejects(probe.$connect(), error => error.name === "PrismaClientInitializationError" && error.errorCode === code);
        } finally { await probe.$disconnect(); }
        tls[key] = code;
        await control(); tls.controlConnections++;
      });
    }
  }
} finally {
  await client.$disconnect();
  process.dlopen = dlopen;
}
assert.equal(sha(input.library), input.librarySha256);
assert.equal(sha(input.schema), input.schemaSha256);
console.log(JSON.stringify({ provider: input.provider, sourceCommit: input.sourceCommit,
  librarySha256: input.librarySha256, schemaSha256: input.schemaSha256,
  loadedLibrarySha256: [...loaded][0], checks, migrationsApplied: 2, rowsRemaining: 0,
  schemaEngineInvocations: fs.readFileSync(path.join(input.project, "schema-engine-invocations.jsonl"), "utf8").trim().split("\n").length,
  clientVersion: Prisma.prismaVersion.client,
  graphql,
  ...(tls ? { tls } : {}),
  ...(scram ? { scram } : {}), productionApproved: false }));
