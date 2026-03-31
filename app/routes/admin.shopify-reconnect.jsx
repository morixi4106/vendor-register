import { redirect } from "@remix-run/node";
import prisma from "../db.server";

const SHOPIFY_SHOP_DOMAIN = "b30ize-1a.myshopify.com";

export const action = async ({ request }) => {
  const formData = await request.formData();
  const returnTo = String(formData.get("returnTo") || "/admin/products");

  const offlineSessionId = `offline_${SHOPIFY_SHOP_DOMAIN}`;

  try {
    await prisma.session.delete({
      where: { id: offlineSessionId },
    });
  } catch (error) {
    console.log("offline session delete skipped:", error);
  }

  throw redirect(`/auth?shop=${SHOPIFY_SHOP_DOMAIN}&returnTo=${encodeURIComponent(returnTo)}`);
};

export const loader = async () => {
  throw redirect(`/auth?shop=${SHOPIFY_SHOP_DOMAIN}`);
};