import { Form, Link } from "@remix-run/react";

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

        <Form method="post" encType="multipart/form-data">
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
              <input
                className="vendor-form__input"
                defaultValue={initialValues.category || ""}
                id="category"
                name="category"
                placeholder="例: スキンケア"
                type="text"
              />
            </div>

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

              <Link className="vendor-shell__button" to={backTo}>
                {backLabel}
              </Link>
            </div>
          </div>
        </Form>
      </div>
    </section>
  );
}
