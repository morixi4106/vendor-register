import prisma from "../db.server";
import { serializePublicStore } from "../utils/publicStores";

export const loader = async () => {
  const stores = await prisma.vendorStore.findMany({
    where: {
      vendorAuth: {
        is: {
          status: "active",
        },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      storeName: true,
      category: true,
      country: true,
      address: true,
      note: true,
      createdAt: true,
      vendorAuth: {
        select: {
          handle: true,
          status: true,
        },
      },
    },
  });

  return new Response(JSON.stringify({
    ok: true,
    stores: stores.map(serializePublicStore).filter(Boolean),
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
