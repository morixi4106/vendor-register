import { json } from "@remix-run/node";
import { useLoaderData, Form } from "@remix-run/react";
import prisma from "../db.server";

// 一覧取得
export const loader = async () => {
  const products = await prisma.product.findMany({
    where: {
      approvalStatus: "pending",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return json({ products });
};

// 承認 / 却下
export const action = async ({ request }) => {
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const productId = String(formData.get("productId") || "");

  if (!productId) return null;

  if (intent === "approve") {
    await prisma.product.update({
      where: { id: productId },
      data: { approvalStatus: "approved" },
    });
  }

  if (intent === "reject") {
    await prisma.product.update({
      where: { id: productId },
      data: { approvalStatus: "rejected" },
    });
  }

  return null;
};

export default function AdminProducts() {
  const { products } = useLoaderData();

  return (
    <div style={{ padding: "40px" }}>
      <h1>商品承認管理</h1>

      {products.length === 0 && <p>申請中の商品はありません</p>}

      <div style={{ display: "grid", gap: "20px" }}>
        {products.map((product) => (
          <div
            key={product.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: "10px",
              padding: "20px",
            }}
          >
            <h3>{product.name}</h3>
            <p>価格: ¥{product.price}</p>

            {/* 👇 商品説明 */}
            <p style={{ marginTop: "10px", whiteSpace: "pre-wrap" }}>
              {product.description || "説明なし"}
            </p>

            {/* 👇 画像（あれば） */}
            {product.imageUrl && (
              <img
                src={product.imageUrl}
                alt={product.name}
                style={{ width: "200px", marginTop: "10px" }}
              />
            )}

            <div style={{ marginTop: "15px", display: "flex", gap: "10px" }}>
              {/* 承認 */}
              <Form method="post">
                <input type="hidden" name="intent" value="approve" />
                <input type="hidden" name="productId" value={product.id} />
                <button type="submit">承認</button>
              </Form>

              {/* 却下 */}
              <Form method="post">
                <input type="hidden" name="intent" value="reject" />
                <input type="hidden" name="productId" value={product.id} />
                <button type="submit">却下</button>
              </Form>

              <a href={`/admin/products/${product.id}`}>
                詳細
              </a>

              {/* Shopify確認（あとで使う） */}
              <a
                href={`https://admin.shopify.com/store/oja-immanuel-bacchus/products`}
                target="_blank"
                rel="noreferrer"
              >
                Shopifyで確認
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}