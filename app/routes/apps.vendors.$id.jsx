import prisma from "../db.server";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }
  }
  return "";
}

function liquidResponse(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: {
      "Content-Type": "application/liquid; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async ({ params }) => {
  const id = String(params.id || "");

  if (!id) {
    return liquidResponse(`
      <section class="page-width" style="padding: 40px 20px 80px;">
        <h1 style="margin: 0 0 16px; font-size: 32px;">店舗詳細</h1>
        <p style="margin: 0;">店舗IDがありません。</p>
      </section>
    `, 400);
  }

  const store = await prisma.vendorStore.findUnique({
    where: { id },
  });

  if (!store) {
    return liquidResponse(`
      <section class="page-width" style="padding: 40px 20px 80px;">
        <h1 style="margin: 0 0 16px; font-size: 32px;">店舗詳細</h1>
        <p style="margin: 0;">店舗が見つかりません。</p>
      </section>
    `, 404);
  }

  const storeName = escapeHtml(
    pickFirst(store.storeName, store.store_name, store.name)
  );
  const ownerName = escapeHtml(
    pickFirst(store.ownerName, store.owner_name)
  );
  const email = escapeHtml(
    pickFirst(store.email)
  );
  const phone = escapeHtml(
    pickFirst(store.phone)
  );
  const address = escapeHtml(
    pickFirst(store.address)
  );
  const country = escapeHtml(
    pickFirst(store.country)
  );
  const category = escapeHtml(
    pickFirst(store.category)
  );
  const website = escapeHtml(
    pickFirst(store.website, store.webSite, store.url)
  );
  const note = escapeHtml(
    pickFirst(store.note, store.description)
  );

  const websiteBlock = website
    ? `
      <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
        <dt style="font-weight: 700; margin-bottom: 8px;">Web / SNS</dt>
        <dd style="margin: 0;">
          <a href="${website}" target="_blank" rel="noopener noreferrer">${website}</a>
        </dd>
      </div>
    `
    : "";

  const noteBlock = note
    ? `
      <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
        <dt style="font-weight: 700; margin-bottom: 8px;">備考</dt>
        <dd style="margin: 0; white-space: pre-wrap;">${note}</dd>
      </div>
    `
    : "";

  return liquidResponse(`
    <section class="page-width" style="padding: 40px 20px 80px;">
      <div style="max-width: 960px; margin: 0 auto;">
        <h1 style="margin: 0 0 28px; font-size: 36px; line-height: 1.3;">
          ${storeName || "店舗詳細"}
        </h1>

        <div style="background: #fff; border: 1px solid #e5e5e5; border-radius: 16px; padding: 28px;">
          <dl style="margin: 0;">
            <div style="padding: 0 0 18px;">
              <dt style="font-weight: 700; margin-bottom: 8px;">店舗名</dt>
              <dd style="margin: 0;">${storeName || "-"}</dd>
            </div>

            <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
              <dt style="font-weight: 700; margin-bottom: 8px;">代表者名</dt>
              <dd style="margin: 0;">${ownerName || "-"}</dd>
            </div>

            <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
              <dt style="font-weight: 700; margin-bottom: 8px;">メールアドレス</dt>
              <dd style="margin: 0;">${email || "-"}</dd>
            </div>

            <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
              <dt style="font-weight: 700; margin-bottom: 8px;">電話番号</dt>
              <dd style="margin: 0;">${phone || "-"}</dd>
            </div>

            <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
              <dt style="font-weight: 700; margin-bottom: 8px;">住所</dt>
              <dd style="margin: 0;">${address || "-"}</dd>
            </div>

            <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
              <dt style="font-weight: 700; margin-bottom: 8px;">国</dt>
              <dd style="margin: 0;">${country || "-"}</dd>
            </div>

            <div style="padding: 18px 0; border-top: 1px solid #e5e5e5;">
              <dt style="font-weight: 700; margin-bottom: 8px;">カテゴリ</dt>
              <dd style="margin: 0;">${category || "-"}</dd>
            </div>

            ${websiteBlock}
            ${noteBlock}
          </dl>
        </div>
      </div>
    </section>
  `);
};