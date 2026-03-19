import { json } from "@remix-run/node";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const formData = await request.formData();

  const name = formData.get("name");
  const price = parseInt(formData.get("price"), 10);
  const vendorStoreId = formData.get("vendorStoreId");

  if (!name || !price || !vendorStoreId) {
    return json({ error: "missing fields" }, { status: 400 });
  }

  const product = await prisma.product.create({
    data: {
      name,
      price,
      vendorStoreId,
    },
  });

  return json({ success: true, product });
};