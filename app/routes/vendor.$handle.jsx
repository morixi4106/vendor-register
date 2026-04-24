import { Form, Link, useActionData, useLoaderData, useNavigation } from '@remix-run/react';
import { useMemo, useState } from 'react';

import {
  createVendorStorefrontAction,
  createVendorStorefrontLoader,
} from '../services/vendorStorefront.server.js';

export const loader = createVendorStorefrontLoader();
export const action = createVendorStorefrontAction();

function formatMoney(amount, currencyCode = 'JPY') {
  const numeric = Number(amount || 0);

  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `ﾂ･${Math.round(numeric).toLocaleString('ja-JP')}`;
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

  const selectedCount = useMemo(
    () =>
      Object.values(quantities).reduce((sum, value) => {
        const numeric = Number(value);
        return sum + (Number.isInteger(numeric) && numeric > 0 ? numeric : 0);
      }, 0),
    [quantities],
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
        .checkout-submit{width:100%;height:56px;border:none;border-radius:999px;background:#221a15;color:#fff;font-size:16px;font-weight:900;cursor:pointer;}
        .checkout-submit:disabled{cursor:not-allowed;opacity:0.65;}
        @media (max-width: 960px){.storefront-grid{grid-template-columns:1fr;}.product-card{grid-template-columns:96px 1fr;}.product-side{grid-column:1 / -1;justify-items:start;}}
        @media (max-width: 640px){.storefront-shell{padding:20px 14px 48px;}.storefront-hero,.storefront-card{padding:18px;border-radius:20px;}.field-grid{grid-template-columns:1fr;}.product-card{grid-template-columns:1fr;}.product-image,.product-image-placeholder{width:100%;height:200px;}}
      `}</style>

      <div className="storefront-shell">
        <Link className="storefront-back" to="/vendors">
          竊・蜃ｺ蠎苓・ｸ隕ｧ縺ｫ謌ｻ繧・
        </Link>

        <section className="storefront-hero">
          <p className="storefront-kicker">Customer Checkout</p>
          <h1 className="storefront-title">{store.storeName}</h1>
          <div className="storefront-meta">
            <span className="storefront-chip">{store.country}</span>
            <span className="storefront-chip">{store.category}</span>
            <span className="storefront-chip">{products.length} products</span>
          </div>
          {store.note ? <p className="storefront-note">{store.note}</p> : null}
        </section>

        <div className="storefront-grid">
          <section className="storefront-card">
            <h2 className="storefront-section-title">蝠・刀繧帝∈縺ｶ</h2>
            <p className="storefront-section-sub">謨ｰ驥上ｒ謖・ｮ壹＠縺ｦ縺昴・縺ｾ縺ｾ豎ｺ貂医∈騾ｲ縺ｿ縺ｾ縺吶る∵侭縺ｯ驟埼∝・蜈･蜉帛ｾ後↓險育ｮ励＆繧後∵ｱｺ貂育判髱｢縺ｧ陦ｨ遉ｺ縺輔ｌ縺ｾ縺吶・</p>

            <div className="product-list">
              {products.map((product) => (
                <article className="product-card" key={product.id}>
                  {product.imageUrl ? (
                    <img className="product-image" src={product.imageUrl} alt={product.name} />
                  ) : (
                    <div className="product-image-placeholder">ITEM</div>
                  )}

                  <div>
                    <h3 className="product-title">{product.name}</h3>
                    <p className="product-description">{product.description || '縺薙・蝠・刀縺ｯ蠎苓・縺ｮ豁｣隕丞ｰ守ｷ壹°繧芽ｳｼ蜈･縺ｧ縺阪∪縺吶・'}</p>
                  </div>

                  <div className="product-side">
                    <div className="product-price">{formatMoney(product.price)}</div>
                    <label className="quantity-label">
                      謨ｰ驥・
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
                    {!product.isPurchasable ? <div className="product-disabled">迴ｾ蝨ｨ縺ｯ雉ｼ蜈･貅門ｙ荳ｭ縺ｧ縺・</div> : null}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="storefront-card">
            <h2 className="storefront-section-title">驟埼∝・縺ｨ縺雁ｮ｢讒俶ュ蝣ｱ</h2>
            <p className="storefront-section-sub">蜈･蜉帛・螳ｹ縺九ｉ checkout payload 繧堤ｵ・∩遶九※縲√◎縺ｮ縺ｾ縺ｾ豎ｺ貂亥ｰ守ｷ壹∈驕ｷ遘ｻ縺励∪縺吶・</p>

            {actionData?.error ? (
              <div className="storefront-error">
                <strong>豎ｺ貂医ｒ髢句ｧ九〒縺阪∪縺帙ｓ縺ｧ縺励◆縲・</strong>
                <div>{actionData.error}</div>
              </div>
            ) : null}

            <Form className="checkout-form" method="post">
              <div className="checkout-summary">
                <strong>{selectedCount} 轤ｹ繧帝∈謚樔ｸｭ</strong>
                <span>submit 縺ｯ 1 蝗槭□縺大ｮ溯｡後＆繧後∵・蜉滓凾縺ｯ invoice URL 縺ｸ縺昴・縺ｾ縺ｾ驕ｷ遘ｻ縺励∪縺吶・</span>
                {actionData?.fieldErrors?.cart ? (
                  <div className="field-error" style={{ marginTop: '8px' }}>
                    {actionData.fieldErrors.cart}
                  </div>
                ) : null}
              </div>

              <div className="field-grid">
                <label className="field-label">
                  蟋・
                  <input className="field-input" name="lastName" value={customer.lastName} onChange={(event) => setCustomer((current) => ({ ...current, lastName: event.target.value }))} />
                  {actionData?.fieldErrors?.lastName ? <span className="field-error">{actionData.fieldErrors.lastName}</span> : null}
                </label>

                <label className="field-label">
                  蜷・
                  <input className="field-input" name="firstName" value={customer.firstName} onChange={(event) => setCustomer((current) => ({ ...current, firstName: event.target.value }))} />
                  {actionData?.fieldErrors?.firstName ? <span className="field-error">{actionData.fieldErrors.firstName}</span> : null}
                </label>
              </div>

              <div className="field-stack">
                <label className="field-label">
                  繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ
                  <input className="field-input" type="email" name="email" value={customer.email} onChange={(event) => setCustomer((current) => ({ ...current, email: event.target.value }))} />
                  {actionData?.fieldErrors?.email ? <span className="field-error">{actionData.fieldErrors.email}</span> : null}
                </label>

                <label className="field-label">
                  髮ｻ隧ｱ逡ｪ蜿ｷ
                  <input className="field-input" name="phone" value={customer.phone} onChange={(event) => setCustomer((current) => ({ ...current, phone: event.target.value }))} />
                  {actionData?.fieldErrors?.phone ? <span className="field-error">{actionData.fieldErrors.phone}</span> : null}
                </label>
              </div>

              <div className="field-stack">
                <label className="field-label">
                  菴乗園1
                  <input className="field-input" name="address1" value={shippingAddress.address1} onChange={(event) => setShippingAddress((current) => ({ ...current, address1: event.target.value }))} />
                  {actionData?.fieldErrors?.address1 ? <span className="field-error">{actionData.fieldErrors.address1}</span> : null}
                </label>

                <label className="field-label">
                  菴乗園2
                  <input className="field-input" name="address2" value={shippingAddress.address2} onChange={(event) => setShippingAddress((current) => ({ ...current, address2: event.target.value }))} />
                </label>
              </div>

              <div className="field-grid">
                <label className="field-label">
                  蟶ょ玄逕ｺ譚・
                  <input className="field-input" name="city" value={shippingAddress.city} onChange={(event) => setShippingAddress((current) => ({ ...current, city: event.target.value }))} />
                  {actionData?.fieldErrors?.city ? <span className="field-error">{actionData.fieldErrors.city}</span> : null}
                </label>

                <label className="field-label">
                  驛ｽ驕灘ｺ懃恁
                  <input className="field-input" name="province" value={shippingAddress.province} onChange={(event) => setShippingAddress((current) => ({ ...current, province: event.target.value }))} />
                  {actionData?.fieldErrors?.province ? <span className="field-error">{actionData.fieldErrors.province}</span> : null}
                </label>
              </div>

              <div className="field-grid">
                <label className="field-label">
                  驛ｵ萓ｿ逡ｪ蜿ｷ
                  <input className="field-input" name="postalCode" value={shippingAddress.postalCode} onChange={(event) => setShippingAddress((current) => ({ ...current, postalCode: event.target.value }))} />
                  {actionData?.fieldErrors?.postalCode ? <span className="field-error">{actionData.fieldErrors.postalCode}</span> : null}
                </label>

                <label className="field-label">
                  蝗ｽ繧ｳ繝ｼ繝・
                  <input className="field-input" name="country" value={shippingAddress.country} onChange={(event) => setShippingAddress((current) => ({ ...current, country: event.target.value }))} />
                  {actionData?.fieldErrors?.country ? <span className="field-error">{actionData.fieldErrors.country}</span> : null}
                </label>
              </div>

              <label className="field-label">
                豕ｨ譁・Γ繝｢
                <textarea className="field-textarea" name="note" value={note} onChange={(event) => setNote(event.target.value)} />
              </label>

              <button className="checkout-submit" type="submit" disabled={isSubmitting}>
                {isSubmitting ? '豎ｺ貂亥ｰ守ｷ壹ｒ貅門ｙ荳ｭ...' : '騾∵侭縺､縺阪〒豎ｺ貂医∈騾ｲ繧'}
              </button>
            </Form>
          </section>
        </div>
      </div>
    </div>
  );
}
