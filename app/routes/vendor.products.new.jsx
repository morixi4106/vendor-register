import { createCookie, json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { Resend } from "resend";
import VendorManagementShell from "../components/vendor/VendorManagementShell";
import VendorProductForm from "../components/vendor/VendorProductForm";
import prisma from "../db.server";
import { PRICE_SYNC_STATUS } from "../utils/priceSyncStatus";

const ALLOWED_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "CNY", "KRW"];

const COPY = {
  storeNotFound: "店舗情報が見つかりません。",
  unsupportedCurrency: "対応していない通貨です。",
  productNameRequired: "商品名を入力してください。",
  priceRequired: "価格を入力してください。",
  invalidPrice: "価格は0以上の数値で入力してください。",
  registerFailed:
    "商品の登録に失敗しました。時間を置いて再度お試しください。",
  cloudinaryMissing: "Cloudinary の環境変数が足りません。",
  shellTitle: "商品管理",
  pageTitle: "新規商品登録",
  intro:
    "新しい商品を登録します。保存後は申請中となり、内容確認後に Shopify へ反映されます。",
  submit: "商品を登録する",
  submitting: "登録中...",
  backToDashboard: "ダッシュボードへ戻る",
  uploadHint:
    "画像を選択すると、保存時にアップロードされます。未選択でも商品登録は可能です。",
  noImage: "まだ画像は登録されていません。",
};

const resend = new Resend(process.env.RESEND_API_KEY);

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

async function uploadImageToCloudinary(file) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error(COPY.cloudinaryMissing);
  }

  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) {
    return null;
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const form = new FormData();
  form.append("file", new Blob([buffer]), file.name || "upload.jpg");
  form.append("upload_preset", uploadPreset);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Cloudinary upload failed: ${JSON.stringify(data)}`);
  }

  return data.secure_url || null;
}

async function getVendorSessionOrRedirect(request) {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("/vendor/verify");
  }

  const vendorSession = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
    },
  });

  if (!vendorSession || vendorSession.expiresAt < new Date()) {
    throw redirect("/vendor/verify", {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  return vendorSession;
}

export const loader = async ({ request }) => {
  const vendorSession = await getVendorSessionOrRedirect(request);
  const store = vendorSession.vendor?.vendorStore;

  if (!store) {
    throw new Response(COPY.storeNotFound, { status: 404 });
  }

  return json({
    store: {
      id: store.id,
      storeName: store.storeName,
    },
  });
};

export const action = async ({ request }) => {
  const vendorSession = await getVendorSessionOrRedirect(request);
  const store = vendorSession.vendor?.vendorStore;

  if (!store) {
    return json({ ok: false, error: COPY.storeNotFound }, { status: 404 });
  }

  try {
    const formData = await request.formData();
    const imageFile = formData.get("image");

    let imageUrl = null;

    if (imageFile && typeof imageFile.size === "number" && imageFile.size > 0) {
      imageUrl = await uploadImageToCloudinary(imageFile);
    }

    const name = String(formData.get("name") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const category = String(formData.get("category") || "").trim();
    const priceRaw = String(formData.get("price") || "").trim();
    const url = String(formData.get("url") || "").trim();
    const costCurrency = String(formData.get("costCurrency") || "JPY")
      .trim()
      .toUpperCase();

    if (!ALLOWED_CURRENCIES.includes(costCurrency)) {
      return json(
        { ok: false, error: COPY.unsupportedCurrency },
        { status: 400 }
      );
    }

    if (!name) {
      return json(
        { ok: false, error: COPY.productNameRequired },
        { status: 400 }
      );
    }

    if (!priceRaw) {
      return json({ ok: false, error: COPY.priceRequired }, { status: 400 });
    }

    const costAmount = Number(priceRaw);

    if (!Number.isFinite(costAmount) || costAmount < 0) {
      return json({ ok: false, error: COPY.invalidPrice }, { status: 400 });
    }

    const createdProduct = await prisma.product.create({
      data: {
        name,
        description: description || null,
        imageUrl,
        category: category || null,
        price: costAmount,
        costAmount,
        costCurrency,
        url: url || null,
        vendorStoreId: store.id,
        approvalStatus: "pending",
        priceSyncStatus: PRICE_SYNC_STATUS.CALCULATED_NOT_APPLIED,
        priceSyncError: null,
      },
    });

    try {
      const adminUrl = `https://vendor-register-pbjl.onrender.com/admin/products/${createdProduct.id}`;

      await resend.emails.send({
        from: process.env.MAIL_FROM,
        to: [process.env.ADMIN_EMAIL],
        subject: "新しい商品申請がありました",
        text: `商品名: ${createdProduct.name}
店舗: ${store.storeName}

確認画面:
${adminUrl}`,
      });
    } catch (error) {
      console.error("admin notification email failed:", error);
    }
  } catch (error) {
    console.error("vendor product create error:", error);

    return json({ ok: false, error: COPY.registerFailed }, { status: 500 });
  }

  return redirect("/vendor/dashboard");
};

export default function VendorProductsNew() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const { store } = useLoaderData();

  const isSubmitting = navigation.state === "submitting";

  return (
    <VendorManagementShell
      activeItem="products"
      storeName={store.storeName}
      title={COPY.shellTitle}
    >
      <VendorProductForm
        backLabel={COPY.backToDashboard}
        backTo="/vendor/dashboard"
        error={actionData?.error}
        imageEmptyText={COPY.noImage}
        intro={COPY.intro}
        isSubmitting={isSubmitting}
        storeName={store.storeName}
        submitLabel={COPY.submit}
        submittingLabel={COPY.submitting}
        title={COPY.pageTitle}
        uploadHint={COPY.uploadHint}
      />
    </VendorManagementShell>
  );
}
