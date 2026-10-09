# Production dependency advisories

## Current status

2026-10-08: the dependency refresh on `agent/shopify-centered-privacy` pins
`proxy-addr` to `2.0.8`, `brace-expansion` to `2.1.7`, `@fastify/busboy` to
`3.2.2`, `@graphql-tools/executor-legacy-ws` to `1.1.37`, `shell-quote` to
`1.12.0`, and `source-map-js` to `1.2.2`.
These are available patch/minor fixes, not new risk exceptions.
Re-run the complete production audit before deployment; the September result
below is historical and does not establish the current dependency safety.
`braces` and `sprintf-js` have no newer published version at this check. The
first refresh still included older GraphQL Tools utility versions; the
follow-up below removes them.
The build-tool gate must not be relaxed or given fabricated acceptance.

The follow-up pins **all** GraphQL Tools utility instances to official
`12.0.3` and moves `@shopify/shopify_function@2.0.1` from the Function's
runtime dependency list to the root development tools. This keeps the Shopify
compiler unchanged while applying the root security override to its pinned
code-generation dependencies. Fresh-install regression tests verify every
physical utility version and the Function compiler's resolution path, and
exercise prototype-pollution protection in the actual patched merger.
Artifact scanning now explicitly rejects `braces`, `micromatch`, `fast-glob`
and `@graphql-tools/utils` in application imports and deployable artifacts,
with regression tests for accidental runtime inclusion.

The audit now applies an archived exception only if its exact package and
advisory are requested. A different or unresolved High/Critical remains
blocked, including when the historical record has expired. This removes
irrelevant expiry/version errors; it does not accept new vulnerabilities.

The remaining High leaf is `braces@3.0.3`
([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)).
The published advisory lists no patched version, and the upstream
[issue #70](https://github.com/micromatch/braces/issues/70) remains open.
Do not relabel, rename or silently accept this dependency to pass CI.
`sprintf-js@1.1.3` remains a reported Moderate build-tool advisory, not a
claim of zero vulnerabilities. No new exception or production switch is
approved by these dependency changes.

## Previous clean audit

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
