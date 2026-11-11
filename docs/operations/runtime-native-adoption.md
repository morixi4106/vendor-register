# Runtime Native Adoption

This is a candidate adoption runbook, not permission to deploy. The production
storefront, transactions, access settings and notification policy stay unchanged.

## Observed Target

The owner-provided November11 Shell screenshot reports Node24.13.1, bundled
OpenSSL3.5.5, N-API10, Linux/x64 and glibc2.36. Candidate Node is pinned24.22.1.
This is selected Shell process output, not independent application-release/hash,
all-worker, OS distribution, system OpenSSL or database evidence. The last
read-only service metadata used native Node, not the repository Dockerfile.

Render resolves Node from `NODE_VERSION`, then `.node-version`, `.nvmrc`, then
`package.json` engines. A service override can therefore supersede the repository
pin. Read only that non-secret selected setting through an authorized route
before a separately approved update; do not export the environment or silently
edit it. [Render Node version policy](https://render.com/docs/node-version).

## Package Verification

The build-tree incident check is necessary but does not attest a separately
installed production tree. Keep that check and original-source admission intact.
The runtime package now checks actual native bytes at these boundaries:

1. After script-disabled installation, before executing the Prisma generator.
   All inventoried native artifacts need platform/hash/source/SBOM admission; the
   expected packaged schema engine must be present. Missing inputs block.
2. After generation. Require both the packaged schema engine and generated
   client library in their actual runtime locations. Retain the pre-generation
   artifacts and policy identity; validate every other native artifact as well.
3. After the registry audit. Recheck the actual native inventory and policy,
   not only package names or version strings. Success evidence binds both.
4. Before activation and after copying. Any changed/missing/extra native bytes
   or changed policy invalidate activation. Restore original modules on failure.

Build tools remain mandatory in the build inventory and forbidden in the runtime
package under the existing toolchain check. Runtime validation does not skip
embedded WASM, unfamiliar native files, duplicate copies or cache artifacts.
Runtime-specific required paths are not a build-tool waiver. The existing
bounded filename/header inventory is not a general malware detector.

`npm audit` queries known package dependency advisories; it is not independent
attestation of embedded/downloaded engine bytes. Keep both controls.
[npm audit documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/).

## Adoption Prerequisites

- Independently verified source/native builds are candidate evidence only.
  Original13 Git identities, wider source/provider/compiler/native package
  admission and production approval remain open. Do not add current candidate
  bytes to the approval list merely to make these checks pass.
- Supply reviewed binaries/SBOMs from the immutable native build input before
  generation. Review every bundled WASM/native dependency used by the generator.
  Prevent fallback to downloaded original engines. This installation integration
  and startup/setup-path verification are not completed by the new package gate.
- Rehearse the complete generated package with the actual application and
  approved inputs on the target runtime; recheck migration/rollback behavior
  separately. Existing isolated client/DB/native tests are not that rehearsal.
- Preserve the existing production build/risk/source/incident gates. Do not
  renew an expired exception, substitute synthetic fixture approvals, or report
  a failed/skipped gate as a release pass.

The November11 Windows rehearsal installed172 production packages in a fresh
temporary project with lifecycle scripts disabled. It inventoried12 unapproved
Prisma WASMs and no packaged schema executable, then rejected before generator
execution. Temporary staging was removed, the original installed native
inventory was unchanged, and no runtime-success receipt or activation occurred.
This is an expected-rejection test, not a successful patched runtime package.
Private evidence: `.audit/runtime-native-real-install.json` and install log;
nonportable. The test fixture approvals do not enter the real policy.

## Production Change Boundary

Before any approved deployment, bind the candidate commit, Node and native
hashes, service build/start commands, four-service update scope, backup/restore
evidence and rollback point. A code rollback alone does not restore database
state or environment settings. Record those separately.

Render may deploy automatically when its tracked branch changes. Do not merge
to main or change settings as part of this rehearsal. Recheck automatic deploy
behavior before a separately authorized release.
[Render deployment behavior](https://render.com/docs/deploys).

No SSH/SQL authentication retry, new key, allowlist/TLS/env change, deployment,
Shopify release, Markets activation, real payment or notification resumption is
authorized by this document. The owner Shell operation is already fulfilled.
