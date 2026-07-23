# 本番整合性監視

公開後72時間は集中監視し、その後もGitHub ActionsとRender Cronを
組み合わせて継続監視します。監視処理は読み取り専用です。注文、台帳、
返金、商品、出金を自動修復しません。

## 構成

### GitHub Actions

`.github/workflows/launch-monitor.yml` はRenderとは別の実行環境から次を
確認します。

- Renderの5xx、401/403、429、アプリエラーログ
- Renderルートが正式ストアへ転送されること
- 正式ストアが200を返し、パスワード画面ではないこと
- DB、撤回メール、問い合わせ、SellerOrder、台帳、テスト出金
- 商品同期と全販売チャネルの公開境界
- 販売制御の鮮度が失われた場合の緊急停止

軽い検査は5分ごと、台帳などの重い検査は15分ごとです。重い検査を
省略した回は直前の結果を維持するため、見かけだけの復旧にはしません。

### 独立販売停止Watchdog

販売制御が古い、Renderが停止、DBへ接続できない、または内部停止APIが
失敗した場合は、別のShopifyカスタムアプリから直接、すべての商品を
全Publicationから非公開化します。最後に公開残存が0件であることを
再取得して確認します。

必要なGitHub `production` 環境の値:

```text
SALE_ELIGIBILITY_WATCHDOG_TOKEN=<Renderにも設定する32文字以上の専用秘密値>
SHOPIFY_WATCHDOG_SHOP_DOMAIN=<production-shop.myshopify.com>
SHOPIFY_WATCHDOG_CLIENT_ID=<独立WatchdogアプリのClient ID>
SHOPIFY_WATCHDOG_CLIENT_SECRET=<独立WatchdogアプリのClient secret>
```

Watchdogアプリの権限は
`read_products,read_publications,write_publications` のみに制限します。
メインアプリのトークンを流用しません。停止後の再公開は自動化せず、原因と
証跡を別担当者が確認してから手動で復旧します。

### Render Dead Man's Switch

Render Cronは10分ごとにGitHub Actionsの最終成功時刻を確認します。
15分以上更新されない場合は、監視停止として通知します。これにより
GitHub Actions側とRender側の片方が停止しても検知できます。

## 通知

- 重大異常: 初回即時、継続時は30分ごと
- 注意: 初回即時、継続時は2時間ごと
- 内容変更、重要度上昇、復旧: 即時
- 72時間集中監視の開始時と終了時: 通知

状態、通知抑制、復旧、実行ロックは既存の`OperationalHeartbeat`へ
永続化します。業務データは変更しません。

## Render環境変数

```text
LAUNCH_MONITOR_ENABLED=true
LAUNCH_MONITOR_TOKEN=<32文字以上の専用秘密値>
LAUNCH_MONITOR_DEADMAN_TOKEN=<別の32文字以上の専用秘密値>
LAUNCH_MONITOR_DURATION_HOURS=72
LAUNCH_MONITOR_STARTED_AT=<UTC ISO日時>
SALE_ELIGIBILITY_WATCHDOG_TOKEN=<さらに別の32文字以上の専用秘密値>
```

任意:

```text
LAUNCH_MONITOR_ALERT_EMAIL=<未設定時はADMIN_EMAIL>
LAUNCH_MONITOR_FROM_EMAIL=<未設定時はMAIL_FROM>
```

`LAUNCH_MONITOR_STARTED_AT` は公開直後の時刻へ更新します。72時間後も
監視そのものは止めず、集中監視期間だけを終了します。

## GitHub Actions

Secrets:

```text
LAUNCH_MONITOR_TOKEN
SALE_ELIGIBILITY_WATCHDOG_TOKEN
SHOPIFY_WATCHDOG_CLIENT_ID
SHOPIFY_WATCHDOG_CLIENT_SECRET
RENDER_API_KEY
RESEND_API_KEY
MAIL_FROM
ADMIN_EMAIL
```

Variables:

```text
LAUNCH_MONITOR_URL=https://vendor-register-pbjl.onrender.com
RENDER_OWNER_ID=<Render workspace ID>
RENDER_SERVICE_ID=<Render Web service ID>
LAUNCH_MONITOR_EXPECTED_ROOT_LOCATION=https://oja-immanuel-bacchus.com/
LAUNCH_MONITOR_STOREFRONT_URL=https://oja-immanuel-bacchus.com/
LAUNCH_MONITOR_STOREFRONT_MARKER=Oja Immanuel Bacchus
SHOPIFY_WATCHDOG_SHOP_DOMAIN=<production-shop.myshopify.com>
```

## Render Cron

10分ごとの別Cron Job:

```text
Build: npm ci
Start: node scripts/launch-monitor-deadman.mjs
Schedule: */10 * * * *
```

必要な環境変数:

```text
LAUNCH_MONITOR_URL
LAUNCH_MONITOR_DEADMAN_TOKEN
RESEND_API_KEY
MAIL_FROM
ADMIN_EMAIL
```

## 安全性

- 内部APIはPOST専用、専用Bearer Token、定数時間比較、`no-store`
- 外部レスポンスには個人情報、生エラー、内部ID、秘密値を含めない
- 監視対象URLとDB条件はサーバー側で固定
- Agentはコマンド実行、`eval`、動的スクリプト実行を行わない
- GitHub Actionsの`concurrency`とDBロックで同時実行を抑止
- ロック所有者を記録し、別実行が有効なロックを解除しない

`node scripts/launch-monitor-agent.mjs --dry-run` は公開URLとRenderログだけを
確認し、内部DB監視、書き込み、通知を行いません。

## 公開前訓練

1. 通常状態で監視が`healthy`になることを確認する。
2. テスト用の疑似障害で初回通知と通知抑制を確認する。
3. 障害を解消し、復旧通知を確認する。
4. RenderとDBへ到達できない状態を作る。
5. 独立Watchdogが全商品を非公開化し、公開残存0件を確認する。
6. 別担当者が証跡を確認し、意図した商品だけを復旧する。
7. 証跡を`INDEPENDENT_SALES_STOP_DRILL_COMPLETED`として登録する。
