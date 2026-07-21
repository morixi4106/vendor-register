# 規約公開・版管理手順

> **INTERNAL DRAFT / 未施行** 正式な承認後にのみ利用してください。

## 1. 本文を確定する

1. 出店者基本契約と購入者規約の `[要確定]` を全て埋める。
2. 文書末尾へ版、制定日、最終改定日及び運営者情報を記載する。
3. 一度公開した版は上書きせず、版ごとに別URL又は復元可能な履歴を保持する。
4. PDFを使用する場合も、スマートフォンで閲覧できるHTML版を用意する。

## 2. SHA-256を計算する

本文の改行や空白変更でもハッシュは変わります。公開する最終ファイルそのものから計算します。

PowerShell:

```powershell
(Get-FileHash -LiteralPath '.\seller-agreement-v1.pdf' -Algorithm SHA256).Hash.ToLower()
```

Node.js:

```bash
node -e "const fs=require('fs');const c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('seller-agreement-v1.pdf')).digest('hex'))"
```

## 3. Renderへ設定する

```text
SELLER_AGREEMENT_VERSION=<例: seller-master-2026-01>
SELLER_AGREEMENT_URL=<公開済みHTTPS URL>
SELLER_AGREEMENT_DOCUMENT_HASH=<64桁SHA-256>
BUYER_TERMS_VERSION=<例: buyer-terms-2026-01>
BUYER_TERMS_URL=<公開済みHTTPS URL>
MARKETPLACE_GOVERNANCE_GATE_ENABLED=false
```

## 4. 同意を取得する

- 出店店舗はログイン後に、現行版の本文を開いて同意する。
- 同意記録には店舗、版、本文ハッシュ、同意者、日時及び取得元を保存する。
- 管理者による代理記録は、紙面又は別システムの同意証跡がある場合に限定する。
- 重要変更時は版とハッシュを更新し、既存店舗から再同意を取得する。

## 5. ゲートを有効化する

1. 管理画面の販売責任・案件管理で、本番店舗と本番商品の警告を解消する。
2. 本番確認で契約・商品・店舗に関するブロッカーが0件であることを確認する。
3. 既存商品の売主対応が正しいことを確認する。
4. `MARKETPLACE_GOVERNANCE_GATE_ENABLED=true` に変更する。
5. 直販商品と店舗商品を各1件、公開・カート・チェックアウト直前まで確認する。

## 6. 変更管理

- 版変更の理由、承認者、公開日時及び影響する店舗を記録する。
- 契約変更前に、必要な通知期間を確保する。
- 注文には注文成立時の売主・規約版スナップショットを保存する。
- 古いURLを削除せず、過去注文の根拠を確認できる状態にする。
