import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Card,
  DataTable,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";

import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import { EU_PRODUCT_ALLOWED_STATUSES } from "../utils/deliveryEligibility.js";
import {
  getProductShippingMethodLabel,
  millimetersToCentimeters,
  PRODUCT_SHIPPING_METHOD,
  validateStoredAirPacketProfile,
} from "../utils/productShippingProfile.js";

function classifyShippingProfile(product) {
  const weight = Number(product.shippingWeightGrams);
  if (!Number.isInteger(weight) || weight <= 0) {
    return { code: "missing_weight", label: "重量未設定", tone: "critical" };
  }

  const airPacketValidation = validateStoredAirPacketProfile(product);
  if (
    product.internationalShippingMethod === PRODUCT_SHIPPING_METHOD.AIR_PACKET &&
    !airPacketValidation.ok
  ) {
    return { code: airPacketValidation.reason, label: "国際条件を要確認", tone: "critical" };
  }
  if (
    EU_PRODUCT_ALLOWED_STATUSES.has(product.productEuStatus) &&
    !airPacketValidation.ok
  ) {
    return { code: "eu_shipping_blocked", label: "EU配送不可", tone: "critical" };
  }
  if (product.internationalShippingMethod === PRODUCT_SHIPPING_METHOD.UNCONFIGURED) {
    return { code: "unconfigured", label: "配送範囲未確認", tone: "warning" };
  }
  if (product.internationalShippingMethod === PRODUCT_SHIPPING_METHOD.AIR_PACKET) {
    return { code: "ready_international", label: "国内・国際対応", tone: "success" };
  }
  return { code: "ready_domestic", label: "国内対応", tone: "info" };
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      approvalStatus: true,
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
      shopifyWeightSyncError: true,
      vendorStore: {
        select: { storeName: true },
      },
    },
    orderBy: [{ approvalStatus: "asc" }, { name: "asc" }],
    take: 501,
  });

  const truncated = products.length > 500;
  const rows = products.slice(0, 500).map((product) => ({
    ...product,
    profileStatus: classifyShippingProfile(product),
  }));

  return json({
    rows,
    truncated,
    summary: {
      total: rows.length,
      ready: rows.filter((row) => row.profileStatus.code.startsWith("ready_")).length,
      needsReview: rows.filter((row) => !row.profileStatus.code.startsWith("ready_")).length,
    },
  });
};

function formatDimensions(product) {
  if (
    !product.shippingLengthMm ||
    !product.shippingWidthMm ||
    !product.shippingHeightMm
  ) {
    return "-";
  }

  return [
    millimetersToCentimeters(product.shippingLengthMm),
    millimetersToCentimeters(product.shippingWidthMm),
    millimetersToCentimeters(product.shippingHeightMm),
  ].join(" × ") + "cm";
}

export default function ProductShippingProfilesPage() {
  const { rows, summary, truncated } = useLoaderData();

  return (
    <Page
      title="商品配送プロフィール"
      subtitle="梱包後重量と国際配送条件を確認します。Shopifyで直接登録した商品もここに表示されます。"
    >
      <BlockStack gap="400">
        <Card>
          <InlineStack gap="600" wrap>
            <BlockStack gap="100">
              <Text as="span" tone="subdued">対象商品</Text>
              <Text as="strong" variant="headingLg">{summary.total}</Text>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="span" tone="subdued">設定済み</Text>
              <Text as="strong" variant="headingLg">{summary.ready}</Text>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="span" tone="subdued">要確認</Text>
              <Text as="strong" variant="headingLg">{summary.needsReview}</Text>
            </BlockStack>
          </InlineStack>
        </Card>

        {truncated ? (
          <Card>
            <Text as="p" tone="caution">
              最初の500件を表示しています。対象商品を絞る機能を追加するまで、本番確認も併用してください。
            </Text>
          </Card>
        ) : null}

        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
            headings={["商品", "店舗", "状態", "重量", "配送範囲", "梱包後サイズ", "操作"]}
            rows={rows.map((product) => [
              product.name,
              product.vendorStore?.storeName || "-",
              <Badge key={`${product.id}-status`} tone={product.profileStatus.tone}>
                {product.profileStatus.label}
              </Badge>,
              product.shippingWeightGrams ? `${product.shippingWeightGrams}g` : "-",
              getProductShippingMethodLabel(product.internationalShippingMethod),
              formatDimensions(product),
              <Link key={`${product.id}-link`} to={`/admin/products/${product.id}`}>
                商品を確認
              </Link>,
            ])}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
