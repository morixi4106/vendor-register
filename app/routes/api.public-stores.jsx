import prisma from "../db.server";

export const loader = async () => {
  const stores = await prisma.vendorStore.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      storeName: true,
      category: true,
      country: true,
      address: true,
      note: true,
      createdAt: true,
    },
  });

  return new Response(JSON.stringify({ ok: true, stores }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};