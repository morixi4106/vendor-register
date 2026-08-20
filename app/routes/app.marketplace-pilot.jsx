import { json } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import {
  MARKETPLACE_OPERATOR_ROLES,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";

export const loader = async ({ request }) => {
  await requireMarketplaceOperator(request, {
    role: MARKETPLACE_OPERATOR_ROLES.ADMIN,
  });
  const { getDomesticMarketplacePilotDashboard } = await import(
    "../services/domesticMarketplacePilot.server.js"
  );
  return json(await getDomesticMarketplacePilotDashboard());
};

export const action = async ({ request }) => {
  const { operator } = await requireMarketplaceOperator(request, {
    role: MARKETPLACE_OPERATOR_ROLES.ADMIN,
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const pilotService = await import(
    "../services/domesticMarketplacePilot.server.js"
  );
  let result;

  if (intent === "prepare") {
    const [vendorStoreId, productId] = String(
      formData.get("candidate") || "",
    ).split("::");
    result = await pilotService.prepareDomesticMarketplacePilot({
      vendorStoreId,
      productId,
      maxQuantityPerOrder: formData.get("maxQuantityPerOrder"),
      maxOrderSubtotalAmount: formData.get("maxOrderSubtotalAmount"),
      startsAt: formData.get("startsAt"),
      expiresAt: formData.get("expiresAt"),
      approvalReference: formData.get("approvalReference"),
      approvalEvidenceHash: formData.get("approvalEvidenceHash"),
      actor: operator.actorKey,
    });
  } else if (intent === "activate") {
    result = await pilotService.activateDomesticMarketplacePilot({
      id: formData.get("pilotId"),
      actor: operator.actorKey,
    });
  } else if (intent === "block") {
    result = await pilotService.blockDomesticMarketplacePilot({
      id: formData.get("pilotId"),
      actor: operator.actorKey,
      reason: formData.get("reason"),
    });
  } else {
    result = { ok: false, reason: "unknown_intent" };
  }

  return json(result, { status: result.ok ? 200 : 400 });
};

function formatDate(value) {
  if (!value) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function fieldStyle() {
  return {
    width: "100%",
    minHeight: 44,
    padding: "10px 12px",
    border: "1px solid #c9ccd3",
    borderRadius: 6,
    background: "#fff",
    font: "inherit",
  };
}

function buttonStyle({ danger = false, disabled = false } = {}) {
  return {
    minHeight: 42,
    padding: "10px 16px",
    border: 0,
    borderRadius: 6,
    background: disabled ? "#d7d9dd" : danger ? "#b42318" : "#111827",
    color: disabled ? "#74777d" : "#fff",
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

export default function MarketplacePilotPage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const candidates = data.stores.flatMap((store) =>
    store.products.map((product) => ({ store, product })),
  );

  return (
    <main
      style={{
        maxWidth: 1240,
        margin: "0 auto",
        padding: "28px 24px 56px",
        color: "#111827",
      }}
    >
      <header style={{ marginBottom: 28 }}>
        <p style={{ margin: "0 0 6px", color: "#596273", fontWeight: 700 }}>
          DOMESTIC MARKETPLACE PILOT
        </p>
        <h1 style={{ margin: 0, fontSize: 30 }}>国内1店舗・1商品パイロット</h1>
        <p style={{ margin: "10px 0 0", lineHeight: 1.7 }}>
          許可した1店舗・1商品・1回の国内注文だけを公開購入経路へ通します。
          月次精算は既存の手動精算を使用します。
        </p>
      </header>

      <section
        style={{
          marginBottom: 28,
          padding: 18,
          border: "1px solid #d9dde5",
          borderRadius: 6,
          background: data.enabled ? "#ecfdf3" : "#fff8e6",
        }}
      >
        <strong>
          実行フラグ: {data.enabled ? "有効" : "無効（安全な初期状態）"}
        </strong>
        <div style={{ marginTop: 6 }}>
          公開Draft Order: {data.publicDraftOrderCheckoutEnabled ? "有効" : "無効"}
        </div>
        {!data.enabled ? (
          <p style={{ margin: "8px 0 0" }}>
            準備内容は保存できますが、環境フラグと既存審査が揃うまで有効化できません。
          </p>
        ) : null}
      </section>

      {actionData ? (
        <div
          role="status"
          style={{
            marginBottom: 22,
            padding: 14,
            borderRadius: 6,
            background: actionData.ok ? "#ecfdf3" : "#fef3f2",
            color: actionData.ok ? "#067647" : "#b42318",
          }}
        >
          {actionData.ok
            ? "処理を完了しました。"
            : `処理できません: ${actionData.reason || "unknown"}`}
          {actionData.reasons?.length
            ? ` (${actionData.reasons.join(", ")})`
            : ""}
        </div>
      ) : null}

      <section style={{ marginBottom: 36 }}>
        <h2 style={{ fontSize: 22, marginBottom: 8 }}>許可証を準備</h2>
        <p style={{ marginTop: 0, color: "#596273" }}>
          Shopifyの書面承認を含む証拠参照とSHA-256を登録します。保存だけでは販売されません。
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="prepare" />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
              gap: 16,
            }}
          >
            <label>
              <span>対象店舗・商品</span>
              <select name="candidate" required style={fieldStyle()}>
                <option value="">選択してください</option>
                {candidates.map(({ store, product }) => (
                  <option
                    key={`${store.id}:${product.id}`}
                    value={`${store.id}::${product.id}`}
                  >
                    {store.storeName} / {product.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>1注文の数量上限</span>
              <input
                name="maxQuantityPerOrder"
                type="number"
                min="1"
                max="1"
                defaultValue="1"
                readOnly
                required
                style={fieldStyle()}
              />
            </label>
            <label>
              <span>商品小計上限（円）</span>
              <input
                name="maxOrderSubtotalAmount"
                type="number"
                min="1"
                required
                style={fieldStyle()}
              />
            </label>
            <label>
              <span>開始日時</span>
              <input name="startsAt" type="datetime-local" required style={fieldStyle()} />
            </label>
            <label>
              <span>終了日時</span>
              <input name="expiresAt" type="datetime-local" required style={fieldStyle()} />
              <small style={{ display: "block", marginTop: 4, color: "#596273" }}>
                開始から7日以内（日本時間）
              </small>
            </label>
            <label>
              <span>承認証拠の保存先・チケット番号</span>
              <input name="approvalReference" required style={fieldStyle()} />
            </label>
            <label>
              <span>証拠SHA-256（64桁）</span>
              <input
                name="approvalEvidenceHash"
                minLength="64"
                maxLength="64"
                pattern="[A-Fa-f0-9]{64}"
                required
                style={fieldStyle()}
              />
            </label>
          </div>
          <button type="submit" disabled={busy} style={{ ...buttonStyle({ disabled: busy }), marginTop: 18 }}>
            準備内容を保存
          </button>
        </Form>
      </section>

      <section>
        <h2 style={{ fontSize: 22 }}>許可証</h2>
        {data.pilots.length === 0 ? (
          <p>保存済みの許可証はありません。</p>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {data.pilots.map((pilot) => {
              const activatable =
                pilot.status === "PREPARED" && pilot.evaluation.ready;
              return (
                <article
                  key={pilot.id}
                  style={{
                    padding: 18,
                    border: "1px solid #d9dde5",
                    borderRadius: 6,
                    background: "#fff",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <strong>{pilot.vendorStore.storeName}</strong>
                      <div>{pilot.product.name}</div>
                      <div style={{ marginTop: 6, color: "#596273" }}>
                        {pilot.status} / 数量 {pilot.maxQuantityPerOrder} / 小計上限 ¥
                        {pilot.maxOrderSubtotalAmount.toLocaleString("ja-JP")}
                      </div>
                      <div style={{ color: "#596273" }}>
                        {formatDate(pilot.startsAt)} から {formatDate(pilot.expiresAt)}
                      </div>
                    </div>
                    <div style={{ minWidth: 280 }}>
                      {pilot.evaluation.reasons.length ? (
                        <div style={{ color: "#b42318", marginBottom: 10 }}>
                          未充足: {pilot.evaluation.reasons.join(", ")}
                        </div>
                      ) : (
                        <div style={{ color: "#067647", marginBottom: 10 }}>
                          有効化条件を満たしています。
                        </div>
                      )}
                      {pilot.status === "PREPARED" ? (
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="activate" />
                          <input type="hidden" name="pilotId" value={pilot.id} />
                          <button
                            type="submit"
                            disabled={busy || !activatable}
                            style={buttonStyle({ disabled: busy || !activatable })}
                          >
                            1回の注文枠を有効化
                          </button>
                        </Form>
                      ) : null}
                      {["PREPARED", "ACTIVE", "RESERVED"].includes(
                        pilot.status,
                      ) ? (
                        <Form
                          method="post"
                          style={{ display: "flex", gap: 8, marginTop: 10 }}
                        >
                          <input type="hidden" name="intent" value="block" />
                          <input type="hidden" name="pilotId" value={pilot.id} />
                          <input name="reason" required placeholder="停止理由" style={fieldStyle()} />
                          <button type="submit" disabled={busy} style={buttonStyle({ danger: true, disabled: busy })}>
                            停止
                          </button>
                        </Form>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
