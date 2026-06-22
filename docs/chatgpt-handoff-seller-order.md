# ChatGPT引き継ぎメモ: SellerOrder / 複数出店者注文対応

最終更新: 2026-06-22

このメモは、ChatGPTなど別のAIに現在の実装状況を共有するための引き継ぎです。GitHub repo 全体を読める前提で、このファイルを入口にしてください。

## 目的

Shopify上では注文を1件のまま扱い、アプリ内では出店者ごとの注文に分解できるようにする。

将来的には、購入者が複数出店者の商品を同時にチェックアウトできる状態を目指す。ただし、いきなり本番導線を切り替えるのではなく、まず既存の売上台帳と新しい SellerOrder 計算結果が一致するかを裏側で検証している。

## 現在の方針

- Shopify Order は引き続き source of truth。
- 既存の seller ledger / payout / refund / shipping flow は基本維持。
- 新しい `MarketplaceOrder` / `SellerOrder` / `SellerOrderLine` はまず shadow write として作る。
- shadow write は本番の注文処理を置き換えない。
- 既存台帳と SellerOrder 計算が一致するかを `/app/seller-order-shadow` で確認する。
- 複数出店者チェックアウトはまだ本番解放しない。

## 重要な現在地

Render の本番環境で以下を確認済み。

- `SELLER_ORDER_SHADOW_WRITE_ENABLED=true` を設定済み。
- `/app/seller-order-shadow` で検証データ補完を実行済み。
- 対象30日 / 100件で、対象は3件。
- 結果は `一致 3件`、`失敗 0件`。
- つまり、現時点で見える過去注文では、既存台帳と SellerOrder 計算が一致している。

## Render env の意味

### すでに入れているもの

`SELLER_ORDER_SHADOW_WRITE_ENABLED=true`

意味:

- `orders/paid` webhook の既存 ledger 処理はそのまま動く。
- その裏で SellerOrder 検証データを作る。
- 既存台帳と新計算の差分を `SellerOrderShadowCheck` に保存する。

これは本番処理の切り替えスイッチではない。

### 次に入れる候補

`VENDOR_ORDERS_USE_SELLER_ORDERS=true`

意味:

- 出店者の注文管理画面を SellerOrder 読み取りに寄せる。
- 既存 ledger 読みからの移行検証。
- 壊れた場合は `false` に戻して再デプロイすれば既存読みへ戻せる設計。

### まだ入れないもの

以下は複数出店者チェックアウト解放に近いフラグなので、まだ有効化しない。

```txt
MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED=true
MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED=true
MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED=true
MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED=true
MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED=true
SALES_CREDIT_MULTI_SELLER_ENABLED=true
```

特に `SALES_CREDIT_MULTI_SELLER_ENABLED` は最後まで原則OFFでよい。複数出店者カートで売上金充当を許すと返金・相殺・精算が複雑になるため。

## 関係する主要ファイル

### Prisma schema

`prisma/schema.prisma`

見るモデル:

- `MarketplaceOrder`
- `SellerOrder`
- `SellerOrderLine`
- `SellerShipment`
- `SellerShipmentLine`
- `SellerOrderShadowCheck`

重要:

- `SellerOrderShadowCheck.currencyCode` は存在する。
- `SellerOrder` は `marketplaceOrderId + sellerId` で unique。

### SellerOrder / ledger / webhook

`app/services/sellerPayments.server.js`

主に見る関数:

- `recordShopifyOrderSellerOrderShadow`
- `backfillSellerOrderShadowChecks`
- `updateSellerOrderShadowForRefund`
- `updateSellerOrderShadowForCancellation`
- `updateSellerOrderShadowRiskStatus`
- `processShopifyOrderPaidSettlement`
- `processShopifyRefundSettlement`

重要:

- Shopify line item の seller 解決は variant 優先の土台が入っている。
- duplicate paid webhook でも shadow write retry できるようにしてある。
- 商品解決は `shopifyVariantId` → `shopifyProductId` を優先する設計。

### SellerOrder検証画面

`app/routes/app.seller-order-shadow.jsx`

URL:

`/app/seller-order-shadow`

用途:

- 既存売上台帳と SellerOrder 計算結果の比較を見る。
- 過去 ledger から検証データを補完する。
- 小さく `days=7 / limit=10` から実行し、問題なければ `days=30 / limit=100` に広げる。

### Backfill route

`app/routes/internal.seller-order-shadow.backfill.jsx`

用途:

- 管理者認証後、過去 ledger から SellerOrder shadow check を作る。
- `confirm=backfill` ガードあり。
- `retryFailed=true` で失敗分の再試行ができる。

### 出店者注文管理

`app/services/vendorManagement.server.js`

主に見る関数:

- `getVendorOrdersPageData`
- SellerOrder read path
- legacy ledger fallback path

重要:

- `VENDOR_ORDERS_USE_SELLER_ORDERS=true` で SellerOrder 読み取りを使う。
- SellerOrder 読み取りが失敗した場合、legacy ledger 読みへ fallback する設計。
- 返金済み SellerOrder は発送登録できないようにするテストがある。

### Readiness

`app/services/productionReadiness.server.js`

見る内容:

- SellerOrder shadow write readiness
- SellerOrder read readiness
- multi-seller checkout readiness

## 最近通したテスト

以下は直近で通過済み。

```txt
node --test tests\services\vendorManagement.server.test.js
node --test tests\services\sellerPayments.server.test.js
node --test tests\services\productionReadiness.server.test.js tests\routes\api.draft-order.checkout.test.js
```

期待されるログ:

- `vendor inventory sync error: ACCESS_DENIED: write_inventory`
- `vendor seller orders list error: SELLER_ORDER_TABLE_UNAVAILABLE`
- `vendor orders list error: Offline session not found...`
- `public vendor checkout api error: Error: draftOrderCreate failed`

これらはテスト上の想定ログであり、直近では失敗扱いではない。

## 次にやること

### 1. SellerOrder検証の確認

`/app/seller-order-shadow` で以下を確認する。

- `一致` が維持されている。
- `失敗` が増えていない。
- `金額差分` がない。
- `既存台帳` と `新計算` の金額・通貨が一致している。

現時点では `一致 3` / `失敗 0`。

### 2. SellerOrder読み取りを出店者注文画面で試す

Render env に以下を追加。

```txt
VENDOR_ORDERS_USE_SELLER_ORDERS=true
```

その後、Render で `Manual Deploy` → `Deploy latest commit`。

確認URL:

```txt
https://vendor-register-pbjl.onrender.com/vendor/orders
```

見るポイント:

- ページが500にならない。
- 注文一覧が表示される。
- 最近の注文が見える。
- 金額が既存表示とズレていない。
- 返金済み注文は発送登録できない。
- 発送済み注文は追跡番号が表示される。
- 未発送・支払い済み注文だけ発送登録できる。

問題が出たら:

```txt
VENDOR_ORDERS_USE_SELLER_ORDERS=false
```

に戻して再デプロイする。

### 3. 問題なければ次フェーズへ

次フェーズ候補:

- SellerOrder読み取りで出店者注文管理が安定しているか追加確認。
- refund / cancel / dispute の SellerOrder 側更新が本番注文でズレないか見る。
- multi-seller checkout はまだOFFのまま、backend処理だけの検証を続ける。

## まだやらないこと

- 複数出店者チェックアウトを本番解放しない。
- 複数出店者カートで売上金充当を有効化しない。
- 既存 seller ledger / payout を SellerOrder 主導に完全置換しない。
- raw Shopify payload を雑にDB保存しない。
- 配送先住所などPIIを安易に SellerOrder に追加しない。

## 設計メモ

SellerOrder は「出店者ごとの注文・精算境界」として扱う。

SellerShipment は「実際の発送登録単位」として SellerOrder から分ける。

理由:

- Shopify FulfillmentOrder は Shopify が location / routing に基づいて自動作成するもので、seller単位とは限らない。
- アプリ側で SellerOrder と Shopify FulfillmentOrder を1対1扱いしない。
- 発送時は `SellerShipmentLine` に `shopifyFulfillmentOrderId` / `shopifyFulfillmentOrderLineItemId` を持ち、対象sellerの商品行だけ fulfill する。

## ChatGPTへの依頼例

この repo と `docs/chatgpt-handoff-seller-order.md` を読んで、現在の SellerOrder shadow migration の状態を把握してください。

特に確認してほしいこと:

- 今の実装が既存本番導線を壊さない形になっているか。
- `VENDOR_ORDERS_USE_SELLER_ORDERS=true` に進む前に危険な点が残っていないか。
- 複数出店者チェックアウト解放前に追加すべき安全確認があるか。
- PII保存や raw payload 保存のリスクが増えていないか。
