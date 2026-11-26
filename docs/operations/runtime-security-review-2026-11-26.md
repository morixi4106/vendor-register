# Runtime Security Review: 2026-11-26

This review separates candidate code, this Windows PC, provider metadata and
deployed processes. It does not authorize publication, production deployment,
database upgrades, financial transactions or monitoring-mail resumption.

## Verified Sources And Applicability

| Component | Finding and scoped disposition |
| --- | --- |
| PHP | The November19 security releases are real:8.5.13/8.4.28/8.3.37/8.2.36. No PHP source/Composer manifest was found in tracked application files, nor a PHP command, standard installation or PHP/Apache/nginx service in the selected PC inventory. No PHP was installed merely to patch an unused runtime. This is not proof about every executable on the PC or vendor-managed internals. |
| Node.js | November security release24.22.3 replaces candidate24.22.1. Exact Windows/Linux executables are bound to the existing official signing fingerprint and verified signed SHA sums. Candidate Node/engines and immutable Docker bases are updated. PC MSI signature/hash and installed executable are verified separately. |
| JavaScript/TypeScript dependencies | Fresh npm audit found four high-labelled package paths caused by Effect ReDoS GHSA-7589-6fvf-x4pw. Pin Effect3.22.1 without downgrading Prisma6.19.3 or Shopify session storage11.0.0. Exercise the real corrected template matcher with a bounded isolated child. |
| Go | Official current patch line remains1.27.4. Rebuild both esbuild targets with the pinned compiler and fresh vulnerability scan; do not refresh old receipt timestamps. |
| Rust compiler | Official1.100.0 is newer than pinned1.99.1. No new compiler security fix requiring that feature-version migration was identified in the reviewed announcements. Rust crate findings are separate and remain actionable below. |
| .NET on PC | Core/Desktop8.0.33 and9.0.22 updated to8.0.34/9.0.23; x86 ASP.NET/Core/Desktop8 also updated. Official hashes/Authenticode verified. Seven framework configurations resolve through actual signed hostfxr. This does not execute third-party apps or patch self-contained app runtimes. CBOR/template advisories require package/generated-code remedies, not runtime installation alone; no .NET application project is tracked here. |
| Python on PC | Managed3.14.3 updated to3.14.10 through Python's signed official index. Existing site-packages preserved; version/SSL/JSON/hash smoke checks run against the installed interpreter. The install manager also performed its own vendor-managed update. No Python application manifest is tracked here. |
| Java/Ruby | No corresponding project manifest, command or standard installation was found in this scoped application/PC inventory. Do not install unrelated runtimes. Embedded/unknown app copies are not independently cleared. |
| PostgreSQL | Official security fixes are17.12/18.7. Upgrade only isolated CI image pins and expected real server versions here, not any real DB. This PC's PostgreSQL17 executable reports17.9. Render metadata reports major18 only; minor/server patch status remains unverified. Real upgrade/backup/reindex steps require a separate approved operation. |
| OpenSSL/C/C++ | Node/Python expose OpenSSL3.5.9; the Prisma source lock selects vendored3.6.3, now an unsupported line. November10/17/24 Low advisories have public source fixes but packaged3.5.10/4.0.4/4.1.1 are scheduled for December1. Do not claim those unavailable releases installed. QUIC, Suite B, DANE, CMS/CRL and AES-GCM-SIV conditions must be assessed separately; absence from owned JavaScript is not whole-native/provider clearance. |

Primary sources: [PHP releases](https://www.php.net/archive/2026.php),
[Node security release](https://nodejs.org/en/blog/release/v24.22.3),
[Node signing keys](https://github.com/nodejs/release-keys),
[Effect maintainer advisory](https://github.com/Effect-TS/effect/security/advisories/GHSA-7589-6fvf-x4pw),
[Go history](https://go.dev/doc/devel/release),
[Rust releases](https://blog.rust-lang.org/),
[Microsoft November servicing](https://devblogs.microsoft.com/dotnet/dotnet-and-dotnet-framework-november-2026-servicing-updates/),
[Python release](https://www.python.org/downloads/release/python-31410/),
[PostgreSQL security](https://www.postgresql.org/support/security/),
[OpenSSL advisory timeline](https://openssl-library.org/news/timeline/).

## Native Dependency Findings

The fresh complete candidate lock scans do not support a clean-all-languages
claim. Before subsequent native repairs, they found:

- Prisma: libz-sys1.1.31 heap overflow (fixed1.1.33), url2.5.8 origin recursion
  (fixed2.5.9), plus chrono0.4.45's unmaintained advisory with no patched version.
- Runner: url2.5.8, Wasmtime36.0.20 and WASI security advisories; the Windows WASI
  filesystem fix requires at least36.0.22 in this supported line.
- Javy: url2.5.8, Wasmtime48.0.8/50.0.1 and WASI security advisories. Windows
  fixes require at least48.0.10/50.0.3. chrono and humantime also have
  unmaintained notices, distinct from demonstrated vulnerabilities.

References: [libz-sys](https://rustsec.org/advisories/RUSTSEC-2026-0544.html),
[url](https://rustsec.org/advisories/RUSTSEC-2026-0592.html),
[Wasmtime](https://rustsec.org/advisories/RUSTSEC-2026-0566.html),
[WASI Windows](https://rustsec.org/advisories/RUSTSEC-2026-0587.html),
[chrono](https://rustsec.org/advisories/RUSTSEC-2026-0543.html).

No old native binary becomes patched because its recipe or a version string is
edited. New locked inputs need real compilation, regression tests and artifact
binding before adoption. Existing original13 source/native/provider/compiler
approvals, package admission and incident closure remain false. Unmaintained
notices must stay visible; do not suppress findings or extend expired waivers.

Private current evidence is under `.audit/november-2026/`: signed metadata,
Node signature/archive/executable checks, npm/Rust full reports, PC installer
receipts, both hostfxr probe reports and checks. These local files are
nonportable; fixed Git/CI/PR records are needed for handoff. No credentials,
customer exports or confirmation codes belong in the portable record.
