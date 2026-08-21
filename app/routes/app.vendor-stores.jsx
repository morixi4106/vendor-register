import { json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useState } from "react";

import prisma from "../db.server.js";
import {
  getActiveDomesticMarketplacePilot,
  isDomesticMarketplacePilotEnabled,
} from "../services/domesticMarketplacePilot.server.js";
import { isPublicDraftOrderCheckoutEnabled } from "../services/vendorStorefront.server.js";
import { authenticate } from "../shopify.server";
import { getVendorStorePublicationState } from "../utils/vendorStoreAdminState.js";

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
  const draftOrderCheckoutEnabled = isPublicDraftOrderCheckoutEnabled(
    process.env,
  );
  const domesticMarketplacePilotEnabled = isDomesticMarketplacePilotEnabled(
    process.env,
  );

  let draftOrdersScope = emptyDraftOrdersScopeState();
  try {
    draftOrdersScope = createDraftOrdersScopeState(await scopes.query());
  } catch (error) {
    console.error("vendor stores scope query error:", error);
  }

  const [stores, activePilot] = await Promise.all([
    prisma.vendorStore.findMany({
      include: { vendorAuth: true },
      orderBy: { createdAt: "desc" },
    }),
    draftOrderCheckoutEnabled && domesticMarketplacePilotEnabled
      ? getActiveDomesticMarketplacePilot()
      : null,
  ]);

  return json({
    stores,
    draftOrdersScope,
    publicationContext: {
      draftOrderCheckoutEnabled,
      domesticMarketplacePilotEnabled,
      activePilotStoreId: activePilot?.vendorStoreId || null,
    },
  });
};

async function loadStoreForProtectedAction(id) {
  if (!id) return null;
  return prisma.vendorStore.findUnique({
    where: { id },
    select: {
      id: true,
      storeName: true,
      isPlatformStore: true,
    },
  });
}

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");
  const store = await loadStoreForProtectedAction(id);

  if (!store) {
    return json(
      { ok: false, message: "対象の店舗が見つかりません。" },
      { status: 404 },
    );
  }

  if (intent === "set_test_store") {
    if (store.isPlatformStore) {
      return json(
        {
          ok: false,
          message: "運営直販店舗のデータ区分はこの画面では変更できません。",
        },
        { status: 400 },
      );
    }

    await prisma.vendorStore.update({
      where: { id },
      data: {
        isTestStore: String(formData.get("isTestStore") || "") === "true",
      },
    });

    return redirect("/app/vendor-stores");
  }

  if (intent !== "delete") {
    return json(
      { ok: false, message: "対応していない操作です。" },
      { status: 400 },
    );
  }

  if (store.isPlatformStore) {
    return json(
      { ok: false, message: "運営直販店舗は削除できません。" },
      { status: 400 },
    );
  }

  await prisma.product.deleteMany({ where: { vendorStoreId: id } });
  await prisma.vendorStore.delete({ where: { id } });
  return redirect("/app/vendor-stores");
};

function scopeSummary(scopeState) {
  if (scopeState.hasReadDraftOrders) {
    return {
      tone: "success",
      title: "注文管理の追加権限は有効です",
      description:
        "出店者ポータルの注文管理で、Shopifyの下書き注文を参照できます。",
    };
  }
  if (scopeState.loadError) {
    return {
      tone: "danger",
      title: "注文管理の権限状態を取得できませんでした",
      description: "時間をおいて状態を再確認してください。",
    };
  }
  if (!scopeState.canRequest) {
    return {
      tone: "warning",
      title: "追加権限をまだ要求できません",
      description:
        "read_draft_orders がShopify側のoptional scopeへ反映されているか確認してください。",
    };
  }
  return {
    tone: "info",
    title: "注文管理の追加権限を有効にできます",
    description:
      "この操作は権限の承認だけを行い、注文や決済は作成しません。",
  };
}

function badgeClass(tone) {
  return `vendor-stores__badge vendor-stores__badge--${tone}`;
}

export default function VendorStoresPage() {
  const { stores, draftOrdersScope, publicationContext } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [requestState, setRequestState] = useState(null);
  const [isRequestingScope, setIsRequestingScope] = useState(false);
  const [clientScopeState, setClientScopeState] = useState(null);

  const scopeState = clientScopeState || draftOrdersScope;
  const scope = scopeSummary(scopeState);
  const canRequestScope =
    !scopeState.hasReadDraftOrders &&
    !scopeState.loadError &&
    scopeState.canRequest;
  const busyId = String(navigation.formData?.get("id") || "");
  const busyIntent = String(navigation.formData?.get("intent") || "");

  async function handleRequestOrdersScope() {
    if (!canRequestScope || isRequestingScope) return;

    setRequestState(null);
    setIsRequestingScope(true);
    try {
      const response = await shopify.scopes.request([READ_DRAFT_ORDERS_SCOPE]);
      const detail = response?.detail || (await shopify.scopes.query());
      const nextState = createDraftOrdersScopeState(detail);
      setClientScopeState(nextState);

      if (response?.result === "granted-all") {
        setRequestState({
          tone: "success",
          message: "注文管理の追加権限を有効にしました。",
        });
        shopify.toast.show("注文管理の追加権限を有効にしました");
        revalidator.revalidate();
      } else {
        setRequestState({
          tone: "warning",
          message: "権限の承認は完了していません。",
        });
      }
    } catch (error) {
      console.error("vendor stores scope request error:", error);
      setRequestState({
        tone: "danger",
        message: "追加権限の要求に失敗しました。時間をおいて再試行してください。",
      });
    } finally {
      setIsRequestingScope(false);
    }
  }

  return (
    <main className="vendor-stores">
      <style>{`
        .vendor-stores{padding:24px;display:grid;gap:20px;color:#111827}
        .vendor-stores__section{background:#fff;border:1px solid #dfe3e8;border-radius:8px;padding:20px}
        .vendor-stores__header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
        .vendor-stores h1,.vendor-stores h2,.vendor-stores p{margin-top:0}
        .vendor-stores h1{font-size:28px;margin-bottom:8px}
        .vendor-stores h2{font-size:20px;margin-bottom:8px}
        .vendor-stores__muted{color:#596273;line-height:1.7;margin-bottom:0}
        .vendor-stores__policy{border-left:4px solid #c88719;background:#fff8e6;padding:14px 16px;line-height:1.7}
        .vendor-stores__notice{border:1px solid #d1d5db;border-radius:6px;padding:12px 14px;line-height:1.6}
        .vendor-stores__notice--success{border-color:#a7f3d0;background:#ecfdf5;color:#047857}
        .vendor-stores__notice--warning{border-color:#fde68a;background:#fffbeb;color:#92400e}
        .vendor-stores__notice--danger{border-color:#fecaca;background:#fef2f2;color:#b91c1c}
        .vendor-stores__notice--info{border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8}
        .vendor-stores__actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .vendor-stores__button,.vendor-stores__link{min-height:38px;display:inline-flex;align-items:center;justify-content:center;padding:0 12px;border-radius:6px;border:1px solid #c9ccd3;background:#fff;color:#111827;font:inherit;font-size:13px;font-weight:700;text-decoration:none;cursor:pointer;box-sizing:border-box}
        .vendor-stores__button:hover,.vendor-stores__link:hover{background:#f6f6f7}
        .vendor-stores__button:disabled{opacity:.6;cursor:not-allowed}
        .vendor-stores__button--primary{background:#111827;border-color:#111827;color:#fff}
        .vendor-stores__button--danger{background:#b42318;border-color:#b42318;color:#fff}
        .vendor-stores__table-wrap{overflow-x:auto}
        .vendor-stores table{width:100%;border-collapse:collapse;min-width:1120px}
        .vendor-stores th,.vendor-stores td{text-align:left;vertical-align:top;padding:14px 12px;border-bottom:1px solid #e5e7eb;font-size:14px}
        .vendor-stores th{color:#596273;font-size:12px;text-transform:uppercase}
        .vendor-stores__store-name{font-weight:700;color:#0b57d0}
        .vendor-stores__cell-detail{max-width:260px;color:#596273;line-height:1.5;margin-top:6px;font-size:12px}
        .vendor-stores__badge{display:inline-flex;align-items:center;min-height:26px;padding:0 9px;border-radius:999px;border:1px solid #d1d5db;background:#f6f6f7;color:#4b5563;font-size:12px;font-weight:700;white-space:nowrap}
        .vendor-stores__badge--success{border-color:#a7f3d0;background:#ecfdf5;color:#047857}
        .vendor-stores__badge--warning{border-color:#fde68a;background:#fffbeb;color:#92400e}
        .vendor-stores__badge--neutral{border-color:#d1d5db;background:#f6f6f7;color:#4b5563}
        @media (max-width:720px){.vendor-stores{padding:16px}.vendor-stores__section{padding:16px}.vendor-stores h1{font-size:24px}}
      `}</style>

      <section className="vendor-stores__section">
        <div className="vendor-stores__header">
          <div>
            <h1>店舗一覧</h1>
            <p className="vendor-stores__muted">
              店舗データの区分と、サイトへの掲載状態を分けて確認できます。
            </p>
          </div>
          <Link className="vendor-stores__link" to="/app/marketplace-pilot">
            国内販売パイロットを開く
          </Link>
        </div>
      </section>

      <section className="vendor-stores__section vendor-stores__policy">
        <strong>「実運用データにする」だけではサイトへ掲載されません。</strong>
        <div>
          運営直販店舗はShopifyコレクションへ掲載されます。第三者店舗は、国内販売パイロットの承認と購入導線の有効化がそろった場合だけ公開APIへ掲載されます。
        </div>
        {!publicationContext.draftOrderCheckoutEnabled ||
        !publicationContext.domesticMarketplacePilotEnabled ? (
          <div>
            現在、第三者店舗の公開機能は停止中です。実運用データへ変更してもサイトには表示されません。
          </div>
        ) : null}
      </section>

      {actionData?.message ? (
        <div className="vendor-stores__notice vendor-stores__notice--danger" role="alert">
          {actionData.message}
        </div>
      ) : null}

      <section className="vendor-stores__section">
        <h2>{scope.title}</h2>
        <div className={`vendor-stores__notice vendor-stores__notice--${scope.tone}`}>
          <div>{scope.description}</div>
          <div className="vendor-stores__actions" style={{ marginTop: 12 }}>
            {canRequestScope ? (
              <button
                type="button"
                className="vendor-stores__button vendor-stores__button--primary"
                onClick={handleRequestOrdersScope}
                disabled={isRequestingScope}
              >
                {isRequestingScope ? "確認中..." : "追加権限を有効にする"}
              </button>
            ) : null}
            <button
              type="button"
              className="vendor-stores__button"
              onClick={() => revalidator.revalidate()}
              disabled={revalidator.state !== "idle"}
            >
              {revalidator.state !== "idle" ? "更新中..." : "状態を再確認"}
            </button>
          </div>
        </div>
        {requestState ? (
          <div
            className={`vendor-stores__notice vendor-stores__notice--${requestState.tone}`}
            style={{ marginTop: 12 }}
          >
            {requestState.message}
          </div>
        ) : null}
      </section>

      <section className="vendor-stores__section">
        {stores.length === 0 ? (
          <p className="vendor-stores__muted">登録済みの店舗はありません。</p>
        ) : (
          <div className="vendor-stores__table-wrap">
            <table>
              <thead>
                <tr>
                  <th>店舗</th>
                  <th>店舗状態</th>
                  <th>データ区分</th>
                  <th>サイト掲載</th>
                  <th>登録日時</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((store) => {
                  const publication = getVendorStorePublicationState(
                    store,
                    publicationContext,
                  );
                  const isBusy = busyId === store.id;
                  const dashboardUrl = store.vendorAuth?.id
                    ? `/vendor/verify?vendorId=${encodeURIComponent(
                        store.vendorAuth.id,
                      )}&returnTo=${encodeURIComponent("/vendor/dashboard")}`
                    : null;
                  const ordersUrl = store.vendorAuth?.id
                    ? `/vendor/verify?vendorId=${encodeURIComponent(
                        store.vendorAuth.id,
                      )}&returnTo=${encodeURIComponent("/vendor/orders")}`
                    : null;

                  return (
                    <tr key={store.id}>
                      <td>
                        <Link
                          className="vendor-stores__store-name"
                          to={`/app/vendor/${store.id}`}
                        >
                          {store.storeName}
                        </Link>
                        <div className="vendor-stores__cell-detail">
                          {store.ownerName} / {store.category || "カテゴリ未設定"}
                        </div>
                      </td>
                      <td>
                        <span
                          className={badgeClass(
                            store.vendorAuth?.status === "active"
                              ? "success"
                              : "warning",
                          )}
                        >
                          {store.vendorAuth?.status === "active"
                            ? "有効"
                            : "要確認"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={badgeClass(
                            store.isTestStore ? "neutral" : "success",
                          )}
                        >
                          {store.isPlatformStore
                            ? "運営直販"
                            : store.isTestStore
                              ? "テストデータ"
                              : "実運用データ"}
                        </span>
                      </td>
                      <td>
                        <span className={badgeClass(publication.tone)}>
                          {publication.label}
                        </span>
                        <div className="vendor-stores__cell-detail">
                          {publication.detail}
                        </div>
                      </td>
                      <td>{new Date(store.createdAt).toLocaleString("ja-JP")}</td>
                      <td>
                        <div className="vendor-stores__actions">
                          {dashboardUrl ? (
                            <Link
                              className="vendor-stores__link"
                              to={dashboardUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              店舗管理
                            </Link>
                          ) : null}
                          {ordersUrl ? (
                            <Link
                              className="vendor-stores__link"
                              to={ordersUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              注文管理
                            </Link>
                          ) : null}
                          {!store.isPlatformStore ? (
                            <Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="set_test_store"
                              />
                              <input type="hidden" name="id" value={store.id} />
                              <input
                                type="hidden"
                                name="isTestStore"
                                value={store.isTestStore ? "false" : "true"}
                              />
                              <button
                                type="submit"
                                className="vendor-stores__button"
                                disabled={isBusy && busyIntent === "set_test_store"}
                              >
                                {isBusy && busyIntent === "set_test_store"
                                  ? "更新中..."
                                  : store.isTestStore
                                    ? "実運用データにする"
                                    : "テストデータに戻す"}
                              </button>
                            </Form>
                          ) : null}
                          {!store.isPlatformStore && !store.isTestStore ? (
                            <Link
                              className="vendor-stores__link"
                              to="/app/marketplace-pilot"
                            >
                              公開準備を確認
                            </Link>
                          ) : null}
                          {!store.isPlatformStore ? (
                            <Form
                              method="post"
                              onSubmit={(event) => {
                                if (
                                  !window.confirm(
                                    `「${store.storeName}」を削除しますか？`,
                                  )
                                ) {
                                  event.preventDefault();
                                }
                              }}
                            >
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="id" value={store.id} />
                              <button
                                type="submit"
                                className="vendor-stores__button vendor-stores__button--danger"
                                disabled={isBusy && busyIntent === "delete"}
                              >
                                {isBusy && busyIntent === "delete"
                                  ? "削除中..."
                                  : "削除"}
                              </button>
                            </Form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
