import prisma from "../../db.server.js";
import { EU_PRODUCT_ALLOWED_STATUSES } from "../../utils/deliveryEligibility.js";
import {
  evaluateInternationalMarketCompliance,
  getRequiredInternationalRequirements,
  INTERNATIONAL_REQUIREMENT_VERSION,
  isCosmeticsProduct,
  isInternationalRequirementCurrent,
} from "../../utils/internationalMarketCompliance.js";
import { validateInternationalCustomsProfile } from "../../utils/internationalProductProfile.js";
import { PRODUCT_SHIPPING_METHOD, SHOPIFY_WEIGHT_SYNC_STATUS, validateStoredAirPacketProfile } from "../../utils/productShippingProfile.js";
import {
  evaluateInternationalShippingAvailability,
  INTERNATIONAL_SERVICE_STATUS,
} from "../internationalShippingAvailability.server.js";
import { createCheck, normalizeShopDomain } from "./common.js";
export async function inspectShopifyProductSync({
  prismaClient = prisma,
  shopDomain = null
} = {}) {
  if (!prismaClient.shopifyProductSyncIssue?.findMany) {
    return {
      available: false,
      unresolvedCount: 0,
      activeCount: 0
    };
  }
  try {
    const normalizedShopDomain = normalizeShopDomain(shopDomain);
    const issues = await prismaClient.shopifyProductSyncIssue.findMany({
      where: {
        status: "unresolved",
        ...(normalizedShopDomain ? { shopDomain: normalizedShopDomain } : {})
      },
      select: {
        id: true,
        payloadJson: true
      }
    });
    const activeCount = issues.filter(issue => String(issue?.payloadJson?.status || "").trim().toLowerCase() === "active").length;
    return {
      available: true,
      unresolvedCount: issues.length,
      activeCount
    };
  } catch (error) {
    if (error?.code === "P2021") {
      return {
        available: false,
        unresolvedCount: 0,
        activeCount: 0
      };
    }
    throw error;
  }
}
export function buildShopifyProductSyncChecks(syncState) {
  if (!syncState.available) {
    return [createCheck({
      id: "shopify_product_store_mapping",
      category: "shopify",
      status: "warning",
      title: "Shopify商品と店舗の紐付け",
      detail: "商品同期テーブルの準備状態を確認できませんでした。",
      action: "最新のPrisma migrationを適用してください。"
    })];
  }
  const status = syncState.activeCount > 0 ? "fail" : syncState.unresolvedCount > 0 ? "warning" : "pass";
  return [createCheck({
    id: "shopify_product_store_mapping",
    category: "shopify",
    status,
    title: "Shopify商品と店舗の紐付け",
    detail: syncState.unresolvedCount > 0 ? `未解決 ${syncState.unresolvedCount}件（販売中 ${syncState.activeCount}件）` : "Shopifyから直接登録された商品も店舗へ紐付いています。",
    action: syncState.unresolvedCount > 0 ? "Shopify商品同期を開き、販売店舗を確定してください。" : ""
  })];
}
export async function inspectProductShippingProfiles({
  prismaClient = prisma,
  now = new Date()
} = {}) {
  if (!prismaClient.product?.findMany) {
    return {
      available: false,
      approvedCount: 0,
      missingWeight: [],
      invalidAirPacket: [],
      invalidInternationalCustoms: [],
      missingInternationalCountryAllowlist: [],
      internationalComplianceBlocked: [],
      internationalRequirementCatalogMissing: [],
      euShippingBlocked: [],
      multiVariantAirPacket: [],
      weightSyncIssues: [],
      serviceAvailability: {
        available: false,
        activeCount: 0,
        staleActiveCount: 0,
        requiredCountryCount: 0,
        unavailableCountries: [],
        staleCountries: []
      },
      error: "product_shipping_profile_table_unavailable"
    };
  }
  try {
    const products = await prismaClient.product.findMany({
      where: {
        approvalStatus: "approved",
        vendorStore: {
          is: {
            isTestStore: false
          }
        }
      },
      select: {
        id: true,
        name: true,
        shippingWeightGrams: true,
        shippingLengthMm: true,
        shippingWidthMm: true,
        shippingHeightMm: true,
        internationalShippingMethod: true,
        productEuStatus: true,
        shippingWeightConfirmedAt: true,
        shippingWeightSource: true,
        shopifyVariantCount: true,
        shopifyWeightSyncStatus: true,
        category: true,
        countryPolicy: true,
        complianceProfile: true,
        complianceEvidence: {
          include: { requirement: true },
          orderBy: { createdAt: "desc" },
          take: 100
        },
        complianceDecisions: {
          include: { requirement: true },
          orderBy: { decidedAt: "desc" },
          take: 100
        }
      }
    });
    const internationalRequirements = prismaClient.complianceRequirement?.findMany ? await prismaClient.complianceRequirement.findMany({
      where: {
        version: INTERNATIONAL_REQUIREMENT_VERSION,
        isActive: true,
        status: "ACTIVE"
      },
      select: {
        code: true,
        effectiveFrom: true,
        effectiveUntil: true,
        reviewDueAt: true,
        isActive: true,
        status: true
      }
    }) : [];
    const availabilityRows = prismaClient.internationalShippingCountryAvailability?.findMany ? await prismaClient.internationalShippingCountryAvailability.findMany({
      where: {
        service: "JAPAN_POST_AIR_PACKET"
      },
      select: {
        countryCode: true,
        status: true,
        checkedAt: true
      }
    }) : null;
    const missingWeight = products.filter(product => {
      const weight = Number(product.shippingWeightGrams);
      return !Number.isInteger(weight) || weight <= 0;
    });
    const invalidAirPacket = products.filter(product => product.internationalShippingMethod === PRODUCT_SHIPPING_METHOD.AIR_PACKET && !validateStoredAirPacketProfile(product).ok);
    const euShippingBlocked = products.filter(product => EU_PRODUCT_ALLOWED_STATUSES.has(product.productEuStatus) && !validateStoredAirPacketProfile(product).ok);
    const airPacketProducts = products.filter(product => product.internationalShippingMethod === PRODUCT_SHIPPING_METHOD.AIR_PACKET);
    const cosmeticsAirPacketProducts = airPacketProducts.filter(isCosmeticsProduct);
    const invalidInternationalCustoms = airPacketProducts.filter(product => !validateInternationalCustomsProfile(product).ok);
    const missingInternationalCountryAllowlist = airPacketProducts.filter(product => {
      const countries = Array.isArray(product.countryPolicy?.allowedCountries) ? product.countryPolicy.allowedCountries : [];
      return countries.filter(country => String(country || "").trim().toUpperCase() !== "JP").length === 0;
    });
    const internationalComplianceBlocked = airPacketProducts.flatMap(product => {
      const countries = Array.isArray(product.countryPolicy?.allowedCountries) ? product.countryPolicy.allowedCountries : [];
      return Array.from(new Set(countries.map(country => String(country || "").trim().toUpperCase()).filter(country => country && country !== "JP"))).flatMap(countryCode => {
        const result = evaluateInternationalMarketCompliance({
          product,
          destinationCountry: countryCode,
          evaluatedAt: now
        });
        return result.ready ? [] : [{ ...product, countryCode, complianceReasons: result.reasons }];
      });
    });
    const activeRequirementCodes = new Set(
      internationalRequirements
        .filter(entry => isInternationalRequirementCurrent(entry, now))
        .map(entry => entry.code)
    );
    const requiredRequirementCatalog = new Map();
    for (const product of cosmeticsAirPacketProducts) {
      const countries = Array.isArray(product.countryPolicy?.allowedCountries)
        ? product.countryPolicy.allowedCountries
        : [];
      for (const countryCode of countries) {
        const normalizedCountry = String(countryCode || "").trim().toUpperCase();
        if (!normalizedCountry || normalizedCountry === "JP") continue;
        for (const requirement of getRequiredInternationalRequirements(
          product,
          normalizedCountry,
        )) {
          requiredRequirementCatalog.set(requirement.code, requirement);
        }
      }
    }
    const internationalRequirementCatalogMissing = Array.from(
      requiredRequirementCatalog.values(),
    ).filter((requirement) => !activeRequirementCodes.has(requirement.code));
    const multiVariantAirPacket = airPacketProducts.filter(product => Number(product.shopifyVariantCount) !== 1);
    const weightSyncIssues = airPacketProducts.filter(product => product.shopifyWeightSyncStatus !== SHOPIFY_WEIGHT_SYNC_STATUS.SYNCED);
    const activeRows = (availabilityRows || []).filter(row => row.status === INTERNATIONAL_SERVICE_STATUS.ACTIVE);
    const staleActiveRows = activeRows.filter(row =>
      evaluateInternationalShippingAvailability(row, { now }).stale
    );
    const requiredCountries = Array.from(new Set(airPacketProducts.flatMap(product => {
      const countries = Array.isArray(product.countryPolicy?.allowedCountries) ? product.countryPolicy.allowedCountries : [];
      return countries.map(country => String(country || "").trim().toUpperCase()).filter(country => country && country !== "JP");
    })));
    const availabilityByCountry = new Map((availabilityRows || []).map(row => [String(row.countryCode || "").trim().toUpperCase(), row]));
    const unavailableCountries = requiredCountries.filter(countryCode =>
      !evaluateInternationalShippingAvailability(
        availabilityByCountry.get(countryCode),
        { now }
      ).deliverable
    );
    const staleCountries = requiredCountries.filter(countryCode => {
      const row = availabilityByCountry.get(countryCode);
      return (
        row?.status === INTERNATIONAL_SERVICE_STATUS.ACTIVE &&
        evaluateInternationalShippingAvailability(row, { now }).stale
      );
    });
    return {
      available: true,
      approvedCount: products.length,
      missingWeight,
      invalidAirPacket,
      invalidInternationalCustoms,
      missingInternationalCountryAllowlist,
      internationalComplianceBlocked,
      internationalRequirementCatalogMissing,
      euShippingBlocked,
      airPacketCount: airPacketProducts.length,
      multiVariantAirPacket,
      weightSyncIssues,
      serviceAvailability: {
        available: Array.isArray(availabilityRows),
        activeCount: activeRows.length,
        staleActiveCount: staleActiveRows.length,
        requiredCountryCount: requiredCountries.length,
        unavailableCountries,
        staleCountries
      },
      error: null
    };
  } catch (error) {
    if (error?.code === "P2021" || error?.code === "P2022") {
      return {
        available: false,
        approvedCount: 0,
        missingWeight: [],
        invalidAirPacket: [],
        invalidInternationalCustoms: [],
        missingInternationalCountryAllowlist: [],
        internationalComplianceBlocked: [],
        internationalRequirementCatalogMissing: [],
        euShippingBlocked: [],
        multiVariantAirPacket: [],
        weightSyncIssues: [],
        serviceAvailability: {
          available: false,
          activeCount: 0,
          staleActiveCount: 0,
          requiredCountryCount: 0,
          unavailableCountries: [],
          staleCountries: []
        },
        error: error.code
      };
    }
    throw error;
  }
}
function formatProductSamples(products) {
  const names = products.slice(0, 5).map(product => product.name || product.id);
  const suffix = products.length > names.length ? `、ほか${products.length - names.length}件` : "";
  return `${names.join("、")}${suffix}`;
}
export function buildProductShippingProfileChecks(shippingProfiles) {
  if (!shippingProfiles.available) {
    return [createCheck({
      id: "product_shipping_profiles_available",
      category: "shopify",
      status: "fail",
      title: "商品配送プロフィール",
      detail: `配送プロフィールを確認できませんでした（${shippingProfiles.error}）。`,
      action: "最新のPrisma migrationを適用し、本番確認を再実行してください。"
    })];
  }
  const checks = [createCheck({
    id: "approved_product_shipping_weight",
    category: "shopify",
    status: shippingProfiles.missingWeight.length > 0 ? "warning" : "pass",
    title: "販売中商品の梱包後重量",
    detail: shippingProfiles.missingWeight.length > 0 ? `販売承認済み商品のうち${shippingProfiles.missingWeight.length}件で梱包後重量が未設定です：${formatProductSamples(shippingProfiles.missingWeight)}` : `販売承認済み${shippingProfiles.approvedCount}件の梱包後重量が設定されています。`,
    action: shippingProfiles.missingWeight.length > 0 ? "商品詳細の配送プロフィールで、梱包材を含む重量を登録してください。国内配送は継続できますが、国際送料には使用できません。" : ""
  }), createCheck({
    id: "international_requirement_catalog",
    category: "shopify",
    status: shippingProfiles.internationalRequirementCatalogMissing.length > 0 ? "fail" : "pass",
    title: "国際販売の規制要件カタログ",
    detail: shippingProfiles.airPacketCount === 0 ? "国際配送対象商品はありません。" : shippingProfiles.internationalRequirementCatalogMissing.length > 0 ? `${shippingProfiles.internationalRequirementCatalogMissing.length}件の国際販売要件が未同期です。` : "国際販売要件は現行版で同期されています。",
    action: shippingProfiles.internationalRequirementCatalogMissing.length > 0 ? "販売責任・案件管理で国際販売要件を同期してください。" : ""
  }), createCheck({
    id: "international_product_customs_profiles",
    category: "shopify",
    status: shippingProfiles.invalidInternationalCustoms.length > 0 ? "fail" : "pass",
    title: "国際配送商品の税関情報",
    detail: shippingProfiles.invalidInternationalCustoms.length > 0 ? `${shippingProfiles.invalidInternationalCustoms.length}件で原産国、HSコード、英語品名または規制区分が不足しています：${formatProductSamples(shippingProfiles.invalidInternationalCustoms)}` : "国際配送商品の税関情報は入力済みです。",
    action: shippingProfiles.invalidInternationalCustoms.length > 0 ? "商品詳細で税関情報を修正してください。" : ""
  }), createCheck({
    id: "international_product_country_allowlist",
    category: "shopify",
    status: shippingProfiles.missingInternationalCountryAllowlist.length > 0 ? "fail" : "pass",
    title: "国際配送商品の販売国",
    detail: shippingProfiles.missingInternationalCountryAllowlist.length > 0 ? `${shippingProfiles.missingInternationalCountryAllowlist.length}件で海外の販売許可国が明示されていません：${formatProductSamples(shippingProfiles.missingInternationalCountryAllowlist)}` : "国際配送商品の販売許可国は明示されています。",
    action: shippingProfiles.missingInternationalCountryAllowlist.length > 0 ? "商品配送設定で販売を許可する国だけを登録してください。" : ""
  }), createCheck({
    id: "international_market_compliance",
    category: "shopify",
    status: shippingProfiles.internationalComplianceBlocked.length > 0 ? "fail" : "pass",
    title: "販売国別の商品適合証拠",
    detail: shippingProfiles.internationalComplianceBlocked.length > 0 ? `${shippingProfiles.internationalComplianceBlocked.length}件の商品・販売国の組み合わせで証拠または判断が不足しています：${formatProductSamples(shippingProfiles.internationalComplianceBlocked)}` : "許可した販売国について必要な商品適合証拠を確認済みです。",
    action: shippingProfiles.internationalComplianceBlocked.length > 0 ? "販売責任・案件管理で国別要件の証拠と判断を登録するか、販売許可国から外してください。" : ""
  }), createCheck({
    id: "air_packet_single_variant_products",
    category: "shopify",
    status: shippingProfiles.multiVariantAirPacket.length > 0 ? "fail" : "pass",
    title: "国際配送商品のバリエーション数",
    detail: shippingProfiles.multiVariantAirPacket.length > 0 ? `国際エアパケット対象のうち${shippingProfiles.multiVariantAirPacket.length}件が単一バリエーションではありません：${formatProductSamples(shippingProfiles.multiVariantAirPacket)}` : "国際エアパケット対象商品はすべて単一バリエーションです。",
    action: shippingProfiles.multiVariantAirPacket.length > 0 ? "該当商品を国内配送のみに戻すか、単一バリエーションの商品として分けてください。" : ""
  }), createCheck({
    id: "air_packet_weight_sync",
    category: "shopify",
    status: shippingProfiles.weightSyncIssues.length > 0 ? "fail" : "pass",
    title: "梱包後重量のShopify同期",
    detail: shippingProfiles.weightSyncIssues.length > 0 ? `${shippingProfiles.weightSyncIssues.length}件で重量の確認またはShopify同期が未完了です：${formatProductSamples(shippingProfiles.weightSyncIssues)}` : "国際配送商品の梱包後重量は確認・同期済みです。",
    action: shippingProfiles.weightSyncIssues.length > 0 ? "商品配送設定で梱包後重量を再確認して保存してください。" : ""
  }), createCheck({
    id: "air_packet_country_availability",
    category: "shopify",
    status: shippingProfiles.airPacketCount === 0 ? "pass" : !shippingProfiles.serviceAvailability.available || shippingProfiles.serviceAvailability.requiredCountryCount === 0 || shippingProfiles.serviceAvailability.unavailableCountries.length > 0 || shippingProfiles.serviceAvailability.staleCountries.length > 0 ? "fail" : "pass",
    title: "国際エアパケットの国別受付状況",
    detail: shippingProfiles.airPacketCount === 0 ? "国際エアパケット対象商品はありません。" : !shippingProfiles.serviceAvailability.available ? "国別受付状況を確認できません。migrationの適用状況を確認してください。" : shippingProfiles.serviceAvailability.activeCount === 0 ? "受付中として確認済みの国・地域がありません。" : `受付中 ${shippingProfiles.serviceAvailability.activeCount}か国・地域、7日以上未確認 ${shippingProfiles.serviceAvailability.staleActiveCount}件です。`,
    action: shippingProfiles.airPacketCount > 0 && (!shippingProfiles.serviceAvailability.available || shippingProfiles.serviceAvailability.requiredCountryCount === 0 || shippingProfiles.serviceAvailability.unavailableCountries.length > 0 || shippingProfiles.serviceAvailability.staleCountries.length > 0) ? "国際配送状況を開き、販売許可国すべてについて日本郵便の最新受付状況を確認してください。" : ""
  }), createCheck({
    id: "air_packet_product_profiles",
    category: "shopify",
    status: shippingProfiles.invalidAirPacket.length > 0 ? "fail" : "pass",
    title: "国際エアパケットの商品条件",
    detail: shippingProfiles.invalidAirPacket.length > 0 ? `国際エアパケット設定済み商品のうち${shippingProfiles.invalidAirPacket.length}件で重量または寸法が利用条件を満たしていません：${formatProductSamples(shippingProfiles.invalidAirPacket)}` : "国際エアパケットを有効にした商品の重量・寸法は利用条件内です。",
    action: shippingProfiles.invalidAirPacket.length > 0 ? "該当商品の重量・寸法を修正するか、配送範囲を国内配送のみに戻してください。" : ""
  }), createCheck({
    id: "eu_product_international_shipping_profiles",
    category: "shopify",
    status: shippingProfiles.euShippingBlocked.length > 0 ? "fail" : "pass",
    title: "EU販売商品の国際配送プロフィール",
    detail: shippingProfiles.euShippingBlocked.length > 0 ? `EU販売可能な商品のうち${shippingProfiles.euShippingBlocked.length}件は、有効な国際配送プロフィールがありません：${formatProductSamples(shippingProfiles.euShippingBlocked)}` : "EU販売可能な商品には有効な国際配送プロフィールがあります。",
    action: shippingProfiles.euShippingBlocked.length > 0 ? "国際エアパケットの重量・寸法を登録するか、EU販売ステータスを無効にしてください。" : ""
  })];
  return checks;
}
