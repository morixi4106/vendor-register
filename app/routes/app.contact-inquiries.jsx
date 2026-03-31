import { json } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const replyType = url.searchParams.get("replyType") || "";
  const q = url.searchParams.get("q") || "";

  const where = {};

  if (replyType && ["fixed", "ai", "escalation"].includes(replyType)) {
    where.replyType = replyType;
  }

  if (q.trim()) {
    where.OR = [
      { name: { contains: q.trim() } },
      { email: { contains: q.trim() } },
      { phone: { contains: q.trim() } },
      { message: { contains: q.trim() } },
      { replyText: { contains: q.trim() } },
      { matchedRuleId: { contains: q.trim() } },
    ];
  }

  const inquiries = await prisma.contactInquiry.findMany({
    where,
    orderBy: {
      createdAt: "desc",
    },
    take: 100,
  });

  return json({
    inquiries,
    replyType,
    q,
  });
};

function FilterLink({ q, value, label, currentReplyType }) {
  const params = new URLSearchParams();

  if (value) {
    params.set("replyType", value);
  }

  if (q) {
    params.set("q", q);
  }

  const to = params.toString()
    ? `/app/contact-inquiries?${params.toString()}`
    : "/app/contact-inquiries";

  const isActive = currentReplyType === value;

  return (
    <Link
      to={to}
      style={{
        display: "inline-block",
        padding: "10px 14px",
        borderRadius: "8px",
        border: "1px solid #ccc",
        background: isActive ? "#111" : "#fff",
        color: isActive ? "#fff" : "#111",
        textDecoration: "none",
      }}
    >
      {label}
    </Link>
  );
}

function shortenText(text, max = 60) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(0, max) + "...";
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function replyTypeLabel(value) {
  if (value === "fixed") return "固定返信";
  if (value === "ai") return "AI返信";
  if (value === "escalation") return "人対応";
  return value;
}

export default function ContactInquiriesPage() {
  const { inquiries, replyType, q } = useLoaderData();
  const [openId, setOpenId] = useState(null);

  return (
    <div style={{ padding: "24px" }}>
      <h1 style={{ fontSize: "28px", fontWeight: "700", marginBottom: "20px" }}>
        問い合わせ一覧
      </h1>

      <Form
        method="get"
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "20px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <input type="hidden" name="replyType" value={replyType} />

        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="キーワード検索（例: 配送 / 返品 / morixi）"
          style={{
            minWidth: "320px",
            padding: "10px 12px",
            borderRadius: "8px",
            border: "1px solid #ccc",
          }}
        />

        <button
          type="submit"
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            background: "#111",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          検索
        </button>

        <Link
          to="/app/contact-inquiries"
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            background: "#fff",
            color: "#111",
            textDecoration: "none",
          }}
        >
          クリア
        </Link>
      </Form>

      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <FilterLink
          q={q}
          value=""
          label="すべて"
          currentReplyType={replyType}
        />

        <FilterLink
          q={q}
          value="fixed"
          label="固定返信"
          currentReplyType={replyType}
        />

        <FilterLink
          q={q}
          value="ai"
          label="AI返信"
          currentReplyType={replyType}
        />

        <FilterLink
          q={q}
          value="escalation"
          label="人対応"
          currentReplyType={replyType}
        />
      </div>

      <div style={{ marginBottom: "20px", color: "#666" }}>
        件数: {inquiries.length}
        {q ? ` / 検索語: ${q}` : ""}
        {replyType ? ` / 種別: ${replyType}` : ""}
      </div>

      {inquiries.length === 0 ? (
        <div>該当する問い合わせはありません。</div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {inquiries.map((item) => {
            const isOpen = openId === item.id;

            return (
              <div
                key={item.id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: "12px",
                  padding: "16px",
                  background: "#fff",
                }}
              >
                <div
                  onClick={() => {
                    setOpenId(isOpen ? null : item.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "12px",
                      marginBottom: "8px",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontWeight: "700" }}>
                      {item.name} / {replyTypeLabel(item.replyType)}
                    </div>

                    <div style={{ color: "#666", fontSize: "14px" }}>
                      {isOpen ? "閉じる" : "開く"}
                    </div>
                  </div>

                  <div style={{ color: "#666", fontSize: "14px", marginBottom: "6px" }}>
                    {formatDate(item.createdAt)}
                  </div>

                  <div style={{ color: "#333" }}>
                    {shortenText(item.message, 90)}
                  </div>
                </div>

                {isOpen ? (
                  <div style={{ marginTop: "16px" }}>
                    <div style={{ marginBottom: "8px" }}>
                      <strong>名前:</strong> {item.name}
                    </div>

                    <div style={{ marginBottom: "8px" }}>
                      <strong>メール:</strong> {item.email}
                    </div>

                    <div style={{ marginBottom: "8px" }}>
                      <strong>電話番号:</strong> {item.phone || "未入力"}
                    </div>

                    <div style={{ marginBottom: "8px" }}>
                      <strong>返信種別:</strong> {item.replyType}
                    </div>

                    <div style={{ marginBottom: "8px" }}>
                      <strong>一致ルールID:</strong> {item.matchedRuleId || "なし"}
                    </div>

                    <div style={{ marginBottom: "8px" }}>
                      <strong>受信日時:</strong> {new Date(item.createdAt).toLocaleString("ja-JP")}
                    </div>

                    <div style={{ marginBottom: "8px" }}>
                      <strong>問い合わせ本文:</strong>
                      <div
                        style={{
                          marginTop: "6px",
                          whiteSpace: "pre-wrap",
                          background: "#f7f7f7",
                          padding: "12px",
                          borderRadius: "8px",
                        }}
                      >
                        {item.message}
                      </div>
                    </div>

                    <div>
                      <strong>返信文:</strong>
                      <div
                        style={{
                          marginTop: "6px",
                          whiteSpace: "pre-wrap",
                          background: "#f7f7f7",
                          padding: "12px",
                          borderRadius: "8px",
                        }}
                      >
                        {item.replyText}
                      </div>
                    </div>

                    <button
                      onClick={async (e) => {
                        e.stopPropagation();

                        await fetch("/api/fixed-candidate", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                          },
                          body: JSON.stringify({
                            message: item.message,
                            replyText: item.replyText,
                          }),
                        });

                        alert("固定文候補に追加した");
                      }}
                      style={{
                        marginTop: "10px",
                        padding: "8px 12px",
                        borderRadius: "8px",
                        border: "1px solid #ccc",
                        background: "#eee",
                        cursor: "pointer",
                      }}
                    >
                      固定文候補にする
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}