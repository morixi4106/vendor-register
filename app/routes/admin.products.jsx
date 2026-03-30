import { json } from "@remix-run/node";
import { Form, Link, Outlet, useLoaderData, useLocation } from "@remix-run/react";
import prisma from "../db.server";

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

export const action = async ({ request }) => {
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const productId = String(formData.get("productId") || "");

  if (!productId) {
    return null;
  }

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
  const location = useLocation();

  const isDetailPage = location.pathname !== "/admin/products";

  if (isDetailPage) {
    return <Outlet />;
  }

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

            <p style={{ marginTop: "10px", whiteSpace: "pre-wrap" }}>
              {product.description || "説明なし"}
            </p>

            {product.imageUrl && (
              <img
                src={product.imageUrl}
                alt={product.name}
                style={{ width: "200px", marginTop: "10px" }}
              />
            )}

            <div style={{ marginTop: "15px", display: "flex", gap: "10px" }}>
              <Form method="post">
                <input type="hidden" name="intent" value="approve" />
                <input type="hidden" name="productId" value={product.id} />
                <button type="submit">承認</button>
              </Form>

              <Form method="post">
                <input type="hidden" name="intent" value="reject" />
                <input type="hidden" name="productId" value={product.id} />
                <button type="submit">却下</button>
              </Form>

              <Link to={`/admin/products/${product.id}`}>詳細</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}