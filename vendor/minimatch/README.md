# Minimatch v9 Security Backport

This is a local ISC-licensed backport of GHSA-g3hv-75wg-m249 to the exact
official minimatch 9.0.9 distribution, not a new upstream release. Its scoped
name and prerelease version distinguish it from the original bytes. Keep the
upstream LICENSE and attribution.

Only the ESM/CommonJS index implementations change semantically. Two upstream
AST trailing spaces are removed without changing AST behavior. The fix stops
amplification of generated glob alternatives and avoids quadratic deduplication
on large sets. This backport rejects amplification beyond1000 generated
alternatives with an explicit RangeError. Leaving such a v9 pattern partly
optimized changes matches, unlike the v11 matcher. Ordinary v9 APIs, including
makeRe and AST, and dependency versions are preserved; over-budget patterns are
intentionally rejected, not claimed transparently compatible. Source maps are
omitted instead of misrepresenting old source
locations. This is a patch of distributed JS, not a claimed source rebuild.

The committed policy binds every package file, provenance and archive. Build
checks inspect installed consumers and separately query advisories against the
original npm/minimatch9.0.9 identity. Any additional advisory or unavailable
upstream check blocks the incident gate; a renamed package alone is not proof.
Tests cover both module systems, common consumer APIs, normal glob semantics
and bounded hostile patterns in isolated, memory-limited child processes.
There is no new risk acceptance, severity filter or advisory exclusion.
