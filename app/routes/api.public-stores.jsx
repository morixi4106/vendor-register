import { json } from "@remix-run/node";
import prisma from "../db.server";

export const loader = async () => {
  const stores = await prisma.vendorStore.findMany({
    orderBy: { createdAt: "desc" },
  });

  return json({ stores });
};