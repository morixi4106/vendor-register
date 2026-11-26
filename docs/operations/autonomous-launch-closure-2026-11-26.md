# Autonomous Launch Closure

The owner requested continuous implementation and verification up to genuine
launch readiness, without asking for another "next" after every small step.
This does not authorize publication, financial actions, access changes,
notification resumption or weaker admission gates.

## Latest Owner Scope

The owner answered the country question: keep international sales switchable,
but exclude overseas destinations from the initial launch. Initial scope is
Japan-only platform-direct sales, not the earlier overseas-from-day-one plan.
International code and strict country/proof requirements remain in place for a
future explicitly approved switch. International-only proof work is not a
domestic prerequisite when fresh native/DB observations prove domestic scope.

Standard direct mode now rejects foreign sale eligibility across all seven
channels and foreign carrier quotes. An international shipping hold is also a
hard foreign-sale blocker. Projection hashes bind both controls; neither a
stale overseas product profile nor a conflicting third-party flag can reopen
foreign application sales. Existing validated-mode compliance checks remain.
This is application code, not proof of changed Shopify Markets or deployment.
See [domestic switch boundaries](../platform-direct-standard-checkout.md).

Domestic-change verification:74 focused tests pass; full1721 tests include
1712 passes,0 failures and9 existing Windows skips. Lint, encoding,
architecture, app build and audit tests pass (187/0/3, coverage98.71/92.60/98.61).
Initial full-suite attempts retained failures from a pre-existing200ms deadline
also imposed on healthy maintenance-test children; only that fixture now keeps
the hung child at200ms and allows bounded healthy startup. Production deadlines
are unchanged. One overlapping build/test attempt also hit Effect's unchanged
8-second outer bound; its isolated and final full-suite checks pass. Failure
logs are retained privately, not erased or relabeled.

## Current Repairs

- Javy selects Wasmtime/WASI48.0.10 and50.0.3, and url2.5.9. Both JIT-debug
  APIs retain the same five exact upstream file hashes and shared registration
  lock. Profiler support, default engine features and release LTO remain.
- Replace the release helper's chrono dependency with Jiff1.0.3. A real Rust
  regression covers local calendar dates around New Year and leap day.
- Whamm's consumed env_logger0.10 API delegates through a bounded local bridge
  to maintained env_logger0.11.12. Keep initialization/builder/filter/custom
  formatting and timestamp features. Its legacy feature name `humantime` now
  selects the maintained logger's Jiff implementation, not the old crate.
  Actual metadata and the entire generated lock contain neither chrono nor
  humantime; maintenance findings are removed by replacing dependencies, not by
  suppressing advisories or renaming those dependencies.
- The complete Javy476-registry-package scan has zero findings/unresolved
  sources. All23 source bindings, exact canonical patch replay and actual
  locked metadata validate. This is not yet native compilation proof.
- The private Prisma source resolves libz-sys1.1.33 and url2.5.9. Its602-package
  scan retains only chrono's maintenance notice. This staged source is not a
  new release binary or a replacement for the active immutable Prisma input.

## Required Verification

Run the Javy source contracts on both OSes, real WASI plugin/profiler builds,
both native CLI builds and isolated probes. Independently verify actual bytes,
compiler/lock/source/metadata/SBOM/receipts and named tests before changing
downstream compiler pins. Preserve strict zero-registry-advisory checks and
false whole-compiler/provider/production approval flags.

Then finish Prisma maintenance-dependency replacement, reviewed SQLite advisory
rebinding, fresh runtime-package native/WASM admission and separate live/DB/
checkout/financial/legal/backup evidence. Completed Node/Go/Runner repairs are
not repeated merely to fill a work batch. OpenSSL November source fixes have a
December1 packaged-release schedule; no future patch is claimed installed.

References: [Wasmtime/WASI advisory](https://rustsec.org/advisories/RUSTSEC-2026-0587.html),
[url advisory](https://rustsec.org/advisories/RUSTSEC-2026-0592.html),
[chrono notice](https://rustsec.org/advisories/RUSTSEC-2026-0543.html),
[humantime notice](https://rustsec.org/advisories/RUSTSEC-2026-0542.html),
[Jiff changelog](https://docs.rs/jiff/latest/jiff/_documentation/changelog/index.html),
[maintained logger](https://docs.rs/env_logger/0.11.12/env_logger/).

Private source/lock/metadata and download observations are under
`.audit/autonomous-2026-11-26/`; those local files are nonportable. The active
handoff remains `vendor-register-final/docs/operations/launch-progress.md`.
