import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function InventoryQuantityInput({ onChange, product, value }) {
  const adjustValue = (delta) => {
    const currentValue = value === "" ? 0 : Number(value);
    const normalizedValue =
      Number.isInteger(currentValue) && currentValue >= 0 ? currentValue : 0;
    const nextValue = Math.max(0, normalizedValue + delta);
    onChange(product.id, String(nextValue));
  };

  return (
    <div className="vendor-inventory-control">
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
        name={`inventoryQuantity:${product.id}`}
        onChange={(event) => onChange(product.id, event.target.value)}
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
    </div>
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

  const productIds = formData
    .getAll("productId")
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (productIds.length === 0) {
    return json(
      {
        ok: false,
        error: "保存する商品がありません。",
      },
      { status: 400 },
    );
  }

  const warnings = [];

  for (const productId of productIds) {
    const result = await updateVendorProductInventory({
      storeId: store.id,
      productId,
      inventoryQuantity: formData.get(`inventoryQuantity:${productId}`),
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

    if (result.warning) {
      warnings.push(`${result.product.name}: ${result.warning}`);
    }
  }

  return json({
    ok: true,
    message: `${productIds.length}件の在庫数を保存しました。`,
    warning: warnings.length > 0 ? warnings.join(" / ") : null,
  });
};

export default function VendorInventoryPage() {
  const actionData = useActionData();
  const { store, products, stats } = useLoaderData();
  const initialInventoryValues = useMemo(
    () =>
      Object.fromEntries(
        products.map((product) => [
          product.id,
          String(product.inventoryInputValue ?? ""),
        ]),
      ),
    [products],
  );
  const [inventoryValues, setInventoryValues] = useState(initialInventoryValues);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setInventoryValues(initialInventoryValues);
  }, [initialInventoryValues]);

  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return products;

    return products.filter((product) =>
      String(product.name || "").toLowerCase().includes(normalizedQuery),
    );
  }, [products, query]);

  const updateInventoryValue = (productId, nextValue) => {
    setInventoryValues((currentValues) => ({
      ...currentValues,
      [productId]: nextValue,
    }));
  };

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
      {actionData?.warning ? (
        <section className="vendor-card">
          <div className="vendor-note vendor-note--warning">{actionData.warning}</div>
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
        <div className="vendor-inventory-card-header">
          <div>
            <h2 className="vendor-section-title">商品別の在庫確認</h2>
            <p className="vendor-section-subtitle">
              在庫が未設定または0の商品は、購入できない状態として扱います。
            </p>
          </div>
          <button
            className="vendor-shell__button vendor-shell__button--primary"
            disabled={filteredProducts.length === 0}
            form="vendor-inventory-bulk-form"
            type="submit"
          >
            保存
          </button>
        </div>

        <div className="vendor-inventory-toolbar">
          <input
            aria-label="商品名で絞り込み"
            className="vendor-shell__search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="商品名で絞り込み"
            type="search"
            value={query}
          />
        </div>

        <Form
          className="vendor-inventory-form"
          id="vendor-inventory-bulk-form"
          method="post"
        >
          <input type="hidden" name="intent" value="updateInventory" />
          <div className="vendor-table-wrap">
          <table className="vendor-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>カテゴリ</th>
                <th>価格</th>
                <th>現在の在庫数</th>
                <th>在庫状態</th>
                <th>公開ストア反映</th>
                <th>公開状態</th>
                <th>確認状況</th>
                <th>最終更新</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan="9" style={{ color: "#6b7280" }}>
                    まだ商品が登録されていません。商品を登録すると、ここに在庫確認対象として表示されます。
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan="9" style={{ color: "#6b7280" }}>
                    条件に一致する商品はありません。
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
                  <tr key={product.id}>
                    <td className="vendor-table__name">{product.name}</td>
                    <td>{product.category}</td>
                    <td>{product.priceLabel}</td>
                    <td>
                      <InventoryQuantityInput
                        onChange={updateInventoryValue}
                        product={product}
                        value={inventoryValues[product.id] ?? ""}
                      />
                    </td>
                    <td>
                      <span className={`vendor-shell__badge vendor-shell__badge--${product.stockStatusTone}`}>
                        {product.stockStatusLabel}
                      </span>
                      <span className="vendor-table__meta">{product.stockLabel}</span>
                    </td>
                    <td>
                      <span className={`vendor-shell__badge vendor-shell__badge--${product.inventorySyncTone}`}>
                        {product.inventorySyncLabel}
                      </span>
                      <span className="vendor-table__meta">{product.inventorySyncDetail}</span>
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
        </Form>
      </section>
    </VendorManagementShell>
  );
}
