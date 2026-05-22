import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default async () => {
  render(<BlockExtension />, document.body);
};

function BlockExtension() {
  return (
    <s-section>
      <s-stack direction="inline" justifyContent="space-between" alignItems="center">
        <s-stack direction="block" gap="small-400">
          <s-heading>マイページ</s-heading>
          <s-text>注文確認や登録情報の確認はこちら</s-text>
        </s-stack>

        <s-button variant="primary" href="extension:account-home-page/">
          開く
        </s-button>
      </s-stack>
    </s-section>
  );
}