import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const stores = await prisma.vendorStore.findMany({
    orderBy: { createdAt: "desc" },
  });

  return json({ stores });
};

export default function VendorStoresPage() {
  const { stores } = useLoaderData();

  return (
    <div style={{ padding: "24px" }}>
      <h1 style={{ fontSize: "28px", fontWeight: "700", marginBottom: "20px" }}>
        店舗一覧
      </h1>

      {stores.length === 0 ? (
        <p>まだ店舗登録はありません。</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              background: "#fff",
            }}
          >
            <thead>
              <tr>
                <th style={thStyle}>店舗名</th>
                <th style={thStyle}>氏名 / 法人名</th>
                <th style={thStyle}>メール</th>
                <th style={thStyle}>電話番号</th>
                <th style={thStyle}>所在地</th>
                <th style={thStyle}>国</th>
                <th style={thStyle}>カテゴリ</th>
                <th style={thStyle}>年齢確認</th>
                <th style={thStyle}>登録日時</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id}>
                  <td style={tdStyle}>{store.storeName}</td>
                  <td style={tdStyle}>{store.ownerName}</td>
                  <td style={tdStyle}>{store.email}</td>
                  <td style={tdStyle}>{store.phone}</td>
                  <td style={tdStyle}>{store.address}</td>
                  <td style={tdStyle}>{store.country}</td>
                  <td style={tdStyle}>{store.category}</td>
                  <td style={tdStyle}>{store.ageCheck}</td>
                  <td style={tdStyle}>
                    {new Date(store.createdAt).toLocaleString("ja-JP")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "12px",
  borderBottom: "1px solid #ddd",
  background: "#f7f7f7",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "12px",
  borderBottom: "1px solid #eee",
  verticalAlign: "top",
};