import { Form, Link, useActionData, useLoaderData, useNavigation } from '@remix-run/react';
import { useMemo, useState } from 'react';

const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

function hiddenVendorStorefrontResponse() {
  throw new Response('Not Found', {
    status: 404,
  });
}

export const loader = hiddenVendorStorefrontResponse;
export const action = hiddenVendorStorefrontResponse;

function formatMoney(amount, currencyCode = 'JPY') {
  const numeric = Number(amount || 0);

  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `JPY ${Math.round(numeric).toLocaleString('ja-JP')}`;
  }
}

export default function VendorStorefrontPage() {
  const { store, products } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  const [quantities, setQuantities] = useState(() =>
    Object.fromEntries(products.map((product) => [product.id, '0'])),
  );
  const [customer, setCustomer] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [shippingAddress, setShippingAddress] = useState({
    address1: '',
    address2: '',
    city: '',
    province: '',
    postalCode: '',
    country: 'JP',
  });
  const [note, setNote] = useState('');
  const [importResponsibilityAccepted, setImportResponsibilityAccepted] = useState(false);

  const selectedCount = useMemo(
    () =>
      Object.values(quantities).reduce((sum, value) => {
        const numeric = Number(value);
        return sum + (Number.isInteger(numeric) && numeric > 0 ? numeric : 0);
      }, 0),
    [quantities],
  );
  const requiresImportWarning = EU_COUNTRY_CODES.has(
    String(shippingAddress.country || '').trim().toUpperCase(),
  );

  return (
    <div className="storefront-page">
      <style>{`
        .storefront-page{min-height:100vh;background:radial-gradient(circle at top left, rgba(255,244,214,0.9), transparent 30%),linear-gradient(180deg, #fffdfa 0%, #f6efe8 100%);color:#221a15;font-family:"Hiragino Sans","Yu Gothic",sans-serif;}
        .storefront-shell{max-width:1200px;margin:0 auto;padding:32px 20px 64px;}
        .storefront-back{display:inline-flex;margin-bottom:20px;color:#6a5446;text-decoration:none;font-weight:700;}
        .storefront-hero{display:grid;gap:20px;padding:28px;border:1px solid rgba(95,72,52,0.12);border-radius:28px;background:rgba(255,255,255,0.82);backdrop-filter:blur(14px);box-shadow:0 24px 80px rgba(72,49,35,0.10);}
        .storefront-kicker{margin:0;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#8a6b57;font-weight:800;}
        .storefront-title{margin:0;font-size:clamp(32px, 5vw, 60px);line-height:1.05;font-weight:900;}
        .storefront-meta{display:flex;flex-wrap:wrap;gap:10px;}
        .storefront-chip{display:inline-flex;align-items:center;padding:8px 14px;border-radius:999px;background:#f4ebe2;color:#6a5446;font-size:13px;font-weight:700;}
        .storefront-note{margin:0;font-size:15px;line-height:1.8;color:#5b473b;max-width:720px;}
        .storefront-grid{display:grid;grid-template-columns:1.2fr 0.9fr;gap:24px;margin-top:28px;}
        .storefront-card{padding:24px;border-radius:24px;background:rgba(255,255,255,0.88);border:1px solid rgba(95,72,52,0.12);box-shadow:0 18px 60px rgba(72,49,35,0.08);}
        .storefront-section-title{margin:0 0 8px;font-size:24px;font-weight:800;}
        .storefront-subtitle{margin:18px 0 8px;font-size:18px;font-weight:800;}
        .storefront-section-sub{margin:0 0 20px;color:#6a5446;font-size:14px;line-height:1.7;}
        .storefront-error{margin-bottom:18px;padding:14px 16px;border-radius:16px;border:1px solid #e6b6b6;background:#fff3f2;color:#9d1d1d;font-size:14px;line-height:1.7;}
        .product-list{display:grid;gap:16px;}
        .product-card{display:grid;grid-template-columns:120px 1fr auto;gap:16px;padding:16px;border-radius:20px;border:1px solid rgba(95,72,52,0.10);background:#fffaf6;}
        .product-image{width:120px;height:120px;border-radius:16px;object-fit:cover;background:#efe4d8;}
        .product-image-placeholder{display:flex;align-items:center;justify-content:center;width:120px;height:120px;border-radius:16px;background:linear-gradient(135deg, #f0e2d5, #e9d8ca);color:#7b5f4b;font-weight:800;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;}
        .product-title{margin:0 0 8px;font-size:20px;font-weight:800;}
        .product-description{margin:0;color:#6a5446;font-size:14px;line-height:1.7;}
        .product-side{display:grid;align-content:space-between;justify-items:end;gap:12px;min-width:110px;}
        .product-price{font-size:20px;font-weight:900;}
        .quantity-label{display:grid;gap:6px;justify-items:end;font-size:12px;color:#6a5446;font-weight:700;}
        .quantity-input{width:84px;height:44px;border-radius:14px;border:1px solid rgba(95,72,52,0.18);background:#fff;text-align:center;font-size:18px;font-weight:800;color:#221a15;}
        .product-disabled{font-size:12px;color:#9d1d1d;font-weight:700;}
        .checkout-form{display:grid;gap:18px;}
        .field-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
        .field-stack{display:grid;gap:12px;}
        .field-label{display:grid;gap:6px;font-size:13px;color:#6a5446;font-weight:700;}
        .field-input,.field-textarea{width:100%;box-sizing:border-box;border-radius:16px;border:1px solid rgba(95,72,52,0.18);background:#fff;padding:14px 16px;color:#221a15;font-size:16px;}
        .field-textarea{min-height:110px;resize:vertical;}
        .field-error{color:#9d1d1d;font-size:12px;font-weight:700;}
        .checkout-summary{padding:18px;border-radius:18px;background:#fbf3eb;border:1px solid rgba(95,72,52,0.12);}
        .checkout-summary strong{display:block;margin-bottom:6px;font-size:18px;}
        .import-warning{display:grid;gap:10px;padding:14px 16px;border-radius:16px;background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;font-size:13px;line-height:1.7;}
        .warning-check{display:flex;gap:8px;align-items:flex-start;font-weight:800;color:#7c2d12;}
        .checkout-submit{width:100%;height:56px;border:none;border-radius:999px;background:#221a15;color:#fff;font-size:16px;font-weight:900;cursor:pointer;}
        .checkout-submit:disabled{cursor:not-allowed;opacity:0.65;}
        @media (max-width: 960px){.storefront-grid{grid-template-columns:1fr;}.product-card{grid-template-columns:96px 1fr;}.product-side{grid-column:1 / -1;justify-items:start;}}
        @media (max-width: 640px){.storefront-shell{padding:20px 14px 48px;}.storefront-hero,.storefront-card{padding:18px;border-radius:20px;}.field-grid{grid-template-columns:1fr;}.product-card{grid-template-columns:1fr;}.product-image,.product-image-placeholder{width:100%;height:200px;}}
      `}</style>

      <div className="storefront-shell">
        <Link className="storefront-back" to="/vendors">
          店舗一覧へ戻る
        </Link>

        <section className="storefront-hero">
          <p className="storefront-kicker">STORE CHECKOUT</p>
          <h1 className="storefront-title">{store.storeName}</h1>
          <div className="storefront-meta">
            <span className="storefront-chip">{store.country}</span>
            <span className="storefront-chip">{store.category}</span>
            <span className="storefront-chip">{products.length} 点の商品</span>
          </div>
          {store.note ? <p className="storefront-note">{store.note}</p> : null}
        </section>

        <div className="storefront-grid">
          <section className="storefront-card">
            <h2 className="storefront-section-title">商品を選ぶ</h2>
            <p className="storefront-section-sub">
              数量を指定して商品を選択してください。送料は配送先入力後に計算され、決済画面で確認できます。
            </p>

            <div className="product-list">
              {products.map((product) => (
                <article className="product-card" key={product.id}>
                  {product.imageUrl ? (
                    <img className="product-image" src={product.imageUrl} alt={product.name} />
                  ) : (
                    <div className="product-image-placeholder">NO IMAGE</div>
                  )}

                  <div>
                    <h3 className="product-title">{product.name}</h3>
                    <p className="product-description">
                      {product.description || '商品説明はありません。'}
                    </p>
                  </div>

                  <div className="product-side">
                    <div className="product-price">{formatMoney(product.price)}</div>
                    <label className="quantity-label">
                      数量
                      <input
                        className="quantity-input"
                        type="number"
                        min="0"
                        inputMode="numeric"
                        name={`quantity:${product.id}`}
                        value={quantities[product.id] || '0'}
                        onChange={(event) =>
                          setQuantities((current) => ({
                            ...current,
                            [product.id]: event.target.value,
                          }))
                        }
                        disabled={!product.isPurchasable || isSubmitting}
                      />
                    </label>
                    {!product.isPurchasable ? (
                      <div className="product-disabled">現在この商品は購入できません。</div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="storefront-card">
            <h2 className="storefront-section-title">配送先・お客様情報</h2>
            <p className="storefront-section-sub">
              入力内容をもとにチェックアウトを作成し、Shopify の決済画面へ移動します。
            </p>

            {actionData?.error ? (
              <div className="storefront-error">
                <strong>決済を開始できませんでした。</strong>
                <div>{actionData.error}</div>
              </div>
            ) : null}

            <Form className="checkout-form" method="post">
              <div className="checkout-summary">
                <strong>{selectedCount} 点を選択中</strong>
                <span>商品と配送先を確認してから決済へ進んでください。</span>
                {actionData?.fieldErrors?.cart ? (
                  <div className="field-error" style={{ marginTop: '8px' }}>
                    {actionData.fieldErrors.cart}
                  </div>
                ) : null}
              </div>

              <h3 className="storefront-subtitle">お客様情報</h3>
              <div className="field-grid">
                <label className="field-label">
                  姓
                  <input
                    className="field-input"
                    name="lastName"
                    placeholder="Yamada"
                    value={customer.lastName}
                    onChange={(event) =>
                      setCustomer((current) => ({ ...current, lastName: event.target.value }))
                    }
                  />
                  {actionData?.fieldErrors?.lastName ? (
                    <span className="field-error">{actionData.fieldErrors.lastName}</span>
                  ) : null}
                </label>

                <label className="field-label">
                  名
                  <input
                    className="field-input"
                    name="firstName"
                    placeholder="Taro"
                    value={customer.firstName}
                    onChange={(event) =>
                      setCustomer((current) => ({ ...current, firstName: event.target.value }))
                    }
                  />
                  {actionData?.fieldErrors?.firstName ? (
                    <span className="field-error">{actionData.fieldErrors.firstName}</span>
                  ) : null}
                </label>
              </div>

              <div className="field-stack">
                <label className="field-label">
                  メールアドレス
                  <input
                    className="field-input"
                    type="email"
                    name="email"
                    placeholder="taro@example.com"
                    value={customer.email}
                    onChange={(event) =>
                      setCustomer((current) => ({ ...current, email: event.target.value }))
                    }
                  />
                  {actionData?.fieldErrors?.email ? (
                    <span className="field-error">{actionData.fieldErrors.email}</span>
                  ) : null}
                </label>

                <label className="field-label">
                  電話番号
                  <input
                    className="field-input"
                    name="phone"
                    placeholder="09012345678"
                    value={customer.phone}
                    onChange={(event) =>
                      setCustomer((current) => ({ ...current, phone: event.target.value }))
                    }
                  />
                  {actionData?.fieldErrors?.phone ? (
                    <span className="field-error">{actionData.fieldErrors.phone}</span>
                  ) : null}
                </label>
              </div>

              <h3 className="storefront-subtitle">配送先住所</h3>
              <div className="field-stack">
                <label className="field-label">
                  住所1
                  <input
                    className="field-input"
                    name="address1"
                    placeholder="Jingumae 1-2-3"
                    value={shippingAddress.address1}
                    onChange={(event) =>
                      setShippingAddress((current) => ({
                        ...current,
                        address1: event.target.value,
                      }))
                    }
                  />
                  {actionData?.fieldErrors?.address1 ? (
                    <span className="field-error">{actionData.fieldErrors.address1}</span>
                  ) : null}
                </label>

                <label className="field-label">
                  住所2
                  <input
                    className="field-input"
                    name="address2"
                    value={shippingAddress.address2}
                    onChange={(event) =>
                      setShippingAddress((current) => ({
                        ...current,
                        address2: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>

              <div className="field-grid">
                <label className="field-label">
                  市区町村
                  <input
                    className="field-input"
                    name="city"
                    placeholder="Shibuya"
                    value={shippingAddress.city}
                    onChange={(event) =>
                      setShippingAddress((current) => ({ ...current, city: event.target.value }))
                    }
                  />
                  {actionData?.fieldErrors?.city ? (
                    <span className="field-error">{actionData.fieldErrors.city}</span>
                  ) : null}
                </label>

                <label className="field-label">
                  都道府県
                  <input
                    className="field-input"
                    name="province"
                    placeholder="Tokyo"
                    value={shippingAddress.province}
                    onChange={(event) =>
                      setShippingAddress((current) => ({
                        ...current,
                        province: event.target.value,
                      }))
                    }
                  />
                  {actionData?.fieldErrors?.province ? (
                    <span className="field-error">{actionData.fieldErrors.province}</span>
                  ) : null}
                </label>
              </div>

              <div className="field-grid">
                <label className="field-label">
                  郵便番号
                  <input
                    className="field-input"
                    name="postalCode"
                    placeholder="150-0001"
                    value={shippingAddress.postalCode}
                    onChange={(event) =>
                      setShippingAddress((current) => ({
                        ...current,
                        postalCode: event.target.value,
                      }))
                    }
                  />
                  {actionData?.fieldErrors?.postalCode ? (
                    <span className="field-error">{actionData.fieldErrors.postalCode}</span>
                  ) : null}
                </label>

                <label className="field-label">
                  国コード
                  <input
                    className="field-input"
                    name="country"
                    placeholder="JP"
                    value={shippingAddress.country}
                    onChange={(event) =>
                      setShippingAddress((current) => ({
                        ...current,
                        country: event.target.value,
                      }))
                    }
                  />
                  {actionData?.fieldErrors?.country ? (
                    <span className="field-error">{actionData.fieldErrors.country}</span>
                  ) : null}
                </label>
              </div>

              <label className="field-label">
                注文メモ
                <textarea
                  className="field-textarea"
                  name="note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>

              {requiresImportWarning ? (
                <div className="import-warning">
                  <strong>配送先国と輸入条件の確認</strong>
                  <span>
                    この商品は国際配送商品です。購入者は配送先国における輸入制限、関税、税金、通関手続き、受取可否を確認する責任を負います。ただし、商品に欠陥がある場合、または適用法により購入者に認められる権利は、この確認により制限されません。
                  </span>
                  <label className="warning-check">
                    <input
                      type="checkbox"
                      name="importResponsibilityAccepted"
                      checked={importResponsibilityAccepted}
                      onChange={(event) => setImportResponsibilityAccepted(event.target.checked)}
                    />
                    配送先国と輸入条件を確認しました
                  </label>
                  {actionData?.fieldErrors?.importResponsibility ? (
                    <span className="field-error">
                      {actionData.fieldErrors.importResponsibility}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <button className="checkout-submit" type="submit" disabled={isSubmitting}>
                {isSubmitting ? '決済画面を準備中...' : '送料つきで決済へ進む'}
              </button>
            </Form>
          </section>
        </div>
      </div>
    </div>
  );
}
