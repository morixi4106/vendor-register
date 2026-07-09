import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useShop} from '@shopify/ui-extensions/customer-account/preact';

export default async () => {
  render(<BlockExtension />, document.body);
};

function BlockExtension() {
  const shop = useShop();
  const withdrawalUrl = buildStorefrontUrl(shop, '/pages/withdrawal-form');

  return (
    <s-section>
      <s-stack direction="inline" justifyContent="space-between" alignItems="center">
        <s-stack direction="block" gap="small-400">
          <s-heading>マイページ</s-heading>
          <s-text>注文確認や登録情報の確認はこちら</s-text>
          <s-text color="subdued" type="small">
            EUのお客様向けの撤回申請フォームもこちらから確認できます。
          </s-text>
        </s-stack>

        <s-stack direction="inline" gap="small-300">
          <s-button variant="primary" href="extension:account-home-page/">
            開く
          </s-button>
          <s-button variant="secondary" href={withdrawalUrl}>
            撤回申請
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function buildStorefrontUrl(shop, path) {
  const baseUrl = shop.storefrontUrl || `https://${shop.myshopifyDomain}`;

  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/$/, '')}${path}`;
  }
}
