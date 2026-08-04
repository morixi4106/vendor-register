# Code architecture

This document is the short map for the parts of the application that carry the
largest operational risk. It describes ownership boundaries, not every file.

## Route boundary

Remix route files own HTTP concerns only:

- authenticate the request;
- parse and validate request parameters;
- call a service operation;
- serialize the response;
- select the page component.

Large admin views live under `app/components`. Product detail, withdrawal
list/detail, vendor preview, vendor dashboard, and production readiness routes
must remain below their line budgets. Their page markup and presentation
helpers do not belong back in the route. Server-only list queries and admin
operations live under `app/services`, not in a client component.

Page-specific CSS lives beside each page in a `.styles.js` module. Keeping the
style text out of the page module makes the component tree and operational
workflow readable without scrolling through unrelated presentation rules.
Display calculations and labels live in the matching `*ViewModel.js` module;
those modules are framework-free and must not perform I/O.

## Operational readiness

`operationalReadiness.server.js` is an orchestration facade. It records and
recovers operational controls and builds readiness evidence.

`operationalControls.server.js` is the low-level, read-safe dependency for:

- the global checkout hold;
- email-class holds;
- operational-control constants.

Checkout eligibility and the withdrawal email worker must depend on the
low-level control reader. They must not import the readiness orchestrator,
because the orchestrator itself aggregates their results.

## Seller payments

`sellerPayments.server.js` remains the compatibility facade used by routes and
webhooks. New logic should be placed in the domain folder first:

- `sellerPayments/constants.js`: public domain values;
- `sellerPayments/values.js`: normalization and currency conversion;
- `sellerPayments/salesCreditCalculations.js`: deterministic ledger and sales
  credit calculations.
- `sellerPayments/settlements`: paid, refund, cancellation, dispute, and shadow
  reconciliation;
- `sellerPayments/payouts`: payout queries, repair, run processing, and Wise;
- the remaining top-level domain files: accounts, checkout, credits, and Stripe
  webhook handling.

Modules inside `app/services/sellerPayments` may not import the facade. The
dependency direction is facade to domain module only.

## Withdrawal administration

`withdrawalAdminDetail.js` owns pure action and display decisions shared by the
withdrawal detail route and page. The route remains responsible for
authentication, intent dispatch, and redirects. The page component remains
responsible for rendering.

`withdrawals.server.js` and `withdrawalDirectReturns.server.js` are
compatibility facades. Their implementations live in the matching domain
folders. Do not restore version-suffixed or unreachable legacy email builders
to either facade. Customer email snapshots belong in
`withdrawalEmailTemplates.js`.

`withdrawalAdminList.server.js` owns server-only queue queries and email
actions. `withdrawalAdminList.js` contains only browser-safe constants shared
with the list page.

## Production readiness

`productionReadiness.server.js` is a compatibility facade. The implementation
is split into independent inspectors under `productionReadiness/`, and
`orchestrator.server.js` is the only module that assembles their results. Leaf
inspectors must not import the facade or the orchestrator.

## Vendor management

`vendorManagement.server.js` is a compatibility facade. Sessions, products,
orders, fulfillment, withdrawals, reports, and settings live in the matching
files under `vendorManagement/`. Domain modules must depend on shared helpers,
never back on the facade.

## Automated guard

Run `npm run check:architecture` after moving service or route code. The check
rejects:

- static cycles between service modules;
- known reverse dependencies into readiness orchestration;
- reverse imports from any domain module into its compatibility facade;
- growth beyond the current budgets of the previously oversized files.

Dynamic imports are not treated as dependency-cycle exemptions. They are
allowed for optional runtime integrations, but should not be introduced merely
to hide a static cycle.
