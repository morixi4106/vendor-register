import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect } from "react";

import {
  findWithdrawalReturnProofRequest,
  submitWithdrawalReturnProof,
} from "../services/withdrawals.server.js";
import {
  findWithdrawalGroupByToken,
  submitWithdrawalGroupShipment,
} from "../services/withdrawalDirectReturns.server.js";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticateAppProxyShop(request);
  const url = new URL(request.url);
  const requestId = url.searchParams.get("request") || url.searchParams.get("ref") || "";
  const token = url.searchParams.get("token") || "";
  const groupId = url.searchParams.get("group") || "";

  if (groupId) {
    const groupResult = await findWithdrawalGroupByToken({
      returnGroupId: groupId,
      token,
    });
    return json(
      {
        ok: groupResult.ok,
        error: groupResult.error || null,
        embedded: isEmbeddedRequest(request),
        requestId: "",
        groupId,
        token,
        workflowVersion: 2,
        withdrawalRequest: groupResult.ok
          ? serializeReturnGroup(groupResult.returnGroup)
          : null,
      },
      { status: groupResult.ok ? 200 : groupResult.status || 404 },
    );
  }

  const result = await findWithdrawalReturnProofRequest({ requestId, token });
  return json(
    {
      ok: result.ok,
      error: result.error || null,
      embedded: isEmbeddedRequest(request),
      requestId,
      token,
      groupId: "",
      workflowVersion: 1,
      withdrawalRequest: result.withdrawalRequest
        ? serializeReturnProofRequest(result.withdrawalRequest)
        : null,
    },
    { status: result.ok ? 200 : result.status || 404 },
  );
};

export const action = async ({ request }) => {
  await authenticateAppProxyShop(request);
  const url = new URL(request.url);
  const formData = await request.formData();
  const groupId =
    String(formData.get("groupId") || "") || url.searchParams.get("group") || "";
  const requestId =
    String(formData.get("requestId") || "") ||
    url.searchParams.get("request") ||
    url.searchParams.get("ref") ||
    "";
  const token =
    String(formData.get("token") || "") || url.searchParams.get("token") || "";

  if (groupId) {
    const quantities = {};
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("quantity:")) {
        quantities[key.slice("quantity:".length)] = value;
      }
    }
    const result = await submitWithdrawalGroupShipment({
      returnGroupId: groupId,
      token,
      values: {
        trackingCompany: formData.get("returnTrackingCompany"),
        trackingNumber: formData.get("returnTrackingNumber"),
        trackingUrl: formData.get("returnTrackingUrl"),
        customerMemo: formData.get("customerMemo"),
        quantities,
      },
    });
    if (!result.ok) {
      return json(
        {
          ok: false,
          error: result.error || "return_proof_submit_failed",
          errors: {},
          values: Object.fromEntries(formData),
        },
        { status: result.status || 400 },
      );
    }
    return redirectToSuccess(request, formData, result.shipment.id);
  }

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
  return redirectToSuccess(request, formData, result.withdrawalRequest.id);
};

async function authenticateAppProxyShop(request) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) throw new Response("Unauthorized", { status: 401 });
  return session.shop;
}

function redirectToSuccess(request, formData, reference) {
  const successUrl = new URL(
    "/apps/vendors/withdrawal/return-proof/success",
    request.url,
  );
  successUrl.searchParams.set("ref", reference);
  if (isEmbeddedRequest(request, formData)) successUrl.searchParams.set("embedded", "1");
  return redirect(successUrl.pathname + successUrl.search);
}

export default function ReturnProofPage() {
  const {
    ok,
    error,
    embedded,
    requestId,
    groupId,
    token,
    workflowVersion,
    withdrawalRequest,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const values = actionData?.values || {};
  const errors = actionData?.errors || {};

  useEmbeddedFrameBehavior(embedded, [actionData]);

  return (
    <main className={`return-proof-page${embedded ? " return-proof-page--embedded" : ""}`}>
      <style>{pageStyles}</style>
      <section className="return-proof-card">
        {!embedded ? <p className="return-proof-eyebrow">EU RIGHT OF WITHDRAWAL</p> : null}
        <h1>返送証明の提出</h1>
        {!ok ? (
          <div className="return-proof-alert">{getErrorMessage(error)}</div>
        ) : (
          <>
            <p className="return-proof-lead">
              商品を返送した後、配送会社と追跡番号または追跡URLを提出してください。
              複数店舗へ返送する場合は、店舗ごとに届いた案内から別々に提出します。
            </p>
            <div className="return-proof-summary">
              <span>受付番号: {withdrawalRequest.id}</span>
              <span>注文番号: {withdrawalRequest.orderName}</span>
              <span>メール: {withdrawalRequest.customerEmail}</span>
              {workflowVersion === 2 ? (
                <span>返送先店舗: {withdrawalRequest.storeName}</span>
              ) : null}
            </div>

            {actionData?.error ? (
              <div className="return-proof-alert">{getErrorMessage(actionData.error)}</div>
            ) : null}

            <Form method="post" className="return-proof-form">
              <input type="hidden" name="requestId" value={requestId} />
              <input type="hidden" name="groupId" value={groupId} />
              <input type="hidden" name="token" value={token} />
              {embedded ? <input type="hidden" name="embedded" value="1" /> : null}

              {workflowVersion === 2 ? (
                <fieldset className="return-proof-items">
                  <legend>この荷物に入れた商品</legend>
                  {withdrawalRequest.lines.map((line) => (
                    <label key={line.id}>
                      <span>
                        {line.title}（残り {line.remainingQuantity} 点）
                      </span>
                      <input
                        name={`quantity:${line.id}`}
                        type="number"
                        inputMode="numeric"
                        min="0"
                        max={line.remainingQuantity}
                        defaultValue={
                          values[`quantity:${line.id}`] ?? line.remainingQuantity
                        }
                      />
                    </label>
                  ))}
                </fieldset>
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
                    values.returnTrackingUrl || withdrawalRequest.returnTrackingUrl || ""
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
                返送証明を提出しただけでは返金は自動実行されません。店舗での到着確認と商品状態の確認後に、運営が返金内容を決定します。
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

function serializeReturnGroup(group) {
  return {
    id: group.withdrawalRequest.id,
    orderName:
      group.withdrawalRequest.shopifyOrderName ||
      group.withdrawalRequest.shopifyOrderNumber ||
      "-",
    customerEmail: maskEmail(group.withdrawalRequest.customerEmail),
    storeName: group.storeNameSnapshot || "販売店舗",
    returnTrackingCompany: "",
    returnTrackingNumber: "",
    returnTrackingUrl: "",
    lines: (group.lines || [])
      .map((line) => ({
        id: line.id,
        title: line.requestedLine.titleSnapshot || "商品",
        remainingQuantity: Math.max(
          0,
          Number(line.instructedQuantity || 0) - Number(line.submittedQuantity || 0),
        ),
      }))
      .filter((line) => line.remainingQuantity > 0),
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
      return "この撤回申請はすでに処理済み、または受付を終了しています。";
    case "invalid_return_proof":
    case "tracking_required":
      return "追跡番号または追跡URLのどちらかを入力してください。";
    case "shipment_quantity_exceeded":
      return "入力した商品数量が返送可能な残数を超えています。";
    case "shipment_lines_required":
      return "この荷物に入れた商品の数量を入力してください。";
    case "invalid_access_link":
    case "invalid_return_proof_link":
    default:
      return "返送証明リンクを確認できませんでした。メール内のリンクを開き直してください。";
  }
}

function isEmbeddedRequest(request, formData = null) {
  const url = new URL(request.url);
  return url.searchParams.get("embedded") === "1" || formData?.get?.("embedded") === "1";
}

function useEmbeddedFrameBehavior(embedded, dependencies) {
  useEffect(() => {
    if (!embedded || typeof window === "undefined") return undefined;

    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    function postFrameHeight() {
      const height = Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
      );
      window.parent?.postMessage({ type: "vendorWithdrawalFrameHeight", height }, "*");
    }

    postFrameHeight();
    const timeoutId = window.setTimeout(postFrameHeight, 150);
    window.addEventListener("resize", postFrameHeight);
    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
      window.clearTimeout(timeoutId);
      window.removeEventListener("resize", postFrameHeight);
    };
  }, [embedded, ...dependencies]);
}

const pageStyles = `
  .return-proof-page{min-height:100vh;display:grid;place-items:start center;padding:48px 18px;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .return-proof-page--embedded{min-height:auto;padding:0;background:transparent;overflow:hidden}
  .return-proof-card{width:min(760px,100%);border:1px solid #dbe3ee;border-radius:8px;background:#fff;padding:34px;box-sizing:border-box}
  .return-proof-page--embedded .return-proof-card{width:100%}
  .return-proof-eyebrow{margin:0 0 10px;color:#475569;font-size:12px;font-weight:900;letter-spacing:0}
  .return-proof-card h1{margin:0 0 18px;font-size:34px;line-height:1.2;letter-spacing:0}
  .return-proof-lead{margin:0 0 18px;line-height:1.8;color:#334155}
  .return-proof-summary{display:grid;gap:6px;margin:0 0 22px;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;background:#f8fafc;color:#334155;font-size:14px}
  .return-proof-form{display:grid;gap:16px}
  .return-proof-items{display:grid;gap:12px;margin:0;border:1px solid #e2e8f0;border-radius:8px;padding:16px}
  .return-proof-items legend{padding:0 6px;font-weight:900}
  .return-proof-form label{display:grid;gap:7px;font-weight:800;color:#334155}
  .return-proof-form input,.return-proof-form textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:13px 14px;font:inherit;color:#0f172a}
  .return-proof-form em{color:#b91c1c;font-size:13px;font-style:normal}
  .return-proof-note{border:1px solid #facc15;border-radius:8px;background:#fffbeb;color:#92400e;padding:14px 16px;line-height:1.7}
  .return-proof-alert{border:1px solid #fecaca;border-radius:8px;background:#fef2f2;color:#b91c1c;padding:14px 16px;line-height:1.7;font-weight:700}
  .return-proof-form button{justify-self:start;min-height:46px;border:1px solid #111827;border-radius:8px;background:#111827;color:#fff;padding:0 22px;font-weight:900;cursor:pointer}
  .return-proof-form button:disabled{opacity:.6;cursor:wait}
  @media(max-width:640px){.return-proof-page{padding:20px 12px}.return-proof-card{padding:22px 18px}.return-proof-card h1{font-size:28px}}
`;
