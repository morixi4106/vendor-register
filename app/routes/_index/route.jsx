import { redirect } from "@remix-run/node";

const PUBLIC_STOREFRONT_URL = "https://oja-immanuel-bacchus.com/";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  throw redirect(PUBLIC_STOREFRONT_URL, {
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};

export default function App() {
  return null;
}
