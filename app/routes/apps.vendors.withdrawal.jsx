import { json, redirect } from "@remix-run/node";
import { randomUUID } from "node:crypto";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";

import {
  createWithdrawalRequestFromForm,
} from "../services/withdrawals.server.js";
import { authenticate } from "../shopify.server";
import {
  formatWithdrawalCountry,
  getWithdrawalDictionary,
  resolveWithdrawalLocale,
} from "../utils/withdrawalLocale.js";

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

const WITHDRAWAL_DRAFT_KEY = "vendor-withdrawal-form-draft-v1";
const WITHDRAWAL_DRAFT_EXCLUDED_FIELDS = new Set([
  "shopDomain",
  "correspondenceLocale",
  "localeSource",
  "submissionNonce",
  "embedded",
]);

export const loader = async ({ request }) => {
  const shopDomain = await authenticateAppProxyShop(request);
  const url = new URL(request.url);
  const orderNumber =
    url.searchParams.get("orderNumber") || url.searchParams.get("order") || "";
  const customerEmail =
    url.searchParams.get("customerEmail") || url.searchParams.get("email") || "";
  const localeResolution = resolveWithdrawalLocale({
    urlLocale: url.searchParams.get("lang"),
    shopifyLocale: url.searchParams.get("locale"),
    acceptLanguage: request.headers.get("accept-language"),
    userSelected: url.searchParams.has("lang"),
  });
  const languageLinks = Object.fromEntries(
    ["ja-JP", "en-GB"].map((language) => {
      const link = new URL(url.pathname + url.search, url.origin);
      link.searchParams.set("lang", language);
      return [language, link.pathname + link.search];
    }),
  );

  return json(
    {
      shopDomain,
      embedded: isEmbeddedRequest(request),
      locale: localeResolution.locale,
      localeSource: localeResolution.source,
      submissionNonce: randomUUID(),
      languageLinks,
      initialValues: { orderNumber, customerEmail },
    },
    { headers: { "Cache-Control": "private, no-store", Vary: "Accept-Language" } },
  );
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
    const locale = formData.get("correspondenceLocale") || "en-GB";
    return json(
      {
        ok: false,
        errors: result.errors || { form: getWithdrawalDictionary(locale).errors.form },
        values: result.values || {},
      },
      { status: result.status || 400 },
    );
  }

  const successUrl = new URL("/apps/vendors/withdrawal/success", request.url);
  successUrl.searchParams.set("receipt", result.receiptToken);
  if (isEmbeddedRequest(request, formData)) {
    successUrl.searchParams.set("embedded", "1");
  }
  if (result.duplicate) {
    successUrl.searchParams.set("duplicate", "1");
  }
  successUrl.searchParams.set(
    "lang",
    result.withdrawalRequest.correspondenceLocale || formData.get("correspondenceLocale") || "en-GB",
  );

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
  const {
    shopDomain,
    embedded,
    initialValues,
    locale,
    localeSource,
    submissionNonce,
    languageLinks,
  } =
    useLoaderData();
  const actionData = useActionData();
  const [isConfirming, setIsConfirming] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const errors = actionData?.errors || {};
  const values = {
    ...(initialValues || {}),
    ...(actionData?.values || {}),
  };
  const countryOptions = useMemo(() => COUNTRY_OPTIONS, []);
  const dictionary = getWithdrawalDictionary(locale);
  const copy = dictionary.public;

  useEmbeddedFrameBehavior(embedded, [isConfirming, actionData]);

  useEffect(() => {
    if (typeof window === "undefined" || actionData?.values) return;
    const form = document.getElementById("withdrawal-entry-form");
    if (!form) return;

    try {
      const draft = JSON.parse(window.sessionStorage.getItem(WITHDRAWAL_DRAFT_KEY) || "null");
      if (!draft || typeof draft !== "object") return;

      Object.entries(draft).forEach(([name, value]) => {
        const control = form.elements.namedItem(name);
        if (!control || typeof value !== "string") return;
        control.value = value;
      });
    } catch {
      window.sessionStorage.removeItem(WITHDRAWAL_DRAFT_KEY);
    }
  }, [locale, actionData?.values]);

  useEffect(() => {
    if (!errors.form || typeof document === "undefined") return;
    document.querySelector(".withdrawal-alert")?.focus();
  }, [errors.form]);

  function preserveDraftBeforeLanguageChange() {
    if (typeof window === "undefined") return;
    const form = document.getElementById("withdrawal-entry-form");
    if (!form) return;

    const draft = {};
    for (const [name, value] of new FormData(form).entries()) {
      if (typeof value === "string" && !WITHDRAWAL_DRAFT_EXCLUDED_FIELDS.has(name)) {
        draft[name] = value;
      }
    }
    window.sessionStorage.setItem(WITHDRAWAL_DRAFT_KEY, JSON.stringify(draft));
  }

  function clearSavedDraft() {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(WITHDRAWAL_DRAFT_KEY);
    }
  }

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

      <nav className="withdrawal-language" aria-label="Language">
        <a
          href={languageLinks["ja-JP"]}
          aria-current={locale === "ja-JP"}
          onClick={preserveDraftBeforeLanguageChange}
        >
          日本語
        </a>
        <a
          href={languageLinks["en-GB"]}
          aria-current={locale === "en-GB"}
          onClick={preserveDraftBeforeLanguageChange}
        >
          English
        </a>
      </nav>

      {!embedded ? (
        <section className="withdrawal-card withdrawal-hero">
          <span className="withdrawal-eyebrow">{copy.eyebrow}</span>
          <h1>{copy.title}</h1>
          <p>{copy.intro}</p>
          <div className="withdrawal-note">
            <strong>{copy.receiptNoticeTitle}</strong>
            <span>{copy.receiptNotice}</span>
          </div>
        </section>
      ) : null}

      {errors.form ? (
        <div className="withdrawal-alert" role="alert" tabIndex="-1">
          {errors.form}
        </div>
      ) : null}

      {!isConfirming ? (
        <section className="withdrawal-card">
          {!embedded ? <h2>{copy.formTitle}</h2> : null}
          <Form
            id="withdrawal-entry-form"
            method="post"
            className="withdrawal-form"
            onSubmit={handlePreview}
          >
            <input type="hidden" name="shopDomain" value={shopDomain || ""} />
            <input type="hidden" name="correspondenceLocale" value={locale} />
            <input type="hidden" name="localeSource" value={localeSource} />
            <input type="hidden" name="submissionNonce" value={submissionNonce} />
            {embedded ? <input type="hidden" name="embedded" value="1" /> : null}
            <Field
              label={copy.customerName}
              name="customerName"
              defaultValue={values.customerName}
              error={errors.customerName}
              required
            />
            <Field
              label={copy.customerEmail}
              type="email"
              name="customerEmail"
              defaultValue={values.customerEmail}
              error={errors.customerEmail}
              required
            />
            <Field
              label={copy.orderNumber}
              name="orderNumber"
              placeholder="#1001"
              defaultValue={values.orderNumber}
              error={errors.orderNumber}
              required
            />
            <Field
              label={copy.customerPhone}
              name="customerPhone"
              defaultValue={values.customerPhone}
            />
            <label className="withdrawal-field" htmlFor="withdrawal-countryCode">
              <span>{copy.countryCode}</span>
              <select
                id="withdrawal-countryCode"
                name="countryCode"
                defaultValue={values.countryCode || ""}
                aria-invalid={Boolean(errors.countryCode)}
                aria-describedby={errors.countryCode ? "withdrawal-countryCode-error" : undefined}
              >
                <option value="">{copy.notProvided}</option>
                {countryOptions.map(([code, label]) => (
                  <option key={code} value={code}>
                    {formatWithdrawalCountry(code, locale) || label}
                  </option>
                ))}
              </select>
              {errors.countryCode ? (
                <em
                  id="withdrawal-countryCode-error"
                  className="withdrawal-error"
                  role="alert"
                >
                  {errors.countryCode}
                </em>
              ) : null}
            </label>
            <Field
              label={copy.receivedDate}
              type="date"
              name="receivedDate"
              defaultValue={values.receivedDate}
            />
            <label className="withdrawal-field" htmlFor="withdrawal-scope">
              <span>{copy.withdrawalScope}</span>
              <select
                id="withdrawal-scope"
                name="withdrawalScope"
                defaultValue={values.withdrawalScope || "FULL"}
              >
                <option value="FULL">{copy.fullOrder}</option>
                <option value="PARTIAL">{copy.partialOrder}</option>
              </select>
            </label>
            <label
              className="withdrawal-field withdrawal-field--wide"
              htmlFor="withdrawal-itemText"
            >
              <span>{copy.itemText}</span>
              <textarea
                id="withdrawal-itemText"
                name="itemText"
                rows="4"
                defaultValue={values.itemText || ""}
                placeholder={copy.itemTextHint}
                aria-invalid={Boolean(errors.itemText)}
                aria-describedby={errors.itemText ? "withdrawal-itemText-error" : undefined}
              />
              {errors.itemText ? (
                <em
                  id="withdrawal-itemText-error"
                  className="withdrawal-error"
                  role="alert"
                >
                  {errors.itemText}
                </em>
              ) : null}
            </label>
            <label
              className="withdrawal-field withdrawal-field--wide"
              htmlFor="withdrawal-itemCondition"
            >
              <span>{copy.itemCondition}</span>
              <textarea
                id="withdrawal-itemCondition"
                name="itemCondition"
                rows="3"
                defaultValue={values.itemCondition || ""}
                placeholder={
                  locale === "ja-JP"
                    ? "未使用、開封済み、試着のみ、破損あり等"
                    : "For example: unused, opened, tried on, or damaged"
                }
              />
            </label>
            <label
              className="withdrawal-field withdrawal-field--wide"
              htmlFor="withdrawal-reason"
            >
              <span>{copy.reason}</span>
              <textarea
                id="withdrawal-reason"
                name="reason"
                rows="3"
                defaultValue={values.reason || ""}
                placeholder={copy.reason}
              />
            </label>
            <div className="withdrawal-actions">
              <button type="submit">{copy.preview}</button>
            </div>
          </Form>
        </section>
      ) : (
        <section className="withdrawal-card">
          <h2>{copy.confirmTitle}</h2>
          <p className="withdrawal-subtle">{copy.confirmHelp}</p>
          <dl className="withdrawal-confirm-list">
            <ConfirmRow label={copy.customerName} value={snapshot.customerName} />
            <ConfirmRow label={copy.customerEmail} value={snapshot.customerEmail} />
            <ConfirmRow label={copy.orderNumber} value={snapshot.orderNumber} />
            <ConfirmRow label={copy.country} value={formatWithdrawalCountry(snapshot.countryCode, locale)} />
            <ConfirmRow
              label={copy.withdrawalScope}
              value={snapshot.withdrawalScope === "PARTIAL" ? copy.partialOrder : copy.fullOrder}
            />
            <ConfirmRow label={copy.itemText} value={snapshot.itemText || copy.wholeOrder} />
            <ConfirmRow label={copy.itemCondition} value={snapshot.itemCondition || "-"} />
            <ConfirmRow label={copy.reason} value={snapshot.reason || "-"} />
          </dl>
          <Form method="post" className="withdrawal-actions" onSubmit={clearSavedDraft}>
            {Object.entries(snapshot).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value || ""} />
            ))}
            {embedded ? <input type="hidden" name="embedded" value="1" /> : null}
            <button type="button" className="secondary" onClick={() => setIsConfirming(false)}>
              {copy.edit}
            </button>
            <button type="submit">{copy.submit}</button>
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
  const inputId = `withdrawal-${name}`;
  const errorId = `${inputId}-error`;

  return (
    <label className="withdrawal-field" htmlFor={inputId}>
      <span>{label}</span>
      <input
        id={inputId}
        type={type}
        name={name}
        defaultValue={normalizedDefaultValue}
        required={required}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      />
      {error ? (
        <em id={errorId} className="withdrawal-error" role="alert">
          {error}
        </em>
      ) : null}
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
  .withdrawal-language{
    max-width:860px;
    margin:0 auto 12px;
    display:flex;
    justify-content:flex-end;
    gap:6px;
  }
  .withdrawal-language a{
    color:#374151;
    text-decoration:none;
    padding:7px 10px;
    border:1px solid transparent;
    border-radius:6px;
  }
  .withdrawal-language a[aria-current="true"]{
    color:#111827;
    border-color:#d1d5db;
    background:#fff;
    font-weight:700;
  }
  .withdrawal-eyebrow{
    display:block;
    margin-bottom:8px;
    color:#4b5563;
    font-size:13px;
    font-weight:800;
  }
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
