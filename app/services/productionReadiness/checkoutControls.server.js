import {
  buildProductionReleaseExpectation,
  inspectProductionReleaseEvidence,
} from "../productionRelease.server.js";
import { inspectPlatformDirectCheckoutMode } from "../platformDirectCheckoutMode.server.js";
import { summarizeProductionReadinessChecks } from "./common.js";

export function includeCheckoutGateInProductionReadiness(
  readiness,
  checkoutGate,
) {
  const gateReady = Boolean(
    checkoutGate?.available === true &&
    checkoutGate?.active === true &&
    checkoutGate?.publicationConfigurationReady !== false &&
    Number(checkoutGate?.exposedProductCount || 0) === 0 &&
    Number(checkoutGate?.failedProductCount || 0) === 0,
  );
  const checkoutGateCheck = {
    id: "marketplace_checkout_publication_boundary",
    category: "shopify",
    status: gateReady ? "pass" : "fail",
    title: "Shopify販売チャネルの公開境界",
    detail: gateReady
      ? "第三者・テスト・未解決の商品は、すべての購入可能Publicationから除外されています。"
      : checkoutGate?.message ||
        `公開中 ${Number(checkoutGate?.exposedProductCount || 0)}件 / 確認失敗 ${Number(checkoutGate?.failedProductCount || 0)}件 / Publication設定 ${checkoutGate?.publicationConfigurationReady === false ? "未完了" : "確認済み"}`,
    action: gateReady
      ? ""
      : "SHOPIFY_ONLINE_STORE_PUBLICATION_IDを設定し、商品カタログ同期と公開境界の有効化を再実行してください。",
  };
  const checks = [
    ...(readiness?.checks || []).filter(
      (check) => check.id !== checkoutGateCheck.id,
    ),
    checkoutGateCheck,
  ];
  const releaseSummary = summarizeProductionReadinessChecks(checks);
  return {
    ...readiness,
    canGoLive: releaseSummary.canGoLive,
    codeCanGoLive: releaseSummary.codeCanGoLive,
    summary: releaseSummary.summary,
    checkoutGate,
    checks: releaseSummary.checks,
  };
}

export function includeCheckoutValidationInProductionReadiness(
  readiness,
  checkoutValidation,
  env = process.env,
) {
  const checkoutMode = inspectPlatformDirectCheckoutMode(env);
  const standardDirect = checkoutMode.standardDirectReady;
  const validationReady = standardDirect
    ? Boolean(
        checkoutValidation?.ok === true &&
        checkoutValidation?.exists === true &&
        checkoutValidation?.prepared === true &&
        checkoutValidation?.active !== true,
      )
    : Boolean(
        checkoutValidation?.ok === true && checkoutValidation?.active === true,
      );
  const checkoutValidationCheck = {
    id: "marketplace_checkout_server_validation",
    category: "shopify",
    status: validationReady ? "pass" : "fail",
    title: standardDirect
      ? "Shopify標準チェックアウト"
      : "Shopifyサーバー側の購入制御",
    detail: validationReady
      ? standardDirect
        ? "国内運営直販はShopify標準チェックアウトを使用し、マーケットプレイス用Validationは無効です。"
        : "Cart and Checkout Validation Functionが有効で、実行失敗時も購入を拒否します。"
      : standardDirect
        ? "標準直販モードではマーケットプレイス用Validationを無効にする必要があります。"
        : `Shopifyの購入制御が未完成です: ${checkoutValidation?.reason || "status_unavailable"}`,
    action: validationReady
      ? ""
      : standardDirect
        ? "本番確認画面からマーケットプレイス用Validationを無効化してください。"
        : "read_validations/write_validationsを承認し、本番確認画面から購入制御を有効化してください。",
  };
  const expectedRelease = buildProductionReleaseExpectation({
    checkoutValidation,
  });
  const productionRelease = inspectProductionReleaseEvidence({
    operationalReadiness: readiness?.operationalReadiness,
    expected: expectedRelease,
  });
  const productionReleaseCheck = {
    id: "operational_attestation_checkout_validation_live_probe_completed",
    category: "operations",
    status: productionRelease.ready ? "pass" : "fail",
    title: "本番Function・Release Manifestの必須シナリオ実機確認",
    detail: productionRelease.ready
      ? `リリース ${productionRelease.manifest.releaseId} の実チェックアウト証跡が現在の稼働版と一致しています。`
      : `リリース証跡が現在の稼働版と一致しません: ${productionRelease.mismatches.join(", ")}`,
    action: productionRelease.ready
      ? ""
      : "SHOPIFY_APP_VERSIONを設定し、本番確認画面で必須シナリオを実行して現在のIDを記録してください。",
  };
  const modeReady =
    checkoutMode.standardDirectRequested === false ||
    checkoutMode.standardDirectReady === true;
  const checkoutModeCheck = {
    id: "platform_direct_checkout_mode",
    category: "shopify",
    status: modeReady ? "pass" : "fail",
    title: "国内運営直販の購入経路",
    detail: modeReady
      ? standardDirect
        ? "Shopify標準チェックアウトとKOMOJUを使用します。第三者販売・精算機能はすべて停止しています。"
        : "マーケットプレイス用の購入制御を使用します。"
      : `標準直販へ切り替えられません。第三者販売フラグが有効です: ${checkoutMode.enabledThirdPartyFlags.join(", ")}`,
    action: modeReady
      ? ""
      : "第三者販売・精算フラグをすべて無効にしてから再確認してください。",
  };
  const checks = [
    ...(readiness?.checks || []).filter(
      (check) =>
        check.id !== checkoutValidationCheck.id &&
        check.id !== productionReleaseCheck.id &&
        check.id !== checkoutModeCheck.id,
    ),
    ...(standardDirect ? [] : [productionReleaseCheck]),
    checkoutModeCheck,
    checkoutValidationCheck,
  ];
  const releaseSummary = summarizeProductionReadinessChecks(checks);
  return {
    ...readiness,
    canGoLive: releaseSummary.canGoLive,
    codeCanGoLive: releaseSummary.codeCanGoLive,
    summary: releaseSummary.summary,
    checkoutValidation,
    checkoutMode,
    productionRelease,
    checks: releaseSummary.checks,
  };
}
