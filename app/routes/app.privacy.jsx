import { Form, Link, useActionData, useLoaderData } from "react-router";
import { requirePrivacyOperator } from "../utils/privacyOperator.server.js";
import prisma from "../db.server.js";
export { privateDocumentHeaders as headers } from "../utils/privateHeaders.js";
import { resolvePrivacyRightsRequest } from "../services/privacyRights.server.js";
import {
  getPrivacyContactChannel,
  getPrivacyInventory,
  protectLegacyVendorContacts,
  recordPrivacyContactChannel,
  revokeAllVendorSessions,
  runPrivacyMaintenance,
} from "../services/privacyOperations.server.js";

export async function loader({ request }) {
  await requirePrivacyOperator(request);
  const [inventory, provider] = await Promise.all([
    getPrivacyInventory(),
    getPrivacyContactChannel(),
  ]);
  const rightsRequests = await prisma.privacyRightsRequest.findMany({
    where: { status: "RECEIVED" },
    orderBy: { deadlineAt: "asc" },
    take: 50,
    select: {
      id: true,
      topic: true,
      deadlineAt: true,
      createdAt: true,
      shopifyCustomerId: true,
      externalRequestId: true,
    },
  });
  return Response.json(
    {
      inventory,
      provider,
      rightsRequests,
      encryptionReady: /^[a-f0-9]{64}$/i.test(
        String(process.env.PRIVACY_ENCRYPTION_KEY || ""),
      ),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function action({ request }) {
  const { operator } = await requirePrivacyOperator(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  let result;
  if (intent === "privacy-rights")
    result = await resolvePrivacyRightsRequest({
      id: String(form.get("id") || ""),
      status: String(form.get("status") || ""),
      evidenceReference: form.get("evidenceReference"),
      evidenceHash: form.get("evidenceHash"),
      actor: operator.actorKey,
    });
  else if (intent === "protect-contacts")
    result = await protectLegacyVendorContacts();
  else if (intent === "revoke-sessions")
    result = { ok: true, ...(await revokeAllVendorSessions()) };
  else if (intent === "prune-resolved") {
    if (form.get("confirmed") !== "yes")
      return Response.json({ ok: false }, { status: 400 });
    result = await runPrivacyMaintenance({ pruneResolvedInquiries: true });
  } else if (intent === "contact-channel")
    result = await recordPrivacyContactChannel({
      provider: String(form.get("provider") || ""),
      actor: operator.actorKey,
      inboxVerified: form.get("inboxVerified") === "yes",
      contactPageVerified: form.get("contactPageVerified") === "yes",
    });
  else return Response.json({ ok: false }, { status: 400 });
  return Response.json(
    { ok: result.ok !== false, result },
    {
      headers: { "Cache-Control": "no-store" },
      status: result.ok === false ? 409 : 200,
    },
  );
}

export default function PrivacyPage() {
  const { inventory, provider, rightsRequests, encryptionReady } =
    useLoaderData();
  const actionData = useActionData();
  const labels = {
    legacyStoreContacts: "未移行の店舗連絡先",
    legacyVendorEmails: "未移行の管理用メール",
    legacyShopifyTokens: "未移行のShopifyトークン",
    legacyOrderContactCopies: "旧注文の氏名・メール",
    inquiries: "問い合わせ履歴",
    expiredCodes: "清掃対象の確認コード",
    expiredSessions: "清掃対象の店舗セッション",
    resolvedInquiryCandidates: "解決後90日を経過した問い合わせ",
  };
  return (
    <main style={{ maxWidth: "1000px", margin: "0 auto", padding: "24px" }}>
      <h1>個人情報管理</h1>
      <p>店舗連絡先の暗号化: {encryptionReady ? "利用可能" : "準備が必要"}</p>
      {actionData ? (
        <p role="status">
          {actionData.ok
            ? "処理を完了しました。"
            : "設定と確認項目を見直してください。"}
        </p>
      ) : null}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginBottom: "24px",
        }}
      >
        <tbody>
          {Object.entries(inventory).map(([key, value]) => (
            <tr key={key}>
              <th
                style={{
                  textAlign: "left",
                  padding: "10px",
                  borderBottom: "1px solid #ddd",
                }}
              >
                {labels[key]}
              </th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Form method="post">
        <button
          name="intent"
          value="protect-contacts"
          disabled={!encryptionReady}
        >
          旧データを暗号化
        </button>
      </Form>
      <h2>問い合わせ窓口</h2>
      <Form method="post" style={{ display: "grid", gap: "12px" }}>
        <input type="hidden" name="intent" value="contact-channel" />
        <select name="provider" defaultValue={provider}>
          <option value="LEGACY">現在のお問い合わせフォーム</option>
          <option value="SHOPIFY_INBOX">Shopify Inbox</option>
        </select>
        <label>
          <input type="checkbox" name="inboxVerified" value="yes" />
          Shopify Inboxで問い合わせを受信できることを確認しました
        </label>
        <label>
          <input type="checkbox" name="contactPageVerified" value="yes" />
          お問い合わせページを新しい窓口へ切り替えました
        </label>
        <button type="submit">問い合わせ窓口を保存</button>
      </Form>
      <h2>保存と失効</h2>
      <Form method="post">
        <button name="intent" value="revoke-sessions">
          店舗ログインをすべて失効
        </button>
      </Form>
      <Form method="post" style={{ marginTop: "16px" }}>
        <input type="hidden" name="intent" value="prune-resolved" />
        <label>
          <input type="checkbox" name="confirmed" value="yes" required />
          解決済み・保存保留なし・90日経過の問い合わせ削除を確認しました
        </label>
        <button type="submit">削除候補を清掃</button>
      </Form>
      <p>
        <Link to="/app/contact-inquiries">問い合わせ履歴を確認</Link>
      </p>
      <h2>開示・削除の要求</h2>
      {rightsRequests.length === 0 ? (
        <p>未処理の要求はありません。</p>
      ) : (
        rightsRequests.map((row) => (
          <Form
            method="post"
            key={row.id}
            style={{
              display: "grid",
              gap: "8px",
              padding: "16px 0",
              borderBottom: "1px solid #ddd",
            }}
          >
            <input type="hidden" name="intent" value="privacy-rights" />
            <input type="hidden" name="id" value={row.id} />
            <strong>{row.topic}</strong>
            <span>
              対応期限: {new Date(row.deadlineAt).toLocaleDateString("ja-JP")}
            </span>
            {row.shopifyCustomerId ? (
              <a
                href={`https://admin.shopify.com/store/oja-immanuel-bacchus/customers/${row.shopifyCustomerId}`}
                target="_blank"
                rel="noreferrer"
              >
                Shopifyで対象顧客を確認
              </a>
            ) : null}
            <select name="status">
              <option value="COMPLETED">対応完了</option>
              <option value="LEGAL_HOLD">法定保存のため保留</option>
            </select>
            <input
              name="evidenceReference"
              placeholder="対応証拠・保存根拠の参照先"
              required
            />
            <input
              name="evidenceHash"
              placeholder="証拠SHA-256"
              pattern="[a-fA-F0-9]{64}"
              required
            />
            <button type="submit">対応結果を記録</button>
          </Form>
        ))
      )}
    </main>
  );
}
