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

実行フラグと公開情報はRepository Variablesへ置きます。ジョブレベルの
`if`で使う`SALE_ELIGIBILITY_WATCHDOG_ENABLED`はEnvironment Variableでは
参照できません。

```text
SALE_ELIGIBILITY_WATCHDOG_ENABLED=false
SHOPIFY_WATCHDOG_SHOP_DOMAIN=<production-shop.myshopify.com>
LAUNCH_MONITOR_URL=https://vendor-register-pbjl.onrender.com
```

秘密値は、承認待ちのないGitHub `watchdog` Environmentへ置きます。

```text
SALE_ELIGIBILITY_WATCHDOG_TOKEN=<Renderにも設定する32文字以上の専用秘密値>
SHOPIFY_WATCHDOG_CLIENT_ID=<独立WatchdogアプリのClient ID>
SHOPIFY_WATCHDOG_CLIENT_SECRET=<独立WatchdogアプリのClient secret>
```

`watchdog` Environmentは`main`ブランチだけに制限します。定期実行を
止めるRequired reviewersは設定しません。認証情報と権限の検証が終わる
まで、Repository Variableの
`SALE_ELIGIBILITY_WATCHDOG_ENABLED`を`true`にしません。

Watchdogアプリの権限は
`read_products,read_publications,write_publications` のみに制限します。
メインアプリのトークンを流用しません。停止後の再公開は自動化せず、原因と
証跡を別担当者が確認してから手動で復旧します。

### Render Dead Man's Switch

Render Cronは10分ごとにGitHub Actionsの最終成功時刻を確認します。
15分以上更新されない場合は、監視停止として通知します。これにより
GitHub Actions側とRender側の片方が停止しても検知できます。

## 通知

`LAUNCH_MONITOR_NOTIFICATION_MODE`をWeb、Render Cron、GitHub Repository
Variablesで揃えます。未設定時は`prelaunch`、不正値は`paused`として
自動送信しません。公開状態から自動で`live`へ切り替えることはありません。

- `prelaunch`: 公開前の監視結果は保存しますが、自動メールとGitHub予備通知は送りません。
- `paused`: 自動通知を停止します。監視の判定自体を正常にはしません。
- `live`: 公開運用を明示承認した後だけ設定します。新しい異常は即時通知し、同じ異常は原則24時間以内に再通知しません。
- 異常が一度消えて再発しても、直近32件・7日間の通知履歴で同じ異常の連続送信を抑えます。
- 本人が異常を確認した後は、確認日時から7日間は同じ異常を再通知しません。
- 復旧メールも24時間以内の繰り返しを抑えます。予備メールは同じ日・同じ内容を重複送信しません。
- 管理画面の「通知テストを送信」は公開前でも明示操作で1通だけ送信できます。

公開前のパスワード保護と既知の未確認事項だけなら、Cronは検査完了として
終了します。ただし監視結果の`critical`、`password_page`、公開NGは残し、
購入可能・本番正常の証拠にはしません。DB異常、5xx、未知のWarningなどは
この扱いに含めません。GitHub監視の古さも公開前は記録のみとし、実行自体の
HTTPエラーとは区別します。

ストアが一般公開されているのに通知モードが`live`でない場合は、
`public_store_notifications_not_live`をCriticalとして記録します。

状態、通知抑制、復旧、実行ロックは既存の`OperationalHeartbeat`へ
永続化します。業務データは変更しません。

## Render環境変数

```text
LAUNCH_MONITOR_ENABLED=true
LAUNCH_MONITOR_NOTIFICATION_MODE=prelaunch
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

Repository Secrets:

```text
LAUNCH_MONITOR_TOKEN
RENDER_API_KEY
RESEND_API_KEY
MAIL_FROM
ADMIN_EMAIL
```

`watchdog` Environment Secrets:

```text
SALE_ELIGIBILITY_WATCHDOG_TOKEN
SHOPIFY_WATCHDOG_CLIENT_ID
SHOPIFY_WATCHDOG_CLIENT_SECRET
```

Repository Variables:

```text
PRODUCTION_INTEGRITY_MONITOR_ENABLED=false
LAUNCH_MONITOR_URL=https://vendor-register-pbjl.onrender.com
RENDER_OWNER_ID=<Render workspace ID>
RENDER_SERVICE_ID=<Render Web service ID>
LAUNCH_MONITOR_EXPECTED_ROOT_LOCATION=https://oja-immanuel-bacchus.com/
LAUNCH_MONITOR_STOREFRONT_URL=https://oja-immanuel-bacchus.com/
LAUNCH_MONITOR_STOREFRONT_MARKER=Oja Immanuel Bacchus
SHOPIFY_WATCHDOG_SHOP_DOMAIN=<production-shop.myshopify.com>
SALE_ELIGIBILITY_WATCHDOG_ENABLED=false
```

`Production integrity monitor`の手動実行は`dry_run=true`が既定です。この
モードは公開URLとRenderログだけを読み、内部監視API、DB、通知を使用
しないため、公開可否のGREEN証拠にはなりません。

パスワード保護中に監視の全経路を確認するときは、手動実行で
`dry_run=false`、`expect_password_critical=true`を選びます。内部API、DB、
Heartbeat、実行ロック、通知まで実行し、非正常項目が
`official_storefront/password_page`の1件だけで、初回Critical通知が送信
された場合に限ってWorkflowを成功させます。この証拠も一般公開GREEN
ではなく、公開前配線確認です。パスワード解除後は
`expect_password_critical=false`でfull runを実行し、`healthy`または
`recovered`を確認します。

定期本実行はRepository Variable
`PRODUCTION_INTEGRITY_MONITOR_ENABLED=true`の場合だけ動きます。手動・定期の
どちらも`main`ブランチからだけ監視用Secretへアクセスできます。

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
