# Pricing Spec

## Scope

This document describes the current pricing behavior implemented in the codebase as of today.

It does not change the formula, schema, or runtime behavior. It records the current rules so that future changes can be made intentionally.

## Source Of Truth

### Formula source of truth

The pricing formula itself is defined in `app/utils/priceCalculator.js`.

- `calculatePrice(...)`
- `calculatePriceBreakdown(...)`

`calculatePriceBreakdown(...)` exposes the intermediate values.
`calculatePrice(...)` returns the final rounded selling price.

### Runtime source of truth for pricing and Shopify-applied price

The shared runtime calculation path is `app/utils/buildCalculatedPrice.js`.

- `validatePriceInputs(...)`
- `calculateProductPrice(...)`
- `buildCalculatedPrice(...)`

The runtime path that writes a price to Shopify is `app/utils/applyProductPrice.server.js`.

- `applyProductPrice(...)`
- `applyCalculatedPriceToShopify(...)`

`applyProductPrice(...)` reads product pricing metafields from Shopify, resolves shop pricing settings for the target shop, calls `calculateProductPrice(...)`, and then writes the final price back to the first Shopify variant.

### Snapshot source of truth

The shared snapshot shape is defined in `app/utils/priceSnapshot.js`.

- `PRICE_FORMULA_VERSION`
- `buildPriceSnapshot(...)`
- `buildPriceSnapshotUpdate(...)`

Snapshot persistence is apply-only.

- admin preview can build the same snapshot shape in memory
- `Product` is updated only after Shopify price apply succeeds

For successful explanation data, `priceSnapshotJson` is the source of truth.

For current sync state, the scalar `Product` fields are the source of truth:

- `priceSyncStatus`
- `priceSyncError`
- `priceAppliedAt`
- `lastPriceApplyAttemptAt`

### Apply log source of truth

Attempt history is stored separately from both the latest successful snapshot and the current sync state.

`ProductPriceApplyLog` is the source of truth for append-only apply attempt history.

### Preview / helper paths

- `app/routes/admin.products.$id.jsx`
  Uses `calculateProductPrice(...)` for admin-side preview and inspection.
- `app/utils/buildCalculatedPrice.js`
  Is the active shared runtime helper for settings lookup, FX lookup, validation, and breakdown generation.

## Current Formula

Defined in `app/utils/priceCalculator.js`.

### Input variables

- `costAmount`
- `fxRate`
- `dutyRate`
- `marginRate`
- `paymentFeeRate`
- `paymentFeeFixed`
- `bufferRate`

### Formula steps

1. `costFx = costAmount * fxRate`
2. `duty = costFx * dutyRate`
3. `landed = costFx + duty`
4. `safeCost = landed * (1 + bufferRate)`
5. `target = safeCost * (1 + marginRate)`
6. `rawPrice = (target + paymentFeeFixed) / (1 - paymentFeeRate)`
7. `finalPrice = Math.ceil(rawPrice)`

### Notes

- Packaging fee is not part of the current active formula.
- Duty is percentage-based and is applied to `costFx`.
- Buffer and margin are multiplicative uplifts, applied in that order.
- Payment fee is modeled as:
  - fixed fee: `paymentFeeFixed`
  - rate fee: `paymentFeeRate`

## Rounding Rule

The final sell price is always rounded up with `Math.ceil(rawPrice)`.

This means:

- fractional values are rounded upward to the next integer
- integer `rawPrice` values remain unchanged

The breakdown keeps both:

- `rawPrice`
- `finalPrice`

## Determinism

The pricing formula is deterministic if the normalized inputs are identical.

In practice, the following full set must be fixed for the same result:

- `costAmount`
- `costCurrency`
- `fxRate`
- `dutyRate`
- `marginRate`
- `paymentFeeRate`
- `paymentFeeFixed`
- `bufferRate`

Given the same values above, the current implementation will produce the same `rawPrice` and the same `finalPrice`.

## Input Inventory

### Product-level inputs

Stored in the local DB `Product` record:

- `price`
- `costAmount`
- `costCurrency`
- `category`
- `shopifyProductId`
- `calculatedPrice`
- `usedFxRate`
- `usedMargin`
- `usedDutyRate`
- `usedFee`
- `roundingResult`
- `calculatedAt`
- `priceSyncStatus`
- `priceSyncError`
- `priceAppliedAt`
- `lastPriceApplyAttemptAt`
- `priceFormulaVersion`
- `priceSnapshotJson`

Stored in local DB `ProductPriceApplyLog` rows:

- `productId`
- `shopifyProductId`
- `shopDomain`
- `attemptedPrice`
- `priceFormulaVersion`
- `status`
- `errorSummary`
- `attemptedAt`
- `priceSnapshotJson`

Stored on Shopify product metafields:

- `pricing.cost_amount`
- `pricing.cost_currency`
- `pricing.duty_category`

### Shop-level inputs

Stored on Shopify shop metafields:

- `global_pricing.default_margin_rate`
- `global_pricing.payment_fee_rate`
- `global_pricing.payment_fee_fixed`
- `global_pricing.buffer_rate`

### FX inputs

Stored in local DB table `FxRate`:

- `base`
- `quote`
- `rate`

Current lookup path expects `base = <currency>` and `quote = "JPY"`.

## Input Sources By Runtime Path

### Vendor product create

`app/routes/vendor.products.new.jsx`

- reads `price` from form input
- stores that numeric value into both:
  - `price`
  - `costAmount`
- stores `costCurrency`
- stores `category`
- creates the product with `approvalStatus = "pending"`

At this stage, no calculated Shopify sell price is written yet.
The local sync state starts as `calculated_not_applied`.

### Vendor product edit

`app/routes/vendor.products.$id.edit.jsx`

- updates local DB `price`
- updates local DB `costAmount`
- updates local DB `costCurrency`
- updates local DB `category`
- if `shopifyProductId` exists, pushes updated pricing metafields to Shopify

Current Shopify metafield update behavior:

- always writes `pricing.cost_amount`
- always writes `pricing.cost_currency`
- writes `pricing.duty_category = "cosmetics"` only when category is one of the mapped cosmetics labels
- does not explicitly clear `pricing.duty_category` when the category is no longer mapped

This means a previously written duty category can remain on Shopify unless overwritten elsewhere.

When the edit is saved successfully, local sync state moves to `calculated_not_applied`.
The last successful snapshot is kept until a later successful apply replaces it.

### Admin product detail preview

`app/routes/admin.products.$id.jsx` loader

Preview breakdown uses:

- Shopify product pricing metafields when the product is linked and Shopify is reachable
- otherwise local DB `product.costAmount` or fallback `product.price`
- otherwise local DB `product.costCurrency`
- otherwise duty category resolved from local DB `product.category`
- `calculateProductPrice(...)`
- shop settings read through `getShopPricingSettings(...)`, with local defaults on read failure

Current admin preview defaults are:

- `marginRate = 0.1`
- `paymentFeeRate = 0.04`
- `paymentFeeFixed = 50`
- `bufferRate = 0.1`

Current duty-rate mapping in that loader is:

- `cosmetics -> 0.2`
- everything else -> `0`

### Admin approve path for a product not yet linked to Shopify

`app/routes/admin.products.$id.jsx` action

When approving a product with no `shopifyProductId`:

1. create Shopify product
2. write pricing metafields onto Shopify product
3. set the initial variant price to `product.costAmount ?? product.price ?? 0`
4. call `applyProductPrice(createdProduct.id)`
5. save returned Shopify product id to local DB

This means the initial variant price is only transitional.
The persistent final sell price is the result of `applyProductPrice(...)`.

### Admin apply-price path

`app/routes/admin.products.$id.jsx` action and `app/routes/api.apply-price.jsx`

Both eventually call `applyProductPrice(productId)`.

The admin page refreshes FX rates first through `app/routes/api.refresh-fx.jsx`, then applies price.
The API route applies price directly.

Admin retry uses the same apply path.
There is no separate retry implementation.

`api.apply-price` may receive `shopDomain` from the caller, but `applyProductPrice(...)` treats that value as fallback or ambiguity resolver only.

If a unique local `Product.shopDomain` is already known for the matching `shopifyProductId`, that local value is preferred over the caller input.

If a local `Product` cannot be resolved for snapshot persistence, `applyProductPrice(...)` fails before it updates Shopify.

### Shopify-side applied price path

`app/utils/applyProductPrice.server.js`

This is the active write path to Shopify.

It reads:

- `pricing.cost_amount` from Shopify product metafield
- `pricing.cost_currency` from Shopify product metafield
- `pricing.duty_category` from Shopify product metafield
- `global_pricing.*` from Shopify shop metafields
- FX from local DB

Then it writes:

- first variant price = `String(finalPrice)`

After Shopify write succeeds, the same apply path persists the latest snapshot onto the local `Product`.

That saved snapshot includes at least:

- `calculatedPrice`
- `usedFxRate`
- `usedMargin`
- `usedDutyRate`
- `usedFee`
- `roundingResult`
- `calculatedAt`
- `priceFormulaVersion`
- `priceSnapshotJson`

`priceSnapshotJson` now also includes the explanation inputs and source metadata, including:

- `input.costAmount`
- `input.costCurrency`
- `input.dutyCategory`
- `input.shopDomain`
- `shopDomain`
- `source`

`priceFormulaVersion` is currently managed as a code constant in `app/utils/priceSnapshot.js`.

On apply success, local state becomes:

- `priceSyncStatus = "applied"`
- `priceSyncError = null`
- `priceAppliedAt = calculatedAt`
- `lastPriceApplyAttemptAt = calculatedAt`

On the same success path, a `ProductPriceApplyLog` row is appended with:

- `status = "success"`
- `attemptedPrice = finalPrice`
- the applied snapshot shape in `priceSnapshotJson`

On apply failure, the last successful snapshot is preserved.
Only the sync-state fields are updated.

Calculation/input/FX failures are stored as `invalid`.
Shopify/session/mutation failures are stored as `apply_failed`.

On the same failure path, a `ProductPriceApplyLog` row is appended with:

- `status = "invalid"` or `status = "apply_failed"`
- `errorSummary`
- `attemptedAt`
- the attempted snapshot when it was already available

If a local `Product` cannot be resolved safely, apply logging still attempts to persist a row with `productId = null` so that the failed attempt is not lost.

## Duty Category Behavior

Defined partly in:

- `app/utils/dutyCategory.js`
- `app/routes/admin.products.$id.jsx`
- `app/utils/applyProductPrice.server.js`
- `app/routes/vendor.products.$id.edit.jsx`

### Category normalization

`resolveDutyCategory(category)` currently maps only these category labels to `"cosmetics"`:

- `スキンケア`
- `美容液`

If the category is not mapped, it returns `null`.

### Duty rate mapping

Current runtime duty-rate maps:

- `cosmetics -> 0.2`
- unmapped / missing -> `0`

No other duty categories are currently active.

## FX Behavior

Defined in:

- `app/utils/fxRates.server.js`
- `app/routes/api.refresh-fx.jsx`

### Lookup

`getFxRateToJpy(currency)`:

- normalizes the currency to uppercase
- returns `1` when currency is `JPY`
- otherwise looks up `<currency>/JPY` in local DB

### Refresh

`app/routes/api.refresh-fx.jsx`:

- fetches rates from ExchangeRate-API using `latest/USD`
- derives:
  - `USD/JPY` directly from API response
  - `EUR/JPY`, `GBP/JPY`, `CNY/JPY`, `KRW/JPY` by cross-rate conversion through USD
- saves them via `upsertFxRate(...)`

Current refresh target currencies are:

- `USD`
- `EUR`
- `GBP`
- `CNY`
- `KRW`

## Shop Pricing Settings Behavior

Defined in:

- `app/utils/shopPricingSettings.js`
- `app/routes/admin.products.$id.jsx`
- `app/utils/applyProductPrice.server.js`

### Shopify metafield keys

- `global_pricing.default_margin_rate`
- `global_pricing.payment_fee_rate`
- `global_pricing.payment_fee_fixed`
- `global_pricing.buffer_rate`

### Fallback defaults

Current defaults used when values are absent or invalid:

- default margin rate: `0.1`
- payment fee rate: `0.04`
- payment fee fixed: `50`
- buffer rate: `0.1`

## Validation Rules

Defined in `app/utils/priceCalculator.js`.

### Required numeric validity

All of the following must be numbers and must not be `NaN`:

- `costAmount`
- `fxRate`
- `dutyRate`
- `marginRate`
- `paymentFeeRate`
- `paymentFeeFixed`
- `bufferRate`

### Range rules

- `costAmount >= 0`
- `fxRate > 0`
- `dutyRate >= 0`
- `marginRate >= 0`
- `paymentFeeRate >= 0 && paymentFeeRate < 1`
- `paymentFeeFixed >= 0`
- `bufferRate >= 0`

## Calculation-Impossible Cases

### Pure formula level

`calculatePrice(...)` throws when:

- any input is not a valid number
- `costAmount < 0`
- `fxRate <= 0`
- `dutyRate < 0`
- `marginRate < 0`
- `paymentFeeRate < 0`
- `paymentFeeRate >= 1`
- `paymentFeeFixed < 0`
- `bufferRate < 0`

### FX level

`getFxRateToJpy(...)` throws when:

- currency is missing
- DB record for `<currency>/JPY` does not exist
- stored rate is not finite
- stored rate is `<= 0`

### Shopify settings level

`getShopPricingSettings()` throws when:

- offline session cannot be found
- Shopify GraphQL request fails
- Shopify returns GraphQL errors

### Shopify apply-price level

`applyProductPrice(...)` throws when:

- `productId` is missing
- offline Shopify session cannot be found
- Shopify product does not exist
- first variant does not exist
- `pricing.cost_amount` is empty or numerically zero
- FX lookup fails
- local `Product` cannot be resolved for snapshot persistence
- Shopify mutation returns user errors

Important current discrepancy:

- `calculatePrice(...)` allows `costAmount = 0`
- `applyProductPrice(...)` rejects `costAmount = 0` because it calls `validatePriceInputs(..., { requirePositiveCostAmount: true })`

So a zero-cost input is mathematically allowed by the formula, but is operationally blocked by the Shopify apply path.

## State Model

### Runtime calculation state

Admin preview can report:

- `calculable`
- `invalid`

This state is derived at read time and is not persisted by preview.

### Persisted sync state

`Product.priceSyncStatus` currently uses:

- `calculated_not_applied`
- `applied`
- `invalid`
- `apply_failed`

State transitions:

- vendor create success -> `calculated_not_applied`
- vendor edit success -> `calculated_not_applied`
- apply success -> `applied`
- apply failure caused by calculation/input/FX -> `invalid`
- apply failure caused by Shopify/session/mutation -> `apply_failed`

### Apply attempt outcome state

`ProductPriceApplyLog.status` currently uses:

- `success`
- `invalid`
- `apply_failed`

This keeps the meanings distinct:

- `Product.priceSyncStatus = "applied"` means the current local sync state is healthy
- `ProductPriceApplyLog.status = "success"` means one specific apply attempt completed successfully

## Current Known Divergences

### 1. `costAmount = 0` is still a responsibility split between preview and apply

- preview paths can calculate with `costAmount = 0`
- `applyProductPrice(...)` intentionally requires `costAmount > 0`

This is not a formula difference.
It is an operational rule on the Shopify apply path.

### 2. DB `price` is not the pricing source of truth after Shopify linkage

Once a product is linked to Shopify and price is applied, the effective Shopify sell price is driven by:

- Shopify product pricing metafields
- Shopify shop pricing settings metafields
- local FX table

The DB field `price` currently acts more like input storage / fallback than the final applied price source of truth.

The latest applied explanation state is stored separately on `Product` via:

- `calculatedPrice`
- `calculatedAt`
- `priceFormulaVersion`
- `priceSnapshotJson`

Attempt history does not replace those fields.
Logs are append-only and are not the source of truth for the latest successful state.

## Practical Definition Of "Same Input"

For the current system, "same input" means all of the following are the same at calculation time:

- Shopify product `pricing.cost_amount`
- Shopify product `pricing.cost_currency`
- Shopify product `pricing.duty_category`
- Shopify shop `global_pricing.default_margin_rate`
- Shopify shop `global_pricing.payment_fee_rate`
- Shopify shop `global_pricing.payment_fee_fixed`
- Shopify shop `global_pricing.buffer_rate`
- local DB FX rate for `<currency>/JPY`

If those inputs are identical, the current formula will return the same final price.

## Related Files

Core:

- `app/utils/priceCalculator.js`
- `app/utils/buildCalculatedPrice.js`
- `app/utils/fxRates.server.js`
- `app/utils/dutyCategory.js`
- `app/utils/shopPricingSettings.js`
- `app/utils/priceSnapshot.js`
- `app/utils/priceSyncStatus.js`
- `app/utils/applyProductPrice.server.js`

Routes and actions that affect pricing inputs or applied price:

- `app/routes/vendor.products.new.jsx`
- `app/routes/vendor.products.$id.edit.jsx`
- `app/routes/admin.products.$id.jsx`
- `app/routes/api.apply-price.jsx`
- `app/routes/api.refresh-fx.jsx`

Persistence for apply attempt history:

- `prisma/schema.prisma`
- `ProductPriceApplyLog`

Legacy / incomplete input path worth noting:

- `app/routes/api.product-create.jsx`

That route creates a product with `price` only and does not set the full pricing inputs required by the active pricing pipeline.
