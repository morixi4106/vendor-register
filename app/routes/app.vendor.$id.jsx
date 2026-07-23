import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatMoney } from "../utils/money";
import {
  buildVendorCollectionUrl,
  buildVendorProxyStorefrontUrl,
} from "../utils/vendorCollectionHandles";
import { syncVendorCollectionByStoreId } from "../utils/vendorCollections.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);

  const store = await prisma.vendorStore.findUnique({
    where: { id: params.id },
    include: {
      products: {
        orderBy: { createdAt: "desc" },
      },
      vendorAuth: {
        select: {
          handle: true,
          status: true,
        },
      },
    },
  });

  if (!store) {
    throw new Response("Not Found", { status: 404 });
  }

  return json({ store });
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "sync-collection") {
    return json({ ok: false, error: "Unknown action" }, { status: 400 });
  }

  let result;

  try {
    result = await syncVendorCollectionByStoreId(params.id);
  } catch (error) {
    console.error("vendor collection sync action failed:", error);
    result = {
      ok: false,
      reason: "sync_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return json(
    {
      ok: result.ok,
      collectionSync: result,
    },
    { status: result.ok ? 200 : 422 },
  );
};

export default function VendorDetailPage() {
  const { store } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSyncing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "sync-collection";
  const collectionUrl = store.isPlatformStore && !store.isTestStore
    ? buildVendorCollectionUrl(store.vendorAuth?.handle)
    : buildVendorProxyStorefrontUrl(store.vendorAuth?.handle);

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
        <DetailRow label="Vendor handle" value={store.vendorAuth?.handle || "-"} />
        <DetailRow label="購入者向けページ" value={collectionUrl || "-"} />
        <DetailRow
          label="登録日時"
          value={new Date(store.createdAt).toLocaleString("ja-JP")}
        />
      </div>

      <div
        style={{
          marginTop: "16px",
          background: "#fff",
          border: "1px solid #e5e5e5",
          borderRadius: "12px",
          padding: "20px",
        }}
      >
        <h2 style={{ margin: "0 0 8px" }}>Shopify Collection同期</h2>
        <p style={{ margin: "0 0 14px", color: "#4b5563" }}>
          この店舗の商品を対応Collectionに同期します。Shopify商品IDがある承認済み商品のみ対象です。
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="sync-collection" />
          <button
            type="submit"
            disabled={isSyncing}
            style={{
              border: 0,
              borderRadius: "10px",
              background: "#111827",
              color: "#fff",
              fontWeight: 700,
              padding: "12px 18px",
              cursor: isSyncing ? "not-allowed" : "pointer",
            }}
          >
            {isSyncing ? "同期中..." : "Collectionを同期する"}
          </button>
        </Form>
        {actionData?.collectionSync ? (
          <pre
            style={{
              marginTop: "16px",
              padding: "12px",
              borderRadius: "8px",
              background: actionData.ok ? "#ecfdf5" : "#fef2f2",
              color: "#111827",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {JSON.stringify(actionData.collectionSync, null, 2)}
          </pre>
        ) : null}
      </div>

      <hr style={{ margin: "40px 0" }} />

      <h2>この店舗の商品</h2>

      {store.products.length === 0 ? (
        <p>まだ商品はありません</p>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {store.products.map((product) => (
            <div
              key={product.id}
              style={{
                border: "1px solid #eee",
                borderRadius: "8px",
                padding: "12px",
              }}
            >
              <div style={{ fontWeight: "700" }}>{product.name}</div>
              <div>{formatMoney(product.price, product.costCurrency || "JPY")}</div>
              <div style={{ color: "#6b7280", fontSize: "13px" }}>
                {product.approvalStatus} / {product.shopifyProductId || "Shopify未連携"}
              </div>
            </div>
          ))}
        </div>
      )}
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
