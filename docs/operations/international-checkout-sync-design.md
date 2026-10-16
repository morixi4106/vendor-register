# 商品別の海外購入制御と失効同期

作成日: 2026-10-15 JST

## 実装状況 2026-10-16

R02とR03の永続同期基盤を[下書きPR #53](https://github.com/morixi4106/vendor-register/pull/53)へ実装。cc8276eのCIは成功。現在地は[進捗メモ](launch-progress.md)の第3弾を参照。以下の本文は当初設計で、次の実装上の差異・残作業を優先する。

- Function queryは上限コスト30。商品区分は一般projection内のroutingClassから読み、重複metafieldを要求しない。GBは郵便番号でNIを拒否し、不明なら拒否。provinceは要求しない。
- 行数200に加え、一般/国際projectionの累積10,000文字をJSON解析前の作業上限とする。実行上限を超えるカートを許可せず分割案内する。大きい入力のWASM拒否と異なる12商品の許可を資源上限内で試験する。200行の一律購入保証ではない。
- 初期native読取りは最大10ページのMarket/配送profile。内側は国250、profile商品25/variant10、配送group5/zone5/method10の範囲を読み、続きがあれば未確認。複合Market条件、条件付き送料、selling plan、分割profile等も未確認。対象商品の実variantが単一の物販かを別読取りで照合する。大規模/未対応構成には検査拡張が必要で、自動許可しない。
- 状態・ジョブの2モデルに加え、既存の市場証拠と配送受付にrevisionを追加。同一ミリ秒の取消も旧フォームで上書きできないようにする。
- 同期要求はRELEASE_MANAGER、証拠登録/取消はCOMPLIANCE_REVIEWER、明示停止はINCIDENT_COMMANDER。既定DISABLEDのまま。内部の範囲承認関数は存在するが、国際リリース証拠の実発行と有効化UIはR05への接続が残る。
- 公開前チェックと監視の海外構成には読取り検査を接続。国内限定例外へのnative実設定の接続は残作業であり、アプリDBの海外0件からShopifyも国内限定とは証明しない。
- migration、backend、Functionを本番へ反映していない。既存の期限日・稼働版の観測は更新せず、独立監査・実PostgreSQL競合・実チェックアウト/決済は未確認。

対象は残実装R02・R03。既存の適格性評価をShopifyの購入判定へ接続し、取消・失効後に古い許可が残る問題を防ぐ。設計のみで、アプリコード、schema、本番設定、Shopify releaseは変更していない。

## 決定事項

1. 海外注文は、全店の許可国と各商品の許可国の両方で判定する。どちらかが不明・失効・未反映なら受け付けない。
2. 許可データの世代を揃える。海外停止を読戻し確認してから商品を更新し、全件を確認した後に全店の許可を公開する。国内用の許可データは別に保つ。
3. 変更と同期要求を同じDBトランザクションに残し、既存のカタログ同期で再試行する。閲覧・監視の読取りから修復や許可の更新を実行しない。

この順序では、更新中に海外販売全体を短時間停止する場合がある。初期実装では部分更新中の誤許可防止を優先し、停止範囲を細分化する別エンジンは作らない。Function実行失敗や既存の全体緊急停止では国内にも影響し得る。

## 確認した前提

- PR #52のローカルHEADは `2971869`。R01/R04を実装済みで、R02/R03は未実装。新しい本番監査はしていない。
- Admin APIとFunctionはともに `2026-04`。APIバージョンや依存パッケージをこの変更に紛れて更新しない。
- 現在のFunctionは全店の `international_sale_gate` と一般の商品適格性を検査し、商品別の国許可は入力に含まない。
- `SaleEligibilityProjection` と履歴は既に商品・国・販売チャネル単位のキーとrevisionを持つ。これを再利用する。
- 現行schemaには `buyerJourney.step`、配送グループの `cartLines`、商品variantの `requiresShipping` がある。対応するAPI仕様も確認した。[Validation API 2026-04](https://shopify.dev/docs/api/functions/2026-04/cart-and-checkout-validation)
- 現行のprojection TTLは26時間、カタログ同期の既定間隔は15分、重大な鮮度超過は180分。これはコードの既定値であり、実環境のCron間隔や環境変数の実値の証明ではない。

## 商品と国の判定

### 正本と評価

正本は既存のProduct、ProductCountryPolicy、商品審査、回収状態、ComplianceEvidence/Decision/Requirement、国別の運用証拠、配送受付状態。国の候補は明示した海外allowlistのみとし、空欄を全世界許可にしない。

今回の海外対象は配送が必要な物販。デジタル商品・継続課金等を国際許可へ自動追加しない。

各商品と候補国について `evaluateSaleEligibilitySnapshot` を使う。さらに既存の市場証拠・配送証拠・税関プロフィール・発送条件の評価を組み合わせる。既存の国別評価が判定しない条件を無視したり、条件式を別のエンジンへ複製したりしない。

`LEGACY_REVIEW_REQUIRED` は海外許可にしない。海外は商品側の `ELIGIBLE` と必要な証拠がすべて有効な組合せだけとする。回収、禁止国、失効した要件、未承認店舗・商品は拒否する。第三者販売フラグはOFFのまま。

読取り検査は純粋な評価を呼ぶ。`evaluateSaleEligibility` は既定で `persist=true` のため、画面や監視から無指定で呼ばない。国別projectionの永続化と履歴追加は変更処理・同期workerの担当とする。

### Shopifyへ渡す値

既存の商品 `sale_eligibility_projection` は国内用として維持し、app所有の商品metafield `international_sale_eligibility` を追加する。全店ゲートは次の互換性境界としてv2にする。

| 値 | 内容 |
| --- | --- |
| 商品側 | schema/policy version、Shopify商品ID、同期世代、商品revision、許可国集合、評価日、有効期限の排他日付、内容hash |
| 全店側 | schema/policy version、同期世代、状態 `PREPARING` / `ACTIVE` / `BLOCKED`、許可国集合、評価日、有効期限の排他日付、内容hash |
| DB側だけ | 判定理由、使用した証拠/要件/決定のIDとversion、正確な期限、source hash、同期対象のmanifestと読戻し結果 |

国集合はソート・重複排除し、未知の国コードやschemaを拒否する。商品IDと同期世代はFunction入力の実商品・全店値と照合する。hashは内容照合用であり、認証や署名の代わりではない。証拠本文、購入者情報、確認者メールはShopifyへ転記しない。

Functionではhashの書式だけをもって承認にしない。app所有metafieldの書込み制限、商品/世代/国/期限と既存の停止を合わせて検査し、backendの読戻しで内容hashと期待値を照合する。アプリの書込み資格情報そのものを奪われた場合の改ざんまで、このhashで防げるとは扱わない。

### Functionの順序

1. 既存の全体停止、独立Watchdog停止、限定公開制御、一般の商品適格性検査を維持する。
2. `buyerJourney.step` と配送が必要な商品行を確認する。カート操作中の住所未入力だけでは国内外を断定しない。注文確定時には、配送が必要な行の配送先・所属グループが不明なら拒否する。段階自体が不明な入力を合格にしない。
3. グループ内の商品行IDをcart行へ照合し、配送先ごとに判定する。国情報が一部欠けたグループ、未照合の行、途中で切れたリスト、未対応の商品種別を許可扱いにしない。対応が確認できない入力は保守的な全商品×全海外配送先の検査、または拒否とし、検査を省略しない。
4. 日本宛てには国際metafieldを要求しない。海外宛てには全店 `ACTIVE`、配送国の許可、商品側の配送国許可、同一世代、商品ID一致、期限内をすべて要求する。
5. GBは既存の北アイルランド拒否を維持する。判別に必要な情報が欠けたGB宛てを「GBなので許可」としない。

既存の200行上限を広げない。グループ数・国数・JSONサイズ・総走査量にも上限を設け、上限超過は拒否する。実際に扱える入力量はWASMの最大ケース試験で決め、200行ならどんな入力も動くとは約束しない。氏名・詳細住所・メールは入力queryへ追加せず、北アイルランド判定に使う州/郵便番号も新たに保存・ログ出力しない。

無料配送、手動送料、別Carrier Serviceでも同じValidation内で国許可を検査する。ただし注文作成API、注文編集、POS、継続課金等、Function非対応の経路まで防げたとは扱わない。P03で無効化・権限・運用を別途確認する。[対応する販売経路](https://shopify.dev/docs/api/functions/2026-04/cart-and-checkout-validation)

## 期限の扱い

有効期限は、使用した国別証拠・配送確認の期限、商品証拠/判定/要件の期限や再審査日、国別projectionの期限の最小値とする。使用していない古い証拠まで一律に最小値へ混ぜない。不正な日時を無期限扱いにしない。

Functionで現在参照しているのは店舗タイムゾーンの日付。UTCの `toISOString().slice(0, 10)` をそのまま排他期限として比較する方式は改め、読取り済みの店舗IANAタイムゾーンで期限日を決める。排他日の開始時刻が実期限を越えないよう切り下げ、当日の残り時間を許可として足さない。タイムゾーン不明・不正・変更検出時は海外許可を更新しない。

公開中の店舗タイムゾーン変更は禁止する運用とし、変更が必要なら海外停止後に全件を再同期する。Functionの日付だけでは管理画面側の無断変更を瞬時に検知できないため、設定検査までの窓も残る。実期限を越えない境界は、読取り済みタイムゾーンが維持される前提で試験する。

この方式では実際の期限より前、期限日の開始時点で停止し得る。日付比較だけで分単位の鮮度保証があるとは言わない。既存の独立監視による鮮度停止も残すが、Cron停止・遅延時の即時取消を保証しない。

分単位のFunction期限判定はこの初期変更へ必須追加しない。公式には `dateTimeBefore` と入力変数を利用できるが、現在の入力変数ガイドはCLI 4.9以降を要件とし、本repoは4.5.2。導入する場合はValidation所有の設定metafield・ツールチェーン・既存のビルド例外を別途検査する。店舗metafieldへ日時を書くだけで動的引数として使えると仮定しない。[日時比較](https://shopify.dev/docs/api/functions/2026-04/cart-and-checkout-validation)、[入力変数と所有者](https://shopify.dev/docs/apps/build/functions/input-queries/use-variables-input-queries)

## 同期の永続化

### 追加するDB

既存の国別projectionと履歴は残し、同期制御用に2モデルを追加する案とする。migrationは後続実装で作成し、この設計では適用しない。

| モデル案 | 主な情報と制約 |
| --- | --- |
| `InternationalGateSyncState` | shop単位。modeは既定 `DISABLED`、承認済み商品×国集合の参照/hashとrelease binding、desired/applied generation、phase、snapshot作成完了、期待/反映hash、期待対象件数、最終読戻し時刻、次の期限。generationはDBで単調増加し、上限超過で停止 |
| `InternationalGateSyncJob` | shop、generation、対象種別 `RECONCILE` / `PRODUCT` / `SHOP`、対象ID、immutableな最小projection/参照manifest、期待hash、状態、試行数、nextAttemptAt、lease token/期限、verifiedAt、秘匿済みerror code。対象とgenerationの組合せを一意にする |

1つ目は「最新の要求と全体の反映状況」、2つ目は「個々の作業と再試行」を担当する。`ShopifyProductSyncIssue` やメールOutboxへ意味の違うジョブを詰め込まない。個人情報・資格情報・証拠ファイルは保存しない。

既定modeでは新しいShopify書込みを実行しない。観測と許可反映を区別し、RELEASE_MANAGERの明示操作と現在の購入制御・証拠・releaseの検査を満たした場合だけ同期をarmする。現在の「同期」操作や証拠登録を、無言で海外販売の有効化操作へ変更しない。緊急停止の復旧承認も同期modeとは別。

arm時に運営が承認した商品×国の上限を固定する。通常更新・期限前の更新はその範囲内だけを対象にし、証拠が追加されただけで新しい商品/国を公開しない。範囲拡大にはRELEASE_MANAGERの明示承認を要求する。取消・許可縮小はこの承認待ちにしない。緊急停止や回収等の解除は既存の復旧条件を満たすまで再許可しない。

### 変更要求

対象は `saveInternationalMarketEvidence` / `revokeInternationalMarketEvidence`、配送受付更新、`saveProductCountryPolicy`、商品審査/回収/適合証拠/適合判定と要件versionの変更、商品削除・Shopifyリンク変更。下位serviceの正式な書込み入口へ接続し、画面actionだけに依存しない。

変更のDBトランザクションで証拠等の更新、desired generationの増加、RECONCILE要求を一緒に確定する。workerは最新世代の整合したDBスナップショットから対象ジョブを作り、manifestとsnapshot完了を同じトランザクションに残す。対象列挙を途中で止めても「全件生成済み」にしない。

フォームには更新元versionを渡し、古い証拠の再保存で新しい取消を上書きする操作は409にする。全更新経路で同じversion検査を使い、確認者はR04の認証済みactorを維持する。

### 反映手順

1. **停止**: 最新世代の全店ゲートを `PREPARING` または `BLOCKED`、海外許可国なしでCAS書込みし、読戻す。取消・回収・配送停止はこの処理を優先し、全商品評価より先に停止を試す。
2. **商品反映**: 最新のmanifestにある商品の国別projectionを小分けに書き、商品ID・世代・内容・期限を読戻す。許可解除や対象から外れた商品にも拒否値を書き、削除済みIDを黙って成功件数へ足さない。
3. **許可公開**: 全対象の確認後に、入力証拠・desired generation・Function稼働版・Markets/配送設定を再確認する。一致時だけ同じ世代の全店ゲートを `ACTIVE` とし読戻す。DBのapplied generationはその後に確定する。

同じ内容は無駄に書き換えず、時刻だけのポーリングで新世代を増やさない。有効期限更新が必要な場合も同じ手順を使う。証拠を同期時刻で再確認済みにしたり、期限を自動延長したりしない。

ShopifyのCASには `compareDigest` を常に付ける。作成時も `null` で「存在しないこと」を条件にする。APIの一括書込みは最大25metafieldsで、原子性はその1リクエスト内だけ。全カタログを一括トランザクションにできるとは仮定しない。[metafield更新の仕様](https://shopify.dev/docs/api/admin-graphql/2026-04/objects/Metafield)

### 競合と再試行

- 書込み前の順序はShopify現在値の読取り、DBの最新世代・有効なlease・証拠version確認、CAS。書込み後にも読戻しとDB世代を再確認する。古いworkerが新しいdigestを取得しただけで古い許可を書ける経路を作らない。
- 旧世代は `SUPERSEDED`。新しい停止後に古い許可ジョブを再試行しない。lease失効後の旧workerはDB完了を確定できない。世代を含む拒否値で、見かけ上同じ停止値への書戻し競合も識別する。
- ネットワーク断・429・一時的5xx・読戻し失敗は上限付きbackoffで再試行し、Retry-Afterを尊重。承認取消や未知schema、scope不足は許可再試行で突破せず `NEEDS_REVIEW` とする。
- 既存カタログ同期の各実行で、取消系、期限接近、許可追加の順に、時間/件数/APIコスト予算内で処理する。カタログ同期本体が失敗しても、可能なら停止系キューを先に処理する。新しい有料Cronや通知専用workerは作らない。
- 変更後は短い時間予算で停止反映をawaitする。失敗しても要求はDBに残る。サーバー終了で消える未awaitのバックグラウンド処理へ頼らない。

DBとShopifyをまたぐ原子的な取消はできない。DB受付直後からShopify反映までの窓は残るため、API応答と画面では「取消受付」と「Shopify停止確認」を区別する。停止を書けない場合は未保護として扱い、既存の緊急停止/独立Watchdogへ連携する。国内も止める全体停止を使う場合はその影響を表示し、自動復旧はしない。

## 読戻し検査

`inspectInternationalCheckoutGate` 相当を共通の読取りserviceとして追加し、公開前チェックと監視で共用する。DBの既定値や最後の成功記録だけで現在の実値を代用しない。

| 検査 | 判定すること |
| --- | --- |
| 許可データ | shop/商品ID、schema/policy、世代、正規化した国集合、内容hash、日付期限、DBの期待値とShopify実値の一致 |
| 同期 | manifest作成完了、対象全件の読戻し、未反映の取消・失敗・期限超過、対象から外れた商品の拒否 |
| 実行系 | 有効なValidation、期待するFunction/App version、実行失敗時拒否、既存の停止値 |
| Markets | 対象国と市場状態等、取得できた設定の一致。現在の設定ファイルには `read_markets` がないため、実付与scopeを再確認し、必要なら別承認で読取り権限だけ追加 |
| 配送 | 対象商品の配送プロファイルID、国/地域、手動・無料送料、別Carrier Service/プロファイル等の取得範囲。現行 `read_shipping` 設定を利用し、実付与scopeとAPIの検査可能範囲を確認 |

Marketsの読取りには `read_markets` が必要。`write_markets` や顧客読取り権限はこの検査のために追加しない。[Markets API](https://shopify.dev/docs/api/admin-graphql/2026-04/queries/markets)

GraphQLの部分エラー、ページング未完了、上限で打ち切った列挙、権限不足、対象不明は未確認。配送実設定の照合で読めない範囲をチェックボックスだけでドリフトなしとしない。実送料・税額・配送可否・決済通貨の通し確認はR05/P02/P11/P22へ残す。

国内のみの構成では海外準備を未設定として表示し、これだけで国内向けの新しい必須条件を増やさない。海外構成では上記の未確認を公開ブロッカーにする。`protected`（停止確認済み）と `ready`（許可反映・条件一致）を別の値で返す。

ただし、DBの海外対象0件だけでShopifyも国内限定と断定しない。Markets実値または有効な設定確認証拠で国内限定と確認した構成と、実設定が不明な構成を分ける。後者を国内限定例外で「海外設定確認済み」へ変換しない。R01の共通判定にもR03の実値確認結果を接続する。

状態表示は「未設定」「同期待ち」「海外停止確認済み」「反映中」「反映一致」「不一致」「確認不能」。証拠が失効した状態を、停止処理の成功だけで販売準備完了へ変更しない。

## 実装の分担

| 担当 | 変更先の候補 |
| --- | --- |
| 商品別projectionの組立て | 新しい小さな `internationalProductProjection` モジュール。`saleEligibility.server.js` の評価/履歴を再利用 |
| shop/商品metafieldの読書き | `internationalSaleGate.server.js` と新しい国際同期モジュール。`marketplaceCheckoutGate.server.js` の既存CAS/公開境界を壊さない |
| workerと永続状態 | 新しい `internationalGateSync.server.js` とPrisma migration。低層の判定・同期から大きな `operationalReadiness.server.js` をimportしない |
| 更新要求の登録 | 市場証拠、配送受付、商品国ポリシー、商品審査/適合・回収の各正式service |
| 定期実行と検査 | `internal.shopify-product-catalog-sync.jsx`、公開前チェック、launch monitor、必要な独立Watchdogの検査 |
| 購入時の拒否 | Functionのinput query、generated types、国際判定、fixtures。国内の現行projectionは維持 |

既存のファイル行数制限とfacade契約を維持し、この設計を理由に上限を増やさない。

## 受入試験

| 群 | 必須ケース |
| --- | --- |
| 商品と国 | AはFR可/BはFR不可の同一カート、国内専用品混在、FR/USの複数グループ、同一商品が複数グループ、禁止国優先、回収、第三者/テスト商品 |
| 入力境界 | 欠落・不正JSON・未知version・商品ID/世代不一致、読戻しでの内容hash不一致、住所未入力の各journey段階、グループ欠落/一部欠損、北アイルランドとGB判別不能、上限超過 |
| 期限 | 正確な期限と店舗排他日付、日付境界、UTC正負タイムゾーン、DST、タイムゾーン変更、不正日時、外部証拠を更新しない日次再評価 |
| 競合 | revoke対grant、古いフォーム対新しい取消、二重起動、lease切れ、CAS競合、旧workerの遅延完了、反映後のDB変更、HTTP応答消失と再実行 |
| 部分障害 | DB受付後クラッシュ、商品途中で失敗、読戻し不一致、429/5xx、scope不足、商品削除、検査のページ打切り、Cron停止。停止未確認を保護済みにしない |
| 運用 | 国内注文の回帰、無料/手動/別配送経路、Web閲覧による書込みなし、権限別操作、証拠追加で承認範囲が増えないこと、prelaunch通知なし、個人情報/秘密を含まないログ |

初期実装はR02/R03を同じ第3弾PRで通し、CIでFunction/WASM・アプリ・隔離runtime・production auditを確認する。実店舗側での遮断確認や国際実取引は、合成データの成功で代用せずR05へ接続する。

## 本番への反映順

1. PR #51/#52を土台に第3弾を実装・CIまで進める。migration、metafield/schema、必要scopeの差分を明示する。ここではmainへマージしない。
2. 本番反映の承認後、海外停止を維持したまま追加migrationとbackend、Function候補と新しいmanifest、読取り権限を順に確認。DB初期状態と旧v1/新v2の混在は海外許可にしない。旧Functionや旧backendへ単に戻して国際制御を解除しない。
3. 対象国・商品・外部証拠が揃い、読戻しと遮断試験を終えた範囲のみ、承認された操作で同期をarmしてMarkets等を有効化する。R05の国際取引確認とR06の通知ACKは別途完了させる。サイト公開を理由に監視メールを自動再開しない。

2026-10-15の設計作成時は文書保存のみ。2026-10-16に追加した実装の範囲と残作業は冒頭の実装状況を参照する。migrationの本番適用、scope追加、Shopify書込み、決済、返金、メール送信は行っていない。
