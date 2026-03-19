import { json } from "@remix-run/node";
import prisma from "../db.server";

export const loader = async () => {
  const stores = await prisma.vendorStore.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      storeName: true,
      category: true,
      country: true,
      createdAt: true,
    },
  });

  return json({ ok: true, stores });
};