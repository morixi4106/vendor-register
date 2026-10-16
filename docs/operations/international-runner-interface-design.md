# 国際販売の管理操作と検証runner接続設計

作成日: 2026-10-16 JST

状態: **4B-3は候補実装・ローカル検証済み。PR/CI確認中、本番未反映**。基準は4B-2候補 `bc20c0849b22a3b1c3baa8a2a65a7559c9c6491c`、[下書きPR #56](https://github.com/morixi4106/vendor-register/pull/56)。本番の最後の独立観測は2026-10-15 11:35 JSTで、今回再監査していない。

2026-10-17の候補実装は `agent/international-runner-interface`。専用認証/受信箱/店舗別P03、closed runner/観測配送、既存UIへ接続し、PG計39件、画面21ケース、全体1271件成功を確認した。capability固定false/空鍵registry/本番未設定は維持。検証の正本は[進捗メモ](launch-progress.md)。以下は契約を記した設計であり、実運用済みという意味ではない。

[承認設計](international-authorization-design.md)の4B-3を具体化する。[4B-2の証拠発行](international-proof-issuance-design.md)を再利用し、別の販売許可エンジンは作らない。文書の採用はmain反映、migration、credential導入、scope追加、Shopify配備/release、実決済・返金、海外有効化、通知再開の承認ではない。

## 1. 今回決める3点

1. **既存管理画面へ接続する**。配備検査、観測更新、用途別preview/confirm、停止、証拠取消を分ける。4C未実装の間はVERIFY/SALE/RESUMEをサーバーでも拒否する。
2. **実行者を認証してから内部serviceを呼ぶ**。publisherの記録配送、閉鎖検査runner、継続observerは別credential・別の許可操作。監視tokenや管理者セッションを流用しない。
3. **配送の再送と証拠の鮮度を分ける**。署名receiptは不変、観測は単回nonceとサーバー採番sequenceに束縛。受信・検査合格・実際の停止保護・販売可能を同じ成功表示にしない。

4B-3では閉鎖専用DEPLOYMENTの実行接続までを完成対象にする。4Cのbrowserシナリオ、通貨の強制、金融結果schema、正常VERIFY終了からの最終proof発行は別変更。未実装の結果受付を汎用JSON uploadで先に公開しない。

## 2. 実コードで確認した接続不足

| 箇所 | 現在 | 4B-3の差分 |
| --- | --- | --- |
| `app.international-shipping.jsx` | 配送/国別証拠、同期、停止のみ。loaderのロールはADMIN/COMPLIANCE/RELEASE | INCIDENT/RECOVERYも必要な状態を閲覧可能にし、操作別permission DTO、配備/観測/履歴/承認を追加 |
| operator authorizer | Shopify認証、user ID整合、owner/allowlist認可が既存。最初に合致したroleを返す | そのrole一つから全操作権限を推測しない。共通の判定を使い各permissionを計算し、POSTでも再認可 |
| 管理POSTの保護 | POST/32KB制限は既存。route独自のOrigin検査はない。SDKはheaderとURLのsession tokenを処理 | 新たな操作と同画面の変更操作をheaderの認証済みsession tokenに統一し、Origin/CSRF対策を明示 |
| `createInternationalProofCommands().prepare` | 内部引数はartifact IDと署名receipt。認証後に検査しrunを作る | browserへreceipt入力欄を出さず、認証済み配送で保存したIDからサーバー側で解決。開始の再送を冪等化 |
| DEPLOYMENT claim/complete | HTTP認証なしの内部関数。claimのexecutorは固定 | 専用runner認証、店舗・run・世代・lease・失効のフェンスをHTTP境界にも適用 |
| 観測更新 | PASSED runのnonceを発行/記録可能。要求のたびに上書きし、sequenceは呼出側が指定 | UIの更新要求とobserverのchallenge取得を分離。競合中のnonceを上書きせず、DB側から次sequenceを返す |
| P03証拠 | issuerはSHOP/認証済みshopの証拠を要求。通常フォームはPLATFORM/GLOBALへ保存 | 同じ確認項目を店舗別に登録する専用操作。全体証拠の自動コピーは禁止 |
| heartbeat/終了 | 内部関数はあるが、heartbeatだけでは現在のgate世代や取消を全て検査しない | kind別の現run/世代/取消/leaseをtransaction内で再検査。既存関数の無条件な公開は禁止 |

既存の国別配送/市場証拠には全体設定のデータもある。今回追加する店舗別run/receipt/承認と混同せず、既存データ全体のtenant化は別の無関係な改修にしない。

## 3. 管理画面とロール

既存の `/app/international-shipping` に「配備と保護」「検証履歴」「承認範囲」の3領域を加える。routeの行数上限を増やさず、表示component、読取りDTO、action dispatcherへ分ける。既存Polarisを使い、見出しは通常サイズ、領域は入れ子のCardにしない。

| intent | 必要権限 | browserから受け付ける主な値 |
| --- | --- | --- |
| `recordInternationalSurfaceEvidence` | COMPLIANCE_REVIEWER | 固定P03項目の証拠参照/hash、確認内容、expectedVersion |
| `prepareInternationalDeployment` | RELEASE_MANAGER | delivery ID、expected receipt digest、開始操作のrequest key |
| `revokeInternationalProofDelivery` | COMPLIANCE_REVIEWER | delivery ID、expected digest。原本の取消と依存run/proofの無効化 |
| `refreshInternationalProofObservation` | RELEASE_MANAGER | run ID、expected result digest。要求を保存するだけ |
| `previewInternationalAuthorization` | RELEASE_MANAGER、RESUMEならRECOVERY_APPROVERも | 用途、scope、JPY、希望期限、verification kind等のB1固定schema |
| `confirmInternationalAuthorization` | 上と同じ | 保存済みrequest ID、nonce、intentだけ |
| `stopInternationalSaleGate` | INCIDENT_COMMANDER | intentだけ。現在proofやcapabilityが不明でも停止受付可能 |
| `revokeInternationalProof` | COMPLIANCE_REVIEWER | run ID、result digest、expected proof参照またはnull |
| `syncInternationalSaleGate` | RELEASE_MANAGER | 既存の現在承認・世代の再同期のみ。新規承認や停止解除には使わない |

viewerは上記業務ロールまたはADMIN。owner/共通管理者による既存の複数権限を許すが、別人の二重承認とは表示しない。finance権限、MFA設定、既存のhold復旧権限は増やさない。

### 表示DTOと操作の状態

- loaderは同店舗のgate、直近20件のrun/承認/配送記録、安全なproof要約を明示selectし、上限付きcursorで履歴を読む。国別の既存表示は維持する。
- 表示はrelease短縮SHA、version tag、国/商品件数、JPY、期限、観測時刻、要求/反映世代、失敗codeを日本語へ対応させたもの。`resultsJson`、署名envelope、nonce、lease、secret、内部サービス応答、operator emailをそのまま返さない。
- 「配備記録受信」「閉鎖検査待ち/実行中」「配備検査合格」「観測待ち/期限切れ」「検証機能未完成」「停止受付/反映中/保護未確認/停止確認済み」「一般販売未承認」を分ける。配備合格でも `saleReady=false`。
- cap固定falseの間は承認ボタンを無効にし、理由と次の確認先を表示する。hidden fieldや直接POSTも422で拒否し、preview要求/run/nonceを作らない。外部設定に実装済みと誤認させるoverrideを加えない。
- capability完成後のpreviewは、対象、実効期限への切下げ、用途、依存証拠、実露出を確認してから別confirm。古いnonceの自動作り直し/再承認は禁止。confirm再送は同じ保存結果を返すだけ。
- GETと自動pollは読取りのみ。画面を開いたことを観測更新・同期・証拠発行・通知送信の契機にしない。pending時のみ5秒間隔で最大2分pollし、非表示tabで停止。期限切れの観測は明示更新を求める。
- 停止操作は他フォームのpendingやcapability不足で隠さない。新規開始と取消は対象を確認し、二重クリックを抑止するが、正しさはDBの冪等性/競合制約で担保する。

### 管理POSTの認証

`requireMarketplaceOperator` とB1/B2 factoryの再認可を維持する。同梱SDKではsession tokenのheader経路を確認したが、独自Origin保護が既存と仮定しない。画面の変更送信はApp Bridgeのtokenをメモリで取得してAuthorization headerへ付ける共通submit経路に統一する。SDKで検証したshop/subとoperatorを使い、POST本文・queryのshop/actor/roleは採用しない。

固定app originと異なるOrigin、`null` Origin、cross-site送信を拒否する。Originがない非browser要求も有効なheader session tokenが必要で、cookieやURL tokenのみへのfallbackはしない。tokenをURL、localStorage、hidden input、ログへ置かない。APIレスポンスの認証失敗は401/403、正常時/失敗時とも `private, no-store`。実装時にShopify内の実際のForm/fetcher経路でtoken付与と再認証を試験する。

## 4. 専用実行者の認証

`internalRouteSecurity.server.js` の定数時間比較を再利用するが、専用wrapperで正しいBearer形式を必須にする。secretは32byte乱数の64桁hex。transport tokenとEd25519署名鍵は別物で、appへ署名秘密鍵を入れない。

| principal | 追加する設定名案 | 許可範囲 |
| --- | --- | --- |
| publisher-ingest | `INTERNATIONAL_PROOF_PUBLISHER_INGEST_TOKEN` | 署名済みRELEASE receiptの配送だけ。配備実行/承認/claim/観測更新は不可 |
| deployment-runner | `INTERNATIONAL_PROOF_DEPLOYMENT_RUNNER_TOKEN` | 閉鎖専用DEPLOYMENTの取得、claim、heartbeat、complete、失敗閉鎖要求 |
| observer | `INTERNATIONAL_PROOF_OBSERVER_TOKEN` | PASSED DEPLOYMENTの更新対象取得、challenge、署名観測提出、固定失敗通知 |

設定名は候補であり、今回secretを作成/登録しない。server設定でprincipalを固定の対象shop/app・操作集合へ束縛する。クライアント指定のshop、executor、鍵、HTTP先、shell commandを採用しない。複数店舗を扱う場合は店舗別credentialを別登録し、一つのtokenで任意店舗を指定させない。

未設定/不正設定は503、認証不一致は401、用途外は403。3つのtoken相互と既存監視tokenの同値を拒否する。署名public keyはB2の審査済みregistryが正本で、env/bodyから信頼鍵を挿入しない。現在の空registryのままなら実行は拒否される。

既存DB rate limitを用途別namespaceで再利用する。認証後はprincipal/shop単位で60要求/分、receipt配送は10件/分、画面からの新規検査/refreshは各5回/分を初期上限とする。STOPはこの開始/更新の枠と共有せず、DBの単一停止状態に収束させる。超過は429/Retry-After。認証前の攻撃対策はプラットフォーム側も必要で、任意入力ごとにDBキーを無制限作成しない。

## 5. Receiptの受信箱と開始の冪等性

新規は汎用証拠台帳ではなく、**`InternationalProofDelivery` 1モデルの受信箱**に限る。B2のrunは検査開始後にしか存在しないため、管理者が選ぶ前の署名receiptを安全に保持する用途が必要になる。run/attestation/承認モデルを置き換えない。

| 群 | 保存する内容 |
| --- | --- |
| 識別 | server ID、shop/app、publisher receipt ID、固定schema version |
| 不変本文 | 32KB以内の署名receipt、canonical digest、artifact ID、commit、version、allowedUseUntil |
| 配送履歴 | 受信時刻、認証したprincipal ID、取消時刻/固定理由。secret/生HTTP/CLIログは保存しない |
| 制約 | `(shopDomain, receiptId)` unique、`(shopDomain,id)` unique、runから同店舗composite FK/Restrict |

内部 `POST /internal/international-proof-receipts` はJSONの署名envelopeのみを受け取る。最初に専用認証し、本文32KB・receipt envelope単体24KB、未知/重複field、signature、RELEASE用途、認証設定のshop/app、期限を検査する。24KB制限はrunner応答/観測入力の32KB枠へ識別子等も収めるため。artifactと実配備の全照合は後のprepareでも行うため、受信箱への保存は合格ではない。

同じreceipt ID/本文の配送再送は同じIDと既存状態を返す。異なる本文は409、取消済みを再送しても復活しない。未参照の有効な受信待ちは店舗当たり100件に制限し、履歴のページングと期限切れの整理を設ける。参照済みの原本は証拠保持期間中削除しない。GitHubは公開repoのため、receipt/観測はActions artifactへuploadしない。

受信箱の取消は認可済みの管理操作だけ。expected digestを照合し、該当delivery、依存run、使用中の最新proof、gate停止/世代/jobを同じtransactionで更新する。専用issuer/readerもdeliveryの未取消を検査する。B2の取消helperを再利用可能に分け、runを一件ずつ別transactionで取消して部分成功にしない。

prepareはdelivery IDとexpected digestから本文をDBで解決する。開始操作のrequest keyはbrowserが一操作ごとに生成するUUIDで、認可secretではない。runへ `proofDeliveryId` と `preparationRequestKey` を追加し、店舗/request keyのuniqueと保存済みactorの照合で重複開始を防ぐ。同じkeyの再送は過去の受付と現在状態を返し、停止世代やrunを増やさない。別actorや同じkeyの別対象は拒否する。

B2 prepareを拡張し、外部取得の前に再送を判別し、確定transaction内でもdelivery digest/取消/使用期限、actor/request key、現在run、P03、世代を再検査する。run作成とrequest key固定を同じSerializable transactionにする。「別serviceで事前に調べたから安全」とはしない。receiptの使用期限を過ぎた再送でも過去の受付参照は返せるが、新規実行を許可しない。

新規列は旧履歴に対してnullableで追加するが、delivery参照のない旧runを自動で新方式の合格へ移さない。専用readerでは未確認とし、採用する場合は正規配送と新しい検査が必要。NULL列や旧内部prepareをHTTPから使う互換バイパスは置かない。

## 6. 内部APIと閉鎖検査

内部routeも全てPOST、JSON、32KB、unknown intent/fieldと重複scalarを拒否。固定CLIは正準JSONを送信し、serverはparse後の正準表現との完全一致で重複keyも拒否する。GET/未使用methodは405、CORSで外部browserへ開放しない。認証前のDB/Shopify/外部fetchは禁止。レスポンスは全て `no-store`、raw error/receipt以外の外部本文は返さない。

| route | intent | 契約 |
| --- | --- | --- |
| `/internal/international-deployment-runner` | `next` | 認証設定の同店舗QUEUED DEPLOYMENTを最大1件の安全な要約で返す。claim/nonce発行はしない |
| 同上 | `claim` | run IDだけ。固定executor、同世代STOPPED、未取消、期限内を検査。lease/nonceと最小の観測入力を一度返す |
| 同上 | `heartbeat` | 現run/世代/取消とleaseを再検査し、期限内だけ延長。保護/成功を更新しない |
| 同上 | `complete` | run IDと署名observer観測。leaseは専用header。B2の独立照合・閉鎖CAS/読戻し・原子的issuerへ接続 |
| 同上 | `fail` | 現run/leaseと固定failure codeのみ。STOPPED/CLOSINGと閉鎖jobを保存し、PASSEDは作らない |
| `/internal/international-proof-observer` | `next` / `challenge` / `record` / `reportFailure` | PASSED runの観測更新専用。承認、run合格、proof期限更新、Shopify書込みはできない |

lease headerは `X-International-Lease` 案で64桁hex。Authorizationとともにloggerのredaction対象へ追加する。serverはexecutorを固定し、bodyのexecutor IDやgenerationで値を差し替えない。heartbeatはB1関数をそのまま外部公開せず、kind/activeKey/現在gate世代/取消を同一transactionで確認する。

DEPLOYMENT claimは5分lease・run全体30分、観測challengeは60秒。claim応答を失った場合、lease原文を再発行しない。期限切れから既存Cronが閉鎖処理へ進み、閉鎖未確認のactiveKeyを手動で解放しない。complete応答消失は同じ観測で過去結果へ収束させ、再発行や再有効化をしない。

claimの観測入力は保存済みreceipt、run ID、nonce、serverが決める初回sequence=1、固定app/config参照だけ。秘密値の応答はこの認証済み経路に限定し、browser DTOには入れない。B2 completionへは観測の鮮度に加え、初回nonceの発行から60秒以内・sequence=1の検査も最終transactionまで追加する。現在artifact/サービス/実Validation/閉鎖値/P03と元のleaseも再検査する。確認が終わってもgateはSTOPPEDのまま。

既存の停止worker、失効検出、世代/CAS、source変更時の無効化を共用する。通常VERIFYのclaim/結果/正常終了用HTTP入口は4Cまで接続しない。未実装入口へ自己申告caseや `passed=true` を送っても422となり、B1のFAILED終了を成功へ変更しない。

## 7. 観測の要求・実行・再送

### UI要求とchallengeを分離

runへ `observationRefreshRequestedAt`、`observationRetryAt`、固定 `observationFailureCode` を追加する。既存のnonce hash/発行時刻/保存済み署名観測は再利用する。新しい汎用jobモデルは増やさない。

1. UIのrefresh POSTは同店舗の未取消PASSED DEPLOYMENTとresult digestを検査し、更新需要だけ保存して202を返す。重複要求はまとめ、進行中のnonceを破壊しない。
2. 固定observerのnextは、明示需要、または現在のENFORCE/VERIFYが参照し期限接近した配備runを選ぶ。未使用・DISABLED・STOPPEDの古いrunを恒久的に巡回しない。
3. observerが実行可能になってからchallenge POST。Serializableで未完了challengeがないことを確認し、32byte nonce/hashとDB時刻を保存、`last accepted sequence + 1` とreceiptを返す。60秒はUIで押した時ではなくここから数える。
4. reader CLIがサービス側active version/Web/Cronを取得し、B2の固定schemaで署名する。recordは現在nonce、**期待sequenceとの完全一致**、requestedAt以降の実観測、期限、同店舗/receiptを検査して単回消費する。単に「前より大きい」だけの採番はやめる。
5. 新しい観測の保存と需要の解消を同じtransactionで行う。応答消失時の同一署名再送は過去受付を返すだけで、observedAt/期限を現在時刻へ書き換えない。古いnonce、別sequence、別署名、取消との競合は拒否する。

challenge進行中の別要求は409/Retry-After。同じ原文nonceを再読取りできない。60秒経過したchallengeだけ新規発行でき、古い結果の採用は不可。観測更新はrunのresult digest、proof revision、proof期限、承認期限を更新しない。

### 失敗と実行基盤

確実なrelease/サービス不一致の報告は固定codeで現在の依存runへ束縛し、停止要求を永続化する。署名検査失敗やtimeoutから成功は作らない。一時的な取得失敗は最終成功時刻を維持し、最大15分という既存の有効観測期限を超えたら利用不能・停止経路へ渡す。失敗codeの保存でもnonce/現在runをフェンスし、旧runの遅延報告で新しいrunを上書きしない。

観測executorは固定コードのbounded CLIとする。既存observerを起動する親commandが認証済みAPIをpollし、署名子processには読取りtokenとobserver鍵だけを渡す。publisherの書込みcredentialは置かない。同じhost上のprocess分離はhost侵害への独立防御ではなく、P06で実行基盤/鍵管理を別途確認する。

`--once` は少数taskを処理して終了、監視用のbounded loopは最大10分で終了してschedulerが再起動する案とする。定期実行は有効用途の観測を約5分ごとに更新する目標で、既存カタログworkerは停止/失効だけを継続する。Web/HTTP/Cron handler内からCLIやbrowserを起動しない。新しい常駐Webサービスは必須にしないが、実際にこのcommandを動かす管理されたschedulerは必要で、GitHub定期実行だけの即時性を仮定しない。

起動待ちの時間は観測鮮度に算入しない。UIは待機状態を表示し、観測後もpreview/confirm各時点で60秒以内を要求する。時間を過ぎたら新しい観測が必要で、10分nonce TTLを理由に古い観測を許可しない。実行基盤が未設定/停止なら待機/未確認となり、readyへ進まない。5分目標や最大15分の観測期限は厳密な遮断時刻の保証ではない。

transportは固定HTTPS app origin・固定path、redirect禁止、応答32KB、外部処理全体にdeadlineを設定する。外部取得を含むprepare/completeは合計45秒を目標上限とし、個別timeoutを直列に足して無制限化しない。DB transactionは既存15秒上限。timeoutの結果不明はまず状態を照会し、再配備や新しい開始操作へ自動変換しない。

## 8. 店舗別P03の接続

新しいP03操作はcheckKeyを `UNSUPPORTED_SALES_SURFACES_DISABLED`、scopeを `SHOP`、scopeIdを認証済みshopへ固定する。実際に調べた対象経路、保存先、SHA-256、確認内容、actor、既存定義の有効期限を記録する。実地確認が未実施ならCONFIRMEDにしない。国別証拠やチェックボックスからの自動作成は不可。

現在の汎用 `recordOperationalReadinessAttestation` はrevision競合/国際停止をこの用途向けに実装していない。SHOP/P03のwriteは専用transaction helperへ統一し、expectedVersion再検査、毎回revision増分、影響する国際承認の無効化/停止job登録を同じtransactionにする。汎用入口からこのSHOP項目を無条件upsertできる経路は拒否または同じhelperへ統一する。旧PLATFORM/GLOBAL証拠を編集/コピーして代用しない。

UIで確認項目の証拠が揃っても、それだけでは配備検査合格にならない。issuerが同じID/revision/hashと有効期限を再検査する。既存国内readinessの適用判定や他の実地証拠の挙動は今回無関係に変えない。

## 9. 実装順と受入条件

| 単位 | 実装対象 | 完了条件 |
| --- | --- | --- |
| 4B-3A | 専用認証、receipt受信箱、prepare再送、SHOP/P03、内部route | 実PGで同時配送/開始、同店舗FK、revision/停止競合を検証。cap false/信頼鍵空では有効化不可 |
| 4B-3B | 閉鎖runner、観測challenge配送、bounded CLI、失敗/失効 | 認証とlease、nonce非上書き、採番、応答消失、期限切れ、遅延結果を検証。DEPLOYMENTだけ合格可能 |
| 4B-3C | 管理DTO/component/action、権限別UI、承認接続 | 320/375/1440px、実submit認証、二重操作、未確認/待機/停止表示を検証。4Cロックと金融境界を維持 |

新規ファイル案は `internationalRunnerAuthentication.server.js`、`internationalProofDelivery.server.js`、`internationalRunnerInterface.server.js`、画面用DTO/action/component、3つの薄い内部route、`international-proof-agent.mjs`。既存B1/B2 serviceへ必要なtransactionフェンスを加えるが、巨大なHTTP/runner兼用moduleや新しい許可エンジンにしない。

必須の負例/競合試験:

- 未認証、監視token、別用途token、別shop/app、未設定/共通secret、未知intent/field、32KB超、重複scalar、Origin不正、URL tokenのみを拒否。拒否前に外部アクセスや状態変更がないことを確認。
- 配送の同一再送/同ID改変、別actorの開始request key、同時prepare、古いdelivery取消、期限切れ、transaction rollback。受付応答消失後もrun/世代は一つ。
- P03の旧GLOBAL流用、SHOP差替え、同hashの期限/内容更新、revision競合、取消とcompleteの同時実行。汎用入口の迂回を拒否し、停止jobを部分確定しない。
- runnerの他kind claim、executor偽装、失効lease、取消後heartbeat、世代変更、STOP競合、claim応答消失、complete再送。閉鎖未確認のactiveKeyを保持。
- 2つのrefresh/observerが競合、nonce応答消失、sequence飛越し、nonce/署名の遅延再送、記録応答消失、未来時刻、60秒/15分境界、外部取得不完全。古い観測を現在時刻で延命しない。
- cap falseで全preview/confirm/通常VERIFY開始を拒否。正しい署名receipt/DEPLOYMENT合格/管理者roleがあってもSALE/正常VERIFY proofは作られない。
- DTO/HTML/ログ/例外に署名payload、token、nonce、lease、顧客情報がないこと。狭幅、長いversion/国名、履歴空/多件、ボタンpending、停止操作の到達性をPlaywrightで検証。

全体/service/route、専用PostgreSQL、Prisma validate/generate/migration、lint/text/architecture、既存WASM/prebuilt/拡張/アプリbuild、隔離runtime、production auditを維持する。quality.yml、package/lockfile、ビルド例外の期限/条件を黙って変更しない。migrationは旧空DB履歴の不整合と今回delta試験を区別する。

## 10. 残る本番条件

4B-3の候補実装はローカル検証済み、PR/CIは確認中。4C、P01-P28、R06、本番反映は未完了。専用credential/公開鍵registry、読取り可能な実token、固定executorのscheduler/稼働記録、実scope/Validation/query、対象国/商品と外部証拠は別の確認対象である。

受信箱は有効な未使用100件/店舗を上限とし、取消/期限切れは選択・利用対象外にする。履歴原本の自動削除は実装せず保持する。仮データ用previewはloopback限定で、実Shopify認証/本番APIを呼ばない。実埋込み画面の再認証、読取り権限、scheduler稼働は外部確認に残す。

候補PRを4B-2の上へ積み、依存PRのretarget/rebaseとCIを経てmain反映を判断する。productionへのmigration/鍵/権限/配備は別承認、海外閉鎖状態で実値を確認する。新規受信箱の行やfixture結果を本番の検査済み証拠としない。

prelaunch通知抑止、自動マージ/自動公開無効、第三者販売無効、既存AWAITING_ORDERと国内ガードを維持する。新しい背景処理から自動メールを送らない。次の作業と検証記録は[進捗メモ](launch-progress.md)を入口に更新する。

## 11. 候補の操作手順

実運用の設定・鍵登録は別承認。app側には3つの専用transport token、固定primary shop/appとGitHub読取り設定を置く。publisher/observerの信頼public keyはコードregistryを審査して導入し、秘密鍵をapp・build・公開artifactへ渡さない。現状の未設定では503または未確認となる。

- 配備後の署名RELEASE receiptの配送だけ: `node scripts/international-proof-agent.mjs publisher --deliver receipt.json`。既存publisherのstage/releaseはこれとは別の承認済み実行。
- 閉鎖検査を管理画面から開始後: `node scripts/international-proof-agent.mjs deployment --once`。
- 明示refreshまたは有効承認の継続観測: `node scripts/international-proof-agent.mjs observer --once` / `observer --loop`。loopは最大10分枠で、新task用に通信/署名の時間を予約して早めに終了する。実schedulerは未設定。
- 上記agentは `INTERNATIONAL_PROOF_APP_ORIGIN` の固定HTTPS先だけへ送信しredirectを拒否する。署名子processへ渡すread token/keyはB2 observerと同じで、transport/publisher書込みcredentialは渡さない。
- 画面確認: `node scripts/preview-international-runner.mjs`。loopbackの仮データだけを使い、本番の証拠作成/送信をしない。画面試験scriptは `INTERNATIONAL_PLAYWRIGHT_MODULE` に既存のPlaywright moduleを指定して実行する。
