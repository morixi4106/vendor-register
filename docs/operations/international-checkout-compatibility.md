# Checkout Provider Compatibility

This is an administrative read-only diagnostic, not a checkout provider or sale
approval. The source capability remains false, verifier keys empty and artifact
level CONTRACT_ONLY. No live-store qualification is inferred from a plan check.

## Supported Evidence

The fixed Admin2026-04 query reads only `shop.myshopifyDomain` and the boolean
`ShopPlan.shopifyPlus`/`partnerDevelopment` fields. It requests no customer,
address, cart, checkout, order, payment or token data. The response domain must
match the authenticated operator's shop; malformed, partial, wrong-shop, failed,
cancelled or over-limit responses yield UNVERIFIED, not NON_PLUS. The five-second
deadline also bounds an adapter that ignores cancellation. Late results cannot
replace a failed diagnostic. The returned report expires after five minutes.
[Shopify ShopPlan2026-04](https://shopify.dev/docs/api/admin-graphql/2026-04/objects/ShopPlan)

Shopify documents information/shipping/payment checkout UI extensions as Plus-only.
A Plus result meets only that plan prerequisite, not installation, release,
protected-data access, actual observer compatibility or independent route/money
correspondence. A development-store flag is inventory, not permission to treat
synthetic results as live evidence or to bypass the plan requirement.
[Checkout UI Extensions](https://shopify.dev/docs/api/checkout-ui-extensions/latest)

Cart/CartCost returns estimates and does not establish all required native-route
identifiers or final checkout prices. Web Pixels exposes checkout events/token,
but analytics data alone is not independently authenticated verification; customer
privacy/consent and missing delivery correspondence remain separate constraints.
No pixel is installed, consent bypassed, raw checkout event collected or customer
data scope requested by this diagnostic.
[Shopify Cart2026-04](https://shopify.dev/docs/api/storefront/2026-04/objects/Cart),
[checkout_started](https://shopify.dev/docs/api/web-pixels-api/standard-events/checkout_started)

## Administrative Boundary

The existing authenticated admin command accepts the intent only. Shop/URL/plan/
report/proof input is rejected; RELEASE_MANAGER is required before any read. It
uses the session shop and the existing five-per-minute actor/shop limiter. The
limiter's ordinary counters are the only database writes: there is no evidence,
authorization, run/job, gate, configuration, scope, key or release mutation.
CSRF/POST/body bounds/no-store transport remain unchanged. It is available even
while checkout verification is disabled, so diagnostics do not require opening a
gate. No background scheduler or automatic GET-time query is added.

The UI distinguishes diagnosis from recording evidence, Plus/non-Plus/unknown and
expired reports. Every report keeps verificationReady=false and saleReady=false.
The result is ephemeral browser action state, not a saved attestation. Re-reading
the page does not refresh an old result's observation time.

## Remaining Work

Use a genuine approved store observation to determine the available integration;
do not implement a Plus-only bridge assuming the production plan. Supported data
must bind the real checkout/session, product/variant, selected native route and
final money without DOM marker injection or expectations as facts. Complete OS/
browser qualification, managed verifier evidence and financial/SALE verification
separately. This diagnostic does not authorize a live checkout, publication,
deployment, Markets activation, payment/refund or monitoring-mail resumption.
