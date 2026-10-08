import { redirect } from "react-router";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { Resend } from "resend";
import prisma from "../db.server";
export { privateDocumentHeaders as headers } from "../utils/privateHeaders.js";
import {
  consumeVendorLoginCode,
  enforceVendorAuthenticationRateLimit,
  findVendorAdminSession,
  findVendorForAuthentication,
  issueVendorLoginCode,
} from "../services/vendorAuthentication.server.js";
import { privateErrorCode } from "../utils/privateData.server.js";
import { readBoundedFormData } from "../utils/requestBody.server.js";
import {
  appendVendorIdToPath,
  createVendorAdminSessionCookieHeaders,
  getVendorReturnTo,
  isConfiguredAdminEmail,
  sanitizeVendorReturnTo,
  vendorAdminSessionCookie,
  vendorAdminSessionsCookie,
} from "../services/vendorManagement.server";

const DEFAULT_RETURN_TO = "/vendor/dashboard";
const resend = new Resend(process.env.RESEND_API_KEY);

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const targetVendorId = String(url.searchParams.get("vendorId") || "").trim();
  const returnTo = appendVendorIdToPath(
    getVendorReturnTo(request, DEFAULT_RETURN_TO),
    targetVendorId,
  );
  const forceVerify = url.searchParams.get("force") === "1";
  const cookieHeader = request.headers.get("Cookie");
  const currentSessionToken = await vendorAdminSessionCookie.parse(cookieHeader);
  const sessionMap =
    (await vendorAdminSessionsCookie.parse(cookieHeader))?.sessions || {};
  const sessionToken = targetVendorId
    ? String(sessionMap[targetVendorId] || currentSessionToken || "")
    : currentSessionToken;

  if (sessionToken && !forceVerify) {
    const session = await findVendorAdminSession(sessionToken, { include: { vendor: true } });

    if (
      session &&
      session.expiresAt > new Date() &&
      (!targetVendorId || session.vendorId === targetVendorId)
    ) {
      return redirect(returnTo);
    }
  }

  return Response.json({ returnTo, targetVendorId });
};

export const action = async (args) => {
  try { return await handleAction(args); }
  catch (error) {
    if (error instanceof Response) return error;
    console.error("vendor authentication failed", { code: privateErrorCode(error) });
    return Response.json({ ok: false, step: "email", error: "時間を置いて再度お試しください。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};

async function handleAction({ request }) {
  const formData = await readBoundedFormData(request, 8000);
  const intent = String(formData.get("intent") || "");
  const formVendorId = String(formData.get("vendorId") || "").trim();
  if (["send-code", "verify-code"].includes(intent)) {
    await enforceVendorAuthenticationRateLimit({ request, email: String(formData.get("email") || "").trim(), intent });
  }
  const returnTo = appendVendorIdToPath(
    sanitizeVendorReturnTo(
    formData.get("returnTo") || new URL(request.url).searchParams.get("returnTo"),
    DEFAULT_RETURN_TO
    ),
    formVendorId,
  );

  if (intent === "send-code") {
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const targetVendorId = formVendorId;
    const isAdminEmail = isConfiguredAdminEmail(email);

    if (!email) {
      return Response.json(
        { ok: false, step: "email", error: "メールアドレスを入力してください。", returnTo },
        { status: 400 }
      );
    }

    if (isAdminEmail && !targetVendorId) {
      return Response.json(
        {
          ok: false,
          step: "email",
          error: "管理者メールで入る場合は、管理画面から対象店舗を選択してください。",
          returnTo,
        },
        { status: 400 }
      );
    }

    const vendor = await findVendorForAuthentication({ email, vendorId: targetVendorId, isAdmin: isAdminEmail });

    if (!vendor) {
      return Response.json(
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

    const { code, id: challengeId } = await issueVendorLoginCode({ vendorId: vendor.id, email });

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
        console.error("vendor verification email failed", { code: "mail_send_failed" });
        await prisma.vendorLoginCode.update({ where: { id: challengeId }, data: { usedAt: new Date() } });

        return Response.json(
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
      console.error("vendor verification email failed", { code: privateErrorCode(e) });
      await prisma.vendorLoginCode.update({ where: { id: challengeId }, data: { usedAt: new Date() } });

      return Response.json(
        {
          ok: false,
          step: "email",
          error: "確認コードのメール送信に失敗しました。",
          returnTo,
        },
        { status: 500 }
      );
    }

    return Response.json({
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
    const vendorId = formVendorId;
    const code = String(formData.get("code") || "").trim();
    const isAdminEmail = isConfiguredAdminEmail(email);

    if (!email || !vendorId || !code) {
      return Response.json(
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

    const vendor = await findVendorForAuthentication({ email, vendorId, isAdmin: isAdminEmail });

    if (
      !vendor ||
      vendor.status !== "active" ||
      (!isAdminEmail && vendor.managementEmail.toLowerCase() !== email)
    ) {
      return Response.json(
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

    const verified = await consumeVendorLoginCode({ vendorId, email, code });

    if (!verified) {
      return Response.json(
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

    return redirect(returnTo, {
      headers: await createVendorAdminSessionCookieHeaders(request, {
        vendorId,
        sessionToken: verified.sessionToken,
      }),
    });
  }

  return Response.json(
    { ok: false, step: "email", error: "不正な操作です。", returnTo },
    { status: 400 }
  );
}

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
