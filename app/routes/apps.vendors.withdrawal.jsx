import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";

import {
  createWithdrawalRequestFromForm,
} from "../services/withdrawals.server.js";
import { authenticate } from "../shopify.server";

const COUNTRY_OPTIONS = [
  ["AT", "Austria"],
  ["BE", "Belgium"],
  ["BG", "Bulgaria"],
  ["HR", "Croatia"],
  ["CY", "Cyprus"],
  ["CZ", "Czechia"],
  ["DK", "Denmark"],
  ["EE", "Estonia"],
  ["FI", "Finland"],
  ["FR", "France"],
  ["DE", "Germany"],
  ["GR", "Greece"],
  ["HU", "Hungary"],
  ["IE", "Ireland"],
  ["IT", "Italy"],
  ["LV", "Latvia"],
  ["LT", "Lithuania"],
  ["LU", "Luxembourg"],
  ["MT", "Malta"],
  ["NL", "Netherlands"],
  ["PL", "Poland"],
  ["PT", "Portugal"],
  ["RO", "Romania"],
  ["SK", "Slovakia"],
  ["SI", "Slovenia"],
  ["ES", "Spain"],
  ["SE", "Sweden"],
  ["JP", "Japan"],
  ["US", "United States"],
  ["GB", "United Kingdom"],
];

export const loader = async ({ request }) => {
  const shopDomain = await authenticateAppProxyShop(request);
  const url = new URL(request.url);
  const orderNumber =
    url.searchParams.get("orderNumber") || url.searchParams.get("order") || "";
  const customerEmail =
    url.searchParams.get("customerEmail") || url.searchParams.get("email") || "";

  return json({
    shopDomain,
    embedded: isEmbeddedRequest(request),
    initialValues: {
      orderNumber,
      customerEmail,
    },
  });
};

export const action = async ({ request }) => {
  const shopDomain = await authenticateAppProxyShop(request);
  const formData = await request.formData();
  const result = await createWithdrawalRequestFromForm({
    request,
    formData,
    shopDomain,
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        errors: result.errors || { form: "送信できませんでした。" },
        values: result.values || {},
      },
      { status: result.status || 400 },
    );
  }

  const successUrl = new URL("/apps/vendors/withdrawal/success", request.url);
  successUrl.searchParams.set("ref", result.withdrawalRequest.id);
  if (isEmbeddedRequest(request, formData)) {
    successUrl.searchParams.set("embedded", "1");
  }
  if (result.duplicate) {
    successUrl.searchParams.set("duplicate", "1");
  }

  return redirect(successUrl.pathname + successUrl.search);
};

async function authenticateAppProxyShop(request) {
  const { session } = await authenticate.public.appProxy(request);

  if (!session?.shop) {
    throw new Response("Unauthorized", { status: 401 });
  }

  return session.shop;
}

export default function WithdrawalFormPage() {
  const { shopDomain, embedded, initialValues } = useLoaderData();
  const actionData = useActionData();
  const [isConfirming, setIsConfirming] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const errors = actionData?.errors || {};
  const values = {
    ...(initialValues || {}),
    ...(actionData?.values || {}),
  };
  const countryOptions = useMemo(() => COUNTRY_OPTIONS, []);

  useEmbeddedFrameBehavior(embedded, [isConfirming, actionData]);

  function handlePreview(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextSnapshot = Object.fromEntries(formData.entries());
    setSnapshot(nextSnapshot);
    setIsConfirming(true);

    if (embedded && typeof window !== "undefined") {
      window.parent?.postMessage({ type: "vendorWithdrawalScrollIntoView" }, "*");
    } else if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  return (
    <main className={`withdrawal-page${embedded ? " withdrawal-page--embedded" : ""}`}>
      <style>{pageStyles}</style>

      {!embedded ? (
        <section className="withdrawal-card withdrawal-hero">
          <h1>EUのお客様向け撤回申請</h1>
          <p>
            EUのお客様は、対象となるオンライン購入について、商品を受け取った日から14日以内であれば撤回申請を行える場合があります。
          </p>
          <p>
            申請後、注文内容・返送状況・商品状態を確認したうえで、キャンセルまたは返金手続きを進めます。
          </p>
          <div className="withdrawal-note">
            <strong>返金は自動実行されません。</strong>
            <span>
              撤回が認められる場合、商品代金および通常配送方法に相当する初回送料を返金対象として確認します。通常配送より高い配送方法を選択された場合、その追加費用は返金対象外となる場合があります。商品の返送にかかる送料は、当店が別途負担すると案内した場合、または法令により当店負担となる場合を除き、お客様負担となる場合があります。商品の確認に必要な範囲を超えて使用・汚損・破損がある場合、返金額が減額されることがあります。
            </span>
          </div>
        </section>
      ) : null}

      {errors.form ? <div className="withdrawal-alert">{errors.form}</div> : null}

      {!isConfirming ? (
        <section className="withdrawal-card">
          {!embedded ? <h2>申請内容を入力</h2> : null}
          <Form method="post" className="withdrawal-form" onSubmit={handlePreview}>
            <input type="hidden" name="shopDomain" value={shopDomain || ""} />
            {embedded ? <input type="hidden" name="embedded" value="1" /> : null}
            <Field
              label="氏名"
              name="customerName"
              defaultValue={values.customerName}
              error={errors.customerName}
              required
            />
            <Field
              label="メールアドレス"
              type="email"
              name="customerEmail"
              defaultValue={values.customerEmail}
              error={errors.customerEmail}
              required
            />
            <Field
              label="注文番号"
              name="orderNumber"
              placeholder="#1001"
              defaultValue={values.orderNumber}
              error={errors.orderNumber}
              required
            />
            <Field
              label="電話番号 任意"
              name="customerPhone"
              defaultValue={values.customerPhone}
            />
            <label className="withdrawal-field">
              <span>居住国または配送先国</span>
              <select
                name="countryCode"
                defaultValue={values.countryCode || ""}
                required
              >
                <option value="">選択してください</option>
                {countryOptions.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              {errors.countryCode ? (
                <em className="withdrawal-error">{errors.countryCode}</em>
              ) : null}
            </label>
            <Field
              label="商品を受け取った日 任意"
              type="date"
              name="receivedDate"
              defaultValue={values.receivedDate}
            />
            <label className="withdrawal-field">
              <span>撤回対象</span>
              <select name="withdrawalScope" defaultValue={values.withdrawalScope || "FULL"}>
                <option value="FULL">注文全体</option>
                <option value="PARTIAL">一部の商品</option>
              </select>
            </label>
            <label className="withdrawal-field withdrawal-field--wide">
              <span>撤回したい商品</span>
              <textarea
                name="itemText"
                rows="4"
                defaultValue={values.itemText || ""}
                placeholder="一部商品の場合は、商品名や数量を入力してください。注文全体の場合は「注文全体」と入力しても構いません。"
              />
              {errors.itemText ? (
                <em className="withdrawal-error">{errors.itemText}</em>
              ) : null}
            </label>
            <label className="withdrawal-field withdrawal-field--wide">
              <span>現在の商品状態 任意</span>
              <textarea
                name="itemCondition"
                rows="3"
                defaultValue={values.itemCondition || ""}
                placeholder="未使用、開封済み、試着のみ、破損あり等"
              />
            </label>
            <label className="withdrawal-field withdrawal-field--wide">
              <span>撤回理由 任意</span>
              <textarea
                name="reason"
                rows="3"
                defaultValue={values.reason || ""}
                placeholder="理由の記載は任意です。"
              />
            </label>
            <div className="withdrawal-actions">
              <button type="submit">入力内容を確認する</button>
            </div>
          </Form>
        </section>
      ) : (
        <section className="withdrawal-card">
          <h2>入力内容の確認</h2>
          <p className="withdrawal-subtle">
            内容を確認し、問題なければ「撤回を確定して送信する」を押してください。
          </p>
          <dl className="withdrawal-confirm-list">
            <ConfirmRow label="氏名" value={snapshot.customerName} />
            <ConfirmRow label="メールアドレス" value={snapshot.customerEmail} />
            <ConfirmRow label="注文番号" value={snapshot.orderNumber} />
            <ConfirmRow label="国" value={snapshot.countryCode} />
            <ConfirmRow
              label="撤回対象"
              value={snapshot.withdrawalScope === "PARTIAL" ? "一部の商品" : "注文全体"}
            />
            <ConfirmRow label="撤回したい商品" value={snapshot.itemText || "注文全体"} />
            <ConfirmRow label="商品状態" value={snapshot.itemCondition || "-"} />
            <ConfirmRow label="理由" value={snapshot.reason || "-"} />
          </dl>
          <Form method="post" className="withdrawal-actions">
            {Object.entries(snapshot).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value || ""} />
            ))}
            {embedded ? <input type="hidden" name="embedded" value="1" /> : null}
            <button type="button" className="secondary" onClick={() => setIsConfirming(false)}>
              修正する
            </button>
            <button type="submit">撤回を確定して送信する</button>
          </Form>
        </section>
      )}
    </main>
  );
}

function isEmbeddedRequest(request, formData = null) {
  const url = new URL(request.url);
  return url.searchParams.get("embedded") === "1" || formData?.get("embedded") === "1";
}

function useEmbeddedFrameBehavior(embedded, dependencies) {
  useEffect(() => {
    if (!embedded || typeof window === "undefined") return undefined;

    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    let resizeObserver = null;
    let timeoutId = null;

    function postFrameHeight() {
      const height = Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
      );

      window.parent?.postMessage(
        {
          type: "vendorWithdrawalFrameHeight",
          height,
        },
        "*",
      );
    }

    postFrameHeight();
    timeoutId = window.setTimeout(postFrameHeight, 150);

    if (typeof ResizeObserver !== "undefined" && document.body) {
      resizeObserver = new ResizeObserver(postFrameHeight);
      resizeObserver.observe(document.body);
    }

    window.addEventListener("resize", postFrameHeight);

    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
      if (timeoutId) window.clearTimeout(timeoutId);
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener("resize", postFrameHeight);
    };
  }, [embedded, ...dependencies]);
}

function Field({ label, name, type = "text", defaultValue, error, required, placeholder }) {
  const normalizedDefaultValue =
    type === "date" ? formatDateInputValue(defaultValue) : defaultValue || "";

  return (
    <label className="withdrawal-field">
      <span>{label}</span>
      <input
        type={type}
        name={name}
        defaultValue={normalizedDefaultValue}
        required={required}
        placeholder={placeholder}
      />
      {error ? <em className="withdrawal-error">{error}</em> : null}
    </label>
  );
}

function formatDateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function ConfirmRow({ label, value }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || "-"}</dd>
    </>
  );
}

const pageStyles = `
  .withdrawal-page{
    min-height:100vh;
    background:#f4f5f7;
    color:#111827;
    font-family:system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding:32px 16px 64px;
  }
  .withdrawal-page--embedded{
    min-height:auto;
    padding:0;
    background:transparent;
    overflow:hidden;
  }
  .withdrawal-page--embedded .withdrawal-card,
  .withdrawal-page--embedded .withdrawal-alert{
    max-width:none;
  }
  .withdrawal-page--embedded .withdrawal-card:first-of-type{
    margin-top:0;
  }
  .withdrawal-card{
    max-width:860px;
    margin:0 auto 20px;
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:18px;
    padding:28px;
    box-sizing:border-box;
  }
  .withdrawal-hero h1{
    margin:0 0 12px;
    font-size:32px;
    line-height:1.25;
  }
  .withdrawal-hero p,
  .withdrawal-subtle{
    color:#4b5563;
    line-height:1.8;
  }
  .withdrawal-note{
    display:grid;
    gap:6px;
    margin-top:18px;
    padding:16px;
    border-radius:14px;
    background:#fffbeb;
    border:1px solid #fde68a;
    color:#92400e;
    line-height:1.7;
  }
  .withdrawal-alert{
    max-width:860px;
    margin:0 auto 20px;
    padding:14px 16px;
    border:1px solid #fecaca;
    border-radius:14px;
    background:#fef2f2;
    color:#b91c1c;
    font-weight:700;
  }
  .withdrawal-form{
    display:grid;
    grid-template-columns:repeat(2, minmax(0, 1fr));
    gap:16px;
  }
  .withdrawal-field{
    display:grid;
    gap:7px;
    color:#374151;
    font-weight:700;
  }
  .withdrawal-field--wide{
    grid-column:1 / -1;
  }
  .withdrawal-field input,
  .withdrawal-field select,
  .withdrawal-field textarea{
    width:100%;
    box-sizing:border-box;
    border:1px solid #d1d5db;
    border-radius:12px;
    padding:12px 13px;
    font:inherit;
    color:#111827;
    background:#fff;
  }
  .withdrawal-error{
    color:#b91c1c;
    font-size:13px;
    font-style:normal;
  }
  .withdrawal-actions{
    grid-column:1 / -1;
    display:flex;
    justify-content:flex-end;
    gap:12px;
    flex-wrap:wrap;
    margin-top:8px;
  }
  .withdrawal-actions button{
    min-height:46px;
    border:1px solid #111827;
    border-radius:999px;
    padding:0 18px;
    background:#111827;
    color:#fff;
    font-weight:800;
    cursor:pointer;
  }
  .withdrawal-actions button.secondary{
    background:#fff;
    color:#111827;
    border-color:#d1d5db;
  }
  .withdrawal-confirm-list{
    display:grid;
    grid-template-columns:180px minmax(0, 1fr);
    border:1px solid #e5e7eb;
    border-radius:14px;
    overflow:hidden;
  }
  .withdrawal-confirm-list dt,
  .withdrawal-confirm-list dd{
    margin:0;
    padding:13px 15px;
    border-top:1px solid #e5e7eb;
    line-height:1.6;
  }
  .withdrawal-confirm-list dt:nth-of-type(1),
  .withdrawal-confirm-list dd:nth-of-type(1){
    border-top:none;
  }
  .withdrawal-confirm-list dt{
    background:#f9fafb;
    color:#4b5563;
    font-weight:800;
  }
  .withdrawal-confirm-list dd{
    overflow-wrap:anywhere;
  }
  @media (max-width:720px){
    .withdrawal-card{
      padding:22px;
      border-radius:14px;
    }
    .withdrawal-form,
    .withdrawal-confirm-list{
      grid-template-columns:1fr;
    }
    .withdrawal-confirm-list dt,
    .withdrawal-confirm-list dd{
      border-top:1px solid #e5e7eb;
    }
  }
`;
