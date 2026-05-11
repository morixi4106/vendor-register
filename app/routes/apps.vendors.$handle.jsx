function hiddenVendorStorefrontResponse() {
  throw new Response('Not Found', {
    status: 404,
  });
}

export const loader = hiddenVendorStorefrontResponse;
export const action = hiddenVendorStorefrontResponse;

export default function HiddenVendorStorefrontPage() {
  return null;
}
