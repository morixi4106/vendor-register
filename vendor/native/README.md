# Native source rebuilds

These are explicit local rebuild recipes, not upstream releases or advisory
exceptions. The Function Runner source remains pinned to Shopify's reviewed
commit. Its Wasmtime 36 LTS dependencies are updated to 36.0.19 and the complete
resolved Cargo.lock is frozen. The root package is marked `9.2.2+oja.1`.

Two small source overrides preserve the cache and profiler features:

- `wasmtime-internal-cache 36.0.19+oja.1` updates sha2 to 0.11 and zstd to
  0.14.3 (zstd-safe 8.2.0). It does not retain the old vulnerable compression
  wrappers or block-buffer dependency.
- `fxprof-processed-profile 0.6.0+oja.1` replaces unmaintained fxhash with
  rustc-hash 2.1.3. The custom version and source patch are recorded explicitly.

The original crate archives are pinned by crates.io SHA-256 checksums. Their
upstream licenses remain applicable: Wasmtime is Apache-2.0 WITH LLVM-exception;
fxprof-processed-profile is MIT OR Apache-2.0. The recipe downloads source rather
than redistributing renamed upstream binaries. Patch files and the generated
lockfile are hash-bound in `security/function-runner-rebuild.json`.

Upstream references:

- https://github.com/Shopify/function-runner/commit/47dca499b04de5158822cc451cd4daf61dfd0fd0
- https://crates.io/crates/wasmtime-internal-cache/36.0.19
- https://crates.io/crates/fxprof-processed-profile/0.6.0
- https://rustsec.org/advisories/RUSTSEC-2026-0391.html
- https://github.com/advisories/GHSA-qwgh-2vcv-g2f7
- https://rustsec.org/advisories/RUSTSEC-2025-0057.html

A clean lock graph is not native-binary certification. Actual compiler,
source/patch/lock hashes, selected build features, binaries, embedded providers
and ABI/fuel/WASM tests still need evidence. This recipe alone does not add any
native approval or authorize a production deployment.
