import { json } from "@remix-run/node";

const SHOP = process.env.SHOPIFY_SHOP || "oja-immanuel-bacchus.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

async function shopify(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  return res.json();
}

export const action = async ({ request }) => {
  const formData = await request.formData();

  const email = String(formData.get("email") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const ownerName = String(formData.get("owner_name") || "").trim();
  const storeName = String(formData.get("store_name") || "").trim();
  const address = String(formData.get("address") || "").trim();
  const country = String(formData.get("country") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const website = String(formData.get("website") || "").trim();
  const note = String(formData.get("note") || "").trim();
  const ageCheck = String(formData.get("age_check") || "").trim();

  if (!TOKEN) {
    return json(
      {
        ok: false,
        errors: [{ message: "SHOPIFY_ADMIN_ACCESS_TOKEN が未設定です。" }],
      },
      { status: 500 }
    );
  }

  const result = await shopify(
    `mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
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
    }
  );
  const topErrors = result?.errors || [];
  if (topErrors.length > 0) {
    console.error("Shopify GraphQL errors:", JSON.stringify(topErrors, null, 2));
    return json(
      {
        ok: false,
        errors: topErrors,
      },
      { status: 400 }
    );
  }

  const errors = result?.data?.customerCreate?.userErrors || [];
  if (errors.length > 0) {
    console.error("customerCreate userErrors:", JSON.stringify(errors, null, 2));
    return json(
      {
        ok: false,
        errors,
      },
      { status: 400 }
    );
  }

  const customer = result?.data?.customerCreate?.customer;
  if (!customer) {
    console.error("customerCreate returned no customer:", JSON.stringify(result, null, 2));
    return json(
      {
        ok: false,
        errors: [{ message: "customerCreate succeeded neither with customer nor userErrors." }],
      },
      { status: 400 }
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location:
        "https://oja-immanuel-bacchus.myshopify.com/pages/%E5%BA%97%E8%88%97%E5%90%91%E3%81%91%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84",
    },
  });
};