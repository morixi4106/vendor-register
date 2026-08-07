# Checkout Function production live-probe runbook

## Purpose and boundary

This runbook verifies the 16 release-bound checkout scenarios without placing
an order. The Shopify storefront stays password protected. Stop before any
payment confirmation.

The `本番確認` page only records results. It does not create test controls,
change the metafield or restore the baseline. A marketplace operator performs
each controlled write, Shopify read-back and restoration. The storefront tester
only operates the cart and saves evidence.

Do not ask the storefront tester to edit metafields. Do not use bulk product
edits, publication changes, inventory changes, refunds or password changes.

## Required order

1. Pass CI and automated Function tests on the exact main commit.
2. Create a Shopify App Version with `--no-release` and inspect its contents.
3. Set the exact version name in `SHOPIFY_APP_VERSION`, redeploy the same main
   commit and confirm the Release ID.
4. Before releasing the new Function, use `INACTIVE基準値を同期・確認` and save
   the successful Shopify read-back.
5. Inspect the current validation ID, Function handle and `blockOnFailure`.
6. Release the inspected version explicitly. Wait for Shopify to report it as
   active.
7. Run the scenarios below. Restore and read back INACTIVE after every scenario.
8. Record the 16 evidence packages only after every restoration succeeds.
9. Start the real-payment E2E only after the final INACTIVE read-back.

If step 4 fails, do not release. If a restoration fails, stop testing and apply
BLOCKED plus the independent purchase stop. Do not continue to the next case.

## Fixed test inputs

Record these once before the first scenario:

- Release ID, Render commit, Shopify App Version and migration version
- Function handle, UID, Shopify Function ID and API version
- Validation ID and `blockOnFailure`
- production shop domain
- one approved platform-direct Shopify product GID
- one variant GID belonging to that product
- current JPY cart total for quantity 1
- current product sale-eligibility projection revision
- current shop-local date reported by Shopify

Use the same product, variant, quantity and cart throughout. The second product
used by `blockedProductRejected` must be a different, otherwise
purchase-eligible platform-direct product so that the observed rejection comes
from the limited-launch allowlist. Do not change inventory or publication state
for this probe.

## Control write rule

For every valid test projection:

1. Read the current metafield value and `compareDigest`.
2. Use a revision greater than the last successfully read revision.
3. Generate the control hash with the checked-in projection builder. Do not
   type or invent `h` manually.
4. Write with the read `compareDigest`.
5. Read the metafield back and compare the complete JSON, revision and hash.
6. Run one storefront observation.
7. Restore INACTIVE with another higher revision and verify the complete
   read-back.

The initial `INACTIVE基準値を同期・確認` action creates the pre-release baseline.
After scenario writes begin, restoration must use the next monotonic revision;
do not reuse revision 1.

Missing, malformed, unknown-version and `r=0` cases intentionally cannot use
the normal valid-projection writer. Those writes must still use the current
`compareDigest`, be followed by an exact read-back and be restored immediately.

## Evidence package

Create one access-controlled package per scenario. Use this file name:

```text
<sequence>-<scenario-id>-<release-id>.zip
```

Each package contains:

- before-control read-back with revision and `compareDigest`
- requested test value or explicit deletion record
- after-write Shopify read-back
- cart/checkout screenshot showing the result and URL origin
- Shopify local date used by the Function
- after-test INACTIVE restoration read-back
- operator, observation time and product projection revision

Calculate the package hash in PowerShell:

```powershell
(Get-FileHash -LiteralPath '<absolute-package-path>' -Algorithm SHA256).Hash.ToLower()
```

Enter the access-controlled evidence reference and that 64-character hash on
the `本番確認` page. Do not place customer data, tokens or complete metafield
credentials in the package.

## Scenario sequence

The expected Japanese message is part of the evidence for rejected cases.
Allowed means that the app validation does not reject checkout; do not pay.

| Seq | Scenario ID | Temporary state/input | Storefront observation | Expected result |
| --- | --- | --- | --- | --- |
| 01 | `directProductAllowed` | Verified INACTIVE baseline | Direct product, quantity 1, standard checkout | `checkout_allowed` |
| 02 | `shopPayObserved` | Verified INACTIVE baseline | Same cart through Shop Pay, stop before payment | `checkout_allowed` |
| 03 | `controlMetafieldMissingRejected` | Delete only `$app/komoju_limited_launch_control` | Same cart | `checkout_rejected`: `現在、購入条件を確認できないため注文を受け付けられません。時間をおいて再度お試しください。` |
| 04 | `controlMetafieldMalformedRejected` | Store malformed JSON | Same cart | `checkout_rejected`: `限定公開の購入条件を確認できません。時間をおいて再度お試しください。` |
| 05 | `controlVersionUnknownRejected` | Complete control shape with unsupported `v` | Same cart | `checkout_rejected`: invalid-control message |
| 06 | `preparingControlRejected` | Valid PREPARING control | Same cart | `checkout_rejected`: limited-launch-ended message |
| 07 | `invalidRevisionRejected` | Complete control shape with `r=0` | Same cart | `checkout_rejected`: invalid-control message |
| 08 | `globalStopRejected` | Valid BLOCKED control | Same cart | `checkout_rejected`: limited-launch-ended message |
| 09 | `activeAllowedProductAllowed` | ACTIVE, selected product/variant, quantity 1, all caps above cart total, `o=1` | Same selected cart | `checkout_allowed` |
| 10 | `blockedProductRejected` | Same ACTIVE control | Cart containing the preselected non-allowlisted product | `checkout_rejected`: `限定公開の対象外商品が含まれています。` |
| 11 | `activeSingleOrderLimitRejected` | ACTIVE with `m` below cart total | Selected cart | `checkout_rejected`: order-limit message |
| 12 | `activeGrossLimitRejected` | ACTIVE with `g` below cart total | Selected cart | `checkout_rejected`: order-limit message |
| 13 | `activeLiabilityLimitRejected` | ACTIVE with `l` below cart total | Selected cart | `checkout_rejected`: order-limit message |
| 14 | `activeOrderCountLimitRejected` | ACTIVE with `o=0` | Selected cart | `checkout_rejected`: order-limit message |
| 15 | `expiryBoundaryRejected` | ACTIVE with `e` equal to Shopify local date | Selected cart | `checkout_rejected`: limited-launch-ended message |
| 16 | `expiredControlRejected` | ACTIVE with `e` before Shopify local date | Selected cart | `checkout_rejected`: limited-launch-ended message |

Message aliases in the table:

- invalid-control: `限定公開の購入条件を確認できません。時間をおいて再度お試しください。`
- limited-launch-ended: `限定公開期間が終了したため、現在注文を受け付けていません。`
- order-limit: `限定公開の注文上限に達したため、現在注文を受け付けていません。`

## Stale positive revision evidence

`invalidRevisionRejected` proves that the Function rejects a structurally
invalid revision such as `r=0`. It does not prove that the Function compares a
positive revision with an earlier value; Shopify Functions receive only the
current projection.

Stale positive writes are a server-side concurrency control. Preserve the CI
run proving both of these tests as separate release evidence:

```powershell
node --test tests/services/marketplaceCheckoutGate.server.test.js
```

- `limited launch projection refuses a stale write over BLOCKED`
- `compareDigest conflict re-reads state and cannot overwrite concurrent BLOCKED`

Do not record this server-side evidence as one of the 16 checkout observations.

## Abort and recovery

Stop immediately when any write, read-back, checkout observation or INACTIVE
restoration differs from the expected value.

1. Write a higher-revision BLOCKED control with `compareDigest` and read it back.
2. Apply the independent purchase stop.
3. Keep the storefront password protected.
4. Disable the affected validation if the approved rollback procedure requires
   it.
5. Do not mark the scenario passed and do not proceed to payment E2E.

After all 16 scenarios pass, perform one final higher-revision INACTIVE write
and read-back. The Release Manifest evidence is valid only while the release,
Function, validation, policy and projection schema still match.
