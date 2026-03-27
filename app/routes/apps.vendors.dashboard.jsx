import { redirect, createCookie } from "@remix-run/node";
import prisma from "../db.server";

const vendorAdminCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export const loader = async ({ request }) => {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("/apps/vendors/verify");
  }

  const session = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: { vendor: true },
  });

  if (!session || session.expiresAt <= new Date()) {
    throw redirect("/apps/vendors/verify", {
      headers: {
        "Set-Cookie": await vendorAdminCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  throw redirect(`https://vendor-register-pbjl.onrender.com/app/vendor-dashboard?vendor=${session.vendorId}`);
};

export default function AppsVendorsDashboardEntry() {
  return null;
}