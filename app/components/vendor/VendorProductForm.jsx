import { Form, Link } from "@remix-run/react";
import { useEffect, useState } from "react";
import { useVendorScopedPath } from "./vendorNavigation";
import {
  PRODUCT_CATEGORY_OPTIONS,
  normalizeProductCategory,
} from "../../utils/productCategories";
import {
  PRODUCT_SHIPPING_METHOD,
  PRODUCT_SHIPPING_METHOD_OPTIONS,
  millimetersToCentimeters,
} from "../../utils/productShippingProfile";

const CURRENCY_OPTIONS = ["JPY", "USD", "EUR", "GBP", "CNY", "KRW"];

export default function VendorProductForm({
  title,
  intro,
  storeName,
  error,
  isSubmitting = false,
  initialValues = {},
  currentImageUrl = null,
  currentImageAlt = "",
  uploadHint = "画像を選択すると、保存時にアップロードされます。",
  imageEmptyText = "現在の画像は登録されていません。",
  submitLabel,
  submittingLabel,
  backTo = "/vendor/dashboard",
  backLabel = "ダッシュボードへ戻る",
}) {
  const scopedBackTo = useVendorScopedPath(backTo);
  const selectedCategory =
    normalizeProductCategory(initialValues.category) || initialValues.category || "";
  const regulatorySelfCertified = Boolean(
    initialValues.regulatorySelfCertified ||
      initialValues.regulatorySelfCertificationJson?.regulatorySelfCertified,
  );
  const categoryOptions = PRODUCT_CATEGORY_OPTIONS.includes(selectedCategory)
    ? PRODUCT_CATEGORY_OPTIONS
    : selectedCategory
      ? [selectedCategory, ...PRODUCT_CATEGORY_OPTIONS]
      : PRODUCT_CATEGORY_OPTIONS;
  const initialShippingMethod =
    initialValues.internationalShippingMethod ||
    PRODUCT_SHIPPING_METHOD.UNCONFIGURED;
  const [shippingMethod, setShippingMethod] = useState(initialShippingMethod);
  const compliance = initialValues.complianceProfile || {};

  useEffect(() => {
    setShippingMethod(initialShippingMethod);
  }, [initialShippingMethod]);

  return (
    <section className="vendor-card">
      <div className="vendor-form">
        <div className="vendor-form__meta">
          <h2 className="vendor-section-title">{title}</h2>
          {storeName ? (
            <p className="vendor-form__store">店舗: {storeName}</p>
          ) : null}
          <p className="vendor-section-subtitle">{intro}</p>
        </div>

        {error ? <div className="vendor-note vendor-note--danger">{error}</div> : null}

        <Form
          key={`${initialValues.id || "new"}:${initialValues.updatedAt || ""}`}
          method="post"
          encType="multipart/form-data"
        >
          <div className="vendor-form__grid">
            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="name">
                商品名
              </label>
              <input
                className="vendor-form__input"
                defaultValue={initialValues.name || ""}
                id="name"
                name="name"
                placeholder="例: EOBEAUTE バランシングローション"
                type="text"
              />
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="description">
                商品説明
              </label>
              <textarea
                className="vendor-form__textarea"
                defaultValue={initialValues.description || ""}
                id="description"
                name="description"
                placeholder="商品の説明を入力してください"
                rows={8}
              />
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label">商品画像</label>

              {currentImageUrl ? (
                <div className="vendor-form__image-frame">
                  <img
                    alt={currentImageAlt || title}
                    className="vendor-form__image"
                    src={currentImageUrl}
                  />
                </div>
              ) : (
                <div className="vendor-form__empty-image">{imageEmptyText}</div>
              )}

              <div className="vendor-form__upload">
                <input
                  accept="image/*"
                  className="vendor-form__file"
                  name="image"
                  type="file"
                />
                <div className="vendor-helper-text">{uploadHint}</div>
              </div>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="category">
                カテゴリー
              </label>
              <select
                className="vendor-form__select"
                defaultValue={selectedCategory}
                id="category"
                name="category"
                required
              >
                <option value="">カテゴリを選択してください</option>
                {categoryOptions.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label">
                <input
                  defaultChecked={regulatorySelfCertified}
                  name="regulatorySelfCertified"
                  type="checkbox"
                  value="1"
                />
                禁止商品・規制対象・知財侵害品ではないことを確認しました
              </label>
              <div className="vendor-helper-text">
                配送先国の可否や追加審査は、商品確認時に管理者が設定します。
              </div>
            </div>

            <div className="vendor-form__field">
              <h3 className="vendor-section-title" style={{ fontSize: "18px" }}>
                販売・通関情報
              </h3>
              <div className="vendor-helper-text">
                購入者への表示、税関申告、商品審査に使います。注文後に商品情報が変わっても、注文時点の内容は保存されます。
              </div>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="conditionStatus">
                商品状態
              </label>
              <select
                className="vendor-form__select"
                defaultValue={compliance.conditionStatus || "NEW"}
                id="conditionStatus"
                name="conditionStatus"
                required
              >
                <option value="NEW">新品</option>
                <option value="USED">中古品</option>
              </select>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="countryOfOriginCode">
                原産国コード
              </label>
              <input
                className="vendor-form__input"
                defaultValue={compliance.countryOfOriginCode || "JP"}
                id="countryOfOriginCode"
                maxLength={2}
                name="countryOfOriginCode"
                placeholder="JP"
                required
                type="text"
              />
              <div className="vendor-helper-text">ISO 2文字コードで入力してください。</div>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="hsCode">
                HSコード
              </label>
              <input
                className="vendor-form__input"
                defaultValue={compliance.hsCode || ""}
                id="hsCode"
                inputMode="numeric"
                name="hsCode"
                placeholder="例: 330499"
                type="text"
              />
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="customsDescriptionEn">
                税関向け英語品名
              </label>
              <input
                className="vendor-form__input"
                defaultValue={compliance.customsDescriptionEn || ""}
                id="customsDescriptionEn"
                name="customsDescriptionEn"
                placeholder="例: Facial lotion"
                required
                type="text"
              />
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="regulatoryCategory">
                規制・許認可区分
              </label>
              <input
                className="vendor-form__input"
                defaultValue={compliance.regulatoryCategory || ""}
                id="regulatoryCategory"
                name="regulatoryCategory"
                placeholder="例: 化粧品 / 一般雑貨 / 食品"
                type="text"
              />
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label">
                <input
                  defaultChecked={Boolean(compliance.authenticityConfirmedAt)}
                  name="authenticityConfirmed"
                  required
                  type="checkbox"
                  value="1"
                />
                正規品であり、表示内容が実物と一致することを確認しました
              </label>
              <label className="vendor-form__label" style={{ marginTop: "10px" }}>
                <input
                  defaultChecked={Boolean(compliance.ipRightsConfirmedAt)}
                  name="ipRightsConfirmed"
                  required
                  type="checkbox"
                  value="1"
                />
                販売に必要な知的財産権・許諾を有することを確認しました
              </label>
            </div>

            <div className="vendor-form__field">
              <h3 className="vendor-section-title" style={{ fontSize: "18px" }}>
                配送情報
              </h3>
              <div className="vendor-helper-text">
                商品1点を、緩衝材や箱を含めてそのまま発送できる状態にした数値を入力してください。
              </div>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="shippingWeightGrams">
                梱包後重量（g）
              </label>
              <input
                className="vendor-form__input"
                defaultValue={initialValues.shippingWeightGrams ?? ""}
                id="shippingWeightGrams"
                inputMode="numeric"
                min="1"
                name="shippingWeightGrams"
                placeholder="例: 350"
                required
                step="1"
                type="number"
              />
              <label className="vendor-form__label" style={{ marginTop: "10px" }}>
                <input
                  defaultChecked={Boolean(initialValues.shippingWeightConfirmedAt)}
                  name="shippingWeightConfirmed"
                  required
                  type="checkbox"
                  value="1"
                />
                この重量が、箱・封筒・緩衝材を含む梱包後重量であることを確認しました
              </label>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="internationalShippingMethod">
                配送範囲
              </label>
              <select
                className="vendor-form__select"
                id="internationalShippingMethod"
                name="internationalShippingMethod"
                onChange={(event) => setShippingMethod(event.currentTarget.value)}
                value={shippingMethod}
              >
                <option value={PRODUCT_SHIPPING_METHOD.UNCONFIGURED} disabled>
                  配送範囲を選択してください
                </option>
                {PRODUCT_SHIPPING_METHOD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {shippingMethod === PRODUCT_SHIPPING_METHOD.AIR_PACKET ? (
              <div className="vendor-form__field">
                <label className="vendor-form__label">梱包後サイズ（cm）</label>
                <div
                  style={{
                    display: "grid",
                    gap: "10px",
                    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  }}
                >
                  <input
                    aria-label="梱包後の長さ"
                    className="vendor-form__input"
                    defaultValue={millimetersToCentimeters(initialValues.shippingLengthMm)}
                    min="0.1"
                    name="shippingLengthCm"
                    placeholder="長さ"
                    required
                    step="0.1"
                    type="number"
                  />
                  <input
                    aria-label="梱包後の幅"
                    className="vendor-form__input"
                    defaultValue={millimetersToCentimeters(initialValues.shippingWidthMm)}
                    min="0.1"
                    name="shippingWidthCm"
                    placeholder="幅"
                    required
                    step="0.1"
                    type="number"
                  />
                  <input
                    aria-label="梱包後の厚さ"
                    className="vendor-form__input"
                    defaultValue={millimetersToCentimeters(initialValues.shippingHeightMm)}
                    min="0.1"
                    name="shippingHeightCm"
                    placeholder="厚さ"
                    required
                    step="0.1"
                    type="number"
                  />
                </div>
                <div className="vendor-helper-text">
                  最終梱包サイズを入力してください。通常形状は14.8cm × 10.5cm以上、
                  2kg以下、最長辺60cm以下、三辺合計90cm以下です。巻物形状は現在非対応です。
                  Shopifyチェックアウトへの反映に最大15分かかる場合があります。
                </div>
              </div>
            ) : null}

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="price">
                価格
              </label>
              <input
                className="vendor-form__input"
                defaultValue={initialValues.price ?? initialValues.costAmount ?? ""}
                id="price"
                min="0"
                name="price"
                placeholder="1000"
                step="0.01"
                type="number"
              />
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="costCurrency">
                価格通貨
              </label>
              <select
                className="vendor-form__select"
                defaultValue={initialValues.costCurrency || "JPY"}
                id="costCurrency"
                name="costCurrency"
              >
                {CURRENCY_OPTIONS.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="url">
                参照URL・関連ページ
              </label>
              <input
                className="vendor-form__input"
                defaultValue={initialValues.url || ""}
                id="url"
                name="url"
                placeholder="https://..."
                type="text"
              />
            </div>

            <div className="vendor-form__actions">
              <button
                className="vendor-shell__button vendor-shell__button--primary"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? submittingLabel : submitLabel}
              </button>

              <Link className="vendor-shell__button" to={scopedBackTo}>
                {backLabel}
              </Link>
            </div>
          </div>
        </Form>
      </div>
    </section>
  );
}
