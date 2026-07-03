# EU Withdrawal Request Setup

This app adds a buyer-facing EU withdrawal request form and an admin review queue.

## Routes

- Buyer form: `/apps/vendors/withdrawal`
- Buyer success page: `/apps/vendors/withdrawal/success`
- Admin list: `/app/withdrawals`
- Admin detail: `/app/withdrawals/:id`

## Deploy

Run the Prisma migration in deploy:

```sh
npx prisma migrate deploy --schema=prisma/schema.prisma
```

Render should already run migrations in pre-deploy. Confirm that this migration is applied:

```text
20260703090000_add_withdrawal_requests
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

## Shopify Page

Create or update a Shopify page such as `/pages/withdrawal-form`, then paste:

```text
docs/withdrawal-entry-page.html
```

The page embeds the app proxy form with a same-store relative URL:

```html
<iframe src="/apps/vendors/withdrawal?embedded=1"></iframe>
```

Do not link buyers directly to the Render app URL. Public links should use the Shopify store domain, either the fixed page or the app proxy path.

Add links to that page from:

- Footer
- Return/refund policy page
- Order confirmation emails
- Any EU-facing help page

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
