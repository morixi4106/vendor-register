import { redirect } from "@remix-run/node";
import { Outlet } from "@remix-run/react";

export const loader = async ({ request }) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/vendor" || pathname === "/vendor/") {
    throw redirect("/vendor/dashboard");
  }

  return null;
};

export default function VendorIndexRedirect() {
  return <Outlet />;
}
