# EU Withdrawal Request Setup

This app adds a buyer-facing EU withdrawal request form, an admin review queue,
and a versioned direct-to-store return workflow.

## Routes

- Buyer form: `/apps/vendors/withdrawal`
- Buyer success page: `/apps/vendors/withdrawal/success`
- Admin list: `/app/withdrawals`
- Admin detail: `/app/withdrawals/:id`
- Direct-return policy: `/app/withdrawal-settings`
- Vendor return address: `/vendor/settings/returns`
- Vendor withdrawal list: `/vendor/withdrawals`
- Vendor withdrawal detail: `/vendor/withdrawals/:id`
- Store-specific return proof: `/apps/vendors/withdrawal/return-proof`

## Deploy

Run the Prisma migration in deploy:

```sh
npx prisma migrate deploy --schema=prisma/schema.prisma
```

Render should already run migrations in pre-deploy. Confirm that this migration is applied:

```text
20260703090000_add_withdrawal_requests
20260717120000_add_direct_return_workflow_v2
```

## Environment Variables

Required for acknowledgement email:

```text
RESEND_API_KEY=...
WITHDRAWAL_FROM_EMAIL=support@example.com
WITHDRAWAL_SUPPORT_EMAIL=support@example.com
```

Fallbacks:

- `WITHDRAWAL_FROM_EMAIL` falls back to `MAIL_FROM`, then `ADMIN_EMAIL`.
- `WITHDRAWAL_SUPPORT_EMAIL` falls back to `ADMIN_EMAIL`, then `MAIL_FROM`.

Optional guard for future Shopify write actions:

```text
WITHDRAWAL_ENABLE_SHOPIFY_WRITE_ACTIONS=false
```

Keep this `false` until cancellation/refund mutations are fully tested with the current Shopify API version and scopes.

No new environment variable is required for the direct-to-store V2 workflow.

`WITHDRAWAL_RETURN_ADDRESS` is a legacy V1 common return address only. V2 never
uses it as a fallback. A store without an active, explicitly confirmed return
address remains blocked from sending return instructions.

Keep `WITHDRAWAL_PUBLIC_BASE_URL` set to the Shopify storefront origin so that
buyer links do not expose the Render application URL.

## Shopify Page

Create or update a Shopify page such as `/pages/withdrawal-form`, then paste:

```text
docs/withdrawal-entry-page.html
```

The page embeds the app proxy form with a same-store relative URL:

```html
<iframe src="/apps/vendors/withdrawal?embedded=1"></iframe>
```

If the fixed page receives `orderNumber`, `order`, `customerEmail`, or `email` in the query string, the provided page snippet forwards those values into the embedded form.

Do not link buyers directly to the Render app URL. Public links should use the Shopify store domain, either the fixed page or the app proxy path.

Add links to that page from:

- Footer
- Return/refund policy page
- Order confirmation emails
- Any EU-facing help page

## Storefront Password

If the Shopify storefront password page is enabled, public visitors will see the password page instead of the fixed page or app proxy form.

Before publishing the withdrawal flow for buyers, confirm that:

- `/pages/withdrawal-form` opens on the storefront domain.
- `/apps/vendors/withdrawal?embedded=1` returns the embedded form, not the Shopify password page.
- Public links use the storefront domain, not the Render app domain.

## Initial Operating Rule

The MVP intentionally does not auto-refund.

1. Buyer submits the withdrawal form.
2. App stores the request.
3. App sends an acknowledgement email.
4. Admin reviews order, deadline, buyer email, item condition, and exemptions.
5. Admin updates status and sends a status email.
6. Admin performs Shopify cancellation/refund manually for now.

Current policy assumption:

- Standard original delivery costs are reviewed as refundable when a withdrawal is accepted.
- Supplementary delivery costs for a buyer-selected premium shipping method may be excluded.
- Return shipping may be buyer-paid if the buyer was informed in advance, unless the store agrees to pay or applicable law requires otherwise.
- Item value reduction can be handled by status notes and manual refund amount decisions.

## Direct-to-store V2

V2 sends each returned product directly to the store that sold it. It does not
reuse a store's general registration address.

Before enabling V2:

1. Open `/app/withdrawal-settings` and create the contract policy and terms version.
2. Keep the policy inactive while stores register return addresses.
3. Each store opens `/vendor/settings/returns`, saves a dedicated return address,
   confirms that it can receive returns, and activates the address.
4. Check `/app/production-readiness`. EU-capable stores without an active return
   address must be visible as warnings.
5. Activate the policy only after the contract structure and public terms have
   been reviewed.

V2 operating flow:

1. A buyer submits one withdrawal request.
2. For a full withdrawal, the app maps every actual Shopify order line to its
   seller order and reserves the purchased quantities. For a partial withdrawal,
   buyer free text is treated as a note only; an administrator must select the
   actual order lines and quantities on `/app/withdrawals/:id` before anything is
   reserved or routed to a store.
3. The app creates one or more contracts according to the active policy, then a
   separate return group for each selling store.
4. An administrator reviews each group. Instructions cannot be sent when the
   line mapping or the store return address is missing.
5. Sending instructions stores an immutable snapshot of the store, address,
   products, deadline, and return-cost rule. Later address changes do not change
   an already-sent instruction.
6. The buyer sends separate packages to each store and submits a tracking number
   or URL for each package. Multiple packages per store are supported.
7. The store records receipt and item condition. The administrator records the
   refund decision and any documented value-reduction deduction.
8. The initial standard shipping refund is held at contract/request level and is
   counted only once, never once per store.
9. Shopify cancellation/refund remains a manual operator action. Webhooks only
   reconcile the actual result back into the withdrawal record.

Existing V1 requests continue to use the legacy fields and UI. V2 children are
the source of truth only for requests initialized under an active V2 policy.

## Admin Status Flow

Suggested flow:

```text
REQUESTED
ACKNOWLEDGED
UNDER_REVIEW
APPROVED
RETURN_REQUESTED
RETURN_RECEIVED
REFUND_PENDING
REFUNDED
```

For rejected or expired requests:

```text
REJECTED
EXPIRED
```

## Notes

- This is not legal advice.
- Confirm the actual EU policy language with counsel before publishing public-facing policy pages.
- If automatic Shopify cancellation/refund is added later, add `write_orders` scope and test order cancellation/refund idempotency before enabling the write flag.
