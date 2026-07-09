import '@shopify/ui-extensions/preact';
import {render} from "preact";
import {
  useCartLines,
  useOrder,
  useShop,
} from "@shopify/ui-extensions/customer-account/preact";

export default async () => {
  render(<Extension />, document.body)
}

function Extension() {
  const order = useOrder();
  const lines = useCartLines();
  const shop = useShop();

  if (!order) {
    return null;
  }

  const isCancelled = Boolean(order.cancelledAt);
  const hasNoVisibleLines = lines.length === 0;

  if (!isCancelled && !hasNoVisibleLines) {
    return null;
  }

  const contactUrl = buildStorefrontUrl(shop, "/pages/contact");
  const withdrawalUrl = buildStorefrontUrl(
    shop,
    buildWithdrawalPagePath(order.name),
  );
  const bodyText = isCancelled
    ? "キャンセル済みのご注文では、商品情報や金額の表示が簡略化される場合があります。ご不明点がございましたらお問い合わせください。"
    : "ご注文内容の表示が簡略化される場合があります。ご不明点がございましたらお問い合わせください。";

  return (
    <s-section heading="ご注文内容の確認について">
      <s-stack gap="base">
        <s-text>{bodyText}</s-text>
        <s-text color="subdued" type="small">
          EUのお客様は、対象となる注文について撤回申請フォームから申請できます。
        </s-text>
        {order.name && (
          <s-text color="subdued" type="small">
            お問い合わせの際は、注文番号（{order.name}）をお知らせください。
          </s-text>
        )}
      </s-stack>

      <s-button slot="primary-action" variant="secondary" href={contactUrl}>
        お問い合わせ
      </s-button>
      <s-button slot="secondary-action" variant="secondary" href={withdrawalUrl}>
        撤回申請
      </s-button>
    </s-section>
  );
}

function buildWithdrawalPagePath(orderName) {
  if (!orderName) {
    return "/pages/withdrawal-form";
  }

  const params = new URLSearchParams({ orderNumber: orderName });
  return `/pages/withdrawal-form?${params.toString()}`;
}

function buildStorefrontUrl(shop, path) {
  const baseUrl = shop.storefrontUrl || `https://${shop.myshopifyDomain}`;

  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}${path}`;
  }
}
