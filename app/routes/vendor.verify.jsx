import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { randomBytes, randomInt } from "crypto";
import { Resend } from "resend";
import prisma from "../db.server";
import {
  getVendorReturnTo,
  isConfiguredAdminEmail,
  sanitizeVendorReturnTo,
  vendorAdminSessionCookie,
} from "../services/vendorManagement.server";

const DEFAULT_RETURN_TO = "/vendor/dashboard";
const resend = new Resend(process.env.RESEND_API_KEY);

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const returnTo = getVendorReturnTo(request, DEFAULT_RETURN_TO);
  const targetVendorId = String(url.searchParams.get("vendorId") || "").trim();
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (sessionToken) {
    const session = await prisma.vendorAdminSession.findUnique({
      where: { sessionToken },
      include: { vendor: true },
    });

    if (
      session &&
      session.expiresAt > new Date() &&
      (!targetVendorId || session.vendorId === targetVendorId)
    ) {
      return redirect(returnTo);
    }
  }

  return json({ returnTo, targetVendorId });
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const returnTo = sanitizeVendorReturnTo(
    formData.get("returnTo") || new URL(request.url).searchParams.get("returnTo"),
    DEFAULT_RETURN_TO
  );

  if (intent === "send-code") {
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const targetVendorId = String(formData.get("vendorId") || "").trim();
    const isAdminEmail = isConfiguredAdminEmail(email);

    if (!email) {
      return json(
        { ok: false, step: "email", error: "メールアドレスを入力してください。", returnTo },
        { status: 400 }
      );
    }

    if (isAdminEmail && !targetVendorId) {
      return json(
        {
          ok: false,
          step: "email",
          error: "管理者メールで入る場合は、管理画面から対象店舗を選択してください。",
          returnTo,
        },
        { status: 400 }
      );
    }

    const vendor = await prisma.vendor.findFirst({
      where: isAdminEmail
        ? {
            id: targetVendorId,
            status: "active",
          }
        : {
            ...(targetVendorId ? { id: targetVendorId } : {}),
            managementEmail: email,
            status: "active",
          },
    });

    if (!vendor) {
      return json(
        {
          ok: false,
          step: "email",
          error: isAdminEmail
            ? "対象店舗が見つからないか、利用できない状態です。"
            : "このメールアドレスは管理用メールとして登録されていません。",
          returnTo,
        },
        { status: 404 }
      );
    }

    const code = String(randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.vendorLoginCode.create({
      data: {
        vendorId: vendor.id,
        email,
        code,
        expiresAt,
      },
    });

    try {
      const { error } = await resend.emails.send({
        from: process.env.MAIL_FROM,
        to: [email],
        subject: "【Oja Immanuel Bacchus】確認コードのお知らせ",
        text:
          `店舗管理ページの確認コードをお送りします。\n\n` +
          `確認コード: ${code}\n` +
          `有効期限: 10分\n\n` +
          `このメールに心当たりがない場合は、このメールを破棄してください。`,
      });

      if (error) {
        console.error("❌ resend error:", error);

        return json(
          {
            ok: false,
            step: "email",
            error: "確認コードのメール送信に失敗しました。",
            returnTo,
          },
          { status: 500 }
        );
      }
    } catch (e) {
      console.error("❌ verify mail error:", e);

      return json(
        {
          ok: false,
          step: "email",
          error: "確認コードのメール送信に失敗しました。",
          returnTo,
        },
        { status: 500 }
      );
    }

    return json({
      ok: true,
      step: "code",
      message: "確認コードを送信しました。",
      email,
      vendorId: vendor.id,
      returnTo,
    });
  }

  if (intent === "verify-code") {
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const vendorId = String(formData.get("vendorId") || "").trim();
    const code = String(formData.get("code") || "").trim();
    const isAdminEmail = isConfiguredAdminEmail(email);

    if (!email || !vendorId || !code) {
      return json(
        {
          ok: false,
          step: "code",
          error: "必要な情報が不足しています。もう一度やり直してください。",
          email,
          vendorId,
          returnTo,
        },
        { status: 400 }
      );
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
    });

    if (
      !vendor ||
      vendor.status !== "active" ||
      (!isAdminEmail && vendor.managementEmail.toLowerCase() !== email)
    ) {
      return json(
        {
          ok: false,
          step: "code",
          error: "管理対象の店舗が見つかりません。",
          email,
          vendorId,
          returnTo,
        },
        { status: 404 }
      );
    }

    const loginCode = await prisma.vendorLoginCode.findFirst({
      where: {
        vendorId,
        email,
        code,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!loginCode) {
      return json(
        {
          ok: false,
          step: "code",
          error: "確認コードが違うか、有効期限が切れています。",
          email,
          vendorId,
          returnTo,
        },
        { status: 400 }
      );
    }

    await prisma.vendorLoginCode.update({
      where: { id: loginCode.id },
      data: { usedAt: new Date() },
    });

    const sessionToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

    await prisma.vendorAdminSession.create({
      data: {
        vendorId,
        sessionToken,
        expiresAt,
      },
    });

    return redirect(returnTo, {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize(sessionToken),
      },
    });
  }

  return json(
    { ok: false, step: "email", error: "不正な操作です。", returnTo },
    { status: 400 }
  );
};

export default function VendorVerifyPage() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSending = navigation.state === "submitting";

  const step = actionData?.step === "code" ? "code" : "email";
  const email = actionData?.email || "";
  const vendorId = actionData?.vendorId || loaderData?.targetVendorId || "";
  const returnTo = actionData?.returnTo || loaderData?.returnTo || DEFAULT_RETURN_TO;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>店舗管理ページ確認</h1>
        <p style={styles.lead}>
          管理用メールアドレスに確認コードを送信します。
          <br />
          メールを受け取れる方のみ先へ進めます。
        </p>

        {actionData?.error ? <div style={styles.error}>{actionData.error}</div> : null}
        {actionData?.message ? <div style={styles.success}>{actionData.message}</div> : null}

        {step === "email" ? (
          <form method="post" action="" style={styles.form}>
            <input type="hidden" name="intent" value="send-code" />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="vendorId" value={vendorId} />

            <label style={styles.label}>
              管理用メールアドレス
              <input
                type="email"
                name="email"
                placeholder="example@shop.com"
                required
                style={styles.input}
              />
            </label>

            <button type="submit" style={styles.button} disabled={isSending}>
              {isSending ? "送信中..." : "確認コードを送る"}
            </button>
          </form>
        ) : (
          <form method="post" action="" style={styles.form}>
            <input type="hidden" name="intent" value="verify-code" />
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="vendorId" value={vendorId} />
            <input type="hidden" name="returnTo" value={returnTo} />

            <label style={styles.label}>
              確認コード
              <input
                type="text"
                name="code"
                placeholder="6桁コード"
                inputMode="numeric"
                maxLength={6}
                required
                style={styles.input}
              />
            </label>

            <div style={styles.note}>送信先: {email}</div>

            <button type="submit" style={styles.button} disabled={isSending}>
              {isSending ? "確認中..." : "店舗管理ページへ進む"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f6f6",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  card: {
    width: "100%",
    maxWidth: "560px",
    background: "#ffffff",
    border: "1px solid #d9d9d9",
    borderRadius: "20px",
    padding: "32px",
    boxSizing: "border-box",
  },
  title: {
    margin: "0 0 16px",
    fontSize: "32px",
    fontWeight: 700,
    color: "#111111",
  },
  lead: {
    margin: "0 0 24px",
    fontSize: "16px",
    lineHeight: 1.8,
    color: "#333333",
  },
  form: {
    display: "grid",
    gap: "18px",
  },
  label: {
    display: "grid",
    gap: "10px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#111111",
  },
  input: {
    width: "100%",
    height: "52px",
    borderRadius: "12px",
    border: "1px solid #cfcfcf",
    padding: "0 16px",
    fontSize: "16px",
    boxSizing: "border-box",
  },
  button: {
    height: "56px",
    border: "none",
    borderRadius: "999px",
    background: "#111111",
    color: "#ffffff",
    fontSize: "20px",
    fontWeight: 700,
    cursor: "pointer",
  },
  error: {
    marginBottom: "16px",
    padding: "14px 16px",
    borderRadius: "12px",
    background: "#fff1f1",
    border: "1px solid #f0b7b7",
    color: "#b42318",
    fontSize: "14px",
  },
  success: {
    marginBottom: "16px",
    padding: "14px 16px",
    borderRadius: "12px",
    background: "#f0fff4",
    border: "1px solid #a6d8b8",
    color: "#166534",
    fontSize: "14px",
  },
  note: {
    fontSize: "14px",
    color: "#555555",
  },
};
