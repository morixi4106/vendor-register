import { redirect } from "@remix-run/node";
import {
  isRouteErrorResponse,
  Outlet,
  useLocation,
  useRouteError,
} from "@remix-run/react";

export const loader = async ({ request }) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/vendor" || pathname === "/vendor/") {
    throw redirect("/vendor/dashboard");
  }

  return null;
};

export default function VendorIndexRedirect() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const needsLogin = status === 401 || status === 403;
  const vendorId = new URLSearchParams(location.search).get("vendorId");
  const returnTo = `${location.pathname}${location.search}`;
  const verifyParams = new URLSearchParams({ returnTo });

  if (vendorId) {
    verifyParams.set("vendorId", vendorId);
  }

  return (
    <main className="vendor-error-page">
      <style>{`
        .vendor-error-page{
          min-height:100vh;
          box-sizing:border-box;
          display:grid;
          place-items:center;
          padding:24px;
          background:#f3f4f6;
          color:#111827;
          font-family:Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
        }
        .vendor-error-page__panel{
          width:min(100%, 520px);
          box-sizing:border-box;
          padding:32px;
          border:1px solid #e5e7eb;
          border-radius:8px;
          background:#ffffff;
          box-shadow:0 8px 24px rgba(15,23,42,.06);
          text-align:center;
        }
        .vendor-error-page__title{
          margin:0;
          font-size:22px;
          line-height:1.4;
        }
        .vendor-error-page__message{
          margin:12px 0 0;
          color:#4b5563;
          font-size:14px;
          line-height:1.8;
        }
        .vendor-error-page__actions{
          display:flex;
          justify-content:center;
          gap:10px;
          margin-top:24px;
          flex-wrap:wrap;
        }
        .vendor-error-page__button{
          display:inline-flex;
          min-height:44px;
          box-sizing:border-box;
          align-items:center;
          justify-content:center;
          padding:10px 18px;
          border:1px solid #d1d5db;
          border-radius:8px;
          background:#ffffff;
          color:#111827;
          font-size:14px;
          font-weight:700;
          text-decoration:none;
          cursor:pointer;
        }
        .vendor-error-page__button--primary{
          border-color:#111827;
          background:#111827;
          color:#ffffff;
        }
        @media (max-width: 560px){
          .vendor-error-page__panel{
            padding:24px 20px;
          }
          .vendor-error-page__actions,
          .vendor-error-page__button{
            width:100%;
          }
        }
      `}</style>

      <section className="vendor-error-page__panel" aria-labelledby="vendor-error-title">
        <h1 id="vendor-error-title" className="vendor-error-page__title">
          {needsLogin ? "ログインの確認が必要です" : "ページを表示できませんでした"}
        </h1>
        <p className="vendor-error-page__message">
          {needsLogin
            ? "安全のため、店舗管理画面へもう一度ログインしてください。"
            : "一時的な問題が発生しました。ページを再読み込みしてください。"}
        </p>
        <div className="vendor-error-page__actions">
          <a className="vendor-error-page__button" href={returnTo}>
            再読み込み
          </a>
          <a
            className="vendor-error-page__button vendor-error-page__button--primary"
            href={`/vendor/verify?${verifyParams.toString()}`}
          >
            ログインを確認
          </a>
        </div>
      </section>
    </main>
  );
}
