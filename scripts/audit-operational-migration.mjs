import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const requireCurrentSchema = process.argv.includes("--require-current-schema");

async function safe(label, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code === "P2021" || error?.code === "P2022") {
      return { unavailable: true, code: error.code };
    }
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function main() {
  const [
    productCount,
    approvedProductCount,
    shopifyLinkedProductCount,
    nonTestPublicationCandidateCount,
    requirementCount,
    evidenceCount,
    decisionCount,
    projectionCount,
    operationalControlCount,
    operationalExecutionCount,
    platformControlCount,
    webhookReceiptCount,
    quarantineHoldCount,
    outboxByStatus,
  ] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { approvalStatus: "approved" } }),
    prisma.product.count({ where: { shopifyProductId: { not: null } } }),
    prisma.product.count({
      where: {
        approvalStatus: "approved",
        shopifyProductId: { not: null },
        vendorStore: { is: { isTestStore: false } },
      },
    }),
    safe("compliance requirements", () => prisma.complianceRequirement.count()),
    safe("compliance evidence", () => prisma.productComplianceEvidence.count()),
    safe("compliance decisions", () =>
      prisma.productComplianceDecision.count(),
    ),
    safe("sale eligibility projections", () =>
      prisma.saleEligibilityProjection.count(),
    ),
    safe("operational controls", () => prisma.operationalControl.count()),
    safe("operational executions", () =>
      prisma.operationalControlExecution.count(),
    ),
    safe("platform operational controls", () =>
      prisma.platformOperationalControl.count(),
    ),
    safe("Shopify webhook receipts", () =>
      prisma.shopifyWebhookReceipt.count(),
    ),
    safe("Shopify quarantine holds", () =>
      prisma.shopifyOrderQuarantineHold.count(),
    ),
    safe("withdrawal outbox status", () =>
      prisma.withdrawalEmailOutbox.groupBy({
        by: ["status"],
        _count: { _all: true },
        orderBy: { status: "asc" },
      }),
    ),
  ]);

  const report = {
    schema: "operational-migration-audit/v1",
    generatedAt: new Date().toISOString(),
    products: {
      total: productCount,
      approved: approvedProductCount,
      shopifyLinked: shopifyLinkedProductCount,
      nonTestPublicationCandidates: nonTestPublicationCandidateCount,
    },
    compliance: {
      requirements: requirementCount,
      evidence: evidenceCount,
      decisions: decisionCount,
      projections: projectionCount,
    },
    controls: {
      platform: platformControlCount,
      operational: operationalControlCount,
      executions: operationalExecutionCount,
      webhookReceipts: webhookReceiptCount,
      quarantineHolds: quarantineHoldCount,
    },
    withdrawalEmailOutbox: Array.isArray(outboxByStatus)
      ? Object.fromEntries(
          outboxByStatus.map((entry) => [
            entry.status,
            entry._count?._all || 0,
          ]),
        )
      : outboxByStatus,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (requireCurrentSchema) {
    const unavailableChecks = [
      ["compliance.requirements", report.compliance.requirements],
      ["compliance.evidence", report.compliance.evidence],
      ["compliance.decisions", report.compliance.decisions],
      ["compliance.projections", report.compliance.projections],
      ["controls.platform", report.controls.platform],
      ["controls.operational", report.controls.operational],
      ["controls.executions", report.controls.executions],
      ["controls.webhookReceipts", report.controls.webhookReceipts],
      ["controls.quarantineHolds", report.controls.quarantineHolds],
    ].filter(([, value]) => value?.unavailable === true);

    if (unavailableChecks.length > 0) {
      throw new Error(
        `operational_schema_incomplete:${unavailableChecks
          .map(([label]) => label)
          .join(",")}`,
      );
    }
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
