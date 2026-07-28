# Shopify toolchain dependency report

These are publication-ready drafts for the two upstream reports required by
the temporary dependency acceptance. They contain no credentials, customer
data, local file paths, or private repository links.

Do not change the risk record to `accepted` until both reports have been
submitted and their real public URLs have been recorded.

## Shopify Function JavaScript issue

Target:
<https://github.com/Shopify/shopify-function-javascript/issues/new>

Title:

```text
Build dependency chain installs brace-expansion@2.1.2 affected by GHSA-mh99-v99m-4gvg
```

Body:

```text
### Summary

The current Shopify Function JavaScript toolchain installs
brace-expansion@2.1.2 through minimatch@9.0.9. npm audit reports
GHSA-mh99-v99m-4gvg as high severity.

### Environment and versions

- Node.js 24.13.1
- npm 11.8.0
- @shopify/shopify_function 2.0.1
- @graphql-codegen/cli 5.0.6
- graphql-config 5.1.3
- minimatch 9.0.9
- brace-expansion 2.1.2

### Reproduction

In a Shopify app with a JavaScript Function extension:

1. Run `npm ci` from a clean checkout.
2. Run `npm explain minimatch --json`.
3. Run `npm explain brace-expansion --json`.
4. Run `npm audit --json`.

The Function workspace reaches the affected package through the Shopify
Function/code-generation build chain, including graphql-config/minimatch.

The production app build was generated with:

`npm exec --offline -- shopify app build --config production --no-color --skip-dependencies-installation`

We checked the generated Function JavaScript and WASM with static byte/string
searches and found no minimatch, brace-expansion, or graphql-config package
reference. We therefore believe this is a build-tool dependency, but still
fail our dependency audit until it is resolved or narrowly reviewed.

Forcing minimatch 10 as a consumer override is not a safe workaround:
graphql-config 5.1.3 declares minimatch ^9.0.5, so npm reports the dependency
tree as invalid.

### Expected result

The supported Function build dependencies should resolve to a minimatch /
brace-expansion combination that is not affected by
GHSA-mh99-v99m-4gvg.

The smallest preferred fix is a compatible Shopify Function dependency update
whose graphql-config/minimatch ranges support a patched brace-expansion
release, without requiring consumers to force an out-of-range major override.

### Additional context

The package is used by the build toolchain and is not imported by the
generated Function JavaScript or WASM artifact in our verification. We are
still treating the audit result as fail-closed and would prefer an upstream
dependency update over an incompatible package override.
```

## Shopify UI Extensions community topic

Target:
<https://community.shopify.dev/c/extensions/5>

Title:

```text
UI Extensions toolchain installs brace-expansion@2.1.2 affected by GHSA-mh99-v99m-4gvg
```

Body:

```text
The current Customer Account UI Extension dependency chain installs
brace-expansion@2.1.2 through:

@shopify/ui-extensions
  -> ts-morph
  -> @ts-morph/common
  -> minimatch@9.0.9
  -> brace-expansion@2.1.2

Environment and versions:

- Node.js 24.13.1
- npm 11.8.0
- @shopify/ui-extensions 2026.4.0
- ts-morph 25.0.1
- @ts-morph/common 0.26.1
- minimatch 9.0.9
- brace-expansion 2.1.2

`npm audit` reports GHSA-mh99-v99m-4gvg as high severity. A clean production
Shopify app build confirms that these packages are build-time dependencies and
are not present in the generated UI extension JavaScript, source map inputs,
or metafile inputs.

Reproduction:

1. Run `npm ci` from a clean checkout.
2. Run `npm explain minimatch --json`.
3. Run `npm explain brace-expansion --json`.
4. Run `npm audit --json`.
5. Run
   `npm exec --offline -- shopify app build --config production --no-color --skip-dependencies-installation`.

We inspected the generated UI bundles, source maps, metafile input lists, and
external imports. None references minimatch, brace-expansion, ts-morph, or
@ts-morph/common.

Could the supported UI Extensions dependency chain be updated to versions of
ts-morph / @ts-morph/common that use a non-affected minimatch and
brace-expansion version?

We do not want to force an incompatible minimatch major through an application
override, because @ts-morph/common 0.26.1 declares minimatch ^9.0.4 and npm
reports an override to minimatch 10 as an invalid dependency tree.

The smallest preferred fix is a compatible @shopify/ui-extensions dependency
update whose ts-morph/@ts-morph/common chain permits a patched minimatch and
brace-expansion release.
```

## After publication

Record the two real URLs in:

`security/risk-decisions/GHSA-mh99-v99m-4gvg.json`

Then a human reviewer, in a separate explicit decision change, may change:

```json
"status": "accepted"
```

Do not alter the advisory ID, package version, path count, path fingerprint, or
expiry date unless a fresh dependency review proves the new values.
