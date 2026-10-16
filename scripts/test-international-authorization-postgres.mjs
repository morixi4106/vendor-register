import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const input = process.env.INTERNATIONAL_AUTHORIZATION_TEST_DATABASE_URL;
if (!input)
  throw new Error(
    "Set a dedicated local INTERNATIONAL_AUTHORIZATION_TEST_DATABASE_URL",
  );
const url = new URL(input);
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !/^\/vendor_register_auth_test(?:_[a-z0-9]+)?$/.test(url.pathname)
)
  throw new Error(
    "Authorization tests require a dedicated local test database",
  );
const schema = `intl_auth_test_${randomBytes(8).toString("hex")}`;
url.searchParams.set("schema", schema);
const databaseUrl = url.toString();
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  INTERNATIONAL_AUTHORIZATION_TEST_DATABASE_URL: databaseUrl,
};
const temporary = mkdtempSync(
  path.join(os.tmpdir(), "international-authorization-"),
);
const prismaCli = path.resolve("node_modules/prisma/build/index.js");
const run = (args) => {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Authorization test command failed (${result.status})`);
};
const client = new PrismaClient({ datasourceUrl: databaseUrl });
try {
  // The historical migration chain cannot bootstrap an empty DB. Test the delta
  // against the exact predecessor schema, without changing those old migrations.
  const baseline = execFileSync(
    "git",
    ["show", "255b6f5993389c2a507a117e210c2f9a39c154d0:prisma/schema.prisma"],
    { encoding: "utf8" },
  );
  const baselinePath = path.join(temporary, "baseline.prisma");
  writeFileSync(baselinePath, baseline);
  run([prismaCli, "db", "push", "--skip-generate", "--schema", baselinePath]);
  run([
    prismaCli,
    "db",
    "execute",
    "--url",
    databaseUrl,
    "--file",
    "prisma/migrations/20261016120000_international_authorization/migration.sql",
  ]);
  run([
    prismaCli,
    "db",
    "execute",
    "--url",
    databaseUrl,
    "--file",
    "prisma/migrations/20261016140000_international_proof_issuance/migration.sql",
  ]);
  run(["--test", "tests/postgres/internationalAuthorization.test.js"]);
  run([
    prismaCli,
    "migrate",
    "diff",
    "--from-url",
    databaseUrl,
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--exit-code",
  ]);
  run(["--test", "tests/postgres/internationalProofIssuance.test.js"]);
} finally {
  // schema is generated above, not taken from the supplied URL.
  await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.$disconnect();
  if (
    path.dirname(temporary) !== path.resolve(os.tmpdir()) ||
    !path.basename(temporary).startsWith("international-authorization-")
  )
    throw new Error("Unexpected test temporary directory");
  rmSync(temporary, { recursive: true, force: true });
}
