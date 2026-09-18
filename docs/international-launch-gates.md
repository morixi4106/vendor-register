# International sales launch gates

International sales remain disabled until every gate in this document has
current evidence and the active Shopify configuration has been verified. The
application does not calculate VAT, customs duty, or import fees itself.
Shopify Markets, the carrier, and the selected tax/customs arrangement remain
the systems of record for those amounts.

## Evidence required before activation

Every enabled destination requires current country-level evidence for:

- carrier acceptance and service availability;
- the Shopify delivery profile and every alternate route, including manual
  rates, free shipping, another Carrier Service, and another delivery profile;
- support language, return address, and complaint contact;
- Shopify Markets configuration;
- VAT, customs, IOSS where applicable, and DDP or DAP responsibilities;
- privacy notices, processors, and international data transfers.

EU destinations additionally require evidence for:

- the withdrawal workflow, including a continuously available withdrawal
  function and a durable confirmation containing the request and timestamp;
- the legal guarantee and the repair, replacement, price reduction, and refund
  workflow;
- VAT/IOSS and DDP/DAP configuration;
- packaging EPR obligations for each destination country;
- the low-value consignment customs policy, including the EUR 3 per-item rule
  and Product Identifier readiness when applicable.

Northern Ireland is not treated as Great Britain. It remains blocked until a
separate Northern Ireland compliance and delivery route is implemented and
approved.

## Product evidence

Cosmetics must pass the existing region-specific evidence gate. EU and GB
evidence includes the responsible person, notification, safety assessment,
label, PIF, GMP, serious adverse event handling, and recall/traceability.

US MoCRA requirements are evaluated independently. Facility registration,
product listing, and GMP may be marked not applicable only when the evidence
supports that specific exemption. Safety substantiation, serious adverse event
handling, labels/claims, and recall procedures cannot inherit that exemption.

## Activation order

1. Read the actual Render environment and active Shopify Validation. Do not
   infer production state from code defaults. In particular, verify
   `PLATFORM_DIRECT_CHECKOUT_MODE`, the payment provider, and every international,
   marketplace, settlement, and EU feature flag without printing secrets.
2. Confirm the store password remains enabled and no international order or
   checkout probe is in progress.
3. Register and approve all product evidence for each intended destination.
4. Register country-level market evidence with an evidence reference, HTTPS
   source, reviewer, and 64-character SHA-256.
5. Set a country route to active only after recording the Shopify delivery
   profile and confirming every alternate shipping route is closed or governed.
6. Re-run Production readiness. International sales remain blocked if any
   product, country, route, freshness, or publication check is not passing.
7. Use the explicit international sale gate sync action and verify the Shopify
   metafield read-back. Do not treat a database-only result as activation.
8. Create a Shopify App Version without releasing it. Inspect the Function,
   scopes, extensions, and deletions before requesting human approval.
9. After human approval, release the version and verify checkout behavior for
   Japan, every allowed country, an unapproved country, Northern Ireland, and an
   expired or missing international gate.
10. Only then run one controlled international transaction and its refund and
    ledger reconciliation. Markets, rates, product publication, the store
    password, and real payment confirmation require separate human approval.

## Stop conditions

Stop international checkout when any required evidence expires or is revoked,
the destination is absent from the verified projection, Northern Ireland is
detected, the route cannot be read back from Shopify, or the Function cannot
parse the control value. Domestic Japanese checkout is not changed by this
gate.

## Repository governance

Protect `main` with pull requests and successful Quality checks. Disable force
pushes, branch deletion, and direct pushes, including routine administrator
bypass. This is a GitHub repository setting and must be enabled by a repository
administrator; application code cannot enforce it.
