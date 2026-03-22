import { json } from "@remix-run/node";
import prisma from "../db.server";

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "-")
    .replace(/\-+/g, "-")
    .replace(/^\-+|\-+$/g, "");
}

async function generateUniqueHandle(storeName) {
  const base = slugify(storeName) || "vendor";
  let handle = base;
  let count = 1;

  while (true) {
    const existing = await prisma.vendor.findUnique({
      where: { handle },
    });

    if (!existing) {
      return handle;
    }

    count += 1;
    handle = `${base}-${count}`;
  }
}

export const loader = async () => {
  return new Response("proxy ok", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

export const action = async ({ request }) => {
  const formData = await request.formData();

  const email = String(formData.get("email") || "").trim().toLowerCase();
  const phone = String(formData.get("phone") || "").trim();
  const ownerName = String(formData.get("owner_name") || "").trim();
  const storeName = String(formData.get("store_name") || "").trim();
  const address = String(formData.get("address") || "").trim();
  const country = String(formData.get("country") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const note = String(formData.get("note") || "").trim();
  const ageCheck = String(formData.get("age_check") || "").trim();

  if (
    !email ||
    !phone ||
    !ownerName ||
    !storeName ||
    !address ||
    !country ||
    !category ||
    !ageCheck
  ) {
    return json(
      {
        ok: false,
        errors: [{ message: "必須項目が不足しています。" }],
      },
      { status: 400 }
    );
  }

  const existingStore = await prisma.vendorStore.findFirst({
    where: { email },
    include: { vendorAuth: true },
  });

  if (existingStore) {
    if (!existingStore.vendorAuth) {
      const handle = await generateUniqueHandle(existingStore.storeName);

      await prisma.vendor.create({
        data: {
          vendorStoreId: existingStore.id,
          storeName: existingStore.storeName,
          handle,
          managementEmail: existingStore.email.toLowerCase(),
          status: "active",
        },
      });
    }

    return json({ ok: true });
  }

  const handle = await generateUniqueHandle(storeName);

  await prisma.$transaction(async (tx) => {
    const vendorStore = await tx.vendorStore.create({
      data: {
        email,
        phone,
        ownerName,
        storeName,
        address,
        country,
        category,
        note: note || null,
        ageCheck,
      },
    });

    await tx.vendor.create({
      data: {
        vendorStoreId: vendorStore.id,
        storeName,
        handle,
        managementEmail: email,
        status: "active",
      },
    });
  });

  return json({ ok: true });
};