# 国際購入の通し検証と販売用証拠

作成日: 2026-10-17 JST

状態: **4C-1は候補実装・ローカル検証済み。4C-2/3は未実装、本番未反映・実取引未確認**。基準は4B-3候補 `960024ebb747180c9c4630d7747504b8ed940356`、[下書きPR #57](https://github.com/morixi4106/vendor-register/pull/57)。本番の最後の観測は2026-10-15 11:35 JSTで、今回再監査していない。最新の候補PR/CIは[進捗メモ](launch-progress.md)を参照する。

[4A-4Cの全体設計](international-release-verification-design.md)、[単回承認](international-authorization-design.md)、[配備証拠](international-proof-issuance-design.md)、[管理操作とrunner](international-runner-interface-design.md)を引き継ぐ。ここでは4Cの具体的な契約と実装順を定める。文書の採用は公開・配備・migration・権限/設定変更・課金・返金・メール送信の承認ではない。

## 1. 決定事項

1. **最初は海外配送・JPY建てに限定する**。国、商品/variant、配送経路、決済方法ごとに検証し、未確認範囲をまとめて開けない。外貨設定は削除せず、購入制御で未対応通貨を拒否する。
2. **実行結果と閉鎖を確認してから合格にする**。ブラウザの申告、fixture、DEPLOYMENT合格、閉鎖要求の受付だけでは販売用証拠を発行しない。正常終了と障害停止を分離する。
3. **既存の金融照合を再利用する**。国際専用の注文/決済/台帳を作らない。購入経路を照合できない注文、国内paid-only、過去のShadow作成記録は海外の成功証拠に使わない。

4Cを3単位で実装するが、統合検証が済むまでsource capabilityの固定falseを維持する。envや管理画面のスイッチで解除しない。統合後も、実証拠・署名鍵・実scope・明示承認がなければ実行/販売は拒否される。

## 2. 実コードとの差分

以下は設計時の不足一覧。4C-1の現在の実装範囲と未接続部分は末尾の実装記録を参照する。

| 現在の箇所 | 確認した不足 | 変更方針 |
| --- | --- | --- |
| `international_validation.js` / `internationalGateProjection.server.js` | shop v2 / policy v1には通貨allowlistがない。queryは既に通貨を取得する | shop v3 / policy v2を厳密に組み合わせ、海外配送時にJPYを強制 |
| `internationalAuthorizationContext.server.js` / `internationalProofReader.server.js` | VERIFYにもDEPLOYMENTのscenario/hashを返す。SALEは未対応 | 配備ケースと国際ケースを分離し、serverが必須集合を生成。SALEは対象別の最終証拠を検査 |
| `internationalVerificationRuns.server.js` | 終了要求は常にresults unavailable。閉鎖確認後もFAILED/EXPIREDのみ | 正規結果を固定して閉鎖する専用経路と、実閉鎖後の正常完了を追加 |
| `internationalGateQueue.server.js` / `internationalGateSync.server.js` | stop helperは承認を取消し、RUNNINGをFAILED候補にする。閉鎖記録とstate最終化は別transaction | 一般STOPの安全側挙動は維持。正常終了だけ別契約とし、最終化/結果採用の競合を防ぐ |
| `productionTransactionProbe.server.js` | 配送国/購入者通貨/checkout対応なし。金額欠損がJPY/0へ補完され、丸めもある | 国際版の厳密snapshot/照合を追加。旧版結果を自動昇格しない |
| `komojuLimitedLaunchScope.server.js` / control / Function | 限定制御は国内を要求し、反映済み残枠を検査する | 海外への流用禁止。同時注文を原子的に予約する仕組みとは扱わない |
| `webhooks.orders.create.jsx` / `shopifyWebhookInbox.server.js` | 署名検証と配送重複制御はあるが、checkoutとの対応は保存しない | 既存の署名済み注文Webhookから国際probe用の最小な対応証拠だけ抽出 |

## 3. 対象範囲と通貨の強制

承認済みのproduct-country集合、JPY、実店舗の完全なnative設定を正本にする。実行計画では現在販売可能なvariant/数量、profile/provider/service、送料条件、決済provider/method、buyer journeyを固定する。商品IDだけ合っている別variantや別サービスを同じ実測としない。

- 国際shop projectionを `v:3` / `p:international-sale-2026-10-v2` とし、ソート済みの `u:["JPY"]` を追加する。productは構造v1のままpolicy v2へ合わせる。ACTIVEでは国と通貨の両方、PREPARINGでは海外国集合が空であることを検査する。
- source hash、承認scope hash、expected shop hash、署名manifest、readerのruntime検査へ通貨を含める。現在別々に許容されるpolicy/versionも、旧v1+v2と新v2+v3の正しい組合せに限定する。旧海外許可値を新通貨検査済みとして採用しない。
- Functionは海外delivery groupを検出した時点で既存の `cart.cost.totalAmount.currencyCode` と照合する。欠落、未知、JPY以外、大小文字等の不正表現は拒否。新しいquery fieldや税計算は追加しない。
- 国内JPだけの購入と、住所未入力段階の既存契約は維持する。ただし確定段階の配送先欠損、group欠損、未被覆行、物理/非物理の海外混在を許可する早期returnは追加しない。0円でも海外の通貨検査を省略しない。
- GB/BT拒否、複数group、大量cart、期限、世代、watchdog/全店停止の優先順位を維持する。新backend/Functionは海外閉鎖中に配備し、旧readerは未確認として閉じる。国内回帰は別途検証する。

初期金融証拠はKOMOJU/CARD、店舗/購入者/照合対象の決済・台帳通貨がすべてJPYの場合のみを実装対象とする。実店舗でこの組合せが提供されると仮定せず、確認できなければ未確認にする。FXや三桁小数通貨、分割払い、複数capture、ギフトカード併用、未知の手数料構造は未対応とし、黙って丸めない。採用できない経路を実店舗側で閉じた証拠も必要で、既存の国内決済をコードから勝手に変更しない。

## 4. 必須ケースと結果の信頼境界

`international-checkout-cases-v1` と固定verifier versionを追加する。必須集合はserverがnative棚卸し、承認scope、販売variant、経路、採用決済から正規化して生成し、承認previewとrun作成時にhashを固定する。runner/フォームが必須ケースを削ったり、失敗を見てN/Aへ変更したりできない。

| 群 | 最低限の確認 | 証明する範囲 |
| --- | --- | --- |
| artifact / WASM | 未知/欠損/不正projection、世代ずれ、期限境界、外貨/通貨欠落、NI、mixed cart、上限、取消/失効競合 | 同じ配備artifactの制御。実店舗の実行実績ではない |
| live 非課金 | 全対象product-countryと販売variant、JPYの価格/送料/税/合計/販売者、対象外国/商品、実在する手動/無料/別profile等の経路、国内回帰 | 実際に観測した購入直前まで。注文確定成功は含まない |
| live 閉鎖 | 正常終了後の空国projection、Validation、同じ旧checkoutと新しいcheckoutで海外拒否 | 当該shop/releaseの閉鎖。受付202だけでは未確認 |
| live 金融 | 国×JPY×provider/method×実配送経路ごとの実売上、注文/行/台帳、原取引に対応する返金 | 試験した取引の金融結果。着金を推定しない |

非課金では支払確定操作、カード入力、wallet承認をしない。観測していないCHECKOUT_COMPLETIONは `NOT_OBSERVED` として保存し、interactionのエラー画面を確定段階の拒否へ読み替えない。必要な確定段階の検査は承認された実試験/隔離店舗で行い、不足なら最終proofを拒否する。buyer journeyには複数の段階がある。[Shopify Function 2026-04](https://shopify.dev/docs/api/functions/2026-04/cart-and-checkout-validation)

不正metafield、時計変更、依存証拠取消等を本番へ自由に注入するrunnerは作らない。破壊的な負例はCI/WASM・隔離店舗に分ける。実店舗の停止/取消訓練が必要な場合は別の承認済みrehearsal runで記録し、その停止・閉鎖結果だけを参照する。取消済みrunをPASSEDへ戻したり、無効になった証拠を最終proofの有効依存へ再採用したりしない。

同じJPYや同じラベルだけで別国/別carrierへ実測を広げない。非存在経路は完全なnative棚卸しの構造で非適用と判断し、人の自由記入で省略しない。case上限を超える場合は開始を拒否し、承認範囲を分割する。上限内へ黙って切り詰めない。

結果は単なる `passed:true` ではなく、run/case ID、server challenge/sequence、固定runner digest、shop/release/scope/native/source/start generation、期待段階、実観測段階、時刻、固定outcome/reason、証拠digestを持つ。source管理の `checkoutVerifier` registryと独立した署名domainを追加し、publisher/observer/transport鍵を流用しない。署名を検査し、serverが期待値と照合して判定する。署名は信頼済み実行者への帰属であって、画面内容そのものの暗号学的attestationではない。

browser runnerは管理された別processでPlaywrightを使用する。既存ローカル画面試験の仮データと本番観測を別environmentとして保存する。固定storefront/Shopifyの許可host以外へ移動・送信せず、自由URL/任意shell/ページ内命令を実行しない。障害時もraw HTML、network log、cookie、storage、traceをuploadしない。

runnerコードとcase定義のdigestを成功CIの同じcommitへ束縛する。既存配備manifestのfilesは拡張成果物用なので、browser scriptを無差別に混ぜない。version付きの別verifier記述を既存proof契約へ明示追加し、固定pathの公開コード/hashのみを検証する。公開Actions artifactへ実店舗結果、checkout URL、認証状態、住所等は置かない。

## 5. 最小の永続化と内部API

既存のrun/承認/probe/証拠モデルを継続する。256組以上のケースを単一32KB JSONへ詰めたり、HTTP制限を広げたりしないため、子モデル **`InternationalCheckoutVerificationCase` 1つ**を追加候補とする。

- caseは同店舗runへのcomposite FK、server生成caseKey、phase、canonical expected JSON/hash、状態、単回challenge hash/sequence/期限、採用結果JSON/hash、固定reason、時刻を持つ。`(shopDomain,runId,caseKey)` unique、run全体最大2048件、結果1件最大4KBを初期上限とする。
- runへ非PIIの不変plan summary/hash、closure candidate digest、closure検査時刻を追加する。既存 `resultsJson` は32KB以内の要約/aggregate digestだけにし、全caseの本文を重複保存しない。case集合の整列hashと件数を最終transactionで検査する。
- `financialProbeId` は同店舗の既存probeを参照する正式なnullable FKにし、probe側へ対応する `(shopDomain,id)` uniqueを追加する。国際probe同士の同時実行を新しいactiveKeyで迂回しない。全体scopeの金融coverageは複数の完了run/probeを厳密に集約する。
- 旧run/旧probeは新plan/対応証拠なしのまま未確認。migrationで合格を埋めず、既存FK/履歴を壊さない。これは設計であり、今回schemaは変更しない。

新しい固定checkout-runner credential/principalをB3認証へ追加し、deployment/observer/publisher tokenとは分離する。専用POST `/internal/international-checkout-runner` のintentは `next` / `claim` / `heartbeat` / `challenge` / `record` / `finish` / `fail` に限定する。bodyは正準JSON/32KB、case結果は最大8件/要求。shop/executorはserver固定、leaseは専用header、challengeは60秒・server採番・同一結果再送だけを許可する。

run leaseは既存5分、heartbeatは約60秒。claimとheartbeatではkind、当該承認、取消、現在世代、delivery/proof依存を同一transactionで再検査する。QUEUEDから開始してもACTIVE反映完了まではcase実行不可。署名完了結果の再送は同じ履歴を返すだけで、期限/実測時刻/世代を更新しない。

新APIは課金/返金の実行権限を持たない。金融結果はprobe IDを受け取ってserverが再照合する。金融実行adapterを使う場合も、用途別の別認可と既存financeロールを必要とする。通常HTTP handler/Cronからbrowserを起動せず、B3と同じbounded CLI/schedulerの責務に分ける。

## 6. 正常終了と閉鎖の順序

通常STOPは従来どおり失敗/失効へ向かう。正常終了だけ、検査済みcase集合に対する専用transitionを追加する。汎用stop helperへクライアント指定 `success` を渡して合格させない。

1. `finish` は現在RUNNING/lease、期限、承認/世代、全pre-close case、artifact/実配備/native/sourceを検査する。金融runは注文前対応と実行結果の受付を固定し、決済結果不明でも新規課金せず閉鎖を優先する。返金やWebhookの完了待ちを理由に海外を開けたままにしない。
2. Serializable transactionでpre-close candidate digest保存、`CLOSING` / `outcomeCode:PRE_CLOSE_VERIFIED`、closure generation採番、海外STOPPEDと閉鎖job登録、実行lease消去を同時確定する。承認の新規利用を終了させるが、正常完了による消費終了と証拠取消を混同せず、取消済みを有効へ戻さない。一般STOP/証拠取消はcandidateを無効化する。
3. 既存workerが空国projectionをCAS反映/読戻しし、実Validationと配備証拠から保護を検査する。古いgenerationの書込み/結果では現在のrunを最終化しない。
4. 閉鎖検査用の短い別challengeで、固定runnerが旧/新checkoutの拒否を観測する。この経路に購入許可や再開の権限はない。workerの `protected:true` だけで実機caseを埋めない。
5. 現stateのSTOPPED、phase BLOCKED、desired=applied=closure generation、実閉鎖観測、未取消依存、immutable candidate/case hashを再検査する。金融runはさらに既存probeのpaid/refund/台帳結果が必要で、閉鎖済みでも金融待ちはCLOSING/未合格とする。state最終化とrun完了のtransaction境界を整理し、すべて揃った場合のみPASSED/CONFIRMED、activeKey解放と正常結果の固定を行う。

外部読取りはtransaction外で上限を設け、確定transactionではDB時刻、同じbinding/観測鮮度/nonce、状態とhashを再照合する。ネットワークI/Oを長いDB transactionへ保持しない。閉鎖証拠の鮮度はB3と同じ60秒、transaction上限15秒とする。

閉鎖未確認はCLOSING/activeKey保持と再試行、RUNNINGの期限/lease切れはEXPIRED候補へ、失敗/取消はFAILEDへ進む。CLOSINGには消去した実行leaseを要求せず、閉鎖challengeとrunの期限で検査する。run期限を越えた閉鎖/金融確認は安全回復・履歴として記録できるが、PASSEDへ昇格しない。返金/金融取込みそのものは試験失効後も継続できる。応答消失、並行STOP、証拠取消、source変更、旧jobの遅延完了を必須PG試験にする。

非課金runのPASSEDは非課金範囲の合格でありSALE-readyではない。正常閉鎖で毎回変わるgenerationをrelease fingerprintへ混ぜて再課金を要求しない。過去の実測bindingと、今の閉鎖/許可世代を分けて検査する。

## 7. Checkoutと注文の対応

先の全体案にあった **`Order.checkoutToken` をGraphQLで読む案は採用しない**。2026-04の公開Orderフィールド一覧では確認できず、`sourceIdentifier` はPOS/第三者の注文識別子でcheckout tokenの代用ではない。`app` / `sourceName` は由来の補助条件で、runとの一意対応には使えない。[Order 2026-04](https://shopify.dev/docs/api/admin-graphql/2026-04/objects/Order)

採用候補は、署名検証済みの既存 `orders/create` / `orders/paid` Webhookの `checkout_token` と、固定runnerが注文前に観測した同じ識別子の対応である。公式サンプルでもnullがあり、実店舗/採用経路で両側を読めることを先に実証する。GraphQLへ存在未確認fieldを追加したり、REST新規利用を前提にしたりしない。[Webhook 2026-04](https://shopify.dev/docs/api/webhooks/2026-04?reference=toml)

- runnerの期待対応は**注文前**にchallenge/runへ固定し、後から任意注文のtokenを持ってきて期待値を書き換えられないようにする。HMACは用途/shop/run/key versionでdomain separationし、照合用秘密はbrowserへ渡さない。原文は認証済み専用入力のメモリ処理だけに限定し、固定digestを保存する。
- 既存privacy hashのfallbackをそのまま新用途へ流用しない。専用のversion付きHMAC鍵を管理実行基盤へ別途導入し、未設定/rotation不整合は未確認。鍵登録は実装/設計の自動副作用にしない。
- Webhookは既存 `authenticate.webhook` とreceipt/inbox経路を維持し、同店舗の現在待機probeだけへ最小の対応digest、注文GID、topic/event/receipt参照、受信API version/時刻を紐付ける。一般顧客全員のtoken台帳やraw payload保存は作らない。
- 先にrun/probeの期待対応を永続化してから注文する。Webhookの順序逆転、重複、処理retryでも同じ注文へ収束させ、別注文の競合は拒否する。通常の決済/台帳取込みは対応不足で止めず、国際証拠の確定だけを待機/拒否する。
- null/欠損/未受信/別checkout、複数配送先、source不明は未確認。cart attribute/注文メモ、似た時刻・金額、画面の注文番号だけへのfallbackは置かない。対応が実証できない経路は公開対象に含めない。

配送先追加取得は国コードのみを基本とする。GBは国コードだけではNIとの区別ができないため、実注文側の地域分類を保存なしで導出できる権限/方法を別確認するまで金融coverageへ含めない。住所・メール・郵便番号・カード・checkout URL/原文tokenは証拠JSON、ログ、DTO、公開artifactへ追加しない。

## 8. 金融probeと実行の境界

既存 `ProductionTransactionProbe` の国際用evidence versionを追加し、開始時に同店舗VERIFY run、authorization/release/scope/native/source binding、国、商品/variant/数量、経路、明示provider/method、店舗/購入者通貨JPY、金額/注文数/期限/原資計画を固定する。国際用はAUTODETECTと国内 `PLATFORM_DIRECT_PAID_ONLY` を拒否する。

国際snapshot helperへ必要なMoneyBag両側、`presentmentCurrencyCode`、国、由来補助情報、配送サービス、完全性を追加する。JPYは厳密な十進文字列を整数minor unitへ変換し、欠損・非ゼロ小数・負数・safe integer超過を拒否する。`65.00` のような小数部ゼロは整数65として扱い、丸めはしない。DB保存額/計画額には既存Prisma Intの上限も適用する。0への補完、currency欠損のJPY補完、独自FXは使わない。既存の国内historyを黙って再解釈しない。

紐付けでは承認期間内のcreatedAt、注文前のcheckout対応、全行/variant/数量、国/通貨、実native配送経路、provider/method、非test/非取消、現在binding/世代を検査する。後から更新された注文や不完全なページ取得を成功にしない。紐付け後の正規返金/取込みはゲート停止後も続け、過去の金融履歴を消さない。

paidは既存の1成功transaction/PaymentAttempt、SellerOrder、商品行、paid ledger、Shadowの直接一致を維持する。refundは元transactionとの対応、provider確認、実額/通貨、SellerOrder返金額/数量、refund ledgerの一意性を再利用する。リクエスト受付やPENDINGから成功を作らず、重複/遅延Webhook・応答消失でも再課金/二重返金しない。

既存のKOMOJU入金証拠戦略と返金原資確認は維持するが、`ZERO_BALANCE_LIMITED_LAUNCH` の国内例外は海外へ移さない。銀行着金と決済/返金確認は別の事実とし、現在採用できる証拠戦略を満たした場合だけ集約する。既存16シナリオや全決済方法/着金試験を無条件に必須へ増やすのではなく、**開ける決済と経路に必要な条件**を要求する。

### 自動課金を許可できる条件

現行の反映済み残枠とWebhook後の集計だけでは、同時checkoutの総額/件数を原子的に制限できない。Functionへnetwork fetchを足せば解決すると仮定しない。利用可能条件が限定されるため、対象店舗で確認するまでは設計依存にしない。[Functionのnetwork制約](https://shopify.dev/docs/api/functions/2026-04/cart-and-checkout-validation)

FINANCIAL VERIFYのpreview/confirm/実行は、RELEASE_MANAGERに加え、既存financeの準備・承認・実行の認可、現実の原資、期限付きの実行計画、店舗全体の露出対策を必要とする。password非公開は試験者だけを識別する境界ではない。NON_FINANCIAL VERIFYでも他のpassword保有者の課金露出を評価する。

決済事業者/Shopifyの承認済み制御で、同時注文を含む対象/金額/件数を拘束できることが未確認なら、本番FINANCIAL VERIFYを開始しない。隔離店舗の合格は本番金融証拠へ移せない。後から残枠を減らす処理や「1回だけクリックする」をhard capと表示しない。

課金adapterは採用先の正規の決済経路だけを使い、無人実行可能な正式な試験手段/認可がある場合に限り接続する。PAN/CVV保存、3DS/MFA回避、任意カードの利用はしない。本人操作が必要な手段しかない場合は未確認のまま停止し、fixture結果で埋めない。返金も既存の正規経路と別認可に従い、通常runner credentialへ実行権限を足さない。

既存の未紐付け `AWAITING_ORDER` がactiveKeyを占有していれば開始競合のまま表示する。無断の削除/取消/付替え、別activeKeyでの迂回、海外成功への書換えは禁止する。

## 9. 最終proofとSALE承認

専用issuerだけが `INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED` を発行する。DEPLOYMENT、正常閉鎖済み非課金run、対象別の金融probe/run、必要な停止訓練/確定段階結果、現時点の実配備/native/法務配送等の依存証拠を再照合する。汎用フォーム、署名付き空結果、自己申告チェックでは発行しない。

最終metadataはversion、shop/release/verifier/case-plan digest、対象product-country/variantと通貨、provider/method/route coverage、依存run/probe/証拠ID・revision・hash、観測時刻/有効期限だけを保持する。coverage集合の不足/余分/改変、別店舗、旧artifact、取消、未閉鎖、金融未完了を拒否する。証拠を満たす対象だけへ明示的にscopeを縮小することはできるが、失敗を見て必須case自体を減らさない。

期限は最大30日と、artifact/receipt/法務配送等の全依存期限の最小値。既存のartifact余裕時間、店舗日付による承認期限切下げ、承認時60秒/利用時15分の実配備観測を維持する。新generationだけで過去金融結果を失効させず、商品/variant、release、国、provider/method、送料構成/税設定、通貨の変更は新しいcoverageを要求する。

proof発行時は海外STOPPEDのまま。一般販売は別のSALEまたはRESUME(SALE) preview/confirmで、現在の適格性/実設定、対象coverage、P01-P28の適用条件を再検査する。決済方法/経路はFunctionの国・商品・通貨制御だけでは閉じられないため、未検証手段を実店舗で無効化した証拠とドリフト検出も必要。完全に確認できなければSALEを拒否する。

現在のnative config hashはMarkets/配送等の取得対象だけで、決済事業者設定や全税設定を含む万能な設定hashではない。追加の実読取りまたは期限付きの正規証拠が必要な設定は個別に束縛し、読取り可否と観測範囲を表示する。API非公開の設定まで自動監視できると報告しない。必須の変更検知が成立しない構成は外部未解決条件として残す。

新規の公開フラグ、独自VAT/関税計算、Marketplace再有効化、自動パスワード解除は追加しない。証拠再発行でobservedAtを現在時刻へ書き換えず、取消/失効/構成変更は既存の停止jobへ接続する。prelaunchの自動通知抑止とR06は別管理を維持する。

## 10. 実装順と受入条件

| 単位 | 実装 | 完了条件 |
| --- | --- | --- |
| 4C-1 | 通貨projection/Function、厳密な国際snapshot、case-plan/coverage契約、artifact/verifier束縛 | JPY/外貨/欠損/旧version、国内回帰、大量cart、十進境界、別国/variant/経路拒否。cap false・SALE未対応は維持 |
| 4C-2 | case子モデル、専用非課金runner/API/管理DTO、正常結果→閉鎖→PASSED | challenge/lease/再送、case不足/偽造、実閉鎖待ち、STOP/取消/旧job競合、実PG rollback、320/375/1440px。非課金PASSEDからSALE不可 |
| 4C-3 | checkout/Webhook対応、既存金融probe接続、最終issuer/reader/SALE coverage、統合capability | 署名済みWebhook/順序逆転、注文流用/二重操作、決済/返金/台帳、現世代の許可反映、依存取消/失効。外部条件欠損時は開始/SALEとも拒否 |

各段階で全体テスト、専用PostgreSQL、Prisma/migration、lint/text/architecture、WASM/prebuilt、拡張/アプリbuild、隔離runtime/production auditを維持する。browserをWeb/runtime依存へ混ぜず、隔離runnerの既存Playwrightを固定する。package/lockfile/品質workflow/ビルド例外条件を変更する必要が生じた場合は別途影響を示し、黙って緩めない。

P01-P28、本番credential/署名鍵/scheduler、実埋込み認証、実scope/checkout識別子/支払制御の可用性、対象国の商品法務・配送・業務メール、旧空DB履歴、既存AWAITING_ORDERは外部または後続の条件として残る。コード/fixture合格と本番GOを分け、[進捗メモ](launch-progress.md)を毎回更新する。

## 11. 4C-1の候補実装

2026-10-17、`agent/international-currency-contract` へ実装。shop v3/policy v2のJPY制御、currency込みscope/source hash、現在runtimeの旧policy拒否、通貨付き閉鎖読戻しを接続した。旧v1+v2 manifestは履歴の解析だけ許容し、現在の配備承認には使えない。

厳密な `internationalTransactionSnapshot.server.js` はread-only query/snapshot/scope照合を提供する。JPY整数、MoneyBag両側、全行/variant、国、由来の補助情報、配送参照hashを確認し、顧客連絡先・住所本文・tokenを新規取得/保存しない。既存国内probeのsnapshot/取込みを置換せず、国際金融の入口とcheckout対応は4C-3に残す。Snapshotやscope一致を金融成功としない。

native readerの既存の単一physical variant制限を維持し、JPY固定market/全経路を確認できる場合だけ、最小のverification inventoryを返す。計画/coverage helperはvariant・国・無料/手動/carrier serviceを区別し、2048case上限・不足/余分/重複を拒否する。厳しいcase用inventoryが未確認でも、既存の国内外scope棚卸し結果は書き換えない。計画の永続化・追加の実機負例・実行/受付は4C-2に残る。

proof manifestへ固定5ソースファイルのhashと `CONTRACT_ONLY` descriptorを追加し、同commitのGitHub sourceを独立照合する。ブラウザ実行済みとは表示せず、checkoutVerifier鍵registryも空、source capabilityはfalse、SALE readerは未対応のまま。Function query/schema、DB schema/migration、package/lockfile、品質workflow/既存の例外条件は変更していない。

ローカル全体1327件中1320成功・既存skip7、専用PG40件成功/schema差分0、Function/WASMとexact prebuilt各92件成功、lint/text/architecture、拡張/アプリbuild、隔離runtime成功。通常local production auditは既存の審査不足3codeで拒否し、例外を広げて通していない。実GraphQL権限/フィールド可用性・checkout対応・決済上限・本番の成功証拠ではない。
