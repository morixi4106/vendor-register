import prisma from "../db.server.js";
import {
  INTERNATIONAL_COMPLIANCE_REQUIREMENTS,
  INTERNATIONAL_REQUIREMENT_VERSION,
} from "../utils/internationalMarketCompliance.js";

export const INTERNATIONAL_REQUIREMENT_REVIEW_DAYS = 180;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeEvidenceHash(value) {
  return normalizeText(value).toLowerCase();
}

function asMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export async function syncInternationalComplianceRequirements(
  { actor = "admin", now = new Date() } = {},
  { prismaClient = prisma } = {},
) {
  if (!prismaClient?.complianceRequirement?.upsert) {
    return { ok: false, reason: "compliance_requirement_table_unavailable" };
  }

  const requirements = [];
  for (const requirement of INTERNATIONAL_COMPLIANCE_REQUIREMENTS) {
    const managedData = {
      name: requirement.name,
      market: requirement.market,
      subjectType: "PRODUCT",
      productCategory: requirement.productCategory,
      severity: requirement.severity,
      status: "ACTIVE",
      requiredVerificationLevel: requirement.requiredVerificationLevel,
      evidencePolicyJson: {
        reviewedEvidenceRequired: true,
        currentDecisionRequired: true,
        failClosed: true,
      },
      sourceUrl: requirement.sourceUrl,
      sourceTitle: requirement.sourceTitle,
      isActive: true,
      metadataJson: {
        managedBy: "international-compliance-catalog",
        managedVersion: INTERNATIONAL_REQUIREMENT_VERSION,
        lastSyncedBy: actor,
        lastSyncedAt: now.toISOString(),
      },
    };
    const saved = await prismaClient.complianceRequirement.upsert({
      where: {
        code_version_jurisdiction: {
          code: requirement.code,
          version: requirement.version,
          jurisdiction: requirement.jurisdiction,
        },
      },
      create: {
        code: requirement.code,
        version: requirement.version,
        jurisdiction: requirement.jurisdiction,
        ...managedData,
        reviewDueAt: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
      },
      // A catalog sync must not silently renew the human legal review window.
      update: managedData,
    });
    requirements.push(saved);
  }

  return {
    ok: true,
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    count: requirements.length,
    requirements,
  };
}

export async function listInternationalComplianceRequirements(
  { prismaClient = prisma } = {},
) {
  if (!prismaClient?.complianceRequirement?.findMany) return [];
  return prismaClient.complianceRequirement.findMany({
    where: {
      version: INTERNATIONAL_REQUIREMENT_VERSION,
      isActive: true,
    },
    orderBy: [{ market: "asc" }, { code: "asc" }],
  });
}

export async function reviewInternationalComplianceRequirements(
  {
    actor,
    confirmed = false,
    reviewReference,
    evidenceHash,
    now = new Date(),
  } = {},
  { prismaClient = prisma } = {},
) {
  const normalizedActor = normalizeText(actor);
  const normalizedReference = normalizeText(reviewReference);
  const normalizedHash = normalizeEvidenceHash(evidenceHash);
  if (
    confirmed !== true ||
    !normalizedActor ||
    !normalizedReference ||
    !/^[a-f0-9]{64}$/.test(normalizedHash)
  ) {
    return { ok: false, reason: "international_requirement_review_invalid" };
  }
  if (
    !prismaClient?.complianceRequirement?.findMany ||
    !prismaClient?.complianceRequirement?.update
  ) {
    return { ok: false, reason: "compliance_requirement_table_unavailable" };
  }

  const requirements = await prismaClient.complianceRequirement.findMany({
    where: {
      version: INTERNATIONAL_REQUIREMENT_VERSION,
      isActive: true,
      status: "ACTIVE",
    },
    orderBy: [{ market: "asc" }, { code: "asc" }],
  });
  const expectedCodes = new Set(
    INTERNATIONAL_COMPLIANCE_REQUIREMENTS.map((entry) => entry.code),
  );
  const actualCodes = new Set(requirements.map((entry) => entry.code));
  if (
    requirements.length !== expectedCodes.size ||
    Array.from(expectedCodes).some((code) => !actualCodes.has(code))
  ) {
    return { ok: false, reason: "international_requirement_catalog_incomplete" };
  }

  const reviewedAt = new Date(now);
  const reviewDueAt = new Date(
    reviewedAt.getTime() +
      INTERNATIONAL_REQUIREMENT_REVIEW_DAYS * 24 * 60 * 60 * 1000,
  );
  const operations = requirements.map((requirement) =>
    prismaClient.complianceRequirement.update({
      where: { id: requirement.id },
      data: {
        reviewDueAt,
        metadataJson: {
          ...asMetadata(requirement.metadataJson),
          legalReviewedBy: normalizedActor,
          legalReviewedAt: reviewedAt.toISOString(),
          legalReviewReference: normalizedReference,
          legalReviewEvidenceHash: normalizedHash,
          legalReviewVersion: INTERNATIONAL_REQUIREMENT_VERSION,
        },
      },
    }),
  );
  const updated = prismaClient.$transaction
    ? await prismaClient.$transaction(operations)
    : await Promise.all(operations);

  return {
    ok: true,
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    count: updated.length,
    reviewedAt,
    reviewDueAt,
  };
}
