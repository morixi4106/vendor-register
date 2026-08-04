import Stripe from "stripe";
import { SELLER_PAYOUT_PROVIDER_WISE, STRIPE_ACCOUNT_PROBE_LIMIT, createCheck, normalizeText, sanitizeStripeErrorMessage } from "./common.js";
export function buildPayoutChecks({
  env,
  operationEnv
}) {
  const wiseChecks = [];
  const wiseConfig = {
    hasApiToken: Boolean(normalizeText(env.WISE_API_TOKEN)),
    hasProfileId: Boolean(normalizeText(env.WISE_PROFILE_ID)),
    hasApiBaseUrl: Boolean(normalizeText(env.WISE_API_BASE_URL)),
    hasWebhookSecret: Boolean(normalizeText(env.WISE_WEBHOOK_SECRET)),
    sourceCurrency: normalizeText(env.WISE_SOURCE_CURRENCY)
  };
  const wiseConfigReady = wiseConfig.hasApiToken && wiseConfig.hasProfileId && wiseConfig.hasApiBaseUrl && Boolean(wiseConfig.sourceCurrency);
  if (operationEnv.sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE) {
    wiseChecks.push(createCheck({
      id: "wise_api_environment",
      category: "payout",
      status: wiseConfigReady ? "pass" : "fail",
      title: "Wise API environment",
      detail: wiseConfigReady ? `Wise API env is configured for source currency ${wiseConfig.sourceCurrency}.` : "Wise payout mode needs WISE_API_TOKEN, WISE_PROFILE_ID, WISE_API_BASE_URL, and WISE_SOURCE_CURRENCY.",
      action: wiseConfigReady ? "" : "Configure Wise sandbox or production credentials in Render before enabling Wise payout execution."
    }), createCheck({
      id: "wise_webhook_secret",
      category: "payout",
      status: wiseConfig.hasWebhookSecret ? "pass" : "warning",
      title: "Wise webhook secret",
      detail: wiseConfig.hasWebhookSecret ? "WISE_WEBHOOK_SECRET is configured." : "WISE_WEBHOOK_SECRET is missing. Polling can be used during early testing, but webhook verification should be configured before relying on asynchronous completion.",
      action: wiseConfig.hasWebhookSecret ? "" : "Create a Wise transfer state-change webhook subscription and set the webhook verification secret."
    }), createCheck({
      id: "wise_execution_safety",
      category: "payout",
      status: "manual",
      title: "Wise execution safety",
      detail: "Wise payout execution must stay behind admin approval, idempotency keys, and sandbox/dry-run testing until live transfers are explicitly enabled.",
      action: "Do not execute live Wise funding from an automatic job until sandbox transfer, failure, retry, and webhook idempotency tests pass."
    }));
  } else {
    wiseChecks.push(createCheck({
      id: "wise_api_connection",
      category: "payout",
      status: wiseConfig.hasApiToken ? "warning" : "manual",
      title: "Wise API connection",
      detail: wiseConfig.hasApiToken ? "WISE_API_TOKEN is present, but SELLER_PAYOUT_PROVIDER is not wise." : "No Wise API token is configured. This is expected for the current manual payout flow.",
      action: "Set SELLER_PAYOUT_PROVIDER=wise only after recipient storage, quote/transfer creation, funding, and webhook handling are tested."
    }));
  }
  return [createCheck({
    id: "seller_payout_transfer_mode",
    category: "payout",
    status: "manual",
    title: "Seller payout transfer mode",
    detail: operationEnv.sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE ? "Seller payouts are configured for Wise API payout runs, with admin approval required before execution." : "Seller payouts are recorded as manual bank/Wise transfers after the real transfer is completed outside the app.",
    action: operationEnv.sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE ? "Use Wise API only after the payout run is approved and the ledger balance is recalculated." : "After the actual transfer is completed outside the app, record the external transfer ID on the payout run."
  }), ...wiseChecks];
}
export async function getPlatformStripeAccount(stripeEnv) {
  if (!stripeEnv.secretKey || stripeEnv.secretKeyMode === "missing") {
    return {
      ok: false,
      reason: "missing_secret_key"
    };
  }
  try {
    const stripe = new Stripe(stripeEnv.secretKey);
    const account = await stripe.accounts.retrieve();
    return {
      ok: true,
      account: {
        id: account.id,
        country: account.country || null,
        defaultCurrency: account.default_currency || null,
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
        detailsSubmitted: Boolean(account.details_submitted)
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason: "stripe_account_retrieve_failed",
      message: sanitizeStripeErrorMessage(error?.message),
      code: normalizeText(error?.code)
    };
  }
}
export async function probeConnectedAccounts({
  stripeEnv,
  sellerRows
}) {
  if (!stripeEnv.secretKey || stripeEnv.secretKeyMode === "missing") {
    return [];
  }
  const stripe = new Stripe(stripeEnv.secretKey);
  const rowsToProbe = sellerRows.filter(row => row.stripeAccount?.stripeAccountId).slice(0, STRIPE_ACCOUNT_PROBE_LIMIT);
  const results = [];
  for (const row of rowsToProbe) {
    const stripeAccountId = row.stripeAccount.stripeAccountId;
    try {
      const account = await stripe.accounts.retrieve(stripeAccountId);
      results.push({
        ok: true,
        sellerId: row.id,
        vendorHandle: row.vendor?.handle || null,
        storeName: row.vendor?.storeName || null,
        stripeAccountId,
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
        detailsSubmitted: Boolean(account.details_submitted)
      });
    } catch (error) {
      results.push({
        ok: false,
        sellerId: row.id,
        vendorHandle: row.vendor?.handle || null,
        storeName: row.vendor?.storeName || null,
        stripeAccountId,
        code: normalizeText(error?.code),
        message: sanitizeStripeErrorMessage(error?.message)
      });
    }
  }
  return results;
}
export function buildSellerChecks({
  sellerRows,
  connectedAccountProbe,
  operationEnv
}) {
  const {
    sellerPayoutProvider,
    stripeConnectProductionEnabled
  } = operationEnv;
  const activeSellers = sellerRows.filter(row => row.status === "active");
  const activeSellersWithoutPayoutRecord = sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE ? activeSellers.filter(row => !row.payoutRecipient?.wiseRecipientId) : [];
  const invalidConnectedAccounts = connectedAccountProbe.filter(row => !row.ok);
  const unavailableConnectedAccounts = connectedAccountProbe.filter(row => row.ok && (!row.detailsSubmitted || !row.chargesEnabled || !row.payoutsEnabled));
  return [createCheck({
    id: "active_sellers_have_stripe_accounts",
    category: "seller",
    status: activeSellersWithoutPayoutRecord.length === 0 ? "pass" : "fail",
    title: "Active sellers have payout recipient records",
    detail: activeSellersWithoutPayoutRecord.length === 0 ? sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE ? "All active sellers have Wise recipient records." : "Manual settlement mode does not require seller Stripe accounts or Wise recipient records before go-live." : sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE ? `${activeSellersWithoutPayoutRecord.length} active seller(s) have no Wise recipient record.` : `${activeSellersWithoutPayoutRecord.length} active seller(s) have no seller payout bookkeeping record.`,
    action: activeSellersWithoutPayoutRecord.length === 0 ? "" : sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE ? "Collect and verify the seller's Wise recipient details, or keep the seller inactive until payouts are not required." : "Keep manual settlement approval based on ledger balance and external transfer records."
  }), createCheck({
    id: "connected_accounts_match_current_stripe_key",
    category: "seller",
    status: stripeConnectProductionEnabled ? invalidConnectedAccounts.length === 0 ? "pass" : "fail" : "manual",
    title: "Connected accounts match current Stripe key",
    detail: stripeConnectProductionEnabled ? invalidConnectedAccounts.length === 0 ? "Connected account probes succeeded for the sampled sellers." : `${invalidConnectedAccounts.length} sampled connected account(s) could not be retrieved with the current Stripe key.` : "Skipped because Stripe Connect is not the production checkout or payout rail.",
    action: stripeConnectProductionEnabled ? invalidConnectedAccounts.length === 0 ? "" : "Accounts created under a test platform cannot be used with live keys. Recreate those seller Stripe accounts after switching to live keys." : "Only verify or recreate connected accounts if enabling Stripe Connect direct charges or Connect payouts."
  }), createCheck({
    id: "connected_accounts_ready",
    category: "seller",
    status: stripeConnectProductionEnabled ? unavailableConnectedAccounts.length === 0 ? "pass" : "warning" : "manual",
    title: "Connected accounts are enabled",
    detail: stripeConnectProductionEnabled ? unavailableConnectedAccounts.length === 0 ? "Sampled connected accounts are submitted and enabled." : `${unavailableConnectedAccounts.length} sampled connected account(s) are not fully enabled.` : "Not required for the current manual seller payout flow.",
    action: stripeConnectProductionEnabled ? unavailableConnectedAccounts.length === 0 ? "" : "Ask the seller to complete the embedded payment settings, then review the seller before payout." : "Keep seller payout approval based on ledger balance and the external bank/Wise transfer record."
  })];
}
