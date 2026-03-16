import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

function slugify(text) {
  return String(text || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, "-")
    .replace(/[^a-z0-9-ぁ-んァ-ヶ一-龠ー]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function graphqlJson(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
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

  const storeHandleBase = slugify(storeName || ownerName || email.split("@")[0]);
  const storeHandle = storeHandleBase || `store-${Date.now()}`;

  const customerResult = await graphqlJson(
    admin,
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
          {
            namespace: "vendor",
            key: "store_handle",
            type: "single_line_text_field",
            value: storeHandle,
          },
        ],
      },
    }
  );

  const customerErrors = customerResult?.data?.customerCreate?.userErrors || [];
  const customer = customerResult?.data?.customerCreate?.customer;

  if (customerErrors.length > 0 || !customer?.id) {
    return json(
      {
        ok: false,
        step: "customerCreate",
        errors: customerErrors,
      },
      { status: 400 }
    );
  }

  const metaobjectResult = await graphqlJson(
    admin,
    `#graphql
    mutation metaobjectCreate($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject {
          id
          handle
          type
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      metaobject: {
        type: "stores",
        handle: storeHandle,
        fields: [
          {
            key: "store_name",
            value: storeName,
          },
          {
            key: "store_description",
            value: note || `${storeName} の店舗ページです。`,
          },
          {
            key: "location",
            value: [address, country].filter(Boolean).join(" / "),
          },
        ],
      },
    }
  );

  const metaobjectErrors =
    metaobjectResult?.data?.metaobjectCreate?.userErrors || [];
  const metaobject = metaobjectResult?.data?.metaobjectCreate?.metaobject;

  if (metaobjectErrors.length > 0 || !metaobject?.id) {
    return json(
      {
        ok: false,
        step: "metaobjectCreate",
        errors: metaobjectErrors,
      },
      { status: 400 }
    );
  }

  const pageBody = `
<p>${storeName} の店舗ページです。</p>
${ownerName ? `<p>運営者: ${ownerName}</p>` : ""}
${category ? `<p>カテゴリ: ${category}</p>` : ""}
${website ? `<p>Web / SNS: <a href="${website}">${website}</a></p>` : ""}
${note ? `<p>${note}</p>` : ""}
  `.trim();

  const pageResult = await graphqlJson(
    admin,
    `#graphql
    mutation pageCreate($page: PageCreateInput!) {
      pageCreate(page: $page) {
        page {
          id
          title
          handle
          onlineStoreUrl
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      page: {
        title: storeName,
        handle: storeHandle,
        body: pageBody,
        templateSuffix: "store",
        isPublished: true,
      },
    }
  );

  const pageErrors = pageResult?.data?.pageCreate?.userErrors || [];
  const page = pageResult?.data?.pageCreate?.page;

  if (pageErrors.length > 0 || !page?.id) {
    return json(
      {
        ok: false,
        step: "pageCreate",
        errors: pageErrors,
      },
      { status: 400 }
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location:
        "/pages/%E5%BA%97%E8%88%97%E5%90%91%E3%81%91%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84",
    },
  });
};