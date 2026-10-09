# Automated Maintenance And Sales Release

Status: implementation proposal, not production authorization. Existing risk
records, sales holds, Shopify versions, environment variables and the password
are not changed by this implementation. Human response is expected within seven
calendar days after acknowledgement; urgent containment does not wait for it.

## Scope

Routine dependency detection uses Dependabot. Daily verification reuses Quality
checks. Only patch updates of `prettier`, `@types/eslint`, `@types/node`,
`@types/react` and `@types/react-dom` can be merged automatically. Files other than
package metadata, added dependency paths, aliases, lifecycle scripts, minor/major
updates, changed runtime dependencies and non-registry downloads are rejected.

The promotion process runs protected main, not PR code. It requires actual
successful CI steps, fresh healthy monitoring, confirmed primary and secondary
notification receipt, no active transaction probe and no pending migrations.
It freezes the PR head SHA and uses a squash title containing `[skip render]`.
These development-only updates deliberately keep the live sales release and its
transaction evidence unchanged. A later promotion verifies that intervening
main changes were also allowlisted development patches.

Application fixes, runtime dependencies, authentication, encryption, payments,
Shopify extensions, database migrations and sales-policy changes are not
automatically deployed by this workflow. They remain separate reviewed releases.
Initial international markets must satisfy their existing country/product gates;
maintenance authorization never enables new countries or third-party commerce.

## Notifications

The primary route is the existing Resend monitor mail. `/app/launch-monitor`
permits a primary-shop operator to send a bounded receipt test, inspect provider
delivery and enter the emailed code. API acceptance alone is not receipt proof.
The code is stored only as a routing-bound HMAC, expires after seven days, allows
five failed attempts and cannot be replayed. Sender/recipient changes invalidate
the proof. Provider failures invalidate delivery; renewed receipt testing is
needed after correcting the route. Message bodies and contacts are not copied
into heartbeat records. Routine messages are provider-checked to keep the
delivery proof fresh without asking for a new human code every week.

The secondary route is a GitHub Issue, independent of Resend. The trusted
fallback workflow reads no customer logs. Render's native runner can also create
the Issue if GitHub schedules stop. A scoped fine-grained token needs only
Issues read/write for this repository. The initial notification test Issue is
acknowledged by an authorized account with `/ack-maintenance`; its number is
required by the promotion gate. Verify that the account actually receives the
GitHub notification; creation of an Issue is not proof of inbox delivery.

The monitor's acknowledgement button records awareness, not resolution or sales
restoration. A new occurrence gets a new response window even if its check IDs
repeat. Repeated acknowledgement cannot extend an existing window. Acknowledged
incidents have daily reminders; new incidents, escalation and recovery notify
immediately. Healthy operation can send a weekly summary. None of these actions
clears a BLOCKED control or repairs financial records.

## Scheduler And Backup

Reuse the suspended `launch-monitor-deadman-72h` Render Cron after authorization:

```text
Build: node --check scripts/maintenance-runner.mjs
Start: node scripts/maintenance-runner.mjs
Schedule: */10 * * * *
```

The agents use native Node APIs; this Cron does not need the app's build-tool
dependencies. The fixed runner serially performs catalog sync, order integrity,
full monitoring and deadman checks, with a three-minute per-process limit. A
failed task does not prevent subsequent checks or the independent fallback.
An existing shared server lock rejects concurrent catalog runs. Verify Render
execution duration and heartbeat freshness before removing the GitHub catalog
schedule; the two writers must not be enabled as independent primary schedulers.

Set `MAINTENANCE_SCHEDULER=render` in both Render and GitHub. GitHub's scheduled
catalog run then stops, while manual controlled runs remain possible. Keep the
external GitHub monitor and independent watchdog under their existing controls.
Use a separate `LAUNCH_MONITOR_RENDER_TOKEN` on the web service. The Cron's
`LAUNCH_MONITOR_TOKEN` must contain that Render-only token, not the external
GitHub token. The endpoint derives the execution role from the credential;
Render checks cannot refresh the external-monitor timestamp.

Backup inspection uses GET `/postgres/{id}/recovery` only. It requires AVAILABLE
status and at least 24 hours of recovery history. It neither downloads customer
data nor triggers exports/restores. This is availability evidence, not a restore
drill. Verify the native recovery window and conduct an authorized isolated
restore drill before claiming tested recovery. Do not restore over the live DB.

## Initial Activation Boundary

1. Keep the store private and preserve the live release. Complete the PR checks.
2. Review and explicitly approve the new condition-bound risk proposal. The old
   dated `braces` proposal and archived `brace-expansion` decision stay unchanged.
   Approval requires the real owner comment, reviewed PR/commit/CI and immutable
   evidence. Embed the actual reviewed audit evidence and its canonical SHA-256
   in the acceptance-only JSON commit; initial acceptance still verifies the live
   CI artifact. Later CI verifies the owner-bound embedded evidence instead of
   depending on an artifact that expires after 45 days. Do not manufacture proof.
3. After separate production approval, coordinate the privacy encryption key,
   guarded build command, additive migration, all dependent workers and Shopify
   scope/version alignment described in `../shopify-centered-privacy.md`.
   Keep `PRIVACY_LEGACY_ENCRYPTION_ENABLED` absent/false until bulk encryption is
   explicitly approved. New private writes still use encryption after key setup.
4. Set and verify the scheduler and notification configuration. No secret may
   appear in chat, Git, command output or Issue bodies. Never replace an existing
   encryption/hash key. The alerts token is not a deployment or Shopify token.
5. Send the primary test, inspect delivery and confirm the emailed code. Run
   `node scripts/maintenance-runner.mjs --notification-test` in the authorized
   Cron environment, confirm GitHub receipt and acknowledge its test Issue.
6. Complete the initial sales evidence under existing publication rules. The
   90-day domestic initial authorization is not silently extended or converted
   into permanent approval of unverified legal/MFA/payment checks. A changed
   runtime release still needs its own evidence. An old PASSED probe is not
   relabelled as a successful payment on a new release.
7. Only then enable routine maintenance promotion. Do not bypass branch
   protection, skip mandatory checks or remove unresolved warning/critical gates.

Future Render/web configuration, all OFF or absent until authorization:

```text
BUILD_TOOLCHAIN_RISK_POLICY=condition-bound-build-only-v1
AUTONOMOUS_MAINTENANCE_AUTHORIZATION=OWNER_APPROVED_ROUTINE_DEV_PATCHES_V1
AUTONOMOUS_MAINTENANCE_NOTIFICATIONS_ENABLED=true
LAUNCH_MONITOR_DELIVERY_PROOF_REQUIRED=true
MAINTENANCE_BACKUP_CHECK_ENABLED=true
RENDER_POSTGRES_ID=<existing Postgres ID>
LAUNCH_MONITOR_RENDER_TOKEN=<separate monitor token>
MAINTENANCE_GATE_TOKEN=<dedicated read-only gate token>
```

Future Cron configuration additionally requires the existing agent URL/tokens,
Render read credentials and alert mail configuration, plus:

```text
MAINTENANCE_RUNNER_ENABLED=true
MAINTENANCE_SCHEDULER=render
MAINTENANCE_ALERTS_ENABLED=true
GITHUB_REPOSITORY=morixi4106/vendor-register
MAINTENANCE_GITHUB_ALERT_TOKEN=<repository Issues-only token>
```

Future repository variables:

```text
MAINTENANCE_SCHEDULER=render
MAINTENANCE_ALERTS_ENABLED=true
MAINTENANCE_SECURITY_CHECKS_ENABLED=true
AUTO_MAINTENANCE_MERGE_ENABLED=true
MAINTENANCE_SECONDARY_RECEIPT_ISSUE=<acknowledged test Issue number>
MAINTENANCE_BACKUP_CHECK_ENABLED=true
RENDER_POSTGRES_ID=<existing Postgres ID>
```

Store `MAINTENANCE_GATE_TOKEN` in the main-only GitHub `maintenance` Environment.
Normal unattended jobs must not wait for an environment reviewer. Initial setup
and high-impact release approval remain separate from the runtime job.

## Cost And Failure

No new service, paid API, plan upgrade, export or restore is created by this PR.
Reactivating the existing Cron can resume Render's minimum $1/month charge plus
active runtime usage. Obtain approval before reactivation. Do not add a second
Cron or backup-storage provider merely to implement this proposal.

If routine promotion fails, leave the sales release unchanged. If genuine sales
integrity fails, use the existing approved containment path. Never auto-refund,
auto-repair the ledger, clear BLOCKED or republish stopped products. Stop new
updates on a new advisory, changed build controls, unverified delivery, stale
checks or incompatible schema. Recovery uses the same encryption key and
compatible readers; blindly reverting the privacy release is unsafe.

References: [GitHub scheduling limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[Render deployment skip markers](https://render.com/docs/deploys#skipping-an-auto-deploy),
[Render Cron billing](https://render.com/docs/cronjobs),
[Render recovery inspection](https://api-docs.render.com/reference/retrieve-postgres-recovery-info).
