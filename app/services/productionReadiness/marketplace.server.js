import { getShopifyMarketplacePaymentsApproval, isCrossBorderSellerSettlementEnabled, isDomesticSellerSettlementEnabled, isMarketplaceGovernanceGateEnabled, isMarketplaceSettlementActionsEnabled } from ".././marketplaceGovernance.server.js";
import { getProductionProbeSigningSecret } from ".././productionRelease.server.js";
import { createCheck, normalizeText } from "./common.js";
function isThirdPartySettlementDisabled(env) {
  return !isMarketplaceSettlementActionsEnabled(env) && !isDomesticSellerSettlementEnabled(env) && !isCrossBorderSellerSettlementEnabled(env);
}
export function applyReleaseDisposition(check, {
  env,
  operationEnv,
  directReturns
} = {}) {
  if (check.status === "pass") {
    return {
      ...check,
      releaseBlocking: false,
      releaseDisposition: "satisfied"
    };
  }
  if (check.status === "fail") {
    return {
      ...check,
      releaseBlocking: true,
      releaseDisposition: "required"
    };
  }
  const scopeExclusions = [{
    applies: check.category === "stripe" && operationEnv?.stripeConnectProductionEnabled !== true,
    reason: "国内直販はShopify Paymentsを使用し、Stripe Connectは公開範囲外です。"
  }, {
    applies: ["connected_accounts_match_current_stripe_key", "connected_accounts_ready"].includes(check.id) && operationEnv?.stripeConnectProductionEnabled !== true,
    reason: "国内直販はShopify Paymentsを使用し、Stripe Connectの接続アカウントは公開範囲外です。"
  }, {
    applies: check.category === "payout" && isThirdPartySettlementDisabled(env),
    reason: "第三者出店者への精算はすべて無効で、国内直販の公開範囲外です。"
  }, {
    applies: check.id === "withdrawal_return_address_legacy" && Number(directReturns?.legacyOpenRequestCount || 0) === 0,
    reason: "未処理の旧V1申請はなく、新規申請は店舗別返送V2だけを使用します。"
  }, {
    applies: check.id.startsWith("withdrawal_direct_return_") && Number(directReturns?.relevantStoreCount || 0) === 0,
    reason: "EU販売対象店舗がない国内限定公開では、店舗別返送方針は公開範囲外です。"
  }, {
    applies: check.id.startsWith("marketplace_governance_") && !isMarketplaceGovernanceGateEnabled(env),
    reason: "第三者マーケットプレイス販売は無効で、国内直販の公開範囲外です。"
  }];
  const exclusion = scopeExclusions.find(entry => entry.applies);
  if (exclusion) {
    return {
      ...check,
      releaseBlocking: false,
      releaseDisposition: "scope_excluded",
      releaseDispositionReason: exclusion.reason
    };
  }
  return {
    ...check,
    releaseBlocking: true,
    releaseDisposition: "decision_required"
  };
}
export function buildMarketplaceGovernanceChecks({
  governance,
  env
}) {
  const gateEnabled = isMarketplaceGovernanceGateEnabled(env);
  const settlementActionsEnabled = isMarketplaceSettlementActionsEnabled(env);
  const domesticSettlementEnabled = isDomesticSellerSettlementEnabled(env);
  const crossBorderSettlementEnabled = isCrossBorderSellerSettlementEnabled(env);
  if (!governance?.available) {
    return [createCheck({
      id: "marketplace_governance_models",
      category: "app",
      status: gateEnabled ? "fail" : "warning",
      title: "販売責任・契約管理",
      detail: "販売責任の検査データを読み込めませんでした。",
      action: "migration適用後に販売責任・案件管理と本番確認を再読み込みしてください。"
    })];
  }
  const productionSellers = governance.sellers.filter(({
    seller
  }) => !seller.vendor?.vendorStore?.isTestStore && !seller.vendor?.vendorStore?.isPlatformStore && seller.status === "active");
  const productionProducts = governance.products.filter(({
    product
  }) => !product.vendorStore?.isTestStore && !product.vendorStore?.isPlatformStore);
  const blockedSellers = productionSellers.filter(({
    readiness
  }) => !readiness.ready);
  const blockedProducts = productionProducts.filter(({
    readiness
  }) => !readiness.ready);
  const criticalCases = governance.cases.filter(entry => entry.priority === "CRITICAL" && !["RESOLVED", "CLOSED"].includes(entry.status));
  const blockedProductCount = Number.isInteger(governance.inspection?.blockedProductionProductCount) ? governance.inspection.blockedProductionProductCount : blockedProducts.length;
  const unresolvedCriticalCaseCount = Number.isInteger(governance.inspection?.criticalCaseCount) ? governance.inspection.criticalCaseCount : criticalCases.length;
  const payoutHolds = productionSellers.filter(({
    seller
  }) => seller.settlementControl?.payoutHold);
  const versionsConfigured = Boolean(governance.configuration?.ready);
  const shopifyPaymentsApproval = getShopifyMarketplacePaymentsApproval(env);
  const shopifyPaymentsApproved = shopifyPaymentsApproval.ready;
  const shopifyApprovalReference = shopifyPaymentsApproval.reference;
  const crossBorderLegalApprovalReference = normalizeText(env.CROSS_BORDER_SETTLEMENT_LEGAL_APPROVAL_REFERENCE);
  const sellerDisclosureProcedureReference = normalizeText(env.SELLER_DISCLOSURE_PROCEDURE_APPROVAL_REFERENCE);
  const taxInvoicePolicyReference = normalizeText(env.MARKETPLACE_TAX_INVOICE_POLICY_APPROVAL_REFERENCE);
  const privacyHashSecretConfigured = (normalizeText(env.PRIVACY_HASH_SECRET) || "").length >= 32;
  const productionProbeSigningSecretConfigured = Boolean(getProductionProbeSigningSecret(env));
  const hasThirdPartyProductionSeller = productionSellers.length > 0;
  const unsafeSettlementSwitch = settlementActionsEnabled && (!shopifyPaymentsApproved || !domesticSettlementEnabled && !crossBorderSettlementEnabled);
  return [createCheck({
    id: "seller_disclosure_procedure",
    category: "legal",
    status: !gateEnabled || sellerDisclosureProcedureReference ? "pass" : "fail",
    title: "販売者情報開示請求の運用手順",
    detail: sellerDisclosureProcedureReference ? `承認済み手順の証跡を記録済みです: ${sellerDisclosureProcedureReference}` : "本人確認、開示根拠、対象項目、店舗通知及び期限を含む承認済み手順が未記録です。",
    action: gateEnabled && !sellerDisclosureProcedureReference ? "手順を承認し、証跡参照をSELLER_DISCLOSURE_PROCEDURE_APPROVAL_REFERENCEへ設定してください。" : ""
  }), createCheck({
    id: "marketplace_tax_invoice_policy",
    category: "tax",
    status: !gateEnabled || taxInvoicePolicyReference ? "pass" : "fail",
    title: "複数売主注文の税務・請求書方針",
    detail: taxInvoicePolicyReference ? `税理士等の確認証跡を記録済みです: ${taxInvoicePolicyReference}` : "領収書・適格請求書の発行主体、店舗別売上、手数料及び返金の処理方針が未記録です。",
    action: gateEnabled && !taxInvoicePolicyReference ? "税務方針を確定し、証跡参照をMARKETPLACE_TAX_INVOICE_POLICY_APPROVAL_REFERENCEへ設定してください。" : ""
  }), createCheck({
    id: "privacy_identifier_hash_secret",
    category: "security",
    status: privacyHashSecretConfigured ? "pass" : "warning",
    title: "公開フォーム識別子の専用ハッシュ鍵",
    detail: privacyHashSecretConfigured ? "専用HMAC鍵を設定済みです。" : "SHOPIFY_API_SECRET等へフォールバックしています。鍵の用途分離が未完了です。",
    action: privacyHashSecretConfigured ? "" : "32文字以上の乱数をPRIVACY_HASH_SECRETへ設定してください。"
  }), createCheck({
    id: "production_probe_signing_secret",
    category: "security",
    status: productionProbeSigningSecretConfigured ? "pass" : "fail",
    title: "本番プローブ専用署名鍵",
    detail: productionProbeSigningSecretConfigured ? "公開フォームやShopify認証とは分離した署名鍵を設定済みです。" : "本番プローブの署名鍵が未設定、短すぎる、または用途分離されていません。",
    action: productionProbeSigningSecretConfigured ? "" : "32文字以上の乱数をPRODUCTION_PROBE_SIGNING_SECRETへ設定してください。"
  }), createCheck({
    id: "shopify_marketplace_payments_written_approval",
    category: "payout",
    status: !hasThirdPartyProductionSeller || shopifyPaymentsApproved ? "pass" : "fail",
    title: "Shopify Paymentsのマーケットプレイス利用確認",
    detail: !hasThirdPartyProductionSeller ? "精算対象となる第三者の本番店舗はありません。" : shopifyPaymentsApproved ? `Shopifyからの書面回答を記録済みです: ${shopifyApprovalReference}` : "第三者店舗を売主とし、運営が代金を受領して後日精算する構造について、Shopifyからの書面承認が未記録です。",
    action: hasThirdPartyProductionSeller && !shopifyPaymentsApproved ? "精算と複数店舗販売を開始せず、Shopifyの書面回答を取得して参照番号をRenderへ設定してください。" : ""
  }), createCheck({
    id: "marketplace_settlement_kill_switches",
    category: "payout",
    status: unsafeSettlementSwitch ? "fail" : "pass",
    title: "店舗精算の独立停止スイッチ",
    detail: `全体 ${settlementActionsEnabled ? "ON" : "OFF"} / 国内 ${domesticSettlementEnabled ? "ON" : "OFF"} / 越境 ${crossBorderSettlementEnabled ? "ON" : "OFF"}`,
    action: unsafeSettlementSwitch ? "書面承認と対象地域の確認が完了するまで、MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED=falseを維持してください。" : ""
  }), createCheck({
    id: "cross_border_settlement_legal_approval",
    category: "payout",
    status: !crossBorderSettlementEnabled || crossBorderLegalApprovalReference ? "pass" : "fail",
    title: "越境精算の法務確認",
    detail: crossBorderSettlementEnabled ? crossBorderLegalApprovalReference ? `越境精算の確認証跡を記録済みです: ${crossBorderLegalApprovalReference}` : "越境精算がONですが、資金移動・収納代行規制の個別確認証跡がありません。" : "越境精算は停止しています。",
    action: crossBorderSettlementEnabled && !crossBorderLegalApprovalReference ? "CROSS_BORDER_SELLER_SETTLEMENT_ENABLED=falseへ戻し、資格者の書面確認後にだけ有効化してください。" : ""
  }), createCheck({
    id: "marketplace_governance_versions",
    category: "app",
    status: versionsConfigured ? "pass" : gateEnabled ? "fail" : "warning",
    title: "契約・購入規約の版管理",
    detail: versionsConfigured ? `出店者契約 ${governance.agreementVersion} / 購入規約 ${governance.buyerTermsVersion}` : `契約設定が不足しています: ${(governance.configuration?.reasons || []).join(", ")}`,
    action: versionsConfigured ? "" : "契約本文と購入規約を公開し、版・URL・SHA-256をRenderへ設定してください。"
  }), createCheck({
    id: "marketplace_governance_sellers",
    category: "seller",
    status: blockedSellers.length === 0 ? "pass" : gateEnabled ? "fail" : "warning",
    title: "販売中店舗の事業者・契約確認",
    detail: blockedSellers.length === 0 ? "販売中の本番店舗は販売責任の確認を完了しています。" : `${blockedSellers.length}店舗で事業者情報、契約、返品先または販売保留の確認が必要です。`,
    action: blockedSellers.length === 0 ? "" : "販売責任・案件管理で不足項目を確認してください。"
  }), createCheck({
    id: "marketplace_governance_products",
    category: "shopify",
    status: blockedProductCount === 0 ? "pass" : gateEnabled ? "fail" : "warning",
    title: "販売商品の責任・通関情報",
    detail: blockedProductCount === 0 ? "本番商品の販売主体、状態、原産国、真正性情報を確認済みです。" : `${blockedProductCount}商品で販売主体、状態、原産国、通関情報または真正性確認が不足しています。`,
    action: blockedProductCount === 0 ? "" : "販売責任・案件管理で、Shopify直接登録商品を含めて審査してください。"
  }), createCheck({
    id: "marketplace_governance_critical_cases",
    category: "app",
    status: unresolvedCriticalCaseCount > 0 ? "fail" : "pass",
    title: "重大な購入後案件",
    detail: unresolvedCriticalCaseCount > 0 ? `未解決の重大案件が${unresolvedCriticalCaseCount}件あります。` : "未解決の重大案件はありません。",
    action: unresolvedCriticalCaseCount > 0 ? "責任・証拠・購入者対応・精算処理を確定してください。" : ""
  }), createCheck({
    id: "marketplace_governance_payout_holds",
    category: "payout",
    status: payoutHolds.length > 0 ? "warning" : "pass",
    title: "出金保留",
    detail: payoutHolds.length > 0 ? `${payoutHolds.length}店舗の出金が管理者判断で保留されています。` : "管理者判断による出金保留はありません。",
    action: payoutHolds.length > 0 ? "保留理由と解除条件を案件記録と照合してください。" : ""
  })];
}
