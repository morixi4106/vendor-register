# Production dependency advisories

## Temporary React Router 6 exception

The production audit currently contains a narrow exception for these moderate
React Router advisories:

- `GHSA-wrjc-x8rr-h8h6`
- `GHSA-337j-9hxr-rhxg`
- `GHSA-jjmj-jmhj-qwj2`

The affected dependency chain is provided by Remix 2. A direct React Router 7
override was tested and rejected because Remix 2 still imports
`react-router-dom/server`, which is not exposed by React Router 7.

The exception:

- applies only to `@remix-run/react`, `react-router`, and `react-router-dom`;
- applies only to the three advisory IDs above;
- never applies to high or critical vulnerabilities;
- expires after 2026-09-30;
- fails CI if any additional advisory or affected package appears.

The permanent resolution is a planned Remix 2 to React Router 7 framework
migration. Until then, application redirects must continue to use fixed or
server-validated destinations rather than untrusted navigation targets.

## Shopify build-tool advisory: GHSA-mh99-v99m-4gvg

`brace-expansion@2.1.2` is currently reachable only through Shopify extension
build dependencies. It is not a direct application dependency and must not be
present in the deployable Remix server, Checkout Function, or Customer Account
UI artifacts.

The temporary acceptance is deliberately fail-closed:

- production runtime dependencies may never use this exception;
- only `GHSA-mh99-v99m-4gvg` for `brace-expansion@2.1.2` is eligible;
- the affected parent is fixed to one physical `minimatch@9.0.9`
  installation;
- the complete reviewed lockfile path set is stored as normalized,
  human-readable evidence with a count and SHA-256 fingerprint;
- any new, runtime, unresolved, or extraneous path fails CI;
- removed paths are accepted with a warning because they reduce exposure;
- application and extension source files may not import the affected
  toolchain packages directly;
- all required Remix server/client artifacts and extension build outputs must
  exist and contain no reference to the affected build-tool packages;
- when a Shopify deployment package is supplied for verification, its complete
  deploy bundle, manifest, required modules, and referenced assets are also
  mandatory and fail closed when incomplete;
- two real upstream tracking URLs are required before acceptance can become
  active;
- the acceptance cannot extend beyond 2026-08-27;
- any other high or critical advisory fails CI.

The machine-readable record is
`security/risk-decisions/GHSA-mh99-v99m-4gvg.json`. It intentionally remains
`proposed` until the reports in
`docs/shopify-toolchain-security-report.md` have been submitted and their real
URLs have been recorded.

### Update procedure

1. Regenerate `package-lock.json` with the repository's pinned Node and npm
   versions.
2. Run `npm ci`, the root build, and the production Shopify app build.
3. Run `npm run audit:production`.
4. If the dependency path fingerprint changes, inspect every path. Do not
   update the fingerprint merely to make CI pass.
5. Reject the change if any affected path is production runtime reachable, is
   extraneous, cannot be resolved, or appears in a deployable artifact.
6. Once the upstream dependencies no longer install the affected version,
   delete the risk-decision record and remove this exception instead of
   extending it.

`postcss` is pinned to `8.5.24` through both `overrides` and `resolutions`.
This removes its independent advisory and is not part of the Shopify toolchain
acceptance.
