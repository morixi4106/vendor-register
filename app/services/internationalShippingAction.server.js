import { redirect } from "react-router";
import prisma from "../db.server.js";
import { requireMarketplaceOperator } from "../utils/marketplaceOperator.server.js";
import { resolveInternationalShippingOperatorRole } from "../utils/marketplaceOperatorRoles.js";
import { readBoundedFormData } from "../utils/requestBody.server.js";
import { requirePostRequest } from "../utils/internalRouteSecurity.server.js";
import { requireInternationalAdminMutation } from "./internationalRunnerAuthentication.server.js";
import { dispatchInternationalRunnerAdmin } from "./internationalRunnerAdmin.server.js";
import {
  saveInternationalMarketEvidence,
  revokeInternationalMarketEvidence,
} from "./internationalMarketReadiness.server.js";
import { stopInternationalGateSync } from "./internationalGateQueue.server.js";
import { syncInternationalSaleGate } from "./internationalSaleGate.server.js";
import { saveInternationalShippingCountryAvailability } from "./internationalShippingAvailability.server.js";
import { getInternationalMarketRequirements } from "../utils/internationalMarketReadiness.js";

export const internationalShippingAction = async ({ request }) => {
  requirePostRequest(request);
  requireInternationalAdminMutation(request);
  const formData = await readBoundedFormData(request);
  if (new Set(formData.keys()).size !== Array.from(formData.keys()).length)
    return Response.json(
      { ok: false, code: "international_duplicate_field" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  const runnerResult = await dispatchInternationalRunnerAdmin({
    request,
    formData,
    requireOperator: requireMarketplaceOperator,
    prismaClient: prisma,
  });
  if (runnerResult) return runnerResult;
  const intent = String(formData.get("intent") || "");
  const role = resolveInternationalShippingOperatorRole(intent);
  if (!role) {
    return Response.json(
      { ok: false, error: "対応していない操作です。" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const { session, operator } = await requireMarketplaceOperator(request, {
    role,
  });
  const confirmedBy = operator.actorKey;

  try {
    if (
      intent === "syncInternationalSaleGate" ||
      intent === "stopInternationalSaleGate"
    ) {
      const command =
        intent === "stopInternationalSaleGate"
          ? stopInternationalGateSync
          : syncInternationalSaleGate;
      const result = await command({
        shopDomain: session?.shop,
      });
      return Response.json(
        {
          ok: result.ok === true,
          ...(result.ok
            ? {
                message: result.protected
                  ? "同期要求を受け付け、Shopifyの海外停止を確認しました。許可の反映は未完了です。"
                  : "同期要求を受け付けました。Shopifyの海外停止は未確認です。",
              }
            : {
                error:
                  "同期は未承認です。リリース・対象商品と国・実設定の確認が必要です。",
              }),
        },
        {
          status: result.ok ? 200 : 409,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    } else if (intent === "revokeMarketEvidence") {
      if (!formData.has("expectedVersion"))
        throw new Error("evidence_version_required");
      await revokeInternationalMarketEvidence({
        countryCode: formData.get("countryCode"),
        requirementCode: formData.get("requirementCode"),
        confirmedBy,
        expectedVersion: formData.get("expectedVersion"),
        notes: formData.get("note"),
      });
    } else if (intent === "saveMarketEvidence") {
      if (!formData.has("expectedVersion"))
        throw new Error("evidence_version_required");
      const requirement = getInternationalMarketRequirements(
        formData.get("countryCode"),
      ).find((entry) => entry.code === formData.get("requirementCode"));
      await saveInternationalMarketEvidence({
        countryCode: formData.get("countryCode"),
        requirementCode: formData.get("requirementCode"),
        evidenceReference: formData.get("evidenceReference"),
        evidenceHash: formData.get("evidenceHash"),
        officialSourceUrl: formData.get("officialSourceUrl"),
        confirmedBy,
        expectedVersion: formData.get("expectedVersion"),
        confirmations: Object.fromEntries(
          (requirement?.confirmations || []).map((key) => [
            key,
            formData.get(key) === "true",
          ]),
        ),
        notes: formData.get("note"),
      });
    } else if (intent === "saveShipping") {
      if (!formData.has("expectedVersion"))
        throw new Error("evidence_version_required");
      await saveInternationalShippingCountryAvailability({
        countryCode: formData.get("countryCode"),
        status: formData.get("status"),
        sourceUrl: formData.get("sourceUrl"),
        evidenceReference: formData.get("evidenceReference"),
        evidenceHash: formData.get("evidenceHash"),
        confirmedBy,
        expectedVersion: formData.get("expectedVersion"),
        expectedEvidenceVersions: JSON.parse(
          String(formData.get("expectedEvidenceVersions") || "null"),
        ),
        deliveryProfileId: formData.get("deliveryProfileId"),
        carrierConfirmations: {
          officialStatusChecked:
            formData.get("officialStatusChecked") === "true",
          countryServiceMatched:
            formData.get("countryServiceMatched") === "true",
        },
        routeAuditConfirmations: {
          deliveryProfileMatched:
            formData.get("deliveryProfileMatched") === "true",
          manualRatesReviewed: formData.get("manualRatesReviewed") === "true",
          freeShippingReviewed: formData.get("freeShippingReviewed") === "true",
          alternateCarrierReviewed:
            formData.get("alternateCarrierReviewed") === "true",
          alternateProfilesReviewed:
            formData.get("alternateProfilesReviewed") === "true",
        },
        note: formData.get("note"),
      });
    }
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error?.code === "INTERNATIONAL_EVIDENCE_CONFLICT"
            ? "別の更新があるため保存できません。再読み込みして確認してください。"
            : "保存できませんでした。確認項目・証拠・同期状態を確認してください。",
      },
      {
        status: error?.code === "INTERNATIONAL_EVIDENCE_CONFLICT" ? 409 : 400,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  return redirect("/app/international-shipping", {
    headers: { "Cache-Control": "private, no-store" },
  });
};
