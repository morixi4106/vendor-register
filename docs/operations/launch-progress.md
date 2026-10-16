# 公開準備の進捗と次の作業

更新日時: 2026-10-17 00:46 JST

公開準備に関するCodexの引き継ぎと進捗管理の入口です。作業開始時に読み、進捗があった作業の終了前に更新します。会話履歴だけを根拠に完了扱いにしないでください。

## 方針と現在地

- 目標は販売可能なサイト。ユーザーの希望は海外販売も初日から対応すること。国内限定の確認だけで目標達成としない。
- 現在の販売方式は運営直販の `SHOPIFY_STANDARD_DIRECT`。第三者店舗販売は別の公開条件で、現在は無効。
- 最後に確認した本番状態は **2026-10-15 11:35 JSTまで**。今回のメモ作成では本番の再監査をしていない。以下はその時点の記録であり、公開直前に読み取り専用で再確認する。
- サイトはパスワード保護中。海外・EU・Marketplace・第三者精算・公開Draft Orderは無効のまま。
- 公開判断は未完了。直近の監視は非公開による重大項目1件と、実地確認等の未完了9項目。監視プロセスの成功と販売可能判定は別。
- 公開前の自動監視メールは `LAUNCH_MONITOR_NOTIFICATION_MODE=prelaunch` で停止。監視・同期は通知なしで継続。購入者向け業務メールの設定は変更していない。
- 自動更新・自動マージは無効。これは販売開始の必須条件ではない。
- このメモの作成・更新は、公開、実決済、返金、Markets有効化、Shopify release、権限変更、通知再開の追加承認ではない。

## 作業場所

このPCの最新作業ツリーは `C:/Users/morix/vendor-register-final`。`C:/Users/morix/vendor-register` は古い別worktreeで、そこにある既存の変更を取り消したり、強制的にmainへ合わせたりしない。別のPCではパスを固定せず、対象リポジトリの最新worktreeを確認する。

確認時の本番Webと監視Cronのコードは `3c3c527cea2ea4f033f38bd0a7af6057478778eb`。稼働中Shopify App Versionは `limited-launch-v2-3470d47`。ローカルのドキュメント変更は本番反映の証明ではない。

## 完了したこと

| 項目 | 確認できた範囲と根拠 |
| --- | --- |
| 公開前の通知過多の修正 | [PR #50](https://github.com/morixi4106/vendor-register/pull/50) を本番反映。公開前は自動メール・GitHub通知を抑止し、手動受信テストは維持 |
| 通知せず監視・同期する動作 | Renderの実行で商品同期・注文整合性・監視・deadmanが完了。`notificationKind:null`、deadmanもメール抑止。受信箱の独立した全件集計は未実施 |
| 本人による監視メールの受信確認 | 2026-10-14に配信と確認コードによる本人受信確認が完了。購入者向け注文メールの証明とは別 |
| Resendの配信Webhook | 署名付き配信結果の取り込みを確認済み |
| CIと保護された変更経路 | PR #50とmainのCI成功。mainはPR・必須チェック・管理者適用を含む保護あり。直接push禁止 |
| 本番DBの独立した件数確認 | Render内の読み取り専用監査で注文5、決済試行1、返金1、直接返金0、台帳36。未適用・失敗migrationは0。既存記録の件数であり、新しい実決済の成功証明ではない |
| 新規非公開情報の保存対策 | 暗号化対応コード・schema・鍵設定・暗号処理の自己診断を確認。過去データすべての暗号化完了やShopify権限削減の完了ではない |
| バックアップの利用可能性 | RenderのPITR復旧可能期間が24時間以上あることを確認。実際の復元試験は未実施 |
| ビルド・実行環境の検査 | PR #50のCIでテスト1123件成功・既存skip1件、production audit成功。ビルド限定例外は条件付きで維持し、無制限の例外にしない |

本番状態のローカル証拠は `.codex-temp/quiet-monitor-runtime-20261015.json`。これはGit管理外で、他PCから参照できるとは限らない。監視時刻、集計結果、リリースを確認し、必要なら正規のサービス側記録で再検証する。秘密値や個人情報をコピーしない。

## 未完了の公開作業

状態の意味: 「未確認」は未実装と同義ではなく、現在の公開条件に適合する証拠が足りない状態。「一部完了」も販売開始の許可ではない。「条件付き」はその機能を公開する場合のみ必要。

### 管理画面に残る9項目

| ID | 作業 | 状態 | 完了条件 |
| --- | --- | --- | --- |
| P01 | 法定表示・利用規約の実画面確認 | 未確認 | 特商法・利用規約・返品・配送・プライバシーと実際の販売運用を照合し、確認者・証拠・有効期限を記録 |
| P02 | 購入直前画面の確認 | 未確認 | 価格・送料・税・合計・販売者・返品条件を実画面で照合し証拠を記録 |
| P03 | 未対応販売経路の無効化確認 | 未確認 | POS・管理画面注文・サブスク等の適用対象を調べ、未検証の迂回経路がないことを確認 |
| P04 | 緊急販売停止の訓練 | 未確認 | 現在の販売方式で停止と安全な再開の手順・結果を確認し記録 |
| P05 | 返金原資・支払可能額 | 未確認 | 必要額、利用できる残高、代替返金手段の実在を期限内の証拠で確認 |
| P06 | 管理者権限・MFA | 未確認 | Shopify・Render・GitHub・決済・メールサービスの管理者と不要権限、MFAを確認 |
| P07 | 個人情報事故対応手順 | 未確認 | 連絡先、検知・封じ込め・調査・本人対応の担当と手順を確定し証拠を記録 |
| P08 | 購入者・管理者への業務メール | 未確認 | 採用する注文・管理通知等を実受信し確認。監視メールの受信済み記録を流用しない |
| P09 | KOMOJU本番決済・注文・台帳の直販確認 | 未確認 | 現在のRender/Shopifyリリースで実売上と注文・商品行・台帳を直接照合。待機中の初回注文ガードは成功実績としない |

`AWAITING_ORDER` の未紐付けガードは未完了のまま扱う。無断で削除、付け替え、成功扱いにしない。`SHOPIFY_STANDARD_DIRECT` ではMarketplace Functionの無効状態だけで公開不可と判断しない。適用条件は実コードの `operationalReadiness.server.js` を確認する。

### 共通の仕上げ

| ID | 作業 | 状態 | 残っていること |
| --- | --- | --- | --- |
| P10 | 販売商品と公開内容の確定 | 未確認 | 商品、画像、価格、在庫、販売者、配送対象を点検しテスト商品を非掲載にする |
| P11 | PC・スマホの購入通し確認 | 未確認 | 商品から注文確認まで、在庫切れ・支払失敗・重複操作も含めて確認。テーマのテスト用コピーと実際の公開テーマを区別 |
| P12 | 返金・実入金照合 | 未確認 | 採用決済と公開条件に合う返金結果・台帳・銀行着金を確認。未検証の決済方法を開けない |
| P13 | 個人情報最小化の仕上げ | 一部完了 | 過去の平文件数・公開プロフィール・実scope/Webhookを点検。過去データの一括暗号化は無効、権限削減候補のShopify releaseは未実施 |
| P14 | 問い合わせ・出荷・返品の運用 | 未確認 | 受付先、担当、対応時間、発送元、返送先を確定。Inboxへの切替は受信等の確認前に行わない |
| P15 | バックアップ復元試験 | 一部完了 | 承認された隔離環境で復元と読取りを試験。利用可能なPITRがあるだけで復旧試験済みにしない |

### 海外販売を初日から行うための追加条件

| ID | 作業 | 状態 | 残っていること |
| --- | --- | --- | --- |
| P16 | 初期販売国の確定 | 未確認 | 対象国を絞り、確認済みの国のみ有効化する |
| P17 | 国別配送の証拠 | 未確認 | 商品受付、サービス、送料、配送日数、追跡、事故対応、返送先、代替配送経路を確認 |
| P18 | Shopify Markets・通貨・言語 | 未確認 | 国、表示通貨、言語、商品、送料を整合。現在は海外販売無効 |
| P19 | 税・関税・輸入費用 | 未確認 | 対象国別に最新確認し、徴収方法・負担者・分類・原産国等を確定。アプリに独自税額計算を追加しない |
| P20 | 国別の法務・商品要件 | 未確認 | 消費者保護、包装EPR、個人情報移転、化粧品等の該当条件を最新の一次資料と証拠で確認。EU・GB・US等を一括で合格にしない |
| P21 | 国際販売ゲートと迂回防止 | 一部実装・実地未確認 | 4A #54、4B-1 #55、4B-2 #56は候補CI成功。4B-3の管理操作/専用認証・配送/観測競合はローカル実装済み、PG計40件・画面21ケース成功。下書きPR #57のCI3本成功。4C、本番/実機は未完了。有効化ロックを維持 |
| P22 | Shopify反映と国際取引の通し確認 | 未確認 | 後続4Cで国・商品・購入者通貨・checkout由来・releaseの束縛を設計。初期はJPY建ての検証対象のみ、外貨対応は未完了。実取引・返金・台帳の証拠は未確認 |

北アイルランドはGBの確認を流用せず、別条件を満たすまで対象外。対象国の法令・制度は実行時に最新確認する。このメモは法的適合を認定しない。国内限定の期限付き公開や既存の国内承認を海外販売の証拠として流用しない。

### 第三者店舗を販売可能にする場合のみ

| ID | 作業 | 状態 | 残っていること |
| --- | --- | --- | --- |
| P23 | 店舗登録・審査・契約 | 条件付き・無効 | 登録、公開プロフィール、販売者表示、契約、商品審査を検証 |
| P24 | 店舗別の情報分離と購入導線 | 条件付き・無効 | 他店の注文・配送先が見えないこと、複数店舗購入の送料・返品を検証 |
| P25 | 店舗精算 | 条件付き・無効 | 手数料、支払、返金負担、台帳、必要なMarketplace制御と停止経路を検証 |

### 公開直前と初動監視

| ID | 作業 | 状態 | 残っていること |
| --- | --- | --- | --- |
| P26 | 本番通知の運用確定 | 一部完了 | 公開前停止は完了。通知対象・頻度・ACK後の猶予を合意し、明示承認後に本番通知を有効化。サイト公開をトリガーに自動再開しない |
| P27 | 独立監視・予備通知の残課題 | 一部完了 | Renderの10分監視は確認済み。GitHub定期実行の数時間遅延とRender起点の独立予備通知経路は未解決。手動GitHub成功や過去のIssue ACKだけで解消扱いにしない |
| P28 | 公開と初回注文の追跡 | 未実施 | 適用条件・証拠期限・商品・送料・決済を最終確認し、承認範囲でパスワードと公開前表示を変更。公開後の購入導線・初回注文を追跡 |

## 次に行う3つ

1. **次は4Cの詳細設計**: [PR #57](https://github.com/morixi4106/vendor-register/pull/57) の4B-3は候補CI成功。JPY制限、国/商品/checkout由来、実機ケース、正常終了/閉鎖、既存金融probeの接続を具体化する。実測検査なしでB1のFAILED終了や最終SALE proof/capabilityを先に緩めない。
2. **実runnerと外部証拠を確認**: 固定publisher/observerの鍵・credential、管理されたscheduler、実scope/native、実埋込み画面の認証、P01-P28の法務/配送/資金/MFA/業務メール/実取引証拠は未確認。fixtureや監視メールの受信記録で代用しない。R06とprelaunch通知抑止は別管理。
3. **依存PRの反映準備**: #57は#56、#56は#55をbaseとする候補。#51以降のretarget/rebase・CI、migration/実権限・国内ガード停止影響を確認してから本番操作を別承認する。空DBの旧migration履歴不整合、AWAITING_ORDER、公開/実決済/返金/通知再開の境界は維持する。

ユーザーの最新依頼は「実装どうぞ」。4B-3を[下書きPR #57](https://github.com/morixi4106/vendor-register/pull/57)へ候補実装し、`d3dcbc5` のQuality/PG/artifact CI3本成功を確認した。4C、本番の鍵/credential・実scope・実配備は未完了で、有効化ロックを維持。本番の最新観測日は引き続き2026-10-15 11:35 JSTまで。本番migration・設定・実決済/返金・メール送信はしていない。

調査結果が既存の確認と変わらない場合は同じ監査を繰り返すだけで終えず、残作業の実装・検証か、必要な外部証拠の特定へ進む。ユーザーが新しい指示をした場合はそちらを優先する。

## 設計と実装の再開地点

2026-10-15に[公開準備の実行設計](launch-execution-design.md)を作成後、ユーザーの実装指示に従い第1段階をローカル実装・検証。本番再監査・設定変更は未実施で、P01-P28の実確認の完了状態は変えていない。

- 既存の公開判定・証跡・国際ゲートを使い、別の公開許可エンジンは作らない。
- 国内限定のリスク受容でwarningになっていても、実証跡の `ready` がfalseなら確認済みではない。
- 国内向けの「標準チェックアウトの準備ができています」を撤去。現在の経路設定、実証跡、国内限定例外、海外の対象未設定・証拠不足・実機確認待ちを分離した。
- 次の作業は既存の確認先へのリンクを最大3件。閲覧で証跡登録、決済、メール送信は実行しない。監視通知モードは安全なenumのみ既存の認証済みloaderへ追加し、非キャッシュを明示した。
- 配送の表示用DTOは既存検査結果の可用性・対象商品数・必要国数のみ。個別の商品・連絡先等を新たに公開しない。既存の行数制限に従いShopifyのDTO組立ては担当モジュールへ置いた。
- ローカル検証: 全体テスト1143件中1139成功・既存のWindows依存skip4件、lint・architectureチェック・アプリbuild成功。PC1440px・スマホ375px/320pxで4状態、合計12パターンのPlaywright画面検証と証跡アンカーの遷移確認を実施。
- ビルドではPolarisの印刷CSSと既存のchunk構成に関する警告を出力したが終了コードは0。`build:production`によるローカル依存の置換は実行していない。
- 検証データは `tests/fixtures/productionReadinessPage.js`。ローカル証拠は `.codex-temp/readiness-stage-one-tests.log`、`.codex-temp/readiness-stage-one-preview-results.json`、同接頭辞のHTML・スクリーンショット。実際の本番データではない。
- 第1段階はmigration・本番設定・決済・通知送信を含めず、まだ本番未反映。次はPR/CI結果を確認してから、第2段階の商品・国・配送経路の実確認へ進む。
- [PR #51](https://github.com/morixi4106/vendor-register/pull/51)、実装 `0805dbf` のverify `38717321565` は成功。CIでFunction試験・拡張/アプリbuild・隔離runtime・production auditも成功。actionのコードはmainとのAST正規化比較でも同一。進捗メモと設計書・AGENTS.mdも同じPRに含め、mainへの直接push・マージ・本番デプロイはしていない。
- 残実装の静的確認では、海外直販のFunction適用、商品×国の強制、ゲート実値/取消同期、国際証拠操作のロール、海外取引の識別、予備通知ACKの6点を設計対象とした。国別ゲートや個人情報移行・基本決済照合は既存のため作り直さない。設計保存はローカルのみで、PR #51へ追加pushしていない。

### 第2弾: R01・R04

- 作業ブランチ `agent/international-direct-policy`、[PR #52](https://github.com/morixi4106/vendor-register/pull/52)、実装コミット `0ebf1016417923f7a10baeabbc3abb81b806b66b`。PR #51 head `8af3cd8` を土台にし、mainの直接push・マージはしていない。GitHub mainは `3c3c527` のままと20:29 JSTまでに再確認したが、本番ランタイムの再監査はしていない。
- 共通判定 `checkoutCommerceContext.server.js` を追加。承認済み非テスト商品の海外配送・国ポリシー/EU状態、配送サービス設定と購入方式を照合する。取得不能を国内0件と扱わない。既存の配送検査結果を本番前チェックと実地証拠判定で共用する。
- 海外設定がある標準直販は公開ブロッカー。国内限定リスク受容・限定公開証拠の代用・paid-only開始/完了・過去合格probeの再利用を禁止し、Validation無効化操作も拒否。検証付き経路では有効なValidationを要求する。KOMOJUのみの直販では未使用のShopify Payments確認を補助項目へ分離。
- 国際配送画面の閲覧/操作を既存運営ロールへ統一。証拠登録とShopify同期を別ロールへ認可し、確認者は認証済みactorから取得。未知intent、POST以外、32KB超を拒否し、内部エラーを隠す。旧ショップドメイン名義の証拠は再確認対象として評価するだけでDBを書き換えない。
- ローカルの全体テスト1161件中1157件成功・既存Windows依存skip4件。国ポリシー検出、未知/海外範囲、権限別の拒否、確認者偽装、旧証拠、サイズ制限、Validation無効化、過去probe再利用を試験。lint・text・architecture・アプリbuild成功。ビルドの既存Polaris CSS/chunk警告は継続。
- 実装コミットの[CI verify 38728474501](https://github.com/morixi4106/vendor-register/actions/runs/38728474501)はSUCCESS。Function試験、拡張/アプリbuild、隔離runtime、production auditと検査用生成差分なしも通過。引き継ぎ文書の追記は同じPRへ保存する。
- ローカル証拠は `.codex-temp/international-policy-all.log` 等。疑似データ/依存注入による検証であり、本番画面・実決済・配送・法令適合の証拠ではない。
- migration、環境変数、Shopify scope/Function、Markets、実決済/返金、メール送信、本番デプロイは変更・実行していない。通知のprelaunch抑止を維持。R02/R03/R05/R06とP01-P28の実確認は残る。

### 第3弾の詳細設計

- 2026-10-15 21:05 JST、[商品別の海外購入制御と失効同期](international-checkout-sync-design.md)を作成。商品別国許可、全店/商品の同期世代、海外停止後の反映、永続キューとCAS/lease、権限と受入試験を具体化した。アプリコード・schemaは未変更。
- 既存の国別 `SaleEligibilityProjection` と評価/履歴を再利用。新規DBは同期制御と対象ジョブの2モデル案で、既定ではShopify書込みをしない。運営がarmした商品×国の範囲だけを対象にし、証拠追加からの無断の範囲拡大・緊急停止の自動復旧を防ぐ。
- 現行Function/APIは2026-04。公式仕様と同梱schemaで `buyerJourney.step` / 配送グループの `cartLines` を確認した。日付だけで分単位の失効を保証せず、店舗タイムゾーンで安全側の期限を採る。取消のDB受付とShopify停止確認は別状態にする。
- 現行設定ファイルには `read_markets` がない。実付与scopeはこの回で照会していない。Markets実値検査は必要な読取り権限の別承認・確認を前提にし、アプリDBの海外対象0件から国内限定を断定しない。新規の顧客読取り/Markets書込みscopeは要求しない。
- 文書のみローカル保存。PR #52への追加push、新規PR/CI、アプリテスト、本番再監査、migration、Shopify書込み、実取引、メール送信は実施していない。P01-P28の実証跡と公開可否は変わらない。

### 第3弾: 商品×国の購入制御と永続同期基盤

- PR #52 head `2971869` を土台に実装。[PR #53](https://github.com/morixi4106/vendor-register/pull/53)は下書き、実装 `cc8276e14124fa604850d3bf6d610b2f9f074dfb`。mainへの直接push、merge、デプロイ、Function release、scope追加、Markets変更、決済・返金・メール送信は行っていない。
- 全店v2と商品v1の国際projectionを世代・商品ID・国・日付で照合。海外は厳密なELIGIBLEだけを生成し、既存の適格性評価・国別証拠と履歴を再利用。回収、テスト店舗、第三者店舗、未照合の配送行、GBの郵便番号不明・BT宛て、未知versionは拒否する。
- FunctionのAPIは2026-04のまま。クエリコスト30以下に収めるため、重複する商品区分metafieldの読取りをやめ、既存の一般projection内のroutingClassを正本として検査。backendの区分metafieldとprojectionの同期・監視は維持。GBは郵便番号でNIを拒否し、provinceは入力へ要求しない。
- 200行は絶対上限のままだが、許可を保証する上限ではない。一般/国際projection合計10,000文字を超えるカートはJSON評価前に分割案内で拒否。100行海外・200行国内の大量入力を、許可テストではなく安全な拒否テストとして扱う。WASMで入力128kB・命令11M・メモリ10,000KiB以下を検査し、異なる12商品の通常注文も検証。
- migration `20261015123000_international_gate_sync` を追加。状態と対象ジョブの2モデル、証拠/配送受付のrevisionを追加するが、本番へは未適用。既定DISABLEDではShopifyへ書かない。証拠取消・配送停止・商品審査/国ポリシー/リンク・削除・要件更新は同じDB transactionで世代とジョブを登録し、停止反映を先に試みる。旧フォームはrevision付きversionで409にする。
- 既存カタログCronへbounded workerを接続。閉鎖値のCASと読戻し、商品反映、全商品の再読戻し、source/native/release再確認、全店許可の順。lease、旧世代破棄、backoff、Retry-After、安全なエラーコードを追加。読戻した閉鎖値だけで「停止確認済み」にせず、有効なFunctionとリリース証拠も要求する。設定不一致後はSTOPPEDにして自動再許可しない。
- 新しい共通読取り検査を海外構成の公開前チェック・監視へ接続。Markets/配送/商品variant/Validationを読取り、必要scope不足、部分取得、未知構造は未確認とする。初期のnative検査には件数上限と未対応構造があり、条件付き送料・selling plan・複合Market条件等は未確認。上限を超える構成を「検査済み」にしない。
- 承認範囲の固定と国際リリース証拠を検査する内部関数は追加したが、有効化UIはまだ公開していない。証拠の実発行と購入防止の実機確認はR05へ接続する。実付与scope・native設定・稼働Functionの独立確認は今回行っていない。国内例外の共通判定へnativeを接続する残作業もある。
- ローカル全体テスト1200件中1196成功・既存Windows依存skip4件、最終canonical JSONの追加後に関連試験も成功。WASM77件、型生成、Prisma format/generate/validate、lint・text・architecture・アプリbuildも成功。負荷をかけた同時実行時に既存maintenance timeout試験が1回不安定になったが、全体再実行は成功し、閾値は変更していない。
- 実装コミットの[CI verify 38884464961](https://github.com/morixi4106/vendor-register/actions/runs/38884464961)はSUCCESS。全体1201件中1200成功・既存skip1、監査coverage175件成功、Function・拡張/アプリbuild・隔離runtime・production audit・生成差分なしも成功。CIの大量カート拒否試験は100行海外6.50M命令、200行国内10.43M命令で上限11M以内。200行の許可を保証する試験ではない。
- ローカル証拠 `.codex-temp/r02-r03-final.log` はGit管理外。疑似DB/依存注入とローカルWASMの検証であり、実PostgreSQLの競合、実Shopify設定、実取引の確認ではない。P01-P28は完了へ変更していない。

### 後続4A-4Cの詳細設計

- 2026-10-16 19:43 JST、[海外販売の実設定・承認・取引検証](international-release-verification-design.md)を作成。4Aのnative共通判定、4Bの証拠発行/単回承認、4Cの対象別取引照合に分け、受入条件と実装先を記録した。R06は別変更とする。
- 現状の内部承認関数と最終証拠だけでは初回検証の循環があるため、配備・検証開始用と一般販売用の証拠を分離する設計。非公開のVERIFYでも通常の適格性・法務/配送条件を飛ばさず、終了後は閉鎖し自動SALE移行しない。
- 国際probeは店舗通貨と購入者通貨を分離し、国・商品・checkout由来・releaseを束縛する。初期の実装受入はJPY建てで、外貨やGBの地域識別が未確認なら自動で合格にしない。許可通貨用の全店v3/policy v2は後続案で、現在のFunctionは未変更。
- 承認要求/検証runの2モデルと既存状態への参照追加を設計したが、schema/migrationは未作成。既存の金融probe JSONを再利用し、AWAITING_ORDERを無断で付け替えない。
- ローカル文書のみ更新。今回の追加push・PR・CI、本番操作、決済/返金、メール送信はなし。文書の整合・文字コード検査を実施し、アプリテストは設計のみのため再実行しない。P01-P28の実証跡の完了状態は変更していない。

### 第4弾4A: native実設定と販売範囲の共通判定

- `agent/checkout-native-scope` に軽量なMarkets/配送国棚卸しと、DBとの共通判定を追加。海外の肯定的な検出と取得の完全性を分け、途中失敗でも国内0件にしない。scope未指定・別shop・欠落権限も未確認とする。DBの商品検査へ対象shopを渡す。
- scope用queryは商品/variant、送料条件、Validationを読まず、国内の条件付き送料で誤って棚卸し全体を未確認にしない。海外詳細検査は制約を維持。集合hashは返却順序を正規化し、国/通貨/profile/送料/provider等の変化は、それぞれ軽量/詳細検査の取得範囲で検出する。
- native読取りsessionは処理単位で共有し、15秒の予算と各要求最大10秒・Abortを適用。root最大10ページ、内側の上限/未対応構成は未確認。API/DB全処理の時間保証や、実配送可能の証明とはしない。
- readiness、監視、国内自動ガード、probe開始/paid-only完了、Validation無効化へ接続。軽い監視でもscopeを再取得。環境変数の希望だけでは国内リスク受容・Watchdog省略に使わない。既存strict flowの支払/返金照合・注文取込みは維持する。
- ローカル全体1233件中1229成功・既存Windows依存skip4、Function/WASM77件成功。lint/text/architecture・アプリbuild・隔離runtime packageも成功。既存Polaris CSS/chunk警告は継続。画面の新設・変更はなく、今回新しいPlaywright画面検証はしていない。
- ローカル通常モードのproduction auditは、変更後artifactの再審査・build evidence・既存のビルド限定例外条件を要求して拒否した。例外期限や検査を緩めず、既存のQuality checksと審査条件でCI検証する。ローカル証拠 `.codex-temp/native-scope-all.log` 等はGit管理外で、実店舗・実取引の証拠ではない。
- [下書きPR #54](https://github.com/morixi4106/vendor-register/pull/54)、実装 `5a0d63258ebd8b8c8bdd256e0efd9e70c7e3d6a7` の[verify 38893113799](https://github.com/morixi4106/vendor-register/actions/runs/38893113799)はSUCCESS。Linux全体1233件中1232成功・既存skip1、監査coverage、Function/WASM、拡張/アプリbuild、隔離runtime、production audit、生成差分なしも成功。既存の条件付きビルド限定例外・provenance検査を使用し、条件の緩和やmain反映はしていない。
- 追加のローカルcoverage検査は対象45件成功。新規のnative読取り/国範囲判定と共通contextの3モジュール合計で行98.61%・分岐91.01%・関数100%。アプリ全体のcoverageや実店舗の確認率ではない。
- 本番反映前には実付与 `read_markets`/配送読取り権限を確認する。欠落すれば国内例外も未確認となり、既存の有効な国内ガードが停止処理へ進み得る。権限追加・ガード解除は自動実行しない。4B/4C、P01-P28の実証跡、本番反映は未完了。

### 4Bの承認・検証証拠の詳細設計

- 2026-10-16 20:40 JST、[国際販売の承認と検証証拠](international-authorization-design.md)を作成。4A候補 `5a0d632` / 文書HEAD `255b6f5` を基準に既存authorizer・同期・queue・role・Prisma・CI artifactを静的確認した。GitHub/本番の再監査はしていない。
- VERIFY/SALE/RESUMEの用途、承認要求とrunの2モデル、source/証拠versionのtransaction内再検査、nonce単回消費、世代/承認ID/leaseのフェンスを具体化。DISABLED中の証拠変更は世代だけで検出できないためsourceも比較する。
- 現在のCI uploadは監査JSONのみで、国際配備proofに必要なWASM/query/schema/policyのartifactと配備記録は追加が必要。固定verifierと専用issuerを使い、自己申告JSON/checkboxでシステム証拠を作らない。
- runner終了/失効/障害の停止要求をDBへ残す。閉鎖未確認の試験runは解放しないが、閉鎖専用の配備再検査を許可してproof失効による行き詰まりを避ける。非課金VERIFYでも他のパスワード保有者の課金露出が残ることを明記した。
- 次は4B-1。4B-2の証拠発行、4B-3の既存UI/runner接続は段階実装し、4Cの通貨制限/実機照合が揃うまでは有効化を拒否する。schema/migration・コード・workflowは今回編集せず、P01-P28の実確認は未完了のまま。
- 文書のUTF-8/文字化け、相対リンク、差分空白を検査。設計のみのためアプリテスト・build・CIは再実行しない。ローカル文書のみで、push/merge/デプロイ・Shopify release/scope・実決済/返金・通知送信はない。

### 第4弾4B-1: 単回承認と永続停止の候補実装

- `agent/international-authorization`、baseは4A候補 `255b6f5`。2モデルと同店舗参照/CHECK、state/jobの承認ID、単回preview/confirm、10分TTL、Serializableによるsource/proof/generation再検査と原子的な承認・世代・job/run作成を追加。復旧には両権限と閉鎖確認を要求する。
- workerは現在の承認ID/用途/leaseを確認。旧actor文字列による有効化、QUEUEDの許可反映、VERIFYの一般販売ready、汎用フォームからのシステム証拠を拒否する。4C capabilityとproof adapterは既定で未対応のまま。
- run失効/終了からSTOPPEDと閉鎖jobを永続化し、閉鎖未確認ならretry/activeKey保持。PASSEDは発行しない。証拠発行・配備検査runの実行adapter・runner HTTP認証・UI・金融検証は4B-2/3・4Cに残る。
- migration `20261016120000_international_authorization` は本番未適用。旧migration全履歴の空DB適用は既存の `Product` テーブル名不整合で失敗したため、旧schemaを隔離PGへ作り今回migrationを適用して検証。適用後のschema差分0。全履歴修復済み、本番migration済みとは扱わない。
- 専用隔離PostgreSQLは11件成功。二重confirm・STOP競合・source変更・別shop/actor・nonce/期限・DB rollback・復旧ロール・lease/閉鎖・proof取消を試験。native/proofの外部取得は試験用adapterであり、実Shopifyや法務の証拠ではない。CIへ専用PG jobを追加し、通常全体テストでの未設定skipとは分離する。
- ローカル全体1244件中1239成功、既存Windows依存skip4と専用PG wrapperの未設定skip1。Function/WASM77件、Prisma format/generate/validate、lint/text/architecture、アプリbuild、隔離runtimeが成功。既存Polaris CSS/chunk警告は継続。UI/Function sourceは変更せず新しいPlaywright画面検証はしていない。
- 通常モードのproduction auditは `artifact_set_changed_since_review` / `build_control_evidence_failed` / `risk_not_accepted` で拒否。runtime単独監査・artifact reachabilityは成功。例外や必須検査を緩めず、既存の条件付き審査を含むCIで確認する。
- [下書きPR #55](https://github.com/morixi4106/vendor-register/pull/55)、実装 `10bef31` とCI分離修正 `7ca46dee4fc80a9982d244b1c0d9c18a0af38a88`。baseはPR #54の `agent/checkout-native-scope`。初回CI `38899742093` は品質workflow/package追記によるbuild control fingerprint不一致で拒否した。専用PG試験を別workflowへ移し、品質workflow・package/lockfile・受容済み例外は元の内容を維持した。
- `7ca46de` の[Quality checks 38900277480](https://github.com/morixi4106/vendor-register/actions/runs/38900277480)はSUCCESS。Linux1244件中1242成功・既存skip1と専用PG wrapper未設定skip1、監査coverage、WASM77件、拡張/アプリbuild、隔離runtime、production audit、生成差分なしを確認。[独立PG試験 38900277332](https://github.com/morixi4106/vendor-register/actions/runs/38900277332)も11件成功・skip0。mainへは未反映。ローカルPGは停止済み。
- 本番/Shopify再監査・設定変更・実取引・メール送信なし。既存AWAITING_ORDER、国内ガード、prelaunch通知停止を維持。4B-1は候補であり、海外販売可能の証明ではない。

### 4B-2のシステム証拠発行の詳細設計

- 2026-10-16 21:50 JST、[国際販売のシステム証拠発行設計](international-proof-issuance-design.md)を追加。4B-1候補HEAD `6ddc76c` のproof拒否、run終了/閉鎖、schema、品質/PG workflow、guarded buildとCLIを確認した。4B-2のコードは未実装。
- 最終build後のWASMを再buildせず試験する独立artifact workflowを設計。archive/content/WASMのdigest、run/head/attempt、全拡張/設定の配備範囲を区別する。既存の品質workflow/package・受容済み例外を黙って変更しない。
- `app deploy --no-build --no-release`、別のrelease承認、署名receipt、サービス側active version/Web/Cronの継続読取りを分離。CLI 4.5.2のhelp/list実装と公式仕様を確認したが、実サービスへの取得・stage/releaseは行っていない。2026-04のFunction query取得可否は本番未確認のまま。
- 配備proofと最終販売proof、初回閉鎖の循環解消、正常終了だけを成功候補とする専用経路、取消の依存追跡、期限/観測TTL/保管上限、実PGの競合試験を具体化した。4B-3/4C不在時の有効化ロックを維持する。
- 文書の文字化け/UTF-8、相対リンク44件、差分空白の検査が成功。設計のみのためアプリテスト/build/CIは再実行していない。文書はローカルのみで、push/merge、本番migration、credential/scope/設定変更、実決済/返金、メール送信はない。P01-P28の実確認は未完了のまま。

### 第4弾4B-2: システム証拠発行の候補実装

- 基準は4B-1 `6ddc76c`。固定repo/workflow/run/attempt/commitの照合、digest/期限と制限付きZIP検査、prebuiltの再build禁止、3拡張を含むartifact workflow、署名付きstage/release receiptとobserver CLIを追加。配備/金融を実行するworkflowは追加していない。
- 閉鎖専用DEPLOYMENT lifecycle、専用issuer/reader/revoker、nonce/sequence付き観測更新を追加。初回proofの循環を避け、run/最新証拠を原子的に保存する。取消は履歴・依存証拠と停止jobを同時に更新する。DEPLOYMENT run中の有効化confirmも拒否する。
- migration `20261016140000_international_proof_issuance` は候補のみ。隔離PGへ旧schemaとB1/B2のdeltaを適用し、schema差分0、各11件成功。旧migrationの全履歴不整合は修復していない。PGの試験に本番DBは使用していない。
- 最終ローカル全体1267件中1261成功・既存Windows依存skip4とPG wrapper未設定skip2。初回の並列試験は既存maintenance timeout試験1件が負荷で失敗し、単独/直列の全体再試験は成功。対象22件も成功。WASM/prebuilt77件、candidate artifact出力、Prisma validate、lint/text/architecture、アプリ/拡張build、隔離runtimeが成功。UI変更なし。
- 通常のproduction auditはartifact/build審査不足として拒否。既存品質workflow・package/lockfile・受容済み例外に差分なし。監査coverage試験は成功。例外を緩和せずLinux CIの既存条件付き審査へ進める。
- GitHub repoの公開設定を実読取り。CI成果物は公開ソース由来の配備ファイルだけに限定し、運用receipt・実観測・顧客/注文情報・本番secretは非公開DBに分離。公開artifactを非公開と説明しない。
- 信頼鍵は空リストが既定、最終SALE proofとcapabilityは4C未実装として拒否。B3の認証/内部配送・UI、4Cの正常終了/実機/金融照合、実key/権限/配備は未確認。本番migration・scope/設定・Shopify stage/release・実決済/返金・通知送信は行っていない。
- [下書きPR #56](https://github.com/morixi4106/vendor-register/pull/56)、baseは `agent/international-authorization` (#55)。実装 `978d671`、診断 `67930b0`、PATH修正 `cc9ad9de965c60af522b4be23d383dfb8d30e7eb`。初回artifact workflow 2回の失敗は、npm経由と違いCLI helper用のローカルbinがPATHにないため。既存safe-buildの入力へ固定binを渡して修正し、再build禁止・必須ケース・例外条件は維持した。
- `cc9ad9d` の[Quality checks 38910494945](https://github.com/morixi4106/vendor-register/actions/runs/38910494945)、[独立PG 38910495553](https://github.com/morixi4106/vendor-register/actions/runs/38910495553)、[artifact 38910494988](https://github.com/morixi4106/vendor-register/actions/runs/38910494988)は全てSUCCESS。Linux1264成功・skip3、PG各11成功/schema差分0、WASM77成功、アプリ/拡張build・隔離runtime・production audit・生成差分なしを確認。
- 実artifact `12049344728` を固定GitHub取得経路で独立読取りし、archive digestと全27ファイルのhash/サイズ一致、77ケースを検査。これは `channel=candidate`、PR合成merge SHA `a5b775b9b1bb7e5aec51809318011c258b06b604` の成果物であり、本番配備/店舗/金融の証拠へ昇格させない。署名receipt等はこの公開artifactへ入れていない。
- ローカルPGは停止済み。所有する一時初期化ディレクトリの削除はツールが拒否したため未実施で、本番データは含まれない。既存 `.codex-temp` は変更していない。進捗/設計書のUTF-8・相対リンク44件・差分空白も確認した。

### 4B-3の管理操作とrunner接続の詳細設計

- 2026-10-16 23:01 JST、[管理操作と検証runner接続設計](international-runner-interface-design.md)を追加。基準は4B-2の `bc20c0849b22a3b1c3baa8a2a65a7559c9c6491c`。前回このHEADの[Quality 38911149368](https://github.com/morixi4106/vendor-register/actions/runs/38911149368)、[PG 38911149008](https://github.com/morixi4106/vendor-register/actions/runs/38911149008)、[artifact 38911149153](https://github.com/morixi4106/vendor-register/actions/runs/38911149153)は成功確認済み。今回CI/GitHub/本番の再監査はしていない。
- 既存画面/authorizer/内部Bearer helper/同梱SDK/issuer/runを静的確認。管理画面の用途別操作とheader session token、publisher配送/閉鎖runner/observerの別credential、固定店舗/実行者、非公開DTOを設計。自己申告JSONや監視tokenを発行経路にしない。
- 新規1モデルは署名receiptの受信箱だけ。開始request keyの冪等性と同店舗FK、取消の依存追跡を既存run/queueへ接続する。P03は既存GLOBALを流用せず、店舗別証拠をrevision付きtransactionで更新/無効化する。
- UIの観測更新需要とexecutorのnonce発行を分離し、nonce非上書き、サーバー採番、同一署名再送、60秒/15分の鮮度、固定CLI/schedulerの責務を具体化。4C不在時の承認/通常VERIFY結果受付は拒否し、prelaunch通知を再開しない。
- 文書のUTF-8/文字化け、相対リンク30件、差分空白を検査。設計のみのためアプリテスト/build/CIは再実行していない。既存 `.codex-temp` は変更していない。
- 文書のみローカル保存。追加実装、migration、credential/設定/scope変更、push/merge、配備/release、実決済/返金、通知送信はない。次は4B-3A/B/Cの実装と検証、4CとP01-P28の実確認は残る。

### 第4弾4B-3: 管理操作とrunner接続の候補実装

- 基準は4B-2 `bc20c08`、ブランチ `agent/international-runner-interface`、[下書きPR #57](https://github.com/morixi4106/vendor-register/pull/57)。管理操作を既存routeからserviceへ分離し、header session token、Origin、用途別ロール、非キャッシュresource action、配備/履歴/承認UIへ接続。capability固定falseを維持し、通常VERIFY/SALEの開始と自己申告結果は拒否する。
- publisher配送/閉鎖runner/observerの専用credentialと内部routeを追加。固定shop/app、厳密Bearer、既存secretとの同値拒否、正準JSON/32KB、用途別rate limit。鍵registryは空のまま、新しいcredentialは作成・登録していない。
- migration `20261017000000_international_runner_interface` は候補のみ。receipt受信箱1モデル、同店舗FK、開始request key unique、取消追跡、観測需要/backoff欄を追加。旧delivery参照なしrunは自動採用しない。隔離PGは旧schemaと3つのdeltaを適用しschema差分0、B1/B2/B3が11+11+18件成功。旧空DB全履歴不整合の修復ではない。
- nonceの並行上書きを拒否し、サーバー採番、初回/更新の60秒challenge、同一結果再送、依存取消/STOP/leaseの競合とrollbackを検証。観測更新でproof/承認の期限やrevisionを延ばさない。受信と合格・停止保護・販売readyは別表示。
- 固定read-only observerを子processへ限定credentialで起動するbounded agentを追加。HTTP/Cron handlerからCLIを起動せず、公開・配備・実決済は実行しない。実scheduler、実CLI読取り権限、実公開鍵の導入/失効管理は未確認。背景処理はメールを送らない。
- ローカル全体1279件中1272成功・既存Windows依存skip4と専用PG wrapper未設定skip3。Prisma format/generate/validate、lint/text/architecture、WASM77件、拡張/アプリbuild、隔離runtime成功。production audit試験のcoverageは行98.49%・分岐92.49%・関数98.60%。通常local auditは審査不足の3codeで拒否し、既存品質workflow/package/lockfile/例外条件は変更していない。
- 仮データの実pageで320/375/1440px、4状態/ロール別の計21ケースをPlaywright確認。横はみ出しなし、GETで副作用なし、header認証送信、同じ開始の再送key、4C未完成の承認禁止を検査。実Shopify埋込み画面のOAuthや実店舗検証ではない。
- 画面確認用は `http://127.0.0.1:4179/`、`scripts/preview-international-runner.mjs` の仮データ専用server。CORSを無効にし、ファイル配信はworkspaceに制限、`.audit`/`.codex-temp`/env/鍵等を拒否する。ローカル生成証拠は `.audit/international-runner-preview/results.json` と同ディレクトリの画像、全体/audit試験ログ。Git管理外で他PCへ自動移動しない。既存 `.codex-temp` は変更していない。
- 初回候補 `07e58e4` の[Quality 38925734867](https://github.com/morixi4106/vendor-register/actions/runs/38925734867)、[独立PG 38925734847](https://github.com/morixi4106/vendor-register/actions/runs/38925734847)、[artifact 38925734657](https://github.com/morixi4106/vendor-register/actions/runs/38925734657)は全てSUCCESS。追加のquota期限切れ整理/未知intent境界を含む `d3dcbc57e69b7b33e542ac723ecfb2a5392b8d5f` の[Quality 38926215445](https://github.com/morixi4106/vendor-register/actions/runs/38926215445)、[独立PG 38926215774](https://github.com/morixi4106/vendor-register/actions/runs/38926215774)、[artifact 38926215682](https://github.com/morixi4106/vendor-register/actions/runs/38926215682)も全てSUCCESS。PG11+11+18/schema差分0、既存条件付きproduction auditとprebuilt77件も成功。
- ローカルPGは停止済み。一時初期化ディレクトリは残存し、本番データは含まれない。preview serverは仮データ確認用にloopbackで稼働。mainのpush/merge、本番migration、scope/Markets/通知設定、Shopify stage/release、実決済/返金、メール送信は行っていない。実scope不足による国内ガードの影響、AWAITING_ORDER、P01-P28、R06は未完了のまま。

## 更新ルール

1. 開始時にこのメモ、`git status`、対象worktreeと必要な個別手順を確認する。
2. 変更した項目の状態と残作業を更新し、確認日時、PR/CI、テスト、サービス側記録などの根拠を添える。
3. 「実装済み」「本番反映済み」「実画面確認済み」「実取引確認済み」を区別する。適用外は理由を記載する。
4. 中断時も、進行中の作業・未完了の検証・再開地点を記録する。完了していない作業のチェックを付けない。
5. 次に行う3つと直近の変更履歴を更新する。過去の日付の観測を現在の状態に見せない。
6. 秘密、受信コード、個人情報、決済明細、DBダンプは書かない。公開前にメールを再開しない。文書の更新だけでデプロイしない。

## 関連手順

- [本番公開チェックリスト](../production-go-live-checklist.md): 決済ごとの手順。すべての決済方法が現在の運営直販で必須とは限らない。
- [海外販売ゲート](../international-launch-gates.md): 国別・商品別・配送経路別の確認と反映順序。
- [Shopify中心の個人情報最小化](../shopify-centered-privacy.md): 残存データ、旧データ暗号化、実権限、Inbox、ロールバック。
- [自動保守](automated-maintenance.md): 自動化の追加条件。過去の計画と実稼働を混同せず、新しい通知停止方針を優先。
- [国内直販の限定承認](domestic-autonomous-launch-authorization-2026-09-29.md): 海外販売の包括承認ではない。
- [外部確認事項](../legal/prelaunch-external-checklist.md): 実際の販売範囲に応じて適用判断する。
- [実地確認の適用ロジック](../../app/services/operationalReadiness.server.js): 現在の販売方式で必須か補助かを判定。
- [残りの実装設計](remaining-implementation-design.md): 確認できたコード不足R01-R06、既存機能との区別、PRの順序。
- [商品別の海外購入制御と失効同期](international-checkout-sync-design.md): 第3弾R02/R03のデータ形式、同期状態、必要権限、期限、試験と反映順。
- [海外販売の実設定・承認・取引検証](international-release-verification-design.md): 後続4A-4Cのnative共通判定、初回検証の証拠発行、範囲承認、国/商品/通貨付き取引証拠。
- [国際販売の承認と検証証拠](international-authorization-design.md): 4Bの用途別承認、単回confirm、2モデル、信頼済みverifier、runner失効/閉鎖、実装3単位と4C依存。
- [国際販売のシステム証拠発行](international-proof-issuance-design.md): 4B-2の試験済みartifact、署名配備receipt、閉鎖専用run、専用発行/取消、期限と障害時の停止。
- [国際販売の管理操作と検証runner接続](international-runner-interface-design.md): 4B-3の用途別UI、専用認証/内部API、receipt配送と開始冪等性、観測競合、店舗別P03、受入試験。

## 直近の変更履歴

| 日付 | 内容 | 検証と残作業 |
| --- | --- | --- |
| 2026-10-17 | 4B-3の専用認証・配送・runner・管理画面をローカル実装 | 全体1272成功/skip7、PG計40件/schema差分0、画面21ケース、WASM77、build/runtime成功。下書きPR #57のCI3本成功、本番/4Cは未完了 |
| 2026-10-16 | 4B-3の管理画面・専用認証/配送・観測競合を設計 | 4B-2候補bc20c08の実コードを静的確認。文書のみローカル保存。3A/B/Cと4C・本番は未完了。有効化/通知ロックを維持 |
| 2026-10-16 | 4B-2を下書きPR #56へ実装しCI3本と実artifactを検証 | cc9ad9dのQuality/PG/artifact成功。Linux1264成功・skip3、PG各11/schema差分0、prebuilt77と実artifact全digest一致。本番/実key/4B-3/4Cは未完了 |
| 2026-10-16 | 4B-2の成果物固定・配備receipt・専用証拠発行/取消を設計 | 4B-1候補6ddc76cとCLI/公式仕様を確認。文書のみローカル更新。4B-2/3・4Cの実装、実配備/実取引は未完了。有効化/通知ロックを維持 |
| 2026-10-16 | 4B-1の単回承認・2モデル・永続停止を下書きPR #55へ実装 | 7ca46deのQuality checks 38900277480と独立PG 38900277332が成功。Linux1242成功・skip2、PG11成功、WASM77成功、production audit成功。4B-2/3・4C・本番は未完了 |
| 2026-10-16 | 4Bの単回承認・証拠発行・runner停止の詳細設計を作成 | 既存コード/CIと公式artifact・App Version仕様を確認。文書のみローカル更新、4B/4Cは未実装。次は4B-1、4C不在時の有効化は禁止 |
| 2026-10-16 | 4Aのnative共通判定と国内例外/監視/probeへの接続候補をPR #54へ実装 | 5a0d632のverify 38893113799成功、Linux1232件成功・既存skip1、Function/隔離runtime/production audit成功。4B/4C・R06・本番反映は未完了 |
| 2026-10-16 | 後続4A-4Cの詳細設計を作成 | コードと公式2026-04仕様を確認。文書のみローカル保存、コード/schema/本番は未変更。実装・R06・外部証拠は未完了 |
| 2026-10-16 | 第3弾R02とR03基盤を実装し下書きPR #53作成 | 実装cc8276eのverify 38884464961成功、全体1200成功・既存skip1、WASM77成功。資源上限とJSONB正規化も検査。R03の残る接続・R05/R06・本番反映は未完了 |
| 2026-10-15 | 第3弾R02/R03の詳細設計を作成 | コードと公式2026-04仕様を確認し文書のみローカル保存。商品×国の強制、停止後同期、2つの同期モデル、必要scopeと試験を設計。追加実装・本番操作なし |
| 2026-10-15 | 第2弾のR01・R04を実装しPR #52作成 | ローカル1157件成功・既存skip4、verify 38728474501成功。販売範囲の共通判定と国際操作認可。本番未反映、R02/R03/R05/R06と外部証拠は残る |
| 2026-10-15 | 残実装R01-R06の設計を静的なコード確認から作成 | 文書のみローカル保存。追加実装・本番再監査・設定・決済・通知送信なし。実証跡の完了状態は変更なし |
| 2026-10-15 | PR #51を作成し、実装コミット0805dbfのCIを確認 | verify 38717321565成功。引き継ぎもGitHubへ保存。本番反映・商品/国/配送の実確認は未実施 |
| 2026-10-15 | 第1段階をローカル実装。経路設定・証跡・国内例外・海外未確認と監視通知を分離し、次の最大3作業を表示 | 1139テスト成功・既存skip4件、lint・architecture・build・12パターンの画面検証成功。本番未反映、P01-P28の実証跡は完了に変更していない |
| 2026-10-15 | 既存の公開判定・証拠・画面・海外ゲートを読み、3段階の実行設計と最初の実装範囲を作成 | 静的確認と文書更新のみ。実装・本番再監査・設定変更・実取引・公開は未実施。P01-P28の状態変更なし |
| 2026-10-15 | PR #50で公開前の監視通知を抑止し、本番Web・監視Cronへ反映 | 実行とCI成功。販売条件は未完了のまま。通知再開なし |
| 2026-10-15 | 公開作業28項目を整理し、このメモとCodex向け入口を作成 | ドキュメント変更のみ。本番状態の再監査・設定変更・実決済・公開は行っていない |
