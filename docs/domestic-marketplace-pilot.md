# Domestic marketplace pilot

## Scope

This pilot is a one-time, domestic marketplace verification for exactly:

- one non-test, non-platform Japanese vendor store;
- one approved product owned by that store;
- one unit shipped to Japan;
- one Draft Order and one paid Shopify order;
- a KOMOJU card payment;
- monthly manual seller settlement.

It does not enable multi-seller carts, sales credit, EU sales, international
shipping, automatic seller payout, automatic refund, or automatic Shopify
order cancellation.

## Safe default

The migration and application must first be deployed with both public switches
disabled:

```text
DOMESTIC_MARKETPLACE_PILOT_ENABLED=false
PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED=false
```

In this state the pilot route may be used by the operator to inspect and prepare
the permit, but no third-party store or product is exposed publicly.

## Required production configuration

Before activation, verify these values without changing the unrelated flags:

```text
DOMESTIC_MARKETPLACE_PILOT_ENABLED=true
PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED=true
MARKETPLACE_GOVERNANCE_GATE_ENABLED=true
SELLER_ORDER_SHADOW_WRITE_ENABLED=true
VENDOR_ORDERS_USE_SELLER_ORDERS=true
SELLER_PAYOUT_PROVIDER=manual
PAYMENT_PROVIDERS=shopify_payments,komoju
KOMOJU_PAYMENT_OPERATIONS_ENABLED=true
PAYMENT_REFUND_CONFIRMATION_ENFORCED=true
```

Keep these disabled for the pilot:

```text
MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED=false
MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED=false
DOMESTIC_SELLER_SETTLEMENT_ENABLED=false
CROSS_BORDER_SELLER_SETTLEMENT_ENABLED=false
```

The marketplace governance gate also requires the configured seller agreement,
buyer terms, and written Shopify marketplace-payments approval evidence. The
pilot permit cannot become active while any required seller, product, return
address, or agreement evidence is missing.

## Preparation and activation

1. Create or select one real third-party store. It must not be a test or
   platform store.
2. Complete the seller governance, agreement, compliance, settlement-control,
   return-address, and Japanese country checks.
3. Approve one product owned by that store. Keep EU sales disabled and ensure
   the Shopify product and variant identifiers are present.
4. Open `アプリ > vendor-register > 国内マーケットパイロット`.
5. Select the store and product, set a maximum subtotal, and set a validity
   period no longer than seven days. Quantity is fixed at one.
6. Save the approval reference and the 64-character SHA-256 of the external
   approval evidence.
7. Prepare the permit while both public switches are still disabled.
8. Enable only the required production switches, redeploy the same reviewed
   commit, and confirm Production Readiness and the launch monitor.
9. Activate the prepared permit once. Activation fails closed if another live
   permit exists or any readiness check has changed.

Activation exposes only the permitted store and product. Platform products
continue to use Shopify standard collections and are rejected by the public
Draft Order endpoint while pilot mode is active.

## One-order execution

1. Open the permitted App Proxy storefront and confirm that only the permitted
   product appears.
2. Submit one unit to a Japanese address without sales credit.
3. The application atomically reserves the single pilot slot before requesting
   the Shopify Draft Order.
4. If Shopify fails before creating a Draft Order, the slot returns to active.
   If creation may have succeeded, the slot remains reserved or order-created
   and must not be retried blindly.
5. Pay the resulting invoice once with a live KOMOJU credit card.
6. The paid webhook must create or match the `MarketplaceOrder`, one
   `SellerOrder`, its lines, SellerOrder Shadow, `PaymentAttempt`, and the paid
   ledger entry.
7. The permit reaches `COMPLETED` only when the same checkout reference and
   Shopify order are present, SellerOrder projection exists, and the recorded
   gateway is KOMOJU card.

Repeated clicks or a second checkout cannot claim the slot. A completed or
order-created pilot cannot be prepared again for another order.

## Settlement and refund

Do not enable automatic payout or marketplace settlement actions. At the
monthly close:

1. Reconcile the Shopify order and KOMOJU payment in `決済運用`.
2. Confirm the SellerOrder and ledger amount after refunds, fees, holds, and
   contractual offsets.
3. Record the approved manual payout using the existing payout workflow and
   retain the bank-transfer evidence.
4. If the order is refunded, confirm success at Shopify and KOMOJU before
   posting the refund ledger entry. The application must not initiate a refund
   or cancellation automatically.

## Stop and recovery

For an immediate stop, set both public switches to false and block the permit.
Either action removes the public third-party purchase path. Do not delete the
permit or overwrite its Draft Order or Shopify order identifiers.

If an external Draft Order may exist but the application did not record it,
inspect Shopify first. Never release the reserved slot merely to retry. If the
paid webhook was delayed, replay the same webhook or run the existing
idempotent projection recovery; do not create another customer payment.

The pilot does not change product Publication automatically, issue refunds,
cancel orders, or send seller payouts. Those actions remain explicit operator
workflows with their existing evidence and audit requirements.
