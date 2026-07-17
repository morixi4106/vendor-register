export function buildContactAcknowledgement({ name } = {}) {
  const recipientName = String(name || "お客様").trim() || "お客様";
  return [
    `${recipientName} 様`,
    "",
    "お問い合わせを受け付けました。",
    "内容を担当者が確認し、必要に応じて改めてご案内いたします。",
    "このメールは受付確認のため、返品・返金その他の対応を確約するものではありません。",
    "",
    "Oja Immanuel Bacchus サポート",
  ].join("\n");
}

export function buildAdminContactNotification({
  name,
  email,
  phone,
  message,
  replyText,
} = {}) {
  return [
    "返信種別: 受付確認（自動回答なし）",
    `名前: ${name}`,
    `メール: ${email}`,
    `電話番号: ${phone || "未入力"}`,
    "",
    "お問い合わせ内容:",
    message,
    "",
    "購入者への受付確認:",
    replyText,
  ].join("\n");
}
