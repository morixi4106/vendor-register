import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launchWorkflowUrl = new URL(
  "../../.github/workflows/launch-monitor.yml",
  import.meta.url,
);
const watchdogWorkflowUrl = new URL(
  "../../.github/workflows/sale-eligibility-watchdog.yml",
  import.meta.url,
);
const launchAgentUrl = new URL(
  "../../scripts/launch-monitor-agent.mjs",
  import.meta.url,
);

test("production monitor is disabled by default and manual runs default to dry-run", async () => {
  const workflow = await readFile(launchWorkflowUrl, "utf8");

  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:/);
  assert.match(workflow, /dry_run:[\s\S]*?default:\s+true/);
  assert.match(workflow, /expect_password_critical:[\s\S]*?default:\s+false/);
  assert.match(
    workflow,
    /vars\.PRODUCTION_INTEGRITY_MONITOR_ENABLED == 'true'/,
  );
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /launch-monitor-agent\.mjs --dry-run/);
  assert.match(
    workflow,
    /PRODUCTION_INTEGRITY_MONITOR_ENABLED:\s*\$\{\{\s*vars\.PRODUCTION_INTEGRITY_MONITOR_ENABLED\s*\}\}/,
  );
  assert.match(
    workflow,
    /launch-monitor-agent\.mjs --expect-password-critical/,
  );
  assert.doesNotMatch(workflow, /permissions:[\s\S]*?\bwrite\b/);
});

test("watchdog uses a main-only dedicated environment and a repository variable gate", async () => {
  const workflow = await readFile(watchdogWorkflowUrl, "utf8");

  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /vars\.SALE_ELIGIBILITY_WATCHDOG_ENABLED == 'true'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /validation_only:[\s\S]*?default:\s+true/);
  assert.match(
    workflow,
    /sale-eligibility-watchdog-agent\.mjs --validate-only/,
  );
  assert.match(workflow, /environment:\s+watchdog/);
  assert.match(workflow, /secrets\.SHOPIFY_WATCHDOG_CLIENT_ID/);
  assert.match(workflow, /secrets\.SHOPIFY_WATCHDOG_CLIENT_SECRET/);
  assert.match(
    workflow,
    /SALE_ELIGIBILITY_WATCHDOG_ENABLED:\s*\$\{\{\s*vars\.SALE_ELIGIBILITY_WATCHDOG_ENABLED\s*\}\}/,
  );
  assert.doesNotMatch(workflow, /permissions:[\s\S]*?\bwrite\b/);
});

test("launch monitor dry-run neither requires the internal token nor sends fallback alerts", async () => {
  const source = await readFile(launchAgentUrl, "utf8");

  assert.match(
    source,
    /const DRY_RUN = process\.argv\.includes\("--dry-run"\)/,
  );
  assert.match(
    source,
    /if \(!dryRun\) required\.push\("LAUNCH_MONITOR_TOKEN"\)/,
  );
  assert.match(source, /if \(!DRY_RUN\) \{\s*await sendFallbackAlert\(error\)/);
  assert.match(source, /if \(dryRun\) \{/);
});

test("prelaunch full monitor delegates the bounded password-page policy", async () => {
  const source = await readFile(launchAgentUrl, "utf8");

  assert.match(source, /--expect-password-critical/);
  assert.match(source, /launch-monitor-response-policy\.mjs/);
  assert.match(source, /isExpectedPasswordCriticalPayload\(payload\)/);
  assert.match(source, /if \(dryRun && expectPasswordCritical\)/);
});

test("launch monitor logs only sanitized issue fields", async () => {
  const source = await readFile(launchAgentUrl, "utf8");

  assert.match(
    source,
    /\.map\(\(\{ id, status, code, count \}\) => \(\{ id, status, code, count \}\)\)/,
  );
  assert.doesNotMatch(source, /issues:[\s\S]*?detail/);
});

test("maintenance writers are opt-in and promotion never checks out PR code", async () => {
  const promotion = await readFile(
    new URL(
      "../../.github/workflows/maintenance-promotion.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(promotion, /vars\.AUTO_MAINTENANCE_MERGE_ENABLED == 'true'/);
  assert.match(promotion, /head_repository\.full_name == github\.repository/);
  assert.match(promotion, /ref: main/);
  assert.match(promotion, /persist-credentials: false/);
  assert.match(promotion, /npm ci --ignore-scripts/);
  const fallback = await readFile(
    new URL("../../.github/workflows/maintenance-alerts.yml", import.meta.url),
    "utf8",
  );
  assert.match(fallback, /vars\.MAINTENANCE_ALERTS_ENABLED == 'true'/);
  assert.doesNotMatch(fallback, /actions\/checkout|download-artifact/);
  const daily = await readFile(
    new URL(
      "../../.github/workflows/maintenance-security.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(daily, /MAINTENANCE_SECURITY_CHECKS_ENABLED == 'true'/);
  assert.match(daily, /uses: \.\/\.github\/workflows\/quality.yml/);
});
