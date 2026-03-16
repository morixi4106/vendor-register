import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const email = String(formData.get("email") || "");
  const phone = String(formData.get("phone") || "");
  const ownerName = String(formData.get("owner_name") || "");
  const storeName = String(formData.get("store_name") || "");
  const address = String(formData.get("address") || "");
  const country = String(formData.get("country") || "");
  const category = String(formData.get("category") || "");
  const website = String(formData.get("website") || "");
  const note = String(formData.get("note") || "");
  const ageCheck = String(formData.get("age_check") || "");

  const response = await admin.graphql(
    `#graphql
    mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          tags
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          email,
          phone,
          tags: ["vendor"],
          metafields: [
            {
              namespace: "vendor",
              key: "owner_name",
              type: "single_line_text_field",
              value: ownerName,
            },
            {
              namespace: "vendor",
              key: "store_name",
              type: "single_line_text_field",
              value: storeName,
            },
            {
              namespace: "vendor",
              key: "address",
              type: "single_line_text_field",
              value: address,
            },
            {
              namespace: "vendor",
              key: "country",
              type: "single_line_text_field",
              value: country,
            },
            {
              namespace: "vendor",
              key: "category",
              type: "single_line_text_field",
              value: category,
            },
            {
              namespace: "vendor",
              key: "website",
              type: "single_line_text_field",
              value: website,
            },
            {
              namespace: "vendor",
              key: "note",
              type: "multi_line_text_field",
              value: note,
            },
            {
              namespace: "vendor",
              key: "age_check",
              type: "single_line_text_field",
              value: ageCheck,
            },
          ],
        },
      },
    },
  );

  const result = await response.json();

  const userErrors = result?.data?.customerCreate?.userErrors || [];

  if (userErrors.length > 0) {
    return json(
      {
        ok: false,
        errors: userErrors,
      },
      { status: 400 }
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/pages/%E5%BA%97%E8%88%97%E5%90%91%E3%81%91%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84",
    },
  });
};