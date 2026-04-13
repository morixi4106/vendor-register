import { redirect } from "@remix-run/node";
import prisma from "../db.server";
import { resolveShopDomain } from "../utils/shopifyAdmin.server";

export const action = async ({ request }) => {
  const formData = await request.formData();
  const returnTo = String(formData.get("returnTo") || "/admin/products");
  const shopDomain = await resolveShopDomain(formData.get("shopDomain"));

  try {
    await prisma.session.deleteMany({
      where: {
        shop: shopDomain,
        isOnline: false,
      },
    });
  } catch (error) {
    console.log("offline session delete skipped:", error);
  }

  throw redirect(`/auth?shop=${shopDomain}&returnTo=${encodeURIComponent(returnTo)}`);
};

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shopDomain = await resolveShopDomain(
    url.searchParams.get("shopDomain") || url.searchParams.get("shop")
  );

  throw redirect(`/auth?shop=${shopDomain}`);
};
