import prisma from "../db.server.js";
import {
  buildInternationalGateSnapshot,
  internationalHash,
  internationalLocalDate,
  serializeInternationalProjection,
} from "./internationalGateProjection.server.js";
import {
  internationalGraphQL,
  readInternationalMetafield,
  verifyInternationalProductReadbacks,
} from "./internationalGateTransport.server.js";
import { inspectInternationalNativeConfiguration } from "./internationalNativeConfiguration.server.js";
import { inspectInternationalGateRelease } from "./internationalGateAuthorization.server.js";
import { inspectInternationalAuthorizationState } from "./internationalAuthorizationState.server.js";

export async function inspectInternationalCheckoutGate(
  { shopDomain, prismaClient = prisma, env = process.env, now = new Date() },
  {
    graphQL = internationalGraphQL,
    buildSnapshot = buildInternationalGateSnapshot,
    inspectNative = inspectInternationalNativeConfiguration,
    inspectRelease = inspectInternationalGateRelease,
    inspectAuthorization = inspectInternationalAuthorizationState,
  } = {},
) {
  try {
    const state = await prismaClient.internationalGateSyncState.findUnique({
      where: { shopDomain },
    });
    if (!state || state.mode === "DISABLED")
      return {
        configured: false,
        ready: false,
        protected: false,
        status: "UNCONFIGURED",
      };
    const observed = await readInternationalMetafield({
      shopDomain,
      targetType: "SHOP",
      graphQL,
    });
    let gate;
    try {
      gate = JSON.parse(observed.value);
    } catch {
      gate = null;
    }
    const validHash =
      gate &&
      (() => {
        const { h, ...base } = gate;
        return h === internationalHash(base);
      })();
    const rows = await prismaClient.operationalReadinessAttestation.findMany({
      where: {
        scopeType: "MARKET_COUNTRY",
        checkKey: "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
      },
    });
    const native = await inspectNative({
      shopDomain,
      scope: state.authorizedScopeJson,
      expectedRoutes: Object.fromEntries(
        rows.map((r) => [r.scopeId, r.metadataJson?.deliveryProfileId]),
      ),
      graphQL,
    });
    const release = await inspectRelease({
      shopDomain,
      prismaClient,
      native,
      env,
      now,
      purpose: state.authorizationPurpose || "SALE",
    });
    const closed =
      validHash &&
      gate.v === 2 &&
      gate.p === "international-sale-2026-10-v1" &&
      ["PREPARING", "BLOCKED"].includes(gate.s) &&
      Array.isArray(gate.c) &&
      gate.c.length === 0;
    const protectedState = Boolean(
      closed && native.validationReady && release.ready,
    );
    const base = {
      configured: true,
      available: true,
      ready: false,
      protected: protectedState,
      desiredGeneration: state.desiredGeneration,
      appliedGeneration: state.appliedGeneration,
      nativeScopeVerified: native.available === true,
      nativeInternationalConfigured: native.internationalConfigured,
      status: protectedState ? "BLOCKED" : "UNVERIFIED",
    };
    if (
      state.mode !== "ENFORCE" ||
      !state.snapshotComplete ||
      state.desiredGeneration !== state.appliedGeneration ||
      state.phase !== "ACTIVE" ||
      !validHash ||
      observed.timezone !== state.shopTimezone ||
      observed.value !==
        serializeInternationalProjection(state.expectedShopJson) ||
      native.configHash !== state.nativeConfigHash ||
      !release.ready ||
      release.binding !== state.releaseBinding ||
      internationalLocalDate(now, observed.timezone) >= gate.e
    )
      return base;
    const authorization = await inspectAuthorization({ prismaClient, state, now });
    if (!authorization.ready) return base;
    const fresh = await buildSnapshot({
      state,
      prismaClient,
      now,
      env,
      persist: false,
    });
    if (
      fresh.sourceHash !== state.sourceHash ||
      JSON.stringify(fresh.shop.c) !== JSON.stringify(gate.c)
    )
      return base;
    const targets = await prismaClient.internationalGateSyncJob.findMany({
      where: {
        shopDomain,
        generation: state.appliedGeneration,
        targetType: "PRODUCT",
        status: "VERIFIED",
      },
      orderBy: { targetId: "asc" },
    });
    if (targets.length !== state.expectedProductCount) return base;
    await verifyInternationalProductReadbacks({ shopDomain, targets, graphQL });
    return authorization.purpose === "VERIFY"
      ? { ...base, ready: false, verificationReady: true, protected: true, status: "VERIFYING" }
      : { ...base, ready: true, protected: true, status: "ACTIVE" };
  } catch {
    return {
      configured: true,
      available: false,
      ready: false,
      protected: false,
      status: "UNVERIFIED",
    };
  }
}

export function buildInternationalCheckoutGateCheck(result) {
  return {
    id: "international_checkout_gate",
    category: "shopify",
    status: result?.ready ? "pass" : "fail",
    title: "海外の商品・国別購入制御",
    detail: result?.ready
      ? "対象商品と国の許可・実設定・リリースが一致しています。"
      : result?.protected
        ? "海外停止は確認済みです。販売条件の反映は未完了です。"
        : "海外停止または販売条件の反映を確認できません。",
    action: result?.ready
      ? ""
      : "同期状態・実設定・リリース証拠を確認してください。",
  };
}
