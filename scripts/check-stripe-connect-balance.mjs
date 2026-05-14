#!/usr/bin/env node

const API_VERSION = process.env.STRIPE_API_VERSION || "2026-02-25.clover";

function printUsage() {
  console.log(`Usage:
  node scripts/check-stripe-connect-balance.mjs --account acct_... [--charge ch_...]
  node scripts/check-stripe-connect-balance.mjs --account acct_... [--payment-intent pi_...]

Environment:
  STRIPE_SECRET_KEY must be set in the shell running this script.

Examples:
  node scripts/check-stripe-connect-balance.mjs --account acct_123
  node scripts/check-stripe-connect-balance.mjs --account acct_123 --charge ch_123
  node scripts/check-stripe-connect-balance.mjs --account acct_123 --payment-intent pi_123
`);
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`${name} is not set.`);
  }

  return value.trim();
}

function encodeForm(params) {
  const body = new URLSearchParams();

  for (const value of params) {
    body.append(value[0], value[1]);
  }

  return body.toString();
}

async function stripeGet(path, { secretKey, accountId, query = [] }) {
  const queryString = query.length ? `?${encodeForm(query)}` : "";
  const response = await fetch(`https://api.stripe.com${path}${queryString}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Account": accountId,
      "Stripe-Version": API_VERSION,
    },
  });

  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload?.error?.message || `Stripe request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function formatUnixTime(seconds) {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString("ja-JP");
}

function printMoneyRows(label, rows = []) {
  console.log(`${label}:`);

  if (!rows.length) {
    console.log("  -");
    return;
  }

  for (const row of rows) {
    console.log(`  ${row.amount} ${String(row.currency || "").toUpperCase()}`);
  }
}

function printBalanceTransaction(balanceTransaction) {
  if (!balanceTransaction || typeof balanceTransaction !== "object") {
    console.log("Balance transaction: not expanded/found");
    return;
  }

  console.log("Balance transaction:");
  console.log(`  id: ${balanceTransaction.id || "-"}`);
  console.log(`  amount: ${balanceTransaction.amount ?? "-"}`);
  console.log(`  fee: ${balanceTransaction.fee ?? "-"}`);
  console.log(`  net: ${balanceTransaction.net ?? "-"}`);
  console.log(`  currency: ${String(balanceTransaction.currency || "").toUpperCase() || "-"}`);
  console.log(`  status: ${balanceTransaction.status || "-"}`);
  console.log(`  available_on: ${formatUnixTime(balanceTransaction.available_on)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const accountId = args.account;

  if (!accountId || typeof accountId !== "string" || !accountId.startsWith("acct_")) {
    throw new Error("--account acct_... is required.");
  }

  const secretKey = requireEnv("STRIPE_SECRET_KEY");

  console.log(`Connected account: ${accountId}`);
  console.log(`Stripe API version: ${API_VERSION}`);

  if (args["payment-intent"]) {
    const paymentIntent = await stripeGet(`/v1/payment_intents/${args["payment-intent"]}`, {
      secretKey,
      accountId,
      query: [["expand[]", "latest_charge.balance_transaction"]],
    });

    console.log("PaymentIntent:");
    console.log(`  id: ${paymentIntent.id}`);
    console.log(`  status: ${paymentIntent.status}`);
    console.log(`  amount: ${paymentIntent.amount} ${String(paymentIntent.currency || "").toUpperCase()}`);

    const charge = paymentIntent.latest_charge;

    if (charge && typeof charge === "object") {
      console.log("Charge:");
      console.log(`  id: ${charge.id}`);
      console.log(`  status: ${charge.status || "-"}`);
      console.log(`  paid: ${charge.paid}`);
      printBalanceTransaction(charge.balance_transaction);
    }
  } else if (args.charge) {
    const charge = await stripeGet(`/v1/charges/${args.charge}`, {
      secretKey,
      accountId,
      query: [["expand[]", "balance_transaction"]],
    });

    console.log("Charge:");
    console.log(`  id: ${charge.id}`);
    console.log(`  status: ${charge.status || "-"}`);
    console.log(`  paid: ${charge.paid}`);
    console.log(`  amount: ${charge.amount} ${String(charge.currency || "").toUpperCase()}`);
    printBalanceTransaction(charge.balance_transaction);
  }

  const balance = await stripeGet("/v1/balance", {
    secretKey,
    accountId,
  });

  printMoneyRows("Available", balance.available || []);
  printMoneyRows("Pending", balance.pending || []);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);

  if (error.payload?.error) {
    console.error(`Stripe error type: ${error.payload.error.type || "-"}`);
    console.error(`Stripe error code: ${error.payload.error.code || "-"}`);
  }

  process.exitCode = 1;
});
