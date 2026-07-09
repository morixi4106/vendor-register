import { json, redirect } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { useEffect } from "react";

import {
  findWithdrawalReturnProofRequest,
  submitWithdrawalReturnProof,
} from "../services/withdrawals.server.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const requestId =
    url.searchParams.get("request") || url.searchParams.get("ref") || "";
  const token = url.searchParams.get("token") || "";
  const result = await findWithdrawalReturnProofRequest({ requestId, token });

  return json(
    {
      ok: result.ok,
      error: result.error || null,
      embedded: isEmbeddedRequest(request),
      requestId,
      token,
      withdrawalRequest: result.withdrawalRequest
        ? serializeReturnProofRequest(result.withdrawalRequest)
        : null,
    },
    { status: result.ok ? 200 : result.status || 404 },
  );
};

export const action = async ({ request }) => {
  const url = new URL(request.url);
  const formData = await request.formData();
  const requestId =
    String(formData.get("requestId") || "") ||
    url.searchParams.get("request") ||
    url.searchParams.get("ref") ||
    "";
  const token =
    String(formData.get("token") || "") || url.searchParams.get("token") || "";
  const result = await submitWithdrawalReturnProof({
    requestId,
    token,
    formData,
    request,
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        error: result.error || "return_proof_submit_failed",
        errors: result.errors || {},
        values: Object.fromEntries(formData),
      },
      { status: result.status || 400 },
    );
  }

  const successUrl = new URL(
    "/apps/vendors/withdrawal/return-proof/success",
    request.url,
  );
  successUrl.searchParams.set("ref", result.withdrawalRequest.id);
  if (isEmbeddedRequest(request, formData)) {
    successUrl.searchParams.set("embedded", "1");
  }

  return redirect(successUrl.pathname + successUrl.search);
};

export default function ReturnProofPage() {
  const { ok, error, embedded, requestId, token, withdrawalRequest } =
    useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const values = actionData?.values || {};
  const errors = actionData?.errors || {};

  useFrameHeight(embedded, actionData);

  return (
    <main
      className={`return-proof-page${
        embedded ? " return-proof-page--embedded" : ""
      }`}
    >
      <style>{pageStyles}</style>
      <section className="return-proof-card">
        <p className="return-proof-eyebrow">EU RIGHT OF WITHDRAWAL</p>
        <h1>返送証明の提出</h1>
        {!ok ? (
          <div className="return-proof-alert">{getErrorMessage(error)}</div>
        ) : (
          <>
            <p className="return-proof-lead">
              商品を返送したあと、追跡番号または追跡URLを提出してください。
              提出内容を確認し、返送状況と商品状態を確認したうえで手続きを進めます。
            </p>
            <div className="return-proof-summary">
              <span>受付番号: {withdrawalRequest.id}</span>
              <span>注文番号: {withdrawalRequest.orderName}</span>
              <span>メール: {withdrawalRequest.customerEmail}</span>
            </div>

            {actionData?.error ? (
              <div className="return-proof-alert">
                {getErrorMessage(actionData.error)}
              </div>
            ) : null}

            <Form method="post" className="return-proof-form">
              <input type="hidden" name="requestId" value={requestId} />
              <input type="hidden" name="token" value={token} />
              {embedded ? (
                <input type="hidden" name="embedded" value="1" />
              ) : null}
              <label>
                <span>配送会社</span>
                <input
                  name="returnTrackingCompany"
                  placeholder="Japan Post / DHL / UPS など"
                  defaultValue={
                    values.returnTrackingCompany ||
                    withdrawalRequest.returnTrackingCompany ||
                    ""
                  }
                />
              </label>
              <label>
                <span>追跡番号</span>
                <input
                  name="returnTrackingNumber"
                  placeholder="例: TEST123456789JP"
                  defaultValue={
                    values.returnTrackingNumber ||
                    withdrawalRequest.returnTrackingNumber ||
                    ""
                  }
                />
                {errors.returnTrackingNumber ? (
                  <em>追跡番号または追跡URLのどちらかを入力してください。</em>
                ) : null}
              </label>
              <label>
                <span>追跡URL</span>
                <input
                  name="returnTrackingUrl"
                  type="url"
                  placeholder="https://..."
                  defaultValue={
                    values.returnTrackingUrl ||
                    withdrawalRequest.returnTrackingUrl ||
                    ""
                  }
                />
              </label>
              <label>
                <span>補足メモ</span>
                <textarea
                  name="customerMemo"
                  rows="4"
                  placeholder="返送日や補足事項があれば入力してください。"
                  defaultValue={values.customerMemo || ""}
                />
              </label>
              <div className="return-proof-note">
                返送証明の提出だけでは返金は自動実行されません。
                通常配送分の初回送料は返金対象として確認しますが、
                追加配送費用や返送送料はお客様負担となる場合があります。
              </div>
              <button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "送信中..." : "返送証明を提出する"}
              </button>
            </Form>
          </>
        )}
      </section>
    </main>
  );
}

function serializeReturnProofRequest(request) {
  return {
    id: request.id,
    orderName: request.shopifyOrderName || request.shopifyOrderNumber || "-",
    customerEmail: maskEmail(request.customerEmail),
    returnTrackingCompany: request.returnTrackingCompany || "",
    returnTrackingNumber: request.returnTrackingNumber || "",
    returnTrackingUrl: request.returnTrackingUrl || "",
  };
}

function maskEmail(email) {
  const value = String(email || "");
  const [name, domain] = value.split("@");
  if (!name || !domain) return value || "-";
  return `${name.slice(0, 2)}***@${domain}`;
}

function getErrorMessage(error) {
  switch (error) {
    case "return_proof_link_expired":
      return "この返送証明リンクは期限切れです。サポートへお問い合わせください。";
    case "withdrawal_request_closed":
      return "この撤回申請はすでに処理済み、または受付終了しています。";
    case "invalid_return_proof":
      return "入力内容を確認してください。";
    case "invalid_return_proof_link":
    default:
      return "返送証明リンクを確認できませんでした。メール内のリンクを開き直してください。";
  }
}

function isEmbeddedRequest(request, formData = null) {
  const url = new URL(request.url);
  return (
    url.searchParams.get("embedded") === "1" ||
    formData?.get?.("embedded") === "1"
  );
}

function useFrameHeight(embedded, dependency) {
  useEffect(() => {
    if (!embedded || typeof window === "undefined") return undefined;

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
    const timeoutId = window.setTimeout(postFrameHeight, 150);
    window.addEventListener("resize", postFrameHeight);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("resize", postFrameHeight);
    };
  }, [embedded, dependency]);
}

const pageStyles = `
  .return-proof-page{
    min-height:100vh;
    display:grid;
    place-items:start center;
    padding:48px 18px;
    background:#f8fafc;
    color:#0f172a;
    font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  }
  .return-proof-page--embedded{
    min-height:auto;
    padding:0;
    background:transparent;
  }
  .return-proof-card{
    width:min(760px,100%);
    border:1px solid #dbe3ee;
    border-radius:18px;
    background:#fff;
    padding:34px;
    box-sizing:border-box;
  }
  .return-proof-eyebrow{
    margin:0 0 10px;
    color:#475569;
    font-size:12px;
    font-weight:900;
    letter-spacing:.08em;
  }
  .return-proof-card h1{
    margin:0 0 18px;
    font-size:34px;
    line-height:1.2;
  }
  .return-proof-lead{
    margin:0 0 18px;
    line-height:1.8;
    color:#334155;
  }
  .return-proof-summary{
    display:grid;
    gap:6px;
    margin:0 0 22px;
    border:1px solid #e2e8f0;
    border-radius:14px;
    padding:14px 16px;
    background:#f8fafc;
    color:#334155;
    font-size:14px;
  }
  .return-proof-form{
    display:grid;
    gap:16px;
  }
  .return-proof-form label{
    display:grid;
    gap:7px;
    font-weight:800;
    color:#334155;
  }
  .return-proof-form input,
  .return-proof-form textarea{
    width:100%;
    box-sizing:border-box;
    border:1px solid #cbd5e1;
    border-radius:12px;
    padding:13px 14px;
    font:inherit;
    color:#0f172a;
  }
  .return-proof-form em{
    color:#b91c1c;
    font-size:13px;
    font-style:normal;
  }
  .return-proof-note{
    border:1px solid #facc15;
    border-radius:14px;
    background:#fffbeb;
    color:#92400e;
    padding:14px 16px;
    line-height:1.7;
  }
  .return-proof-alert{
    border:1px solid #fecaca;
    border-radius:14px;
    background:#fef2f2;
    color:#b91c1c;
    padding:14px 16px;
    line-height:1.7;
    font-weight:700;
  }
  .return-proof-form button{
    justify-self:start;
    min-height:46px;
    border:1px solid #111827;
    border-radius:999px;
    background:#111827;
    color:#fff;
    padding:0 22px;
    font-weight:900;
    cursor:pointer;
  }
  .return-proof-form button:disabled{
    opacity:.6;
    cursor:wait;
  }
`;
