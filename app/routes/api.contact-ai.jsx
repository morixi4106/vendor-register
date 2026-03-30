import { json } from "@remix-run/node";
import { Resend } from "resend";

// =========================
// CORS対応（OPTIONS）
// =========================
export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  return new Response("Not Found", { status: 404 });
};

// =========================
// プロンプト生成
// =========================
function buildPrompt({ name, email, phone, message }) {
  return `
あなたは EC サイト「Oja Immanuel Bacchus」のカスタマーサポート担当です。
以下のお問い合わせに対して、日本語で丁寧で自然な一次返信メール文を作成してください。

条件:
- 丁寧な敬語
- 長すぎない
- まだ確定していないことを断定しない
- 返品・返金・法的判断・医療判断は勝手に断定しない
- 必要に応じて「担当者が確認のうえご案内します」と書く
- 件名は作らず、本文だけ作る
- 最後に必ず「Oja Immanuel Bacchus サポート」を入れる

お問い合わせ情報:
【お名前】
${name || "未入力"}

【メールアドレス】
${email || "未入力"}

【電話番号】
${phone || "未入力"}

【お問い合わせ内容】
${message || "未入力"}
`.trim();
}

// =========================
// Claude 呼び出し
// =========================
async function createClaudeReply({ name, email, phone, message }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5", // ←修正済み
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: buildPrompt({ name, email, phone, message }),
        },
      ],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Claude API error: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  const reply = data?.content?.[0]?.text?.trim();

  if (!reply) {
    throw new Error("Claude reply is empty");
  }

  return reply;
}

// =========================
// メイン処理
// =========================
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json(
      { ok: false, error: "Method not allowed" },
      {
        status: 405,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return json(
        { ok: false, error: "Content-Type must be application/json" },
        {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    const body = await request.json();

    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim();
    const phone = String(body?.phone || "").trim();
    const message = String(body?.message || "").trim();

    if (!name || !email || !message) {
      return json(
        { ok: false, error: "name, email, message are required" },
        {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    if (
      !process.env.CLAUDE_API_KEY ||
      !process.env.RESEND_API_KEY ||
      !process.env.MAIL_FROM ||
      !process.env.ADMIN_EMAIL
    ) {
      return json(
        { ok: false, error: "Server env is not configured" },
        {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    // =========================
    // AI生成
    // =========================
    const aiReply = await createClaudeReply({ name, email, phone, message });

    const resend = new Resend(process.env.RESEND_API_KEY);

    // =========================
    // ユーザー返信
    // =========================
    await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: email,
      subject: "お問い合わせありがとうございます",
      text: aiReply,
    });

    // =========================
    // 管理者通知
    // =========================
    await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: process.env.ADMIN_EMAIL,
      subject: "新しいお問い合わせが届きました",
      text: [
        "お問い合わせ内容を受信しました。",
        "",
        `名前: ${name}`,
        `メール: ${email}`,
        `電話番号: ${phone || "未入力"}`,
        "",
        "本文:",
        message,
        "",
        "AI自動返信文:",
        aiReply,
      ].join("\n"),
    });

    return json(
      { ok: true },
      {
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  } catch (error) {
    console.error("api.contact-ai error:", error);

    return json(
      { ok: false, error: "Internal server error" },
      {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  }
};