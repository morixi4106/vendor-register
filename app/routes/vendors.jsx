import { json } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import { authenticate } from "../shopify.server";

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-ぁ-んァ-ヶ一-龠ー]/g, "");
}

export async function loader({ request }) {
  const { admin } = await authenticate.public.appProxy(request).catch(() => ({}));

  if (!admin) {
    return json({ vendors: [] });
  }

  const response = await admin.graphql(`
    query {
      customers(first: 100, query: "tag:vendor") {
        edges {
          node {
            id
            firstName
            lastName
            email
            metafield(namespace: "vendor", key: "store_name") {
              value
            }
          }
        }
      }
    }
  `);

  const data = await response.json();

  const vendors =
    data?.data?.customers?.edges
      ?.map(({ node }) => {
        const storeName =
          node?.metafield?.value ||
          [node?.lastName, node?.firstName].filter(Boolean).join(" ").trim() ||
          node?.email ||
          "店舗名未設定";

        return {
          id: node.id,
          storeName,
          slug: slugify(storeName),
        };
      })
      .filter((vendor) => vendor.storeName) || [];

  return json({ vendors });
}

export default function Vendors() {
  const { vendors } = useLoaderData();

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "40px" }}>
      <h1 style={{ fontSize: "42px", fontWeight: "800", marginBottom: "40px" }}>
        店舗一覧
      </h1>

      {vendors.length === 0 ? (
        <p style={{ fontSize: "18px" }}>まだ店舗が登録されていません。</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))",
            gap: "24px",
          }}
        >
          {vendors.map((vendor) => (
            <Link
              key={vendor.id}
              to={`/vendors/${vendor.slug}`}
              style={{
                border: "1px solid #ddd",
                padding: "20px",
                borderRadius: "12px",
                textDecoration: "none",
                color: "#111",
                fontWeight: "700",
                background: "#fff",
              }}
            >
              {vendor.storeName}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}