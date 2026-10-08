import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import toml from "toml";

const config = (name) =>
  toml.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"));

test("Shopify config candidates remove customer master access but retain order operations", () => {
  for (const name of [
    "shopify.app.toml",
    "shopify.app.production.toml",
    "shopify.app.vendor-register.toml",
  ]) {
    const scopes = config(name).access_scopes.scopes.split(",");
    assert.ok(!scopes.includes("read_customers"));
    assert.ok(!scopes.includes("write_customers"));
    assert.ok(scopes.includes("read_products"));
    if (name !== "shopify.app.vendor-register.toml") {
      assert.ok(scopes.includes("read_orders"));
      assert.ok(scopes.includes("write_draft_orders"));
    }
  }
});

test("production order subscriptions keep economic and destination fields without customer contacts", () => {
  const subscriptions = config("shopify.app.production.toml").webhooks
    .subscriptions;
  for (const topic of ["orders/create", "orders/paid", "orders/updated"]) {
    const fields = subscriptions.find((row) =>
      row.topics?.includes(topic),
    ).include_fields;
    for (const field of [
      "line_items",
      "shipping_lines",
      "total_price_set",
      "total_discounts_set",
      "currency",
      "source_name",
      "note_attributes",
      "shipping_address.country_code",
      "billing_address.country_code",
    ])
      assert.ok(fields.includes(field), field);
    for (const field of [
      "customer",
      "email",
      "phone",
      "billing_address",
      "shipping_address",
    ])
      assert.ok(!fields.includes(field), field);
  }
  assert.deepEqual(
    subscriptions.find((row) => row.compliance_topics).compliance_topics,
    ["customers/data_request", "customers/redact", "shop/redact"],
  );
});
