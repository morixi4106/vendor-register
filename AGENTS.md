# Launch Readiness Handoff

For launch, production, monitoring, privacy, payments, or maintenance work:

1. Read `docs/operations/launch-progress.md` before taking action. It is the
   current progress and handoff entry point. Read the linked domain runbooks
   for the task; older handoffs are historical unless reverified.
2. Check `git status`, the branch, and worktree before editing. Preserve
   unrelated user changes. Production state and local HEAD are separate facts.
3. Follow the user's newest request. The progress file is not authorization to
   publish, charge, refund, change access, enable international sales, or send
   notifications. Respect existing approval boundaries.
4. Keep prelaunch automatic monitoring notifications suppressed unless the
   user explicitly approves a different policy. Never enable notifications
   merely because a deployment or storefront publication succeeds.
5. After meaningful progress, update `docs/operations/launch-progress.md` in
   the same work session. Update the timestamp, affected task rows, evidence,
   remaining work, next three actions, and concise change history. Also record
   incomplete work when interrupted or stopping. Avoid no-op timestamp churn.
6. Mark completion only with evidence appropriate to that task. Passing unit
   tests, a successful monitoring process, and a successful deployment do not
   establish real payment, delivery, refund, legal, or sale readiness.
7. Distinguish application code, deployed runtime, Shopify configuration,
   operational evidence, and actual transactions. Include the observation date
   and release binding when relevant. Mark old observations as needing refresh
   rather than presenting them as current production checks.
8. Keep credentials, confirmation codes, personal data, raw database exports,
   and payment details out of progress notes. Use safe references and aggregate
   results. Local `.codex-temp` evidence is not portable; say so when used.
9. Do not push directly to `main` or weaken CI/branch protection. Documentation
   updates alone do not require a production deployment or Shopify release.

For other work, update the handoff only if the outcome affects launch status or
the next actions. This file and the handoff do not replace code inspection.
