import { json, redirect, createCookie } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { randomBytes, randomInt } from "crypto";
import prisma from "../db.server";

const vendorAdminCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export const loader = async ({ request }) => {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminCookie.parse(cookieHeader);

  if (sessionToken) {
    const session = await prisma.vendorAdminSession.findUnique({
      where: { sessionToken },
      include: { vendor: true },
    });

    if (session && session.expiresAt > new Date()) {
      return redirect(`/app/vendor-dashboard?vendor=${session.vendorId}`);
    }
  }

  return json({});
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "send-code") {
    const email = String(formData.get("email") || "").trim().toLowerCase();

    if (!email) {
      return json({ ok: false, step: "email", error: "メールアドレスを入力してください。" }, { status: 400 });
    }

    const vendor = await prisma.vendor.findFirst({
      where: {
        managementEmail: email,
        status: "active",
      },
    });

    if (!vendor) {
      return json(
        { ok: false, step: "email", error: "このメールアドレスは管理用メールとして登録されていません。" },
        { status: 404 },
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

    console.log("Vendor verify code:", {
      vendorId: vendor.id,
      email,
      code,
      expiresAt: expiresAt.toISOString(),
    });

    return json({
      ok: true,
      step: "code",
      message: "確認コードを送信しました。",
      email,
      vendorId: vendor.id,
    });
  }

  if (intent === "verify-code") {
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const vendorId = String(formData.get("vendorId") || "").trim();
    const code = String(formData.get("code") || "").trim();

    if (!email || !vendorId || !code) {
      return json(
        { ok: false, step: "code", error: "必要な情報が不足しています。もう一度やり直してください。", email, vendorId },
        { status: 400 },
      );
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
    });

    if (!vendor || vendor.managementEmail.toLowerCase() !== email || vendor.status !== "active") {
      return json(
        { ok: false, step: "code", error: "管理対象の店舗が見つかりません。", email, vendorId },
        { status: 404 },
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
        { ok: false, step: "code", error: "確認コードが違うか、有効期限が切れています。", email, vendorId },
        { status: 400 },
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

    return redirect(`/app/vendor-dashboard?vendor=${vendorId}`, {
      headers: {
        "Set-Cookie": await vendorAdminCookie.serialize(sessionToken),
      },
    });
  }

  return json({ ok: false, step: "email", error: "不正な操作です。" }, { status: 400 });
};

export default function VendorVerifyPage() {
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSending = navigation.state === "submitting";

  const step = actionData?.step === "code" ? "code" : "email";
  const email = actionData?.email || "";
  const vendorId = actionData?.vendorId || "";

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
          <Form method="post" style={styles.form}>
            <input type="hidden" name="intent" value="send-code" />

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
          </Form>
        ) : (
          <Form method="post" style={styles.form}>
            <input type="hidden" name="intent" value="verify-code" />
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="vendorId" value={vendorId} />

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
          </Form>
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