# Wise payout design

This design keeps Shopify Checkout as the buyer payment flow, including KOMOJU where configured, and uses Wise only for seller remittance after internal ledger checks.

## Target money flow

1. Buyer pays through Shopify Checkout.
2. The checkout payment provider settles into the platform's business account.
3. Shopify webhooks create seller ledger credits and debits.
4. The app calculates seller payoutable balances after refunds, cancellations, holds, minimum payout thresholds, and seller restrictions.
5. Admin approves a payout run.
6. Wise quote, recipient compatibility, transfer, and balance funding happen after approval.
7. Wise transfer ID and transfer status are saved on the payout run.
8. Admin polling marks the payout as paid or failed. Verified webhook handling can be added later.
9. Only a successful Wise completion creates the `payout_paid` ledger debit.

## Wise API resources

Wise payout execution should follow this order:

1. Create or retrieve a quote for the route and amount.
2. Fetch recipient/account requirements for the quote and target currency.
3. Create or reuse a Wise recipient account.
4. Check quote and recipient compatibility.
5. Create a transfer using a unique `customerTransactionId`.
6. Fund the transfer from Wise balance.
7. Store and process transfer state changes by webhook or polling.

Wise recipient fields are dynamic by country and currency. The app should store the Wise recipient ID, summaries, verification result, and the original payload/requirements JSON instead of assuming one universal bank form.

## Environment variables

```text
PAYMENT_PROVIDER=shopify_payments
SELLER_PAYOUT_PROVIDER=wise
WISE_API_TOKEN=...
WISE_PROFILE_ID=...
WISE_API_BASE_URL=https://api.wise-sandbox.com
WISE_WEBHOOK_SECRET=...
WISE_SOURCE_CURRENCY=JPY
WISE_LIVE_TRANSFERS_ENABLED=false
```

Use sandbox first. Live Wise funding should not be enabled until sandbox transfer creation, funding failure, polling, and ledger idempotency tests pass.

## Database groundwork

`SellerPayoutRecipient` stores the seller's payout destination for Wise:

- `provider`
- `status`
- `countryCode`
- `currencyCode`
- `legalType`
- `accountHolderName`
- `wiseProfileId`
- `wiseRecipientId`
- `wiseRecipientHash`
- `accountSummary`
- `longAccountSummary`
- `recipientPayloadJson`
- `requirementsJson`
- `verificationJson`

`PayoutRun` gains Wise execution fields:

- `sellerPayoutRecipientId`
- `wiseQuoteId`
- `wiseTransferId`
- `wiseTransferStatus`
- `wiseCustomerTransactionId`
- `wiseSourceCurrency`
- `wiseTargetCurrency`
- `wiseSourceAmount`
- `wiseTargetAmount`
- `wiseFeeAmount`
- `wiseRate`
- `wiseFailureCode`
- `wiseFailureMessage`
- `wisePayloadJson`

`WiseTransferEvent` stores webhook events by unique Wise event ID so duplicate delivery cannot create duplicate ledger entries.

## Safety rules

- Do not auto-create payout runs from unsettled or recently refunded sales.
- Enforce a hold period before a ledger credit becomes payoutable.
- Enforce a minimum payout threshold.
- Exclude `restricted` and `banned` sellers.
- Exclude sellers without an active Wise recipient record.
- Recalculate payoutable ledger balance immediately before transfer creation.
- Use one `customerTransactionId` per payout run.
- Do not automatically retry failed Wise transfers.
- Move failed payout runs to admin review and require recipient correction before a new payout run.
- Keep Stripe Connect direct charges and Connect payouts disabled for this production mode.

## Implementation phases

1. Add schema, readiness checks, and admin-visible mode labels. Done.
2. Add admin Wise recipient ID registration for recipients created/verified in Wise. Done.
3. Add Wise sandbox client with mocked tests. Done.
4. Add approved payout run execution behind admin action. Done.
5. Add polling status sync and idempotent ledger debit. Done.
6. Add seller-side Wise recipient setup screens using dynamic Wise requirements.
7. Add verified Wise webhook handling if polling becomes insufficient.
8. Add payout candidate generation after hold and threshold checks.
