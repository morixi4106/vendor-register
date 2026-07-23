# マーケットプレイス運用管理

この機能は、販売主体、出店者契約、商品コンプライアンス、購入後案件、精算保留を一つの監査可能な流れで管理します。

契約、個人情報、資金フロー、税務及び事故対応の原案は [法務・運用パッケージ](./legal/README.md) にまとめています。アプリ側のゲートを有効にする前に、同ディレクトリの公開前チェックリストを完了してください。

## 環境変数

```text
MARKETPLACE_GOVERNANCE_GATE_ENABLED=false
SELLER_AGREEMENT_VERSION=seller-master-2026-01
SELLER_AGREEMENT_URL=https://example.com/seller-agreement
SELLER_AGREEMENT_DOCUMENT_HASH=<公開した契約本文のSHA-256>
BUYER_TERMS_VERSION=buyer-terms-2026-01
BUYER_TERMS_URL=https://example.com/terms
BUYER_TERMS_DOCUMENT_HASH=<公開した購入規約本文のSHA-256>
SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_CONFIRMED=false
SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_REFERENCE=
MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED=false
DOMESTIC_SELLER_SETTLEMENT_ENABLED=false
CROSS_BORDER_SELLER_SETTLEMENT_ENABLED=false
CROSS_BORDER_SETTLEMENT_LEGAL_APPROVAL_REFERENCE=
SELLER_DISCLOSURE_PROCEDURE_APPROVAL_REFERENCE=
MARKETPLACE_TAX_INVOICE_POLICY_APPROVAL_REFERENCE=
PRIVACY_HASH_SECRET=<32文字以上の乱数>
MARKETPLACE_ADMIN_EMAILS=owner@example.com
FINANCE_PREPARER_EMAILS=preparer@example.com
FINANCE_APPROVER_EMAILS=approver@example.com
RELEASE_MANAGER_EMAILS=release-manager@example.com
INCIDENT_COMMANDER_EMAILS=incident-commander@example.com
RECOVERY_APPROVER_EMAILS=recovery-approver@example.com
COMPLIANCE_REVIEWER_EMAILS=compliance-reviewer@example.com
FINANCE_EXECUTOR_EMAILS=executor@example.com
```

- 初回デプロイ時は `MARKETPLACE_GOVERNANCE_GATE_ENABLED=false` のままにします。
- 契約URLは出店者が実際に閲覧できる `https` URLを設定します。
- 文書ハッシュは契約本文から計算した64桁のSHA-256です。秘密値ではありません。
- Shopifyの書面回答、税務方針及び開示手順の参照値には、社内で保存したメール・PDF・議事録等の識別子だけを設定し、秘密資料そのものをPublic repositoryへ置きません。
- 契約本文を変更するときは版とハッシュを更新し、出店者から改めて同意を取得します。
- 担当者メールはShopify Adminのassociated userと一致させます。複数指定はカンマ区切りです。
- `ADMIN_EMAIL` と `MARKETPLACE_ADMIN_EMAILS` は緊急用の全権管理者です。通常運用では、リリース、事故対応、復旧承認、コンプライアンス証跡確認を上記の個別リストへ分離してください。
- Shopifyアカウント所有者も緊急用の全権を持ちます。日常操作には使わず、監査ログに残る担当アカウントを使用してください。
- 同一人物による出金予定の作成と承認、および販売停止者本人による復旧はサーバー側でも拒否されます。

## 決済・精算の開始条件

第三者店舗を売主とし、運営がShopify Paymentsで代金を受領して後日精算する構造は、環境変数だけで合法・契約適合にはなりません。Shopifyから当該フローについて書面回答を取得するまで、精算とガバナンスの各スイッチを `false` に維持します。

確認時は [Shopify Payments 日本向け利用規約](https://www.shopify.com/jp/legal/terms-payments/jp) と [Shopify Payments Terms of Service](https://www.shopify.com/legal/terms-shopify-payments) の双方を参照し、回答資料は非公開領域で保存します。

## 段階公開

1. migrationを適用し、管理画面の「販売責任・案件管理」を開きます。
2. Renderへ契約と購入規約の版、URL、ハッシュを設定します。
3. 本番店舗の事業者情報、返送先、出店者契約への同意を確認します。
4. Shopifyで直接登録した商品を含め、販売商品の状態、原産国、英語品名、真正性、知財権を審査します。
5. 「本番確認」で販売責任関連の警告が0件であることを確認します。
6. `MARKETPLACE_GOVERNANCE_GATE_ENABLED=true` に変更します。
7. 既存商品と新規商品を各1件、購入直前まで確認します。

ゲートが無効な間は不足を警告として表示します。ゲートを有効にすると、準備不足の商品は公開同期とアプリ経由のCheckoutで販売できません。

## 精算制御

- `salesHold`: 新しい売上計上を保留します。
- `payoutHold`: 新しい出金予定の作成を停止します。
- `reserveAmount`: 台帳残高から留保する金額です。
- `directInvoiceBalance`: 店舗へ直接請求し、未回収となっている金額です。
- `futureSetoffEnabled`: 責任確定後の将来売上との相殺について、契約上の根拠を確認済みであることを示します。

案件を作成しただけでは台帳を変更しません。責任額と根拠を確定し、管理者が個別の精算調整を適用したときだけ台帳へ記録します。負担額は確定した店舗責任額を超えられません。

### 財務操作の分離

- `FINANCE_PREPARER`: 出金予定と精算調整を作成します。
- `FINANCE_APPROVER`: 出金予定と精算調整を承認し、台帳不整合の補正を実行します。
- `FINANCE_EXECUTOR`: 承認済みの出金予定を実送金へ進めます。
- 送金は「承認済みから処理中への確保」と「外部送金IDを伴う完了記録」の二段階です。
- 作成者情報がない旧出金予定は承認できません。削除や流用をせず、内容を確認して新しく作り直します。

## 注文スナップショット

新しいSellerOrderには、注文成立時点の販売主体、出店者契約版、購入規約版、商品コンプライアンスを保存します。後から店舗名、住所、商品説明、規約が変わっても、過去注文の根拠は上書きされません。

## 運用境界

- 自動返金、自動キャンセル、自動相殺は行いません。
- 監視機能は案件や精算を自動修復しません。
- 法的判断、真正性判断、責任割合、越境返品は、人が証拠を確認して記録します。
- テスト店舗は出金不可であり、ゲート有効時の本番準備完了数から除外します。
