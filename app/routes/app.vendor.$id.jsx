import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);

  const store = await prisma.vendorStore.findUnique({
    where: { id: params.id },
  });

  if (!store) {
    throw new Response("Not Found", { status: 404 });
  }

  return json({ store });
};

export default function VendorDetailPage() {
  const { store } = useLoaderData();

  return (
    <div style={{ padding: "24px", maxWidth: "960px" }}>
      <h1 style={{ fontSize: "28px", fontWeight: "700", marginBottom: "24px" }}>
        店舗詳細
      </h1>

      <div
        style={{
          background: "#fff",
          border: "1px solid #e5e5e5",
          borderRadius: "12px",
          padding: "24px",
        }}
      >
        <DetailRow label="店舗名" value={store.storeName} />
        <DetailRow label="氏名 / 法人名" value={store.ownerName} />
        <DetailRow label="メール" value={store.email} />
        <DetailRow label="電話番号" value={store.phone} />
        <DetailRow label="所在地" value={store.address} />
        <DetailRow label="国" value={store.country} />
        <DetailRow label="カテゴリ" value={store.category} />
        <DetailRow label="備考" value={store.note || "-"} />
        <DetailRow label="年齢確認" value={store.ageCheck} />
        <DetailRow
          label="登録日時"
          value={new Date(store.createdAt).toLocaleString("ja-JP")}
        />
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gap: "16px",
        padding: "14px 0",
        borderBottom: "1px solid #eee",
      }}
    >
      <div style={{ fontWeight: "700" }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}