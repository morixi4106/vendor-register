import { redirect } from "@remix-run/node";

import { getAppBaseUrl } from "../utils/appUrl.server.js";

export const loader = async ({ request }) => {
  throw redirect(`${getAppBaseUrl(request)}/vendor/dashboard`, 302);
};

export default function LegacyVendorDashboardRedirect() {
  return null;
}
