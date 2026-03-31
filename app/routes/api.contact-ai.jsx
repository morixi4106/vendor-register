import { json } from "@remix-run/node";
import { Resend } from "resend";
import prisma from "../db.server";

// =========================
// CORS対応
// =========================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  return new Response("Not Found", { status: 404 });
};

// =========================
// 危険ワード定義
// =========================
const ESCALATION_KEYWORDS = [
  "返品",
  "返金",
  "交換",
  "クレーム",
  "苦情",
  "破損",
  "届かない",
  "未着",
  "トラブル",
  "訴訟",
  "違法",
  "責任",
  "副作用",
  "肌荒れ",
  "治る",
  "効能",
  "効果",
  "アレルギー",
  "炎症",
];

// =========================
// 共通関数
// =========================
function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function includesAny(text, keywords) {
  return keywords.some((keyword) =>
    text.includes(String(keyword || "").toLowerCase())
  );
}

function buildEscalationReply({ name }) {
  return `${name} 様

お問い合わせいただきありがとうございます。
Oja Immanuel Bacchus サポートでございます。

お問い合わせ内容を確認いたしました。
本件につきましては重要な確認を要するため、担当者が内容を確認のうえ、順次ご案内いたします。

恐れ入りますが、今しばらくお待ちくださいますようお願いいたします。

何卒よろしくお願い申し上げます。

Oja Immanuel Bacchus サポート`;
}

async function findFixedReplyRule(message) {
  const text = normalizeText(message);

  const rules = await prisma.fixedReplyRule.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  for (const rule of rules) {
    const keyword = normalizeText(rule.keyword);

    if (!keyword) continue;

    if (text.includes(keyword)) {
      return rule;
    }
  }

  return null;
}

function shouldEscalate(message) {
  const text = normalizeText(message);
  return includesAny(text, ESCALATION_KEYWORDS);
}

// =========================
// AI用プロンプト
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
- 一般的な質問は、その場で答えられる範囲で回答する
- 不明点がある場合のみ追加確認を求める
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
// Claude呼び出し
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
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5",
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
        headers: CORS_HEADERS,
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
          headers: CORS_HEADERS,
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
          headers: CORS_HEADERS,
        }
      );
    }

    if (
      !process.env.RESEND_API_KEY ||
      !process.env.MAIL_FROM ||
      !process.env.ADMIN_EMAIL
    ) {
      return json(
        { ok: false, error: "Server env is not configured" },
        {
          status: 500,
          headers: CORS_HEADERS,
        }
      );
    }

    let replyType = "fixed";
    let matchedRuleId = null;
    let replyText = null;

    const matchedRule = await findFixedReplyRule(message);

    if (matchedRule) {
      matchedRuleId = matchedRule.id;
      replyText = matchedRule.replyText;
    } else if (shouldEscalate(message)) {
      replyType = "escalation";
      replyText = buildEscalationReply({ name });
    } else {
      if (!process.env.CLAUDE_API_KEY) {
        return json(
          { ok: false, error: "CLAUDE_API_KEY is not configured" },
          {
            status: 500,
            headers: CORS_HEADERS,
          }
        );
      }

      replyType = "ai";
      replyText = await createClaudeReply({ name, email, phone, message });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: email,
      subject: "お問い合わせありがとうございます",
      text: replyText,
    });

    await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: process.env.ADMIN_EMAIL,
      subject: "新しいお問い合わせが届きました",
      text: [
        "お問い合わせ内容を受信しました。",
        "",
        `返信種別: ${replyType}`,
        `一致ルールID: ${matchedRuleId || "なし"}`,
        `名前: ${name}`,
        `メール: ${email}`,
        `電話番号: ${phone || "未入力"}`,
        "",
        "本文:",
        message,
        "",
        "返信文:",
        replyText,
      ].join("\n"),
    });

    await prisma.contactInquiry.create({
      data: {
        name,
        email,
        phone: phone || null,
        message,
        replyText,
        replyType,
        matchedRuleId,
      },
    });

    return json(
      {
        ok: true,
        replyType,
        matchedRuleId,
      },
      {
        headers: CORS_HEADERS,
      }
    );
  } catch (error) {
    console.error("api.contact-ai error:", error);

    return json(
      { ok: false, error: "Internal server error" },
      {
        status: 500,
        headers: CORS_HEADERS,
      }
    );
  }
};