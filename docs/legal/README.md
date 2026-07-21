# マーケットプレイス法務・運用パッケージ

このディレクトリは、Oja Immanuel Bacchus のマーケットプレイス運営について、アプリ外で決定・公開・保存すべき事項をまとめた作業文書です。

## 採用する基本構造

- 出店店舗の商品は、その出店店舗が購入者に対する売主です。
- 運営が直接販売する商品は、運営が購入者に対する売主です。
- 運営はマーケットプレイス提供者であり、出店店舗のために注文受付、決済代金の受領、返金処理、販売管理及び精算を行います。
- 一つのチェックアウトに複数店舗の商品が含まれる場合、購入者と各売主との間に店舗別の売買契約が成立するものとして扱います。
- 運営が購入者に対する窓口を一本化しても、商品の表示、安全性、適法性及び契約適合性に関する各売主の責任は消えません。
- 返金、キャンセル、店舗への求償及び売上との相殺は、自動実行せず、証拠、責任額及び契約上の根拠を確認して記録します。

詳細は [marketplace-legal-structure.md](./marketplace-legal-structure.md) を参照してください。

## 文書一覧

- `marketplace-legal-structure.md`: 売主、運営、購入者、決済及び精算の関係
- `seller-master-agreement-draft.md`: 出店者基本契約の原案
- `buyer-terms-draft.md`: 購入者向け利用規約の原案
- `privacy-data-handling.md`: 個人情報のデータマップと運用基準
- `funds-flow-tax-memo.md`: 資金フロー、金融規制及び税務の確認メモ
- `operational-playbook.md`: 事故、返金、チャージバック、負残高等の運用手順
- `prelaunch-external-checklist.md`: 公開前に証跡を揃えるチェックリスト
- `expert-inquiry-templates.md`: 決済会社、弁護士、税理士、保険会社への限定質問
- `contract-publication-runbook.md`: 規約公開、SHA-256、再同意及びゲート有効化の手順

## 文書の扱い

これらは現行コードと現在の事業方針に合わせた原案です。次の事項が未確定の間は、そのまま公開文書として使用しません。

1. 運営法人又は個人事業者の正式名称、住所、代表者及び連絡先
2. 手数料率、精算周期、保留期間及び最低出金額
3. 決済会社との契約上、運営が出店店舗の代金を代理受領できること
4. 資金決済法上の取扱いについての個別確認
5. 消費税、インボイス及び帳簿処理についての個別確認
6. 管轄裁判所、準拠法及び損害賠償上限
7. EU販売を行う場合の国別法務、VAT/IOSS、GPSR及びDSA対応

## 公開までの順番

1. `marketplace-legal-structure.md` の意思決定欄を確定する。
2. 出店者基本契約と購入者規約の `[要確定]` を埋める。
3. 契約本文を変更不能な公開URLへ掲載する。
4. 公開本文のSHA-256を計算し、版、URL及びハッシュをRenderへ設定する。
5. 出店店舗から現行版への同意を取得する。
6. 税務・資金フローの限定論点だけを資格者及び決済会社へ照会する。
7. `MARKETPLACE_GOVERNANCE_GATE_ENABLED=true` にして販売ゲートを有効にする。

## 主な公的資料

- [消費者庁: 取引デジタルプラットフォーム消費者保護法](https://www.caa.go.jp/policies/policy/consumer_transaction/digital_platform/)
- [国税庁: インボイス制度](https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm)
- [個人情報保護委員会: 漏えい等の対応](https://www.ppc.go.jp/personalinfo/legal/leakAction/)
- [経済産業省: インターネット取引と製品安全4法](https://www.meti.go.jp/product_safety/consumer/pdf/seller_product-safety-4law-overview.pdf)
- [EUR-Lex: Digital Services Act](https://eur-lex.europa.eu/eli/reg/2022/2065/oj)
