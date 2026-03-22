import prisma from "../db.server";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const loader = async ({ params }) => {
  const id = String(params.id || "");

  if (!id) {
    return new Response("店舗IDがありません。", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const store = await prisma.vendorStore.findUnique({
    where: { id },
  });

  if (!store) {
    return new Response(
      `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>店舗が見つかりません</title>
  <style>
    body{
      margin:0;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:#fff;
      color:#111;
    }
    .wrap{
      max-width:1100px;
      margin:0 auto;
      padding:48px 24px 80px;
    }
    .title{
      margin:0 0 20px;
      font-size:42px;
      font-weight:800;
    }
    .text{
      font-size:18px;
      line-height:1.8;
      color:#555;
    }
    .back{
      display:inline-block;
      margin-top:24px;
      color:#111;
      text-decoration:none;
      font-weight:700;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">店舗が見つかりません</h1>
    <div class="text">指定された店舗情報は存在しないか、削除されています。</div>
    <a class="back" href="/pages/%E5%BA%97%E8%88%97%E4%B8%80%E8%A6%A7">← 店舗一覧へ戻る</a>
  </div>
</body>
</html>`,
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const storeName = escapeHtml(store.storeName);
  const ownerName = escapeHtml(store.ownerName);
  const email = escapeHtml(store.email);
  const phone = escapeHtml(store.phone);
  const address = escapeHtml(store.address);
  const country = escapeHtml(store.country);
  const category = escapeHtml(store.category);
  const note = escapeHtml(store.note || "");
  const ageCheck = escapeHtml(store.ageCheck);
  const createdAt = new Date(store.createdAt).toLocaleString("ja-JP");

  return new Response(
    `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${storeName} | 店舗詳細</title>
  <style>
    *{
      box-sizing:border-box;
    }
    body{
      margin:0;
      background:#fff;
      color:#111;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    .page{
      padding:40px 0 80px;
    }
    .inner{
      max-width:1280px;
      margin:0 auto;
      padding:0 40px;
    }
    .back{
      display:inline-block;
      margin-bottom:24px;
      color:#666;
      text-decoration:none;
      font-size:15px;
    }
    .title{
      margin:0 0 32px;
      font-size:42px;
      line-height:1.15;
      font-weight:800;
      color:#111;
    }
    .card{
      border:1px solid #e5e5e5;
      border-radius:20px;
      background:#fff;
      padding:32px;
    }
    .grid{
      display:grid;
      grid-template-columns:220px 1fr;
      gap:18px 28px;
      align-items:start;
    }
    .label{
      font-size:16px;
      font-weight:700;
      color:#666;
    }
    .value{
      font-size:18px;
      line-height:1.8;
      color:#111;
      word-break:break-word;
    }
    .note{
      white-space:pre-wrap;
    }
    @media screen and (max-width:749px){
      .page{
        padding:24px 0 48px;
      }
      .inner{
        padding:0 16px;
      }
      .title{
        font-size:30px;
        margin-bottom:24px;
      }
      .card{
        padding:20px;
        border-radius:16px;
      }
      .grid{
        grid-template-columns:1fr;
        gap:8px 0;
      }
      .label{
        margin-top:10px;
      }
      .value{
        font-size:16px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="inner">
      <a class="back" href="/pages/%E5%BA%97%E8%88%97%E4%B8%80%E8%A6%A7">← 店舗一覧へ戻る</a>
      <h1 class="title">${storeName}</h1>

      <div class="card">
        <div class="grid">
          <div class="label">店舗名</div>
          <div class="value">${storeName}</div>

          <div class="label">氏名 / 法人名</div>
          <div class="value">${ownerName}</div>

          <div class="label">カテゴリ</div>
          <div class="value">${category}</div>

          <div class="label">国</div>
          <div class="value">${country}</div>

          <div class="label">所在地</div>
          <div class="value">${address}</div>

          <div class="label">電話番号</div>
          <div class="value">${phone}</div>

          <div class="label">メール</div>
          <div class="value">${email}</div>

          <div class="label">年齢確認</div>
          <div class="value">${ageCheck}</div>

          <div class="label">備考</div>
          <div class="value note">${note || "なし"}</div>

          <div class="label">登録日時</div>
          <div class="value">${createdAt}</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
};