import { redirect } from "@remix-run/node";
import prisma from "../db.server";
import { resolveShopDomain } from "../utils/shopifyAdmin.server";

async function deleteOfflineSession(shopDomain) {
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
}

function buildAuthLoginRedirect(shopDomain, returnTo) {
  const params = new URLSearchParams({ shop: shopDomain });

  if (returnTo) {
    params.set("returnTo", returnTo);
  }

  return `/auth/login?${params.toString()}`;
}

export const action = async ({ request }) => {
  const formData = await request.formData();
  const returnTo = String(formData.get("returnTo") || "/admin/products");
  const shopDomain = await resolveShopDomain(formData.get("shopDomain"));

  await deleteOfflineSession(shopDomain);

  throw redirect(buildAuthLoginRedirect(shopDomain, returnTo));
};

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shopDomain = await resolveShopDomain(
    url.searchParams.get("shopDomain") || url.searchParams.get("shop")
  );
  const returnTo = url.searchParams.get("returnTo") || "";

  await deleteOfflineSession(shopDomain);

  throw redirect(buildAuthLoginRedirect(shopDomain, returnTo));
};
