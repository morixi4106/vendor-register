# 国際販売のシステム証拠発行設計

作成日: 2026-10-16 JST

状態: **4B-2は候補実装・ローカル検証済み、CI確認前。本番未反映**。基準は4B-1候補 `6ddc76c`、[下書きPR #55](https://github.com/morixi4106/vendor-register/pull/55)。実装ブランチは `agent/international-proof-issuance`。本番の独立観測は2026-10-15 11:35 JSTまでで、今回更新していない。

[承認の詳細設計](international-authorization-design.md)の4B-2を具体化する。4B-1の単回承認・永続停止・世代付き同期を再利用する。設計の採用はmain反映、migration、credential追加、Shopify配備/release、scope追加、実決済/返金、通知再開の承認ではない。

## 候補実装 2026-10-16

- 専用artifact workflow、最終WASMを再buildせず試験する設定/禁止hook、全3拡張のファイル一覧、固定GitHub出所/attempt/digest照合、制限付きZIP読取りを追加した。新しい依存は追加せずpackage/lockfile・quality.yml・既存ビルド例外は変更していない。
- Ed25519の用途別署名、stage/releaseを分けるpublisher CLIと読取り専用observer CLI、閉鎖専用DEPLOYMENT run、原子的な配備proof発行、reader/取消・nonce付き観測更新を追加した。外部コマンドの試験は差替えた実行器だけで、本番の配備/観測は行っていない。
- migration `20261016140000_international_proof_issuance` は候補のみ。既存runに取消・観測欄を追加し、新しい汎用証拠テーブルは作らない。隔離PGで旧schemaから2つのdelta migrationを適用し、schema差分0、B1/B2各11件成功を確認した。
- issuer/readerの信頼鍵はコードの空リストが既定。鍵の導入/失効registry審査・実サービスの取得権限は別途必要。B3のHTTP認証/配送は未実装で、任意のenvやフォームから信頼鍵・合格値を渡す経路はない。
- 4Cの結果schema・coverage・金融照合が未実装のため最終販売proofは拒否する。通常VERIFY終了を成功候補へ進める接続も4Cの実測検査と同時に行い、B1の暫定FAILED処理を先に緩めない。capability固定falseを維持する。
- ローカル全体1266件中1260成功・skip6、追加の圧縮ZIP試験とpublisher/observer試験も成功。prebuiltの77ケースとcandidate出力、アプリ/拡張build、隔離runtime、lint/text/architecture、Prisma validateが成功。通常のproduction auditは既存のartifact/build審査不足として拒否し、例外を緩和していない。Linux CIでの最終検査はこれから。

## 1. 今回決める3点

1. **試験したbytesを配備に結び付ける**。固定CIの成果物、再buildしない配備記録、実店舗の読戻しを照合する。CI成功や手入力のhashだけでは証拠を発行しない。
2. **配備確認と販売確認を分ける**。閉鎖中に作れる配備proofは検証の前提だけ。一般販売には4Cの対象別実測・金融照合と、別のSALE承認を要求する。
3. **失効・取消から自動復旧しない**。証拠と使用中の承認を追跡し、既存キューで停止する。4B-3/4Cが完成するまで有効化capabilityは固定falseを維持する。

汎用証拠フォーム、任意URL、結果JSONのupload、環境変数の `passed`、既存国内probeの自己申告は発行経路にしない。未設定の実行基盤や取得不能を仮データで補わない。

## 2. コードで確認した差分

| 現在の候補 | 4B-2の変更 |
| --- | --- |
| 品質CIのartifactは監査JSONのみ。WASM試験後に拡張buildがある | 最終build後のWASMを再buildなしで試験し、配備可能な成果物一式を固定する独立workflow |
| `npm run deploy` は `app deploy --no-release`。通常はbuildを伴う | 承認された専用publisherで `--no-build --no-release`。既存scriptの実行成功を同一bytesの証明にしない |
| release expectationは環境変数等から組立てる | expectationは比較対象のまま。実際の配備・active versionはサービス側記録から独立取得 |
| proof adapterは未対応として拒否 | 専用issuer・reader・revoker。2つの予約キーを用途別に評価 |
| run claimは消費済みVERIFYとENFORCEを要求する | authorization不要・閉鎖専用のDEPLOYMENT lifecycleを分離 |
| run閉鎖の現実装はFAILED/EXPIREDのみ | verifierだけが使える成功確定経路。旧FAILEDをPASSEDへ書き換えない |
| 既存runと最新attestationがある | 同じモデルを拡張。新しい汎用承認DBや金融テーブルを増やさない |

4B-1初回CIは、品質workflow/package追記で審査済みbuild control fingerprintが変わり拒否された。独立PG workflowへ分離後に成功している。4B-2でも `quality.yml`、package/lockfile、safe-build、既存リスク受容のhashや期限を黙って変えない。変更が必要なら別の明示審査対象にする。

## 3. 成果物の固定

### 固定workflowと試験

専用workflow案は `.github/workflows/international-proof-artifact.yml`。本番用は固定repo `morixi4106/vendor-register` の保護されたmain上の明示実行だけとする。PR/featureでの検査はcandidate用に分け、同じ名前の成功結果でも本番証拠へ昇格させない。fork、`pull_request_target` の未信頼checkout、本番secret付きbuildは使用しない。

1. exact 40桁commitをcheckoutし、固定lockfile・Node・CLI・pinned Actionsで既存の品質検査を実行する。同じcommitのQuality checksと独立PG試験の成功もAPIで確認する。別SHA、別attempt、check名だけの一致は拒否する。
2. buildは既存の隔離HOME・環境allowlist・時間制限を通す。品質workflowを編集せず、共有可能な既存scriptを呼ぶ。外部から渡された任意コマンドを実行するworkflowにはしない。
3. 全拡張の最終build後、**そのWASMを再buildせず**既存のケース集合で試験する。現在の77ケースは基準であり、将来も77件ならよいという判定にはしない。固定case ID集合/hashと必須ケース全件成功を照合する。
4. prebuilt harnessは既存のケース/fixtureを共有し、`buildFunction()` を呼ばず、固定のWASM/query/schemaをrunnerへ渡す。既存guarded runnerから起動し、前後のdigest一致、命令/入力上限も検査する。後続buildでbytesが変わったら再試験が必要。
5. manifestを作成してartifactへupload。upload後は追加build・再梱包・同じIDへの上書きをしない。workflow全体の完了成功を待って採用する。最終差分・監査・生成物の検査を省略しない。

候補と本番の権限は分ける。build jobにShopify/Render/DB/署名秘密鍵を渡さない。artifact操作のGitHub権限も必要最小限にし、build subprocessへActionsのtokenを引き継がない。

### manifest v1

| 群 | 固定する情報 |
| --- | --- |
| 出所 | repo ID/name、workflow path/ID、event、head SHA、run ID/attempt、commit側のworkflow digest、candidate/production区分 |
| ビルド | lockfile digest、Node/CLI/build/verifier version、build control審査参照、試験case集合/hashと結果digest |
| Function | handle/UID、API `2026-04`、target/export、WASM/query/schemaの相対path・長さ・SHA-256、国際policy/projection version |
| 配備範囲 | app設定の安全な正規化hash、全拡張の識別子/設定/送信対象ファイル一覧とdigest、集合digest |
| 保持 | 作成日時、artifact保持方針。実際のID/digest/失効日時はupload後のGitHub APIを正本にする |

Shopify App Versionは全設定・全拡張のsnapshotなので、Functionだけの小さなZIPをapp全体の配備物と扱わない。実際にCLIが送るreview済みの配備ディレクトリ一式を対象にし、他拡張の削除、scope/Webhook差分、dashboard管理拡張を別途検査する。未対応の拡張種別は黙って除外せずpublisherを拒否する。

canonical JSONは既存の構造化hash方式に合わせ、schemaの許可項目と集合の順序を固定する。`contentDigest` は自分自身のdigest/signature欄を除いたmanifest、`archiveDigest` はGitHubの配布archive、`wasmDigest` はWASM本体のhash。3つを混同しない。artifact IDは後から取れる外側のenvelopeに記録し、manifest内へ循環参照させない。

GitHub artifact attestationは利用可能なプラン・設定を確認できた場合の追加防御とする。初期必須は固定GitHub APIの所属・完了状態・bytes照合であり、署名provenanceだけでコードの安全性を認定しない。利用不可を署名済みと表示しない。[GitHubのartifact API](https://docs.github.com/en/rest/actions/artifacts)、[artifact attestation](https://docs.github.com/en/actions/concepts/security/artifact-attestations)

## 4. 取得と保管

- artifact IDを固定repo APIへ渡す。任意のdownload URLは受け取らない。所属run/head/attempt、expired、expires、size、digestをAPIから再取得し、実際のarchive bytesと全ファイルを照合する。
- API originから配布originへのredirectは最大3回。HTTPSとサービスが実際に使う承認済みhostだけを許可し、private/link-local IPや任意hostを拒否する。別originへGitHub認証headerを転送しない。
- 初期上限はmetadata 256KB、manifest 256KB、配布archive 64MiB、展開後128MiB/2,000ファイル、圧縮比100倍、取得合計30秒。超過は明示拒否。ストリーム途中で打ち切り、timeout後に解析を続けない。
- archiveの絶対path、`..`、symlink/hardlink、重複/大文字小文字衝突、特殊ファイル、manifest外の配備対象を拒否する。任意のarchive内scriptを実行しない。既存の構造化parserを優先し、必要な依存追加は監査/lockfile審査を省略しない。
- 正規化manifest・配備receipt・安全な結果要約は既存DBのrunに保存する。WASM/ZIPはJSONBへ入れず、固定GitHub artifactを初期の原本保管先とする。実装時にrepoが公開設定と確認できたため、artifactは公開ソース由来のFunction/UI配備ファイルとmanifestだけに限定する。receipt・実店舗観測・顧客/注文情報・本番secretはuploadせず非公開DBへ保存する。公開repoのartifactを非公開と説明しない。
- artifact保持は45日を要求するがAPIの実expiresを優先する。proofはそれより前に失効させる。削除/取得不能を検知したら依存proofの利用を止める。長期監査が必要な場合は承認された非公開保管先へ別途複製・再照合し、GitHubを永続保管と呼ばない。

検証済みのimmutable manifest/各digestは再利用できるが、artifactの存在・保持期限や取消を無期限にcacheしない。新規発行ではarchiveを取得して照合する。承認時は60秒以内のAPI metadata照合、稼働中は最大15分以内の成功記録を要求する。大きなZIPを監視のたびに実行/展開しない。期限超過・metadata不一致・取得障害の猶予終了は未確認として停止経路へ渡す。

## 5. 配備receiptと実配備の確認

### 書込み権限を持つpublisher

publisherは固定・審査済みの専用コマンド/実行環境。任意PRのscriptやartifact内コードを本番credential付きで動かさない。buildと別の新しいworkspace/processで、検証済み配備ファイルと固定CLIだけを使用する。credential投入後の `npm ci`、codegen、build、任意shell hookを禁止する。credential導入・鍵作成・実行環境の有効化は別承認。

承認対象はapp ID、exact commit、artifact ID/digest、設定/全拡張差分、stage/releaseの用途、有効期限。stageは固定version tagで `shopify app deploy --no-build --no-release` を使用し、送信対象の全digestを直前/直後に検査する。自動削除許可を付けない。タイムアウト等で結果不明なら実versionを照合するまで再送せず、UNKNOWNにする。

既存CLI 4.5.2のローカルhelpで両flagを確認した。公式にもbuild省略と非releaseが別flagとして定義されている。既存 `npm run deploy` はそのまま同じ意味ではない。[Shopify app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy)

stage後は固定app/configへ `app versions list --json` を使い、version tag/IDを独立確認する。deployの人間向けstdoutから成功文を切り出してreceiptにしない。ローカル4.5.2のlist実装は配列に `versionTag` / `status` を返し、active判定は `active`。実際の応答schema・ID・取得範囲をfixture/承認済み読取りで確認し、返らないversionや取得不完全を推定で補わない。[versions list](https://shopify.dev/docs/api/shopify-cli/app/app-versions-list)

releaseは別承認・別receiptで、指定version以外を公開しない。stage成功から自動releaseしない。Shopify配備はRender backendの配備とは別であり、両方の記録を必要とする。

### 署名receipt v1

固定JSONにreceipt ID、承認参照、publisher/key ID・version、shop/app、stage/release用途、commit、GitHub run/attempt/artifact、content/archive/WASM digest、全配備集合digest、Shopify version/結果、開始/完了時刻を含める。Render側は対象Web/Cronのservice/deploy ID、実commit、成功状態、migration versionを独立した配備記録として束縛する。

承認の実行期限 `executeBefore` と、配備を証拠として使用できる期限 `allowedUseUntil` を分けて署名する。前者は実行開始時、後者はproof発行/利用時に検査する。短期の実行tokenが失効したことだけで配備proofを失効させず、使用期限の未設定も無期限許可へ変換しない。

publisher専用Ed25519鍵で、固定domain文字列とcanonical payloadに署名する案とする。秘密鍵はpublisherだけ、app側は許可public keyとkey IDだけを持つ。Shopify secret・監視token・probe HMAC鍵を流用しない。未知/失効key、別shop/app、改変、期限切れ承認、同一receipt IDの別本文は拒否する。鍵の有効期間/失効は審査済みregistryに置き、receiptが自分の鍵を信頼登録する構造にしない。

署名は「信頼したpublisherの記録」の証明であり、侵害されたpublisherによる虚偽やShopify側の実WASMを暗号学的に証明しない。最小権限、固定コード、実行記録のレビューと実店舗試験も必要。署名秘密鍵やraw CLI/APIログをartifact・DB・メモへ入れない。

### 現在の配備を再確認する読取り経路

immutable receiptだけでは後日のrelease差替えを検知できない。専用verifierがサービス側のactive App VersionとRenderの稼働deployを再取得し、receipt・実行中backendのexpectationと照合する。環境変数に同じ値があることだけで現配備を確認済みにしない。

ブラウザ/配備CLIをWeb要求に居残りさせず、同じ固定実行基盤の読取り専用コマンドが署名付き観測を返す。新しい常駐Webサービスを必須にしない。B3で内部配送経路を接続するまではadapter未設定として拒否する。publisherの書込み/署名権限と、継続観測の読取り/観測署名権限は分離する。

観測は対象run/receipt/shop/app、active version、Web/Cron deploy、単調増加sequence、観測時刻/期限、request nonceに束縛する。確認時は60秒以内、workerの継続利用は最大15分以内とし、以前の署名を送信し直して鮮度を延ばせない。反映遅延はPENDING、非対応・取得不能はUNVERIFIED。実配備変更を検知したら停止し、旧receiptの自動再採用はしない。

nonceは観測要求側で発行する再送防止challengeで、B1の承認nonceとは別物。未来時刻や15分を超える観測TTLを拒否する。B3のprepare/refreshから新しい観測を取得できるようにし、10分ごとの古い記録だけで60秒条件を満たしたことにしない。contextの `observedAt` は読取り完了時の実観測から作り、保存済み観測を読んだ時刻への置換で鮮度を延ばさない。

実店舗ではValidation ID、唯一の対象Function ID/handle、API version、enabled、blockOnFailure、runtime error、取得できたinput queryを読む。full native検査とは別にValidationを実読取りし、共通の安全な検査DTOを作る。フィールド欠落を既定trueにしない。初期実装のquery比較は意図的に厳密なbytes/hash一致とし、空白差異も未確認にする。意味を曖昧にする文字列置換はせず、将来正規化が必要なら審査済みGraphQL parserを使う。API version/権限による取得可否は本番未確認。2026-04の公式ページ取得は成功せず、latestの存在だけで実取得済みとは扱わない。

稼働WASM digestをAdmin APIから直接取得できるとは仮定しない。同じFunction ID/queryだけでもbytes一致の証明にはならない。配備時のbytes固定、現versionの読取り、4Cの実挙動を組み合わせる。競合/反映遅延の検出窓や外部障害が残り、完全な遠隔attestationとは呼ばない。

## 6. 発行する2種類のproof

| 予約キー | 発行に必要なもの | 許可する用途 |
| --- | --- | --- |
| `INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED` | 信頼済みartifact/receipt、現配備/Validation/query、閉鎖値の読戻し、未対応販売経路の有効な外部証拠 | 停止保護の確認とVERIFY準備。SALEには不足 |
| `INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED` | 上記に加え4Cの必須case集合、対象別非課金/金融結果、注文由来・通貨・返金/台帳等、全runの閉鎖確認 | coverage内のSALE previewに使える証拠。SALE承認そのものではない |

readerの用途は `DEPLOYMENT` / `VERIFY` / `SALE` を明示する。B1の `input.purpose` と直接 `purpose` の両入口を正規化し、RESUMEは `resumePurpose` を使う。不明な用途は拒否する。閉鎖確認に最終販売proofを要求せず、VERIFYを一般販売readyにしない。

返却DTOは `ready/reason`、`releaseBinding`、scenario/verifier version、`requiredCasesHash`、厳密な `{id, revision, evidenceHash}` のproof参照、`expiresAt` とする。context側で詳細native hash、店舗timezone、実観測時刻を付ける。最大20参照等のB1制約を維持する。

国際用 `releaseBinding` は既存国内challengeと別versionのcanonical hashにし、shop/app、Web/Cron実commit、migration、Shopify version、Function/Validation識別子、artifact/全配備digest、国際policy/projection versionを含める。source/native/scopeは別hashのまま混ぜず、通常のgeneration更新だけでbindingを変えない。

DEPLOYMENT runの `scopeHash` は販売範囲ではなく店舗配備の識別用hash、`nativeConfigHash` は配備/Validation検査DTOのhashとする。承認contextの詳細native hashとは用途が違うため同一と仮定しない。配備proofがあるだけで未検査の商品/配送経路を承認せず、VERIFY/SALEでは選択scope全体の詳細native・sourceと実証拠を改めて検査する。

最終proofは商品×国×JPYに加え、provider/支払方法/配送経路種別ごとのcoverageを固定する。同じ国や通貨という理由だけで範囲を広げない。4Cが未実装なら最終proofの発行を拒否し、4B-2だけで有効化capabilityを変更しない。

## 7. 初回発行とrun lifecycle

### DEPLOYMENTの循環を作らない

1. 認証済みRELEASE_MANAGERが配備検査を要求する。専用 `DEPLOYMENT` runを作り、既存の停止要求でSTOPPEDを永続化する。承認requestは不要、VERIFY/SALEのscopeを開けない。RUNNINGのVERIFYがあれば拒否する。
2. 固定executorが別の閉鎖専用claimを使用する。B1のENFORCE/消費済みVERIFY必須claimを緩めず、DEPLOYMENT用途だけ分離する。60秒heartbeat/5分lease、DB時刻、同店舗/世代のフェンスを共有する。
3. artifact・配備・実Validationを独立検査し、現STOPPED世代の閉鎖metafieldをCAS/読戻しする。ここで発行しようとしているproof自身を前提にしない。
4. 成功なら同じSerializable transactionでrunのPASSED/closure CONFIRMED、immutable結果、最新配備attestationを確定する。現世代、lease、失効、key/依存証拠revisionを再確認し、ネットワークはtransaction前に終える。
5. workerは確定済み配備proofと現在の閉鎖/Validationを読んで保護を確認する。STOPPEDは維持し、通常承認へ自動復帰しない。

DEPLOYMENTの実行期限は最大30分で、proofの有効期限とは別。runの `expiresAt` は実行期限、attestationの `expiresAt` は証拠の期限として使う。PASSED後は期限内に実行完了したことを確認し、runの実行期限が過ぎただけで30日proofを不正に失効/延長させない。

試験runがCLOSINGで配備proof失効により止まっている場合、別の `shop:DEPLOYMENT` keyで同じSTOPPEDの再検査を許可する。現配備で停止を確認できても、旧releaseの試験をPASSEDにしない。

### VERIFYと最終証拠

成功結果の受付は固定verifierのschemaと必須集合に限定する。runnerの `passed=true` をそのまま採用しない。4Cが結果/金融probeを独立検査し、閉鎖要求前に検証済み結果digestを固定する。結果不足/期限切れ/停止競合ならFAILEDまたはEXPIREDのまま。

現B1の `recordInternationalRunClosure()` は常にFAILEDへ進むため、成功候補専用の終了処理を追加する。CLOSINGから現閉鎖世代・全必須結果・有効依存を再検査した場合だけPASSEDにする。汎用workerの `protected=true` 引数だけで合格にせず、失敗済みrunは新しいrunで再試験する。

B1の共通stopは現在の承認を取消し、runにFAILEDを設定する。このままでは正常終了も成功にならないため、検証済み結果の固定と閉鎖要求を行う専用transactionを追加する。同じstop/世代更新を再利用しつつ、対象runだけに終了候補 `VERIFIED_AWAITING_CLOSURE` と正常終了理由を残す。通常の停止/失効処理は成功候補を作れない。

正常終了による承認取消は再有効化防止のため維持する。過去結果のreaderは消費時の承認・範囲・有効期間と正常終了理由を検査し、この取消だけを過去実測の無効化と混同しない。事故停止・proof取消・期限超過による取消は成功経路へ入れない。最終閉鎖前の停止競合やsource変更で候補が失効した場合はPASSEDを発行しない。

単一runの試験合格と、販売coverage全体の証拠発行は分ける。集約には同一shop/release/policy/scenarioと互換なnative設定、全参照runのID/結果digest/未取消を要求する。最終発行のanchor runに集約内容を一度だけ固定し、全体不足なら当該runの成功だけを記録して最終proofは作らない。

## 8. 保存・原子性・取消

既存 `InternationalCheckoutVerificationRun` を正本にする。`artifactReference/hash/expiresAt` は固定GitHub artifactの参照/archive digest/保持期限に統一し、結果要約のdigestとは分ける。`resultsJson` のversion付きallowlistにmanifest、receipt、固定観測、case結果digest、依存proof/run、coverage、発行内容の安全な要約を保存する。初期上限256KB、超過は分割uploadで回避せず明示拒否する。

追加schemaはrunの `revokedAt/revokedBy/revocationReason` と、継続配備観測用の `observationJson/observedAt/observationExpiresAt` を候補とする。署名付き最新観測は最大32KBでsequence検査し、immutable試験結果とは分離する。観測更新だけでproof revisionや期限を延長しない。既存同店舗FK・activeKey・CHECKを維持し、結果/receiptはterminal後に書き換えない。

最新 `OperationalReadinessAttestation` は表示/索引用のprojection。`confirmedBy=system:international-checkout-verifier`、run ID、結果digest、依存参照、固定validity versionを専用issuerだけが保存する。人の開始actorはrunの `initiatedBy` に残す。`system:` 文字列だけで信頼せず、実run/署名/出所をreaderが再検査する。

- 発行は同一run・同一結果なら冪等。同一runの別結果は409。run PASSEDと最新attestationのrevision更新は同一transactionで、片方だけ成功させない。
- 最新行の差替えは旧revisionに紐付くpreview/承認を無効にする。使用中ならSTOPPED・承認取消・世代更新・RECONCILEを同一transactionに入れる。自動差替えで現在のSALEを延命しない。
- 取消はCOMPLIANCE_REVIEWERを再認可し、対象ID/revision/digestを条件付き更新。古い画面から最新の別proofを取消しない。runの取消履歴、最新行の取消、依存する最終proof/承認の無効化、停止jobを原子的に保存する。
- 旧runは最新行から外れても取消可能。逆に最新行だけを再発行して取消runの結果を再利用しない。取消/失効後は新しい検査とRESUMEが必要で、過去行の復活や削除では解決しない。

proof更新とconfirm/STOP/workerの競合をSerializable/既存generation・lease・CASで検査する。外部書込み後の競合窓は残るため、停止優先の再試行と読戻しを維持する。API障害でも停止要求の永続化は妨げない。

## 9. 期限と障害時

初期validity案は `international-proof-validity-v1`。配備proof・最終proofとも発行後最大30日とし、依存する実証拠/配備承認の使用期限/artifact保持期限の最小へ短縮する。artifact期限には1時間の余裕を取り、VERIFYはさらに既存48時間上限と店舗日付の切下げを適用する。これは運用上の初期上限であり、法定期限とは説明しない。

過去の実課金が再利用可能かは4Cが対象/経路/releaseで判定し、通常のgeneration更新だけで再課金しない。期限が来るたびに人の実測を機械が確認したことにしたり、期限不明の依存を無期限にしたりしない。30日経っても同じ結果を自動で日付更新する機能は今回作らない。

build限定リスク受容はbuild時点の権限・条件として検査し、その期限をruntime全体の寿命と混同しない。新規build/配備の審査要否は現在の既存policyに従う。過去の成功を理由に例外の期限/hashを延長しない。

固定エラーは `artifact_untrusted` / `artifact_unavailable` / `deployment_unverified` / `deployment_changed` / `proof_expired` / `proof_revoked` / `coverage_incomplete` 等へ正規化する。raw API応答・署名秘密・stackは返さない。監視は既存Cronへ接続し、prelaunchメール抑止を維持する。新しいメール送信経路を追加しない。

leaseや観測TTLは厳密な同時刻の購入遮断保証ではない。Cron遅延・API障害・Functionの日付単位の期限が残る。停止要求、閉鎖値の確認、Validationでの保護、一般販売可能を別表示にする。

## 10. 実装順と受入条件

次の実装は4B-2として進める。以下は内部の順序であり、毎回別の公開許可段階を増やすものではない。

1. manifest/receipt/schema/hash、固定GitHub adapterとprebuilt試験、独立artifact workflowを追加する。publisher/観測adapter未設定でも、拒否経路と出所照合を試験可能にする。
2. 閉鎖専用DEPLOYMENT lifecycle、専用issuer/reader/revoker、最小schema拡張、既存context/workerを接続する。publisher receipt作成/検証は固定CLIで実装し、実本番の書込み実行はしない。
3. 実PostgreSQLの競合・全体CIを通して候補PRにする。4B-3でUI/内部認証・観測配送、4Cで実機/金融を接続するまではcapability falseを維持する。

必須試験:

- 別repo/fork/PR/head/workflow/run attempt、未完了CI、artifact差替え、manifest/ZIP/WASM digest不一致、試験後再buildを拒否。
- 任意URL/認証header転送、redirect/private IP、圧縮爆弾/path traversal/衝突/巨大JSON、未知schema/署名key/偽receipt/再送sequenceを拒否。
- stageだけ・別active version・backend/Cron不一致・query/Validation不明・反映遅延を未確認にする。環境変数の一致だけでは合格しない。
- 初回配備proofなしでも閉鎖検査を完了できる。配備proofのみでSALE不可、4C不在で最終proof/有効化不可。旧FAILEDの成功化やrunner自己申告を拒否。
- 実PGで発行のrollback/重複、proof差替えとconfirm、取消とworker、lease失効と終了、旧revisionの取消、依存runの取消を検査する。
- 成果物取得不能/期限切れ/観測停止から停止jobへ収束する。閉鎖未確認のactiveKeyは保持し、新DEPLOYMENT検査で解消してもSALEを自動再開しない。
- 既存の全体試験、PG試験、Prisma format/validate/generate、lint/text/architecture、Function/WASM・拡張/アプリbuild、隔離runtime、production auditを維持する。UI追加は4B-3で画面試験する。

## 11. 実装完了と本番確認の境界

コード/CIで完了できるのは契約、取得/検査、専用発行/取消、閉鎖lifecycle、競合試験まで。実publisher/鍵・権限、GitHub保管範囲、サービス側version取得、実scope、承認済み配備は別の実環境確認が必要。fixture成功をこれらの確認済み記録に転記しない。

PR #51-#55の連鎖を整理し、保護されたmainと本番/候補を区別する。既存空DB migration通し適用の不整合、P01-P28、初期国/商品、金融原資、AWAITING_ORDERガード、R06は未完了のまま引き継ぐ。国内例外や海外設定を一時的に緩めて合格にしない。

今回の候補実装の検証結果とPR/CIは[進捗メモ](launch-progress.md)へ記録する。本番のDB・設定・通知・Shopify配備は未変更。次はCIで候補を確認し、4B-3/4Cへ接続する。
