import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function InventoryQuantityForm({ product }) {
  const [value, setValue] = useState(product.inventoryInputValue || "");

  const adjustValue = (delta) => {
    const currentValue = value === "" ? 0 : Number(value);
    const normalizedValue =
      Number.isInteger(currentValue) && currentValue >= 0 ? currentValue : 0;
    const nextValue = Math.max(0, normalizedValue + delta);
    setValue(String(nextValue));
  };

  return (
    <Form method="post" className="vendor-inventory-control">
      <input type="hidden" name="intent" value="updateInventory" />
      <input type="hidden" name="productId" value={product.id} />
      <button
        aria-label={`${product.name}の在庫を1減らす`}
        className="vendor-inventory-control__step"
        onClick={() => adjustValue(-1)}
        type="button"
      >
        -
      </button>
      <input
        aria-label={`${product.name}の在庫数`}
        className="vendor-inventory-control__input"
        inputMode="numeric"
        min="0"
        name="inventoryQuantity"
        onChange={(event) => setValue(event.target.value)}
        step="1"
        type="number"
        value={value}
      />
      <button
        aria-label={`${product.name}の在庫を1増やす`}
        className="vendor-inventory-control__step"
        onClick={() => adjustValue(1)}
        type="button"
      >
        +
      </button>
      <button className="vendor-shell__button" type="submit">
        保存
      </button>
    </Form>
  );
}

export const loader = async ({ request }) => {
  const {
    getVendorPublicContext,
    listVendorProducts,
    requireVendorContext,
  } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  const products = await listVendorProducts(store.id, {});
  const publicCount = products.filter(
    (product) => product.statusLabel === "公開済み"
  ).length;
  const pendingCount = products.filter(
    (product) => product.approvalLabel === "申請中"
  ).length;

  return json({
    ...getVendorPublicContext(vendor, store),
    products,
    stats: {
      total: products.length,
      public: publicCount,
      pending: pendingCount,
    },
  });
};

export const action = async ({ request }) => {
  const {
    requireVendorContext,
    updateVendorProductInventory,
  } = await import("../services/vendorManagement.server");
  const { store } = await requireVendorContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "updateInventory") {
    return json(
      {
        ok: false,
        error: "未対応の操作です。",
      },
      { status: 400 },
    );
  }

  const result = await updateVendorProductInventory({
    storeId: store.id,
    productId: formData.get("productId"),
    inventoryQuantity: formData.get("inventoryQuantity"),
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        error: result.error,
      },
      { status: result.status || 400 },
    );
  }

  return json({
    ok: true,
    message: `${result.product.name} の在庫数を保存しました。`,
  });
};

export default function VendorInventoryPage() {
  const actionData = useActionData();
  const { store, products, stats } = useLoaderData();

  return (
    <VendorManagementShell activeItem="inventory" storeName={store.storeName} title="在庫">
      {actionData?.error ? (
        <section className="vendor-card">
          <div className="vendor-note vendor-note--danger">{actionData.error}</div>
        </section>
      ) : null}
      {actionData?.message ? (
        <section className="vendor-card">
          <div className="vendor-note">{actionData.message}</div>
        </section>
      ) : null}

      <section className="vendor-card">
        <h2 className="vendor-section-title">在庫一覧</h2>
        <p className="vendor-section-subtitle">
          登録済み商品の在庫数を更新できます。数値欄はキーボードの上下キーでも増減できます。
        </p>

        <div className="vendor-description-list">
          <div className="vendor-description-row">
            <div className="vendor-description-term">登録商品</div>
            <div className="vendor-description-value">{stats.total}件</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">公開済み</div>
            <div className="vendor-description-value">{stats.public}件</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">確認中</div>
            <div className="vendor-description-value">{stats.pending}件</div>
          </div>
        </div>

        <div className="vendor-actions-row" style={{ marginTop: "16px" }}>
          <Link className="vendor-shell__button" to="/vendor/products">
            商品管理を開く
          </Link>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">商品別の在庫確認</h2>
        <p className="vendor-section-subtitle">
          在庫が未設定または0の商品は、購入できない状態として扱います。
        </p>

        <div className="vendor-table-wrap">
          <table className="vendor-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>カテゴリ</th>
                <th>価格</th>
                <th>現在の在庫数</th>
                <th>在庫状態</th>
                <th>公開状態</th>
                <th>確認状況</th>
                <th>最終更新</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan="8" style={{ color: "#6b7280" }}>
                    まだ商品が登録されていません。商品を登録すると、ここに在庫確認対象として表示されます。
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id}>
                    <td className="vendor-table__name">{product.name}</td>
                    <td>{product.category}</td>
                    <td>{product.priceLabel}</td>
                    <td>
                      <InventoryQuantityForm
                        key={`${product.id}:${product.inventoryInputValue}`}
                        product={product}
                      />
                    </td>
                    <td>
                      <span className={`vendor-shell__badge vendor-shell__badge--${product.stockStatusTone}`}>
                        {product.stockStatusLabel}
                      </span>
                      <span className="vendor-table__meta">{product.stockLabel}</span>
                    </td>
                    <td>
                      <span className={`vendor-shell__badge vendor-shell__badge--${product.statusTone}`}>
                        {product.statusLabel}
                      </span>
                    </td>
                    <td>
                      <span className={`vendor-shell__badge vendor-shell__badge--${product.approvalTone}`}>
                        {product.approvalLabel}
                      </span>
                    </td>
                    <td>{product.updatedAtLabel}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </VendorManagementShell>
  );
}
