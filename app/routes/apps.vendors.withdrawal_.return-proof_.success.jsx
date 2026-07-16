import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { useEffect } from "react";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  return json({
    ref: url.searchParams.get("ref") || "",
    embedded: url.searchParams.get("embedded") === "1",
  });
};

export default function ReturnProofSuccessPage() {
  const { ref, embedded } = useLoaderData();
  const formHref = embedded
    ? "/apps/vendors/withdrawal?embedded=1"
    : "/apps/vendors/withdrawal";

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

    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
      window.clearTimeout(timeoutId);
    };
  }, [embedded]);

  return (
    <main
      className={`return-proof-success${
        embedded ? " return-proof-success--embedded" : ""
      }`}
    >
      <style>{pageStyles}</style>
      <section className="return-proof-success__card">
        {!embedded ? (
          <p className="return-proof-success__eyebrow">EU RIGHT OF WITHDRAWAL</p>
        ) : null}
        <h1>返送証明を受け付けました</h1>
        <p>
          提出内容を確認し、返送状況と商品状態を確認したうえで手続きを進めます。
          返金やキャンセルは自動実行されません。
        </p>
        <div className="return-proof-success__box">
          <span>受付番号: {ref || "-"}</span>
        </div>
        <div className="return-proof-success__actions">
          <Link to={formHref}>撤回申請フォームへ戻る</Link>
        </div>
      </section>
    </main>
  );
}

const pageStyles = `
  .return-proof-success{
    min-height:100vh;
    display:grid;
    place-items:center;
    padding:48px 18px;
    background:#f8fafc;
    color:#0f172a;
    font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  }
  .return-proof-success--embedded{
    min-height:auto;
    padding:0;
    background:transparent;
    overflow:hidden;
  }
  .return-proof-success__card{
    width:min(680px,100%);
    border:1px solid #dbe3ee;
    border-radius:18px;
    background:#fff;
    padding:34px;
    box-sizing:border-box;
  }
  .return-proof-success--embedded .return-proof-success__card{
    width:100%;
  }
  .return-proof-success__eyebrow{
    margin:0 0 10px;
    color:#475569;
    font-size:12px;
    font-weight:900;
    letter-spacing:.08em;
  }
  .return-proof-success h1{
    margin:0 0 18px;
    font-size:34px;
    line-height:1.2;
  }
  .return-proof-success p{
    margin:0 0 18px;
    line-height:1.8;
    color:#334155;
  }
  .return-proof-success__box{
    display:grid;
    gap:6px;
    margin:0 0 22px;
    border:1px solid #bbf7d0;
    border-radius:14px;
    padding:14px 16px;
    background:#f0fdf4;
    color:#047857;
    font-weight:800;
  }
  .return-proof-success__actions a{
    display:inline-flex;
    min-height:42px;
    align-items:center;
    border:1px solid #111827;
    border-radius:999px;
    background:#111827;
    color:#fff;
    padding:0 18px;
    text-decoration:none;
    font-weight:900;
  }
`;
