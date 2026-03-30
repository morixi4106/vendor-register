import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import prisma from "../db.server";

export const loader = async () => {
  const inquiries = await prisma.contactInquiry.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: 100,
  });

  return json({ inquiries });
};

export default function ContactInquiriesPage() {
  const { inquiries } = useLoaderData();

  return (
    <div style={{ padding: "24px" }}>
      <h1 style={{ fontSize: "28px", fontWeight: "700", marginBottom: "20px" }}>
        問い合わせ一覧
      </h1>

      {inquiries.length === 0 ? (
        <div>まだ問い合わせはありません。</div>
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