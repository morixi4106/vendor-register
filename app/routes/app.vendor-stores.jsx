import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const stores = await prisma.vendorStore.findMany({
    orderBy: { createdAt: "desc" },
  });

  return json({ stores });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent !== "delete") {
    return json({ ok: false, message: "不正な操作です。" }, { status: 400 });
  }

  if (!id) {
    return json({ ok: false, message: "店舗IDがありません。" }, { status: 400 });
  }

  await prisma.product.deleteMany({
    where: { vendorStoreId: id },
  });

  await prisma.vendorStore.delete({
    where: { id },
  });

  return redirect("/app/vendor-stores");
};

export default function VendorStoresPage() {
  const { stores } = useLoaderData();
  const navigation = useNavigation();

  const deletingId =
    navigation.formData?.get("intent") === "delete"
      ? String(navigation.formData?.get("id") || "")
      : "";

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
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => {
                const isDeleting = deletingId === store.id;

                return (
                  <tr key={store.id}>
                    <td style={tdStyle}>
                      <a
                        href={`https://oja-immanuel-bacchus.myshopify.com/apps/vendors/${store.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "#0b57d0",
                          textDecoration: "underline",
                          fontWeight: "700",
                        }}
                      >
                        {store.storeName}
                      </a>
                    </td>
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
                    <td style={tdStyle}>
                      <Form
                        method="post"
                        onSubmit={(e) => {
                          const ok = window.confirm(
                            `「${store.storeName}」を削除しますか？`
                          );
                          if (!ok) e.preventDefault();
                        }}
                      >
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={store.id} />
                        <button
                          type="submit"
                          disabled={isDeleting}
                          style={{
                            minWidth: "88px",
                            height: "36px",
                            border: "none",
                            borderRadius: "999px",
                            background: "#c91c1c",
                            color: "#fff",
                            fontWeight: "700",
                            cursor: isDeleting ? "not-allowed" : "pointer",
                            opacity: isDeleting ? 0.7 : 1,
                          }}
                        >
                          {isDeleting ? "削除中..." : "削除"}
                        </button>
                      </Form>
                    </td>
                  </tr>
                );
              })}
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
  whiteSpace: "nowrap",
};