import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const replyType = url.searchParams.get("replyType");

  const where = {};
  if (replyType && ["fixed", "ai", "escalation"].includes(replyType)) {
    where.replyType = replyType;
  }

  const inquiries = await prisma.contactInquiry.findMany({
    where,
    orderBy: {
      createdAt: "desc",
    },
    take: 100,
  });

  return json({ inquiries, replyType: replyType || "" });
};

export default function ContactInquiriesPage() {
  const { inquiries, replyType } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();

  function handleFilterChange(nextReplyType) {
    const nextParams = new URLSearchParams(searchParams);

    if (nextReplyType) {
      nextParams.set("replyType", nextReplyType);
    } else {
      nextParams.delete("replyType");
    }

    setSearchParams(nextParams);
  }

  return (
    <div style={{ padding: "24px" }}>
      <h1 style={{ fontSize: "28px", fontWeight: "700", marginBottom: "20px" }}>
        問い合わせ一覧
      </h1>

      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => handleFilterChange("")}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            background: replyType === "" ? "#111" : "#fff",
            color: replyType === "" ? "#fff" : "#111",
            cursor: "pointer",
          }}
        >
          すべて
        </button>

        <button
          type="button"
          onClick={() => handleFilterChange("fixed")}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            background: replyType === "fixed" ? "#111" : "#fff",
            color: replyType === "fixed" ? "#fff" : "#111",
            cursor: "pointer",
          }}
        >
          固定返信
        </button>

        <button
          type="button"
          onClick={() => handleFilterChange("ai")}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            background: replyType === "ai" ? "#111" : "#fff",
            color: replyType === "ai" ? "#fff" : "#111",
            cursor: "pointer",
          }}
        >
          AI返信
        </button>

        <button
          type="button"
          onClick={() => handleFilterChange("escalation")}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            background: replyType === "escalation" ? "#111" : "#fff",
            color: replyType === "escalation" ? "#fff" : "#111",
            cursor: "pointer",
          }}
        >
          人対応
        </button>
      </div>

      {inquiries.length === 0 ? (
        <div>該当する問い合わせはありません。</div>
      ) : (
        <div style={{ display: "grid", gap: "16px" }}>
          {inquiries.map((item) => (
            <div
              key={item.id}
              style={{
                border: "1px solid #ddd",
                borderRadius: "12px",
                padding: "16px",
                background: "#fff",
              }}
            >
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
                <strong>受信日時:</strong>{" "}
                {new Date(item.createdAt).toLocaleString("ja-JP")}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}