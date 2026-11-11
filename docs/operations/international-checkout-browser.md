# Nonfinancial Checkout Browser

Status: implemented browser observation/guard and sanitized child-process bridge,
with synthetic real-browser tests. **Not qualified for live Shopify observations.**
The source capability remains false, verifier registry empty and artifact level
CONTRACT_ONLY. This document does not authorize a live checkout or any activation.

## Boundaries

- The existing agent signs only the observer's four fixed output fields. The
  browser child has no signing, transport, Shopify, mail, payment or DB credentials;
  it uses IPC only, private temporary home/profile, ignored stdout/stderr and a
  constant128MB Node heap. Chromium's sandbox stays enabled, with no custom
  executable, shell, arbitrary launch arguments, preload or persistent profile.
- Playwright1.64.1 is locked in a separate private tools package. Root app/runtime
  dependencies and native-tool approval are unchanged. Install with npm ci and
  ignore lifecycle scripts. Chromium revision/version comes from that locked
  package; do not substitute the previously installed older browser revision.
- URL validation allows a single HTTPS checkout path on the server-selected
  myshopify domain. No credentials, alternate host/port, fragments, redirect URL,
  duplicate parameters or arbitrary navigation. Custom-domain redirects are
  unsupported until separately reviewed, not automatically allowlisted.
- Only the exact main document and narrowly scoped static GET assets pass the
  browser routing guard. All POST/XHR/fetch/iframe navigation, WebSockets, popups,
  downloads and dialogs are rejected and invalidate an observation. Service workers
  are blocked. There is no click, submit, form-fill, payment or wallet API.
- Browser routing is not an OS egress sandbox or a guarantee against every browser
  side channel. Production process/container egress and resource supervision need
  separate qualification. Node heap bounds do not bound all Chromium memory.

## Observation Contract

A reviewed parent adapter must implement prepare/read. It owns checkout-session
creation and independent fresh facts; these functions, URLs and facts cannot come
from the runner HTTP body. There is deliberately **no default Shopify provider**.
The Storefront Cart API documents checkoutUrl and estimated cart costs; estimated
cart data alone is not proof of final checkout totals or exact route correspondence.
[Shopify Cart2026-04](https://shopify.dev/docs/api/storefront/2026-04/objects/Cart)

The2026-04 CartCost contract also exposes estimated flags; a false flag does not
establish this verifier's full tax, selected delivery-profile/method/provider and
final-checkout identity correspondence. CartDeliveryGroup has a selected delivery
option, but no documented mapping to every native administrative route identifier
required here. These are compatibility gaps, not grounds to fabricate final facts
from a cart response or inject identity markers into the checkout DOM.
[Shopify CartCost](https://shopify.dev/docs/api/storefront/2026-04/objects/CartCost),
[Shopify CartDeliveryGroup](https://shopify.dev/docs/api/storefront/2026-04/objects/CartDeliveryGroup)

Fixed facts include product/variant/quantity, country, JPY, subtotal/shipping/tax/
total, displayed product/variant/seller/delivery labels, route hash and time.
Missing, rounded, negative, fractional-JPY, inconsistent or older30-second values
are rejected. Only undiscounted tax-exclusive arithmetic is currently supported.
GB is unsupported until NI classification is separately bound. No raw addresses,
customer emails, card information or free evidence notes are accepted.

The fixed semantic DOM profile requires visible country/line identity, seller,
money rows, currency and delivery labels. It only observes whether a payment
control is visible; it never activates it. Exact known gate rejection is distinct
from an unrelated failure. Hidden/missing/changed values are NOT_OBSERVED, not a
pass. Expectations are compared after observation, not used to synthesize it.

**The profile's data attributes are a strict compatibility requirement of this
candidate, not a documented Shopify DOM guarantee.** No actual Shopify checkout
has been shown to expose every required marker. Do not add missing markers via
page.evaluate, infer variant/route from titles alone or loosen the profile merely
to make a real page pass. A genuine supported data-to-checkout correlation and
actual compatibility evidence are still required before live qualification.

Each session has a fresh isolated context; allowed OPEN sessions are retained only
in memory for the same old-checkout CLOSED case. New sessions cannot reuse old
URLs. Digests use a per-process random HMAC key and run domain; raw URL/token,
HTML, storage, cookies, traces and request logs are not returned or uploaded.
Abort, deadline and close dispose contexts, reject pending RPC and remove profiles.

## Capacity and Failure Lifecycle

The database retains its2048-case history bound. The managed browser has a separate
256-session execution bound: an old CLOSED checkout reuses its OPEN session;
allowed, new CLOSED, denied-country and domestic cases each allocate a new one.
The server computes this exact demand before approval, and rechecks stored plans
on next/claim. The agent rechecks the complete pinned case set before requesting a
challenge. Unsupported GB scope and orphaned OPEN/CLOSED pairs are rejected too.
No coverage is truncated or silently split; an operator must approve a smaller
explicit scope. The execution bound does not guarantee completion within the
ten-minute run budget or impose a whole-browser memory limit.

The parent reserves capacity and rejects duplicate cases before prepare. It checks
duplicate checkout identities before read, ignoring query/locale differences;
old sessions also require the next generation before read. Prepare/read share a
maximum25-second deadline, capped by the challenge expiry. Caller abort, close or
child exit cancels that deadline and permanently retires an uncertain process.
A callback ignoring AbortSignal cannot forward its late result to another callback,
IPC or the signer. Raw provider exceptions are replaced by a fixed failure code.
This does not roll back a cart already created remotely: a future provider must
honor AbortSignal and explicitly qualify remote side-effect handling. No such
provider is enabled by this implementation.

Idle/no-task and failed-next agent paths close the observer. Shutdown is idempotent
and concurrent close calls share one cleanup operation. The agent disposes the
observer before finalize; cleanup failure cannot report a successful run. A failed
claimed run has a separate five-second, abortable STOP-report budget even when its
work deadline has elapsed. An unsuccessful report is not proof of closure: durable
server expiry/STOP and closed-state readback remain necessary. None of these paths
can activate SALE or resume prelaunch monitoring mail.

## Verification

The isolated workflow pins Node, npm integrity, Playwright and its browser build;
Chromium sandbox remains enabled on Windows and Ubuntu22.04. Every permitted page
request is fulfilled in memory, not forwarded to a store. Actual Chromium renders
the fixture and executes its hostile scripts. The probe checks old/new session
correspondence, country denial/domestic regression, substitutions, hidden values,
navigation/POST/iframe/WebSocket/popup/dialog/submit rejection and real sanitized
child startup/closure at320/375/1440px. Only aggregate synthetic receipts are
uploaded; screenshots are synthetic local aids, not customer evidence.

The Playwright API explicitly distinguishes request routing and service workers,
so both HTTP routing and separate WebSocket interception are installed before a
page is created, with serviceWorkers:block.
[Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)

The proof manifest requires an independent same-commit checkout-browser CI run
alongside Quality and isolated PostgreSQL. Browser CI success proves this scoped
fixture behavior, not live-store compatibility, a managed NON_FINANCIAL package,
payment completion, refund, legal compliance or sale readiness. See the current
launch memo and PR evidence for actual conclusions, not just these test definitions.
