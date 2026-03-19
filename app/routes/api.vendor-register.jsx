import { json, redirect } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation } from "@remix-run/react";
import prisma from "../db.server";

export const loader = async () => {
  const stores = await prisma.vendorStore.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });

  return json({ stores });
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent !== "delete") {
    return json(
      { ok: false, message: "不正な操作です。" },
      { status: 400 }
    );
  }

  if (!id) {
    return json(
      { ok: false, message: "店舗IDがありません。" },
      { status: 400 }
    );
  }

  await prisma.product.deleteMany({
    where: {
      vendorStoreId: id,
    },
  });

  await prisma.vendorStore.delete({
    where: {
      id,
    },
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
    <div style={{ padding: "32px" }}>
      <h1
        style={{
          margin: "0 0 24px",
          fontSize: "48px",
          fontWeight: 800,
          color: "#111",
        }}
      >
        店舗一覧
      </h1>

      {stores.length === 0 ? (
        <div
          style={{
            padding: "24px",
            background: "#f6f6f6",
            borderRadius: "12px",
            fontSize: "18px",
          }}
        >
          まだ店舗登録はありません
        </div>
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
              <tr style={{ background: "#f3f3f3" }}>
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
                  <tr key={store.id} style={{ borderTop: "1px solid #e5e5e5" }}>
                    <td style={tdStyle}>
                      <Link
                        to={`/app/vendor/${store.id}`}
                        style={{
                          color: "#005bd3",
                          textDecoration: "none",
                          fontWeight: 700,
                        }}
                      >
                        {store.storeName}
                      </Link>
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
                          if (!ok) {
                            e.preventDefault();
                          }
                        }}
                      >
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={store.id} />
                        <button
                          type="submit"
                          disabled={isDeleting}
                          style={{
                            minWidth: "96px",
                            height: "40px",
                            border: "none",
                            borderRadius: "999px",
                            background: "#c91c1c",
                            color: "#fff",
                            fontWeight: 700,
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
  padding: "16px",
  textAlign: "left",
  fontSize: "16px",
  fontWeight: 800,
  color: "#111",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "16px",
  fontSize: "16px",
  color: "#111",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
};