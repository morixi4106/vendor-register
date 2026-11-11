import assert from "node:assert/strict";
import test from "node:test";
import { inspectPostgresTlsConfiguration } from "../../app/utils/postgresTlsPolicy.js";
import {
  buildEnvironmentChecks,
  inspectOperationEnvironment,
  inspectStripeEnvironment,
} from "../../app/services/productionReadiness/environment.server.js";

const base = "postgresql://user:password@db.example.invalid:5432/shop";
const strict = "sslmode=require&sslaccept=strict";
const inspect = (query) =>
  inspectPostgresTlsConfiguration(`${base}${query ? `?${query}` : ""}`);

test("only explicit native Prisma required TLS and strict certificate validation are ready", () => {
  for (const value of [
    `${base}?${strict}`,
    `${base.replace("postgresql:", "postgres:")}?${strict}`,
    `${base}?${strict}&sslcert=%2Fprivate%2Froot%20ca.pem`,
    `${base}?schema=app&pgbouncer=true&${strict}`,
    `postgresql://user:password@[::1]:5432/shop?${strict}`,
    `${base}?sslmode=%72equire&sslaccept=strict`,
  ]) {
    assert.deepEqual(inspectPostgresTlsConfiguration(value), {
      ready: true,
      reason: "explicit_required_verified_tls_configuration",
      configurationOnly: true,
      connectionVerified: false,
    });
  }
});

test("defaults, plaintext, prefer and libpq-only verify modes cannot pass the native Prisma policy", () => {
  for (const query of [
    "",
    "sslmode=disable&sslaccept=strict",
    "sslmode=prefer&sslaccept=strict",
    "sslmode=verify-full&sslaccept=strict",
    "sslmode=verify-ca&sslaccept=strict",
    "sslmode=REQUIRE&sslaccept=strict",
    "sslmode=require%20&sslaccept=strict",
    "sslaccept=strict",
  ]) {
    assert.equal(inspect(query).ready, false, query);
    assert.equal(inspect(query).reason, "tls_not_required", query);
  }
  for (const query of [
    "sslmode=require",
    "sslmode=require&sslaccept=accept_invalid_certs",
    "sslmode=require&sslaccept=STRICT",
    "sslmode=require&sslaccept=typo",
  ])
    assert.equal(inspect(query).reason, "certificate_validation_not_required");
});

test("duplicates, ignored case variants, query-host overrides and fragments fail closed", () => {
  for (const query of [
    `${strict}&sslmode=disable`,
    `sslmode=disable&${strict}`,
    `${strict}&sslaccept=accept_invalid_certs`,
    `${strict}&sslmode=require`,
    `${strict}&SSLMode=disable`,
    "SSLMODE=require&sslaccept=strict",
    `${strict}&sslcert=a&sslcert=b`,
    `${strict}&sslidentity=a&SSLIDENTITY=b`,
    `${strict}&sslpassword=a&sslpassword=b`,
  ])
    assert.equal(inspect(query).reason, "ambiguous_tls_parameters", query);
  for (const host of ["", "other.example.invalid", "%2Fvar%2Frun%2Fpostgresql"])
    assert.equal(
      inspect(`${strict}&host=${host}`).reason,
      "host_override_unverified",
    );
  assert.equal(inspect(`${strict}#hidden`).reason, "ambiguous_endpoint");
  assert.equal(inspect(`${strict}&sslcert=`).reason, "empty_certificate_path");
});

test("invalid inputs are bounded, nonthrowing and never echo credentials or endpoint details", () => {
  for (const value of [undefined, null, ""])
    assert.equal(inspectPostgresTlsConfiguration(value).reason, "missing");
  for (const value of [
    {},
    42,
    new URL(base),
    "not a URL",
    " ",
    `${base}?${strict}\n`,
    `${base}?sslmo\tde=require&sslaccept=strict`,
    `${base}?${strict}&token=%xy`,
    `${base}?${strict}&token=%`,
    `${base}?${strict}&long=${"x".repeat(16384)}`,
  ]) {
    const result = inspectPostgresTlsConfiguration(value);
    assert.equal(result.reason, "invalid_url");
    assert.equal(result.connectionVerified, false);
    assert.equal(JSON.stringify(result).includes("password"), false);
    assert.equal(JSON.stringify(result).includes("example.invalid"), false);
  }
  for (const value of [
    "file:///private/db",
    "https://db.example.invalid",
    "prisma://db.example.invalid",
    "mysql://db.example.invalid",
  ])
    assert.equal(
      inspectPostgresTlsConfiguration(value).reason,
      "unsupported_protocol",
    );
  for (const value of [
    `postgresql:///shop?${strict}`,
    `postgresql://%2Fvar%2Frun/shop?${strict}`,
  ])
    assert.equal(
      inspectPostgresTlsConfiguration(value).reason,
      "ambiguous_endpoint",
    );
});

test("readiness blocks unsafe production settings, warns in development and never mutates configuration", () => {
  for (const NODE_ENV of ["production", "test", "development", undefined]) {
    for (const DATABASE_URL of [undefined, base, `${base}?${strict}`]) {
      const env = Object.freeze({ NODE_ENV, DATABASE_URL });
      const before = JSON.stringify(env);
      const checks = buildEnvironmentChecks({
        env,
        stripeEnv: inspectStripeEnvironment(env),
        operationEnv: inspectOperationEnvironment(env),
      });
      const check = checks.find(
        (item) => item.id === "database_tls_configuration",
      );
      assert.equal(
        check.status,
        DATABASE_URL?.endsWith(strict)
          ? "pass"
          : NODE_ENV === "production"
            ? "fail"
            : "warning",
      );
      assert.equal(check.category, "app");
      assert.equal(JSON.stringify(check).includes("password"), false);
      assert.equal(JSON.stringify(check).includes("db.example.invalid"), false);
      assert.equal(JSON.stringify(env), before);
      if (check.status === "pass")
        assert.match(check.detail, /Configuration only/);
    }
  }
});
