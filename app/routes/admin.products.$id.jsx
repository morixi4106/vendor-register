import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "../db.server";

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

  const createVariables = {
    product: {
      title: product.name,
      descriptionHtml: product.description || "",
      vendor: product.vendorStore?.storeName || "Vendor",
      productType: product.category || "",
      status: "ACTIVE",
      metafields: [
        {
          namespace: "pricing",
          key: "cost_amount",
          type: "number_decimal",
          value: String(product.price ?? 0),
        },
        {
          namespace: "pricing",
          key: "cost_currency",
          type: "single_line_text_field",
          value: "JPY",
        },
        {
          namespace: "pricing",
          key: "duty_category",
          type: "single_line_text_field",
          value: product.category === "スキンケア" ? "cosmetics" : "",
        },
      ],
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
        price: String(product.price ?? 0),
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

  return json({ product });
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

      const { applyProductPrice } = await import("../utils/applyProductPrice.server");
      const result = await applyProductPrice(product.shopifyProductId);

      return json({
        ok: true,
        message: `価格を更新しました（¥${result.oldPrice} → ¥${result.newPrice}）`,
        priceApplied: true,
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
  const { product } = useLoaderData();
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
          <p>価格: ¥{product.price}</p>
          <p>状態: {product.approvalStatus}</p>
          <p>Shopify商品ID: {product.shopifyProductId || "-"}</p>
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