import { resolveDutyCategory } from "../utils/dutyCategory";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "../db.server";
import { getFxRateToJpy } from "../utils/fxRates.server";
import { calculatePriceBreakdown } from "../utils/priceCalculator";

const SHOPIFY_SHOP_DOMAIN = "b30ize-1a.myshopify.com";
const SHOPIFY_API_VERSION = "2026-01";

async function getOfflineAccessToken() {
  const offlineSessionId = `offline_${SHOPIFY_SHOP_DOMAIN}`;

  const session = await prisma.session.findUnique({
    where: {
      id: offlineSessionId,
    },
  });

  if (!session?.accessToken) {
    throw new Error(
      `Offline session not found for session id: ${offlineSessionId}`
    );
  }

  return session.accessToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getOfflineAccessToken();

  const res = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL request failed: ${res.status} ${JSON.stringify(data)}`
    );
  }

  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

async function createShopifyProductFromDbProduct(product) {
  const createMutation = `
    mutation CreateProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          title
          status
          descriptionHtml
          variants(first: 1) {
            nodes {
              id
              price
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const dutyCategory = resolveDutyCategory(product.category);

  const metafields = [
    {
      namespace: "pricing",
      key: "cost_amount",
      type: "number_decimal",
      value: String(product.costAmount ?? product.price ?? 0),
    },
    {
      namespace: "pricing",
      key: "cost_currency",
      type: "single_line_text_field",
      value: product.costCurrency || "JPY",
    },
  ];

  if (dutyCategory) {
    metafields.push({
      namespace: "pricing",
      key: "duty_category",
      type: "single_line_text_field",
      value: dutyCategory,
    });
  }

  const createVariables = {
    product: {
      title: product.name,
      descriptionHtml: product.description || "",
      vendor: product.vendorStore?.storeName || "Vendor",
      productType: product.category || "",
      status: "ACTIVE",
      metafields,
    },
  };

  const createResult = await shopifyGraphQL(createMutation, createVariables);
  const createPayload = createResult?.productCreate;

  if (!createPayload) {
    throw new Error("Shopify productCreate response is empty");
  }

  if (createPayload.userErrors?.length) {
    throw new Error(
      `productCreate userErrors: ${JSON.stringify(createPayload.userErrors)}`
    );
  }

  const createdProduct = createPayload.product;
  const createdVariant = createdProduct?.variants?.nodes?.[0];

  if (!createdProduct?.id) {
    throw new Error("Shopify product ID was not returned");
  }

  if (!createdVariant?.id) {
    throw new Error("Shopify initial variant ID was not returned");
  }

  const updateVariantMutation = `
    mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product {
          id
        }
        productVariants {
          id
          price
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const updateVariantVariables = {
    productId: createdProduct.id,
    variants: [
      {
        id: createdVariant.id,
        price: String(product.costAmount ?? product.price ?? 0),
      },
    ],
  };

  const updateVariantResult = await shopifyGraphQL(
    updateVariantMutation,
    updateVariantVariables
  );

  const updateVariantPayload = updateVariantResult?.productVariantsBulkUpdate;

  if (!updateVariantPayload) {
    throw new Error("Shopify productVariantsBulkUpdate response is empty");
  }

  if (updateVariantPayload.userErrors?.length) {
    throw new Error(
      `productVariantsBulkUpdate userErrors: ${JSON.stringify(
        updateVariantPayload.userErrors
      )}`
    );
  }

  if (product.imageUrl) {
    const createMediaMutation = `
      mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            alt
            mediaContentType
            status
          }
          mediaUserErrors {
            field
            message
          }
          product {
            id
          }
        }
      }
    `;

    const createMediaVariables = {
      productId: createdProduct.id,
      media: [
        {
          alt: product.name || "Product image",
          mediaContentType: "IMAGE",
          originalSource: product.imageUrl,
        },
      ],
    };

    const createMediaResult = await shopifyGraphQL(
      createMediaMutation,
      createMediaVariables
    );

    const createMediaPayload = createMediaResult?.productCreateMedia;

    if (!createMediaPayload) {
      throw new Error("Shopify productCreateMedia response is empty");
    }

    if (createMediaPayload.mediaUserErrors?.length) {
      throw new Error(
        `productCreateMedia mediaUserErrors: ${JSON.stringify(
          createMediaPayload.mediaUserErrors
        )}`
      );
    }
  }

  const { applyProductPrice } = await import("../utils/applyProductPrice.server");
  await applyProductPrice(createdProduct.id);

  return {
    shopifyProductId: createdProduct.id,
  };
}

export const loader = async ({ params }) => {
  const id = String(params.id || "");

  if (!id) {
    throw new Response("IDがありません", { status: 400 });
  }

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      vendorStore: true,
    },
  });

  if (!product) {
    throw new Response("商品が見つかりません", { status: 404 });
  }

  let priceBreakdown = null;

  try {
    const costAmount = Number(product.costAmount ?? product.price ?? 0);
    const costCurrency = product.costCurrency || "JPY";
    const dutyCategory = resolveDutyCategory(product.category);

    const dutyRateMap = {
      cosmetics: 0.2,
    };

    const dutyRate = dutyRateMap[dutyCategory] ?? 0;

    const fxRate = await getFxRateToJpy(costCurrency);

    const shopSettingsData = await shopifyGraphQL(`
      query ReadShopPricingSettings {
        shop {
          marginRate: metafield(namespace: "global_pricing", key: "default_margin_rate") { value }
          paymentFeeRate: metafield(namespace: "global_pricing", key: "payment_fee_rate") { value }
          paymentFeeFixed: metafield(namespace: "global_pricing", key: "payment_fee_fixed") { value }
          bufferRate: metafield(namespace: "global_pricing", key: "buffer_rate") { value }
        }
      }
    `);

    const marginRate = Number(shopSettingsData?.shop?.marginRate?.value ?? 0.1);
    const paymentFeeRate = Number(shopSettingsData?.shop?.paymentFeeRate?.value ?? 0.04);
    const paymentFeeFixed = Number(shopSettingsData?.shop?.paymentFeeFixed?.value ?? 50);
    const bufferRate = Number(shopSettingsData?.shop?.bufferRate?.value ?? 0.1);

    priceBreakdown = calculatePriceBreakdown({
      costAmount,
      fxRate,
      dutyRate,
      marginRate,
      paymentFeeRate,
      paymentFeeFixed,
      bufferRate,
    });
  } catch (e) {
    console.error("price breakdown error:", e);
  }

  let shopifyPrice = null;
  let needsReconnect = false;
  let shopifyError = null;

  if (product.shopifyProductId) {
    try {
      const shopifyData = await shopifyGraphQL(
        `
          query ReadProductPrice($id: ID!) {
            product(id: $id) {
              id
              variants(first: 1) {
                nodes {
                  id
                  price
                }
              }
            }
          }
        `,
        {
          id: product.shopifyProductId,
        }
      );

      shopifyPrice =
        shopifyData?.product?.variants?.nodes?.[0]?.price || null;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "不明なエラーです";

      shopifyError = message;

      if (
        message.includes("Invalid API key or access token") ||
        message.includes("401")
      ) {
        needsReconnect = true;
      } else {
        throw error;
      }
    }
  }

  return json({ product, shopifyPrice, needsReconnect, shopifyError, priceBreakdown });
};

export const action = async ({ request }) => {
  try {
    const formData = await request.formData();

    const intent = String(formData.get("intent") || "");
    const productId = String(formData.get("productId") || "");

    if (!productId) {
      return json({ ok: false, error: "productId がありません" }, { status: 400 });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        vendorStore: true,
      },
    });

    if (!product) {
      return json({ ok: false, error: "商品が見つかりません" }, { status: 404 });
    }

    if (intent === "apply-price") {
      if (!product.shopifyProductId) {
        return json(
          { ok: false, error: "Shopify商品IDがありません" },
          { status: 400 }
        );
      }

      const refreshRes = await fetch(
        `${new URL(request.url).origin}/api/refresh-fx`,
        {
          method: "POST",
        }
      );

      const refreshData = await refreshRes.json();

      if (!refreshRes.ok || !refreshData?.ok) {
        return json(
          {
            ok: false,
            error: refreshData?.error || "為替更新に失敗しました",
          },
          { status: 500 }
        );
      }

      const { applyProductPrice } = await import("../utils/applyProductPrice.server");
      const result = await applyProductPrice(product.shopifyProductId);

      return json({
        ok: true,
        message: `為替更新後に価格を更新しました（USD/JPY=${refreshData.fxRate.rate}）（¥${result.oldPrice} → ¥${result.newPrice}）`,
        priceApplied: true,
        fxRate: refreshData.fxRate,
        result,
      });
    }

    if (intent === "approve") {
      if (product.shopifyProductId) {
        const updateMutation = `
          mutation UpdateProductStatus($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                status
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const updateResult = await shopifyGraphQL(updateMutation, {
          input: {
            id: product.shopifyProductId,
            title: product.name,
            descriptionHtml: product.description || "",
            productType: product.category || "",
            status: "ACTIVE",
          },
        });

        const updatePayload = updateResult?.productUpdate;

        if (!updatePayload) {
          throw new Error("Shopify productUpdate response is empty");
        }

        if (updatePayload.userErrors?.length) {
          throw new Error(
            `productUpdate userErrors: ${JSON.stringify(updatePayload.userErrors)}`
          );
        }

        await prisma.product.update({
          where: { id: productId },
          data: {
            approvalStatus: "approved",
          },
        });

        return redirect(`/admin/products/${productId}`);
      }

      const result = await createShopifyProductFromDbProduct(product);

      await prisma.product.update({
        where: { id: productId },
        data: {
          approvalStatus: "approved",
          shopifyProductId: result.shopifyProductId,
        },
      });

      return redirect(`/admin/products/${productId}`);
    }

    if (intent === "reject") {
      await prisma.product.update({
        where: { id: productId },
        data: {
          approvalStatus: "rejected",
        },
      });

      return redirect(`/admin/products/${productId}`);
    }

    return json({ ok: false, error: "不明な intent です" }, { status: 400 });
  } catch (error) {
    console.error("admin approve error:", error);

    const message =
      error instanceof Error ? error.message : "不明なエラーです";

    const needsReconnect =
      message.includes("Invalid API key or access token") ||
      message.includes("401");

    return json(
      {
        ok: false,
        error: message,
        needsReconnect,
      },
      { status: 500 }
    );
  }
};

export default function AdminProductDetail() {
  const { product, shopifyPrice, needsReconnect, shopifyError } = useLoaderData();
  const actionData = useActionData();

  return (
    <div style={{ padding: "40px", maxWidth: "1000px", margin: "0 auto" }}>
      <h1>{product.name}</h1>

      <p style={{ color: "#666" }}>
        店舗: {product.vendorStore?.storeName || "-"}
      </p>

      {actionData?.error ? (
        <div
          style={{
            marginTop: "20px",
            marginBottom: "20px",
            padding: "14px",
            borderRadius: "8px",
            background: "#fff1f2",
            border: "1px solid #fecdd3",
            color: "#9f1239",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong>エラー:</strong>
          <div style={{ marginTop: "8px" }}>{actionData.error}</div>

          {actionData?.needsReconnect ? (
            <div style={{ marginTop: "14px" }}>
              <div style={{ marginBottom: "10px" }}>
                Shopify接続が切れています。再接続してください。
              </div>

              <Form method="post" action="/admin/shopify-reconnect">
                <input type="hidden" name="returnTo" value={`/admin/products/${product.id}`} />
                <button
                  type="submit"
                  style={{
                    height: "40px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: "1px solid #111827",
                    background: "#111827",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Shopify再接続
                </button>
              </Form>
            </div>
          ) : null}
        </div>
      ) : null}

      {needsReconnect ? (
        <div
          style={{
            marginTop: "20px",
            marginBottom: "20px",
            padding: "14px",
            borderRadius: "8px",
            background: "#fff7ed",
            border: "1px solid #fdba74",
            color: "#9a3412",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong>Shopify接続エラー:</strong>
          <div style={{ marginTop: "8px" }}>
            {shopifyError || "Shopify接続が切れています。再接続してください。"}
          </div>

          <div style={{ marginTop: "14px" }}>
            <Form method="post" action="/admin/shopify-reconnect">
              <input
                type="hidden"
                name="returnTo"
                value={`/admin/products/${product.id}`}
              />
              <button
                type="submit"
                style={{
                  height: "40px",
                  padding: "0 14px",
                  borderRadius: "8px",
                  border: "1px solid #111827",
                  background: "#111827",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Shopify再接続
              </button>
            </Form>
          </div>
        </div>
      ) : null}

      {actionData?.ok && actionData?.message ? (
        <div
          style={{
            marginTop: "20px",
            marginBottom: "20px",
            padding: "14px",
            borderRadius: "8px",
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            color: "#065f46",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong>成功:</strong>
          <div style={{ marginTop: "8px" }}>{actionData.message}</div>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: "20px", marginTop: "20px" }}>
        <div>
          <h3>基本情報</h3>
          {priceBreakdown ? (
            <div style={{ marginTop: "10px", padding: "10px", background: "#f9fafb", borderRadius: "8px" }}>
              <p>為替レート: {priceBreakdown.input.fxRate.toFixed(4)}</p>
              <p>関税率: {(priceBreakdown.input.dutyRate * 100).toFixed(1)}%</p>
              <p>原価(JPY換算): ¥{Math.round(priceBreakdown.breakdown.costFx)}</p>
              <p>関税込原価: ¥{Math.round(priceBreakdown.breakdown.landed)}</p>
              <p>安全原価: ¥{Math.round(priceBreakdown.breakdown.safeCost)}</p>
              <p>目標価格: ¥{Math.round(priceBreakdown.breakdown.target)}</p>
              <p><strong>最終価格: ¥{priceBreakdown.finalPrice}</strong></p>
            </div>
          ) : null}
          <p>
            原価: {product.costCurrency || "JPY"} {product.costAmount ?? product.price}
          </p>
          <p>
            基準販売価格（JPY）: {typeof product.price === "number" ? `¥${product.price}` : "-"}
          </p>
          <p>
            Shopify基準価格: {shopifyPrice ? `¥${shopifyPrice}` : "-"}
          </p>
          <p>状態: {product.approvalStatus}</p>
          <p>Shopify商品ID: {product.shopifyProductId || "-"}</p>
          <p style={{ color: "#6b7280", fontSize: "14px", marginTop: "8px" }}>
            ※ 原価・通貨・関税設定をもとに基準販売価格（JPY）が計算されます。
          </p>
        </div>

        <div>
          <h3>商品説明</h3>
          <div style={{ whiteSpace: "pre-wrap" }}>
            {product.description || "説明なし"}
          </div>
        </div>

        <div>
          <h3>追加情報</h3>
          <p>カテゴリ: {product.category || "未設定"}</p>
          <p>画像URL: {product.imageUrl || "なし"}</p>
        </div>

        {product.imageUrl ? (
          <div>
            <h3>商品画像</h3>
            <img
              src={product.imageUrl}
              alt={product.name}
              style={{
                width: "320px",
                maxWidth: "100%",
                border: "1px solid #e5e7eb",
                borderRadius: "12px",
                display: "block",
              }}
            />
          </div>
        ) : null}

        <div style={{ display: "flex", gap: "10px", marginTop: "20px", flexWrap: "wrap" }}>
          <Form method="post">
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="productId" value={product.id} />
            <button type="submit">承認する</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="reject" />
            <input type="hidden" name="productId" value={product.id} />
            <button type="submit">却下する</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="apply-price" />
            <input type="hidden" name="productId" value={product.id} />
            <button
              type="submit"
              style={{
                height: "40px",
                padding: "0 14px",
                borderRadius: "8px",
                border: "1px solid #2563eb",
                background: "#2563eb",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              価格更新
            </button>
          </Form>

          <a href="/admin/products">← 戻る</a>
        </div>
      </div>
    </div>
  );
}