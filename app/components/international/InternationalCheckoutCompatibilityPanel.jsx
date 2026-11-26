import { useEffect, useState } from "react";
import { Badge, BlockStack, Button, InlineStack, Text } from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import {
  InternationalAdminForm as Form,
  useInternationalActionResult,
} from "./InternationalAdminForm.jsx";

const planLabels = {
  PLUS: "Shopify Plus",
  NON_PLUS: "Plus以外",
  UNVERIFIED: "未確認",
};
const pathLabels = {
  STOREFRONT_CART: "Storefront Cart API",
  CHECKOUT_UI_EXTENSION: "購入直前のUI拡張",
  WEB_PIXEL: "Web Pixels",
};
const reasonLabels = {
  ESTIMATES_AND_ROUTE_BINDING_UNVERIFIED: "最終金額・配送経路の対応が未確認",
  PLAN_ONLY_OBSERVED: "プラン条件のみ確認、購入検証は未確認",
  PLUS_REQUIRED: "Shopify Plusが必要",
  PLAN_UNVERIFIED: "店舗プランが未確認",
  ANALYTICS_NOT_INDEPENDENT_CHECKOUT_PROOF:
    "計測イベントのみ、独立した購入検証の証拠には未対応",
};

export default function InternationalCheckoutCompatibilityPanel({
  canInspect,
}) {
  const result = useInternationalActionResult();
  const [now, setNow] = useState(Date.now);
  const report = result?.compatibility;
  useEffect(() => {
    if (!report) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [report]);
  if (!canInspect) return null;
  const current =
    report?.version === "international-checkout-compatibility-v1" &&
    Date.parse(report.expiresAt) > now &&
    Date.parse(report.observedAt) <= now;
  return (
    <section>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="h2" variant="headingMd">
            チェックアウト対応診断
          </Text>
          <Badge tone="warning">購入検証は未確認</Badge>
        </InlineStack>
        <Form>
          <input
            type="hidden"
            name="intent"
            value="inspectInternationalCheckoutCompatibility"
          />
          <Button submit icon={RefreshIcon}>
            対応状況を取得
          </Button>
        </Form>
        {current ? (
          <BlockStack gap="200">
            <Text as="p">
              店舗プラン: {planLabels[report.plan] || "未確認"}
            </Text>
            <Text as="p">
              開発店舗:{" "}
              {report.developmentStore === null
                ? "未確認"
                : report.developmentStore
                  ? "はい"
                  : "いいえ"}
            </Text>
            <Text as="p" tone="subdued">
              確認日時:{" "}
              {new Date(report.observedAt).toLocaleString("ja-JP", {
                timeZone: "Asia/Tokyo",
              })}{" "}
              JST
            </Text>
            {(report.paths || []).map((row) => (
              <Text key={row.id} as="p">
                {pathLabels[row.id] || "未確認"}:{" "}
                {reasonLabels[row.reason] || "未確認"}
              </Text>
            ))}
          </BlockStack>
        ) : (
          <Text as="p" tone="subdued">
            {report
              ? "診断結果は期限切れ、または未確認です。"
              : "診断結果は未取得です。"}
          </Text>
        )}
      </BlockStack>
    </section>
  );
}
