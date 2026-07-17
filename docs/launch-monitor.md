# 公開後72時間監視

公開直後の72時間だけ、GitHub ActionsとRender Cronを組み合わせて監視します。
監視は読み取り専用で、注文、台帳、返金、商品、出金を自動修復しません。

## 構成

### GitHub Actions（5分ごと）

`.github/workflows/launch-monitor.yml` がRenderとは別の実行環境から次を確認します。

- Renderの5xx、401/403、429、アプリエラーログ
- Renderアプリのルートが正式ストアへ転送されること
- 正式ストアが200を返し、`/password` ではなく、ブランド文字列を含むこと
- Webアプリ内のDB、撤回メール、問い合わせ、SellerOrder、台帳、テスト出金

軽い検査は5分ごと、台帳などの重い検査は15分ごとです。重い検査を省略した回は、
直前の結果を維持するため、見かけ上の復旧にはなりません。

### Render Dead Man's Switch（10分ごと）

GitHub Actionsの最終成功時刻だけを確認します。15分以上更新されない場合、
GitHub ActionsまたはWebアプリ停止として、Renderから直接メールします。

これにより、Renderが停止した場合はGitHub側、GitHub Actionsが停止した場合は
Render側から異常を検出できます。

## 通知

- 重大異常は初回即時、継続時は30分ごと
- 注意は初回即時、継続時は2時間ごと
- 内容変更、重要度上昇、復旧は即時
- 開始時と72時間完了時にも通知
- Dead Man's Switchの同一障害通知はResendの冪等キーで1時間に1回まで
- 重大異常時はGitHub Actionsも失敗扱いになり、Resendとは別に赤い実行履歴を残す

監視状態、通知抑制、復旧状態、ロックは既存の`OperationalHeartbeat`へ保存します。
業務データへの書き込みは行いません。

管理画面の「公開監視」には、現在の検査結果から確認先を示す決定表ベースの
運用ガイドがあります。AIによる自動判断や自動修復は行いません。

## Webサービスの環境変数

```text
LAUNCH_MONITOR_ENABLED=true
LAUNCH_MONITOR_TOKEN=<32文字以上のランダム値>
LAUNCH_MONITOR_DEADMAN_TOKEN=<別の32文字以上のランダム値>
LAUNCH_MONITOR_DURATION_HOURS=72
LAUNCH_MONITOR_STARTED_AT=<UTC ISO日時>
```

`LAUNCH_MONITOR_STARTED_AT`はパスワード解除直後の時刻へ必ず更新します。
開始時刻と期間から監視キャンペーンを識別し、以前の完了・通知・重い検査の状態を
新しい72時間へ引き継ぎません。

任意:

```text
LAUNCH_MONITOR_ALERT_EMAIL=<通知先。未設定時はADMIN_EMAIL>
LAUNCH_MONITOR_FROM_EMAIL=<送信元。未設定時はMAIL_FROM>
```

## GitHub Actions

Secrets:

```text
LAUNCH_MONITOR_TOKEN
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
```

Workflowは72時間完了レスポンスを受け取ると、自身を無効化します。

## Render Cron

10分ごとのCron Jobを別サービスとして作成します。

```text
Build: npm ci
Start: node scripts/launch-monitor-deadman.mjs
Schedule: */10 * * * *
```

必要な環境変数:

```text
LAUNCH_MONITOR_URL
LAUNCH_MONITOR_DEADMAN_TOKEN
RENDER_API_KEY
RENDER_CRON_SERVICE_ID
RESEND_API_KEY
MAIL_FROM
ADMIN_EMAIL
```

72時間完了を検知すると、このCron Jobも自身を停止します。

## 安全性

- 内部APIはPOST専用、専用Bearer Token、定数時間比較、`no-store`
- 外部レスポンスはID、状態コード、件数だけ。個人情報や生エラーを返さない
- 監視対象URLとDB条件はサーバー側で固定し、リクエストから指定できない
- Agentはコマンド実行、`eval`、動的スクリプト実行をしない
- 同時実行はGitHub ActionsのconcurrencyとDBロックの両方で抑止
- DBロックは所有者を記録し、古い実行が後続実行のロックを解除できない
- Renderの自己停止対象は`crn-`で始まるCron Job IDだけ

`node scripts/launch-monitor-agent.mjs --dry-run` はRenderログと公開URLだけを確認し、
内部監視、DB書き込み、通知を行いません。
