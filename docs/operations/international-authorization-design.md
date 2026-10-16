# 国際販売の承認と検証証拠の詳細設計

作成日: 2026-10-16 JST

状態: **4B-1はPR #55、4B-2はPR #56で候補CI成功。4B-3はPR #57で候補CI成功、4Cは未実装、本番未反映**。基準は4A候補 `5a0d632` と文書追記 `255b6f5`、[下書きPR #54](https://github.com/morixi4106/vendor-register/pull/54)。4B-1は `agent/international-authorization` の[下書きPR #55](https://github.com/morixi4106/vendor-register/pull/55)。本番の最後の独立観測は2026-10-15 11:35 JSTであり、現在の稼働状態を再確認した文書ではない。

[4A-4C全体設計](international-release-verification-design.md)の4Bを実装単位まで具体化する。既存の適格性・国別証拠・閉鎖後同期を再利用し、別の販売許可エンジンは作らない。設計の採用は公開・配備・scope追加・海外有効化・実決済・返金・通知再開の承認ではない。

4B-2の具体的な発行契約・成果物固定・署名配備receipt・閉鎖専用run・取消は[システム証拠発行設計](international-proof-issuance-design.md)を参照。4B-1候補 `6ddc76c` を土台に候補実装・隔離PG・CI3本を検証した。実環境の確認と4B-3/4Cは未完了。

4B-3の実装基準は[管理操作とrunner接続設計](international-runner-interface-design.md)。4B-2候補 `bc20c08` から専用配送受信箱、店舗別P03、管理POST認証、nonce競合/再送と内部APIを候補実装した。以下の概要と異なる接続詳細は同設計を使う。4B-3はローカル検証と候補CI3本が成功、4Cと本番確認は未完了。

## 4B-1の候補実装 2026-10-16

- migration `20261016120000_international_authorization` で2モデル、同店舗の参照制約、用途/状態のCHECK、state/jobの承認IDを追加。公開条件のschema versionも追従。本番には未適用。
- 認証済みshop/actorを使うコマンドfactory、nonce hash/10分TTL、Serializableでのsource/proof/generation再検査と単回消費、承認/世代/job/runの原子的作成を追加。RESUMEは両権限と実際の閉鎖確認を要求する。
- 既存workerへ承認ID/用途のフェンス、QUEUEDの許可反映禁止、runの失効/終了による永続STOPPED、閉鎖未確認時のretryを接続。VERIFYを一般販売readyと表示しない。旧actor文字列だけの承認関数は拒否専用へ変更した。
- proof adapterと4C capabilityの既定は未対応として拒否。汎用attestationで国際2キーを作れない。内部claim/heartbeat/終了はあるが、runner HTTP認証/API、成功結果受付、証拠発行、管理UIは4B-2/3・4Cに残る。B1のrun終了だけではPASSEDを発行しない。
- ローカル全体1244件中1239成功、既存Windows依存skip4と専用PG試験の未設定skip1。専用の隔離PostgreSQL試験は別実行で11件成功。Function/WASM77件、Prisma validate、lint/text/architecture、アプリbuildと隔離runtimeも成功。通常モードのproduction auditはartifact/build審査情報の更新を要求して拒否し、例外は緩和していない。
- 新規空DBへの旧migration通し適用には既存の `Product` テーブル名不整合がある。前commitのschemaを隔離DBに作り、今回のmigrationを適用して制約と競合を検証した。CIにも同じ専用PostgreSQL試験を追加。既存migrationの全履歴修復や、本番migration成功の証明ではない。
- 候補 `7ca46de` の[Quality checks 38900277480](https://github.com/morixi4106/vendor-register/actions/runs/38900277480)はSUCCESS。Linux1242件成功・skip2、WASM77件、拡張/アプリbuild、隔離runtime、既存条件付き審査でのproduction auditも成功。[独立PG試験 38900277332](https://github.com/morixi4106/vendor-register/actions/runs/38900277332)は11件成功。初回のbuild control fingerprint不一致は、PG試験を独立workflowへ分離して修正した。品質workflow、package/lockfileと既存の例外条件は変更前と同一。

## 1. 決定事項

1. **検証と販売を分離する**。VERIFYは非公開店舗の限定試験、SALEは一般販売の範囲承認。試験成功から自動SALE移行しない。停止後は別のRESUME承認を要求する。
2. **承認と証拠を永続化する**。10分で失効する単回承認要求と、実行ごとの検証履歴を追加する。承認・世代更新・同期ジョブ作成を同一DB transactionで確定する。
3. **実測からだけシステム証拠を発行する**。固定CIと配備記録、認証されたrunner、実店舗読取りを突き合わせる。4Cが未実装・実設定が不明なら、UI/APIとも有効化を拒否する。

非課金試験でもゲートを開けば、他のパスワード保有者が注文できる可能性はある。runnerが課金しないことと、店舗全体に課金が発生しないことを同一視しない。Shopifyのパスワードを試験者専用の認可境界とは扱わない。

## 2. 既存実装からの差分

| 既存箇所 | 確認した現状 | 4Bで加えるもの |
| --- | --- | --- |
| `internationalGateAuthorization.server.js` | 最終証拠を読む関数と内部範囲承認のみ。actor文字列だけではロール認可にならない | 用途別のproof検査、preview/confirm、認可済みコマンド境界 |
| `internationalGateQueue.server.js` | Serializable、世代、停止優先、旧job無効化が既存。DISABLED中の証拠変更では世代を増やさない | confirm時のsource再計算、承認IDのフェンス、検証終了の永続停止 |
| `internationalGateSync.server.js` | 閉鎖、商品反映、再検査、全店反映。期限更新も同じ経路 | VERIFYのrunner lease/非公開検査、SALEの最終証拠、停止理由別の再開禁止 |
| `internationalCheckoutInspection.server.js` | 閉鎖保護の確認にも最終販売証拠を要求 | 閉鎖値、配備保護、検証中、一般販売準備を別の結果にする |
| `marketplaceOperatorAuthorization.js` | ロールallowlistに加えaccount owner/共通管理者を許可 | 同じ既存認可を使用。ownerの複数権限を別人による二重承認とは表示しない |
| `operationalReadiness.server.js` | 汎用フォーム由来の証拠と、専用probe由来の証拠が混在 | 国際2キーは専用発行に限定。取消も履歴と同期を残す |
| `.github/workflows/quality.yml` | 現在のuploadは監査用JSON、保存45日 | Function本体/query/schema/policyとmanifestを束ねた専用artifact。既存CI成功だけでは代用不可 |

## 3. 用途と停止からの再開

承認要求の `purpose` は `VERIFY` / `SALE` / `RESUME`。RESUMEだけは `resumePurpose=VERIFY|SALE` を必須にし、実際の有効化条件にはその用途を使う。金融試験か非課金試験かはVERIFYの `verificationKind` で区別する。

| 操作 | サーバーで再認可する権限 | 条件と副作用 |
| --- | --- | --- |
| 配備検査の開始/閉鎖準備 | RELEASE_MANAGER | 専用runを作る。既存の明示停止コマンドで閉鎖を要求。公開・有効化はしない |
| VERIFY preview/confirm | RELEASE_MANAGER | 現在の配備証拠、非公開確認、適格性、露出制御が必要。一般販売判定はfalse |
| SALE preview/confirm | RELEASE_MANAGER | 最終証拠と適用する公開条件、対象別coverageが必要。パスワード解除はしない |
| 停止 | INCIDENT_COMMANDER | nonce/現在のproofがなくても要求可能。停止の受付と実際の保護確認は別 |
| RESUME preview/confirm | RECOVERY_APPROVERとRELEASE_MANAGERの両方 | 同一actorを両権限で個別に認可し、用途に応じた現在の証拠を再検査。二人必須にはしない |
| 証拠の取消 | COMPLIANCE_REVIEWER | 最新証拠を取消し、使用中の承認を停止。同じ証拠を復活させず、新しい検証が必要 |
| 実決済/返金 | 既存finance各ロール | ゲート承認とは別の承認・原資・実露出上限を要求。4Bで権限を拡張しない |

STOPPEDなら初回準備後でも通常のVERIFY/SALE confirmを拒否し、RESUMEを要求する。「初回だから」の復旧権限例外は作らない。RESUMEでも既存の全店緊急holdや法務/配送holdを解除しない。それらは既存の別復旧手続きが必要。

## 4. 永続データ

追加は既定の2モデルと既存状態の拡張に留める。4B-1で候補schema/migrationへ実装した。本番にはまだ存在すると扱わない。配備runの実行と成功証拠の保存は後続adapterへ接続する。

### InternationalGateAuthorizationRequest

| フィールド群 | 内容 |
| --- | --- |
| 識別/認可 | `id`, `shopDomain`, `actorKey`, `purpose`, `resumePurpose`, `verificationKind`, 認可結果の最小snapshot |
| 承認内容 | 正規化scope JSON/hash、許可通貨、requested/effective expiry、金融用の別承認参照、停止からの再開対象ID |
| 変更検出 | `expectedGeneration`, `sourceHash`, 選択証拠のID/revision/hash、詳細native hash、release/配備proof binding、店舗timezone |
| 単回性 | 32byte乱数の `nonceHash`、`previewExpiresAt`, `consumedAt`, `consumedGeneration`, 固定のresult code |
| 履歴 | `createdAt`, `revokedAt`, 固定の取消/失効理由。承認後にscopeやactorを上書きしない |

scopeは既存200商品/128国/256商品国組合せと32KB本文制限の両方に従う。通貨は4Cの初期allowlist `JPY` のみ。previewの選択可能表示と、Functionが実際に制限する通貨を一致させる。

nonce原文はpreviewの非キャッシュ応答で一度だけ返し、URL・ログ・監査snapshotに入れない。再読込で失ったら新しいpreviewを作る。承認済みrequestは監査用に残し、再利用しない。取消は削除ではなく追記可能な固定フィールドと既存監査記録で表現する。

### InternationalCheckoutVerificationRun

| フィールド群 | 内容 |
| --- | --- |
| 種別/束縛 | `id`, `shopDomain`, `kind=DEPLOYMENT|NON_FINANCIAL|FINANCIAL`, `authorizationRequestId`, `initiatedBy`, `executorId`, scenario/verifier version |
| 検証対象 | scope/release/native/配備proofのhash、開始世代、最終閉鎖世代、固定の必須シナリオ集合hash |
| 実行制御 | `activeKey` unique、状態、開始/最終heartbeat/期限、lease tokenのhash/期限、停止要求/閉鎖確認日時 |
| 結果 | 固定schemaのcase別結果、実行段階、件数、failure code、非公開artifactのID/digest/保持期限、既存金融probe参照 |

DEPLOYMENTだけはauthorization参照をnullにでき、海外閉鎖のまま実行する。これにより「承認に必要な配備証拠を承認済みrunからしか作れない」という循環を避ける。その他は消費済みVERIFY要求に必ず紐付ける。FINANCIALも支払・返金の正本は既存 `ProductionTransactionProbe` とし、取引内容を重複保存しない。

試験runの `activeKey=shopDomain:VERIFY` は同一店舗の未完了runでのみ設定し、DB unique制約で並行実行を防ぐ。失敗・期限切れでも閉鎖未確認なら解放しない。新しい試験を始めるために古いrunを消さない。停止確認を終えたterminal runだけ解放する。

配備検査は別の `activeKey=shopDomain:DEPLOYMENT` とし、VERIFYのRUNNING中には開始しない。CLOSING/閉鎖未確認時の配備再検査は許可し、海外を開けず同じSTOPPEDの閉鎖世代を検査する。これにより「配備proof失効で閉鎖確認できず、新しい配備検査も開始できない」行き詰まりを避ける。現配備で閉鎖できても、旧releaseの試験結果をPASSEDへ変えない。

request/runの `(shopDomain,id)` をuniqueにし、店舗を含めたrelationで他店舗参照を拒否する。履歴参照の削除はRestrict、cascadeで消さない。状態・用途・日時の整合はDB制約とservice双方で検査する。JSON内のproof参照もtransaction内で同店舗・実在・digestを検証する。

### 既存モデルの拡張

- `InternationalGateSyncState`: `authorizationRequestId`, 有効用途、`verificationRunId`, 固定の停止理由/時刻を追加。既存generation・lease・expiry・modeを再利用する。
- `InternationalGateSyncJob`: 作成時のauthorization request IDを保存し、処理ごとに現在のID/generationと一致確認。旧jobのnonce消費結果から再許可しない。
- `OperationalReadinessAttestation`: 最新判定の表示用。専用issuerがrun ID/digestとrevisionを保存し、成功の履歴本体はrunに残す。新しい汎用証拠テーブルは増やさない。
- 未設定の既存行はDISABLED/未確認を維持する。旧最終証拠やENFORCE行を新方式の承認済みに自動変換しない。

## 5. 証拠発行の信頼境界

### 配備証拠

専用verifierは固定repo `morixi4106/vendor-register` と許可したworkflow path/IDから、run ID・run attempt・成功・head SHA・head repositoryを再取得する。本番採用は保護された反映経路と承認済み配備記録を要求する。feature/forkのCI成功は候補検査としてのみ扱う。

新しい専用artifactは、Function WASM、入力query、対象schema、policy manifest、各digestと集合digest、lockfile/build verifier versionを含める。CI successや自己申告のWASM hashだけでは発行しない。環境変数は比較対象であって出所証明ではない。

artifact ID、run/headとの所属、実際のbytes/digest、期限を検証する。artifactは期限切れ・削除があり得るため、新規証拠発行時に取得不能なら拒否する。既に検証した安全なmanifestと参照先を正規の非公開証拠保管先へ固定し、証拠の有効期間中取得できることを要求する。ローカル `.codex-temp` は保管先にしない。[GitHub artifact API](https://docs.github.com/en/rest/actions/artifacts)

取得先は固定APIと、そのAPIが返す承認したHTTPS配布先に限定する。認証headerを別originへ転送せず、redirect数・時間・サイズを制限する。入力URLの任意fetch、archiveのpath traversal/symlink/実行ファイル起動を拒否する。artifact全体digestと中のWASM digestは別物として照合する。

承認されたShopify配備コマンドは、使用artifact digest、対象app/version、Function識別子/API、対象店舗、実行者、結果を非公開記録へ残す。配備時の再buildは同一bytesを検査できない限り別artifact扱い。記録を取得できない場合は環境変数から補完しない。

App Versionは設定と拡張のスナップショットであり、release記録だけで店舗への即時反映とはしない。実店舗のValidation/Function/queryと閉鎖値を読み、別店舗や旧versionを拒否する。APIから稼働WASMのdigestが直接取得できるとは仮定しない。これは配備記録と実挙動の突合であり、遠隔環境の暗号学的attestationではない。[Shopify App Version](https://shopify.dev/docs/apps/launch/deployment/app-versions)

配備proofの対象はshop/release/Function/query/schema/policyと、未対応販売経路の有効な外部証拠。現在の閉鎖generationは観測結果として記録するが、将来の全承認generationの固定値にはしない。更新ごとに初回配備proofを発行し直す循環を避け、現在の閉鎖/稼働状態は別途必ず再取得する。

### 実機結果と最終証拠

browser runnerは固定された検証コードから起動する専用CLIとし、任意JavaScriptや結果JSONを管理画面から実行/提出できない。管理者の確認チェック、署名challenge、スクリーンショット単独ではシステム証拠を作らない。

runner用認証は既存の内部Bearer検査パターンを使うが、監視tokenとは別の最小権限credentialにする。専用credentialが未設定なら実行不能。追加設定は別承認で行う。runnerは承認済みrunをclaim/heartbeat/結果提出/停止要求できるだけで、承認・proof発行・scope拡大・課金権限を持たない。

claim時にrun/shop/実装version/承認IDを固定し、短期lease tokenを一度だけ返す。serviceはrunのcoverage、caseごとの観測段階、artifact digest、現在のrelease/native、金融probe、最終閉鎖を独立に再確認して発行する。runnerが報告した `passed=true` の総合値は受け付けない。

観測ケースの正しさは信頼済みrunnerと実行基盤にも依存する。認証はrunner侵害後の虚偽を防ぐ万能な証明ではない。fork/PRの任意コードへ本番credentialを渡さず、固定runnerの配備とcredential管理もP06の確認対象にする。

最終proofは正規化された対象別coverageを持つ。同じJPYでも別国、別provider/支払方法、別配送経路種別を一括合格にしない。SALE previewで全対象がcoverageの部分集合であることをサーバーが検証する。4Cで未実装/未観測のケースは未確認に残す。

複数runを集約する場合も同じshop/release/policy/scenarioと互換なnative構成に限り、参照run ID/digest・coverageを明示する。最終proofは参照proof/実地証拠・承認された配備の使用期限・証拠保管期限の最小までで、期限不明の依存を無期限と扱わない。4B-2で専用の固定validity定義を追加し、入力フォームから延長できないようにする。再発行で過去の実課金を再利用できるかは4Cが判定し、単なる日付更新を新しい取引実績とはしない。

汎用証拠登録から国際2キーをCONFIRMEDにする経路は禁止する。専用issuerだけが `system:international-checkout-verifier` とrun参照を記録し、人の開始/承認actorは別保存する。取消は専用コマンドでrevision更新・承認停止・同期登録を同一transactionに入れる。

## 6. Previewと単回Confirm

1. **Preview POST**: 認証済みshop/actor/用途を取得し、role、正常なDB入力、詳細native、proof、timezone、4C capabilityを確認。既存snapshot builderを `persist=false`、仮のENFORCE状態で評価し、許可できない商品国が一つでもあれば黙って除外せず拒否理由を返す。
2. **要求保存**: 正規化したscope、source/証拠version、native/release binding、期待generation、期限を固定。32byte nonceを発行しhashだけ保存。10分のpreview TTLと、承認する販売/検証期限を混同しない。
3. **Confirm事前検査**: 同一shop/actor/用途、nonce、現在のroleを再検査する。入力はrequest ID/nonce/intentだけとし、scopeやproofを再送値で差し替えない。native/proof/非公開を再取得し、snapshotの観測時刻は最大60秒前までとする。超過なら再取得し、transaction開始前に期限を再確認する。
4. **Serializable確定**: DB時刻と同一snapshotでrequest・gate・選択source/証拠・holdを再読取りする。source hash/証拠version/generation/期限/未取消を比較し、nonceの条件付き単回消費、承認ID/用途/期限の保存、世代更新、RECONCILE作成を同一transactionにする。VERIFYは未実行runも同時に作る。
5. **応答**: `accepted/pending` とrequest ID/generationだけを返す。同期完了・実際の保護・検証成功とは表示しない。ネットワーク呼出をtransaction中に行わない。

source計算は既存の適格性評価/証拠選択と共有する小さいhelperに抽出する。DB JSONBのobject/集合の順序を正規化し、時刻・generation・projection再生成だけの変化と入力変更を区別する。DISABLEDではgenerationが不変でもsource差分で古いpreviewを拒否する。証拠の削除・新しい決定の挿入・holdの追加も比較対象にする。

同じactorが同じnonceで再送した場合は保存済み結果に収束し、新しい世代を作らない。別nonce/別actor/shopは拒否。応答消失後の照会も認証必須で、現在停止済みなら「過去の受付結果」と「現在の停止」を並べ、成功済み表示で上書きしない。P2034は既存上限3回だけ再試行し、nonce消費とjob作成の部分確定を許さない。本番confirmは実際のtransactionが必須で、mock向けのtransactionなしfallbackを成功経路として使わない。

DBとShopifyは分散transactionにできない。confirm後にnativeが変更され得るため、workerが全店許可の直前にも再取得する。停止競合もgeneration・承認ID・leaseで前後をフェンスし、ShopifyのCASと読戻しを使う。ただしDBのフェンスだけで外部書込み直後の競合窓がゼロになるとは保証しない。

## 7. Runの寿命と停止

run状態は `QUEUED -> RUNNING -> CLOSING -> PASSED|FAILED|EXPIRED`。停止の実状態を混ぜないよう、別に `closureStatus=PENDING|CONFIRMED|UNVERIFIED` を持つ。terminalでも閉鎖未確認ならactiveKeyを維持し、結果を最終証拠に使わない。

- VERIFY承認直後はrunがQUEUEDのため、workerは閉鎖準備までしか進めない。専用CLIが明示claimし、RUNNING・有効lease・非公開確認が揃ってから許可反映する。
- heartbeatは60秒間隔、leaseは5分、最長run期限は承認したVERIFY期限以内。時計はサーバー/DBを正本にする。lease切れ後の遅延結果や古いtokenで成功へ変えない。
- 正常終了、失敗、取消、lease/承認期限切れ、非公開解除、release/native不一致はいずれも、runのCLOSING化とgate STOPPED・世代更新・閉鎖jobを同一DB transactionで保存する。終了処理の `finally` だけに頼らない。
- 既存Cronは失効runを検出し同じ停止処理を再試行する。既存のbounded worker/backoffを使い、重いbrowserをCronやHTTP要求に居残りさせない。runner再起動から自動再承認しない。
- 閉鎖値のCAS/読戻しと有効な配備/Validationが揃うまで「停止確認済み」にしない。配備検証が失効しても閉鎖書込み自体は試み、保護は未確認と表示する。API障害なら停止要求を残し、販売再開より停止jobを優先する。
- 期限後も閉鎖未確認のrunは、同じrunに対する閉鎖専用処理で解決する。runnerの古い成功提出を受け入れ直さず、新試験のためのactiveKey解除を手作業で偽装しない。

VERIFYの上限は48時間と使用証拠/配備proof/金融承認期限の最小。Functionの店舗日付による排他期限への切下げをpreviewに表示し、当日内に切下がって利用可能な期間がない場合は拒否する。SALEも明示期限と依存証拠期限の最小で、無期限承認は作らない。

5分leaseや10分Cronは厳密な5分/10分後の購入遮断保証ではない。Functionの現行時刻表現、Cron遅延、API障害の残存時間を明記する。非公開状態と許可scopeだけでは許容できない露出になる場合、本番VERIFYを開始せず隔離店舗で検証する。

正常なprojectionの期限更新は、同じ消費済み承認・用途・対象・証拠条件・承認期限内だけで可能。証拠の再承認、scope/通貨拡大、停止解除、承認期限の延長は行わない。現世代を検査し直すが、日々の世代更新だけで実課金を繰り返さない。対象/経路/releaseの意味ある変更は4Cのcoverage再判定と新しい明示承認を要求する。

## 8. 非公開確認と金融操作の境界

VERIFYでは固定した正規storefront originをcookieなしの別sessionで実確認する。過去のmonitor記録や「password」という文字列だけを流用せず、パスワード画面と通常の商品アクセスを検査する。403/障害/redirect不明は非公開確認済みにしない。取得先をフォームURLで指定させない。

この観測は全購入経路の閉鎖証明ではない。既存checkoutや別チャネルを含むP03の証拠、現在のValidation、対象scopeと露出対策を別に要求する。RUNNING中はrunnerとworkerで再検査し、公開が判明/未確認になれば停止する。

非課金runnerはカード入力・支払確定・実注文作成を実行しない。それでもゲート有効化による他者の課金リスクがあるため、本番VERIFYの承認にはその露出と既存制御の検査結果を含める。runnerの件数カウンターをサーバー側の購入上限とは見なさない。

金融VERIFYは4Cの実行可能な経路だけに限定し、既存financeロール/原資/総額・注文数の実上限/返金の別承認を要求する。既存限定公開制御がその海外経路・通貨にも効くと確認できなければ開始不可。4Bはカード情報、顧客の住所/メール、checkout token原文を保存しない。未紐付けAWAITING_ORDERの既存ガードを取り消さない。

## 9. UIとAPI

既存 `app.international-shipping.jsx` の3領域へ追加する。実設定、検証履歴、承認範囲をunframedで並べ、既存Polarisと権限別操作を使う。service/helper/componentへ分け、既存routeのarchitecture上限を増やさない。

追加intentは `previewInternationalAuthorization`, `confirmInternationalAuthorization`, `prepareInternationalDeployment`, `revokeInternationalProof`。既存の明示sync/stopも用途と承認IDを検査する。復旧はpreview/confirmのRESUME用途に統一する。全てPOST、認証済みshop/actor、allowlist、32KB上限、既存origin/session保護、`private, no-store`。GETは集計表示だけで検査結果の証拠化やnonce発行をしない。

runner用は別の認証済み内部actionとし、claim/heartbeat/case結果/終了・閉鎖要求のみ許可する。任意のrequest IDから新しい承認を作れない。runner結果もschema・case数・サイズを制限し、raw trace/HTML/住所/購入URLを受け付けない。

表示は「未確認」「承認要求受付」「反映中」「検証中」「閉鎖要求中」「閉鎖値確認・保護未確認」「停止確認済み」「検証合格」「一般販売準備確認」を区別する。VERIFYでgateがACTIVEでも一般販売readyはfalse。SALEの承認/反映だけでP01-P28全体や公開が完了したと表示しない。

未知/拒否は固定reason codeと次の確認先を返す。401/403、409の入力競合、422の証拠/適格性不足、503の外部取得不能を区別し、raw API応答・stack・秘密を返さない。内部例外も構造化codeへ正規化して、恒久的な設定不一致を無限の一時retry扱いにしない。

## 10. 実装順と受入条件

| 単位 | 実装するもの | 完了条件 |
| --- | --- | --- |
| 4B-1 | 2モデル/既存state・job拡張、入力schema、preview/confirm、用途別proof interface、閉鎖/復旧 | 実PostgreSQLで単回消費・同時停止・DISABLED中のsource変更を検証。proof未対応時は全有効化を拒否 |
| 4B-2 | CI artifact manifest、配備記録の取込み、固定verifier、proof発行/取消 | 別repo/run/head/artifact/期限・自己申告結果を拒否。配備proofだけでSALE不可 |
| 4B-3 | 既存UI/role、runner用内部API、監視/同期への接続 | 320/375/1440px、権限・二重クリック・未確認表示を検証。4C完了まで承認実行をロック |

4B-1から実装できる。4Cがない時点のcapabilityはサーバー固定でunsupportedとし、環境変数や隠しフォームで有効化できる暫定バイパスは置かない。previewは不足理由を返せても、消費/有効化はできない。4B-3のrunner APIは実行結果の受入口であり、実際のシナリオ実行/金融照合は4Cに接続する。

4Cで全店v3/policy v2の通貨制限、実機シナリオ、checkout由来・国・金額の照合が実装され、そのartifactが配備proofに一致した後にのみ、統合試験でcapabilityを成立させる。コード上のinterfaceが存在するだけで実環境をreadyにしない。

必須試験は次のとおり。

- PostgreSQLで同じnonceの二重confirm、別actor/shop、失効直前、P2034、応答消失の再送、nonce消費とjob登録のrollback。
- DISABLED中の証拠差替え、決定の挿入、商品削除、hold追加、native変更、timezone変更、別世代/別承認のworkerを拒否。
- 同時STOPとSHOP書込み、lease喪失、CAS後DB保存失敗、runner kill、閉鎖API失敗、遅延結果、再起動後の停止継続を試験。外部競合窓を測りゼロと偽らない。
- 配備proofのみ、期限切れartifact、誤ったdigest、fork CI、任意URL/巨大archive、generic attestation経由、自己申告caseを拒否。
- 同じ国での通貨/provider/経路不足、別国の結果流用、4C不在、未確認の露出制御/非公開を拒否。試験後のSALE自動移行がないことを確認。
- 正常な期限更新と失効/取消を分け、停止後のrole不足・古いRESUME・scope差替えを拒否。金融履歴/未紐付けガード/注文取込みは壊さない。
- 全体/service/routeテスト、Prisma validate/migration、lint/text/architecture、Function/WASM/拡張/アプリbuild、隔離runtime、既存production auditを維持する。既存例外の期限・条件を延長しない。

## 11. 反映と残る外部条件

候補PRとCIを先に完成させ、#51-#54の依存を整理する。本番反映は別承認で、海外閉鎖中にmigration、backend、scope実付与、Function候補配備/release、actual readbackを個別に確認する。migrationの追加だけで旧ENFORCEを新承認へ移さず、旧backendへのrollbackも海外閉鎖を維持する。

固定runner/非公開証拠保管先の実運用、承認済み配備記録の取得手段、実付与scope、初期対象国/商品、法務/配送/税務書類、原資と対応可能な支払方法は未確認の外部条件である。これらを仮のデータで合格にしない。

次の実装は4B-3の管理操作/専用runner接続。4B-2は候補CI成功、4B-3/4Cは未完了で、4B全体や本番反映、海外販売開始は完了していない。R06は別変更にし、prelaunchの通知抑止、自動マージ無効、第三者販売無効を維持する。最新のPR/CI・完了/未完了は[進捗メモ](launch-progress.md)へ記録する。
