import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { useState } from "react";

import prisma from "../db.server";
import { serializePublicVendorStorefront } from "../utils/publicVendorStorefront";

const PREVIEW_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "Surrogate-Control": "no-store",
};

const COUNTRY_OPTIONS = [
  { value: "", label: "配送先を選択" },
  { value: "JP", label: "日本" },
  { value: "FR", label: "フランス" },
  { value: "DE", label: "ドイツ" },
  { value: "IT", label: "イタリア" },
  { value: "ES", label: "スペイン" },
  { value: "NL", label: "オランダ" },
  { value: "SE", label: "スウェーデン" },
  { value: "US", label: "アメリカ" },
  { value: "GB", label: "イギリス" },
  { value: "KR", label: "韓国" },
  { value: "SG", label: "シンガポール" },
  { value: "AU", label: "オーストラリア" },
];

const STATUS_LABELS = {
  AVAILABLE: "販売可能",
  UNKNOWN_COUNTRY: "配送先未選択",
  REQUIRES_IMPORT_WARNING: "注意確認が必要",
  UNAVAILABLE: "販売できません",
  UNPURCHASABLE: "購入できません",
  UNAVAILABLE_PRODUCT_EU_REVIEW: "販売できません",
  UNAVAILABLE_SELLER_EU_REVIEW: "販売できません",
  UNAVAILABLE_COUNTRY_BLOCKED: "販売できません",
  UNAVAILABLE_COUNTRY_NOT_ALLOWED: "販売できません",
  UNAVAILABLE_PRODUCT_UNAPPROVED: "購入できません",
};

export const meta = () => [
  { title: "Storefront Preview" },
  { name: "robots", content: "noindex,nofollow" },
];

function normalizeHandle(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeCountry(value) {
  return String(value || "").trim().toUpperCase();
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("ja-JP");
}

function buildApiUrl({ origin, handle, deliveryCountry, filterEligible }) {
  const apiUrl = new URL(
    `/api/public-vendors/${encodeURIComponent(handle)}`,
    origin,
  );

  if (deliveryCountry) {
    apiUrl.searchParams.set("deliveryCountry", deliveryCountry);
  }

  if (filterEligible) {
    apiUrl.searchParams.set("filterEligible", "1");
  }

  return apiUrl.toString();
}

function getStatusTone(product) {
  const status = product.deliveryEligibility?.status || "UNKNOWN_COUNTRY";

  if (status.startsWith("UNAVAILABLE") || !product.isPurchasable) {
    return "block";
  }

  if (status === "REQUIRES_IMPORT_WARNING") {
    return "warning";
  }

  if (status === "AVAILABLE") {
    return "ok";
  }

  return "info";
}

export const loader = async ({ params, request }) => {
  const handle = normalizeHandle(params.handle);
  const url = new URL(request.url);
  const deliveryCountry = normalizeCountry(url.searchParams.get("deliveryCountry"));
  const filterEligible = url.searchParams.get("filterEligible") === "1";

  if (!handle) {
    throw new Response("Vendor handle is required.", { status: 400 });
  }

  const vendor = await prisma.vendor.findUnique({
    where: { handle },
    select: {
      id: true,
      handle: true,
      storeName: true,
      status: true,
      vendorStore: {
        select: {
          id: true,
          storeName: true,
          country: true,
          category: true,
          address: true,
          note: true,
        },
      },
      seller: {
        select: {
          euSellerStatus: true,
        },
      },
    },
  });

  if (!vendor || vendor.status !== "active" || !vendor.vendorStore) {
    throw new Response("Vendor was not found.", { status: 404 });
  }

  const products = await prisma.product.findMany({
    where: {
      vendorStoreId: vendor.vendorStore.id,
      approvalStatus: "approved",
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      imageUrl: true,
      category: true,
      price: true,
      calculatedPrice: true,
      shopDomain: true,
      approvalStatus: true,
      productEuStatus: true,
      countryPolicy: true,
    },
  });

  const storefront = serializePublicVendorStorefront({
    vendor,
    store: vendor.vendorStore,
    products,
    deliveryCountry,
    filterByDeliveryEligibility: false,
  });

  if (!storefront) {
    throw new Response("Vendor was not found.", { status: 404 });
  }

  const visibleProducts =
    filterEligible && deliveryCountry
      ? storefront.products.filter(
          (product) =>
            product.isPurchasable && product.deliveryEligibility?.isAvailable,
        )
      : storefront.products;
  const unavailableProductCount = storefront.products.filter(
    (product) =>
      !product.isPurchasable || !product.deliveryEligibility?.isAvailable,
  ).length;

  return json(
    {
      ...storefront,
      products: visibleProducts,
      visibleProductCount: visibleProducts.length,
      hiddenProductCount: storefront.products.length - visibleProducts.length,
      unavailableProductCount,
      deliveryCountry,
      filterEligible,
      rawApiUrl: buildApiUrl({
        origin: url.origin,
        handle,
        deliveryCountry,
        filterEligible,
      }),
    },
    { headers: PREVIEW_HEADERS },
  );
};

function Metric({ label, value }) {
  return (
    <div className="preview-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ product }) {
  const status = product.deliveryEligibility?.status || "UNKNOWN_COUNTRY";
  const tone = getStatusTone(product);
  const label =
    product.deliveryEligibility?.label || STATUS_LABELS[status] || status;

  if (status === "AVAILABLE" || !label) {
    return null;
  }

  return (
    <span className={`preview-status preview-status--${tone}`}>
      {label}
    </span>
  );
}

function CountryChips({ countries, emptyText }) {
  if (!countries?.length) {
    return <span className="preview-restriction-empty">{emptyText}</span>;
  }

  return (
    <span className="preview-country-chips">
      {countries.map((country) => (
        <span className="preview-country-chip" key={country.code}>
          {country.label}
        </span>
      ))}
    </span>
  );
}

function getDeliveryRestrictionCountries(summary) {
  const countries = new Map();

  for (const country of summary?.unavailableCountries || []) {
    countries.set(country.code, country);
  }

  if (summary?.hasAllowedCountryLimit) {
    const allowedCountryCodes = new Set(
      (summary.allowedCountries || []).map((country) => country.code),
    );

    for (const country of COUNTRY_OPTIONS) {
      if (country.value && !allowedCountryCodes.has(country.value)) {
        countries.set(country.value, {
          code: country.value,
          label: country.label,
        });
      }
    }
  }

  return Array.from(countries.values());
}

function DeliveryRestrictionButton({ product, onOpen }) {
  const summary = product.deliveryRestrictionSummary;

  if (!summary?.hasRestrictions) {
    return null;
  }

  return (
    <button
      className="preview-restriction-button"
      type="button"
      onClick={() => onOpen(product)}
    >
      購入できない配送先を見る
    </button>
  );
}

function DeliveryRestrictionModal({ product, onClose }) {
  const summary = product?.deliveryRestrictionSummary;

  if (!product || !summary?.hasRestrictions) {
    return null;
  }

  const unavailableCountries = getDeliveryRestrictionCountries(summary);

  return (
    <div
      className="preview-modal-backdrop"
      role="presentation"
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
    >
      <section
        className="preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-delivery-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="preview-modal-header">
          <div>
            <p className="preview-modal-kicker">配送先の確認</p>
            <h2 id="preview-delivery-modal-title">{product.name}</h2>
          </div>
          <button
            className="preview-modal-close"
            type="button"
            aria-label="閉じる"
            onClick={onClose}
          >
            x
          </button>
        </div>

        <p className="preview-modal-message">{summary.message}</p>

        <div className="preview-restriction-block">
          <strong>購入できない配送先</strong>
          <CountryChips
            countries={unavailableCountries}
            emptyText="購入できない配送先は登録されていません。"
          />
        </div>

        {summary.warningCountries?.length ? (
          <div className="preview-restriction-block">
            <strong>注意確認が必要な配送先</strong>
            <CountryChips countries={summary.warningCountries} />
          </div>
        ) : null}

        <p className="preview-modal-note">
          配送先ごとの制限は、店舗と商品の現在の登録情報にもとづいて表示しています。
        </p>
      </section>
    </div>
  );
}

export default function PublicVendorPreviewPage() {
  const data = useLoaderData();
  const hasDeliveryCountry = Boolean(data.deliveryCountry);
  const [restrictionProductId, setRestrictionProductId] = useState(null);
  const activeRestrictionProduct =
    data.products.find((product) => product.id === restrictionProductId) || null;

  return (
    <main className="preview-page">
      <style>{`
        .preview-page{
          min-height:100vh;
          background:#f5f6f8;
          color:#17202a;
          font-family:Inter, "Hiragino Sans", "Yu Gothic", sans-serif;
        }
        .preview-shell{
          width:min(1180px, calc(100% - 32px));
          margin:0 auto;
          padding:28px 0 48px;
          display:grid;
          gap:18px;
        }
        .preview-header{
          display:grid;
          grid-template-columns:1fr auto;
          align-items:start;
          gap:18px;
          padding:22px;
          background:#fff;
          border:1px solid #dfe4ea;
          border-radius:8px;
        }
        .preview-kicker{
          margin:0 0 8px;
          color:#5b6674;
          font-size:12px;
          font-weight:800;
          letter-spacing:.08em;
          text-transform:uppercase;
        }
        .preview-title{
          margin:0;
          font-size:32px;
          line-height:1.2;
          letter-spacing:0;
        }
        .preview-meta{
          display:flex;
          flex-wrap:wrap;
          gap:8px;
          margin-top:14px;
        }
        .preview-chip{
          display:inline-flex;
          align-items:center;
          min-height:30px;
          padding:0 10px;
          background:#f1f4f7;
          border:1px solid #dfe4ea;
          border-radius:8px;
          color:#344254;
          font-size:13px;
          font-weight:700;
        }
        .preview-link{
          color:#0f3b72;
          font-weight:800;
          text-decoration:none;
        }
        .preview-link:hover{
          text-decoration:underline;
        }
        .preview-panel{
          padding:18px;
          background:#fff;
          border:1px solid #dfe4ea;
          border-radius:8px;
        }
        .preview-controls{
          display:grid;
          grid-template-columns:minmax(180px, 240px) 1fr auto;
          gap:14px;
          align-items:end;
        }
        .preview-field{
          display:grid;
          gap:7px;
          color:#4a5564;
          font-size:13px;
          font-weight:800;
        }
        .preview-select{
          min-height:44px;
          border:1px solid #cbd3dc;
          border-radius:8px;
          background:#fff;
          color:#17202a;
          padding:0 12px;
          font-size:15px;
        }
        .preview-check{
          display:flex;
          align-items:center;
          gap:8px;
          min-height:44px;
          color:#344254;
          font-weight:800;
        }
        .preview-button{
          min-height:44px;
          border:0;
          border-radius:8px;
          background:#17202a;
          color:#fff;
          padding:0 18px;
          font-weight:900;
          cursor:pointer;
        }
        .preview-metrics{
          display:grid;
          grid-template-columns:repeat(4, minmax(0, 1fr));
          gap:10px;
        }
        .preview-metric{
          display:grid;
          gap:6px;
          padding:14px;
          border:1px solid #dfe4ea;
          border-radius:8px;
          background:#fff;
        }
        .preview-metric span{
          color:#5b6674;
          font-size:12px;
          font-weight:800;
        }
        .preview-metric strong{
          color:#17202a;
          font-size:24px;
          line-height:1.1;
        }
        .preview-products{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));
          gap:14px;
        }
        .preview-product{
          display:grid;
          grid-template-rows:auto 1fr;
          overflow:hidden;
          background:#fff;
          border:1px solid #dfe4ea;
          border-radius:8px;
        }
        .preview-product--blocked{
          background:#fffafa;
          border-color:#f2c7c7;
        }
        .preview-product--warning{
          background:#fffaf2;
          border-color:#efd6a8;
        }
        .preview-image,
        .preview-image-placeholder{
          width:100%;
          aspect-ratio:4 / 3;
          background:#e8edf3;
        }
        .preview-image{
          object-fit:cover;
        }
        .preview-image-placeholder{
          display:grid;
          place-items:center;
          color:#6b7785;
          font-size:12px;
          font-weight:900;
          letter-spacing:.08em;
        }
        .preview-product-body{
          display:grid;
          gap:12px;
          padding:16px;
        }
        .preview-product-top{
          display:flex;
          justify-content:space-between;
          align-items:flex-start;
          gap:12px;
        }
        .preview-product h2{
          margin:0;
          font-size:18px;
          line-height:1.35;
          letter-spacing:0;
        }
        .preview-price{
          white-space:nowrap;
          font-size:17px;
          font-weight:900;
        }
        .preview-description{
          margin:0;
          color:#4a5564;
          font-size:13px;
          line-height:1.7;
          display:-webkit-box;
          -webkit-line-clamp:3;
          -webkit-box-orient:vertical;
          overflow:hidden;
        }
        .preview-status-row{
          display:flex;
          flex-wrap:wrap;
          gap:8px;
          align-items:center;
        }
        .preview-status{
          display:inline-flex;
          align-items:center;
          min-height:28px;
          padding:0 10px;
          border-radius:8px;
          border:1px solid;
          font-size:12px;
          font-weight:900;
        }
        .preview-status--ok{
          color:#06663f;
          background:#eefbf3;
          border-color:#a7e7c0;
        }
        .preview-status--warning{
          color:#8a4a08;
          background:#fff7e6;
          border-color:#efc36b;
        }
        .preview-status--block{
          color:#9d1d1d;
          background:#fff1f1;
          border-color:#efb4b4;
        }
        .preview-status--info{
          color:#344254;
          background:#f1f4f7;
          border-color:#d4dbe3;
        }
        .preview-message{
          margin:0;
          color:#344254;
          font-size:13px;
          line-height:1.7;
        }
        .preview-message--block{
          color:#9d1d1d;
        }
        .preview-message--warning{
          color:#8a4a08;
        }
        .preview-restriction-button{
          display:inline-flex;
          max-width:100%;
          min-height:34px;
          align-items:center;
          padding:0 10px;
          border:1px solid #cbd3dc;
          border-radius:8px;
          background:#fff;
          color:#344254;
          font-size:12px;
          font-weight:900;
          cursor:pointer;
          text-align:left;
        }
        .preview-restriction-button::after{
          content:"";
          width:7px;
          height:7px;
          margin-left:8px;
          border-right:2px solid currentColor;
          border-bottom:2px solid currentColor;
          transform:rotate(45deg) translateY(-2px);
        }
        .preview-restriction-button:hover,
        .preview-restriction-button:focus-visible{
          border-color:#9aa7b5;
          background:#f8fafc;
        }
        .preview-modal-backdrop{
          position:fixed;
          inset:0;
          z-index:20;
          display:grid;
          place-items:center;
          padding:18px;
          background:rgba(23,32,42,.34);
        }
        .preview-modal{
          width:min(480px, 100%);
          max-height:min(640px, calc(100vh - 36px));
          overflow:auto;
          display:grid;
          gap:16px;
          padding:18px;
          border:1px solid #cbd3dc;
          border-radius:8px;
          background:#fff;
          box-shadow:0 24px 70px rgba(23,32,42,.28);
        }
        .preview-modal-header{
          display:grid;
          grid-template-columns:1fr auto;
          gap:14px;
          align-items:start;
        }
        .preview-modal-kicker{
          margin:0 0 4px;
          color:#5b6674;
          font-size:12px;
          font-weight:900;
        }
        .preview-modal h2{
          margin:0;
          color:#17202a;
          font-size:22px;
          line-height:1.3;
          letter-spacing:0;
        }
        .preview-modal-close{
          width:34px;
          height:34px;
          border:1px solid #cbd3dc;
          border-radius:8px;
          background:#fff;
          color:#344254;
          font-size:18px;
          font-weight:900;
          line-height:1;
          cursor:pointer;
        }
        .preview-modal-close:hover,
        .preview-modal-close:focus-visible{
          background:#f1f4f7;
        }
        .preview-modal-message,
        .preview-modal-note{
          margin:0;
          color:#344254;
          font-size:13px;
          line-height:1.7;
        }
        .preview-modal-note{
          color:#5b6674;
        }
        .preview-restriction-block{
          display:grid;
          gap:8px;
        }
        .preview-restriction-block strong{
          font-size:12px;
          color:#17202a;
        }
        .preview-restriction-block small,
        .preview-restriction-empty{
          color:#5b6674;
          font-size:12px;
          line-height:1.6;
        }
        .preview-country-chips{
          display:flex;
          flex-wrap:wrap;
          gap:6px;
        }
        .preview-country-chip{
          display:inline-flex;
          align-items:center;
          min-height:26px;
          padding:0 8px;
          border:1px solid #dfe4ea;
          border-radius:8px;
          background:#f8fafc;
          color:#344254;
          font-size:12px;
          font-weight:800;
        }
        .preview-empty{
          padding:32px;
          background:#fff;
          border:1px dashed #b9c3cf;
          border-radius:8px;
          color:#4a5564;
          text-align:center;
          line-height:1.7;
        }
        .preview-api{
          display:flex;
          flex-wrap:wrap;
          gap:10px;
          align-items:center;
          justify-content:space-between;
          color:#4a5564;
          font-size:13px;
        }
        .preview-code{
          max-width:100%;
          overflow:auto;
          border:1px solid #dfe4ea;
          border-radius:8px;
          padding:9px 10px;
          background:#f8fafc;
          color:#17202a;
          font-family:"SFMono-Regular", Consolas, monospace;
        }
        @media (max-width: 820px){
          .preview-header,
          .preview-controls{
            grid-template-columns:1fr;
          }
          .preview-metrics{
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 520px){
          .preview-shell{
            width:min(100% - 20px, 1180px);
            padding-top:14px;
          }
          .preview-title{
            font-size:26px;
          }
          .preview-metrics,
          .preview-products{
            grid-template-columns:1fr;
          }
        }
      `}</style>

      <div className="preview-shell">
        <header className="preview-header">
          <div>
            <p className="preview-kicker">Public Storefront Preview</p>
            <h1 className="preview-title">{data.store.storeName}</h1>
            <div className="preview-meta">
              <span className="preview-chip">handle: {data.vendor.handle}</span>
              {data.store.country ? (
                <span className="preview-chip">{data.store.country}</span>
              ) : null}
              {data.store.category ? (
                <span className="preview-chip">{data.store.category}</span>
              ) : null}
              {hasDeliveryCountry ? (
                <span className="preview-chip">配送先: {data.deliveryCountry}</span>
              ) : (
                <span className="preview-chip">配送先未選択</span>
              )}
            </div>
          </div>
          <a className="preview-link" href={data.rawApiUrl}>
            JSONを見る
          </a>
        </header>

        <section className="preview-panel">
          <Form className="preview-controls" method="get">
            <label className="preview-field">
              配送先国
              <select
                className="preview-select"
                name="deliveryCountry"
                defaultValue={data.deliveryCountry || ""}
              >
                {COUNTRY_OPTIONS.map((country) => (
                  <option key={country.value || "none"} value={country.value}>
                    {country.label}
                    {country.value ? ` (${country.value})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="preview-check">
              <input
                type="checkbox"
                name="filterEligible"
                value="1"
                defaultChecked={data.filterEligible}
              />
              販売できない商品を非表示
            </label>

            <button className="preview-button" type="submit">
              表示を更新
            </button>
          </Form>
        </section>

        <section className="preview-metrics" aria-label="storefront metrics">
          <Metric label="商品数" value={formatCount(data.productCount)} />
          <Metric label="表示中" value={formatCount(data.visibleProductCount)} />
          <Metric label="非表示" value={formatCount(data.hiddenProductCount)} />
          <Metric label="販売不可" value={formatCount(data.unavailableProductCount)} />
        </section>

        <section className="preview-products">
          {data.products.map((product) => {
            const tone = getStatusTone(product);
            const status = product.deliveryEligibility?.status || "UNKNOWN_COUNTRY";
            const shouldShowStatus = status !== "AVAILABLE";
            const shouldShowStatusRow = shouldShowStatus || product.category;

            return (
              <article
                className={`preview-product preview-product--${tone}`}
                key={product.id}
              >
                {product.imageUrl ? (
                  <img
                    className="preview-image"
                    src={product.imageUrl}
                    alt={product.name}
                  />
                ) : (
                  <div className="preview-image-placeholder">NO IMAGE</div>
                )}

                <div className="preview-product-body">
                  <div className="preview-product-top">
                    <h2>{product.name}</h2>
                    <span className="preview-price">{product.formattedPrice}</span>
                  </div>

                  {product.description ? (
                    <p className="preview-description">{product.description}</p>
                  ) : null}

                  {shouldShowStatusRow ? (
                    <div className="preview-status-row">
                      {shouldShowStatus ? <StatusBadge product={product} /> : null}
                      {product.category ? (
                        <span className="preview-status preview-status--info">
                          {product.category}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {product.deliveryEligibility?.message ? (
                    <p className={`preview-message preview-message--${tone}`}>
                      {product.deliveryEligibility.message}
                    </p>
                  ) : null}

                  {!hasDeliveryCountry ? (
                    <DeliveryRestrictionButton
                      product={product}
                      onOpen={(selectedProduct) =>
                        setRestrictionProductId(selectedProduct.id)
                      }
                    />
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>

        {data.products.length === 0 ? (
          <div className="preview-empty">
            {data.hiddenProductCount > 0
              ? "現在の配送先では表示できる商品がありません。フィルターを外すと販売不可理由を確認できます。"
              : "公開対象の商品がまだありません。"}
          </div>
        ) : null}

        <section className="preview-panel preview-api">
          <span>この画面は公開APIと同じ配送可否ロジックを表示しています。</span>
          <code className="preview-code">{data.rawApiUrl}</code>
        </section>
      </div>

      <DeliveryRestrictionModal
        product={activeRestrictionProduct}
        onClose={() => setRestrictionProductId(null)}
      />
    </main>
  );
}
