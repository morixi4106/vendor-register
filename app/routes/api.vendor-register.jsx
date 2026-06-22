import { json } from "@remix-run/node";

import prisma from "../db.server.js";
import { vendorRegistrationTargetCookie } from "../services/vendorManagement.server.js";
import { ensureSellerForVendor } from "../services/sellerPayments.server.js";

const RESERVED_VENDOR_HANDLES = new Set([
  "dashboard",
  "verify",
  "products",
  "orders",
  "inventory",
  "settings",
  "reports",
]);

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function generateUniqueHandle(storeName) {
  const base = slugify(storeName) || "vendor";
  let count = 0;

  while (true) {
    const handle = count === 0 ? base : `${base}-${count}`;

    if (RESERVED_VENDOR_HANDLES.has(handle)) {
      count += 1;
      continue;
    }

    const existing = await prisma.vendor.findUnique({
      where: { handle },
    });

    if (!existing) {
      return handle;
    }

    count += 1;
  }
}

async function registrationSuccessResponse(vendorId) {
  const normalizedVendorId = String(vendorId || "").trim();
  const headers = new Headers();

  if (normalizedVendorId) {
    headers.append(
      "Set-Cookie",
      await vendorRegistrationTargetCookie.serialize(normalizedVendorId),
    );
  }

  return json({ ok: true, vendorId: normalizedVendorId || null }, { headers });
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
    let vendorId = existingStore.vendorAuth?.id || null;

    if (!existingStore.vendorAuth) {
      const handle = await generateUniqueHandle(existingStore.storeName);

      const vendor = await prisma.vendor.create({
        data: {
          vendorStoreId: existingStore.id,
          storeName: existingStore.storeName,
          handle,
          managementEmail: existingStore.email.toLowerCase(),
          status: "active",
        },
      });

      vendorId = vendor.id;

      await ensureSellerForVendor(vendor.id, {
        prismaClient: prisma,
        defaultStatus: "pending",
        changedBy: "system.vendor_register",
        reason: "vendor_registration",
      });
    } else {
      await ensureSellerForVendor(existingStore.vendorAuth.id, {
        prismaClient: prisma,
        defaultStatus: "pending",
        changedBy: "system.vendor_register",
        reason: "vendor_registration",
      });
    }

    return registrationSuccessResponse(vendorId);
  }

  const handle = await generateUniqueHandle(storeName);
  let vendorId = null;

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

    const vendor = await tx.vendor.create({
      data: {
        vendorStoreId: vendorStore.id,
        storeName,
        handle,
        managementEmail: email,
        status: "active",
      },
    });

    vendorId = vendor.id;

    const seller = await tx.seller.create({
      data: {
        vendorId: vendor.id,
        vendorStoreId: vendorStore.id,
        status: "pending",
      },
    });

    await tx.sellerStatusHistory.create({
      data: {
        sellerId: seller.id,
        fromStatus: null,
        toStatus: "pending",
        changedBy: "system.vendor_register",
        reason: "vendor_registration",
      },
    });
  });

  return registrationSuccessResponse(vendorId);
};
