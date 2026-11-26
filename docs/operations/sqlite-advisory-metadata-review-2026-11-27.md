# SQLite Advisory Metadata Review

The fresh November27 Japan-time check of the official OSV payload for
RUSTSEC-2026-0459 differs from the saved November9 payload only in `aliases`
and `modified`. The entire details, affected ranges, references, severity and
other fields are unchanged. The added BIT identifier and RUSTSEC-2026-0502
identify the same SQLite CVE; SQLCipher remains rejected by source wiring.

## Reviewed Binding

- Original canonical SHA256:
  `775268f2214d68fbda497ec20183114be74804b2a0f58475705743ec0c47fc58`.
- Current canonical SHA256:
  `41bfcad9cd214fb86fe181d38491b6905e0524c440b497230b19e1c7c7676958`.
- Current full modified value: `2026-11-17T13:41:05.770775012Z`;
  query-batch value: `2026-11-17T13:41:05.770775Z`.

Keep the original saved advisory, Prisma source policy, native artifact pins,
SQLite C patch, all27 source bindings and compiled-regression requirements
unchanged. A separate strict metadata review binds both complete canonical
payloads and requires exactly those two changed fields. Fresh batch findings
must match the current ID/date; stale, removed, extra, mismatched or otherwise
changed payloads are rejected. Object key order alone is immaterial. The audit
still returns the actual vulnerability finding and `sourceAuditOk=false`;
metadata review is not a registry exemption or native/production approval.

This closes a metadata-only preparation failure, not the remaining Prisma
libz-sys/url fixes, chrono replacement, original Git-source review or runtime
package admission. Previous native bytes are not relabeled as new fixes.

## Verification

Focused SQLite/Prisma tests53 pass, full1715 pass/0 fail/9 existing Windows
skips, lint/encoding/architecture/build and audit187/0/3 pass. A fresh call to
the official batch/full APIs passes the new strict review while retaining the
actual finding and false approval flags. Active source-policy SHA256 remains
`77fafe98de32a1213dfaf4374ffe45e23142e07f49dbeca153a306f73a0a9d1d`.

The active contract lock still contains libz-sys1.1.31/url2.5.8 findings. A
private, non-adopted contract candidate updates them to1.1.33/2.5.9; its368
registry packages scan clean and actual locked metadata passes existing edge/
feature checks. Engine candidate and active contract/source-policy/native
inputs remain unchanged. This candidate has not been compiled or admitted;
the active full source workflow must still reject its unresolved contract
findings rather than treating this metadata repair as full source success.

References: [official SQLite advisory](https://rustsec.org/advisories/RUSTSEC-2026-0459.html),
[full OSV record](https://api.osv.dev/v1/vulns/RUSTSEC-2026-0459),
[SQLCipher alias](https://rustsec.org/advisories/RUSTSEC-2026-0502.html).
