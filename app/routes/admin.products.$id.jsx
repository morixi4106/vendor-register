import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form } from "@remix-run/react";
import prisma from "../db.server";

const SHOPIFY_SHOP_DOMAIN = "oja-immanuel-bacchus.myshopify.com";
const SHOPIFY_API_VERSION = "2026-01";

async function getOfflineAccessToken() {
  const session = await prisma.session.findFirst({
    where: {
      shop: SHOPIFY_SHOP_DOMAIN,
      isOnline: false,
    },
  });

  if (!session?.accessToken) {
    throw new Error(
      `Offline session not found for shop: ${SHOPIFY_SHOP_DOMAIN}`
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
      vendor: product.vendorStore?.storeName || "Vendor",
      status: "ACTIVE",
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

  return {
    shopifyProductId: createdProduct.id,
  };
}

// loader
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

// action
export const action = async ({ request }) => {
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const productId = String(formData.get("productId") || "");

  if (!productId) {
    return null;
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      vendorStore: true,
    },
  });

  if (!product) {
    throw new Response("商品が見つかりません", { status: 404 });
  }

  if (intent === "approve") {
    if (product.shopifyProductId) {
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

  return null;
};

export default function AdminProductDetail() {
  const { product } = useLoaderData();

  return (
    <div style={{ padding: "40px", maxWidth: "1000px", margin: "0 auto" }}>
      <h1>{product.name}</h1>

      <p style={{ color: "#666" }}>
        店舗: {product.vendorStore?.storeName || "-"}
      </p>

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
            説明項目はまだDB未保存のため、次で追加
          </div>
        </div>

        <div>
          <h3>追加情報</h3>
          <p>カテゴリ: まだ未保存</p>
          <p>画像: まだ未保存</p>
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "20px" }}>
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

          <a href="/admin/products">← 戻る</a>
        </div>
      </div>
    </div>
  );
}