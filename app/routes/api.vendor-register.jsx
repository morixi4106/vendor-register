import { json } from "@remix-run/node";
import prisma from "../db.server";

export const loader = async () => {
  return new Response("proxy ok", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

export const action = async ({ request }) => {
  const formData = await request.formData();

  const email = String(formData.get("email") || "").trim();
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

  await prisma.vendorStore.create({
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

  return json({ ok: true });
};