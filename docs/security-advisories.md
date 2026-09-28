# Production dependency advisories

## Current status

As of 2026-09-29, the production dependency audit passes without an active
runtime or Shopify build-tool exception:

- the application framework has been migrated from Remix 2 and React Router 6
  to React Router 7;
- the former React Router moderate-advisory exception has been removed from
  the audit policy;
- the Shopify extension build graph resolves `brace-expansion` to `2.1.4`;
- `npm audit` reports no known vulnerabilities;
- production server, client, Checkout Function, and Customer Account extension
  artifacts are scanned for unexpected dependency reachability.

Runtime vulnerabilities fail CI. There is no severity-based runtime exception.

## Historical Shopify build-tool acceptance

The repository retains the accepted
`security/risk-decisions/GHSA-mh99-v99m-4gvg.json` record and its approved-path
snapshot as audit provenance. They document the temporary review of
`brace-expansion@2.1.2` in Shopify-owned build dependencies and must not be
treated as an active exception now that the lockfile is patched.

The original upstream reports remain available at:

- <https://github.com/Shopify/shopify-function-javascript/issues/129>
- <https://community.shopify.dev/t/ui-extensions-toolchain-installs-brace-expansion-2-1-2-affected-by-ghsa-mh99-v99m-4gvg/36425>

The dated investigation and artifact evidence remain in
`docs/security-toolchain-evidence-2026-07-28.md`.

## Update procedure

1. Regenerate `package-lock.json` with the repository's pinned Node and npm
   versions.
2. Run `npm ci`, the root build, and the production Shopify app build.
3. Run `npm run audit:production`.
4. Reject the change if an affected package is production-runtime reachable,
   unresolved, extraneous, or present in a deployable artifact.
5. Do not add or extend a dependency exception merely to make CI pass. A new
   exception requires a separate, time-bounded review with upstream tracking,
   complete path evidence, and explicit approval provenance.

`postcss` remains pinned to `8.5.24` through both `overrides` and `resolutions`.
