import { json, redirect } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { useState } from "react";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import {
  reconcileShopifyProductCatalog,
  resolveShopifyProductSyncIssue,
} from "../services/shopifyProductSync.server.js";
import {
  backfillMarketplaceCheckoutPolicies,
  syncMarketplaceCheckoutPolicyForProduct,
} from "../services/marketplaceCheckoutGate.server.js";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const [issues, stores, unresolvedCount, resolvedCount] = await Promise.all([
    prisma.shopifyProductSyncIssue.findMany({
      orderBy: [{ status: "asc" }, { lastAttemptAt: "desc" }],
      take: 100,
    }),
    prisma.vendorStore.findMany({
      select: {
        id: true,
        storeName: true,
        vendorAuth: { select: { handle: true } },
      },
      orderBy: { storeName: "asc" },
    }),
    prisma.shopifyProductSyncIssue.count({
      where: { status: "unresolved" },
    }),
    prisma.shopifyProductSyncIssue.count({
      where: { status: "resolved" },
    }),
  ]);

  return json({ issues, stores, unresolvedCount, resolvedCount });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "reconcile_catalog") {
    try {
      const result = await reconcileShopifyProductCatalog(session.shop, {
        limit: 250,
      });
      const checkoutPolicies = await backfillMarketplaceCheckoutPolicies(
        session.shop,
      );
      return json({
        ok: checkoutPolicies.ok,
        message: `確認 ${result.scanned}件 / 新規 ${result.created}件 / 更新 ${result.updated}件 / 要確認 ${result.unresolved}件`,
        checkoutPolicies,
      });
    } catch (error) {
      console.error("Shopify product catalog reconciliation failed:", error);
      return json(
        {
          ok: false,
          message: "Shopify商品一覧の同期に失敗しました。接続状態を確認してください。",
        },
        { status: 500 },
      );
    }
  }

  if (intent === "resolve_issue") {
    const issueId = String(formData.get("issueId") || "").trim();
    const vendorStoreId = String(formData.get("vendorStoreId") || "").trim();

    if (!issueId || !vendorStoreId) {
      return json(
        { ok: false, message: "店舗を選択してください。" },
        { status: 400 },
      );
    }

    const result = await resolveShopifyProductSyncIssue({
      issueId,
      vendorStoreId,
    });

    if (!result.ok) {
      return json(
        { ok: false, message: "商品の店舗紐付けに失敗しました。" },
        { status: 400 },
      );
    }

    await syncMarketplaceCheckoutPolicyForProduct({
      localProductId: result.product.id,
      shopDomain: result.product.shopDomain || session.shop,
    });

    return redirect("/app/shopify-product-sync");
  }

  return json({ ok: false, message: "不正な操作です。" }, { status: 400 });
};

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ja-JP");
}

function reasonLabel(reason) {
  const labels = {
    vendor_label_missing: "Shopifyの販売元が未入力です",
    vendor_label_not_found: "販売元に一致する登録店舗がありません",
    vendor_label_ambiguous: "同名の店舗が複数あり自動判定できません",
    explicit_store_not_found: "指定された店舗IDが見つかりません",
    shopify_price_missing: "Shopify価格を取得できません",
  };
  return labels[reason] || reason || "要確認";
}

function IssueAssignment({ issue, stores, busy }) {
  const [vendorStoreId, setVendorStoreId] = useState("");
  const options = [
    { label: "紐付ける店舗を選択", value: "" },
    ...stores.map((store) => ({
      label: store.vendorAuth?.handle
        ? `${store.storeName} (${store.vendorAuth.handle})`
        : store.storeName,
      value: store.id,
    })),
  ];

  return (
    <Form method="post">
      <input type="hidden" name="intent" value="resolve_issue" />
      <input type="hidden" name="issueId" value={issue.id} />
      <input type="hidden" name="vendorStoreId" value={vendorStoreId} />
      <InlineStack gap="300" blockAlign="end" wrap>
        <div style={{ minWidth: "280px", flex: "1 1 320px" }}>
          <Select
            label="販売店舗"
            options={options}
            value={vendorStoreId}
            onChange={setVendorStoreId}
          />
        </div>
        <Button submit variant="primary" disabled={!vendorStoreId || busy}>
          店舗を確定
        </Button>
      </InlineStack>
    </Form>
  );
}

export default function ShopifyProductSyncPage() {
  const { issues, stores, unresolvedCount, resolvedCount } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const unresolvedIssues = issues.filter((issue) => issue.status === "unresolved");
  const resolvedIssues = issues.filter((issue) => issue.status === "resolved");

  return (
    <Page
      title="Shopify商品同期"
      subtitle="Shopify管理画面から直接登録した商品を、販売店舗と売上台帳へ紐付けます。"
      primaryAction={{
        content: busy ? "確認中" : "Shopify商品を再確認",
        disabled: busy,
        onAction: () => document.getElementById("catalog-reconcile-form")?.requestSubmit(),
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Form id="catalog-reconcile-form" method="post">
              <input type="hidden" name="intent" value="reconcile_catalog" />
            </Form>

            {actionData?.message ? (
              <div
                role="status"
                style={{
                  padding: "12px 14px",
                  border: `1px solid ${actionData.ok ? "#86efac" : "#fecaca"}`,
                  borderRadius: "8px",
                  background: actionData.ok ? "#f0fdf4" : "#fef2f2",
                  color: actionData.ok ? "#166534" : "#991b1b",
                }}
              >
                {actionData.message}
              </div>
            ) : null}

            <Card>
              <InlineStack gap="600" wrap>
                <BlockStack gap="100">
                  <Text as="span" tone="subdued">要確認</Text>
                  <Text as="strong" variant="headingXl">{unresolvedCount}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="span" tone="subdued">同期済み</Text>
                  <Text as="strong" variant="headingXl">{resolvedCount}</Text>
                </BlockStack>
              </InlineStack>
            </Card>

            {unresolvedIssues.length === 0 ? (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">要確認の商品はありません</Text>
                  <Text as="p" tone="subdued">
                    Shopifyの「販売元」には、登録済み店舗の店舗名またはハンドルを入力してください。
                  </Text>
                </BlockStack>
              </Card>
            ) : (
              unresolvedIssues.map((issue) => (
                <Card key={issue.id}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="start" wrap>
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingMd">
                          {issue.productTitle || "名称未取得の商品"}
                        </Text>
                        <Text as="p" tone="subdued">
                          販売元: {issue.vendorLabel || "未入力"}
                        </Text>
                      </BlockStack>
                      <Badge tone="warning">要確認</Badge>
                    </InlineStack>
                    <Text as="p">{reasonLabel(issue.reason)}</Text>
                    <Text as="p" tone="subdued">
                      最終確認: {formatDateTime(issue.lastAttemptAt)}
                    </Text>
                    <IssueAssignment issue={issue} stores={stores} busy={busy} />
                  </BlockStack>
                </Card>
              ))
            )}

            {resolvedIssues.length > 0 ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">最近の同期済み商品</Text>
                  {resolvedIssues.slice(0, 20).map((issue) => (
                    <InlineStack key={issue.id} align="space-between" wrap>
                      <Text as="span">{issue.productTitle || issue.shopifyProductId}</Text>
                      <Badge tone="success">同期済み</Badge>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
