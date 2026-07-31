# Marketplace operator access

Sensitive marketplace administration routes require a Shopify Admin session
and an explicitly authorized operator identity.

With Shopify's embedded authentication strategy, the signed session token
identifies the current Shopify user through its `sub` claim. Configure the
allowed IDs as comma-separated values:

```text
MARKETPLACE_ADMIN_USER_IDS=98531410083
```

`MARKETPLACE_ADMIN_USER_IDS` grants all marketplace operator roles. For
separation of duties, use role-specific variables instead:

```text
FINANCE_PREPARER_USER_IDS=
FINANCE_APPROVER_USER_IDS=
FINANCE_EXECUTOR_USER_IDS=
RELEASE_MANAGER_USER_IDS=
INCIDENT_COMMANDER_USER_IDS=
RECOVERY_APPROVER_USER_IDS=
COMPLIANCE_REVIEWER_USER_IDS=
```

Existing `MARKETPLACE_ADMIN_EMAILS`, role-specific `*_EMAILS`, and Shopify
account-owner checks remain supported when Shopify provides those identity
fields. A user is denied when no trusted identity matches or when the signed
token user conflicts with persisted session identity.

Treat Shopify user IDs as access-control configuration. Do not infer or accept
them from request query parameters, form data, or browser storage.
