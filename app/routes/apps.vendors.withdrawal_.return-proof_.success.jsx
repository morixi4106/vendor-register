import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import {
  appendWithdrawalLocale,
  getWithdrawalDictionary,
  resolveWithdrawalLocale,
} from "../utils/withdrawalLocale.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) throw new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  const locale = resolveWithdrawalLocale({
    urlLocale: url.searchParams.get("lang"),
    acceptLanguage: request.headers.get("accept-language"),
  }).locale;
  return json({
    ref: url.searchParams.get("ref") || "",
    embedded: url.searchParams.get("embedded") === "1",
    locale,
  });
};

export const headers = () => ({
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

export default function ReturnProofSuccessPage() {
  const { ref, embedded, locale } = useLoaderData();
  const copy = getWithdrawalDictionary(locale).returnProof;
  const formHref = appendWithdrawalLocale(embedded
    ? "/apps/vendors/withdrawal?embedded=1"
    : "/apps/vendors/withdrawal", locale);

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
        <h1>{copy.successTitle}</h1>
        <p>{copy.successBody}</p>
        <div className="return-proof-success__box">
          <span>{copy.request}: {ref || "-"}</span>
        </div>
        <div className="return-proof-success__actions">
          <Link to={formHref}>{copy.backToForm}</Link>
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
