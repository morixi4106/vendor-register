import { json, redirect } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation, useRevalidator } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";

const READ_DRAFT_ORDERS_SCOPE = "read_draft_orders";

function createDraftOrdersScopeState(scopeDetail = {}) {
  const granted = Array.isArray(scopeDetail.granted) ? scopeDetail.granted : [];
  const optional = Array.isArray(scopeDetail.optional) ? scopeDetail.optional : [];
  const required = Array.isArray(scopeDetail.required) ? scopeDetail.required : [];

  return {
    requiredScope: READ_DRAFT_ORDERS_SCOPE,
    granted,
    optional,
    required,
    hasReadDraftOrders: granted.includes(READ_DRAFT_ORDERS_SCOPE),
    canRequest: optional.includes(READ_DRAFT_ORDERS_SCOPE),
    loadError: false,
  };
}

function emptyDraftOrdersScopeState() {
  return {
    requiredScope: READ_DRAFT_ORDERS_SCOPE,
    granted: [],
    optional: [],
    required: [],
    hasReadDraftOrders: false,
    canRequest: false,
    loadError: true,
  };
}

export const loader = async ({ request }) => {
  const { scopes } = await authenticate.admin(request);

  let draftOrdersScope = emptyDraftOrdersScopeState();

  try {
    const scopeDetail = await scopes.query();
    draftOrdersScope = createDraftOrdersScopeState(scopeDetail);
  } catch (error) {
    console.error("vendor stores scope query error:", error);
  }

  const stores = await prisma.vendorStore.findMany({
    orderBy: { createdAt: "desc" },
  });

  return json({ stores, draftOrdersScope });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent !== "delete") {
    return json({ ok: false, message: "不正な操作です。" }, { status: 400 });
  }

  if (!id) {
    return json({ ok: false, message: "店舗IDがありません。" }, { status: 400 });
  }

  await prisma.product.deleteMany({
    where: { vendorStoreId: id },
  });

  await prisma.vendorStore.delete({
    where: { id },
  });

  return redirect("/app/vendor-stores");
};

function scopeNoticeTone(scopeState) {
  if (scopeState.hasReadDraftOrders) {
    return "success";
  }

  if (scopeState.loadError) {
    return "danger";
  }

  if (!scopeState.canRequest) {
    return "warning";
  }

  return "info";
}

function scopeHeadline(scopeState) {
  if (scopeState.hasReadDraftOrders) {
    return "注文管理権限は有効です";
  }

  if (scopeState.loadError) {
    return "注文管理権限の状態を確認できませんでした";
  }

  if (!scopeState.canRequest) {
    return "optional scope の反映を待っています";
  }

  return "注文管理を有効化できます";
}

function scopeDescription(scopeState) {
  if (scopeState.hasReadDraftOrders) {
    return "merchant 承認後の状態です。vendor portal 側の /vendor/orders は missing_scope ではなく ready state を返せます。";
  }

  if (scopeState.loadError) {
    return "Shopify から scope 状態を取得できませんでした。時間をおいて再度お試しください。";
  }

  if (!scopeState.canRequest) {
    return "App Bridge から追加要求するには、read_draft_orders が app config の optional_scopes として Shopify 側に反映されている必要があります。";
  }

  return "このボタンは Shopify Admin 内の merchant 向けです。承認後に /vendor/orders の empty state を解除できるようになります。";
}

function scopeBoxClassName(tone) {
  if (tone === "success") {
    return "vendor-stores__scope-box vendor-stores__scope-box--success";
  }

  if (tone === "danger") {
    return "vendor-stores__scope-box vendor-stores__scope-box--danger";
  }

  if (tone === "warning") {
    return "vendor-stores__scope-box vendor-stores__scope-box--warning";
  }

  return "vendor-stores__scope-box vendor-stores__scope-box--info";
}

export default function VendorStoresPage() {
  const { stores, draftOrdersScope } = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [requestState, setRequestState] = useState(null);
  const [isRequestingScope, setIsRequestingScope] = useState(false);
  const [clientScopeState, setClientScopeState] = useState(null);

  const deletingId =
    navigation.formData?.get("intent") === "delete"
      ? String(navigation.formData?.get("id") || "")
      : "";

  const scopeState = clientScopeState || draftOrdersScope;
  const scopeTone = scopeNoticeTone(scopeState);
  const canRequestScope =
    !scopeState.hasReadDraftOrders && !scopeState.loadError && scopeState.canRequest;
  const isRefreshingScope = revalidator.state !== "idle";

  async function handleRequestOrdersScope() {
    if (!canRequestScope || isRequestingScope) {
      return;
    }

    setRequestState(null);
    setIsRequestingScope(true);

    try {
      const response = await shopify.scopes.request([READ_DRAFT_ORDERS_SCOPE]);
      const detail = response?.detail || (await shopify.scopes.query());
      const nextScopeState = {
        ...createDraftOrdersScopeState(detail),
        requiredScope: READ_DRAFT_ORDERS_SCOPE,
      };

      setClientScopeState(nextScopeState);

      if (response?.result === "granted-all") {
        setRequestState({
          tone: "success",
          message:
            "追加権限の承認を確認しました。状態を再確認して、vendor portal の /vendor/orders が ready state になることを確認してください。",
        });
        shopify.toast.show("注文管理権限を有効化しました");
        revalidator.revalidate();
        return;
      }

      setRequestState({
        tone: "warning",
        message:
          "追加権限の付与はまだ完了していません。必要に応じて再度お試しください。",
      });
      shopify.toast.show("追加権限の付与は完了していません");
    } catch (error) {
      console.error("vendor stores scope request error:", error);
      setRequestState({
        tone: "danger",
        message:
          "追加権限の要求に失敗しました。時間をおいて再度お試しください。",
      });
      shopify.toast.show("追加権限の要求に失敗しました");
    } finally {
      setIsRequestingScope(false);
    }
  }

  return (
    <div style={{ padding: "24px" }}>
      <style>{`
        .vendor-stores__page{
          display:grid;
          gap:24px;
        }
        .vendor-stores__card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:20px;
          box-sizing:border-box;
        }
        .vendor-stores__section-title{
          font-size:24px;
          font-weight:700;
          margin:0 0 8px;
          color:#111827;
        }
        .vendor-stores__section-subtitle{
          margin:0 0 18px;
          color:#6b7280;
          line-height:1.7;
          font-size:14px;
        }
        .vendor-stores__scope-box{
          border:1px solid #dbeafe;
          border-radius:14px;
          padding:16px 18px;
          background:#eff6ff;
          color:#1d4ed8;
          line-height:1.7;
        }
        .vendor-stores__scope-box--success{
          border-color:#a7f3d0;
          background:#ecfdf5;
          color:#047857;
        }
        .vendor-stores__scope-box--warning{
          border-color:#fde68a;
          background:#fffbeb;
          color:#92400e;
        }
        .vendor-stores__scope-box--danger{
          border-color:#fecaca;
          background:#fef2f2;
          color:#b91c1c;
        }
        .vendor-stores__scope-actions{
          display:flex;
          gap:10px;
          flex-wrap:wrap;
          margin-top:16px;
        }
        .vendor-stores__button{
          min-height:42px;
          padding:0 16px;
          border-radius:999px;
          border:1px solid #d1d5db;
          background:#fff;
          color:#111827;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
        }
        .vendor-stores__button:hover{
          background:#f9fafb;
        }
        .vendor-stores__button:disabled{
          cursor:not-allowed;
          opacity:0.6;
        }
        .vendor-stores__button--primary{
          border-color:#111827;
          background:#111827;
          color:#fff;
        }
        .vendor-stores__button--primary:hover{
          background:#1f2937;
        }
        .vendor-stores__scope-meta{
          display:grid;
          gap:8px;
          margin-top:14px;
          font-size:13px;
          color:#4b5563;
        }
        .vendor-stores__scope-meta-row{
          display:flex;
          gap:8px;
          flex-wrap:wrap;
        }
        .vendor-stores__scope-meta-label{
          font-weight:700;
          color:#111827;
        }
        .vendor-stores__notice{
          margin-top:14px;
          border-radius:12px;
          padding:12px 14px;
          font-size:14px;
          line-height:1.7;
          border:1px solid #d1d5db;
          background:#f9fafb;
          color:#374151;
        }
        .vendor-stores__notice--success{
          border-color:#a7f3d0;
          background:#ecfdf5;
          color:#047857;
        }
        .vendor-stores__notice--warning{
          border-color:#fde68a;
          background:#fffbeb;
          color:#92400e;
        }
        .vendor-stores__notice--danger{
          border-color:#fecaca;
          background:#fef2f2;
          color:#b91c1c;
        }
      `}</style>

      <div className="vendor-stores__page">
        <section className="vendor-stores__card">
          <h1 className="vendor-stores__section-title">店舗一覧</h1>
          <p className="vendor-stores__section-subtitle">
            Shopify Admin 内で、vendor portal の注文管理機能に必要な追加権限を確認できます。
            この画面は scope request 導線専用で、Draft Order や checkout は作成しません。
          </p>

          <div className={scopeBoxClassName(scopeTone)}>
            <strong style={{ display: "block", marginBottom: "6px" }}>
              {scopeHeadline(scopeState)}
            </strong>
            <div>{scopeDescription(scopeState)}</div>

            <div className="vendor-stores__scope-meta">
              <div className="vendor-stores__scope-meta-row">
                <span className="vendor-stores__scope-meta-label">対象 scope:</span>
                <span>{scopeState.requiredScope}</span>
              </div>
              <div className="vendor-stores__scope-meta-row">
                <span className="vendor-stores__scope-meta-label">granted:</span>
                <span>{scopeState.granted.join(", ") || "-"}</span>
              </div>
              <div className="vendor-stores__scope-meta-row">
                <span className="vendor-stores__scope-meta-label">optional:</span>
                <span>{scopeState.optional.join(", ") || "-"}</span>
              </div>
            </div>

            <div className="vendor-stores__scope-actions">
              {canRequestScope ? (
                <button
                  type="button"
                  className="vendor-stores__button vendor-stores__button--primary"
                  onClick={handleRequestOrdersScope}
                  disabled={isRequestingScope}
                >
                  {isRequestingScope ? "要求中..." : "注文管理を有効化"}
                </button>
              ) : null}

              <button
                type="button"
                className="vendor-stores__button"
                onClick={() => revalidator.revalidate()}
                disabled={isRefreshingScope}
              >
                {isRefreshingScope ? "再確認中..." : "状態を再確認"}
              </button>
            </div>

            {requestState ? (
              <div
                className={`vendor-stores__notice vendor-stores__notice--${requestState.tone}`}
              >
                {requestState.message}
              </div>
            ) : null}
          </div>
        </section>

        <section className="vendor-stores__card">
          {stores.length === 0 ? (
            <p style={{ margin: 0 }}>まだ店舗登録はありません。</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  background: "#fff",
                }}
              >
                <thead>
                  <tr>
                    <th style={thStyle}>店舗名</th>
                    <th style={thStyle}>オーナー名</th>
                    <th style={thStyle}>メール</th>
                    <th style={thStyle}>電話番号</th>
                    <th style={thStyle}>住所</th>
                    <th style={thStyle}>国</th>
                    <th style={thStyle}>カテゴリ</th>
                    <th style={thStyle}>年齢確認</th>
                    <th style={thStyle}>登録日時</th>
                    <th style={thStyle}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {stores.map((store) => {
                    const isDeleting = deletingId === store.id;

                    return (
                      <tr key={store.id}>
                        <td style={tdStyle}>
                          <Link
                            to={`/app/vendor/${store.id}`}
                            style={{
                              color: "#0b57d0",
                              textDecoration: "underline",
                              fontWeight: "700",
                            }}
                          >
                            {store.storeName}
                          </Link>
                        </td>
                        <td style={tdStyle}>{store.ownerName}</td>
                        <td style={tdStyle}>{store.email}</td>
                        <td style={tdStyle}>{store.phone}</td>
                        <td style={tdStyle}>{store.address}</td>
                        <td style={tdStyle}>{store.country}</td>
                        <td style={tdStyle}>{store.category}</td>
                        <td style={tdStyle}>{store.ageCheck}</td>
                        <td style={tdStyle}>
                          {new Date(store.createdAt).toLocaleString("ja-JP")}
                        </td>
                        <td style={tdStyle}>
                          <Form
                            method="post"
                            onSubmit={(event) => {
                              const confirmed = window.confirm(
                                `「${store.storeName}」を削除しますか？`,
                              );
                              if (!confirmed) event.preventDefault();
                            }}
                          >
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="id" value={store.id} />
                            <button
                              type="submit"
                              disabled={isDeleting}
                              style={{
                                minWidth: "88px",
                                height: "36px",
                                border: "none",
                                borderRadius: "999px",
                                background: "#c91c1c",
                                color: "#fff",
                                fontWeight: "700",
                                cursor: isDeleting ? "not-allowed" : "pointer",
                                opacity: isDeleting ? 0.7 : 1,
                              }}
                            >
                              {isDeleting ? "削除中..." : "削除"}
                            </button>
                          </Form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "12px",
  borderBottom: "1px solid #ddd",
  background: "#f7f7f7",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "12px",
  borderBottom: "1px solid #eee",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};
