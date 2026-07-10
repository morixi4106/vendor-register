import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { useEffect } from "react";

import prisma from "../db.server.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const ref = String(url.searchParams.get("ref") || "").trim();
  const duplicate = url.searchParams.get("duplicate") === "1";
  const embedded = url.searchParams.get("embedded") === "1";

  if (!ref) {
    return json({ found: false, duplicate: false, embedded, ref: "" });
  }

  const withdrawalRequest = await prisma.withdrawalRequest.findUnique({
    where: { id: ref },
    select: {
      id: true,
      shopifyOrderName: true,
      customerEmail: true,
      status: true,
      confirmationSentAt: true,
    },
  });

  return json({
    found: Boolean(withdrawalRequest),
    duplicate,
    embedded,
    ref,
    withdrawalRequest,
  });
};

export default function WithdrawalSuccessPage() {
  const { found, duplicate, embedded, ref, withdrawalRequest } = useLoaderData();
  const formHref = embedded ? "/apps/vendors/withdrawal?embedded=1" : "/apps/vendors/withdrawal";

  useEmbeddedFrameBehavior(embedded);

  return (
    <main className={`withdrawal-success${embedded ? " withdrawal-success--embedded" : ""}`}>
      <style>{pageStyles}</style>
      <section className="withdrawal-success__card">
        <h1>{found ? "撤回申請を受け付けました" : "受付状況を確認しています"}</h1>
        <p>
          {found
            ? "内容を確認のうえ、今後の手続きをメールでご案内します。"
            : "受付番号が見つかりませんでした。時間を置いて再度ご確認ください。"}
        </p>
        <div className="withdrawal-success__box">
          <span>受付番号: {withdrawalRequest?.id || ref || "-"}</span>
          {withdrawalRequest?.shopifyOrderName ? (
            <span>注文番号: {withdrawalRequest.shopifyOrderName}</span>
          ) : null}
          {withdrawalRequest?.confirmationSentAt ? (
            <span>受付確認メール: 送信済み</span>
          ) : (
            <span>受付確認メール: 確認中</span>
          )}
          {duplicate ? <span>同じ申請はすでに受け付け済みです。</span> : null}
        </div>
        <p>
          商品が発送済みの場合、返送または返送証明の確認後に返金処理を進める場合があります。
          通常配送分の初回送料は返金対象として確認しますが、追加配送費用や返送送料はお客様負担となる場合があります。
          商品状態によっては返金額が減額される場合があります。
        </p>
        <div className="withdrawal-success__actions">
          <Link to={formHref}>フォームへ戻る</Link>
        </div>
      </section>
    </main>
  );
}

function useEmbeddedFrameBehavior(embedded) {
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
    window.parent?.postMessage({ type: "vendorWithdrawalScrollIntoView" }, "*");

    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
      window.clearTimeout(timeoutId);
    };
  }, [embedded]);
}

const pageStyles = `
  .withdrawal-success{
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:32px 16px;
    background:#f4f5f7;
    color:#111827;
    font-family:system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .withdrawal-success__card{
    width:min(720px, 100%);
    border:1px solid #e5e7eb;
    border-radius:20px;
    background:#fff;
    padding:32px;
    box-sizing:border-box;
  }
  .withdrawal-success--embedded{
    min-height:auto;
    padding:0;
    background:transparent;
    overflow:hidden;
  }
  .withdrawal-success--embedded .withdrawal-success__card{
    width:100%;
  }
  .withdrawal-success h1{
    margin:0 0 12px;
    font-size:30px;
    line-height:1.25;
  }
  .withdrawal-success p{
    color:#4b5563;
    line-height:1.8;
  }
  .withdrawal-success__box{
    display:grid;
    gap:8px;
    margin:22px 0;
    padding:18px;
    border:1px solid #a7f3d0;
    border-radius:14px;
    background:#ecfdf5;
    color:#047857;
    font-weight:700;
  }
  .withdrawal-success__actions{
    display:flex;
    justify-content:flex-end;
  }
  .withdrawal-success__actions a{
    min-height:44px;
    display:inline-flex;
    align-items:center;
    border:1px solid #111827;
    border-radius:999px;
    padding:0 18px;
    background:#111827;
    color:#fff;
    text-decoration:none;
    font-weight:800;
  }
`;
