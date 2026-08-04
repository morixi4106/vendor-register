import prisma from "../../db.server.js";
import { EU_PRODUCT_ALLOWED_STATUSES } from "../../utils/deliveryEligibility.js";
import { PRODUCT_SHIPPING_METHOD, SHOPIFY_WEIGHT_SYNC_STATUS, validateStoredAirPacketProfile } from "../../utils/productShippingProfile.js";
import { INTERNATIONAL_SERVICE_STATUS } from ".././internationalShippingAvailability.server.js";
import { createCheck } from "./common.js";
export async function inspectShopifyProductSync({
  prismaClient = prisma
} = {}) {
  if (!prismaClient.shopifyProductSyncIssue?.findMany) {
    return {
      available: false,
      unresolvedCount: 0,
      activeCount: 0
    };
  }
  try {
    const issues = await prismaClient.shopifyProductSyncIssue.findMany({
      where: {
        status: "unresolved"
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
      euShippingBlocked: [],
      multiVariantAirPacket: [],
      weightSyncIssues: [],
      serviceAvailability: {
        available: false,
        activeCount: 0,
        staleActiveCount: 0
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
        shopifyWeightSyncStatus: true
      }
    });
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
    const multiVariantAirPacket = airPacketProducts.filter(product => Number(product.shopifyVariantCount) !== 1);
    const weightSyncIssues = airPacketProducts.filter(product => product.shopifyWeightSyncStatus !== SHOPIFY_WEIGHT_SYNC_STATUS.SYNCED);
    const staleBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const activeRows = (availabilityRows || []).filter(row => row.status === INTERNATIONAL_SERVICE_STATUS.ACTIVE);
    const staleActiveRows = activeRows.filter(row => !row.checkedAt || new Date(row.checkedAt) < staleBefore);
    return {
      available: true,
      approvedCount: products.length,
      missingWeight,
      invalidAirPacket,
      euShippingBlocked,
      airPacketCount: airPacketProducts.length,
      multiVariantAirPacket,
      weightSyncIssues,
      serviceAvailability: {
        available: Array.isArray(availabilityRows),
        activeCount: activeRows.length,
        staleActiveCount: staleActiveRows.length
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
        euShippingBlocked: [],
        multiVariantAirPacket: [],
        weightSyncIssues: [],
        serviceAvailability: {
          available: false,
          activeCount: 0,
          staleActiveCount: 0
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
      status: "warning",
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
    status: shippingProfiles.airPacketCount === 0 ? "pass" : !shippingProfiles.serviceAvailability.available || shippingProfiles.serviceAvailability.activeCount === 0 ? "fail" : shippingProfiles.serviceAvailability.staleActiveCount > 0 ? "warning" : "pass",
    title: "国際エアパケットの国別受付状況",
    detail: shippingProfiles.airPacketCount === 0 ? "国際エアパケット対象商品はありません。" : !shippingProfiles.serviceAvailability.available ? "国別受付状況を確認できません。migrationの適用状況を確認してください。" : shippingProfiles.serviceAvailability.activeCount === 0 ? "受付中として確認済みの国・地域がありません。" : `受付中 ${shippingProfiles.serviceAvailability.activeCount}か国・地域、7日以上未確認 ${shippingProfiles.serviceAvailability.staleActiveCount}件です。`,
    action: shippingProfiles.airPacketCount > 0 && (shippingProfiles.serviceAvailability.activeCount === 0 || shippingProfiles.serviceAvailability.staleActiveCount > 0) ? "国際配送状況を開き、日本郵便の最新受付状況を確認してください。" : ""
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
