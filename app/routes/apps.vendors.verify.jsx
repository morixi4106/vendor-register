import { json, redirect, createCookie } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
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

  if (!sessionToken) {
    return json({ ok: true });
  }

  const session = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: { vendor: true },
  });

  if (!session || session.expiresAt <= new Date()) {
    return json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": await vendorAdminCookie.serialize("", {
            maxAge: 0,
          }),
        },
      }
    );
  }

  return redirect(`/apps/vendors/dashboard?vendor=${session.vendorId}`);
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "send-code") {
    const email = String(formData.get("email") || "").trim().toLowerCase();

    if (!email) {
      return json({ ok: false, error: "メールアドレスを入力してください。" }, { status: 400 });
    }

    const vendor = await prisma.vendor.findFirst({
      where: {
        managementEmail: email,
        status: "active",
      },
    });

    if (!vendor) {
      return json(
        { ok: false, error: "該当する店舗が見つかりません。" },
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

    console.log("Vendor verify code:", {
      vendorId: vendor.id,
      email,
      code,
      expiresAt: expiresAt.toISOString(),
    });

    return json({
      ok: true,
      step: "code-sent",
      message: "確認コードを発行しました。",
      email,
    });
  }

  if (intent === "verify-code") {
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const code = String(formData.get("code") || "").trim();

    if (!email || !code) {
      return json(
        { ok: false, error: "メールアドレスと確認コードを入力してください。" },
        { status: 400 }
      );
    }

    const vendor = await prisma.vendor.findFirst({
      where: {
        managementEmail: email,
        status: "active",
      },
    });

    if (!vendor) {
      return json(
        { ok: false, error: "該当する店舗が見つかりません。" },
        { status: 404 }
      );
    }

    const loginCode = await prisma.vendorLoginCode.findFirst({
      where: {
        vendorId: vendor.id,
        email,
        code,
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!loginCode) {
      return json(
        { ok: false, error: "確認コードが正しくないか、有効期限切れです。" },
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
        vendorId: vendor.id,
        sessionToken,
        expiresAt,
      },
    });

    return redirect(`/apps/vendors/dashboard?vendor=${vendor.id}`, {
      headers: {
        "Set-Cookie": await vendorAdminCookie.serialize(sessionToken),
      },
    });
  }

  return json({ ok: false, error: "不正なリクエストです。" }, { status: 400 });
};

export default function VendorVerifyPage() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";
  const sentEmail = actionData?.email || "";

  return (
    <div
      style={{
        maxWidth: "560px",
        margin: "60px auto",
        padding: "24px",
        fontFamily: "sans-serif",
      }}
    >
      <h1 style={{ fontSize: "28px", fontWeight: "700", marginBottom: "24px" }}>
        店舗管理者ログイン
      </h1>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          padding: "20px",
          marginBottom: "20px",
        }}
      >
        <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>確認コード送信</h2>

        <Form method="post">
          <input type="hidden" name="intent" value="send-code" />
          <div style={{ marginBottom: "12px" }}>
            <input
              type="email"
              name="email"
              placeholder="管理用メールアドレス"
              defaultValue={sentEmail}
              style={{
                width: "100%",
                padding: "12px",
                border: "1px solid #ccc",
                borderRadius: "8px",
              }}
            />
          </div>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              width: "100%",
              padding: "12px",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            {isSubmitting ? "送信中..." : "確認コードを送信"}
          </button>
        </Form>
      </div>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          padding: "20px",
        }}
      >
        <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>確認コード入力</h2>

        <Form method="post">
          <input type="hidden" name="intent" value="verify-code" />
          <div style={{ marginBottom: "12px" }}>
            <input
              type="email"
              name="email"
              placeholder="管理用メールアドレス"
              defaultValue={sentEmail}
              style={{
                width: "100%",
                padding: "12px",
                border: "1px solid #ccc",
                borderRadius: "8px",
              }}
            />
          </div>
          <div style={{ marginBottom: "12px" }}>
            <input
              type="text"
              name="code"
              placeholder="6桁コード"
              style={{
                width: "100%",
                padding: "12px",
                border: "1px solid #ccc",
                borderRadius: "8px",
              }}
            />
          </div>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              width: "100%",
              padding: "12px",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            {isSubmitting ? "確認中..." : "ログイン"}
          </button>
        </Form>
      </div>

      {actionData?.message ? (
        <p style={{ marginTop: "16px" }}>{actionData.message}</p>
      ) : null}

      {actionData?.error ? (
        <p style={{ marginTop: "16px", color: "red" }}>{actionData.error}</p>
      ) : null}
    </div>
  );
}