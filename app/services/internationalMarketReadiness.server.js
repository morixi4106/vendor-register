import prisma from "../db.server.js";
import { normalizeCountryCode } from "../utils/deliveryEligibility.js";
import {
  evaluateInternationalMarketReadiness,
  getInternationalMarketRequirement,
  getInternationalMarketRequirements,
  INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
  INTERNATIONAL_MARKET_REQUIREMENT_VERSION,
} from "../utils/internationalMarketReadiness.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeHttpsUrl(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days) * 24 * 60 * 60 * 1000);
}

export async function listInternationalMarketEvidence({
  countryCode,
  prismaClient = prisma,
} = {}) {
  const country = normalizeCountryCode(countryCode);
  if (!country) return [];
  const codes = getInternationalMarketRequirements(country).map(
    (definition) => definition.code,
  );
  if (codes.length === 0) return [];

  return prismaClient.operationalReadinessAttestation.findMany({
    where: {
      scopeType: INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
      scopeId: country,
      checkKey: { in: codes },
    },
    orderBy: [{ checkKey: "asc" }],
  });
}

export async function getInternationalMarketReadiness({
  countryCode,
  provinceCode = null,
  postalCode = null,
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const attestations = await listInternationalMarketEvidence({
    countryCode,
    prismaClient,
  });
  return evaluateInternationalMarketReadiness({
    countryCode,
    provinceCode,
    postalCode,
    attestations,
    now,
  });
}

export async function saveInternationalMarketEvidence({
  countryCode,
  requirementCode,
  evidenceReference,
  evidenceHash,
  officialSourceUrl,
  confirmedBy,
  confirmations = {},
  notes = null,
  metadata = {},
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const country = normalizeCountryCode(countryCode);
  const definition = getInternationalMarketRequirement(requirementCode);
  const requiredCodes = new Set(
    getInternationalMarketRequirements(country).map((entry) => entry.code),
  );
  if (!country || !definition || !requiredCodes.has(definition.code)) {
    throw new Error("この国に適用される確認項目ではありません。");
  }

  const reference = normalizeText(evidenceReference);
  const hash = normalizeText(evidenceHash)?.toLowerCase() || null;
  const sourceUrl = normalizeHttpsUrl(officialSourceUrl);
  const actor = normalizeText(confirmedBy);
  if (!reference) throw new Error("証拠の保存先またはチケット番号が必要です。");
  if (!SHA256_PATTERN.test(hash || "")) {
    throw new Error("証拠ファイルのSHA-256を64桁で入力してください。");
  }
  if (!sourceUrl) throw new Error("公式のHTTPS URLが必要です。");
  if (!actor) throw new Error("確認者を特定できません。");

  const normalizedConfirmations = Object.fromEntries(
    definition.confirmations.map((key) => [key, confirmations[key] === true]),
  );
  const missing = definition.confirmations.filter(
    (key) => normalizedConfirmations[key] !== true,
  );
  if (missing.length > 0) {
    throw new Error(`未確認の項目があります: ${missing.join(", ")}`);
  }

  const expiresAt = addDays(now, definition.validityDays);
  const data = {
    status: "CONFIRMED",
    evidenceReference: reference,
    evidenceHash: hash,
    confirmedBy: actor,
    confirmedAt: now,
    expiresAt,
    notes: normalizeText(notes),
    metadataJson: {
      ...metadata,
      countryCode: country,
      requirementVersion: INTERNATIONAL_MARKET_REQUIREMENT_VERSION,
      requirementLabel: definition.label,
      officialSourceUrl: sourceUrl,
      confirmations: normalizedConfirmations,
    },
  };

  return prismaClient.operationalReadinessAttestation.upsert({
    where: {
      checkKey_scopeType_scopeId: {
        checkKey: definition.code,
        scopeType: INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
        scopeId: country,
      },
    },
    create: {
      checkKey: definition.code,
      scopeType: INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
      scopeId: country,
      ...data,
    },
    update: data,
  });
}

export async function revokeInternationalMarketEvidence({
  countryCode,
  requirementCode,
  confirmedBy,
  notes,
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const country = normalizeCountryCode(countryCode);
  const definition = getInternationalMarketRequirement(requirementCode);
  if (!country || !definition) {
    throw new Error("国または確認項目が不正です。");
  }
  return prismaClient.operationalReadinessAttestation.upsert({
    where: {
      checkKey_scopeType_scopeId: {
        checkKey: definition.code,
        scopeType: INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
        scopeId: country,
      },
    },
    create: {
      checkKey: definition.code,
      scopeType: INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
      scopeId: country,
      status: "REVOKED",
      confirmedBy: normalizeText(confirmedBy),
      confirmedAt: now,
      notes: normalizeText(notes),
      metadataJson: {
        countryCode: country,
        requirementVersion: INTERNATIONAL_MARKET_REQUIREMENT_VERSION,
      },
    },
    update: {
      status: "REVOKED",
      confirmedBy: normalizeText(confirmedBy),
      confirmedAt: now,
      expiresAt: now,
      notes: normalizeText(notes),
    },
  });
}
