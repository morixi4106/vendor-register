# 海外販売の実設定・承認・取引検証の設計

作成日: 2026-10-16 JST

状態: **4A/4Bは候補CI成功。4C-1はローカル候補実装・検証済み、4C-2/3と本番は未完了**。当初設計の基準は `156f393`、第3弾の実装は `cc8276e`。本番状態は再監査していない。最新のPR/CIと最後の本番観測は[進捗メモ](launch-progress.md)を参照する。

4Bの単回承認は[承認の詳細設計](international-authorization-design.md)、4B-2の候補実装は[システム証拠発行設計](international-proof-issuance-design.md)を参照する。後者は試験済み成果物と配備receipt、初回閉鎖検査、専用発行/取消を追加した。本番未反映で、4C不在時の有効化拒否は維持する。

2026-10-17追記: 4B-3の契約は[管理操作/runner設計](international-runner-interface-design.md)、4Cの具体的な実装仕様は[国際購入の通し検証設計](international-checkout-verification-design.md)を正本とする。以下の実装状況は各段階の履歴を含む。4Cは通貨/対象契約、非課金runner/正常閉鎖、金融照合/最終proofの3単位とし、実証拠なしでcapabilityを解除しない。

## 4Aの実装状況 2026-10-16

- `agent/checkout-native-scope` に共通native棚卸し、DB/nativeの合成判定と接続を追加。認証済み/既存の対象shopを明示し、DBの商品検査も同じshopへ限定する。
- 国範囲の軽量queryは商品/variant・送料条件・Validationを読まず、国内の条件付き送料を理由に国範囲の完全性を失わない。海外の詳細検査は既存の制約を維持する。native集合のhashは返却順序を正規化した。
- 共通scopeのhashは軽量queryで取得した国・市場通貨・profile構成の範囲を示す。送料額/provider/商品所属を含む販売承認用のhashは、引き続き詳細検査で作る。軽量hashを完全な配送監査として使わない。
- 読取りsessionは処理内だけで重複取得を共有し、native読取りは全体15秒/1要求最大10秒、root最大10ページ、内側の取得上限を維持。途中取得の海外検出を保持し、未取得部分を国内扱いにしない。独立DB読取り等の全処理が15秒で終わる保証ではない。
- readiness・監視・国内ガード・新規probe・paid-only完了・Validation無効化へ接続。軽い監視でもscopeは再取得し、古い国内合格結果で上書きしない。取引probe画面と国内ガード内では同じ処理のscope結果を共有する。
- 既存strict flowの支払/返金の照合や注文取込みは、native取得不能だけでは停止しない。新規probe開始と国内例外の使用は確認完了を要求し、過去の金融履歴を現在の販売許可としない。
- ローカル全体1233件中1229成功・既存Windows依存skip4件、Function/WASM77件成功。lint・text・architecture・アプリbuildも成功。scope付与、native実店舗の取得、本番反映、4B/4Cは未実施。
- [下書きPR #54](https://github.com/morixi4106/vendor-register/pull/54)、実装 `5a0d632` の[CI 38893113799](https://github.com/morixi4106/vendor-register/actions/runs/38893113799)はSUCCESS。Linux1232件成功・既存skip1、Function/拡張/アプリbuild、隔離runtime、既存の条件付き審査に従うproduction auditも成功。mainへは未反映。
- **反映前の注意**: 実付与 `read_markets`/配送読取り権限が足りなければ国内例外も未確認になる。有効な国内自動公開ガードがあれば既存の停止経路へ進み得るため、main反映前にscope承認・実値・停止影響を別途確認する。この実装から権限を追加しない。

対象はR03の残る接続とR05。商品適格性・証拠・世代付き同期は作り直さない。この文書は公開、Shopify release、scope追加、海外有効化、実決済・返金、メール送信の承認ではない。

## 次の3段階

1. **4A: 実設定による販売範囲の共通判定**。Shopify側に海外設定がある場合や取得不能の場合、国内限定例外へ入れない。
2. **4B: リリース証拠と範囲承認**。検証用と一般販売用を分け、実行結果から証拠を発行し、対象商品・国・通貨を明示承認する。
3. **4C: 国際取引の照合**。国、商品、購入者通貨、決済、台帳、返金とリリースを束縛し、国内注文の成功を海外へ流用しない。

R06の予備通知ACKは別の小さな変更に分ける。公開前通知の抑止は維持し、4A-4Cの完了やサイト公開から自動解除しない。第4弾へR05/R06をまとめる当初案より、残るR03の接続を先に完成させる順序を優先する。

## コードで確認した不足

| 箇所 | 現状 | 今回の設計で補うこと |
| --- | --- | --- |
| `checkoutCommerceContext.server.js` | アプリDBの配送検査から国内外を判定 | ShopifyのMarkets・全配送プロファイルの読取りを追加。DBの海外0件だけでは国内限定にしない |
| `internationalNativeConfiguration.server.js` | 詳細検査とValidation検査が一体。部分取得・未対応構造は未確認 | 販売範囲だけの検査と、海外経路の詳細検査を分離し、国内に海外用証拠を要求しない |
| `internationalGateAuthorization.server.js` | 証拠を読む内部関数と範囲承認関数はある | 証拠発行、承認プレビュー、単回承認、停止後の復旧を接続 |
| `internationalCheckoutInspection.server.js` | 停止確認にも最終リリース証拠を要求 | 検証前でも確認できる配備・停止の証拠と、一般販売可能の証拠を分ける |
| 既存のlive probe | 署名challengeとフォームの結果を扱う | 署名は対象の束縛であり実行証明ではない。国際版は検証runnerの実測結果を正本にする |
| `productionTransactionProbe.server.js` | 注文国を取得せず、主に `shopMoney` を照合 | 配送国と `presentmentMoney` を追加し、通貨別に照合 |
| 国際Function | 商品×国は制限するが、国際ゲートに許可通貨がない | 試験した通貨だけを許可する。既存queryの通貨フィールドを再利用 |

これらは未実装の接続であり、P01-P28の外部証拠が揃ったという意味ではない。既存の未紐付け `AWAITING_ORDER` も維持する。

## 4A 販売範囲の共通判定

### 判定入力と結果

`inspectCheckoutCommerceContext` の入力へ明示した `shopDomain` と依存注入可能なnative検査を追加する。呼出側の認証済みsessionまたは既存の対象shop解決から渡し、クライアント入力や不明な環境変数から別店舗を選ばせない。

結果は既存の `mode` と `shippingProfiles` を維持し、次の安全な集計DTOを追加する。

- `scopeStatus`: `DOMESTIC_ONLY` / `INTERNATIONAL` / `UNKNOWN`。
- `available`、`observedAt`、`nativeConfigHash`、DB/nativeそれぞれの確認可否、固定のreason code。
- 海外設定を少なくとも1つ検出したか、棚卸しが完了したかを別々に持つ。途中で海外設定を見つけた後に取得失敗しても、国内限定へ戻さない。

国内限定が確認済みとなるのは、DB検査とnative検査の両方が完了し、どちらにも海外設定がない場合のみ。DB/nativeの片方でも海外設定を検出したら国内例外を拒否する。取得途中・権限不足・未知構造は `UNKNOWN` で、海外がないという否定の証明には使わない。

nativeの販売範囲検査では有効なMarketsの国条件と、全配送プロファイルの配送国・全世界指定を調べる。市場と送料の両方が揃う場合だけでなく、片方だけ海外設定が残る場合も保守的に海外構成として扱う。国内限定の判断に、海外商品の法務証拠や有効な海外Validationは不要。

### 詳細検査との分離

- 既存のMarkets/配送取得と評価を小さな共通モジュールへ分ける。国内限定の棚卸しに、全商品のvariant・海外のroute audit・有効なFunctionまで要求しない。
- 範囲の判定に不要な `profileItems` の件数や条件付き送料の価格式を理由に、国内国一覧の完全性まで未確認にしない。ただし国条件自体を展開できない構造、全世界指定、途中で切れた国/zone一覧は未確認または海外ありとする。
- 海外の承認・反映には、既存の対象商品variant、profile所属、送料条件、配送証拠まで含む厳しい詳細検査を使う。未対応構成を許可するために制限を外さない。必要な構成が実在した場合だけページング/型対応を追加する。
- 正規化してソートした実設定をhash化する。API返却順序だけでドリフトにせず、実際の国・通貨・送料・provider等の変化は検出する。
- 読取りには上限・Abort timeout・全体予算を設ける。接続が最後まで読めたかを明示し、上限到達を成功にしない。GETはDB/Shopifyへ修復を書かない。

`read_markets` 等が実付与されていなければ未確認とする。scope追加は別の承認・Shopify反映・実付与確認が必要。手動のスクリーンショットや「国内のみ」のチェックボックスを、live棚卸しの代替として `available=true` にしない。

### 接続先と操作上の注意

本番前チェック、監視、実地証拠の適用、国内自動公開ガード、probeの開始/完了/過去合格再利用、Validation無効化に同じcontextを渡す。1回の処理ではnative結果を共有し、同じAPIの重複取得を避ける。次のactionやCronでは再読取りし、過去の成功cacheへフォールバックしない。

引数なしの `inspectPlatformDirectCheckoutMode(env)` は設定の希望を読む用途だけに残す。公開許可や検査省略の根拠には使わない。ただし注文の取込み、返金、既存の停止処理まで外部APIの可用性に依存させない。取引記録は継続し、購入許可と封じ込めの判断を分ける。

販売範囲の取得不能だけでValidationを自動有効化/無効化したり、全店停止をGETから実行したりしない。停止が必要な場合は既存の明示的な統制経路を使う。設定上の `effectiveMode` が検証付きになっても、実際のFunction稼働確認とは表示を分ける。

## 4B 証拠発行と承認

2026-10-16に[承認と検証証拠の詳細設計](international-authorization-design.md)を追加し、4B-1の単回承認/永続停止を候補実装した。2モデル、transaction、runner lease/停止、CI artifact/配備記録の信頼境界、用途別復旧、4C未実装時のロックはそちらを仕様とする。以下は全体方針であり、4B-2/3の証拠発行とUIは未実装。

### 証拠を2段階に分ける

| 証拠 | 確認するもの | 許可しないもの |
| --- | --- | --- |
| 配備・検証開始用証拠 `INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED` | 成功したCI artifact、承認された配備記録、対象shopのValidation/Function/input query、海外閉鎖値の読戻し、別管理する未対応販売経路の証拠 | 一般販売、実決済、法務適合の自己認定 |
| 一般販売用証拠 `INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED` | 上記に加え、対象店舗での国際シナリオ実測と4Cの対象別取引証拠 | 別国・別通貨・別releaseへの流用、第三者販売 |

現在の `inspectInternationalGateRelease` を用途別に分離する。閉鎖値の反映/読戻しは最終販売証拠を待たずに試みるが、`protected=true` には検証できた配備と有効なfail-closed Validationを必要とする。実際の閉鎖値だけで停止を保証したと扱わない。

配備証拠は、CIで生成したFunction WASM/query/schema/policyのdigest、repo/workflow/run/head、Shopify配備・release記録と対象version IDを結び付ける。環境変数のapp versionとWASM hashを入力しただけでは発行しない。

信頼済みverifierが固定repo/workflowの成功実行とartifactを取得・照合する。ブラウザから渡したURLの任意fetch、任意JSONの `passed=true`、署名済みchallengeだけの提出は禁止。fork/未承認featureのCIは候補の検査には使えるが、本番配備の承認や保護された反映経路の代わりにしない。配備物の再buildは、同一digestを確認できなければ別物とする。

Shopify App Versionは設定・拡張のスナップショットで、反映には時間差があり得る。versionの環境変数だけで実店舗への反映を即断しない。[ShopifyのApp Version仕様](https://shopify.dev/docs/apps/launch/deployment/app-versions)

Admin APIから稼働WASMのdigestを直接取得できるとは仮定しない。配備記録・artifact provenanceと実店舗での振る舞いを合わせた証拠であり、遠隔実行環境の暗号学的attestationとは呼ばない。配備記録が取得できなければ未確認のまま残す。

### 初回の循環を解く手順

1. 海外閉鎖のまま、CI/WASMと隔離したテスト店舗で許可・拒否・取消を検証し、配備証拠を確認する。テスト店舗の成功を本番店舗の成功へ移さない。
2. 非公開が実確認できる本番店舗に対し、RELEASE_MANAGERが対象商品×国×通貨と期限を指定した **`VERIFY` 承認**を行う。候補は全て通常の適格性・市場/配送証拠を満たすものに限る。未確認の法務条件を試験目的で飛ばさない。
3. 既存の閉鎖後同期でその最小範囲だけを有効化し、実店舗の非課金シナリオを実行する。試験後は閉鎖を要求して読戻し、一般販売へ自動移行しない。一般販売は最終証拠の成立後、別の **`SALE` 承認**で行う。

`VERIFY` は海外を開ける実操作であり、コード実装の承認には含めない。既存Functionの `ACTIVE` と通常の適格性評価を使い、試験者を無条件許可するバイパスや新しい公開フラグを作らない。ストアのパスワードを持つ他者まで識別して排除できる仕組みではないため、完全な試験者隔離とは保証しない。非公開を確認できない場合は本番VERIFYを開始しない。

VERIFYの承認期限は最大48時間と、使用証拠/配備証拠の期限の最小値。Shopify店舗日付による既存の切下げを維持し、previewには実際に許可できる排他期限を表示する。今日のうちに失効する等で有効な期間を作れなければ開始しない。分単位の自動停止保証はせず、runnerの終了処理とCronの再試行で閉鎖を追跡する。

ブラウザrunnerはHTTP要求内で起動したままにせず、認証済みの専用実行コマンドから起動する。既存Cronは期限超過の停止・未完了の検出だけを担う。runnerクラッシュ後に自動でVERIFYを再承認しない。

実決済が必要なら、非課金検証と閉鎖を終えた後に、金額・注文数・期限・返金範囲を別承認した実取引用VERIFYを作る。非課金runnerは支払確定の直前で必ず止まり、カード情報を入力・保存しない。

RELEASE_MANAGERによるゲート承認を金融操作の権限へ拡張しない。決済/返金は既存のfinanceロール・原資確認・承認境界に従う。runnerの注文数上限だけで、他のパスワード保有者や同時注文の総課金額まで制限できるとは扱わない。必要な露出上限を既存の限定制御で確認できない場合は実取引用VERIFYを開始しない。

非課金VERIFYでも、海外ゲートを開ければ他のパスワード保有者による課金の露出は残る。承認にはその検査と許容範囲を含め、非課金runnerだから店舗全体に課金が起きないとは保証しない。許容できる制御がなければ隔離店舗で試験する。STOPPEDからは初回準備後でもRESUMEを使い、VERIFY/SALEそれぞれの条件とRECOVERY_APPROVER・RELEASE_MANAGER両方の認可を要求する。

### 永続化と単回承認

既存のattestationは最新の判定、既存 `ProductionTransactionProbe` は金融照合に使う。再送防止と試験履歴を表現するため、次の2モデルを追加候補とする。この設計段階ではschema/migrationを編集しない。

| モデル案 | 保存する最小情報 |
| --- | --- |
| `InternationalGateAuthorizationRequest` | shop、認証済みactor、用途VERIFY/SALE/RESUME、scope JSON/hash、期待generation、release/native/source binding、検証run参照、ランダムnonceのhash、承認期限、消費時刻、結果、承認した有効期限 |
| `InternationalCheckoutVerificationRun` | shop、authorization参照、scenario version、release/scope/native binding、開始/完了・lease、実測結果の安全な要約、artifact参照/digest、状態RUNNING/PASSED/FAILED/EXPIRED、failure code |

承認要求と検証runは寿命と権限が異なるため分ける。結果はrunごとに残し、成功済みrunを上書きして別releaseの成功にしない。未消費要求は10分で失効。request/run本文はallowlist schemaとサイズ上限で検査し、raw API応答や自由な証拠本文を入れない。

`InternationalGateSyncState` へ現在のauthorization request参照と用途を追加する案とする。期限・scope上限・mode・世代・ジョブは既存フィールドを使用する。金融証拠は既存probe JSONの新versionを使い、金融専用の重複テーブルを作らない。

### 承認プロトコル

- **プレビュー**: 明示POSTでDB/native/releaseを読み、候補・拒否理由・期限を計算。承認要求をDBに保存するだけでShopifyへ書かない。GETにはnonce生成/証拠登録/同期の副作用を持たせない。
- **承認**: actor/shop/用途/nonce/期限/ロールをサーバーで照合し、nativeとreleaseを再取得する。serializable transaction内でDB由来source・証拠version・期待generationを再検査し、nonce消費、承認範囲保存、世代更新、RECONCILE登録を一括確定する。ネットワーク呼出をDB transaction内に保持しない。
- **反映**: workerは現在のrequestと用途に必要な証拠を再確認する。VERIFYは配備証拠と非公開確認、SALEは最終証拠を要求。どちらも閉鎖、商品反映、再検査、全店反映の順を守る。停止/失効/新世代に負けた旧workerから再許可しない。

nonceの二重消費、別actor/shop、旧generation、取消された証拠は409または認可エラーで拒否。二重クリックは既存の同じ要求の処理結果へ収束させ、別の有効化要求を作らない。nativeとDBは一括transactionにならないため、最終反映前の再検査と独立監視を維持し、競合窓がゼロとは保証しない。

証拠の期限切れ・取消・配備差替えは既存キューで停止を要求する。`STOPPED` からの復旧はRECOVERY_APPROVERによる別のRESUME要求と、現在のRELEASE条件を要求する。ロールは既存ADMIN overrideを維持するが、画面の閲覧権限から更新権限を推定しない。

### 操作画面

既存の国際配送画面へ「実設定」「検証結果」「承認範囲」の3つのunframedな領域を追加する。既存のPolarisを使用し、同期記録・停止確認・販売可能を別表示する。長いrouteはコンポーネント/serviceへ分け、既存architecture上限を増やさない。

| 操作 | 権限 |
| --- | --- |
| 閲覧 | ADMIN / COMPLIANCE_REVIEWER / RELEASE_MANAGER / INCIDENT_COMMANDER / RECOVERY_APPROVER |
| 市場・配送証拠の登録/取消 | COMPLIANCE_REVIEWER |
| 検証/販売のpreviewと承認、明示同期 | RELEASE_MANAGER |
| 停止 | INCIDENT_COMMANDER |
| 停止後の復旧 | RECOVERY_APPROVER |

既存loaderにINCIDENT_COMMANDER/RECOVERY_APPROVERの閲覧を追加し、権限のある操作だけ表示する。対象は検索可能な商品一覧、国の選択、通貨の選択、期限入力で指定し、承認前に追加・削除される組合せを表示する。任意のJSONや自己申告 `passed` 欄は置かない。

全intentをallowlist化し、POST・既存32KB制限・認証済みactor・no-storeを維持する。範囲の既存上限200商品/128国/256組合せとbody制限の両方を守り、超過は明示エラーにする。「要求受付」「反映中」「実際の停止確認」「検証合格」を同じ成功表示へまとめない。

## 4C 国際取引の証拠

### 国・商品・経路の束縛

既存probeのJSONへ国際用versionを追加し、開始時に次を固定する。

- shop、実release fingerprintとFunction artifact/policy、authorization request ID、scope hash、native config hash、実機scenario version。
- 配送国、商品/variant IDと数量、配送サービス、明示したprovider/支払方法。国際ではAUTODETECT・国内paid-onlyを使わない。
- 期待する店舗通貨/購入者通貨、通貨ごとの上限額、開始時のsource hash・desired/applied generation、期限。

注文紐付け前に実店舗・実ゲート・対象商品を再取得する。注文作成時刻が承認期間内で、対象国・商品・variant・数量・providerが一致し、取得が完全であることを確認する。国内注文、別国、未確認の商品、テスト決済、混合/不明な配送先を合格にしない。

さらに注文の `app` / `sourceName` 等で採用したチェックアウト由来かを確認し、runnerが操作したcheckoutとの対応を検証する。時刻・金額・商品が似ているだけの注文を自動採用しない。**2026-10-17修正: GraphQL `Order.checkoutToken` は公開2026-04フィールドで確認できず、当初の取得案は採用しない**。署名検証済み注文Webhookの `checkout_token` と注文前runner識別子の対応を候補とし、詳細は[4C設計](international-checkout-verification-design.md)に従う。null/欠損や実環境の対応を確認できなければ未確認で、任意注文IDや属性の自己申告へfallbackしない。token原文をDB・URL・ログへ追加保存しない。[注文の識別フィールド](https://shopify.dev/docs/api/admin-graphql/2026-04/objects/Order)、[注文Webhook](https://shopify.dev/docs/api/webhooks/2026-04?reference=toml)

開始から紐付けまでに世代が変わった場合は自動紐付けせず再確認を要求する。紐付け後の支払/返金履歴は世代変更で消さない。通常の期限更新だけで再課金を求めず、公開判定では同じrelease/承認範囲/native構成に対する過去の取引結果と、**現世代の**実値・適格性の両方を要求する。範囲拡大・経路/通貨変更・配備差替えには新しい対象別証拠が必要。

現在の未紐付け `AWAITING_ORDER` が同じactive keyを占有する場合は競合を表示する。無断で取消・削除・付け替え、新しい国際probeへ置換しない。既存の正式な解決手順が必要な外部依存として残す。

### 通貨を混同しない

Shopify 2026-04の `Order.currencyCode` は店舗通貨で、購入者通貨は `presentmentCurrencyCode`。金額には `shopMoney` と `presentmentMoney` があるため、同じ通貨と推定して比較しない。[Order API](https://shopify.dev/docs/api/admin-graphql/2026-04/objects/Order)

注文、支払、返金それぞれについて必要な `MoneyBag` の両側を取得し、通貨・minor unit・合計を別々に照合する。KOMOJU、SellerOrder、台帳は各記録の実通貨と比較し、独自の為替換算で差を埋めない。実入金は別の入金証拠であり、注文額から銀行着金を推定しない。[OrderTransaction API](https://shopify.dev/docs/api/admin-graphql/2026-04/objects/OrderTransaction)

**最初の受入対象は、現在の会計実装で通し検証できるJPY建ての海外取引とする**。海外配送と外貨建て決済は分ける。JPYでも実際の対象国・provider・送料で成立することを確認するまでは許可しない。既存の外貨設定を削除せず、未対応通貨の組合せは未確認のまま残す。外貨対応を完了したと報告しない。

承認した通貨を越えないため、全店の国際projectionをv3、policyを `international-sale-2026-10-v2` とする小さな追加を設計する。`u` にソート済みの許可通貨集合を持ち、商品projectionはv1構造のままpolicyを同じv2へ合わせる。初期の許可通貨は `JPY` のみ。海外宛てには既存queryの `cart.cost.totalAmount.currencyCode` と照合し、欠落・未対応・不一致を拒否する。国内の一般projectionは変更しない。

旧v2の海外許可値を新しい通貨確認済みとして受け入れない。新backend/Functionの配備は海外閉鎖状態で行い、候補と本番のversionを区別する。queryに新フィールドを増やさず、WASM命令/入力制限と既存の大量カート拒否を再検証する。これは未公開の第3弾への追加であり、Function全体や税計算を作り直すものではない。

外貨建てを後続で開けるには、通貨ごとのminor unit、provider、返金、台帳・入金との対応まで実装/試験し、明示承認してallowlistを広げる。現在の「0桁通貨以外は2桁」という変換を全通貨対応と見なさない。

### 個人情報の境界

追加する注文の配送先情報は原則 `shippingAddress.countryCodeV2` のみ。氏名、住所本文、電話、メール、カード情報を証拠JSONへ追加しない。国コードでも注文と結び付く情報であり、匿名情報とは扱わない。必要scope・保護対象データの実取得可否を確認し、欠損/マスク/API errorは未確認にする。権限を自動で増やさない。[Shopifyの保護対象データ要件](https://shopify.dev/docs/apps/launch/protected-customer-data)

GBは国コードだけでは北アイルランド以外の配送先を独立確認できない。FunctionのBT拒否試験を行っても、国コードGBだけの実注文をGB本土の取引証拠としない。必要なら郵便番号を保存せず地域区分だけ導出する別途のアクセス審査/設計を行う。それまではGBの実取引証拠を未確認に残す。

browserは合成データと承認された試験先だけを使う。URL・checkout token・入力済み住所・メール等をraw traceやスクリーンショットへ残さない。既存の非公開証拠参照、マスク済み画像、固定項目のJSONだけを保存する。金融操作は別承認がなければ実行しない。

### 試験範囲と一般販売の条件

国際scenarioは別versionの必須集合を定義する。既存16シナリオは維持し、新しい集合を満たしたことにしない。最低限の国際ケースは次のとおり。

- 許可された商品×国×通貨が購入直前まで進む、同一カートの国不許可商品が拒否される。
- 不許可国、NI、未設定通貨、商品/全店の世代ずれ、projection欠落・期限切れを拒否する。
- 手動/無料送料・別Carrier/profileの実在する経路でも同じ拒否が有効。経路が存在しない場合はnative棚卸しで確認し、試験したことにしない。
- 証拠取消後の閉鎖値/商品反映と購入拒否、旧checkoutの再利用拒否、試験終了後の閉鎖読戻し。
- 国内購入の回帰、通信失敗、二重送信・Webhook重複、返金の再試行と実台帳の一意性。

Function入力fixtureやブラウザの画面だけで「注文確定時に拒否した」と認定しない。各ケースに実行したbuyer journey段階と観測可能だった結果を記録する。非課金で観測できない確定段階は未検証のまま残し、必要な実試験を別承認へ回す。結果に応じた必須項目の省略は禁止。

非課金検証は承認対象の全商品×国を網羅する。実取引は少なくとも公開する国×購入者通貨×provider/支払方法×配送経路種別の各組合せを対象とし、どの商品で試験したかも記録する。ある国の成功だけで同じ通貨の別国まで合格にしない。試験負担が大きければ有効化範囲を明示的に絞り、未確認範囲をまとめて開けない。

各runの実測・支払/返金/台帳照合・必要な外部証拠が揃ったときだけ、専用serviceが最終attestationを発行する。汎用の証拠登録フォームから国際システム証拠キーを直接CONFIRMEDにする操作は禁止。`confirmedBy` はverifierのsystem actorとし、開始/承認した運営actorを別に残す。既存の人名があることだけで機械検証済みにしない。

一般販売の許可条件は、適用するP01-P28、現在の完全な実設定、最終証拠の対象一致、現世代の実ゲート反映、明示したSALE承認。いずれか未確認なら販売可能と表示しない。SALE承認からストアのパスワード解除や通知再開は行わない。

## 実装単位と受入条件

| 単位 | 主な変更先 | 必須の受入試験 |
| --- | --- | --- |
| 4A | 共通context、native読取り/評価、readiness/monitor/guard/probeの呼出 | DB国内/native海外、逆の不一致、scope不足、部分取得、全世界、国内の条件付き送料、重複取得抑止、GET無副作用、停止/注文取込みの回帰 |
| 4B | 承認/検証serviceと2モデル、証拠発行、既存国際route/role/UI、worker用途別条件 | 初回閉鎖から検証開始、未証拠/別repo artifact拒否、nonce再送/別actor/別shop/旧世代、取消との実PostgreSQL競合、runner停止/期限切れ、復旧の別権限 |
| 4C | 国際probe helperと既存金融照合、シナリオ/runner、projection/Functionの通貨境界 | 国内/別国/別商品/別通貨/旧release拒否、JPY実額、外貨未対応拒否、支払/返金二重実行、現世代検査、WASM上限、証拠へのPII混入拒否 |

4Aを先に単独実装する。4Bの実店舗結果入力は4Cのrunner/照合へ依存するため、型・状態・拒否経路を先行実装しても手動チェックで合格へ埋めない。4B/4Cの組合せを統合試験してから承認UIを使用可能にする。

全体テスト、対象service/route試験、Prisma validate、lint/text/architecture、アプリ/Function build、隔離runtime、production auditを既存CIで実施する。実PostgreSQLの同時承認/取消、JSONB正規化、PC/スマホ320/375/1440pxの画面・権限/未確認表示も試験する。既存のFunction query cost30・判定量10,000文字・行数上限と資源試験を維持する。

本番反映はPR #51-#53の依存関係を整理した後の別段階。migration、backend、Shopify候補配備/release、scope付与を個別に観測し、閉鎖した状態で整合を確認する。rollbackでも海外の古い許可値へ戻さず閉鎖を維持する。

## この段階でも外部依存として残ること

初期対象国/商品の確定、法務・税務・商品規制の実書類、実付与scope、実配送設定、非公開確認、決済手段と資金、実受信、入金、復元試験はコードで捏造しない。実環境への承認済みアクセスや試験手段がなければ、未確認の理由と次に必要な操作を固定して残す。

R06・通知有効化・第三者販売・自動マージ・既存国内ガードの処分は今回の設計から自動実行しない。実装範囲は4Aと4B-1の候補。4B-2/3・4Cと本番の完了状態は変更しない。
